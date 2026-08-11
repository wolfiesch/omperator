import { describe, expect, it } from "vite-plus/test";
import type { RemoteConnection } from "@t4-code/host-service";
import { commandId, hostId, requestId, sessionId } from "@t4-code/host-wire";
import {
	ClusterInternalRemotePolicy,
	decodeClusterInternalClientFrame,
	sessionHostConfigFromEnv,
	type ClusterIdentityReviewer,
} from "../src/session-host-policy.ts";

const SERVER_TOKEN = `header.payload.${"s".repeat(64)}`;
const connection = {
	connectionId: "connection-one",
	peer: {
		identity: { nodeId: "cluster-server", addresses: ["10.42.0.10"], source: "direct" },
		address: "10.42.0.10",
		source: "direct",
	},
	socket: { connectionId: "connection-one", peer: {} as never, send: () => true, close: () => undefined },
} as RemoteConnection;
const hello = {
	v: "omp-app/1" as const,
	type: "hello" as const,
	protocol: { min: "omp-app/1", max: "omp-app/1" },
	client: { name: "cluster-server", version: "1", build: "test", platform: "linux" },
	requestedFeatures: ["resume", "session.state", "cluster.operator"],
	savedCursors: [],
	capabilities: { client: ["sessions.read", "sessions.prompt", "preview.control", "ci.trigger"] },
	authentication: { deviceId: "cluster-server", deviceToken: SERVER_TOKEN },
};
class MemoryReviewer implements ClusterIdentityReviewer {
	allowed = true;
	failure = false;
	readonly tokens: string[] = [];
	async review(token: string): Promise<boolean> {
		this.tokens.push(token);
		if (this.failure) throw new Error("unavailable");
		return this.allowed;
	}
}
function policy(reviewer: ClusterIdentityReviewer): ClusterInternalRemotePolicy {
	return new ClusterInternalRemotePolicy({
		reviewer,
		supportedCapabilities: ["sessions.read", "sessions.prompt", "preview.control"],
		supportedFeatures: ["resume", "session.state"],
	});
}
const validHostEnv: Record<string, string> = {
	T4_CREDENTIAL_BROKER_SOCKET: "/run/t4-credential/broker.sock",
	T4_RUNTIME_ID: "runtime-a1b2c3d4",
	T4_RUNTIME_UID: "31dbbb5e-5293-4b86-a1eb-1551a33a5d4e",
	T4_RUNTIME_GENERATION: "gen_123456789012345678901234",
	T4_SESSION_NAME: "session-one",
	T4_OMP_EXECUTABLE: "/opt/t4/libexec/omp-authority",
	T4_SESSION_STATE_ROOT: "/runtime-state/runtime-a1b2c3d4",
	T4_HOST_RUNTIME_DIR: "/run/t4/runtime-a1b2c3d4",
	T4_PRIVATE_RUNTIME_DIR: "/runtime-state/runtime-a1b2c3d4/private",
	T4_BROWSER_STATE_DIR: "/runtime-state/runtime-a1b2c3d4/browser",
	T4_GUI_ENABLED: "false",
	T4_SESSION_HOST_READY_PATH: "/run/t4/runtime-a1b2c3d4/host.ready",
	T4_WORKSPACE_ROOT: "/workspace",
	T4_SESSION_HOST_PORT: "8787",
	T4_IDLE_POLICY: "allow-idle-sleep",
	T4_RUNTIME_KEEPALIVE: "false",
};

describe("one-session pod host authority", () => {
	it("preserves the existing hello field while admitting a bounded projected bearer only on the internal policy", () => {
		expect(decodeClusterInternalClientFrame(hello)).toMatchObject({ authentication: { deviceId: "cluster-server", deviceToken: SERVER_TOKEN } });
		expect(() => decodeClusterInternalClientFrame({ ...hello, authentication: { ...hello.authentication, deviceToken: "short" } })).toThrow("token");
	});

	it("accepts only the TokenReview-authorized fixed server peer and never grants cluster-server-only names upstream", async () => {
		const reviewer = new MemoryReviewer();
		const remotePolicy = policy(reviewer);
		expect(await remotePolicy.authenticate(connection, hello)).toEqual({
			authenticated: true,
			authentication: "paired",
			deviceId: "cluster-server",
			grantedCapabilities: ["sessions.read", "sessions.prompt", "preview.control"],
			grantedFeatures: ["resume", "session.state"],
		});
		expect(reviewer.tokens).toEqual([SERVER_TOKEN]);
		reviewer.allowed = false;
		expect(await remotePolicy.authenticate(connection, hello)).toMatchObject({ authenticated: false, authentication: "denied" });
		reviewer.failure = true;
		expect(await remotePolicy.authenticate(connection, hello)).toMatchObject({ authenticated: false, authentication: "denied" });
		expect(await remotePolicy.authenticate({ ...connection, peer: { ...connection.peer, identity: { ...connection.peer.identity, nodeId: "other" } } }, hello)).toMatchObject({ authenticated: false });
	});

	it("authorizes only negotiated command capabilities on an authenticated connection", async () => {
		const remotePolicy = policy(new MemoryReviewer());
		await remotePolicy.authenticate(connection, hello);
		expect(await remotePolicy.authorize(connection, { v: "omp-app/1", type: "ping", nonce: "one", timestamp: "2026-07-20T00:00:00.000Z" }, { connectionId: "connection-one", peer: connection.peer })).toBe(true);
		expect(await remotePolicy.authorize(connection, {
			v: "omp-app/1", type: "command", requestId: requestId("r1"), commandId: commandId("c1"), hostId: hostId("pod-host"),
			sessionId: sessionId("private-session"), command: "session.attach", args: {},
		}, { connectionId: "connection-one", peer: connection.peer })).toBe(true);
		expect(await remotePolicy.authorize(connection, {
			v: "omp-app/1", type: "command", requestId: requestId("r2"), commandId: commandId("c2"), hostId: hostId("pod-host"),
			sessionId: sessionId("private-session"), command: "session.prompt", args: { message: "hello" },
		}, { connectionId: "connection-one", peer: connection.peer })).toBe(true);
		expect(await remotePolicy.authorize(connection, {
			v: "omp-app/1", type: "command", requestId: requestId("r3"), commandId: commandId("c3"), hostId: hostId("pod-host"),
			sessionId: sessionId("private-session"), command: "preview.click", args: { previewId: "preview-one", x: 10, y: 20 },
		}, { connectionId: "connection-one", peer: connection.peer })).toBe(false);
	});

	it("parses a credential-free isolated host configuration", () => {
		expect(sessionHostConfigFromEnv(validHostEnv)).toEqual({
			credentialBrokerSocket: "/run/t4-credential/broker.sock",
			runtimeId: "runtime-a1b2c3d4",
			runtimeUid: "31dbbb5e-5293-4b86-a1eb-1551a33a5d4e",
			generation: "gen_123456789012345678901234",
			sessionName: "session-one",
			ompExecutable: "/opt/t4/libexec/omp-authority",
			stateRoot: "/runtime-state/runtime-a1b2c3d4",
			runtimeRoot: "/run/t4/runtime-a1b2c3d4",
			privateRuntimeRoot: "/runtime-state/runtime-a1b2c3d4/private",
			browserStateRoot: "/runtime-state/runtime-a1b2c3d4/browser",
			browserEnabled: false,
			readyPath: "/run/t4/runtime-a1b2c3d4/host.ready",
			workspaceRoot: "/workspace",
			port: 8787,
			idlePolicy: "allow-idle-sleep",
			keepalive: false,
		});
		expect(sessionHostConfigFromEnv({ ...validHostEnv, T4_OMP_EXECUTABLE: undefined }).ompExecutable).toBe("/opt/t4/libexec/omp-authority");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_OMP_EXECUTABLE: "/usr/local/bin/omp" })).toThrow("authority-principal wrapper");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_SESSION_NAME: "bad/name" })).toThrow("T4_SESSION_NAME");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_CREDENTIAL_BROKER_SOCKET: undefined })).toThrow("T4_CREDENTIAL_BROKER_SOCKET");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_CREDENTIAL_BROKER_SOCKET: "/run/shared/broker.sock" })).toThrow("private broker mount");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_SESSION_STATE_ROOT: "/workspace/.t4/sessions/session" })).toThrow("T4_SESSION_STATE_ROOT");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_WORKSPACE_ROOT: "/runtime-state/runtime-a1b2c3d4/workspace" })).toThrow("must not overlap");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_HOST_RUNTIME_DIR: "/run/t4/other" })).toThrow("must match");
		expect(() => sessionHostConfigFromEnv({ ...validHostEnv, T4_RUNTIME_GENERATION: "gen_short" })).toThrow("T4_RUNTIME_GENERATION");
	});
});
