import { describe, expect, it, vi } from "vite-plus/test";
import {
	agentId,
	commandId,
	entryId,
	hostId,
	projectId,
	requestId,
	revision,
	sessionId,
	type ClientFrame,
	type ServerFrame,
	type SessionRef,
} from "@t4-code/host-wire";
import { ClusterGateway, type GatewayClient, type GatewayMutationBackend } from "../src/gateway.ts";
import { Authorizer, type AuthorizationAuditEvent } from "../src/authorization.ts";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import { KubernetesApiError } from "../src/kubernetes-client.ts";
import type { RequestIdentity } from "../src/identity.ts";
import type { PodHostConnection, PodHostConnector, PodHostRoute } from "../src/pod-host-router.ts";
import type { RuntimeIngressIdentity, RuntimeIngressLedger } from "@t4-code/portable-control-store";

const PRINCIPAL = "owner@example.com";
const IDENTITY: RequestIdentity = Object.freeze({
	principalId: PRINCIPAL,
	authorizedScopes: Object.freeze([]),
	adapter: Object.freeze({ id: "test", type: "tailscale" }),
	policyRevision: "1",
});
function authority(upstreamSessionId: string): SessionRef {
	return {
		hostId: hostId("session-pod"),
		sessionId: sessionId(upstreamSessionId),
		project: { projectId: projectId("t4-code"), name: "T4 code" },
		revision: revision("authority-r1"),
		title: "Authoritative OMP session",
		status: "idle",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
}

const host = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4ClusterHost",
	metadata: { name: "primary", uid: "host-uid", resourceVersion: "10", generation: 1 },
	status: { observedGeneration: 1, conditions: [] },
};
const workspace = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4Workspace",
	metadata: { name: "workspace-one", uid: "workspace-uid", resourceVersion: "11", generation: 1 },
	spec: { hostRef: "primary", owner: PRINCIPAL, displayName: "Workspace one", retentionPolicy: "Retain", size: "20Gi" },
	status: { observedGeneration: 1, phase: "Ready", conditions: [] },
};
const session = (name: string) => ({
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4Session",
	metadata: { name, uid: `${name}-uid`, resourceVersion: name === "session-one" ? "12" : "13", generation: 1 },
	spec: { hostRef: "primary", workspaceRef: "workspace-one", title: name, runtimeProfile: "omp-17.0.5", guiEnabled: true },
	status: {
		observedGeneration: 1,
		runtimeGeneration: `gen_${name.replaceAll("-", "_")}`,
		phase: "Ready",
		serviceName: name,
		podName: `${name}-pod`,
		conditions: [{ type: "RouteReady", status: "True", observedGeneration: 1 }],
	},
});

class MemoryClient implements GatewayClient {
	readonly frames: ServerFrame[] = [];
	readonly closes: Array<[number | undefined, string | undefined]> = [];
	send(frame: ServerFrame): void { this.frames.push(frame); }
	close(code?: number, reason?: string): void { this.closes.push([code, reason]); }
}

class MemoryConnector implements PodHostConnector {
	readonly routes: PodHostRoute[] = [];
	readonly sent: ClientFrame[] = [];
	onFrame?: (frame: ServerFrame) => void;
	readonly frameCallbacks: Array<(frame: ServerFrame) => void> = [];
	readonly closeCallbacks: Array<() => void> = [];
	async connect(route: PodHostRoute, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection> {
		this.routes.push(route);
		this.onFrame = onFrame;
		this.frameCallbacks.push(onFrame);
		if (onClose) this.closeCallbacks.push(onClose);
		return { send: frame => { this.sent.push(frame); }, close: () => undefined };
	}
}

class PendingConnector extends MemoryConnector {
	readonly closes: Array<[number | undefined, string | undefined]> = [];
	#resolve: (() => void) | undefined;
	override connect(route: PodHostRoute, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection> {
		this.routes.push(route);
		this.onFrame = onFrame;
		this.frameCallbacks.push(onFrame);
		if (onClose) this.closeCallbacks.push(onClose);
		const deferred = Promise.withResolvers<PodHostConnection>();
		this.#resolve = () => {
			this.#resolve = undefined;
			deferred.resolve({
				send: frame => { this.sent.push(frame); },
				close: (code, reason) => { this.closes.push([code, reason]); },
			});
		};
		return deferred.promise;
	}
	resolveConnection(): void {
		if (!this.#resolve) throw new Error("pod connector is not pending");
		this.#resolve();
	}
}

class MemoryIngress implements RuntimeIngressLedger {
	readonly leases = new Map<string, Set<string>>();
	readonly fenced = new Set<string>();
	#counter = 0;
	releaseFailuresRemaining = 0;
	readonly released = Promise.withResolvers<void>();
	#key(request: RuntimeIngressIdentity): string { return `${request.runtimeId}\0${request.generation}`; }
	async acquireRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly ttlSeconds: number }) {
		const key = this.#key(request);
		if (this.fenced.has(key)) return { outcome: "fenced" as const };
		const leaseId = `ing_${String(++this.#counter).padStart(32, "a")}`;
		const active = this.leases.get(key) ?? new Set<string>();
		active.add(leaseId);
		this.leases.set(key, active);
		return { outcome: "acquired" as const, leaseId, expiresAt: new Date(Date.now() + request.ttlSeconds * 1000).toISOString() };
	}
	async renewRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly leaseId: string; readonly ttlSeconds: number }) {
		if (this.fenced.has(this.#key(request))) return { outcome: "fenced" as const };
		return this.leases.get(this.#key(request))?.has(request.leaseId)
			? { outcome: "renewed" as const, expiresAt: new Date(Date.now() + request.ttlSeconds * 1000).toISOString() }
			: { outcome: "notFound" as const };
	}
	async releaseRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly leaseId: string }) {
		if (this.releaseFailuresRemaining > 0) {
			this.releaseFailuresRemaining--;
			throw new Error("transient release failure");
		}
		const active = this.leases.get(this.#key(request));
		this.released.resolve();
		return active?.delete(request.leaseId) ? "released" as const : "notFound" as const;
	}
	async beginRuntimeIngressDrain(request: RuntimeIngressIdentity & { readonly mode: "idle" | "explicit" }) {
		const key = this.#key(request);
		const activeLeases = this.leases.get(key)?.size ?? 0;
		if (request.mode === "idle" && activeLeases > 0) return { outcome: "busy" as const, activeLeases };
		this.fenced.add(key);
		return { outcome: "fenced" as const, activeLeases };
	}
	async reopenRuntimeIngress(request: RuntimeIngressIdentity) {
		return this.fenced.delete(this.#key(request)) ? "reopened" as const : "notFound" as const;
	}
	async runtimeIngressState(request: RuntimeIngressIdentity) {
		const key = this.#key(request);
		return { ...request, open: !this.fenced.has(key), activeLeases: this.leases.get(key)?.size ?? 0 };
	}
}

class MemoryMutations implements GatewayMutationBackend {
	workspaceCreates = 0;
	sessionCreates = 0;
	sessionDeletes = 0;
	async createWorkspace() {
		this.workspaceCreates++;
		return { id: "workspace-created", revision: "workspace-r1" };
	}
	async createSession() {
		this.sessionCreates++;
		return { sessionId: "session-created", revision: "session-r1" };
	}
	async deleteSession() {
		this.sessionDeletes++;
		return { deleted: true as const };
	}
}

function setup(
	epoch = "replica-uid-1",
	connector: MemoryConnector = new MemoryConnector(),
	runtimeIngress: MemoryIngress = new MemoryIngress(),
	onProtocolMismatch?: () => void,
) {
	const projection = new ClusterInfrastructureProjection({ epoch, namespace: "development" });
	projection.replace({
		host,
		workspaces: [workspace],
		sessions: [session("session-one"), session("session-two")],
		resourceVersion: "13",
	});
	projection.setSessionAuthority("session-one", authority("omp-private-one"));
	projection.setSessionAuthority("session-two", authority("omp-private-two"));
	const mutations = new MemoryMutations();
	const gateway = new ClusterGateway({ projection, connector, mutations, runtimeIngress, ...(onProtocolMismatch ? { onProtocolMismatch } : {}) });
	const client = new MemoryClient();
	const connection = gateway.connect(client, IDENTITY);
	return { projection, connector, mutations, gateway, runtimeIngress, client, connection };
}

const hello = {
	v: "omp-app/1" as const,
	type: "hello" as const,
	protocol: { min: "omp-app/1", max: "omp-app/1" },
	client: { name: "test", version: "1", build: "test", platform: "linux" },
	requestedFeatures: ["resume", "preview.control", "cluster.operator"],
	savedCursors: [],
	capabilities: { client: ["sessions.read", "sessions.manage", "preview.read", "preview.control", "ci.trigger"] },
};

describe("stateless omp-app cluster gateway", () => {
	it("negotiates cluster.operator, bootstraps one canonical inventory, and changes epoch on replica restart", async () => {
		const first = setup("replica-uid-1");
		await first.connection.receive(hello);
		expect(first.client.frames.map(frame => frame.type)).toEqual(["welcome", "sessions"]);
		expect(first.client.frames[0]).toMatchObject({
			type: "welcome",
			hostId: "cluster:host-uid",
			epoch: "replica-uid-1",
			grantedFeatures: ["resume", "preview.control", "cluster.operator"],
		});
		expect((first.client.frames[1] as { sessions: unknown[] }).sessions).toHaveLength(2);

		const second = setup("replica-uid-2");
		await second.connection.receive({ ...hello, savedCursors: [{ hostId: "cluster:host-uid", sessionId: "session-one", cursor: { epoch: "replica-uid-1", seq: 7 } }] });
		expect(second.client.frames[0]).toMatchObject({ type: "welcome", epoch: "replica-uid-2", resumed: false });
		expect((second.client.frames[1] as { sessions: unknown[] }).sessions).toHaveLength(2);
	});

	it("reports malformed OMP frames through the production mismatch producer seam", async () => {
		const onProtocolMismatch = vi.fn();
		const value = setup("replica-mismatch", new MemoryConnector(), new MemoryIngress(), onProtocolMismatch);
		await value.connection.receive("{not-json");
		expect(onProtocolMismatch).toHaveBeenCalledOnce();
		expect(value.client.closes).toContainEqual([1002, "invalid omp-app frame"]);
	});

	it("expires a route locally during ledger partition and ignores a late renewal", async () => {
		vi.useFakeTimers();
		try {
			const lateRenewal = Promise.withResolvers<{ readonly outcome: "renewed"; readonly expiresAt: string }>();
			class PartitionedIngress extends MemoryIngress {
				override async runtimeIngressState(request: RuntimeIngressIdentity) {
					await Promise.reject(new Error("ledger partition"));
					return super.runtimeIngressState(request);
				}
				override async renewRuntimeIngress() {
					return await lateRenewal.promise;
				}
			}
			const connector = new PendingConnector();
			const value = setup("replica-partition", connector, new PartitionedIngress());
			await value.connection.receive(hello);
			const attaching = value.connection.receive({
				v: "omp-app/1", type: "command", requestId: "request-expiry", commandId: "command-expiry",
				hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
			});
			await vi.advanceTimersByTimeAsync(0);
			connector.resolveConnection();
			await attaching;
			await vi.advanceTimersByTimeAsync(4_001);
			expect(connector.closes).toContainEqual([1012, "runtime ingress lease expired"]);
			lateRenewal.resolve({ outcome: "renewed", expiresAt: new Date(Date.now() + 60_000).toISOString() });
			await vi.advanceTimersByTimeAsync(0);
			expect(connector.closes).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies an identity without omp-app connect before projection, connector, or mutation backends", async () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-reader", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session("session-one")], resourceVersion: "13" });
		const connector = new MemoryConnector();
		const mutations = new MemoryMutations();
		const gateway = new ClusterGateway({ projection, connector, mutations, runtimeIngress: new MemoryIngress() });
		const client = new MemoryClient();
		const reader: RequestIdentity = Object.freeze({
			...IDENTITY,
			authorizedScopes: Object.freeze([{ scopeId: "personal", roles: Object.freeze(["reader"]) }]),
		});
		const connection = gateway.connect(client, reader);
		await connection.receive(hello);
		expect(client.closes).toEqual([[1008, "gateway scope unavailable"]]);
		expect(connector.routes).toEqual([]);
		expect(mutations).toMatchObject({ workspaceCreates: 0, sessionCreates: 0, sessionDeletes: 0 });
		expect(client.frames).toEqual([]);
	});

	it("uses one server request ID per inbound operation and does not re-audit a preauthorized upgrade", async () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-audit", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session("session-one")], resourceVersion: "13" });
		const events: AuthorizationAuditEvent[] = [];
		const gateway = new ClusterGateway({
			projection,
			connector: new MemoryConnector(),
			mutations: new MemoryMutations(),
			authorizer: new Authorizer(event => { events.push(event); }),
			runtimeIngress: new MemoryIngress(),
		});
		const client = new MemoryClient();
		const connection = gateway.connect(client, IDENTITY, "req_upgrade");
		expect(events).toEqual([]);
		await connection.receive(hello);
		await connection.receive({
			v: "omp-app/1", type: "command", requestId: "r-list-audit", commandId: "c-list-audit",
			hostId: "cluster:host-uid", command: "workspace.list", args: {},
		});
		await Promise.resolve();
		const connectEvents = events.filter(event => event.action === "runtime.connect.omp-app");
		expect(new Set(connectEvents.map(event => event.requestId)).size).toBe(2);
		expect(events.some(event => event.requestId === "req_upgrade")).toBe(false);
	});

	it("answers the host-scoped session.list bootstrap from the Kubernetes projection", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "r-sessions", commandId: "c-sessions", hostId: "cluster:host-uid",
			command: "session.list", args: {},
		});
		expect(value.client.frames.at(-1)).toMatchObject({
			type: "response", commandId: "c-sessions", ok: true, command: "session.list",
			result: { cursor: { epoch: "replica-uid-1" }, totalCount: 2, truncated: false, sessions: [{ sessionId: "session-one" }, { sessionId: "session-two" }] },
		});
	});

	it("returns workspace bootstrap with its independent cursor and streams each watch revision once", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "r-list", commandId: "c-list", hostId: "cluster:host-uid",
			command: "workspace.list", args: {},
		});
		expect(value.client.frames.at(-1)).toMatchObject({
			type: "response", commandId: "c-list", ok: true, command: "workspace.list",
			result: { cursor: { epoch: "replica-uid-1", seq: 1 }, workspaces: [{ id: "workspace-one" }] },
		});
		value.projection.applyWatch({
			type: "MODIFIED",
			object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "20", generation: 2 }, status: { ...workspace.status, observedGeneration: 2, phase: "Failed" } },
		});
		value.projection.applyWatch({ type: "MODIFIED", object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "20" } } });
		expect(value.client.frames.filter(frame => frame.type === "workspace.state")).toHaveLength(1);
	});

	it("routes to exactly one pod host, rewrites only address ids, and preserves attach output order", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-attach", commandId: "command-attach",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
		});
		expect(value.connector.routes).toEqual([{
			clusterSessionId: "session-one",
			routeGeneration: expect.stringMatching(/^route_/u),
			runtimeGeneration: "gen_session_one",
			upstreamSessionId: "omp-private-one",
			url: "ws://session-one.development.svc:8787/v1/ws",
		}]);
		const routeGeneration = value.connector.routes[0]!.routeGeneration;
		expect(value.gateway.runtimeActivity("session-one", routeGeneration)).toEqual({ gatewayUpstreams: 1 });
		expect(value.connector.sent.at(-1)).toMatchObject({
			type: "command", requestId: "request-attach", commandId: "command-attach",
			hostId: "upstream", sessionId: "omp-private-one", command: "session.attach",
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "snapshot", hostId: hostId("upstream"), sessionId: sessionId("omp-private-one"),
			cursor: { epoch: "pod-epoch", seq: 1 }, revision: revision("session-r1"), entries: [],
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "entry", hostId: hostId("upstream"), sessionId: sessionId("omp-private-one"),
			cursor: { epoch: "pod-epoch", seq: 2 }, revision: revision("session-r2"),
			entry: { id: entryId("entry-one"), parentId: null, hostId: hostId("upstream"), sessionId: sessionId("omp-private-one"), kind: "message", timestamp: "2026-07-20T00:00:00.000Z", data: { text: "hello", correlationId: "omp-private-one" } },
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "agent", hostId: hostId("upstream"), sessionId: sessionId("omp-private-one"), agentId: agentId("Main"), state: "running", detail: {},
		});
		const forwarded = value.client.frames.slice(-3);
		expect(forwarded.map(frame => frame.type)).toEqual(["snapshot", "entry", "agent"]);
		expect(forwarded[0]).toMatchObject({ hostId: "cluster:host-uid", sessionId: "session-one" });
		expect(forwarded[1]).toMatchObject({
			hostId: "cluster:host-uid", sessionId: "session-one",
			entry: { hostId: "cluster:host-uid", sessionId: "session-one", data: { correlationId: "omp-private-one" } },
		});
		value.connection.close();
		expect(value.gateway.runtimeActivity("session-one", routeGeneration)).toEqual({ gatewayUpstreams: 0 });
	});

	it("retries a transient ingress release failure", async () => {
		const value = setup();
		value.runtimeIngress.releaseFailuresRemaining = 1;
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-release", commandId: "command-release",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
		});
		expect(value.runtimeIngress.leases.get("session-one\0gen_session_one")?.size).toBe(1);
		value.connection.close();
		await value.runtimeIngress.released.promise;
		expect(value.runtimeIngress.releaseFailuresRemaining).toBe(0);
		expect(value.runtimeIngress.leases.get("session-one\0gen_session_one")?.size).toBe(0);
	});

	it("omits transcript.search and rejects lifecycle and inventory commands outside the explicit proxy allowlist", async () => {
		const value = setup();
		await value.connection.receive({
			...hello,
			requestedFeatures: [...hello.requestedFeatures, "transcript.search"],
			capabilities: {
				client: [...hello.capabilities.client, "agents.control", "bash.run", "files.write"],
			},
		});
		const welcomeFrame = value.client.frames[0];
		expect(welcomeFrame).toMatchObject({ type: "welcome" });
		if (welcomeFrame?.type !== "welcome") throw new Error("gateway did not send welcome");
		expect(welcomeFrame.grantedFeatures).not.toContain("transcript.search");
		expect(welcomeFrame.grantedCapabilities).not.toContain("agents.control");
		expect(welcomeFrame.grantedCapabilities).not.toContain("bash.run");
		expect(welcomeFrame.grantedCapabilities).not.toContain("files.write");
		const forbidden = [
			{ command: "session.fork", args: {} },
			{ command: "session.close", expectedRevision: "authority-r1", args: {} },
			{ command: "session.archive", expectedRevision: "authority-r1", args: {} },
			{ command: "session.restore", expectedRevision: "authority-r1", args: {} },
			{ command: "runtime.list", args: {} },
			{ command: "transcript.search", args: { query: "needle" } },
		] as const;
		for (const [index, selected] of forbidden.entries()) {
			await value.connection.receive({
				v: "omp-app/1",
				type: "command",
				requestId: `request-forbidden-${index}`,
				commandId: `command-forbidden-${index}`,
				hostId: "cluster:host-uid",
				...(selected.command === "runtime.list" || selected.command === "transcript.search"
					? {}
					: { sessionId: "session-one" }),
				...selected,
			});
			expect(value.client.frames.at(-1)).toMatchObject({
				type: "response",
				commandId: `command-forbidden-${index}`,
				ok: false,
				error: { code: "UNSUPPORTED_FEATURE" },
			});
		}
		expect(value.connector.routes).toEqual([]);
	});

	it("rewrites transcript page result addresses without changing opaque user content", async () => {
		const value = setup();
		await value.connection.receive({
			...hello,
			requestedFeatures: [...hello.requestedFeatures, "transcript.page"],
		});
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-page", commandId: "command-page",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "transcript.page",
			args: { limit: 10, maxBytes: 4096 },
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "response", requestId: "request-page", commandId: "command-page",
			hostId: "private-host", sessionId: "omp-private-one", ok: true, command: "transcript.page",
			result: {
				entries: [{
					id: "entry-page", parentId: null, hostId: "private-host", sessionId: "omp-private-one",
					kind: "message", timestamp: "2026-07-20T00:00:00.000Z",
					data: { text: "literal omp-private-one", correlationId: "omp-private-one" },
				}],
				hasMore: false,
				generation: "opaque-generation",
			},
		} as never);
		const response = value.client.frames.at(-1) as unknown as {
			hostId: string;
			sessionId: string;
			result: { entries: Array<{ hostId: string; sessionId: string; data?: unknown }> };
		};
		expect(response).toMatchObject({
			hostId: "cluster:host-uid",
			sessionId: "session-one",
			result: { entries: [{
				hostId: "cluster:host-uid",
				sessionId: "session-one",
				data: { text: "literal omp-private-one", correlationId: "omp-private-one" },
			}] },
		});
		const structured = structuredClone(response);
		delete structured.result.entries[0]!.data;
		expect(JSON.stringify(structured)).not.toContain("private-host");
		expect(JSON.stringify(structured)).not.toContain("omp-private-one");
	});

	it("closes a pending route without dispatch when session ownership changes", async () => {
		const scenarios: Array<{ frame: unknown; commandId?: string }> = [
			{
				commandId: "command-revoked",
				frame: {
					v: "omp-app/1", type: "command", requestId: "request-revoked", commandId: "command-revoked",
					hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
				},
			},
			{
				commandId: "preview-revoked",
				frame: {
					v: "omp-app/1", type: "command", requestId: "request-preview-revoked", commandId: "preview-revoked",
					hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: {},
				},
			},
			{
				frame: {
					v: "omp-app/1", type: "terminal.input", hostId: "cluster:host-uid", sessionId: "session-one",
					terminalId: "terminal-revoked", data: "blocked",
				},
			},
		];
		for (const scenario of scenarios) {
			const connector = new PendingConnector();
			const value = setup("replica-uid-1", connector);
			await value.connection.receive({
				...hello,
				requestedFeatures: [...hello.requestedFeatures, "terminal.io"],
				capabilities: { client: [...hello.capabilities.client, "term.input"] },
			});
			const pending = value.connection.receive(scenario.frame);
			await Promise.resolve();
			expect(connector.routes).toHaveLength(1);
			value.projection.applyWatch({
				type: "MODIFIED",
				object: {
					...workspace,
					metadata: { ...workspace.metadata, resourceVersion: "30", generation: 2 },
					spec: { ...workspace.spec, owner: "other@example.com" },
				},
			});
			connector.resolveConnection();
			await pending;
			expect(connector.sent).toEqual([]);
			expect(connector.closes).toContainEqual([1001, "session route changed"]);
			if (scenario.commandId) {
				expect(value.client.frames.find(frame => frame.type === "response" && frame.commandId === scenario.commandId)).toMatchObject({
					type: "response", commandId: scenario.commandId, ok: false, error: { code: "NOT_AUTHORIZED" },
				});
			}
		}
	});

	it("rejects a pending connection when its authoritative upstream route changes", async () => {
		const changes: Array<(projection: ClusterInfrastructureProjection) => void> = [
			projection => projection.setSessionAuthority("session-one", authority("omp-private-moved")),
			projection => projection.applyWatch({
				type: "MODIFIED",
				object: {
					...session("session-one"),
					metadata: { ...session("session-one").metadata, resourceVersion: "31", generation: 2 },
					status: { ...session("session-one").status, serviceName: "session-one-moved" },
				},
			}),
		];
		for (const [index, change] of changes.entries()) {
			const connector = new PendingConnector();
			const value = setup("replica-uid-1", connector);
			await value.connection.receive(hello);
			const commandId = `command-route-changed-${index}`;
			const pending = value.connection.receive({
				v: "omp-app/1", type: "command", requestId: `request-route-changed-${index}`, commandId,
				hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
			});
			await Promise.resolve();
			expect(connector.routes).toHaveLength(1);
			change(value.projection);
			connector.resolveConnection();
			await pending;
			expect(connector.sent).toEqual([]);
			expect(connector.closes).toContainEqual([1001, "session route changed"]);
			expect(value.client.frames.find(frame => frame.type === "response" && frame.commandId === commandId)).toMatchObject({
				type: "response",
				commandId,
				ok: false,
				error: { code: index === 0 ? "UPSTREAM_UNAVAILABLE" : "NOT_AUTHORIZED" },
			});
		}
	});

	it("drops cached routes and delayed frames across a stable-URL generation replacement", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-stale", commandId: "command-stale",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
		});
		const staleCallback = value.connector.frameCallbacks[0]!;
		const oldGeneration = value.connector.routes[0]!.routeGeneration;
		value.projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session("session-one"),
				metadata: {
					...session("session-one").metadata,
					uid: "session-one-replacement-uid",
					generation: 2,
					resourceVersion: "40",
				},
				status: {
					...session("session-one").status,
					observedGeneration: 2,
					runtimeGeneration: "gen_session_one_replacement",
					conditions: [{ type: "RouteReady", status: "True", observedGeneration: 2 }],
				},
			},
		});
		value.projection.setSessionAuthority("session-one", authority("omp-private-fresh"));
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-fresh", commandId: "command-fresh",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.attach", args: {},
		});
		expect(value.connector.routes).toHaveLength(2);
		expect(value.connector.routes[1]!.url).toBe(value.connector.routes[0]!.url);
		expect(value.connector.routes[1]!.routeGeneration).not.toBe(oldGeneration);
		staleCallback({
			v: "omp-app/1", type: "response", requestId: requestId("request-stale"), commandId: commandId("command-stale"),
			hostId: "private-host" as never, sessionId: "omp-private-one" as never,
			ok: true, command: "session.attach", result: { attached: true, cursor: { epoch: "old", seq: 1 } },
		});
		expect(value.client.frames.some(frame => frame.type === "response" && frame.commandId === "command-stale")).toBe(false);
		value.connector.frameCallbacks[1]!({
			v: "omp-app/1", type: "response", requestId: requestId("request-fresh"), commandId: commandId("command-fresh"),
			hostId: "private-host" as never, sessionId: "omp-private-fresh" as never,
			ok: true, command: "session.attach", result: { attached: true, cursor: { epoch: "new", seq: 1 } },
		});
		expect(value.client.frames.at(-1)).toMatchObject({
			type: "response", commandId: "command-fresh", hostId: "cluster:host-uid", sessionId: "session-one", ok: true,
		});
	});

	it("denies a preview id learned from another session without opening a second upstream socket", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-owner", commandId: "command-owner",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: {},
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "preview.state", hostId: "upstream" as never, sessionId: "omp-private-one" as never,
			previewId: "preview-one" as never, state: "ready", url: "https://example.test", revision: "preview-r1" as never,
			cursor: { epoch: "preview-e1", seq: 1 },
		});
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-preview", commandId: "command-preview",
			hostId: "cluster:host-uid", sessionId: "session-two", command: "preview.activate", args: { previewId: "preview-one" },
		});
		expect(value.connector.routes).toHaveLength(1);
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", commandId: "command-preview", ok: false, error: { code: "NOT_AUTHORIZED" } });
	});

	it("forgets preview ownership when its generation-bound pod connection closes", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-owner-close", commandId: "command-owner-close",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: {},
		});
		value.connector.frameCallbacks[0]!({
			v: "omp-app/1", type: "preview.state", hostId: "upstream" as never, sessionId: "omp-private-one" as never,
			previewId: "preview-reused" as never, state: "ready", url: "https://example.test", revision: "preview-r1" as never,
			cursor: { epoch: "preview-e1", seq: 1 },
		});
		value.connector.closeCallbacks[0]!();
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-reused", commandId: "command-reused",
			hostId: "cluster:host-uid", sessionId: "session-two", command: "preview.activate", args: { previewId: "preview-reused" },
		});
		expect(value.connector.routes).toHaveLength(2);
		expect(value.connector.sent.at(-1)).toMatchObject({
			type: "command", commandId: "command-reused", sessionId: "omp-private-two",
		});
	});

	it("uses bounded command idempotency while CR mutation identity survives reconnect", async () => {
		const value = setup();
		await value.connection.receive(hello);
		const command = {
			v: "omp-app/1" as const, type: "command" as const, requestId: "request-create", commandId: "command-create",
			hostId: "cluster:host-uid", command: "workspace.create",
			args: { displayName: "Created", retentionPolicy: "Retain", capacity: "20Gi" },
		};
		await value.connection.receive(command);
		await value.connection.receive({ ...command, requestId: "request-create-retry" });
		expect(value.mutations.workspaceCreates).toBe(1);
		expect(value.client.frames.slice(-2)).toEqual([
			expect.objectContaining({ type: "response", commandId: "command-create", ok: true }),
			expect.objectContaining({ type: "response", commandId: "command-create", requestId: "request-create-retry", ok: true }),
		]);
	});

	it("omits preview grants when no owned browser-enabled routable session exists", async () => {
		const value = setup();
		for (const name of ["session-one", "session-two"]) {
			const current = session(name);
			value.projection.applyWatch({
				type: "MODIFIED",
				object: { ...current, metadata: { ...current.metadata, resourceVersion: `${name}-disabled` }, spec: { ...current.spec, guiEnabled: false } },
			});
		}
		await value.connection.receive({
			...hello,
			capabilities: { client: [...hello.capabilities.client, "preview.input"] },
		});
		const welcome = value.client.frames[0];
		if (welcome?.type !== "welcome") throw new Error("gateway did not send welcome");
		expect(welcome.grantedCapabilities.filter(capability => capability.startsWith("preview."))).toEqual([]);
		expect(welcome.grantedFeatures).not.toContain("preview.control");
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-disabled-gui", commandId: "command-disabled-gui",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: {},
		});
		expect(value.connector.routes).toHaveLength(0);
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", ok: false, error: { code: "NOT_AUTHORIZED", message: "command capability was not granted" } });
	});

	it("forces welcome renegotiation whenever owned preview route availability changes", async () => {
		const enabled = setup();
		await enabled.connection.receive(hello);
		for (const name of ["session-one", "session-two"]) {
			const current = session(name);
			enabled.projection.applyWatch({
				type: "MODIFIED",
				object: { ...current, metadata: { ...current.metadata, resourceVersion: `${name}-disabled` }, spec: { ...current.spec, guiEnabled: false } },
			});
		}
		expect(enabled.client.frames.at(-1)).toMatchObject({
			type: "bye", code: "server_restart", reason: "browser availability changed", retryable: true,
		});
		expect(enabled.client.closes).toContainEqual([1012, "browser availability changed"]);

		const disabled = setup();
		for (const name of ["session-one", "session-two"]) {
			const current = session(name);
			disabled.projection.applyWatch({
				type: "MODIFIED",
				object: { ...current, metadata: { ...current.metadata, resourceVersion: `${name}-disabled` }, spec: { ...current.spec, guiEnabled: false } },
			});
		}
		await disabled.connection.receive(hello);
		const enabledSession = session("session-one");
		disabled.projection.applyWatch({
			type: "MODIFIED",
			object: { ...enabledSession, metadata: { ...enabledSession.metadata, resourceVersion: "session-one-enabled" } },
		});
		expect(disabled.client.frames.at(-1)).toMatchObject({
			type: "bye", code: "server_restart", reason: "browser availability changed", retryable: true,
		});
		expect(disabled.client.closes).toContainEqual([1012, "browser availability changed"]);
	});

	it("treats an already absent session delete as an idempotent success", async () => {
		const value = setup();
		value.projection.applyWatch({ type: "DELETED", object: session("session-one") });
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-delete-replay", commandId: "command-delete-replay",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.delete", expectedRevision: "authority-r1", args: {},
		});
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", ok: true, result: { deleted: true } });
		expect(value.mutations.sessionDeletes).toBe(0);
	});

	it("does not reveal whether an unauthorized session delete target exists", async () => {
		const value = setup();
		value.projection.applyWatch({
			type: "MODIFIED",
			object: {
				...workspace,
				metadata: { ...workspace.metadata, resourceVersion: "31", generation: 2 },
				spec: { ...workspace.spec, owner: "other@example.com" },
			},
		});
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-private-delete", commandId: "command-private-delete",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "session.delete", expectedRevision: "authority-r1", args: {},
		});
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", ok: true, result: { deleted: true } });
		expect(value.mutations.sessionDeletes).toBe(0);
	});

	it("reports Kubernetes schema rejection as a client contract error", async () => {
		const value = setup();
		value.mutations.createWorkspace = async () => { throw new KubernetesApiError(422, "invalid"); };
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-invalid", commandId: "command-invalid",
			hostId: "cluster:host-uid", command: "workspace.create",
			args: { displayName: "Created", retentionPolicy: "Retain", capacity: "20Gi" },
		});
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", ok: false, error: { code: "INVALID_FRAME" } });
	});
});
