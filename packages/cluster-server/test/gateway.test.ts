import { describe, expect, it } from "vite-plus/test";
import {
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
const session = (name: string, upstream: string) => ({
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
		return { deleted: true };
	}
}

function setup(epoch = "replica-uid-1") {
	const projection = new ClusterInfrastructureProjection({ epoch, namespace: "development" });
	projection.replace({
		host,
		workspaces: [workspace],
		sessions: [session("session-one", "omp-private-one"), session("session-two", "omp-private-two")],
		resourceVersion: "13",
	});
	projection.setSessionAuthority("session-one", authority("omp-private-one"));
	projection.setSessionAuthority("session-two", authority("omp-private-two"));
	const connector = new MemoryConnector();
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
	requestedFeatures: ["resume", "cluster.operator"],
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
			grantedFeatures: ["resume", "cluster.operator"],
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
			v: "omp-app/1", type: "snapshot", hostId: "upstream", sessionId: "omp-private-one",
			cursor: { epoch: "pod-epoch", seq: 1 }, revision: "session-r1", entries: [],
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "entry", hostId: "upstream", sessionId: "omp-private-one",
			cursor: { epoch: "pod-epoch", seq: 2 }, revision: "session-r2",
			entry: { id: "entry-one", parentId: null, hostId: "upstream", sessionId: "omp-private-one", kind: "message", timestamp: "2026-07-20T00:00:00.000Z", data: { text: "hello", correlationId: "omp-private-one" } },
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "agent", hostId: "upstream", sessionId: "omp-private-one", agentId: "Main", state: "running", detail: {},
		});
		const forwarded = value.client.frames.slice(-3);
		expect(forwarded.map(frame => frame.type)).toEqual(["snapshot", "entry", "agent"]);
		expect(forwarded[0]).toMatchObject({ hostId: "cluster:host-uid", sessionId: "session-one" });
		expect(forwarded[1]).toMatchObject({
			hostId: "cluster:host-uid", sessionId: "session-one",
			entry: { hostId: "cluster:host-uid", sessionId: "session-one", data: { correlationId: "omp-private-one" } },
		});
	});

	it("denies a preview id learned from another session without opening a second upstream socket", async () => {
		const value = setup();
		await value.connection.receive(hello);
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-owner", commandId: "command-owner",
			hostId: "cluster:host-uid", sessionId: "session-one", command: "preview.state", args: { previewId: "preview-one" },
		});
		value.connector.onFrame?.({
			v: "omp-app/1", type: "preview.state", hostId: "upstream" as never, sessionId: "omp-private-one" as never,
			previewId: "preview-one" as never, state: "ready", url: "https://example.test", revision: "preview-r1" as never,
			cursor: { epoch: "preview-e1", seq: 1 },
		});
		await value.connection.receive({
			v: "omp-app/1", type: "command", requestId: "request-preview", commandId: "command-preview",
			hostId: "cluster:host-uid", sessionId: "session-two", command: "preview.state", args: { previewId: "preview-one" },
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
});
