import { describe, expect, it, vi } from "vite-plus/test";
import { hostId, projectId, revision, sessionId, type SessionRef } from "@t4-code/host-wire";
import { KubernetesApiError, type KubernetesApiClient } from "../src/kubernetes-client.ts";
import {
	ClusterInfrastructureProjection,
	clusterHostIdFromUid,
	type InfrastructureList,
	type KubernetesWatchEvent,
} from "../src/kubernetes-projection.ts";
import { KubernetesProjectionRunner } from "../src/kubernetes-runner.ts";

const AUTHORITY: SessionRef = {
	hostId: hostId("pod-host"),
	sessionId: sessionId("omp-session-old"),
	project: { projectId: projectId("workspace-one") },
	revision: revision("authority-r1"),
	title: "Cluster session",
	status: "active",
	updatedAt: "2026-07-20T00:00:00.000Z",
};

function snapshot(hostUid: string, versions: readonly [string, string, string]): InfrastructureList {
	return {
		host: {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4ClusterHost",
			metadata: { name: "primary", uid: hostUid, resourceVersion: versions[0] },
			spec: {},
		},
		workspaces: [{
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: { name: "workspace-one", uid: "workspace-uid", resourceVersion: versions[1] },
			spec: { hostRef: "primary", owner: "owner@example.com", displayName: "Workspace", retentionPolicy: "Retain", size: "20Gi" },
			status: { phase: "Ready" },
		}],
		sessions: [{
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name: "session-one", uid: "session-uid", resourceVersion: versions[2] },
			spec: { hostRef: "primary", workspaceRef: "workspace-one", title: "Session", runtimeProfile: "default", guiEnabled: true },
			status: { phase: "Running", serviceName: "session-one" },
		}],
		resourceVersion: versions[2],
		resourceVersions: { t4clusterhosts: versions[0], t4workspaces: versions[1], t4sessions: versions[2] },
	};
}

interface WatchCall {
	readonly resource: string;
	readonly resourceVersion: string;
	readonly signal: AbortSignal;
	emit(event: KubernetesWatchEvent): void;
	fail(error: unknown): void;
}

function watchMock(calls: WatchCall[], freshGenerationStarted: PromiseWithResolvers<void>): KubernetesApiClient["watch"] {
	return (resource, resourceVersion, onEvent, signal, onStarted) => new Promise<void>((_resolve, reject) => {
		let settled = false;
		const fail = (error: unknown): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			reject(error);
		};
		const abort = (): void => fail(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		calls.push({
			resource,
			resourceVersion,
			signal,
			emit: event => {
				if (settled) return;
				try { onEvent(event); }
				catch (error) { fail(error); }
			},
			fail,
		});
		onStarted?.();
		if (calls.length === 6) freshGenerationStarted.resolve();
	});
}

const invalidatingEvents = [
	["deletion", (listed: InfrastructureList) => ({ type: "DELETED" as const, object: listed.host })],
	["UID replacement", (listed: InfrastructureList) => ({
		type: "MODIFIED" as const,
		object: { ...listed.host, metadata: { ...listed.host.metadata, uid: "host-uid-new", resourceVersion: "103" } },
	})],
] as const;

describe("Kubernetes projection runner", () => {
	it.each(invalidatingEvents)("fails closed and relists the whole generation after selected host %s", async (_name, event) => {
		const initial = snapshot("host-uid-old", ["100", "101", "102"]);
		const fresh = snapshot("host-uid-new", ["200", "201", "202"]);
		const absentListStarted = Promise.withResolvers<void>();
		const freshListStarted = Promise.withResolvers<void>();
		const freshList = Promise.withResolvers<InfrastructureList>();
		let listAttempt = 0;
		const listInfrastructure = vi.fn(() => {
			listAttempt++;
			if (listAttempt === 1) return Promise.resolve(initial);
			if (listAttempt === 2) {
				absentListStarted.resolve();
				return Promise.reject(new Error("T4ClusterHost is unavailable"));
			}
			if (listAttempt === 3) {
				freshListStarted.resolve();
				return freshList.promise;
			}
			return Promise.reject(new Error("unexpected infrastructure list"));
		});
		const calls: WatchCall[] = [];
		const freshGenerationStarted = Promise.withResolvers<void>();
		const watch = vi.fn(watchMock(calls, freshGenerationStarted));
		const client = { listInfrastructure, watch } as unknown as KubernetesApiClient;
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-one", namespace: "development" });
		const errors: unknown[] = [];
		const runner = new KubernetesProjectionRunner({ client, projection, hostName: "primary", retryMs: 0, onError: error => errors.push(error) });

		await runner.start();
		projection.setSessionAuthority("session-one", AUTHORITY);
		expect(calls.map(call => [call.resource, call.resourceVersion])).toEqual([
			["t4clusterhosts", "100"],
			["t4workspaces", "101"],
			["t4sessions", "102"],
		]);
		expect(projection.sessionRoute("session-one")?.upstreamSessionId).toBe("omp-session-old");

		calls[0]!.emit(event(initial));
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		expect(projection.workspaceList().workspaces).toEqual([]);
		await absentListStarted.promise;
		expect(calls).toHaveLength(3);
		expect(calls.every(call => call.signal.aborted)).toBe(true);
		await freshListStarted.promise;
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		expect(calls).toHaveLength(3);

		freshList.resolve(fresh);
		await freshGenerationStarted.promise;
		expect(calls.slice(3).map(call => [call.resource, call.resourceVersion])).toEqual([
			["t4clusterhosts", "200"],
			["t4workspaces", "201"],
			["t4sessions", "202"],
		]);
		expect(projection.hostId).toBe(clusterHostIdFromUid("host-uid-new"));
		expect(projection.sessionRoute("session-one")).toBeUndefined();
		projection.setSessionAuthority("session-one", { ...AUTHORITY, sessionId: sessionId("omp-session-fresh") });
		expect(projection.sessionRoute("session-one")?.upstreamSessionId).toBe("omp-session-fresh");
		expect(errors).toHaveLength(2);
		await runner.stop();
	});

	it("keeps 410 handling generation-wide and resumes every watch from relisted versions", async () => {
		const initial = snapshot("host-uid", ["100", "101", "102"]);
		const fresh = snapshot("host-uid", ["200", "201", "202"]);
		const relistStarted = Promise.withResolvers<void>();
		const relist = Promise.withResolvers<InfrastructureList>();
		let listAttempt = 0;
		const listInfrastructure = vi.fn(() => {
			listAttempt++;
			if (listAttempt === 1) return Promise.resolve(initial);
			if (listAttempt === 2) { relistStarted.resolve(); return relist.promise; }
			return Promise.reject(new Error("unexpected infrastructure list"));
		});
		const calls: WatchCall[] = [];
		const freshGenerationStarted = Promise.withResolvers<void>();
		const watch = vi.fn(watchMock(calls, freshGenerationStarted));
		const client = { listInfrastructure, watch } as unknown as KubernetesApiClient;
		const projection = new ClusterInfrastructureProjection({ epoch: "replica-one", namespace: "development" });
		const runner = new KubernetesProjectionRunner({ client, projection, hostName: "primary", retryMs: 0 });

		await runner.start();
		calls[2]!.fail(new KubernetesApiError(410, "resource version expired"));
		await relistStarted.promise;
		expect(calls.every(call => call.signal.aborted)).toBe(true);
		expect(calls).toHaveLength(3);
		relist.resolve(fresh);
		await freshGenerationStarted.promise;
		expect(calls.slice(3).map(call => call.resourceVersion)).toEqual(["200", "201", "202"]);
		await runner.stop();
	});
});
