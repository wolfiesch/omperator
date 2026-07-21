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
		phase: "Running",
		podName: "session-one-pod",
		serviceName: "session-one",
		conditions: [{ type: "Available", status: "True", reason: "PodReady", message: "ready", observedGeneration: 5 }],
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
			object: { ...session, metadata: { ...session.metadata, resourceVersion: "105" }, spec: { ...session.spec, guiEnabled: false } },
		});
		expect(projection.sessionGuiState("session-one", PRINCIPAL)).toBe("Unavailable");
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
