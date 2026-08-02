import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SharedControlLedgerConflictError,
	SharedControlStore,
	type SharedControlLedgerSnapshot,
	type SharedControlLedgerState,
	type SharedControlLedgerStorage,
} from "../src/shared-control-store.ts";
import { SqliteSharedControlLedgerStorage } from "../src/sqlite-shared-ledger-storage.ts";

class MemoryStorage implements SharedControlLedgerStorage {
	#snapshot: SharedControlLedgerSnapshot | undefined;
	async read(): Promise<SharedControlLedgerSnapshot | undefined> { return structuredClone(this.#snapshot); }
	async create(state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		if (this.#snapshot) throw new SharedControlLedgerConflictError();
		this.#snapshot = { resourceVersion: "1", state: structuredClone(state) };
		return structuredClone(this.#snapshot);
	}
	async replace(resourceVersion: string, state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		if (!this.#snapshot || this.#snapshot.resourceVersion !== resourceVersion) throw new SharedControlLedgerConflictError();
		this.#snapshot = { resourceVersion: String(Number(resourceVersion) + 1), state: structuredClone(state) };
		return structuredClone(this.#snapshot);
	}
}

const policy = {
	maxActiveRuntimes: 1,
	maxRetainedRuntimes: 2,
	maxWorkspaceCapacityBytes: 20,
	maxCpuMillis: 1_000,
	maxMemoryBytes: 2_000,
	maxGpuUnits: 0,
	browserEnabled: false,
	runtimeResources: { cpuMillis: 1_000, memoryBytes: 2_000, gpuUnits: 0 },
	creationRate: { windowSeconds: 60, burst: 2, maximumRetryAfterSeconds: 30 },
} as const;
	test("enforces one exact slot across independent SQLite-backed replicas", async () => {
		const root = mkdtempSync(join(tmpdir(), "admission-ledger-"));
		const path = join(root, "shared.sqlite");
		const firstStorage = new SqliteSharedControlLedgerStorage(path);
		const secondStorage = new SqliteSharedControlLedgerStorage(path);
		try {
			const first = new SharedControlStore({ storage: firstStorage, randomBytes: length => new Uint8Array(length).fill(3) });
			const second = new SharedControlStore({ storage: secondStorage, randomBytes: length => new Uint8Array(length).fill(4) });
			const request = (resourceKey: string) => ({ scopeId: "scope_sqlite", resourceKey, resourceKind: "runtime" as const, transition: "activate" as const, active: true, policy, usage: { ...emptyUsage, retainedRuntimes: 2 } });
			const results = await Promise.all([first.reserveAdmission(request("one")), second.reserveAdmission(request("two"))]);
			expect(results.filter(item => item.outcome === "admitted")).toHaveLength(1);
			expect(results.filter(item => item.outcome === "denied")).toEqual([expect.objectContaining({ reason: "active_runtime_limit" })]);
			const expiry = Math.floor(Date.now() / 1_000) + 20;
			const nonceClaims = await Promise.all([
				first.claimProviderAssertionNonce({ nonce: "s".repeat(24), expiresAt: expiry }),
				second.claimProviderAssertionNonce({ nonce: "s".repeat(24), expiresAt: expiry }),
			]);
			expect(nonceClaims.sort()).toEqual(["claimed", "replayed"]);
		} finally {
			firstStorage.close();
			secondStorage.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

const emptyUsage = { activeRuntimes: 0, retainedRuntimes: 0, workspaceCapacityBytes: 0, cpuMillis: 0, memoryBytes: 0, gpuUnits: 0 };

describe("shared scope admission ledger", () => {
	test("admits exactly the limit across two replicas and releases deterministic failures", async () => {
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage, randomBytes: length => new Uint8Array(length).fill(1) });
		const second = new SharedControlStore({ storage, randomBytes: length => new Uint8Array(length).fill(2) });
		const request = (resourceKey: string) => ({ scopeId: "scope_one", resourceKey, resourceKind: "runtime" as const, active: true, policy, usage: emptyUsage });
		const admitted = await Promise.all([first.reserveAdmission(request("runtime_one")), second.reserveAdmission(request("runtime_two"))]);
		expect(admitted.filter(item => item.outcome === "admitted")).toHaveLength(1);
		expect(admitted.filter(item => item.outcome === "denied")).toEqual([expect.objectContaining({ reason: "active_runtime_limit" })]);
		const reservation = admitted.find(item => item.outcome === "admitted");
		if (!reservation || reservation.outcome !== "admitted") throw new Error("reservation missing");
		expect(await first.releaseAdmission(reservation.reservationToken)).toBe("released");
		expect((await second.reserveAdmission(request("runtime_three"))).outcome).toBe("admitted");
	});

	test("denies browser, GPU, overflowing capacity, and returns a bounded rate retry", async () => {
		let now = 1_000_000;
		const storage = new MemoryStorage();
		let seed = 1;
		const store = new SharedControlStore({ storage, now: () => now, randomBytes: length => new Uint8Array(length).fill(seed++) });
		expect(await store.reserveAdmission({ scopeId: "scope_one", resourceKey: "browser", resourceKind: "runtime", browserRequested: true, policy, usage: emptyUsage })).toEqual({ outcome: "denied", reason: "browser_disabled" });
		expect(await store.reserveAdmission({ scopeId: "scope_one", resourceKey: "gpu", resourceKind: "runtime", active: true, policy: { ...policy, runtimeResources: { ...policy.runtimeResources, gpuUnits: 1 } }, usage: emptyUsage })).toEqual({ outcome: "denied", reason: "gpu_limit" });
		expect(await store.reserveAdmission({ scopeId: "scope_one", resourceKey: "huge", resourceKind: "workspace", workspaceCapacityBytes: 10, policy, usage: { ...emptyUsage, workspaceCapacityBytes: Number.MAX_SAFE_INTEGER } })).toEqual({ outcome: "denied", reason: "workspace_capacity_limit" });
		for (const key of ["one", "two"]) {
			const result = await store.reserveAdmission({ scopeId: "scope_rate", resourceKey: key, resourceKind: "workspace", workspaceCapacityBytes: 1, policy, usage: emptyUsage });
			if (result.outcome !== "admitted") throw new Error("expected admission");
			expect(await store.commitAdmission(result.reservationToken)).toBe("committed");
		}
		const limited = await store.reserveAdmission({ scopeId: "scope_rate", resourceKey: "three", resourceKind: "workspace", workspaceCapacityBytes: 1, policy, usage: emptyUsage });
		expect(limited).toEqual({ outcome: "denied", reason: "creation_rate_limit", retryAfterSeconds: 30 });
		now += 60_001;
		expect((await store.reserveAdmission({ scopeId: "scope_rate", resourceKey: "four", resourceKind: "workspace", workspaceCapacityBytes: 1, policy, usage: emptyUsage })).outcome).toBe("admitted");
	});
	test("retains committed ambiguous capacity past the attempt TTL until authoritative reconciliation", async () => {
		let now = 1_000_000;
		const store = new SharedControlStore({ storage: new MemoryStorage(), now: () => now, randomBytes: length => new Uint8Array(length).fill(7) });
		const request = (resourceKey: string) => ({
			scopeId: "scope_ambiguous",
			resourceKey,
			resourceKind: "runtime" as const,
			transition: "activate" as const,
			active: true,
			policy,
			usage: emptyUsage,
		});
		const first = await store.reserveAdmission(request("runtime_one"));
		if (first.outcome !== "admitted") throw new Error("expected admission");
		expect(await store.commitAdmission(first.reservationToken)).toBe("committed");
		expect(await store.releaseAdmission(first.reservationToken)).toBe("notFound");
		now += 600_000;
		expect(await store.reserveAdmission(request("runtime_two"))).toEqual({ outcome: "denied", reason: "active_runtime_limit" });
		expect(await store.reconcileAdmissionAbsence({ scopeId: "scope_ambiguous", resourceKind: "runtime", resourceKey: "runtime_one", transition: "activate" })).toBe("released");
		expect((await store.reserveAdmission(request("runtime_two"))).outcome).toBe("admitted");
	});

	test("isolates identical public resource IDs across scopes", async () => {
		let seed = 30;
		const store = new SharedControlStore({ storage: new MemoryStorage(), randomBytes: length => new Uint8Array(length).fill(seed++) });
		const reserve = (scopeId: string) => store.reserveAdmission({
			scopeId,
			resourceKey: "shared-public-id",
			resourceKind: "runtime" as const,
			transition: "activate" as const,
			active: true,
			policy,
			usage: emptyUsage,
		});
		const first = await reserve("scope_one");
		const second = await reserve("scope_two");
		expect(first.outcome).toBe("admitted");
		expect(second.outcome).toBe("admitted");
		if (first.outcome !== "admitted" || second.outcome !== "admitted") throw new Error("expected isolated admissions");
		await store.commitAdmission(first.reservationToken);
		await store.commitAdmission(second.reservationToken);
		expect(await store.reconcileAdmissionAbsence({ scopeId: "scope_one", resourceKind: "runtime", resourceKey: "shared-public-id", transition: "activate" })).toBe("released");
		expect(await store.reconcileAdmissionAbsence({ scopeId: "scope_two", resourceKind: "runtime", resourceKey: "shared-public-id", transition: "activate" })).toBe("released");
	});

	test("persists and idempotently completes admission retirement intents", async () => {
		let now = Date.parse("2026-07-30T00:00:00.000Z");
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage, now: () => now });
		const request = { scopeId: "scope_delete", resourceKind: "runtime" as const, resourceKey: "runtime_deleted" };
		expect(await first.beginAdmissionRetirement(request)).toMatchObject({ ...request, state: "pending" });
		const replica = new SharedControlStore({ storage, now: () => now });
		expect(await replica.getAdmissionRetirement(request)).toMatchObject({ ...request, state: "pending" });
		now += 1_000;
		expect(await replica.completeAdmissionRetirement(request)).toBe("completed");
		expect(await first.completeAdmissionRetirement(request)).toBe("alreadyCompleted");
		expect(await first.getAdmissionRetirement(request)).toMatchObject({
			...request,
			state: "complete",
			completedAt: "2026-07-30T00:00:01.000Z",
		});
	});

	test("computes retry-after from exactly the counted in-window contributors", async () => {
		let now = 1_000_000;
		let seed = 10;
		const exactPolicy = { ...policy, creationRate: { windowSeconds: 60, burst: 2, maximumRetryAfterSeconds: 120 } };
		const store = new SharedControlStore({ storage: new MemoryStorage(), now: () => now, randomBytes: length => new Uint8Array(length).fill(seed++) });
		const reserve = (resourceKey: string) => store.reserveAdmission({ scopeId: "scope_retry", resourceKey, resourceKind: "workspace" as const, workspaceCapacityBytes: 1, policy: exactPolicy, usage: emptyUsage });
		const oldAttempt = await reserve("old_attempt");
		expect(oldAttempt.outcome).toBe("admitted");
		now += 120_000;
		for (const key of ["recent_one", "recent_two"]) {
			const result = await reserve(key);
			if (result.outcome !== "admitted") throw new Error("expected recent admission");
			expect(await store.commitAdmission(result.reservationToken)).toBe("committed");
		}
		expect(await reserve("limited")).toEqual({ outcome: "denied", reason: "creation_rate_limit", retryAfterSeconds: 60 });
	});
});

describe("generation-scoped runtime ingress ledger", () => {
	test("atomically fences generations and tracks owned renewable leases", async () => {
		const storage = new MemoryStorage();
		let now = 1_000_000;
		let seed = 10;
		const gateway = new SharedControlStore({ storage, now: () => now, randomBytes: length => new Uint8Array(length).fill(seed++) });
		const controller = new SharedControlStore({ storage, now: () => now, randomBytes: length => new Uint8Array(length).fill(seed++) });
		const identity = { runtimeId: "session-one", generation: "gen_123456789012345678901234" };
		const acquired = await gateway.acquireRuntimeIngress({ ...identity, gatewayReplicaEpoch: "gateway-epoch-one", ttlSeconds: 10 });
		expect(acquired.outcome).toBe("acquired");
		expect(await controller.beginRuntimeIngressDrain({ ...identity, mode: "idle" })).toEqual({ outcome: "busy", activeLeases: 1 });
		if (acquired.outcome !== "acquired") throw new Error("runtime ingress lease missing");
		expect((await gateway.renewRuntimeIngress({ ...identity, gatewayReplicaEpoch: "gateway-epoch-one", leaseId: acquired.leaseId, ttlSeconds: 10 })).outcome).toBe("renewed");
		expect(await gateway.releaseRuntimeIngress({ ...identity, gatewayReplicaEpoch: "other-owner", leaseId: acquired.leaseId })).toBe("notFound");
		expect(await controller.beginRuntimeIngressDrain({ ...identity, mode: "explicit" })).toEqual({ outcome: "fenced", activeLeases: 1 });
		expect(await gateway.acquireRuntimeIngress({ ...identity, gatewayReplicaEpoch: "gateway-epoch-one", ttlSeconds: 10 })).toEqual({ outcome: "fenced" });
		expect(await gateway.releaseRuntimeIngress({ ...identity, gatewayReplicaEpoch: "gateway-epoch-one", leaseId: acquired.leaseId })).toBe("released");
		expect(await controller.runtimeIngressState(identity)).toEqual({ ...identity, open: false, activeLeases: 0 });
		expect(await controller.reopenRuntimeIngress(identity)).toBe("reopened");
		expect((await gateway.acquireRuntimeIngress({ ...identity, gatewayReplicaEpoch: "gateway-epoch-one", ttlSeconds: 10 })).outcome).toBe("acquired");
	});

	test("reclaims expired crashed leases and garbage-collects fenced old generations", async () => {
		const storage = new MemoryStorage();
		let now = 2_000_000;
		let seed = 20;
		const store = new SharedControlStore({ storage, now: () => now, randomBytes: length => new Uint8Array(length).fill(seed++) });
		const old = { runtimeId: "session-crash", generation: "generation-old" };
		expect((await store.acquireRuntimeIngress({ ...old, gatewayReplicaEpoch: "dead-replica", ttlSeconds: 2 })).outcome).toBe("acquired");
		expect((await store.beginRuntimeIngressDrain({ ...old, mode: "explicit" })).activeLeases).toBe(1);
		now += 2_001;
		expect(await store.runtimeIngressState(old)).toEqual({ ...old, open: false, activeLeases: 0 });
		const current = { runtimeId: old.runtimeId, generation: "generation-current" };
		expect((await store.acquireRuntimeIngress({ ...current, gatewayReplicaEpoch: "live-replica", ttlSeconds: 10 })).outcome).toBe("acquired");
		const snapshot = await storage.read();
		expect(snapshot?.state.runtimeIngress.map(item => item.generation)).toEqual(["generation-current"]);
	});
});

describe("shared provider authority ledger", () => {
	const binding = {
		principalId: "principal",
		scopeId: "scope",
		audience: "cmux-machine-provider",
		runtimeId: "runtime",
		runtimeGeneration: "runtime-generation",
		providerControlGeneration: "control-generation-a",
		purpose: "runtime.connect.cmux",
	};
	test("activates a ticket on another replica and atomically fences replacement", async () => {
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage });
		const second = new SharedControlStore({ storage });
		expect(await first.installProviderControlGeneration({ principalId: binding.principalId, generation: binding.providerControlGeneration })).toEqual({ outcome: "installed" });
		expect(await first.registerProviderConnection({ ...binding, connectionId: "connection-one", ticket: "a".repeat(32) })).toEqual({ outcome: "registered" });
		const consumable = await first.mintTicket({ ...binding, ttlSeconds: 60 });
		expect(await second.activateProviderConnection({ ...binding, ticket: "a".repeat(32) })).toEqual({ outcome: "active", connectionId: "connection-one" });
		expect(await first.isProviderConnectionActive("connection-one")).toBeTrue();
		expect(await second.installProviderControlGeneration({ principalId: binding.principalId, generation: "control-generation-b" })).toEqual({
			outcome: "installed",
			replaced: { generation: binding.providerControlGeneration, bindings: [binding] },
		});
		expect(await first.isProviderConnectionActive("connection-one")).toBeFalse();
		expect(await first.consumeTicket({ ...binding, ticket: consumable.ticket })).toBeFalse();
	});
	test("expires crashed active provider connections and renews live leases", async () => {
		let now = 1_000_000;
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage, now: () => now, maximumProviderConnections: 1 });
		const second = new SharedControlStore({ storage, now: () => now, maximumProviderConnections: 1 });
		await first.installProviderControlGeneration({ principalId: binding.principalId, generation: binding.providerControlGeneration });
		await first.registerProviderConnection({ ...binding, connectionId: "connection-crashed", ticket: "c".repeat(32) });
		await second.activateProviderConnection({ ...binding, ticket: "c".repeat(32) });
		now += 20_000;
		expect(await second.renewProviderConnection("connection-crashed")).toBe("renewed");
		now += 29_999;
		expect(await first.isProviderConnectionActive("connection-crashed")).toBeTrue();
		now += 2;
		expect(await first.isProviderConnectionActive("connection-crashed")).toBeFalse();
		expect(await first.registerProviderConnection({ ...binding, connectionId: "connection-replacement", ticket: "d".repeat(32) })).toEqual({ outcome: "registered" });
	});
	test("claims assertion nonces once across replicas and reclaims bounded expired state", async () => {
		let now = 1_000_000;
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage, now: () => now, maximumProviderAssertionNonces: 1 });
		const second = new SharedControlStore({ storage, now: () => now, maximumProviderAssertionNonces: 1 });
		expect(await first.claimProviderAssertionNonce({ nonce: "a".repeat(24), expiresAt: 1_020 })).toBe("claimed");
		expect(await second.claimProviderAssertionNonce({ nonce: "a".repeat(24), expiresAt: 1_020 })).toBe("replayed");
		now = 1_021_000;
		expect(await second.claimProviderAssertionNonce({ nonce: "b".repeat(24), expiresAt: 1_041 })).toBe("claimed");
	});
	test("persists a monotonic assertion keyring floor while allowing bounded mixed projection reload", async () => {
		let now = 100_000;
		const storage = new MemoryStorage();
		const first = new SharedControlStore({ storage, now: () => now });
		const second = new SharedControlStore({ storage, now: () => now });
		expect(await first.acceptProviderAssertionKeyring({ revision: 1, activeKid: "rotation-1", assertionKid: "rotation-1" })).toBe("accepted");
		expect(await second.acceptProviderAssertionKeyring({ revision: 2, activeKid: "rotation-2", assertionKid: "rotation-2", previousKid: "rotation-1", previousNotAfter: 130 })).toBe("accepted");
		expect(await first.acceptProviderAssertionKeyring({ revision: 1, activeKid: "rotation-1", assertionKid: "rotation-1" })).toBe("accepted");
		expect(await second.acceptProviderAssertionKeyring({ revision: 2, activeKid: "other-kid", assertionKid: "other-kid" })).toBe("rollback");
		expect(await second.acceptProviderAssertionKeyring({ revision: 3, activeKid: "rotation-3", assertionKid: "rotation-3", previousKid: "rotation-2", previousNotAfter: 160 })).toBe("accepted");
		expect(await first.acceptProviderAssertionKeyring({ revision: 2, activeKid: "rotation-2", assertionKid: "rotation-2", previousKid: "rotation-1", previousNotAfter: 130 })).toBe("accepted");
		expect(await first.acceptProviderAssertionKeyring({ revision: 2, activeKid: "rotation-2", assertionKid: "rotation-1", previousKid: "rotation-1", previousNotAfter: 130 })).toBe("rollback");
		now = 161_000;
		expect(await first.acceptProviderAssertionKeyring({ revision: 2, activeKid: "rotation-2", assertionKid: "rotation-2", previousKid: "rotation-1", previousNotAfter: 130 })).toBe("rollback");
	});
});
