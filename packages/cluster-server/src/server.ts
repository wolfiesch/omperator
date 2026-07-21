import { BlockList, isIP } from "node:net";
import { normalizeIpAddress } from "@t4-code/host-service";
import type { GatewayConnection, ClusterGateway } from "./gateway.ts";
import { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import { ClusterMetrics, ClusterServerHealth, JsonLogger, createAdminHandler } from "./observability.ts";

interface SocketData { connection?: GatewayConnection; principal: string; }
export interface ClusterHttpServersOptions {
	readonly gateway: ClusterGateway;
	readonly projection: ClusterInfrastructureProjection;
	readonly gatewayPort: number;
	readonly adminPort: number;
	readonly trustedProxyAddresses?: readonly string[];
	readonly trustedProxyCidrs?: readonly string[];
	readonly health: ClusterServerHealth;
	readonly metrics: ClusterMetrics;
	readonly logger: JsonLogger;
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

export function isLoopbackAddress(address: string): boolean {
	const normalized = normalizeIpAddress(address);
	if (normalized === "::1") return true;
	if (isIP(normalized) !== 4) return false;
	const firstOctet = Number(normalized.split(".", 1)[0]);
	return firstOctet === 127;
}

function gatewayPrincipal(request: Request, remoteAddress: string, trustedSource: (address: string) => boolean): string | undefined {
	if (!trustedSource(remoteAddress)) return undefined;
	if (request.headers.get("x-forwarded-proto") !== "https") return undefined;
	const principal = request.headers.get("tailscale-user-login") ?? request.headers.get("tailscale-user-name");
	if (!principal || principal !== principal.trim() || new TextEncoder().encode(principal).byteLength > 256 || /\p{Cc}/u.test(principal)) return undefined;
	return principal;
}

export function startClusterHttpServers(options: ClusterHttpServersOptions): ClusterHttpServers {
	let draining = false;
	const trustedSource = trustedProxyMatcher(options.trustedProxyAddresses ?? [], options.trustedProxyCidrs ?? []);
	const gatewayServer = Bun.serve<SocketData>({
		hostname: "0.0.0.0",
		port: options.gatewayPort,
		fetch(request, server) {
			const url = new URL(request.url);
			if (url.pathname !== "/v1/ws") return new Response("not found", { status: 404 });
			if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
			if (draining) return new Response("draining", { status: 503 });
			const remoteAddress = server.requestIP(request)?.address;
			if (!remoteAddress) return new Response("authenticated proxy required", { status: 401 });
			const principal = gatewayPrincipal(request, remoteAddress, trustedSource);
			if (!principal) return new Response("authenticated Tailscale proxy identity required", { status: 401 });
			const origin = request.headers.get("origin");
			if (origin && !options.projection.allowedOrigins().includes(origin)) return new Response("forbidden", { status: 403 });
			if (!server.upgrade(request, { data: { principal } })) return new Response("upgrade required", { status: 426 });
			return undefined;
		},
		websocket: {
			maxPayloadLength: 1_048_576,
			idleTimeout: 120,
			backpressureLimit: 1_048_576,
			closeOnBackpressureLimit: true,
			perMessageDeflate: false,
			open(socket) {
				socket.data.connection = options.gateway.connect({
					send(frame) {
						const accepted = socket.send(JSON.stringify(frame));
						if (accepted <= 0) socket.close(1013, "gateway backpressure");
					},
					close(code, reason) { socket.close(code, reason); },
				}, socket.data.principal);
				options.metrics.set("t4_cluster_gateway_connections", options.gateway.connectionCount);
			},
			message(socket, message) {
				const input = typeof message === "string" ? message : new Uint8Array(message);
				void socket.data.connection?.receive(input).catch(() => socket.close(1011, "gateway error"));
			},
			close(socket) {
				socket.data.connection?.close();
				socket.data.connection = undefined;
				options.metrics.set("t4_cluster_gateway_connections", options.gateway.connectionCount);
			},
		},
	});
	let stopping: Promise<void> | undefined;
	const drain = async (): Promise<void> => {
		if (stopping) return await stopping;
		draining = true;
		options.health.beginDrain();
		options.gateway.beginDrain();
		stopping = gatewayServer.stop(false).then(() => undefined);
		options.logger.info("gateway drain started", { result: "success" });
		await stopping;
		options.health.markGatewayStopped();
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
	options.logger.info("cluster server listening", { result: "success" });
	return {
		drain,
		async stop() {
			await drain();
			await adminServer.stop(true);
		},
	};
}
