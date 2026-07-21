import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hostId, projectId, revision, sessionId, type SessionCiState, type SessionRef } from "@t4-code/host-wire";
import { CiProjectionRunner } from "../src/ci-projection-runner.ts";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import type { CiProvider } from "../src/woodpecker.ts";

const correlation = {
	sessionId: "session-one",
	repositoryId: "t4-code",
	ref: "refs/heads/agent/t4-cluster-operator",
	commit: "0123456789abcdef0123456789abcdef01234567",
};
const exactState: SessionCiState = {
	provider: "woodpecker",
	correlation: "exact",
	repositoryId: correlation.repositoryId,
	ref: correlation.ref,
	commit: correlation.commit,
	pipelineNumber: 42,
	status: "running",
	currentStage: "cluster-server-tests",
};
const authority: SessionRef = {
	hostId: hostId("pod-host"),
	sessionId: sessionId("omp-session"),
	project: { projectId: projectId("workspace-one") },
	revision: revision("authority-r1"),
	title: "Cluster session",
	status: "active",
	updatedAt: "2026-07-20T00:00:00.000Z",
};

function projection(): ClusterInfrastructureProjection {
	const value = new ClusterInfrastructureProjection({ epoch: "replica-one", namespace: "development" });
	value.replace({
		host: { apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4ClusterHost", metadata: { name: "primary", uid: "host-uid", resourceVersion: "1" }, spec: {} },
		workspaces: [{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Workspace", metadata: { name: "workspace-one", resourceVersion: "2" }, spec: { hostRef: "primary", owner: "owner@example.com", displayName: "Workspace", retentionPolicy: "Retain", size: "20Gi" }, status: { phase: "Ready" } }],
		sessions: [{ apiVersion: "cluster.t4.dev/v1alpha1", kind: "T4Session", metadata: { name: correlation.sessionId, resourceVersion: "3" }, spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Session", runtimeProfile: "default", guiEnabled: true, ci: { repositoryId: correlation.repositoryId, ref: correlation.ref, commit: correlation.commit } }, status: { phase: "Running", serviceName: "session-one" } }],
		resourceVersion: "3",
	});
	value.setSessionAuthority(correlation.sessionId, authority);
	return value;
}

afterEach(() => vi.useRealTimers());

describe("CI projection runner", () => {
	it("reconstructs exact provider state and refreshes stage transitions", async () => {
		vi.useFakeTimers();
		const state = projection();
		let current = exactState;
		const provider: CiProvider = {
			name: "woodpecker",
			query: async () => current,
			run: async () => ({ triggered: false }),
		};
		const runner = new CiProjectionRunner({ projection: state, provider, pollMs: 10 });
		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.sessionRef(correlation.sessionId)?.liveState?.ci).toEqual(exactState);
		current = { ...exactState, status: "success", currentStage: "publish" };
		await vi.advanceTimersByTimeAsync(10);
		expect(state.sessionRef(correlation.sessionId)?.liveState?.ci).toMatchObject({ status: "success", currentStage: "publish" });
		await runner.stop();
	});

	it("fails closed to unknown correlation when the provider is unavailable", async () => {
		vi.useFakeTimers();
		const state = projection();
		state.setSessionCiState(correlation.sessionId, exactState);
		const errors: unknown[] = [];
		const provider: CiProvider = {
			name: "woodpecker",
			query: async () => { throw new Error("provider unavailable"); },
			run: async () => ({ triggered: false }),
		};
		const runner = new CiProjectionRunner({ projection: state, provider, pollMs: 10, onError: error => errors.push(error) });
		runner.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.sessionRef(correlation.sessionId)?.liveState?.ci).toEqual({
			provider: "woodpecker",
			correlation: "unknown",
			repositoryId: correlation.repositoryId,
			ref: correlation.ref,
			commit: correlation.commit,
		});
		expect(errors).toHaveLength(1);
		await runner.stop();
	});
});
