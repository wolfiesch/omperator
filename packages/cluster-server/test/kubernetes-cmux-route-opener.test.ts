import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it } from "vite-plus/test";
import { hostId, projectId, revision, sessionId } from "@t4-code/host-wire";
import { KubernetesCmuxWebSocketRouteOpener, KubernetesProviderCmuxRouteOpener } from "../src/kubernetes-cmux-route-opener.ts";
import type { KubernetesApiClient } from "../src/kubernetes-client.ts";
import { ClusterInfrastructureProjection, type KubernetesResource } from "../src/kubernetes-projection.ts";

const login = "owner@example.test";
const principal = `id_${createHash("sha256").update("t4.identity.tailscale.v1").update("\0").update(login).digest("base64url")}`;

describe("Kubernetes cmux WebSocket route opener", () => {
	it("loads the current generation secret server-side and preserves raw bytes", async () => {
		const server = new WebSocketServer({ port: 0 });
		await new Promise<void>(resolve => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("test WebSocket address is unavailable");
		const port = address.port;
		const headers = Promise.withResolvers<Record<string, string | string[] | undefined>>();
		const received = Promise.withResolvers<Uint8Array>();
		server.on("connection", (socket, request) => {
			headers.resolve(request.headers);
			socket.once("message", value => received.resolve(Buffer.from(value as Buffer)));
			socket.send(Uint8Array.from([4, 5, 6]));
		});
		const host: KubernetesResource = { kind: "T4ClusterHost", metadata: { name: "primary", uid: "host", resourceVersion: "1" }, spec: {} };
		const session: KubernetesResource = { kind: "T4Session", metadata: { name: "session", uid: "runtime-uid", resourceVersion: "3", generation: 1 }, spec: { hostRef: "primary", workspaceRef: "workspace", publicId: "runtime-public", title: "Runtime", desiredState: "Running" }, status: { phase: "Ready", runtimeGeneration: "gen_runtime_uid", podName: "runtime-pod", serviceName: "runtime-service", serviceUid: "runtime-service-uid", generationSecretName: "generation-secret", conditions: [{ type: "RouteReady", status: "True", observedGeneration: 1 }] } };
		const workspace: KubernetesResource = { kind: "T4Workspace", metadata: { name: "workspace", uid: "workspace", resourceVersion: "2", generation: 1 }, spec: { hostRef: "primary", owner: principal, size: "1Gi" }, status: { phase: "Ready", capacity: "1Gi" } };
		const projection = new ClusterInfrastructureProjection({ epoch: "epoch", namespace: "private" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "3" });
		projection.setSessionAuthority("session", { hostId: hostId("host"), sessionId: sessionId("session"), project: { projectId: projectId("project"), name: "Project" }, revision: revision("revision"), title: "Runtime", status: "idle", updatedAt: "2026-07-29T12:00:00.000Z" });
		const route = projection.cmuxWebSocketRoute("runtime-public", principal)!;
		const key = Buffer.alloc(32, 0x31);
		const api = { request: async (path: string) => { expect(path).toBe("/api/v1/namespaces/private/secrets/generation-secret"); return { data: { key: key.toString("base64") } }; } } as unknown as KubernetesApiClient;
		const opener = new KubernetesCmuxWebSocketRouteOpener(projection, api, (_url, options) => new WebSocket(`ws://127.0.0.1:${port}`, options));
		const abort = new AbortController();
		const stream = await opener.open(route, abort.signal);
		const requestHeaders = await headers.promise;
		expect(requestHeaders.authorization).toBe(`Bearer ${key.toString("base64url")}`);
		expect(requestHeaders["x-runtime-uid"]).toBe("runtime-uid");
		expect(requestHeaders["x-runtime-generation"]).toBe("gen_runtime_uid");
		await stream.write(Uint8Array.from([1, 2, 3]));
		expect([...(await received.promise)]).toEqual([1, 2, 3]);
		const iterator = stream.readable[Symbol.asyncIterator]();
		expect([...(await iterator.next()).value!]).toEqual([4, 5, 6]);
		await stream.end();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});

	it("adapts only the exact provider-resolved route for its authorized principal", async () => {
		const host: KubernetesResource = { kind: "T4ClusterHost", metadata: { name: "primary", uid: "host", resourceVersion: "1" }, spec: {} };
		const session: KubernetesResource = { kind: "T4Session", metadata: { name: "session", uid: "runtime-uid", resourceVersion: "3", generation: 1 }, spec: { hostRef: "primary", workspaceRef: "workspace", publicId: "runtime-public", desiredState: "Running" }, status: { phase: "Ready", observedGeneration: 1, runtimeGeneration: "gen_runtime_uid", podName: "runtime-pod", serviceName: "runtime-service", serviceUid: "runtime-service-uid", generationSecretName: "generation-secret", conditions: [{ type: "RouteReady", status: "True", observedGeneration: 1 }] } };
		const workspace: KubernetesResource = { kind: "T4Workspace", metadata: { name: "workspace", uid: "workspace", resourceVersion: "2", generation: 1 }, spec: { hostRef: "primary", owner: principal, size: "1Gi" }, status: { phase: "Ready", capacity: "1Gi" } };
		const projection = new ClusterInfrastructureProjection({ epoch: "epoch", namespace: "private" });
		projection.replace({ host, workspaces: [workspace], sessions: [session], resourceVersion: "3" });
		projection.setSessionAuthority("session", { hostId: hostId("host"), sessionId: sessionId("session"), project: { projectId: projectId("project"), name: "Project" }, revision: revision("revision"), title: "Runtime", status: "idle", updatedAt: "2026-07-29T12:00:00.000Z" });
		const portable = projection.portableRuntimeRoute(principal, "runtime-public", "cmux-v10", "gen_runtime_uid");
		if (portable.outcome !== "resolved") throw new Error("test route was not resolved");
		let openedRuntime = "";
		const direct = { open: async (route: { readonly runtimeId: string }) => {
			openedRuntime = route.runtimeId;
			return { readable: { async *[Symbol.asyncIterator]() {} }, write: async () => undefined, end: async () => undefined, close: async () => undefined };
		} };
		const adapter = new KubernetesProviderCmuxRouteOpener(projection, direct, principal);
		await adapter.open({ runtimeId: "runtime-public", runtimeGeneration: portable.generation, route: { kind: "cmux-v10", reference: portable.reference } });
		expect(openedRuntime).toBe("runtime-public");
		await expect(adapter.open({ runtimeId: "runtime-public", runtimeGeneration: portable.generation, route: { kind: "cmux-v10", reference: `${portable.reference}-tampered` } })).rejects.toThrow("no longer authoritative");
	});
});
