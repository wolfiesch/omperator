import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeIngressLedger, SharedPortableControlLedger } from "@t4-code/portable-control-store";
import type { ClusterGateway } from "../src/gateway.ts";
import { RequestIdentityResolver, TailscaleIdentityAdapter } from "../src/identity.ts";
import { ClusterInfrastructureProjection } from "../src/kubernetes-projection.ts";
import type { ClusterMetrics, ClusterServerHealth, JsonLogger } from "../src/observability.ts";
import { ProviderAssertionVerifier, type ClusterProviderService } from "../src/provider-service.ts";
import { startClusterHttpServers } from "../src/server.ts";

const secret = Buffer.alloc(32, 0x42);
const audience = "cluster.default.svc:8080/internal/provider";
const roots: string[] = [];
function assertion(): string {
	const body = Buffer.from(JSON.stringify({ v: 1, kid: "current", aud: audience, purpose: "provider.control", principalId: "principal", scopeId: "scope", requestId: "request", exp: Math.floor(Date.now() / 1_000) + 20, nonce: "abcdefghijklmnopqrstuvwx", authorizedScopes: [{ scopeId: "scope", roles: ["member"] }], policyRevision: "ssh-v1" })).toString("base64url");
	return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

const serveSpy = vi.spyOn(Bun, "serve");
afterEach(() => { serveSpy.mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
afterAll(() => serveSpy.mockRestore());

describe("internal SSH provider WebSocket route", () => {
	it("requires a single-use assertion and preserves provider protocol bytes", async () => {
		const served: Array<{ fetch(request: Request, server: unknown): Promise<Response | undefined>; websocket: { open(socket: unknown): void; message(socket: unknown, message: Uint8Array): void; close(socket: unknown): void } }> = [];
		serveSpy.mockImplementation(((options: typeof served[number]) => { served.push(options); return { stop: async () => undefined }; }) as unknown as typeof Bun.serve);
		const projection = new ClusterInfrastructureProjection({ epoch: "epoch", namespace: "namespace" });
		let closed = 0;
		const providerService = {
			async openControl() { return { session: { receive: async (input: Uint8Array) => [Uint8Array.from([input[0]!, 0x7f])] }, close: async () => { closed++; } }; },
		} as unknown as ClusterProviderService;
		const root = mkdtempSync(join(tmpdir(), "provider-route-keyring-")); roots.push(root);
		const keyringPath = join(root, "keyring.json");
		writeFileSync(keyringPath, JSON.stringify({ revision: 1, activeKid: "current", keys: [{ kid: "current", secret: secret.toString("base64url") }] }));
		const claimed = new Set<string>();
		const assertionLedger = { acceptProviderAssertionKeyring: () => "accepted" as const, claimProviderAssertionNonce: ({ nonce }: { nonce: string }) => claimed.has(nonce) ? "replayed" as const : (claimed.add(nonce), "claimed" as const) } as unknown as SharedPortableControlLedger;
		startClusterHttpServers({
			gateway: { connectionCount: 0, beginDrain() {} } as unknown as ClusterGateway,
			runtimeIngress: {} as RuntimeIngressLedger,
			projection,
			gatewayPort: 8080,
			adminPort: 9090,
			identityResolver: new RequestIdentityResolver([new TailscaleIdentityAdapter({ id: "tailnet", type: "tailscale", policyRevision: "1" })]),
			restApi: { restBaseUrl: "https://public.example.test/v1", ompAppWebSocketUrl: "wss://public.example.test/v1/ws", build: { version: "1", revision: "revision", builtAt: "2026-07-29T12:00:00.000Z" } },
			providerService,
			providerAssertionVerifier: new ProviderAssertionVerifier({ keyringPath, ledger: assertionLedger, audience }),
			health: { beginDrain() {}, markGatewayStopped() {}, markGatewayListening() {} } as unknown as ClusterServerHealth,
			metrics: { set() {}, increment() {} } as unknown as ClusterMetrics,
			logger: { info() {} } as unknown as JsonLogger,
		});
		const gateway = served[0]!;
		let data: unknown;
		const server = { requestIP: () => ({ address: "127.0.0.1" }), upgrade: (_request: Request, options: { data: unknown }) => { data = options.data; return true; } };
		const url = "http://cluster/internal/provider/control";
		expect(await gateway.fetch(new Request(url), server)).toMatchObject({ status: 401 });
		expect(await gateway.fetch(new Request(url, { headers: { "x-t4-provider-assertion": assertion() } }), server)).toBeUndefined();
		expect(await gateway.fetch(new Request(url, { headers: { "x-t4-provider-assertion": assertion() } }), server)).toMatchObject({ status: 401 });
		const sent: Uint8Array[] = [];
		const delivered = Promise.withResolvers<void>();
		const socket = { data, send(value: Uint8Array) { sent.push(value); delivered.resolve(); return value.byteLength; }, getBufferedAmount: () => 0, close() {} };
		gateway.websocket.open(socket);
		gateway.websocket.message(socket, Uint8Array.from([0x31]));
		await delivered.promise;
		expect([...sent[0]!]).toEqual([0x31, 0x7f]);
		gateway.websocket.close(socket);
		expect(closed).toBe(1);
	});
});
