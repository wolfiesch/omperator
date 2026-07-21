import { describe, expect, it } from "vite-plus/test";
import {
	agentId,
	entryId,
	hostId,
	projectId,
	revision,
	sessionId,
	type ClientFrame,
	type ServerFrame,
	type SessionRef,
} from "@t4-code/host-wire";
import { ClusterGateway, type GatewayClient, type GatewayMutationBackend } from "../src/gateway.ts";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import { KubernetesApiError } from "../src/kubernetes-client.ts";
import type { PodHostConnection, PodHostConnector, PodHostRoute } from "../src/pod-host-router.ts";

const PRINCIPAL = "owner@example.com";
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
		phase: "Running",
		serviceName: name,
		conditions: [],
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
	async connect(route: PodHostRoute, onFrame: (frame: ServerFrame) => void): Promise<PodHostConnection> {
		this.routes.push(route);
		this.onFrame = onFrame;
		return { send: frame => { this.sent.push(frame); }, close: () => undefined };
	}
}

class PendingConnector extends MemoryConnector {
	readonly closes: Array<[number | undefined, string | undefined]> = [];
	#resolve: (() => void) | undefined;
	override connect(route: PodHostRoute, onFrame: (frame: ServerFrame) => void): Promise<PodHostConnection> {
		this.routes.push(route);
		this.onFrame = onFrame;
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

function setup(epoch = "replica-uid-1", connector: MemoryConnector = new MemoryConnector()) {
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
	const gateway = new ClusterGateway({ projection, connector, mutations });
	const client = new MemoryClient();
	const connection = gateway.connect(client, PRINCIPAL);
	return { projection, connector, mutations, gateway, client, connection };
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
		expect(value.connector.routes).toEqual([{ clusterSessionId: "session-one", upstreamSessionId: "omp-private-one", url: "ws://session-one.development.svc:8787/v1/ws" }]);
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
			expect(connector.routes).toHaveLength(1);
			change(value.projection);
			connector.resolveConnection();
			await pending;
			expect(connector.sent).toEqual([]);
			expect(connector.closes).toContainEqual([1001, "session route changed"]);
			expect(value.client.frames.find(frame => frame.type === "response" && frame.commandId === commandId)).toMatchObject({
				type: "response", commandId, ok: false, error: { code: "UPSTREAM_UNAVAILABLE" },
			});
		}
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

	it("fails closed when the session infrastructure does not authorize GUI access", async () => {
		const value = setup();
		value.projection.applyWatch({
			type: "MODIFIED",
			object: { ...session("session-one"), metadata: { ...session("session-one").metadata, resourceVersion: "30" }, spec: { ...session("session-one").spec, guiEnabled: false } },
		});
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-disabled-gui", commandId: "command-disabled-gui",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: {},
		});
		expect(value.connector.routes).toHaveLength(0);
		expect(value.client.frames.at(-1)).toMatchObject({ type: "response", ok: false, error: { code: "UNSUPPORTED_FEATURE", message: "GUI is disabled for this session" } });
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
