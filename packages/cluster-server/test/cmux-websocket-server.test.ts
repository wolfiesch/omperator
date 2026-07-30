import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { hostId, projectId, revision, sessionId } from "@t4-code/host-wire";
import type { RuntimeIngressIdentity, RuntimeIngressLedger, RuntimeIngressState } from "@t4-code/portable-control-store";
import type { CmuxJsonlByteStream, CmuxWebSocketRoute } from "../src/cmux-websocket.ts";
import type { ClusterGateway } from "../src/gateway.ts";
import { RequestIdentityResolver, TailscaleIdentityAdapter } from "../src/identity.ts";
import { ClusterInfrastructureProjection, type KubernetesResource } from "../src/kubernetes-projection.ts";
import type { ClusterMetrics, ClusterServerHealth, JsonLogger } from "../src/observability.ts";
import { startClusterHttpServers } from "../src/server.ts";

const LOGIN = "owner@example.test";
const PRINCIPAL = `id_${createHash("sha256").update("t4.identity.tailscale.v1").update("\0").update(LOGIN).digest("base64url")}`;
const host: KubernetesResource = {
	kind: "T4ClusterHost",
	metadata: { name: "primary", uid: "host-uid", resourceVersion: "1" },
	spec: {},
};
const workspace: KubernetesResource = {
	kind: "T4Workspace",
	metadata: { name: "workspace-private", uid: "workspace-uid", resourceVersion: "2", generation: 1 },
	spec: { hostRef: "primary", owner: PRINCIPAL, displayName: "Workspace", size: "1Gi" },
	status: { phase: "Ready", capacity: "1Gi" },
};
function session(uid = "session-uid", resourceVersion = "3"): KubernetesResource {
	return {
		kind: "T4Session",
		metadata: { name: "session-private", uid, resourceVersion, generation: 1 },
		spec: { hostRef: "primary", workspaceRef: "workspace-private", publicId: "runtime-public", title: "Runtime" },
		status: { phase: "Ready", runtimeGeneration: `gen_${uid.replaceAll("-", "_")}`, podName: "pod-private", serviceName: "service-private", conditions: [{ type: "RouteReady", status: "True", observedGeneration: 1 }] },
	};
}

class ByteQueue implements AsyncIterable<Uint8Array> {
	readonly #values: Uint8Array[] = [];
	readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
	#ended = false;
	push(value: string): void {
		const bytes = new TextEncoder().encode(value);
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value: bytes });
		else this.#values.push(bytes);
	}
	end(): void {
		this.#ended = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return { next: async () => {
			const value = this.#values.shift();
			if (value) return { done: false, value };
			if (this.#ended) return { done: true, value: undefined };
			const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
			this.#waiters.push(pending.resolve);
			return await pending.promise;
		} };
	}
}
class MemoryDuplex implements CmuxJsonlByteStream {
	readonly source = new ByteQueue();
	readonly readable = this.source;
	readonly writes: Uint8Array[] = [];
	readonly wrote = Promise.withResolvers<void>();
	closed = 0;
	async write(chunk: Uint8Array): Promise<void> { this.writes.push(chunk.slice()); this.wrote.resolve(); }
	async end(): Promise<void> {}
	async close(): Promise<void> { this.closed++; this.source.end(); }
}

class MemoryRuntimeIngress implements RuntimeIngressLedger {
	readonly leases = new Map<string, RuntimeIngressIdentity>();
	open = true;
	#sequence = 0;
	acquireRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly ttlSeconds: number }) {
		if (!this.open) return { outcome: "fenced" as const };
		const leaseId = `lease-${++this.#sequence}`;
		this.leases.set(leaseId, request);
		return { outcome: "acquired" as const, leaseId, expiresAt: new Date(Date.now() + request.ttlSeconds * 1000).toISOString() };
	}
	renewRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly leaseId: string; readonly ttlSeconds: number }) {
		if (!this.open) return { outcome: "fenced" as const };
		return this.leases.has(request.leaseId)
			? { outcome: "renewed" as const, expiresAt: new Date(Date.now() + request.ttlSeconds * 1000).toISOString() }
			: { outcome: "notFound" as const };
	}
	releaseRuntimeIngress(request: RuntimeIngressIdentity & { readonly gatewayReplicaEpoch: string; readonly leaseId: string }) {
		const current = this.leases.get(request.leaseId);
		if (!current || current.runtimeId !== request.runtimeId || current.generation !== request.generation) return "notFound" as const;
		this.leases.delete(request.leaseId);
		return "released" as const;
	}
	beginRuntimeIngressDrain(request: RuntimeIngressIdentity & { readonly mode: "idle" | "explicit" }) {
		if (request.mode === "idle" && this.leases.size > 0) return { outcome: "busy" as const, activeLeases: this.leases.size };
		this.open = false;
		return { outcome: "fenced" as const, activeLeases: this.leases.size };
	}
	reopenRuntimeIngress(_request: RuntimeIngressIdentity) {
		this.open = true;
		return "reopened" as const;
	}
	runtimeIngressState(request: RuntimeIngressIdentity): RuntimeIngressState {
		return { ...request, open: this.open, activeLeases: this.leases.size };
	}
}

interface CapturedServe {
	readonly fetch: (request: Request, server: {
		requestIP(request: Request): { readonly address: string } | null;
		upgrade(request: Request, options: { readonly data: unknown }): boolean;
	}) => Promise<Response | undefined>;
	readonly websocket: {
		open(socket: TestSocket): void;
		message(socket: TestSocket, message: string | Uint8Array): void;
		close(socket: TestSocket): void;
	};
}
interface TestSocket {
	data: Record<string, unknown>;
	readonly sent: string[];
	readonly closes: Array<[number, string]>;
	send(value: string): number;
	getBufferedAmount(): number;
	close(code: number, reason: string): void;
	waitForSent(): Promise<void>;
	waitForClose(): Promise<void>;
}
function testSocket(data: unknown): TestSocket {
	const sent = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	return {
		data: data as Record<string, unknown>,
		sent: [],
		closes: [],
		send(value) { this.sent.push(value); sent.resolve(); return new TextEncoder().encode(value).byteLength; },
		getBufferedAmount() { return 0; },
		close(code, reason) { this.closes.push([code, reason]); closed.resolve(); },
		waitForSent: () => sent.promise,
		waitForClose: () => closed.promise,
	};
}

const serveSpy = vi.spyOn(Bun, "serve");
afterEach(() => serveSpy.mockReset());

describe("authenticated direct cmux server route", () => {
	it("opens by public binding, preserves bytes, denies foreign owners, revokes replacement, and drains", async () => {
		const served: CapturedServe[] = [];
		serveSpy.mockImplementation(((options: CapturedServe) => {
			served.push(options);
			return { stop: async () => undefined };
		}) as unknown as typeof Bun.serve);
		const projection = new ClusterInfrastructureProjection({ epoch: "replica", namespace: "private-namespace" });
		projection.replace({ host, workspaces: [workspace], sessions: [session()], resourceVersion: "3" });
		projection.setSessionAuthority("session-private", {
			hostId: hostId("pod-host-private"),
			sessionId: sessionId("upstream-private"),
			project: { projectId: projectId("project-private"), name: "Project" },
			revision: revision("authority-one"),
			title: "Runtime",
			status: "idle",
			updatedAt: "2026-07-29T12:00:00.000Z",
		});
		const opened: CmuxWebSocketRoute[] = [];
		const streams: MemoryDuplex[] = [];
		const signals: AbortSignal[] = [];
		let openGate: Promise<void> | undefined;
		let openObserved = Promise.withResolvers<void>();
		const runtimeIngress = new MemoryRuntimeIngress();
		const servers = startClusterHttpServers({
			gateway: { connectionCount: 0, beginDrain() {} } as unknown as ClusterGateway,
			runtimeIngress,
			projection,
			gatewayPort: 8080,
			adminPort: 9090,
			identityResolver: new RequestIdentityResolver([new TailscaleIdentityAdapter({ id: "tailnet", type: "tailscale", policyRevision: "1" })]),
			trustedProxyAddresses: ["127.0.0.1"],
			restApi: {
				restBaseUrl: "https://public.example.test/v1",
				ompAppWebSocketUrl: "wss://public.example.test/v1/ws",
				cmuxWebSocketTemplate: "wss://public.example.test/v1/cmux/{runtimeId}",
				build: { version: "1", revision: "revision", builtAt: "2026-07-29T12:00:00.000Z" },
			},
			cmuxWebSocketRouteOpener: { open: async (route: CmuxWebSocketRoute, signal: AbortSignal) => {
				opened.push(route);
				signals.push(signal);
				const stream = new MemoryDuplex();
				streams.push(stream);
				openObserved.resolve();
				await openGate;
				return stream;
			} },
			health: { beginDrain() {}, markGatewayStopped() {}, markGatewayListening() {} } as unknown as ClusterServerHealth,
			metrics: { set() {}, increment() {} } as unknown as ClusterMetrics,
			logger: { info() {} } as unknown as JsonLogger,
		});
		const gateway = served[0]!;
		let upgraded: unknown;
		const request = (principal: string, signal?: AbortSignal) => new Request("https://public.example.test/v1/cmux/runtime-public", {
			headers: { "x-forwarded-proto": "https", "tailscale-user-login": principal },
			...(signal ? { signal } : {}),
		});
		const server = {
			requestIP: () => ({ address: "127.0.0.1" }),
			upgrade: (_request: Request, options: { readonly data: unknown }) => { upgraded = options.data; return true; },
		};
		const unauthenticated = new Request("https://public.example.test/v1/cmux/runtime-public");
		expect(await gateway.fetch(unauthenticated, server)).toMatchObject({ status: 401 });
		expect(opened).toHaveLength(0);
		expect(await gateway.fetch(request("other@example.test"), server)).toMatchObject({ status: 404 });
		expect(opened).toHaveLength(0);
		expect(await gateway.fetch(request(LOGIN), server)).toBeUndefined();
		expect(opened).toEqual([{ principal: PRINCIPAL, runtimeId: "runtime-public", generation: expect.stringMatching(/^gen_/u), routeGeneration: expect.stringMatching(/^route_/u) }]);
		expect(JSON.stringify(opened)).not.toContain("private");
		expect(runtimeIngress.leases.size).toBe(1);

		const socket = testSocket(upgraded);
		gateway.websocket.open(socket);
		const identify = '{ "cmd" : "identify", "number": 1e+03, "base64": "AQID==" }';
		gateway.websocket.message(socket, identify);
		streams[0]!.source.push(' {"event" : "ready", "number":1e+03} \n');
		await Promise.all([streams[0]!.wrote.promise, socket.waitForSent()]);
		const written = Buffer.concat(streams[0]!.writes.map(value => Buffer.from(value)));
		expect(written.toString("utf8")).toBe(`${identify}\n`);
		expect(createHash("sha256").update(written).digest("hex")).toBe("30edc7846b6ac226569facd4a16ad8ff81ab6a2cd3c587bc19e349dd8deed32b");
		expect(socket.sent).toEqual([' {"event" : "ready", "number":1e+03} ']);

		projection.applyWatch({ type: "MODIFIED", object: session("replacement-session-uid", "4") });
		await socket.waitForClose();
		expect(socket.closes[0]).toEqual([1008, "cmux route revoked"]);
		expect(signals[0]!.aborted).toBe(true);
		expect(streams[0]!.closed).toBeGreaterThan(0);
		expect(runtimeIngress.leases.size).toBe(0);

		projection.setSessionAuthority("session-private", {
			hostId: hostId("pod-host-private"), sessionId: sessionId("upstream-private"),
			project: { projectId: projectId("project-private"), name: "Project" }, revision: revision("authority-two"),
			title: "Runtime", status: "idle", updatedAt: "2026-07-29T12:01:00.000Z",
		});
		await gateway.fetch(request(LOGIN), server);
		const second = testSocket(upgraded);
		gateway.websocket.open(second);
		projection.applyWatch({
			type: "MODIFIED",
			object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "5" }, spec: { ...workspace.spec, owner: "other@example.test" } },
		});
		await second.waitForClose();
		expect(second.closes[0]).toEqual([1008, "cmux route revoked"]);
		expect(signals[1]!.aborted).toBe(true);

		projection.applyWatch({
			type: "MODIFIED",
			object: { ...workspace, metadata: { ...workspace.metadata, resourceVersion: "6" } },
		});
		const gate = Promise.withResolvers<void>();
		openGate = gate.promise;
		openObserved = Promise.withResolvers<void>();
		const requestAbort = new AbortController();
		const pendingFetch = gateway.fetch(request(LOGIN, requestAbort.signal), server);
		await openObserved.promise;
		expect(runtimeIngress.leases.size).toBe(1);
		requestAbort.abort();
		gate.resolve();
		expect(await pendingFetch).toMatchObject({ status: 404 });
		expect(signals[2]!.aborted).toBe(true);
		expect(streams[2]!.closed).toBeGreaterThan(0);
		expect(runtimeIngress.leases.size).toBe(0);
		openGate = undefined;
		await gateway.fetch(request(LOGIN), server);
		const third = testSocket(upgraded);
		gateway.websocket.open(third);
		await servers.drain();
		expect(third.closes[0]).toEqual([1001, "cluster server draining"]);
		expect(signals[3]!.aborted).toBe(true);
		expect(runtimeIngress.leases.size).toBe(0);
		await servers.stop();
	});
});
