import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DEVICE_CAPABILITIES } from "@t4-code/host-wire";
import { mkdtemp, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceMetadata, DeviceRecord, RemotePeerIdentity } from "../src/security/index.ts";
import {
	argsDigest,
	DefaultAuthorizationGuard,
	DefaultRedactor,
	JsonlAuditSink,
	LeaseRegistry,
	OutboundQueue,
	SecureConfirmationStore,
	SqliteDeviceRegistry,
	SqlitePairingService,
	TokenBucketLimiter,
} from "../src/security/index.ts";

let dbPath = "";
const identity = { nodeId: "node-a", login: "alice@example.com", hostId: "host-a", tailnetIp: "100.64.0.2" };
const clock = {
	value: 1_000,
	now() {
		return this.value;
	},
};
class FakeRegistry {
	readonly records = new Map<string, DeviceRecord>();
	readonly active = new Map<string, DeviceRecord & { authenticatedAt: number; connectionId: string }>();
	get(id: string): DeviceRecord | null {
		return this.records.get(id) ?? null;
	}
	create(record: DeviceRecord, _token: string) {
		this.records.set(record.deviceId, record);
	}
	updateMetadata(id: string, metadata: DeviceMetadata, capabilities: readonly DeviceRecord["capabilities"][number][]) {
		const old = this.records.get(id);
		if (old) this.records.set(id, { ...old, metadata, capabilities });
	}
	authenticate(id: string, token: string, _identity: RemotePeerIdentity, connectionId: string) {
		const record = this.records.get(id);
		if (!record || token !== "token") throw new Error("denied");
		const principal = { ...record, authenticatedAt: clock.now(), connectionId };
		this.active.set(`${connectionId}:${id}`, principal);
		return principal;
	}
	getAuthenticatedPrincipal(connectionId: string, deviceId: string) {
		return this.active.get(`${connectionId}:${deviceId}`) ?? null;
	}
	revoke(id: string) {
		const record = this.records.get(id);
		if (record) {
			this.records.set(id, { ...record, revokedAt: clock.now(), epoch: record.epoch + 1 });
			for (const key of this.active.keys()) if (key.endsWith(`:${id}`)) this.active.delete(key);
		}
	}
	list(): readonly DeviceRecord[] {
		return [...this.records.values()];
	}
	close() {}
}

beforeAll(() => {
	dbPath = `/tmp/omp-security-${process.pid}/device.sqlite`;
});
afterAll(async () => {
	await unlink(dbPath).catch(() => undefined);
});

describe("security core", () => {
	it("pairs once and authenticates a returned token without storing plaintext", () => {
		const registry = new SqliteDeviceRegistry(dbPath, clock);
		const pairing = new SqlitePairingService(registry, clock, { bytes: n => new Uint8Array(n).fill(7) });
		const issuerRecord = {
			deviceId: "issuer",
			identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
			capabilities: ["sessions.manage"] as const,
			metadata: { label: "issuer" },
			createdAt: 1,
			lastSeenAt: 1,
			tokenExpiresAt: clock.now() + 86_400_000,
			revokedAt: null,
			epoch: 0,
		};
		registry.create(issuerRecord, "A".repeat(43));
		const issuer = registry.authenticate("issuer", "A".repeat(43), identity, "connection-a");
		const grant = pairing.start("connection-a", ["sessions.read"], undefined, {
			deviceId: issuer.deviceId,
			epoch: issuer.epoch,
			identityKey: issuer.identityKey,
		});
		const result = pairing.complete("connection-a", grant.code, identity, { label: "device" }, ["sessions.read"], {
			deviceId: issuer.deviceId,
			epoch: issuer.epoch,
			identityKey: issuer.identityKey,
		});
		expect(registry.authenticate(result.deviceId, result.token, identity, "connection-a").deviceId).toBe(
			result.deviceId,
		);
		expect(() => registry.authenticate(result.deviceId, "wrong", identity, "connection-a")).toThrow();
		registry.close();
	});

	it("binds authorization to the authenticated capability intersection", () => {
		const principal = {
			deviceId: "d",
			identityKey: "i",
			capabilities: ["sessions.read"] as const,
			metadata: { label: "d" },
			createdAt: 1,
			lastSeenAt: 1,
			tokenExpiresAt: Date.now() + 86_400_000,
			revokedAt: null,
			epoch: 0,
			authenticatedAt: 1,
			connectionId: "c",
		};
		const registry = new FakeRegistry();
		registry.create(principal, "token");
		const guard = new DefaultAuthorizationGuard(registry);
		registry.authenticate("d", "token", identity, "c");
		const base = { principal, connectionId: "c", capabilities: ["sessions.read"] as const, args: {} };
		expect(() => guard.authorize({ ...base, command: "session.attach", sessionId: "s" })).not.toThrow();
		expect(() => guard.authorize({ ...base, command: "session.prompt", sessionId: "s" })).toThrow();
	});
	it("requires a controller lease for fast-mode changes", () => {
		const record = {
			deviceId: "fast-device",
			identityKey: "fast-identity",
			capabilities: ["sessions.manage"] as const,
			metadata: { label: "fast-device" },
			createdAt: 1,
			lastSeenAt: 1,
			tokenExpiresAt: Date.now() + 86_400_000,
			revokedAt: null,
			epoch: 0,
		};
		const registry = new FakeRegistry();
		registry.create(record, "token");
		const principal = registry.authenticate(record.deviceId, "token", identity, "fast-connection");
		const leases = new LeaseRegistry(clock, { bytes: n => new Uint8Array(n).fill(5) });
		const guard = new DefaultAuthorizationGuard(registry, leases, undefined, clock, () => "fast-revision");
		const request = {
			principal,
			connectionId: "fast-connection",
			command: "session.fast.set",
			capabilities: ["sessions.manage"] as const,
			sessionId: "fast-session",
			revision: "fast-revision",
			args: { enabled: true },
		};
		expect(() => guard.authorize(request)).toThrow("session lease required");
		const lease = leases.acquire(
			record.deviceId,
			"fast-connection",
			"fast-session",
			"controller",
			30_000,
			0,
			"fast-revision",
		);
		expect(() => guard.authorize({ ...request, leaseId: lease.leaseId })).not.toThrow();
	});

	it("expires and releases a single-owner lease", () => {
		const leases = new LeaseRegistry(clock, { bytes: n => new Uint8Array(n).fill(3) });
		leases.acquire("d", "conn", "s", "controller", 10);
		expect(() => leases.acquire("d2", "other", "s", "controller")).toThrow();
		clock.value += 11;
		expect(() => leases.acquire("d2", "other", "s", "controller")).not.toThrow();
		leases.disconnect("d2", "other");
	});

	it("consumes confirmations once and redacts nested secrets", () => {
		const confirmations = new SecureConfirmationStore(clock);
		const grant = confirmations.issue({
			connectionId: "c",
			deviceId: "d",
			command: "files.write",
			sessionId: "s",
			argsDigest: "a",
			revision: "r",
			epoch: 0,
		});
		confirmations.consume(grant.id, {
			connectionId: "c",
			deviceId: "d",
			command: "files.write",
			sessionId: "s",
			argsDigest: "a",
			revision: "r",
			epoch: 0,
		});
		expect(() =>
			confirmations.consume(grant.id, {
				connectionId: "c",
				deviceId: "d",
				command: "files.write",
				sessionId: "s",
				argsDigest: "a",
				revision: "r",
				epoch: 0,
			}),
		).toThrow();
		expect(new DefaultRedactor().redact({ auth: { token: "secret" }, nested: [{ password: "x" }] })).toEqual({
			auth: "[redacted]",
			nested: [{ password: "[redacted]" }],
		});
	});

	it("rate limits and never drops terminal queue messages", () => {
		const limiter = new TokenBucketLimiter(1, 0, clock);
		const principal = {
			deviceId: "device",
			identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
			capabilities: ["sessions.read"] as const,
			metadata: { label: "device" },
			createdAt: 1,
			lastSeenAt: 1,
			tokenExpiresAt: Date.now() + 86_400_000,
			revokedAt: null,
			epoch: 0,
			authenticatedAt: 1,
			connectionId: "connection",
		};
		expect(limiter.allowAuthenticated(principal, identity, "100.64.0.2")).toBe(true);
		const queue = new OutboundQueue(100);
		queue.push({ kind: "result", payload: "done" });
		expect(() => queue.push({ kind: "event", payload: "drop-me" })).not.toThrow();
		expect(queue.shift()?.kind).toBe("result");
	});

	it("writes redacted JSONL audit values", async () => {
		const path = `/tmp/omp-security-audit-${process.pid}/audit.jsonl`;
		const sink = new JsonlAuditSink(path);
		await sink.write({ command: "x", token: "secret-canary" });
		const text = await Bun.file(path).text();
		expect(text).not.toContain("secret-canary");
		await unlink(path).catch(() => undefined);
	});
});
it("rejects expired or replayed pairing and mismatched identity", () => {
	const localClock = {
		value: 100,
		now() {
			return this.value;
		},
	};
	const registry = new FakeRegistry();
	const issuerRecord = {
		deviceId: "issuer-exp",
		identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
		capabilities: ["sessions.manage"] as const,
		metadata: { label: "issuer" },
		createdAt: 1,
		lastSeenAt: 1,
		tokenExpiresAt: 100_000,
		revokedAt: null,
		epoch: 0,
	};
	registry.create(issuerRecord, "token");
	const issuer = registry.authenticate("issuer-exp", "token", identity, "c");
	const pairing = new SqlitePairingService(registry, localClock, { bytes: n => new Uint8Array(n).fill(9) });
	const context = { deviceId: issuer.deviceId, epoch: issuer.epoch, identityKey: issuer.identityKey };
	const grant = pairing.start("c", ["sessions.read"], 10, context);
	localClock.value = 111;
	expect(() => pairing.complete("c", grant.code, identity, { label: "x" }, ["sessions.read"], context)).toThrow();
});

it("invalidates an authenticated principal after revoke epoch change", () => {
	const registry = new FakeRegistry();
	const record = {
		deviceId: "d2",
		identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
		capabilities: ["sessions.read"] as const,
		metadata: { label: "x" },
		createdAt: 1,
		lastSeenAt: 1,
		tokenExpiresAt: Date.now() + 86_400_000,
		revokedAt: null,
		epoch: 0,
	};
	registry.create(record, "token");
	const principal = registry.authenticate("d2", "token", identity, "c");
	registry.revoke("d2");
	const guard = new DefaultAuthorizationGuard(registry);
	expect(() =>
		guard.authorize({
			principal,
			connectionId: "c",
			command: "host.list",
			capabilities: ["sessions.read"],
			args: {},
		}),
	).toThrow();
});

it("coalesces transient events while preserving terminal messages", () => {
	const queue = new OutboundQueue(100);
	queue.push({ kind: "event", coalesceKey: "state", payload: { n: 1 } });
	queue.push({ kind: "event", coalesceKey: "state", payload: { n: 2 } });
	queue.push({ kind: "error", payload: { done: true } });
	expect(queue.drain().map(item => item.kind)).toEqual(["event", "error"]);
});

it("redacts cycles, JWT, bearer, basic and private-key strings", () => {
	const cycle: Record<string, unknown> = { value: "Bearer abcdefghijklmnopqrstuvwxyz" };
	cycle.self = cycle;
	const output = JSON.stringify(new DefaultRedactor().redact(cycle));
	expect(output).not.toContain("Bearer");
	expect(output).not.toContain('"self":{"self"');
});
it("pair completion stays bound to the issuing connection", () => {
	const registry = new FakeRegistry();
	const issuerRecord = {
		deviceId: "issuer-bind",
		identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
		capabilities: ["sessions.manage"] as const,
		metadata: { label: "issuer" },
		createdAt: 1,
		lastSeenAt: 1,
		tokenExpiresAt: Date.now() + 86_400_000,
		revokedAt: null,
		epoch: 0,
	};
	registry.create(issuerRecord, "token");
	const issuer = registry.authenticate("issuer-bind", "token", identity, "issuer");
	const pairing = new SqlitePairingService(registry, clock, { bytes: n => new Uint8Array(n).fill(8) });
	const context = { deviceId: issuer.deviceId, epoch: issuer.epoch, identityKey: issuer.identityKey };
	const grant = pairing.start("issuer", ["sessions.read"], undefined, context);
	expect(() => pairing.complete("other", grant.code, identity, { label: "x" }, ["sessions.read"], context)).toThrow();
});

it("expired credentials are rejected and revoked", () => {
	const localClock = {
		value: 100,
		now() {
			return this.value;
		},
	};
	const path = `/tmp/omp-expired-${process.pid}/device.sqlite`;
	const registry = new SqliteDeviceRegistry(path, localClock, { bytes: n => new Uint8Array(n).fill(6) });
	registry.create(
		{
			deviceId: "expired",
			identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
			capabilities: ["sessions.read"],
			metadata: { label: "x" },
			createdAt: 1,
			lastSeenAt: 1,
			tokenExpiresAt: 110,
			revokedAt: null,
			epoch: 0,
		},
		"A".repeat(43),
	);
	localClock.value = 111;
	expect(() => registry.authenticate("expired", "A".repeat(43), identity, "connection")).toThrow();
	expect(registry.get("expired")?.revokedAt).toBe(111);
	registry.close();
	unlink(path).catch(() => undefined);
});
it("canonical args reject non-finite, undefined, and cycles while preserving null", () => {
	expect(() => argsDigest({ value: Number.NaN })).toThrow();
	expect(() => argsDigest({ value: Infinity })).toThrow();
	expect(() => argsDigest({ value: undefined })).toThrow();
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	expect(() => argsDigest(cycle)).toThrow();
	expect(argsDigest({ value: null })).not.toEqual(argsDigest({}));
});

it("queue coalescing keeps event position and full frame metadata", () => {
	const queue = new OutboundQueue(500);
	queue.push({ kind: "event", payload: { frameId: "a", n: 1 }, coalesceKey: "state" });
	queue.push({ kind: "result", payload: { frameId: "r" } });
	queue.push({ kind: "event", payload: { frameId: "b", n: 2 }, coalesceKey: "state" });
	expect(queue.drain()).toEqual([
		{ kind: "event", payload: { frameId: "b", n: 2 }, coalesceKey: "state" },
		{ kind: "result", payload: { frameId: "r" } },
	]);
});

it("lease owner is device plus connection and command allowlist is enforced", () => {
	const leases = new LeaseRegistry(clock, { bytes: n => new Uint8Array(n).fill(4) });
	const lease = leases.acquire("device", "connection", "session", "prompt");
	expect(leases.verify(lease.leaseId, "device", "connection", "session", "session.prompt")).toBe(true);
	expect(leases.verify(lease.leaseId, "device", "other", "session", "session.prompt")).toBe(false);
	expect(leases.verify(lease.leaseId, "device", "connection", "session", "session.cancel")).toBe(false);
});
it("audit dispose releases single-writer ownership", async () => {
	const path = `/tmp/omp-audit-dispose-${process.pid}/audit.jsonl`;
	const first = new JsonlAuditSink(path);
	await first.write({ ok: true });
	await first.dispose();
	await first.close();
	const second = new JsonlAuditSink(path);
	await second.dispose();
	await unlink(path).catch(() => undefined);
});

it("pairing rejects a caller identity different from verified issuer", () => {
	const registry = new FakeRegistry();
	const issuerIdentity = identity;
	const issuerRecord = {
		deviceId: "issuer-canonical",
		identityKey: JSON.stringify([
			issuerIdentity.nodeId,
			issuerIdentity.login,
			issuerIdentity.hostId,
			issuerIdentity.tailnetIp,
		]),
		capabilities: ["sessions.manage"] as const,
		metadata: { label: "issuer" },
		createdAt: 1,
		lastSeenAt: 1,
		tokenExpiresAt: Date.now() + 86_400_000,
		revokedAt: null,
		epoch: 0,
	};
	registry.create(issuerRecord, "token");
	const principal = registry.authenticate("issuer-canonical", "token", issuerIdentity, "issuer-canonical-connection");
	const pairing = new SqlitePairingService(registry, clock, { bytes: n => new Uint8Array(n).fill(2) });
	const context = { deviceId: principal.deviceId, epoch: principal.epoch, identityKey: principal.identityKey };
	const grant = pairing.start("issuer-canonical-connection", ["sessions.read"], undefined, context);
	expect(() =>
		pairing.complete(
			"issuer-canonical-connection",
			grant.code,
			{ ...issuerIdentity, tailnetIp: "100.64.0.3" },
			{ label: "x" },
			["sessions.read"],
			context,
		),
	).toThrow();
});

it("lease renew and release reject command-kind bypasses", () => {
	const leases = new LeaseRegistry(clock, { bytes: n => new Uint8Array(n).fill(5) });
	const lease = leases.acquire("device", "connection", "session", "prompt");
	expect(() => leases.renew(lease.leaseId, "device", "connection", 30_000, 0, undefined, "session.cancel")).toThrow();
	leases.release(lease.leaseId, "device", "connection", 0, undefined, "session.cancel");
	expect(leases.verify(lease.leaseId, "device", "connection", "session", "session.prompt", 0)).toBe(true);
});
it("authenticated limiter rejects caller-supplied identity and isolates verified source addresses", () => {
	const limiter = new TokenBucketLimiter(1, 0, clock);
	const principal = {
		deviceId: "limit-device",
		identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
		capabilities: ["sessions.read"] as const,
		metadata: { label: "x" },
		createdAt: 1,
		lastSeenAt: 1,
		tokenExpiresAt: Date.now() + 86_400_000,
		revokedAt: null,
		epoch: 0,
		authenticatedAt: 1,
		connectionId: "limit-connection",
	};
	expect(limiter.allowAuthenticated(principal, identity, "100.64.0.2")).toBe(true);
	expect(limiter.allowAuthenticated(principal, identity, "100.64.0.2")).toBe(false);
	expect(limiter.allowAuthenticated(principal, identity, "100.64.0.3")).toBe(true);
	expect(limiter.allowAuthenticated(principal, { ...identity, tailnetIp: "100.64.0.3" }, "100.64.0.3")).toBe(false);
});

it("unauthenticated pairing limiter derives identity and source internally", () => {
	const limiter = new TokenBucketLimiter(1, 0, clock);
	const other = { nodeId: "node-b", login: "bob@example.com", hostId: "host-b", tailnetIp: "100.64.0.3" };
	expect(limiter.allowPairing(identity, "100.64.0.2")).toBe(true);
	expect(limiter.allowPairing(identity, "100.64.0.2")).toBe(false);
	expect(limiter.allowPairing(identity, "100.64.0.3")).toBe(true);
	expect(limiter.allowUnauthenticatedPairing(other, "100.64.0.2")).toBe(true);
	expect(limiter.allowPairing(identity, "not-an-ip")).toBe(false);
});

it("device schema version is durable across close and reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-schema-"));
	const path = join(root, "device.sqlite");
	const first = new SqliteDeviceRegistry(path, clock);
	first.close();
	const database = new Database(path);
	expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
	database.close();
	const second = new SqliteDeviceRegistry(path, clock);
	second.close();
});

it("reopens devices whose capability JSON exceeds the ordinary row-field bound", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-capabilities-"));
	const path = join(root, "device.sqlite");
	const token = "A".repeat(43);
	const first = new SqliteDeviceRegistry(path, clock);
	first.create(
		{
			deviceId: "full-capability-device",
			identityKey: JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]),
			capabilities: DEVICE_CAPABILITIES,
			metadata: { label: "local companion" },
			createdAt: 1,
			lastSeenAt: null,
			tokenExpiresAt: clock.now() + 1_000,
			revokedAt: null,
			epoch: 0,
		},
		token,
	);
	first.close();
	expect(JSON.stringify(DEVICE_CAPABILITIES).length).toBeGreaterThan(256);

	const second = new SqliteDeviceRegistry(path, clock);
	expect(second.get("full-capability-device")?.capabilities).toEqual(DEVICE_CAPABILITIES);
	second.close();
});

it("future device schema versions fail closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-future-schema-"));
	const path = join(root, "device.sqlite");
	const database = new Database(path);
	database.run("PRAGMA user_version = 99");
	database.close();
	expect(() => new SqliteDeviceRegistry(path, clock)).toThrow("unsupported device schema");
});

it("failed device migration rolls back table changes and schema version", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-rollback-schema-"));
	const path = join(root, "device.sqlite");
	const database = new Database(path);
	database.run("CREATE TABLE devices(other TEXT)");
	database.close();
	expect(() => new SqliteDeviceRegistry(path, clock)).toThrow("unsupported device schema");
	const reopened = new Database(path);
	expect(reopened.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
	expect(reopened.query("PRAGMA table_info(devices)").all()).toHaveLength(1);
	reopened.close();
});

it("audit stale dead owner recovery uses complete lock records", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-audit-stale-"));
	const path = join(root, "audit.jsonl");
	await writeFile(
		`${path}.lock`,
		JSON.stringify({ pid: 2_000_000_000, ownerId: "dead", processStart: "123", createdAt: 1 }),
		{ mode: 0o600 },
	);
	const sink = new JsonlAuditSink(path);
	await sink.write({ ok: true });
	expect(await Bun.file(path).text()).toContain('"ok":true');
	expect(await stat(`${path}.lock`).catch(() => null)).toBeNull();
	await sink.dispose();
});

it("audit malformed or empty lock is never treated as an owned lock", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-audit-empty-"));
	const path = join(root, "audit.jsonl");
	await writeFile(`${path}.lock`, "");
	const sink = new JsonlAuditSink(path);
	await expect(sink.write({ ok: true })).rejects.toThrow("audit writer busy");
	await unlink(`${path}.lock`);
	await sink.dispose();
});

it("audit lock with live pid and unknown start token is preserved", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-audit-live-"));
	const path = join(root, "audit.jsonl");
	await writeFile(
		`${path}.lock`,
		JSON.stringify({ pid: process.pid, ownerId: "foreign", processStart: "unknown", createdAt: 1 }),
		{ mode: 0o600 },
	);
	const sink = new JsonlAuditSink(path);
	await expect(sink.write({ ok: true })).rejects.toThrow("audit writer busy");
	expect(await Bun.file(`${path}.lock`).text()).toContain('"foreign"');
	await unlink(`${path}.lock`);
	await sink.dispose();
});
