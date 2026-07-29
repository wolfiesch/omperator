import { expect, test } from "bun:test";
import type { ClientFrame, CommandFrame, HelloFrame, Revision } from "@t4-code/host-wire";
import { TailscaleRemotePolicy } from "../src/remote/policy.ts";
import type { RemoteConnection } from "../src/remote/types.ts";
import {
	type AuthenticatedPrincipal,
	DefaultAuthorizationGuard,
	type DeviceRecord,
	type DeviceRegistry,
	LeaseRegistry,
	type RemotePeerIdentity,
} from "../src/security/index.ts";

const revisionValue = "r" as Revision;

const identity: RemotePeerIdentity = { nodeId: "node", login: "user@example", hostId: "host", tailnetIp: "100.64.0.2" };
const identityKey = JSON.stringify([identity.nodeId, identity.login, identity.hostId, identity.tailnetIp]);
const record: DeviceRecord = {
	deviceId: "device",
	identityKey,
	capabilities: ["sessions.read", "sessions.control", "files.write", "term.input", "preview.read"],
	metadata: { label: "test" },
	createdAt: 1,
	lastSeenAt: 1,
	tokenExpiresAt: 9_999_999,
	revokedAt: null,
	epoch: 0,
};
class Registry implements DeviceRegistry {
	readonly listeners = new Set<(deviceId: string) => void>();
	readonly active = new Map<string, AuthenticatedPrincipal>();
	current: DeviceRecord = record;
	authenticate(
		deviceId: string,
		token: string,
		_identity: RemotePeerIdentity,
		connectionId: string,
	): AuthenticatedPrincipal {
		if (deviceId !== record.deviceId || token !== "token") throw new Error("denied");
		const principal = { ...this.current, authenticatedAt: 1, connectionId };
		this.active.set(`${connectionId}:${deviceId}`, principal);
		return principal;
	}
	get(deviceId: string) {
		return deviceId === this.current.deviceId ? this.current : null;
	}
	create() {}
	updateMetadata() {}
	revoke(deviceId: string) {
		if (deviceId !== this.current.deviceId) return;
		this.current = { ...this.current, revokedAt: 2, epoch: this.current.epoch + 1 };
		for (const key of this.active.keys()) if (key.endsWith(`:${deviceId}`)) this.active.delete(key);
		for (const listener of this.listeners) listener(deviceId);
	}
	list() {
		return [this.current];
	}
	close() {}
	getAuthenticatedPrincipal(connectionId: string, deviceId: string) {
		return this.active.get(`${connectionId}:${deviceId}`) ?? null;
	}
	onInvalidation(listener: (deviceId: string) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
function connection(connectionId: string, closeCalls: { count: number }): RemoteConnection {
	return {
		connectionId,
		peer: {
			address: identity.tailnetIp,
			source: "direct",
			identity: { ...identity, addresses: [identity.tailnetIp], source: "direct" },
		},
		socket: {
			connectionId,
			peer: {
				address: identity.tailnetIp,
				source: "direct",
				identity: { ...identity, addresses: [identity.tailnetIp], source: "direct" },
			},
			send: () => true,
			close: () => {
				closeCalls.count += 1;
			},
		},
	};
}
function hello(_connectionId: string, capabilities?: string[], requestedFeatures: string[] = []): HelloFrame {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "test", version: "1", build: "test", platform: "linux" },
		requestedFeatures,
		savedCursors: [],
		...(capabilities === undefined ? {} : { capabilities: { client: capabilities } }),
		authentication: { deviceId: "device", deviceToken: "token" },
	} as HelloFrame;
}
function command(
	commandId: string,
	name: string,
	sessionId = "session",
	args: Record<string, unknown> = {},
): CommandFrame {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: `request-${commandId}`,
		commandId,
		hostId: "host",
		sessionId,
		command: name,
		args,
	} as unknown as CommandFrame;
}

test("authenticated capability omission uses the explicit default, while empty is zero", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry });
	const omitted = connection("omitted", { count: 0 });
	expect(policy.authenticate(omitted, hello("omitted")).grantedCapabilities).toEqual([
		"sessions.read",
		"sessions.control",
	]);
	const empty = connection("empty", { count: 0 });
	expect(policy.authenticate(empty, hello("empty", [] as string[])).grantedCapabilities).toEqual([]);
	policy.close();
});

test("heartbeat ping stays authorized while pairing and after authentication", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry });
	const heartbeat = {
		v: "omp-app/1",
		type: "ping",
		nonce: "heartbeat",
		timestamp: "2026-07-22T00:00:00.000Z",
	} as ClientFrame;
	const pairing = connection("pairing", { count: 0 });
	const pairingContext = { connectionId: pairing.connectionId, peer: pairing.peer };
	expect(policy.authorize(pairing, heartbeat, pairingContext)).toBe(false);
	expect(
		policy.authenticate(pairing, { ...hello("pairing"), authentication: undefined } as HelloFrame).authentication,
	).toBe("pairing-required");
	expect(policy.authorize(pairing, heartbeat, pairingContext)).toBe(true);

	const paired = connection("paired", { count: 0 });
	expect(policy.authenticate(paired, hello("paired")).authentication).toBe("paired");
	expect(
		policy.authorize(paired, { ...heartbeat, nonce: "paired-heartbeat" } as ClientFrame, {
			connectionId: paired.connectionId,
			peer: paired.peer,
		}),
	).toBe(true);
	policy.close();
});

test("controller lease feature gates interception and replay is idempotent", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
	const calls = { count: 0 };
	const connectionValue = connection("lease", calls);
	expect(policy.authenticate(connectionValue, hello("lease", ["sessions.control"], [])).grantedFeatures).toEqual([]);
	const denied = command("acquire-denied", "controller.lease.acquire");
	expect(policy.authorize(connectionValue, denied, { connectionId: "lease", peer: connectionValue.peer })).toBe(false);
	expect(policy.handleCommand(connectionValue, denied)).toBeUndefined();
	const reconnect = connection("lease-ready", calls);
	expect(
		policy.authenticate(reconnect, hello("lease-ready", ["sessions.control"], ["controller.lease"])).grantedFeatures,
	).toEqual(["controller.lease"]);
	const acquire = { ...command("acquire", "controller.lease.acquire"), expectedRevision: "r" } as CommandFrame;
	expect(
		policy.authorize(reconnect, acquire, {
			connectionId: "lease-ready",
			peer: reconnect.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	const first = policy.handleCommand(reconnect, acquire);
	expect(first).toBeDefined();
	const retry = { ...acquire, requestId: "request-retry" } as CommandFrame;
	expect(
		policy.authorize(reconnect, retry, {
			connectionId: "lease-ready",
			peer: reconnect.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	expect(policy.handleCommand(reconnect, retry)).toMatchObject({
		type: "response",
		requestId: "request-retry",
		commandId: "acquire",
	});
	expect(
		policy.authorize(reconnect, command("acquire", "controller.lease.acquire", "other"), {
			connectionId: "lease-ready",
			peer: reconnect.peer,
		}),
	).toBe(false);
	policy.close();
});
test("stale lease acquire is typed and does not allocate before a fresh acquire", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
	const connectionValue = connection("stale-acquire", { count: 0 });
	policy.authenticate(connectionValue, hello("stale-acquire", ["sessions.control"], ["controller.lease"]));
	const context = {
		connectionId: connectionValue.connectionId,
		peer: connectionValue.peer,
		sessionRevision: "fresh" as Revision,
	};
	const stale = { ...command("stale", "controller.lease.acquire"), expectedRevision: "old" } as CommandFrame;
	expect(policy.authorize(connectionValue, stale, context)).toBe(true);
	expect(policy.handleCommand(connectionValue, stale)).toMatchObject({
		type: "response",
		ok: false,
		error: {
			code: "stale_revision",
			details: { expectedRevision: "old", actualRevision: "fresh" },
		},
	});
	const fresh = { ...command("fresh", "controller.lease.acquire"), expectedRevision: "fresh" } as CommandFrame;
	expect(policy.authorize(connectionValue, fresh, context)).toBe(true);
	expect(policy.handleCommand(connectionValue, fresh)).toMatchObject({
		type: "response",
		ok: true,
		result: { leaseId: expect.any(String) },
	});
	policy.close();
});

test("held lease acquire is a soft error, never a connection-level denial", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
	const calls = { count: 0 };
	const connectionValue = connection("held-acquire", calls);
	policy.authenticate(connectionValue, hello("held-acquire", ["sessions.control"], ["controller.lease"]));
	const context = {
		connectionId: connectionValue.connectionId,
		peer: connectionValue.peer,
		sessionRevision: "fresh" as Revision,
	};
	const first = { ...command("first", "controller.lease.acquire"), expectedRevision: "fresh" } as CommandFrame;
	expect(policy.authorize(connectionValue, first, context)).toBe(true);
	expect(policy.handleCommand(connectionValue, first)).toMatchObject({ type: "response", ok: true });
	// A second acquire while the first lease is live must answer with a typed
	// error response — returning false here would close the connection (1008)
	// mid-conversation and drop the user's message.
	const second = { ...command("second", "controller.lease.acquire"), expectedRevision: "fresh" } as CommandFrame;
	expect(policy.authorize(connectionValue, second, context)).toBe(true);
	expect(policy.handleCommand(connectionValue, second)).toMatchObject({
		type: "response",
		ok: false,
		error: { code: "lease_held" },
	});
	expect(calls.count).toBe(0);
	policy.close();
});

test("registry invalidation closes once and clears authorization state", () => {
	const registry = new Registry();
	const calls = { count: 0 };
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
	const connectionValue = connection("revoke", calls);
	policy.authenticate(connectionValue, hello("revoke", ["sessions.control"], ["controller.lease"]));
	const acquire = {
		...command("acquire", "controller.lease.acquire"),
		expectedRevision: "r",
	} as CommandFrame;
	expect(
		policy.authorize(connectionValue, acquire, {
			connectionId: "revoke",
			peer: connectionValue.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	registry.revoke("device");
	expect(calls.count).toBe(1);
	expect(policy.authorize(connectionValue, acquire, { connectionId: "revoke", peer: connectionValue.peer })).toBe(
		false,
	);
	expect(calls.count).toBe(1);
	expect(policy.handleCommand(connectionValue, acquire)).toBeUndefined();
	policy.disconnected(connectionValue);
	policy.disconnected(connectionValue);
	policy.close();
});

test("controller lease gates session mutations for the owning connection and expires", () => {
	let now = 1_000;
	const registry = new Registry();
	registry.current = { ...record, capabilities: [...record.capabilities, "sessions.manage"] };
	const policy = new TailscaleRemotePolicy({
		registry,
		clock: { now: () => now },
		supportedFeatures: ["controller.lease"],
	});
	const owner = connection("mutation-owner", { count: 0 });
	policy.authenticate(
		owner,
		hello("mutation-owner", ["sessions.control", "sessions.manage", "files.write"], ["controller.lease"]),
	);
	const acquire = {
		...command("mutation-lease", "controller.lease.acquire", "session"),
		expectedRevision: "r",
	} as CommandFrame;
	expect(
		policy.authorize(owner, acquire, {
			connectionId: owner.connectionId,
			peer: owner.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	const leaseResponse = policy.handleCommand(owner, acquire);
	const leaseId = String((leaseResponse as { result?: { leaseId?: string } } | undefined)?.result?.leaseId);
	expect(leaseId).not.toBe("undefined");
	const write = command("write", "files.write", "session", { leaseId, path: "file.txt", content: "ok" });
	expect(policy.authorize(owner, write, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
	const review = command("review", "review.apply", "session", { leaseId, reviewId: "review" });
	expect(policy.authorize(owner, review, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
	const fastWithoutLease = {
		...command("fast-without-lease", "session.fast.set", "session", { enabled: true }),
		expectedRevision: "r",
	} as CommandFrame;
	expect(
		policy.authorize(owner, fastWithoutLease, {
			connectionId: owner.connectionId,
			peer: owner.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(false);
	const fast = {
		...command("fast", "session.fast.set", "session", { leaseId, enabled: true }),
		expectedRevision: "r",
	} as CommandFrame;
	expect(
		policy.authorize(owner, fast, {
			connectionId: owner.connectionId,
			peer: owner.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	const wrongConnection = connection("mutation-other", { count: 0 });
	policy.authenticate(
		wrongConnection,
		hello("mutation-other", ["sessions.control", "files.write"], ["controller.lease"]),
	);
	expect(
		policy.authorize(
			wrongConnection,
			command("wrong", "files.write", "session", { leaseId, path: "file.txt", content: "no" }),
			{ connectionId: wrongConnection.connectionId, peer: wrongConnection.peer },
		),
	).toBe(false);
	now += 31_000;
	expect(
		policy.authorize(
			owner,
			command("expired", "files.write", "session", { leaseId, path: "file.txt", content: "late" }),
			{ connectionId: owner.connectionId, peer: owner.peer },
		),
	).toBe(false);
	policy.close();
});
test("prompt lease gates prompt mutations by device, connection, session, revision, and expiry", () => {
	let now = 1_000;
	const registry = new Registry();
	registry.current = { ...record, capabilities: [...record.capabilities, "sessions.prompt"] };
	const policy = new TailscaleRemotePolicy({
		registry,
		clock: { now: () => now },
		supportedFeatures: ["prompt.lease"],
	});
	const owner = connection("prompt-owner", { count: 0 });
	policy.authenticate(owner, hello("prompt-owner", ["sessions.prompt"], ["prompt.lease"]));
	const acquire = {
		...command("prompt-acquire", "prompt.lease.acquire", "session"),
		expectedRevision: "r",
	} as CommandFrame;
	expect(
		policy.authorize(owner, acquire, {
			connectionId: owner.connectionId,
			peer: owner.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(true);
	const leaseResponse = policy.handleCommand(owner, acquire);
	const leaseId = String((leaseResponse as { result?: { leaseId?: string } } | undefined)?.result?.leaseId);
	const prompt = {
		...command("prompt", "session.prompt", "session", { message: "hello", leaseId }),
		expectedRevision: "r",
	} as CommandFrame;
	expect(policy.authorize(owner, prompt, { connectionId: owner.connectionId, peer: owner.peer })).toBe(true);
	expect(
		policy.authorize(owner, { ...prompt, sessionId: "other", commandId: "wrong-session" } as CommandFrame, {
			connectionId: owner.connectionId,
			peer: owner.peer,
		}),
	).toBe(false);
	expect(
		policy.authorize(owner, { ...prompt, expectedRevision: "other", commandId: "wrong-revision" } as CommandFrame, {
			connectionId: owner.connectionId,
			peer: owner.peer,
		}),
	).toBe(false);
	const other = connection("prompt-other", { count: 0 });
	policy.authenticate(other, hello("prompt-other", ["sessions.prompt"], ["prompt.lease"]));
	expect(
		policy.authorize(other, { ...prompt, commandId: "wrong-connection" } as CommandFrame, {
			connectionId: other.connectionId,
			peer: other.peer,
		}),
	).toBe(false);
	expect(
		policy.authorize(
			owner,
			{
				...prompt,
				commandId: "malformed",
				args: { message: "hello", leaseId: "bad\u0000lease" },
			} as unknown as CommandFrame,
			{ connectionId: owner.connectionId, peer: owner.peer },
		),
	).toBe(false);
	now += 31_000;
	expect(
		policy.authorize(owner, { ...prompt, commandId: "expired" } as CommandFrame, {
			connectionId: owner.connectionId,
			peer: owner.peer,
		}),
	).toBe(false);
	policy.close();
});
test("prompt lease release remains authorized by the default guard before revocation", () => {
	const now = 1_000;
	const clock = { now: () => now };
	const registry = new Registry();
	registry.current = { ...record, capabilities: [...record.capabilities, "sessions.prompt"] };
	const leases = new LeaseRegistry(clock);
	const guard = new DefaultAuthorizationGuard(registry, leases, undefined, clock, () => "r");
	const policy = new TailscaleRemotePolicy({
		registry,
		leases,
		guard,
		clock,
		supportedFeatures: ["prompt.lease"],
	});
	const owner = connection("guarded-prompt-owner", { count: 0 });
	policy.authenticate(owner, hello(owner.connectionId, ["sessions.prompt"], ["prompt.lease"]));
	const context = { connectionId: owner.connectionId, peer: owner.peer, sessionRevision: revisionValue };
	const acquire = {
		...command("guarded-acquire", "prompt.lease.acquire", "session"),
		expectedRevision: "r",
	} as CommandFrame;
	expect(policy.authorize(owner, acquire, context)).toBe(true);
	const acquired = policy.handleCommand(owner, acquire);
	const leaseId = String((acquired as { result?: { leaseId?: string } } | undefined)?.result?.leaseId);
	const release = {
		...command("guarded-release", "prompt.lease.release", "session", { leaseId }),
		expectedRevision: "r",
	} as CommandFrame;
	expect(policy.authorize(owner, release, context)).toBe(true);
	expect(policy.handleCommand(owner, release)).toMatchObject({
		type: "response",
		ok: true,
		result: { leaseId, released: true },
	});
	const prompt = {
		...command("guarded-prompt", "session.prompt", "session", { message: "denied", leaseId }),
		expectedRevision: "r",
	} as CommandFrame;
	expect(policy.authorize(owner, prompt, context)).toBe(false);
	policy.close();
});
test("remote terminal opens remain confirmation protected", () => {
	const registry = new Registry();
	registry.current = {
		...registry.current,
		capabilities: [...registry.current.capabilities, "term.open"],
	};
	const guard = new DefaultAuthorizationGuard(registry);
	const policy = new TailscaleRemotePolicy({ registry, guard });
	const remote = connection("guarded-terminal", { count: 0 });
	policy.authenticate(remote, hello(remote.connectionId, ["term.open"]));
	expect(
		policy.authorize(remote, command("guarded-terminal-open", "term.open"), {
			connectionId: remote.connectionId,
			peer: remote.peer,
			sessionRevision: revisionValue,
		}),
	).toBe(false);
	policy.close();
});
test("preview commands require negotiated preview.control and preview capability", () => {
	const registry = new Registry();
	registry.current = {
		...registry.current,
		capabilities: [...registry.current.capabilities, "preview.control", "preview.input"],
	};
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["preview.control"] });
	const connectionValue = connection("preview", { count: 0 });
	policy.authenticate(connectionValue, hello("preview", ["preview.read"], []));
	const preview = command("preview", "preview.state", "session", {});
	expect(policy.authorize(connectionValue, preview, { connectionId: "preview", peer: connectionValue.peer })).toBe(
		false,
	);
	const negotiated = connection("preview-ready", { count: 0 });
	policy.authenticate(negotiated, hello("preview-ready", ["preview.read"], ["preview.control"]));
	expect(
		policy.authorize(negotiated, { ...preview, requestId: "request-preview-ready" } as CommandFrame, {
			connectionId: "preview-ready",
			peer: negotiated.peer,
		}),
	).toBe(true);
	const inputOnly = connection("preview-input", { count: 0 });
	policy.authenticate(inputOnly, hello("preview-input", ["preview.input"], ["preview.control"]));
	const click = command("preview-click", "preview.click", "session", {
		previewId: "preview-1",
		selector: "button",
	});
	expect(policy.authorize(inputOnly, click, { connectionId: "preview-input", peer: inputOnly.peer })).toBe(true);
	expect(
		policy.authorize(negotiated, { ...click, requestId: "request-preview-click-denied" } as CommandFrame, {
			connectionId: "preview-ready",
			peer: negotiated.peer,
		}),
	).toBe(false);

	const control = connection("preview-control", { count: 0 });
	policy.authenticate(control, hello("preview-control", ["preview.control"], ["preview.control"]));
	const acquire = command("preview-lease", "preview.lease.acquire", "session", { previewId: "preview-1" });
	expect(policy.authorize(control, acquire, { connectionId: "preview-control", peer: control.peer })).toBe(true);
	expect(policy.handleCommand(control, acquire)).toBeUndefined();
	policy.close();
});

test("transcript pages require both the negotiated read feature and sessions.read", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["transcript.page"] });
	const missingFeature = connection("page-missing-feature", { count: 0 });
	policy.authenticate(missingFeature, hello("page-missing-feature", ["sessions.read"], []));
	const page = command("page", "transcript.page", "session", { limit: 10 });
	expect(
		policy.authorize(missingFeature, page, {
			connectionId: missingFeature.connectionId,
			peer: missingFeature.peer,
		}),
	).toBe(false);

	const ready = connection("page-ready", { count: 0 });
	policy.authenticate(ready, hello("page-ready", ["sessions.read"], ["transcript.page"]));
	expect(policy.authorize(ready, page, { connectionId: ready.connectionId, peer: ready.peer })).toBe(true);

	const missingCapability = connection("page-missing-capability", { count: 0 });
	policy.authenticate(missingCapability, hello("page-missing-capability", [], ["transcript.page"]));
	expect(
		policy.authorize(missingCapability, page, {
			connectionId: missingCapability.connectionId,
			peer: missingCapability.peer,
		}),
	).toBe(false);
	policy.close();
});

test("project file search requires both its negotiated feature and files.list", () => {
	const registry = new Registry();
	registry.current = { ...record, capabilities: [...record.capabilities, "files.list"] };
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["files.search"] });
	const search = command("file-search", "files.search", "session", { query: "app" });

	const missingFeature = connection("file-search-missing-feature", { count: 0 });
	policy.authenticate(missingFeature, hello(missingFeature.connectionId, ["files.list"], []));
	expect(
		policy.authorize(missingFeature, search, {
			connectionId: missingFeature.connectionId,
			peer: missingFeature.peer,
		}),
	).toBe(false);

	const ready = connection("file-search-ready", { count: 0 });
	policy.authenticate(ready, hello(ready.connectionId, ["files.list"], ["files.search"]));
	expect(policy.authorize(ready, search, { connectionId: ready.connectionId, peer: ready.peer })).toBe(true);

	const missingCapability = connection("file-search-missing-capability", { count: 0 });
	policy.authenticate(missingCapability, hello(missingCapability.connectionId, [], ["files.search"]));
	expect(
		policy.authorize(missingCapability, search, {
			connectionId: missingCapability.connectionId,
			peer: missingCapability.peer,
		}),
	).toBe(false);
	policy.close();
});

test("terminal input needs terminal.io even when term.input is granted", () => {
	const registry = new Registry();
	const policy = new TailscaleRemotePolicy({ registry, supportedFeatures: ["controller.lease"] });
	const connectionValue = connection("terminal", { count: 0 });
	policy.authenticate(connectionValue, hello("terminal", ["term.input"], []));
	const terminal = {
		v: "omp-app/1",
		type: "terminal.input",
		hostId: "host",
		sessionId: "session",
		terminalId: "terminal",
		data: "x",
	} as unknown as ClientFrame;
	expect(policy.authorize(connectionValue, terminal, { connectionId: "terminal", peer: connectionValue.peer })).toBe(
		false,
	);
	policy.close();
});
