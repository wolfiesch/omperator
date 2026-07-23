import { describe, expect, test } from "bun:test";
import {
	AppWireError,
	CI_TRIGGER_CAPABILITY,
	CLUSTER_OPERATOR_FEATURE,
	COMMAND_DESCRIPTORS,
	DEVICE_CAPABILITIES,
	PROTOCOL_FEATURES,
	decodeCiRunArguments,
	decodeCiRunResult,
	decodeClusterSessionCreateArguments,
	decodeClusterWorkspaceCreateArguments,
	decodeCommand,
	decodeCommandResult,
	decodeServerFrame,
	decodeSessionRef,
	decodeWelcome,
	decodeWorkspaceState,
} from "../src/index.js";

const session = {
	hostId: "cluster-host-uid-1",
	sessionId: "session-one",
	project: { projectId: "workspace-one" },
	revision: "session-r7",
	title: "Cluster task",
	status: "idle",
	updatedAt: "2026-07-20T12:00:00.000Z",
};

const condition = {
	type: "Available",
	status: "True",
	reason: "PodReady",
	message: "The session pod is ready",
	observedGeneration: 7,
};

describe("cluster operator wire contract", () => {
	test("negotiates one additive operator feature and one CI mutation capability", () => {
		expect(CLUSTER_OPERATOR_FEATURE).toBe("cluster.operator");
		expect(CI_TRIGGER_CAPABILITY).toBe("ci.trigger");
		expect(PROTOCOL_FEATURES).toContain(CLUSTER_OPERATOR_FEATURE);
		expect(DEVICE_CAPABILITIES).toContain(CI_TRIGGER_CAPABILITY);
		expect(
			decodeWelcome({
				v: "omp-app/1",
				type: "welcome",
				selectedProtocol: "omp-app/1",
				hostId: "cluster-host-uid-1",
				ompVersion: "17.0.5",
				ompBuild: "2eef185481d499c6e04323b71eda550a54bd4550",
				appserverVersion: "0.1.31",
				appserverBuild: "cluster",
				epoch: "replica-pod-uid-1",
				grantedCapabilities: ["sessions.read", "ci.trigger"],
				grantedFeatures: ["resume", "cluster.operator"],
				negotiatedLimits: {},
				authentication: "paired",
				resumed: false,
			}),
		).toMatchObject({ grantedCapabilities: ["sessions.read", "ci.trigger"], grantedFeatures: ["resume", "cluster.operator"] });
	});

	test("decodes bounded workspace upsert and removal frames in their own cursor domain", () => {
		const upsert = decodeWorkspaceState({
			v: "omp-app/1",
			type: "workspace.state",
			hostId: "cluster-host-uid-1",
			workspaceId: "workspace-one",
			cursor: { epoch: "replica-pod-uid-1", seq: 19 },
			revision: "workspace-r3",
			upsert: {
				id: "workspace-one",
				displayName: "T4 code",
				phase: "Ready",
				retentionPolicy: "Retain",
				storageClass: "t4-workspaces-rwx",
				capacity: "20Gi",
				accessMode: "ReadWriteMany",
				revision: "workspace-r3",
				condition,
			},
		});
		expect(upsert.cursor).toEqual({ epoch: "replica-pod-uid-1", seq: 19 });
		expect(upsert.upsert.id).toBe("workspace-one");
		expect(decodeServerFrame(upsert).type).toBe("workspace.state");

		const remove = decodeWorkspaceState({
			v: "omp-app/1",
			type: "workspace.state",
			hostId: "cluster-host-uid-1",
			workspaceId: "workspace-one",
			cursor: { epoch: "replica-pod-uid-1", seq: 20 },
			revision: "workspace-r4",
			remove: "workspace-one",
		});
		expect(remove).toMatchObject({ workspaceId: "workspace-one", remove: "workspace-one" });

		for (const malformed of [
			{ ...upsert, remove: true },
			{ ...upsert, upsert: undefined },
			{ ...upsert, workspaceId: "other" },
			{ ...upsert, upsert: { ...upsert.upsert, accessMode: "ReadWriteOnce" } },
			{ ...upsert, upsert: { ...upsert.upsert, condition: { ...condition, token: "secret" } } },
		]) expect(() => decodeWorkspaceState(malformed)).toThrow(AppWireError);
	});

	test("strictly decodes cluster and Woodpecker live state without credentials or private paths", () => {
		const decoded = decodeSessionRef(
			{
				...session,
				liveState: {
					cluster: {
						workspaceId: "workspace-one",
						phase: "Running",
						condition,
						gui: { state: "Ready", previewId: "preview-one" },
					},
					ci: {
						provider: "woodpecker",
						correlation: "exact",
						repositoryId: "t4-code",
						ref: "refs/heads/agent/t4-cluster-operator",
						commit: "0123456789abcdef0123456789abcdef01234567",
						pipelineNumber: 42,
						status: "running",
						currentStage: "test",
						startedAt: "2026-07-20T12:00:00.000Z",
						link: "https://ci.example.test/repos/t4-code/pipeline/42",
					},
				},
			},
			"session",
		);
		expect(decoded.liveState?.cluster?.gui.state).toBe("Ready");
		expect(decoded.liveState?.ci?.pipelineNumber).toBe(42);

		for (const liveState of [
			{ cluster: { ...decoded.liveState?.cluster, phase: "Succeeded" } },
			{ cluster: { ...decoded.liveState?.cluster, podPath: "/var/run/private" } },
			{ ci: { ...decoded.liveState?.ci, provider: "github" } },
			{ ci: { ...decoded.liveState?.ci, correlation: "approximate" } },
			{ ci: { ...decoded.liveState?.ci, token: "secret" } },
			{ ci: { ...decoded.liveState?.ci, link: "http://ci.example.test/run/42" } },
		]) expect(() => decodeSessionRef({ ...session, liveState }, "session")).toThrow(AppWireError);
	});

	test("types ci.run as a session-revision-gated allowlist with no endpoint, token, or shell fields", () => {
		expect(COMMAND_DESCRIPTORS["ci.run"]).toEqual({
			capability: "ci.trigger",
			scope: "session",
			revision: "required",
			revisionOwner: "session",
			confirmation: "none",
		});
		const args = {
			provider: "woodpecker",
			action: "run",
			repositoryId: "t4-code",
			ref: "refs/heads/agent/t4-cluster-operator",
			commit: "0123456789abcdef0123456789abcdef01234567",
		};
		expect(decodeCiRunArguments(args)).toEqual(args);
		expect(
			decodeCommand({
				v: "omp-app/1",
				type: "command",
				requestId: "request-ci-1",
				commandId: "command-ci-1",
				hostId: "cluster-host-uid-1",
				sessionId: "session-one",
				command: "ci.run",
				expectedRevision: "session-r7",
				args,
			}).args,
		).toEqual(args);
		expect(decodeCiRunResult({ triggered: false, pipelineNumber: 42, status: "running" })).toEqual({
			triggered: false,
			pipelineNumber: 42,
			status: "running",
		});
		for (const extra of [
			{ url: "https://ci.example.test" },
			{ token: "secret" },
			{ shell: "curl ci" },
			{ action: "restart" },
		]) expect(() => decodeCiRunArguments({ ...args, ...extra })).toThrow(AppWireError);
	});

	test("keeps legacy workspace.list fixtures compatible while adding cluster bootstrap and create shapes", () => {
		const legacy = {
			repositoryId: "project-one",
			instanceId: "instance-one",
			ownership: "managed",
			branch: "main",
			sourceCommit: "abc",
			expectedHead: "abc",
			lifecycle: "active",
			createdAt: 1,
			updatedAt: 2,
		};
		expect(decodeCommandResult("workspace.list", { workspaces: [legacy] })).toEqual({ workspaces: [legacy] });
		const clusterWorkspace = {
			id: "workspace-one",
			displayName: "T4 code",
			phase: "Pending",
			retentionPolicy: "Delete",
			accessMode: "ReadWriteMany",
			revision: "workspace-r1",
		};
		expect(
			decodeCommandResult("workspace.list", {
				workspaces: [clusterWorkspace],
				cursor: { epoch: "replica-pod-uid-1", seq: 4 },
			}),
		).toEqual({ workspaces: [clusterWorkspace], cursor: { epoch: "replica-pod-uid-1", seq: 4 } });
		expect(
			decodeClusterWorkspaceCreateArguments({
				displayName: "T4 code",
				retentionPolicy: "Retain",
				capacity: "20Gi",
				repository: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
			}),
		).toMatchObject({ displayName: "T4 code", capacity: "20Gi" });
		expect(
			decodeClusterSessionCreateArguments({
				workspaceId: "workspace-one",
				title: "Agent task",
				runtimeProfile: "omp-17.0.5",
				guiEnabled: true,
				ci: { provider: "woodpecker", repositoryId: "t4-code", ref: "refs/heads/main", commit: "abcdef0" },
			}),
		).toMatchObject({ workspaceId: "workspace-one", runtimeProfile: "omp-17.0.5" });
		for (const malformed of [
			{ displayName: "x".repeat(129), retentionPolicy: "Retain", capacity: "20Gi" },
			{ displayName: "T4 code", retentionPolicy: "Retain", capacity: "0Gi" },
			{ displayName: "T4 code", retentionPolicy: "Retain", capacity: "20Gi", storageClass: "client-owned" },
			{ displayName: "T4 code", retentionPolicy: "Retain", capacity: "20Gi", repository: { repositoryId: "t4-code", commit: "abcdef0" } },
			{ displayName: "T4 code", retentionPolicy: "Retain", capacity: "20Gi", repository: { repositoryId: "t4-code", ref: "main", commit: "abc" } },
		]) expect(() => decodeClusterWorkspaceCreateArguments(malformed)).toThrow(AppWireError);
		for (const malformed of [
			{ workspaceId: "Workspace:one", title: "Agent", runtimeProfile: "default", guiEnabled: true },
			{ workspaceId: "workspace-one", title: "x".repeat(129), runtimeProfile: "default", guiEnabled: true },
			{ workspaceId: "workspace-one", title: "Agent", runtimeProfile: "Default:unsafe", guiEnabled: true },
			{ workspaceId: "workspace-one", title: "Agent", runtimeProfile: "default", guiEnabled: true, ci: { provider: "woodpecker", repositoryId: "t4-code", ref: "main", commit: "abc" } },
		]) expect(() => decodeClusterSessionCreateArguments(malformed)).toThrow(AppWireError);
	});
});
