import { randomUUID } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { normalizeIpAddress } from "@t4-code/host-service";
import type { RuntimeIngressLedger } from "@t4-code/portable-control-store";
import type { DuplexByteStream } from "@t4-code/provider-engine";
import {
	CmuxWebSocketBridge,
	MAX_CMUX_FRAME_BYTES,
	isValidCmuxWebSocketTemplate,
	sameCmuxWebSocketRoute,
	type CmuxJsonlByteStream,
	type CmuxWebSocketRoute,
	type CmuxWebSocketRouteOpener,
} from "./cmux-websocket.ts";
import { requestIdentityOwnsProjectedScope, requestIdentityScopeId, type RequestIdentity, type RequestIdentityResolver } from "./identity.ts";
import type { GatewayConnection, ClusterGateway } from "./gateway.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import { ClusterMetrics, ClusterServerHealth, JsonLogger, createAdminHandler } from "./observability.ts";
import { createClusterRestHandler, type ClusterRestApiConfig, type ClusterRestHandlerOptions } from "./rest-handler.ts";
import { Authorizer, createAuthorizationRequestId, isAuthorized } from "./authorization.ts";
import type { ClusterProviderService, OpenProviderControl, ProviderAssertionVerifier, ProviderAuthority } from "./provider-service.ts";
const GATEWAY_WEBSOCKET_LIMIT = 1_048_576;
const INGRESS_LEASE_TTL_SECONDS = 4;
const INGRESS_RELEASE_ATTEMPTS = 3;

interface GatewaySocketData { readonly kind: "gateway"; connection?: GatewayConnection; readonly identity: RequestIdentity; readonly requestId: string; }
interface CmuxSocketData {
	readonly kind: "cmux";
	readonly identity: RequestIdentity;
	readonly route: CmuxWebSocketRoute;
	readonly runtimeIngressIdentity: Readonly<{ runtimeId: string; generation: string }>;
	readonly abort: AbortController;
	readonly requestId: string;
	readonly ingressLeaseId: string;
	readonly fenceTimer: ReturnType<typeof setInterval>;
	readonly expiryTimer: ReturnType<typeof setTimeout>;
	released: boolean;
	stream?: CmuxJsonlByteStream;
	bridge?: CmuxWebSocketBridge;
}
interface ProviderControlSocketData { readonly kind: "provider-control"; readonly control: OpenProviderControl; }
interface ProviderStreamSocketData { readonly kind: "provider-stream"; readonly authority: ProviderAuthority; readonly abort: AbortController; transport?: ProviderWebSocketTransport; }
interface ProviderWebSocketPeer {
	send(value: Uint8Array): number;
	close(code?: number, reason?: string): void;
	getBufferedAmount(): number;
}
export class ProviderWebSocketTransport implements DuplexByteStream {
	readonly #socket: ProviderWebSocketPeer;
	readonly #chunks: Uint8Array[] = [];
	readonly #readers: Array<{ resolve(value: IteratorResult<Uint8Array>): void; reject(error: unknown): void }> = [];
	#ended = false;
	#queuedBytes = 0;
	constructor(socket: ProviderWebSocketPeer) { this.#socket = socket; }
	readonly readable: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => {
		const chunk = this.#chunks.shift();
		if (chunk) {
			this.#queuedBytes -= chunk.byteLength;
			return Promise.resolve({ done: false as const, value: chunk });
		}
		if (this.#ended) return Promise.resolve({ done: true as const, value: undefined });
		const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
		this.#readers.push(pending);
		return pending.promise;
	} }) };
	receive(value: string | ArrayBuffer | Uint8Array): void {
		const chunk = typeof value === "string" ? Buffer.from(value) : new Uint8Array(value);
		const reader = this.#readers.shift();
		if (reader) reader.resolve({ done: false, value: chunk });
		else if (chunk.byteLength > GATEWAY_WEBSOCKET_LIMIT - this.#queuedBytes) {
			this.#finish();
			this.#socket.close(1009, "provider inbound queue limit exceeded");
		} else {
			this.#chunks.push(chunk);
			this.#queuedBytes += chunk.byteLength;
		}
	}
	async write(chunk: Uint8Array): Promise<void> {
		if (this.#ended || this.#socket.getBufferedAmount() > GATEWAY_WEBSOCKET_LIMIT - chunk.byteLength || this.#socket.send(chunk) <= 0) throw new Error("provider WebSocket backpressure limit exceeded");
	}
	async end(): Promise<void> { this.#finish(); this.#socket.close(1000, "provider stream ended"); }
	async close(_cause?: unknown): Promise<void> { this.#finish(); this.#socket.close(1011, "provider stream closed"); }
	clientClosed(): void { this.#finish(); }
	#finish(): void { if (this.#ended) return; this.#ended = true; for (const reader of this.#readers.splice(0)) reader.resolve({ done: true, value: undefined }); }
}
type SocketData = GatewaySocketData | CmuxSocketData | ProviderControlSocketData | ProviderStreamSocketData;
export interface ClusterHttpServersOptions {
	readonly gateway: ClusterGateway;
	readonly runtimeIngress: RuntimeIngressLedger;
	readonly projection: ClusterInfrastructureProjection;
	readonly gatewayPort: number;
	readonly adminPort: number;
	readonly identityResolver: RequestIdentityResolver;
	readonly trustedProxyAddresses?: readonly string[];
	readonly providerService?: ClusterProviderService;
	readonly providerAssertionVerifier?: ProviderAssertionVerifier;
	readonly trustedProxyCidrs?: readonly string[];
	readonly restApi: ClusterRestApiConfig;
	readonly cmuxWebSocketRouteOpener?: CmuxWebSocketRouteOpener;
	readonly restMutations?: ClusterRestHandlerOptions["mutations"];
	readonly admission?: ClusterRestHandlerOptions["admission"];
	readonly lifecycleEvents?: ClusterRestHandlerOptions["eventSource"] & { close?: () => void | Promise<void> };
	readonly health: ClusterServerHealth;
	readonly metrics: ClusterMetrics;
	readonly logger: JsonLogger;
	readonly authorizer?: Authorizer;
}
export interface ClusterHttpServers {
	drain(): Promise<void>;
	stop(): Promise<void>;
}
function trustedProxyMatcher(addresses: readonly string[], cidrs: readonly string[]): (address: string) => boolean {
	const exact = new Set(addresses.map(normalizeIpAddress));
	const subnets = new BlockList();
	for (const cidr of cidrs) {
		const [address, prefixText] = cidr.split("/");
		const family = isIP(address!);
		if ((family !== 4 && family !== 6) || !/^(?:0|[1-9][0-9]*)$/u.test(prefixText ?? ""))
			throw new Error("trusted proxy CIDR is invalid");
		subnets.addSubnet(address!, Number(prefixText), family === 4 ? "ipv4" : "ipv6");
	}
	return address => {
		const normalized = normalizeIpAddress(address);
		const family = isIP(normalized);
		return exact.has(normalized) || family !== 0 && subnets.check(normalized, family === 4 ? "ipv4" : "ipv6");
	};
}
export async function observeClusterRestResponse(
	metrics: ClusterMetrics,
	handler: (request: Request, identity?: RequestIdentity) => Response | Promise<Response>,
	request: Request,
	identity?: RequestIdentity,
): Promise<Response> {
	const startedAt = performance.now();
	let result: "success" | "denied" | "error" = "error";
	try {
		const response = await handler(request, identity);
		result = response.status >= 500 ? "error" : response.status >= 400 ? "denied" : "success";
		return response;
	} finally {
		const labels = { transport: "rest", operation: "request", result } as const;
		metrics.increment("omperator_gateway_requests_total", labels);
		metrics.observe("omperator_gateway_request_duration_seconds", (performance.now() - startedAt) / 1_000, labels);
	}
}

export function recordCmuxProtocolMismatch(metrics: ClusterMetrics): void {
	metrics.increment("omperator_cmux_protocol_mismatch_total", {});
}

export function recordBrowserStreamDrop(metrics: ClusterMetrics, frame: Readonly<{ readonly type: string }>, dropped: boolean): void {
	if (dropped && frame.type.startsWith("preview."))
		metrics.increment("omperator_browser_stream_dropped_frames_total", {});
}


export function isLoopbackAddress(address: string): boolean {
	const normalized = normalizeIpAddress(address);
	if (normalized === "::1") return true;
	if (isIP(normalized) !== 4) return false;
	const firstOctet = Number(normalized.split(".", 1)[0]);
	return firstOctet === 127;
}

export async function gatewayIdentity(
	request: Request,
	remoteAddress: string,
	trustedSource: (address: string) => boolean,
	resolver: RequestIdentityResolver,
): Promise<RequestIdentity | undefined> {
	try {
		return await resolver.authenticate({ request, remoteAddress, isTrustedProxy: trustedSource });
	} catch {
		return undefined;
	}
}

export function startClusterHttpServers(options: ClusterHttpServersOptions): ClusterHttpServers {
	let draining = false;
	const authorize = (identity: RequestIdentity, action: "runtime.connect.cmux" | "runtime.connect.omp-app", requestId: string, resourceId?: string): boolean => {
		const scopeId = requestIdentityScopeId(identity);
		return options.authorizer
			? options.authorizer.decide({ identity, scopeId, action, gateway: action === "runtime.connect.cmux" ? "cmux" : "omp-app", requestId, ...(resourceId ? { resourceId } : {}) }).allowed
			: isAuthorized(identity, scopeId, action);
	};
	const trustedSource = trustedProxyMatcher(options.trustedProxyAddresses ?? [], options.trustedProxyCidrs ?? []);
	const gatewayReplicaEpoch = randomUUID();
	const cmuxEnabled = options.cmuxWebSocketRouteOpener !== undefined && isValidCmuxWebSocketTemplate(options.restApi.cmuxWebSocketTemplate);
	const restHandler = createClusterRestHandler({
		projection: options.projection,
		config: options.restApi,
		mutations: options.restMutations,
		admission: options.admission,
		eventSource: options.lifecycleEvents,
		directCmuxWebSocket: cmuxEnabled,
		authorizer: options.authorizer,
	});
	const observeRestResponse = (request: Request, identity?: RequestIdentity): Promise<Response> =>
		observeClusterRestResponse(options.metrics, restHandler, request, identity);
	const cmuxSockets = new Set<CmuxSocketData>();
	const releaseCmuxIngress = (data: CmuxSocketData): void => {
		if (data.released) return;
		data.released = true;
		clearInterval(data.fenceTimer);
		clearTimeout(data.expiryTimer);
		const release = async (): Promise<void> => {
			for (let attempt = 0; attempt < INGRESS_RELEASE_ATTEMPTS; attempt++) {
				try {
					await options.runtimeIngress.releaseRuntimeIngress({
						runtimeId: data.runtimeIngressIdentity.runtimeId,
						generation: data.runtimeIngressIdentity.generation,
						gatewayReplicaEpoch,
						leaseId: data.ingressLeaseId,
					});
					return;
				} catch {
					// Expiry is the final recovery path when all bounded retries fail.
				}
			}
		};
		void release();
	};
	const revokeCmux = async (data: CmuxSocketData, code: number, reason: string): Promise<void> => {
		cmuxSockets.delete(data);
		releaseCmuxIngress(data);
		data.abort.abort(new Error(reason));
		if (data.bridge) await data.bridge.close(code, reason);
		else if (data.stream) {
			try { await data.stream.close(new Error(reason)); } catch {}
		}
	};
	const unsubscribeCmux = cmuxEnabled ? options.projection.subscribeSessions(() => {
		for (const data of cmuxSockets) {
			if (!authorize(data.identity, "runtime.connect.cmux", data.requestId, data.route.runtimeId)) {
				void revokeCmux(data, 1008, "cmux route revoked");
				continue;
			}
			const current = options.projection.cmuxWebSocketRoute(data.route.runtimeId, data.identity.principalId, data.identity);
			if (!sameCmuxWebSocketRoute(current, data.route)) void revokeCmux(data, 1008, "cmux route revoked");
		}
	}) : undefined;
	const gatewayServer = Bun.serve<SocketData>({
		hostname: "0.0.0.0",
		port: options.gatewayPort,
		async fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname === "/.well-known/omperator") return await observeRestResponse(request);
			const cmuxMatch = cmuxEnabled ? /^\/v1\/cmux\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})$/u.exec(url.pathname) : null;
			const providerKind = options.providerService && url.pathname === "/v1/provider/control" ? "provider-control" : options.providerService && url.pathname === "/v1/provider/stream" ? "provider-stream" : undefined;
			const internalProviderKind = options.providerAssertionVerifier && options.providerService && url.pathname === "/internal/provider/control" ? "provider-control" : options.providerAssertionVerifier && options.providerService && url.pathname === "/internal/provider/stream" ? "provider-stream" : undefined;
			if (url.pathname !== "/v1/ws" && !cmuxMatch && !providerKind && !internalProviderKind) {
				const remoteAddress = server.requestIP(request)?.address;
				const identity = remoteAddress ? await gatewayIdentity(request, remoteAddress, trustedSource, options.identityResolver) : undefined;
				return await observeRestResponse(request, identity);
			}
			if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
			if (draining) return new Response("draining", { status: 503 });
			if (internalProviderKind) {
				if (url.search !== "") return new Response("not found", { status: 404 });
				const authority = await options.providerAssertionVerifier!.verify(request.headers.get("x-t4-provider-assertion"), internalProviderKind === "provider-control" ? "control" : "stream");
				if (!authority) return new Response("authentication required", { status: 401 });
				if (internalProviderKind === "provider-control") {
					let control: OpenProviderControl;
					try { control = await options.providerService!.openControl(authority); }
					catch { return new Response("provider unavailable", { status: 503 }); }
					if (!server.upgrade(request, { data: { kind: internalProviderKind, control } })) {
						await control.close();
						return new Response("upgrade required", { status: 426 });
					}
					return undefined;
				}
				if (!server.upgrade(request, { data: { kind: internalProviderKind, authority, abort: new AbortController() } })) return new Response("upgrade required", { status: 426 });
				return undefined;
			}
			const remoteAddress = server.requestIP(request)?.address;
			if (!remoteAddress) return new Response("authenticated proxy required", { status: 401 });
			const identity = await gatewayIdentity(request, remoteAddress, trustedSource, options.identityResolver);
			if (!identity) return new Response("authentication required", { status: 401 });
			const requestId = createAuthorizationRequestId();
			const runtimeId = cmuxMatch?.[1];
			if (runtimeId) {
				if (url.search !== "" || !authorize(identity, "runtime.connect.cmux", requestId, runtimeId))
					return new Response("not found", { status: 404 });
			} else if (!providerKind && !authorize(identity, "runtime.connect.omp-app", requestId)) {
				return new Response("not found", { status: 404 });
			}
			if (!requestIdentityOwnsProjectedScope(identity, requestIdentityScopeId(identity))) return new Response("not found", { status: 404 });
			const origin = request.headers.get("origin");
			if (origin && !options.projection.allowedOrigins().includes(origin)) return new Response("forbidden", { status: 403 });
			if (providerKind) {
				if (url.search !== "") return new Response("not found", { status: 404 });
				const authority: ProviderAuthority = { identity, scopeId: requestIdentityScopeId(identity), ownerPrincipal: identity.principalId, gateway: "rest" };
				if (providerKind === "provider-control") {
					let control: OpenProviderControl;
					try { control = await options.providerService!.openControl(authority); }
					catch { return new Response("provider unavailable", { status: 503 }); }
					if (!server.upgrade(request, { data: { kind: providerKind, control } })) {
						await control.close();
						return new Response("upgrade required", { status: 426 });
					}
					return undefined;
				}
				if (!server.upgrade(request, { data: { kind: providerKind, authority, abort: new AbortController() } })) return new Response("upgrade required", { status: 426 });
				return undefined;
			}
			if (cmuxMatch) {
				const route = options.projection.cmuxWebSocketRoute(cmuxMatch[1]!, identity.principalId, identity);
				if (!route) return new Response("not found", { status: 404 });
				const runtimeIngressIdentity = options.projection.cmuxRuntimeIngressIdentity(cmuxMatch[1]!, identity.principalId, identity);
				if (!runtimeIngressIdentity || runtimeIngressIdentity.generation !== route.generation) return new Response("not found", { status: 404 });
				let ingress;
				try {
					ingress = await options.runtimeIngress.acquireRuntimeIngress({
						runtimeId: runtimeIngressIdentity.runtimeId,
						generation: runtimeIngressIdentity.generation,
						gatewayReplicaEpoch,
						ttlSeconds: INGRESS_LEASE_TTL_SECONDS,
					});
				} catch {
					return new Response("runtime ingress authority unavailable", { status: 503 });
				}
				if (ingress.outcome === "fenced") return new Response("runtime draining", { status: 503 });
				let data!: CmuxSocketData;
				let leaseExpiresAt = Date.parse(ingress.expiresAt);
				let renewalAttempt = 0;
				let expiryTimer!: ReturnType<typeof setTimeout>;
				const expireRoute = (): void => {
					if (data?.released) return;
					const remaining = leaseExpiresAt - Date.now();
					if (remaining > 0) {
						expiryTimer = setTimeout(expireRoute, remaining);
						expiryTimer.unref?.();
						return;
					}
					void revokeCmux(data, 1012, "runtime ingress lease expired");
				};
				const scheduleExpiry = (): void => {
					clearTimeout(expiryTimer);
					expiryTimer = setTimeout(expireRoute, Math.max(0, leaseExpiresAt - Date.now()));
					expiryTimer.unref?.();
				};
				scheduleExpiry();
				const fenceTimer = setInterval(() => {
					if (Date.now() >= leaseExpiresAt) {
						expireRoute();
						return;
					}
					const renew = Date.now() >= leaseExpiresAt - INGRESS_LEASE_TTL_SECONDS * 500;
					const attempt = ++renewalAttempt;
					const operation = renew
						? Promise.resolve(options.runtimeIngress.renewRuntimeIngress({
							runtimeId: runtimeIngressIdentity.runtimeId,
							generation: runtimeIngressIdentity.generation,
							gatewayReplicaEpoch,
							leaseId: ingress.leaseId,
							ttlSeconds: INGRESS_LEASE_TTL_SECONDS,
						}))
						: Promise.resolve(options.runtimeIngress.runtimeIngressState({
							runtimeId: runtimeIngressIdentity.runtimeId,
							generation: runtimeIngressIdentity.generation,
						}));
					void operation.then(result => {
						if (data.released || attempt !== renewalAttempt) return;
						if ("expiresAt" in result) {
							if (Date.now() >= leaseExpiresAt) {
								expireRoute();
								return;
							}
							const acknowledgedExpiry = Date.parse(result.expiresAt);
							if (Number.isFinite(acknowledgedExpiry) && acknowledgedExpiry > leaseExpiresAt) {
								leaseExpiresAt = acknowledgedExpiry;
								scheduleExpiry();
							}
							return;
						}
						if (!("open" in result) || !result.open) void revokeCmux(data, 1012, "runtime draining");
					}, () => undefined);
				}, 100);
				fenceTimer.unref?.();
				data = { kind: "cmux", identity, route, runtimeIngressIdentity, abort: new AbortController(), requestId, ingressLeaseId: ingress.leaseId, fenceTimer, expiryTimer, released: false };
				cmuxSockets.add(data);
				const requestAborted = (): void => { void revokeCmux(data, 1001, "cmux request aborted"); };
				request.signal.addEventListener("abort", requestAborted, { once: true });
				if (request.signal.aborted) requestAborted();
				try {
					data.stream = await options.cmuxWebSocketRouteOpener!.open(route, data.abort.signal);
				} catch {
					request.signal.removeEventListener("abort", requestAborted);
					cmuxSockets.delete(data);
					data.abort.abort();
					options.authorizer?.error({ identity, scopeId: requestIdentityScopeId(identity), action: "runtime.connect.cmux", gateway: "cmux", requestId, resourceId: route.runtimeId });
					if (!authorize(identity, "runtime.connect.cmux", requestId, route.runtimeId)) return new Response("not found", { status: 404 });
					const current = options.projection.cmuxWebSocketRoute(route.runtimeId, identity.principalId, identity);
					if (!sameCmuxWebSocketRoute(current, route)) return new Response("not found", { status: 404 });
					options.metrics.increment("omperator_gateway_requests_total", { transport: "cmux", operation: "open", result: "error" });
					return new Response("cmux backend unavailable", { status: 503 });
				}
				if (!authorize(identity, "runtime.connect.cmux", requestId, route.runtimeId)) {
					await revokeCmux(data, 1008, "cmux route revoked");
					return new Response("not found", { status: 404 });
				}
				const current = options.projection.cmuxWebSocketRoute(route.runtimeId, identity.principalId, identity);
				request.signal.removeEventListener("abort", requestAborted);
				if (draining || data.abort.signal.aborted || !sameCmuxWebSocketRoute(current, route)) {
					await revokeCmux(data, 1008, "cmux route revoked");
					return new Response("not found", { status: 404 });
				}
				if (!server.upgrade(request, { data })) {
					await revokeCmux(data, 1001, "cmux upgrade rejected");
					return new Response("upgrade required", { status: 426 });
				}
				return undefined;
			}
			if (!server.upgrade(request, { data: { kind: "gateway", identity, requestId } })) return new Response("upgrade required", { status: 426 });
			return undefined;
		},
		websocket: {
			maxPayloadLength: MAX_CMUX_FRAME_BYTES,
			idleTimeout: 120,
			backpressureLimit: MAX_CMUX_FRAME_BYTES,
			closeOnBackpressureLimit: true,
			perMessageDeflate: false,
			open(socket) {
				if (socket.data.kind === "provider-control") return;
				if (socket.data.kind === "provider-stream") {
					const data = socket.data;
					data.transport = new ProviderWebSocketTransport(socket);
					void options.providerService!.runStream(data.transport, data.authority, data.abort.signal).catch(() => {
						if (!data.abort.signal.aborted) socket.close(1011, "provider stream failed");
					});
					return;
				}
				if (socket.data.kind === "cmux") {
					const data = socket.data;
					if (!authorize(data.identity, "runtime.connect.cmux", data.requestId, data.route.runtimeId)) {
						revokeCmux(data, 1008, "cmux route revoked");
						socket.close(1008, "cmux route revoked");
						return;
					}
					const current = options.projection.cmuxWebSocketRoute(data.route.runtimeId, data.identity.principalId, data.identity);
					if (!data.stream || !sameCmuxWebSocketRoute(current, data.route)) {
						revokeCmux(data, 1008, "cmux route revoked");
						socket.close(1008, "cmux route revoked");
						return;
					}
					data.bridge = new CmuxWebSocketBridge(data.stream, {
						sendText(value) {
							const accepted = socket.send(value);
							return socket.getBufferedAmount() > MAX_CMUX_FRAME_BYTES ? 0 : accepted;
						},
						close: (code, reason) => socket.close(code, reason),
					}, data.abort, () => {
						cmuxSockets.delete(data);
						releaseCmuxIngress(data);
					}, { onProtocolMismatch: () => recordCmuxProtocolMismatch(options.metrics) });
					options.metrics.increment("omperator_gateway_requests_total", { transport: "cmux", operation: "open", result: "success" });
					options.logger.info("connection opened", {
						request_id: data.requestId,
						runtime_ref: data.route.runtimeId,
						runtime_generation: data.route.generation,
						transport: "cmux",
						result: "success",
					});
					data.bridge.start();
					return;
				}
				socket.data.connection = options.gateway.connect({
					send(frame) {
						const accepted = socket.send(JSON.stringify(frame));
						const dropped = socket.getBufferedAmount() > GATEWAY_WEBSOCKET_LIMIT || accepted <= 0;
						recordBrowserStreamDrop(options.metrics, frame, dropped);
						if (dropped) socket.close(1013, "gateway backpressure");
					},
					close(code, reason) { socket.close(code, reason); },
				}, socket.data.identity, socket.data.requestId);
				options.metrics.increment("omperator_gateway_requests_total", { transport: "omp-app", operation: "open", result: "success" });
				options.logger.info("connection opened", { request_id: socket.data.requestId, transport: "omp-app", result: "success" });
			},
			message(socket, message) {
				if (socket.data.kind === "provider-control") {
					if ((typeof message === "string" ? Buffer.byteLength(message) : message.byteLength) > GATEWAY_WEBSOCKET_LIMIT) { socket.close(1009, "provider control frame too large"); return; }
					const input = typeof message === "string" ? Buffer.from(message) : new Uint8Array(message);
					void socket.data.control.session.receive(input).then(responses => {
						let totalBytes = 0;
						for (const response of responses) {
							if (response.byteLength > GATEWAY_WEBSOCKET_LIMIT - totalBytes) {
								socket.close(1013, "provider control backpressure");
								return;
							}
							totalBytes += response.byteLength;
						}
						if (socket.getBufferedAmount() > GATEWAY_WEBSOCKET_LIMIT - totalBytes) {
							socket.close(1013, "provider control backpressure");
							return;
						}
						for (const response of responses) {
							if (socket.send(response) <= 0) {
								socket.close(1013, "provider control backpressure");
								return;
							}
						}
					}).catch(() => socket.close(1003, "invalid provider control frame"));
					return;
				}
				if (socket.data.kind === "provider-stream") {
					if ((typeof message === "string" ? Buffer.byteLength(message) : message.byteLength) > GATEWAY_WEBSOCKET_LIMIT) { socket.close(1009, "provider stream frame too large"); return; }
					socket.data.transport?.receive(message);
					return;
				}
				if (socket.data.kind === "cmux") {
					if (!authorize(socket.data.identity, "runtime.connect.cmux", socket.data.requestId, socket.data.route.runtimeId)) {
						void revokeCmux(socket.data, 1008, "cmux route revoked");
						socket.close(1008, "cmux route revoked");
						return;
					}
					if (typeof message === "string") socket.data.bridge?.receiveText(message);
					else socket.data.bridge?.receiveBinary();
					return;
				}
				if ((typeof message === "string" ? Buffer.byteLength(message) : message.byteLength) > GATEWAY_WEBSOCKET_LIMIT) {
					socket.close(1009, "gateway message too large");
					return;
				}
				const input = typeof message === "string" ? message : new Uint8Array(message);
				void socket.data.connection?.receive(input).catch(() => {
					options.metrics.increment("omperator_gateway_requests_total", { transport: "omp-app", operation: "request", result: "error" });
					socket.close(1011, "gateway error");
				});
			},
			close(socket) {
				if (socket.data.kind === "provider-control") {
					void socket.data.control.close();
					return;
				}
				if (socket.data.kind === "provider-stream") {
					socket.data.abort.abort();
					socket.data.transport?.clientClosed();
					return;
				}
				if (socket.data.kind === "cmux") {
					cmuxSockets.delete(socket.data);
					releaseCmuxIngress(socket.data);
					void socket.data.bridge?.clientClosed();
					if (!socket.data.bridge) {
						socket.data.abort.abort();
						void socket.data.stream?.close();
					}
					return;
				}
				socket.data.connection?.close();
				socket.data.connection = undefined;
			},
		},
	});
	let stopping: Promise<void> | undefined;
	const drain = async (): Promise<void> => {
		if (stopping) return await stopping;
		draining = true;
		options.health.beginDrain();
		options.metrics.set("omperator_gateway_ready", 0);
		options.gateway.beginDrain();
		stopping = (async () => {
			unsubscribeCmux?.();
			const revocations = await Promise.allSettled([...cmuxSockets].map(data => revokeCmux(data, 1001, "cluster server draining")));
			await options.lifecycleEvents?.close?.();
			await gatewayServer.stop(false);
			options.health.markGatewayStopped();
			if (revocations.some(result => result.status === "rejected"))
				throw new Error("one or more cmux routes failed to drain");
		})();
		try {
			await stopping;
			options.metrics.increment("omperator_drain_total", { result: "success" });
			options.logger.info("gateway drain completed", { result: "success" });
		} catch (error) {
			options.metrics.increment("omperator_drain_total", { result: "error" });
			options.logger.error("gateway drain failed", { result: "error" });
			throw error;
		}
	};
	const adminHandler = createAdminHandler({ health: options.health, metrics: options.metrics });
	const adminServer = Bun.serve({
		hostname: "0.0.0.0",
		port: options.adminPort,
		async fetch(request, server) {
			if (new URL(request.url).pathname !== "/drainz") return adminHandler(request);
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const source = server.requestIP(request)?.address;
			if (!source || !isLoopbackAddress(source)) return new Response("forbidden", { status: 403 });
			await drain();
			return Response.json({ draining: true }, { status: 202, headers: { "cache-control": "no-store" } });
		},
	});
	options.health.markGatewayListening();
	options.metrics.set("omperator_gateway_ready", 1);
	options.logger.info("cluster server listening", { result: "success" });
	return {
		drain,
		async stop() {
			await drain();
			await adminServer.stop(true);
		},
	};
}
