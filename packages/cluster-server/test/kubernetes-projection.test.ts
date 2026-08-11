import { describe, expect, it } from "vite-plus/test";
import { hostId, projectId, revision, sessionId, type SessionRef } from "@t4-code/host-wire";
import {
	CLUSTER_MAX_SESSIONS,
	CLUSTER_MAX_WORKSPACES,
	ClusterInfrastructureProjection,
	KubernetesAuthorityInvalidatedError,
	clusterHostIdFromUid,
} from "../src/kubernetes-projection.ts";

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
	metadata: { name: "primary", uid: "24e7bcb1-c694-4ba4-85c4-70a829f7996b", resourceVersion: "100", generation: 2 },
	spec: {},
	status: { observedGeneration: 2, conditions: [{ type: "Available", status: "True", reason: "Ready", message: "ready", observedGeneration: 2 }] },
};
const workspace = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4Workspace",
	metadata: { name: "workspace-one", uid: "workspace-uid", resourceVersion: "101", generation: 3 },
	spec: {
		hostRef: "primary",
		owner: PRINCIPAL,
		displayName: "T4 code",
		retentionPolicy: "Retain",
		size: "20Gi",
		repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
	},
	status: {
		observedGeneration: 3,
		phase: "Ready",
		capacity: "20Gi",
		conditions: [{ type: "StorageReady", status: "True", reason: "Bound", message: "PVC is bound", observedGeneration: 3 }],
		pvcRef: "workspace-one",
	},
};
const session = {
	apiVersion: "cluster.t4.dev/v1alpha1",
	kind: "T4Session",
	metadata: { name: "session-one", uid: "session-uid", resourceVersion: "102", generation: 5 },
	spec: {
		hostRef: "primary",
		workspaceRef: "workspace-one",
		title: "Cluster task",
		runtimeProfile: "omp-17.0.5",
		guiEnabled: true,
		ci: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
	},
	status: {
		observedGeneration: 5,
		runtimeGeneration: "gen_controller_owned_0001",
		phase: "Ready",
		podName: "session-one-pod",
		serviceName: "session-one",
		conditions: [
			{ type: "Available", status: "True", reason: "CompositeReady", message: "ready", observedGeneration: 5 },
			{ type: "RouteReady", status: "True", reason: "CompositeReadinessProven", message: "ready", observedGeneration: 5 },
		],
	},
};

describe("Kubernetes infrastructure projection", () => {
	it("derives a stable host id from the T4ClusterHost UID and bounded list state", () => {
		expect(clusterHostIdFromUid(host.metadata.uid)).toBe("cluster:24e7bcb1-c694-4ba4-85c4-70a829f7996b");
		expect(CLUSTER_MAX_WORKSPACES).toBe(256);
		expect(CLUSTER_MAX_SESSIONS).toBe(1_000);
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		expect(projection.hostId).toBe(clusterHostIdFromUid(host.metadata.uid));
		expect(projection.workspaceList()).toEqual({
			cursor: { epoch: "replica-uid-1", seq: 1 },
			workspaces: [
				expect.objectContaining({
					id: "workspace-one",
					phase: "Ready",
					accessMode: "ReadWriteMany",
					retentionPolicy: "Retain",
				}),
			],
		});
		expect(JSON.stringify(projection.workspaceList())).not.toContain("credentialPath");
		expect(JSON.stringify(projection.workspaceList())).not.toContain("pvcRef");
		expect(JSON.stringify(projection.workspaceList())).not.toContain("repositoryId");
	});

	it("projects controller-owned runtime generation independently of Kubernetes metadata generation", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		const first = projection.restProjection(PRINCIPAL).runtimes[0]!;
		expect(first.generation).toBe("gen_controller_owned_0001");
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...session, metadata: { ...session.metadata, generation: 99, resourceVersion: "103" } },
		});
		expect(projection.restProjection(PRINCIPAL).runtimes[0]!.generation).toBe(first.generation);
		projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session,
				metadata: { ...session.metadata, generation: 99, resourceVersion: "104" },
				status: { ...session.status, runtimeGeneration: "gen_controller_owned_0002" },
			},
		});
		expect(projection.restProjection(PRINCIPAL).runtimes[0]!.generation).toBe("gen_controller_owned_0002");
	});

	it("omits runtimes and direct routes without a valid controller-owned generation", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		const missingGeneration = { ...session, status: { ...session.status, runtimeGeneration: undefined } };
		projection.replace({ host, workspaces: [workspace], sessions: [missingGeneration], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		expect(projection.restProjection(PRINCIPAL).runtimes).toEqual([]);
		expect(projection.cmuxWebSocketRoute("session-one", PRINCIPAL)).toBeUndefined();

		const invalidGeneration = { ...session, status: { ...session.status, runtimeGeneration: "metadata-5" } };
		projection.replace({ host, workspaces: [workspace], sessions: [invalidGeneration], resourceVersion: "103" });
		expect(projection.restProjection(PRINCIPAL).runtimes).toEqual([]);
	});

	it("keeps workspace cursors separate and reconnect replacement idempotent", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		const seen: unknown[] = [];
		const stop = projection.subscribe(frame => seen.push(frame), projection.workspaceCursor);
		projection.applyWatch({ type: "MODIFIED", object: { ...session, metadata: { ...session.metadata, resourceVersion: "103" } } });
		expect(seen).toHaveLength(0);
		projection.applyWatch({
			type: "MODIFIED",
			object: {
				...workspace,
				metadata: { ...workspace.metadata, resourceVersion: "104", generation: 4 },
				status: { ...workspace.status, observedGeneration: 4, phase: "Failed" },
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ type: "workspace.state", workspaceId: "workspace-one", cursor: { seq: 2 } });
		projection.applyWatch({ type: "MODIFIED", object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "104" } } });
		expect(seen).toHaveLength(1);
		stop();
	});

	it("projects routable pod authority and removes deleted sessions without local truth", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		expect(projection.sessionRoute("session-one")).toEqual({
			clusterSessionId: "session-one",
			routeGeneration: expect.stringMatching(/^route_/u),
			runtimeGeneration: "gen_controller_owned_0001",
			upstreamSessionId: "omp-session-private",
			url: "ws://session-one.development.svc:8787/v1/ws",
		});
		expect(projection.sessionRefs()).toEqual([
			expect.objectContaining({
				hostId: clusterHostIdFromUid(host.metadata.uid),
				sessionId: "session-one",
				liveState: expect.objectContaining({
					cluster: expect.objectContaining({ workspaceId: "workspace-one", phase: "Running" }),
				}),
			}),
		]);
		projection.applyWatch({ type: "DELETED", object: session });
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		expect(projection.sessionRefs()).toEqual([]);
	});

	it("retracts every endpoint before a draining generation can be resolved", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		expect(projection.sessionEndpoints()).toHaveLength(1);
		projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session,
				metadata: { ...session.metadata, resourceVersion: "103" },
				status: {
					...session.status,
					phase: "Provisioning",
					serviceName: undefined,
					conditions: session.status.conditions.map(item => item.type === "RouteReady" ? { ...item, status: "False", reason: "RouteDraining" } : item),
				},
			},
		});
		expect(projection.sessionEndpoints()).toEqual([]);
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		expect(projection.cmuxWebSocketRoute("session-one", PRINCIPAL)).toBeUndefined();
	});

	it("invalidates authority and notifies subscribers when UID or generation changes behind a stable name and service", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const before = projection.sessionRoute("session-one")!;
		let notifications = 0;
		projection.subscribeSessions(() => { notifications++; });
		projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session,
				metadata: { ...session.metadata, uid: "session-uid-replaced", generation: 6, resourceVersion: "103" },
				status: { ...session.status, observedGeneration: 6, conditions: session.status.conditions.map(item => item.type === "RouteReady" ? { ...item, observedGeneration: 6 } : item) },
			},
		});
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		const endpoint = projection.sessionEndpoints()[0]!;
		expect(endpoint).toMatchObject({
			clusterSessionId: "session-one",
			url: before.url,
		});
		expect(endpoint.routeGeneration).not.toBe(before.routeGeneration);
		expect(notifications).toBe(1);
	});

	it("rotates route authority when the internal pod incarnation changes under the same service", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const before = projection.sessionEndpoints()[0]!;
		projection.applyWatch({
			type: "MODIFIED",
			object: {
				...session,
				metadata: { ...session.metadata, resourceVersion: "103" },
				status: { ...session.status, podName: "session-one-pod-recreated" },
			},
		});
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		const after = projection.sessionEndpoints()[0]!;
		expect(after.url).toBe(before.url);
		expect(after.routeGeneration).not.toBe(before.routeGeneration);
	});

	it("invalidates missed-delete authority during relist even when name, service, and resource version repeat", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const before = projection.sessionEndpoints()[0]!.routeGeneration;
		let notifications = 0;
		projection.subscribeSessions(() => { notifications++; });
		const replacement = {
			...session,
			metadata: { ...session.metadata, uid: "session-uid-after-missed-delete", generation: 1 },
			status: { ...session.status, observedGeneration: 1, conditions: session.status.conditions.map(item => ({ ...item, observedGeneration: 1 })) },
		};
		projection.replace({ host, workspaces: [workspace], sessions: [replacement], resourceVersion: "102" });
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		expect(projection.sessionEndpoints()[0]!.routeGeneration).not.toBe(before);
		expect(notifications).toBe(1);
	});

	it("accepts only HTTPS browser origins and exposes GUI infrastructure authorization", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({
			host: { ...host, spec: { allowedOrigins: ["https://t4.tailnet.example", "http://insecure.example", "https://user:secret@t4.example"] } },
			workspaces: [workspace],
			sessions: [session],
			resourceVersion: "102",
		});
		expect(projection.allowedOrigins()).toEqual(["https://t4.tailnet.example"]);
		expect(projection.sessionGuiState("session-one", PRINCIPAL)).toBe("Ready");
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...session, metadata: { ...session.metadata, resourceVersion: "105" }, spec: { ...session.spec, guiEnabled: true, browserPolicy: "Disabled" } },
		});
		expect(projection.sessionGuiState("session-one", PRINCIPAL)).toBe("Unavailable");
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...session, metadata: { ...session.metadata, resourceVersion: "106" }, spec: { ...session.spec, guiEnabled: false, browserPolicy: "Allowed" } },
		});
		expect(projection.sessionGuiState("session-one", PRINCIPAL)).toBe("Ready");
		expect(projection.sessionGuiState("session-one", "other@example.com")).toBeUndefined();
	});

	it("removes cached resources immediately if a legacy watch migrates them to another host", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...session, metadata: { ...session.metadata, resourceVersion: "106" }, spec: { ...session.spec, hostRef: "another-host" } },
		});
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "107" }, spec: { ...workspace.spec, hostRef: "another-host" } },
		});
		expect(projection.workspaceList(PRINCIPAL).workspaces).toEqual([]);
	});

	it.each([
		["deletion", { type: "DELETED" as const, object: host }],
		["UID replacement", {
			type: "MODIFIED" as const,
			object: { ...host, metadata: { ...host.metadata, uid: "replacement-host-uid", resourceVersion: "108" } },
		}],
	])("invalidates all selected authority immediately on host %s", (_name, event) => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const workspaceSequence = projection.workspaceCursor.seq;
		expect(() => projection.applyWatch(event)).toThrow(KubernetesAuthorityInvalidatedError);
		expect(() => projection.hostId).toThrow("not synchronized");
		expect(projection.workspaceList().workspaces).toEqual([]);
		expect(projection.workspaceCursor.seq).toBeGreaterThan(workspaceSequence);
		expect(projection.sessionRefs()).toEqual([]);
		expect(projection.sessionRoute("session-one")).toBeUndefined();

		const replacementHost = { ...host, metadata: { ...host.metadata, uid: "replacement-host-uid", resourceVersion: "200" } };
		projection.replace({
			host: replacementHost,
			workspaces: [{ ...workspace, metadata: { ...workspace.metadata, resourceVersion: "201" } }],
			sessions: [{ ...session, metadata: { ...session.metadata, resourceVersion: "202" } }],
			resourceVersion: "202",
			resourceVersions: { t4clusterhosts: "200", t4workspaces: "201", t4sessions: "202" },
		});
		expect(projection.hostId).toBe(clusterHostIdFromUid("replacement-host-uid"));
		expect(projection.sessionRoute("session-one")).toBeUndefined();
	});

	it("resolves direct cmux routes only by stable public id, owner, readiness, and immutable generation", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		const routedSession = { ...session, spec: { ...session.spec, publicId: "runtime-public" } };
		projection.replace({ host, workspaces: [workspace], sessions: [routedSession], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const runtimeId = projection.restProjection(PRINCIPAL).runtimes[0]!.id;
		const first = projection.cmuxWebSocketRoute(runtimeId, PRINCIPAL);
		expect(first).toMatchObject({
			principal: PRINCIPAL,
			runtimeId,
			generation: "gen_controller_owned_0001",
			routeGeneration: expect.stringMatching(/^route_/u),
		});
		expect(JSON.stringify(first)).not.toContain("session-one");
		expect(JSON.stringify(first)).not.toContain("service");
		expect(projection.cmuxWebSocketRoute(runtimeId, "other@example.com")).toBeUndefined();
		expect(projection.cmuxWebSocketRoute("session-one", PRINCIPAL)).toBeUndefined();

		projection.applyWatch({
			type: "MODIFIED",
			object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "103" }, spec: { ...workspace.spec, owner: "other@example.com" } },
		});
		expect(projection.cmuxWebSocketRoute(runtimeId, PRINCIPAL)).toBeUndefined();

		const replacementWorkspace = { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "104" } };
		const replacementSession = {
			...routedSession,
			metadata: { ...session.metadata, uid: "replacement-session-uid", resourceVersion: "105" },
			status: { ...session.status, runtimeGeneration: "gen_controller_owned_0002" },
		};
		projection.replace({ host, workspaces: [replacementWorkspace], sessions: [replacementSession], resourceVersion: "105" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		const replaced = projection.cmuxWebSocketRoute(runtimeId, PRINCIPAL);
		expect(replaced?.generation).not.toBe(first?.generation);
		expect(replaced?.routeGeneration).not.toBe(first?.routeGeneration);
	});

	it("notifies direct cmux revocation when attached workspace readiness changes by watch or replace", () => {
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-uid-1", namespace: "development" });
		const routedSession = { ...session, spec: { ...session.spec, publicId: "runtime-public" } };
		projection.replace({ host, workspaces: [workspace], sessions: [routedSession], resourceVersion: "102" });
		projection.setSessionAuthority("session-one", authority("omp-session-private"));
		expect(projection.cmuxWebSocketRoute("runtime-public", PRINCIPAL)).toBeDefined();
		let notifications = 0;
		projection.subscribeSessions(() => { notifications++; });

		const pending = {
			...workspace,
			metadata: { ...workspace.metadata, resourceVersion: "103" },
			status: { ...workspace.status, phase: "Pending" },
		};
		projection.applyWatch({ type: "MODIFIED", object: pending });
		expect(projection.cmuxWebSocketRoute("runtime-public", PRINCIPAL)).toBeUndefined();
		expect(notifications).toBe(1);

		const ready = { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "104" } };
		projection.applyWatch({ type: "MODIFIED", object: ready });
		expect(projection.cmuxWebSocketRoute("runtime-public", PRINCIPAL)).toBeDefined();
		expect(notifications).toBe(2);

		const failedWorkspace = {
			...ready,
			metadata: { ...ready.metadata, resourceVersion: "105" },
			status: { ...ready.status, phase: "Failed" },
		};
		projection.replace({ host, workspaces: [failedWorkspace], sessions: [routedSession], resourceVersion: "105" });
		expect(projection.cmuxWebSocketRoute("runtime-public", PRINCIPAL)).toBeUndefined();
		expect(notifications).toBe(3);
	});

	it("fails closed at explicit projection limits", () => {
		const projection = new ClusterInfrastructureProjection({
			epoch: "replica-uid-1",
			namespace: "development",
			maxWorkspaces: 1,
			maxSessions: 1,
		});
		expect(() => projection.replace({ host, workspaces: [workspace, { ...workspace, metadata: { ...workspace.metadata, name: "two" } }], sessions: [], resourceVersion: "1" })).toThrow("workspace projection limit");
		expect(() => projection.replace({ host, workspaces: [], sessions: [session, { ...session, metadata: { ...session.metadata, name: "two" } }], resourceVersion: "1" })).toThrow("session projection limit");
	});
});
