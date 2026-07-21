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

	it("parses fixed Kubernetes reviewer and isolated session paths", () => {
		expect(sessionHostConfigFromEnv({
			KUBERNETES_SERVICE_HOST: "10.96.0.1",
			KUBERNETES_SERVICE_PORT_HTTPS: "443",
			T4_KUBERNETES_API_AUDIENCE: "kubernetes.custom.example",
			T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "release-t4-cluster-server",
			T4_SESSION_NAME: "session-one",
			T4_OMP_EXECUTABLE: "/opt/t4/bin/omp",
			T4_SESSION_STATE_ROOT: "/workspace/.t4/sessions/a1b2c3d4",
			T4_SESSION_HOST_PORT: "8787",
		})).toEqual({
			kubernetesBaseUrl: "https://10.96.0.1:443",
			kubernetesTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
			kubernetesCaPath: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
			kubernetesNamespacePath: "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
			kubernetesApiAudience: "kubernetes.custom.example",
			serverServiceAccountName: "release-t4-cluster-server",
			sessionName: "session-one",
			ompExecutable: "/opt/t4/bin/omp",
			stateRoot: "/workspace/.t4/sessions/a1b2c3d4",
			port: 8787,
		});
		expect(() => sessionHostConfigFromEnv({ KUBERNETES_SERVICE_HOST: "10.96.0.1", T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "server", T4_SESSION_NAME: "bad/name" })).toThrow("T4_SESSION_NAME");
		expect(() => sessionHostConfigFromEnv({ KUBERNETES_SERVICE_HOST: "10.96.0.1", T4_CLUSTER_SERVER_SERVICE_ACCOUNT: "server", T4_SESSION_NAME: "session", T4_SESSION_STATE_ROOT: "/workspace/.t4/sessions/session", T4_KUBERNETES_API_AUDIENCE: "/invalid" })).toThrow("T4_KUBERNETES_API_AUDIENCE");
	});
});
