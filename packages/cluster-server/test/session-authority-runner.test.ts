import { describe, expect, it, vi } from "vite-plus/test";
import { hostId, projectId, revision, sessionId, type ServerFrame, type SessionRef } from "@t4-code/host-wire";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import { SessionAuthorityRunner } from "../src/session-authority-runner.ts";
import type { PodHostConnection, PodHostConnector, PodHostEndpoint } from "../src/pod-host-router.ts";

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
	spec: { hostRef: "primary", owner: "owner@example.com", retentionPolicy: "Retain", size: "20Gi" },
	status: { observedGeneration: 1, phase: "Ready", conditions: [] },
};
const session = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4Session",
	metadata: { name: "session-one", uid: "session-uid", resourceVersion: "12", generation: 1 },
	spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Session", runtimeProfile: "default" },
	status: { observedGeneration: 1, runtimeGeneration: "gen_session_one", phase: "Ready", serviceName: "session-one", podName: "session-one-pod", conditions: [{ type: "RouteReady", status: "True", observedGeneration: 1 }] },
};
function authority(id: string): SessionRef {
	return {
		hostId: hostId("private-host"),
		sessionId: sessionId(id),
		project: { projectId: projectId("project"), name: "Project" },
		revision: revision(`revision-${id}`),
		title: "Session",
		status: "idle",
		updatedAt: "2026-07-20T00:00:00.000Z",
	};
}
function snapshot(...sessions: SessionRef[]): ServerFrame {
	return {
		v: "omp-app/1",
		type: "sessions",
		hostId: hostId("private-host"),
		cursor: { epoch: "pod-epoch", seq: 1 },
		sessions,
		totalCount: sessions.length,
		truncated: false,
	};
}
class MemoryConnector implements PodHostConnector {
	readonly connections: Array<{
		readonly endpoint: PodHostEndpoint;
		readonly onFrame: (frame: ServerFrame) => void;
		readonly onClose?: () => void;
		readonly closes: Array<[number | undefined, string | undefined]>;
	}> = [];
	async connect(endpoint: PodHostEndpoint, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection> {
		const closes: Array<[number | undefined, string | undefined]> = [];
		this.connections.push({ endpoint, onFrame, onClose, closes });
		return { send: () => undefined, close: (code, reason) => { closes.push([code, reason]); } };
	}
}
function setup() {
	const projection = new ClusterInfrastructureProjection({ epoch: "replica-one", namespace: "development" });
	projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "12" });
	const connector = new MemoryConnector();
	const errors: unknown[] = [];
	const runner = new SessionAuthorityRunner({ projection, connector, retryMs: 1, onError: error => errors.push(error) });
	return { projection, connector, errors, runner };
}

describe("session authority generation binding", () => {
	it("reconnects and drops authority when UID/generation changes behind the same stable name, service, and URL", async () => {
		const value = setup();
		value.runner.start();
		const first = value.connector.connections[0]!;
		first.onFrame(snapshot(authority("omp-one")));
		expect(value.projection.sessionRoute("session-one")?.upstreamSessionId).toBe("omp-one");
		value.projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session,
				metadata: { ...session.metadata, uid: "session-replacement-uid", generation: 2, resourceVersion: "13" },
				status: {
					...session.status,
					observedGeneration: 2,
					runtimeGeneration: "gen_session_replacement",
					conditions: [{ type: "RouteReady", status: "True", observedGeneration: 2 }],
				},
			},
		});
		expect(value.connector.connections).toHaveLength(2);
		const second = value.connector.connections[1]!;
		expect(second.endpoint.url).toBe(first.endpoint.url);
		expect(second.endpoint.routeGeneration).not.toBe(first.endpoint.routeGeneration);
		expect(value.projection.sessionRoute("session-one")).toBeUndefined();
		await Promise.resolve();
		expect(first.closes).toContainEqual([1001, "session endpoint generation changed"]);
		await value.runner.stop();
	});

	it.each([
		["upsert", { upsert: authority("omp-other") }],
		["remove", { remove: sessionId("omp-other") }],
	] as const)("invalidates a connection on a mismatched delta %s", async (_name, delta) => {
		const value = setup();
		value.runner.start();
		const connection = value.connector.connections[0]!;
		connection.onFrame(snapshot(authority("omp-one")));
		const mismatchedId = "upsert" in delta ? delta.upsert.sessionId : delta.remove;
		connection.onFrame({
			v: "omp-app/1",
			type: "session.delta",
			hostId: hostId("private-host"),
			sessionId: mismatchedId,
			revision: revision("revision-omp-other"),
			cursor: { epoch: "pod-epoch", seq: 2 },
			...delta,
		} as ServerFrame);
		expect(value.projection.sessionRoute("session-one")).toBeUndefined();
		await Promise.resolve();
		expect(connection.closes[0]?.[0]).toBe(1008);
		await value.runner.stop();
	});

	it("ignores delayed frames from a stale connection after a fresh exact-one-session snapshot", async () => {
		vi.useFakeTimers();
		try {
			const value = setup();
			value.runner.start();
			const stale = value.connector.connections[0]!;
			stale.onFrame(snapshot(authority("omp-one")));
			stale.onFrame({
				v: "omp-app/1", type: "session.delta", hostId: hostId("private-host"), sessionId: sessionId("omp-other"),
				cursor: { epoch: "pod-epoch", seq: 2 }, revision: revision("revision-omp-other"), upsert: authority("omp-other"),
			});
			await vi.advanceTimersByTimeAsync(1);
			const current = value.connector.connections[1]!;
			current.onFrame(snapshot(authority("omp-fresh")));
			stale.onFrame(snapshot(authority("omp-stale")));
			stale.onFrame({
				v: "omp-app/1", type: "session.delta", hostId: hostId("private-host"), sessionId: sessionId("omp-fresh"),
				cursor: { epoch: "pod-epoch", seq: 3 }, revision: revision("revision-omp-fresh"), remove: sessionId("omp-fresh"),
			});
			expect(value.projection.sessionRoute("session-one")?.upstreamSessionId).toBe("omp-fresh");
			await value.runner.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
