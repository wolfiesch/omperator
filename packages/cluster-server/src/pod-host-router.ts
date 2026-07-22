import {
	DEVICE_CAPABILITIES,
	PROTOCOL_FEATURES,
	decodeServerFrame,
	parseBounded,
	type ClientFrame,
	type HostId,
	type ServerFrame,
} from "@t4-code/host-wire";
import { readClusterIdentityToken } from "./config.ts";

export interface PodHostEndpoint {
	readonly clusterSessionId: string;
	readonly url: string;
}
export interface PodHostRoute extends PodHostEndpoint {
	readonly upstreamSessionId: string;
}
export interface PodHostConnection {
	readonly hostId?: string;
	send(frame: ClientFrame): void;
	close(code?: number, reason?: string): void;
}
export interface PodHostConnector {
	connect(endpoint: PodHostEndpoint, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection>;
}
export interface WebSocketPodHostConnectorOptions {
	readonly identityTokenFile: string;
	readonly openTimeoutMs?: number;
	readonly keepAliveMs?: number;
	readonly webSocketFactory?: (url: string) => WebSocket;
}

export class WebSocketPodHostConnector implements PodHostConnector {
	readonly #identityTokenFile: string;
	readonly #timeoutMs: number;
	readonly #factory: (url: string) => WebSocket;
	readonly #keepAliveMs: number;
	constructor(options: WebSocketPodHostConnectorOptions) {
		this.#identityTokenFile = options.identityTokenFile;
		this.#timeoutMs = options.openTimeoutMs ?? 10_000;
		this.#keepAliveMs = options.keepAliveMs ?? 30_000;
		if (!Number.isSafeInteger(this.#keepAliveMs) || this.#keepAliveMs < 10 || this.#keepAliveMs > 60_000)
			throw new Error("pod host keepalive interval is invalid");
		this.#factory = options.webSocketFactory ?? (url => new WebSocket(url));
	}
	connect(endpoint: PodHostEndpoint, onFrame: (frame: ServerFrame) => void, onClose?: () => void): Promise<PodHostConnection> {
		if (!endpoint.url.startsWith("ws://") && !endpoint.url.startsWith("wss://")) return Promise.reject(new Error("pod host URL is invalid"));
		const socket = this.#factory(endpoint.url);
		return new Promise((resolve, reject) => {
			let settled = false;
			let upstreamHostId: string | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			let heartbeatNonce: string | undefined;
			const timer = setTimeout(() => {
				if (!settled) { settled = true; socket.close(1013, "upstream timeout"); reject(new Error("pod host handshake timed out")); }
			}, this.#timeoutMs);
			socket.addEventListener("open", () => {
				void readClusterIdentityToken(this.#identityTokenFile).then(token => {
					if (settled) return;
					socket.send(JSON.stringify({
						v: "omp-app/1", type: "hello",
						protocol: { min: "omp-app/1", max: "omp-app/1" },
						client: { name: "cluster-server", version: "0.1.31", build: "cluster", platform: "linux" },
						requestedFeatures: PROTOCOL_FEATURES.filter(feature => feature !== "cluster.operator"),
						savedCursors: [],
						capabilities: { client: DEVICE_CAPABILITIES.filter(capability => capability !== "ci.trigger") },
						authentication: { deviceId: "cluster-server", deviceToken: token },
					}));
				}, () => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					socket.close(1011, "identity unavailable");
					reject(new Error("pod host identity is unavailable"));
				});
			});
			socket.addEventListener("message", event => {
				try {
					const frame = decodeServerFrame(parseBounded(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer)));
					if (frame.type === "welcome") {
						if (settled) throw new Error("duplicate pod host welcome");
						if (frame.authentication !== "paired") throw new Error("pod host authentication failed");
						upstreamHostId = frame.hostId;
						settled = true;
						clearTimeout(timer);
						heartbeat = setInterval(() => {
							if (socket.readyState !== WebSocket.OPEN) return;
							heartbeatNonce = `cluster-${Date.now().toString(36)}`;
							try { socket.send(JSON.stringify({ v: "omp-app/1", type: "ping", nonce: heartbeatNonce, timestamp: new Date().toISOString() })); }
							catch { socket.close(1011, "upstream keepalive failed"); }
						}, this.#keepAliveMs);
						resolve({
							get hostId() { return upstreamHostId; },
							send: value => {
								if (socket.readyState !== WebSocket.OPEN) throw new Error("pod host connection is closed");
								socket.send(JSON.stringify(value));
							},
							close: (code, reason) => {
								clearInterval(heartbeat);
								socket.close(code, reason);
							},
						});
						return;
					}
					if (!settled) throw new Error("pod host frame arrived before welcome");
					if (frame.type === "pong" && frame.nonce === heartbeatNonce) return;
					onFrame(frame);
				} catch (error) {
					if (!settled) {
						settled = true;
						clearTimeout(timer);
						socket.close(1002, "invalid upstream frame");
						reject(error);
					} else socket.close(1002, "invalid upstream frame");
				}
			});
			socket.addEventListener("error", () => {
				if (!settled) { settled = true; clearTimeout(timer); reject(new Error("pod host connection failed")); }
			});
			socket.addEventListener("close", () => {
				clearInterval(heartbeat);
				if (!settled) { settled = true; clearTimeout(timer); reject(new Error("pod host connection closed")); }
				else onClose?.();
			});
		});
	}
}

/** Only app-wire address fields are translated; opaque ids and payload values remain byte-semantically unchanged. */
export function rewriteClientAddress(
	frame: ClientFrame,
	route: PodHostRoute,
	upstreamHostId: string,
): ClientFrame {
	if (!("hostId" in frame)) return frame;
	return {
		...frame,
		hostId: upstreamHostId as HostId,
		...(frame.sessionId === undefined ? {} : { sessionId: route.upstreamSessionId }),
	} as ClientFrame;
}

function rewriteEntry(entry: Record<string, unknown>, clusterHostId: string, clusterSessionId: string): Record<string, unknown> {
	return { ...entry, hostId: clusterHostId, sessionId: clusterSessionId };
}
export function rewriteServerAddress(
	frame: ServerFrame,
	route: PodHostRoute,
	clusterHostId: string,
): ServerFrame {
	let output: Record<string, unknown> = { ...frame };
	if ("hostId" in output) output.hostId = clusterHostId;
	if ("sessionId" in output) output.sessionId = route.clusterSessionId;
	if (frame.type === "entry") output.entry = rewriteEntry(frame.entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId);
	if (frame.type === "snapshot") output.entries = frame.entries.map(entry => rewriteEntry(entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId));
	if (frame.type === "agent.transcript") output.entries = frame.entries.map(entry => rewriteEntry(entry as unknown as Record<string, unknown>, clusterHostId, route.clusterSessionId));
	if (frame.type === "session.delta" && frame.upsert) output.upsert = { ...frame.upsert, hostId: clusterHostId, sessionId: route.clusterSessionId };
	if (frame.type === "session.delta" && frame.remove) output.remove = route.clusterSessionId;
	if (frame.type === "sessions") output.sessions = frame.sessions.map(ref => ({ ...ref, hostId: clusterHostId, sessionId: route.clusterSessionId }));
	return output as unknown as ServerFrame;
}
