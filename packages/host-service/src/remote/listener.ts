import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
	ListenerPeerContext,
	ListenerPlan,
	RemoteConnection,
	RemoteConnectionHooks,
	RemoteListenerConfig,
	RemotePeerIdentity,
} from "./types.ts";
// Remote bootstrap can burst multiple 4 MiB app frames. Bound the queue while
// leaving enough room for settings metadata and a transcript snapshot.
const DEFAULT_REMOTE_BACKPRESSURE_BYTES = 16 * 1024 * 1024;

export function normalizeIpAddress(address: string): string {
	return address.startsWith("::ffff:") && isIP(address) === 6 && isIP(address.slice(7)) === 4
		? address.slice(7)
		: address;
}
function ipv4(value: string): number[] | undefined {
	if (isIP(value) !== 4) return undefined;
	const parts = value.split(".").map(Number);
	return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
		? parts
		: undefined;
}
function ipv6(value: string): bigint | undefined {
	if (isIP(value) !== 6) return undefined;
	const pieces = value.split("::");
	if (pieces.length > 2) return undefined;
	const left = pieces[0] ? pieces[0].split(":") : [];
	const right = pieces[1] ? pieces[1].split(":") : [];
	const count = left.length + right.length;
	if ((!pieces[1] && count !== 8) || (pieces[1] && count >= 8)) return undefined;
	const words = [...left, ...Array(8 - count).fill("0"), ...right].map(piece => Number.parseInt(piece, 16));
	if (words.some(word => !Number.isInteger(word) || word < 0 || word > 0xffff)) return undefined;
	return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}
export function isTailnetAddress(address: string): boolean {
	const normalized = normalizeIpAddress(address);
	const v4 = ipv4(normalized);
	if (v4) return v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127;
	const v6 = ipv6(normalized);
	return v6 !== undefined && v6 >> 80n === 0xfd7a115ca1e0n;
}
export function createListenerPlan(config: RemoteListenerConfig): ListenerPlan {
	if (!isTailnetAddress(config.address) || normalizeIpAddress(config.address) !== config.address)
		throw new Error("direct listener address must be an explicit Tailscale address");
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
		throw new Error("listener port is invalid");
	return { mode: "direct", address: config.address, port: config.port, path: "/v1/ws", trustedServeProxy: false };
}
export function originAllowed(origin: string | null, allowlist: readonly string[] = []): boolean {
	return origin === null || allowlist.includes(origin);
}
export function createServeProxyPlan(config: RemoteListenerConfig): ListenerPlan {
	if (config.address !== "127.0.0.1" && config.address !== "::1") throw new Error("Serve proxy must bind loopback");
	if (config.trustedServeProxy !== true) throw new Error("Serve proxy requires trustedServeProxy");
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
		throw new Error("listener port is invalid");
	return { mode: "serve", address: config.address, port: config.port, path: "/v1/ws", trustedServeProxy: true };
}
export function resolveServePeer(
	remoteAddress: string,
	headers: Headers,
	trustedServeProxy: boolean,
): ListenerPeerContext | undefined {
	if (!trustedServeProxy || (remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")) return undefined;
	const nodeId = headers.get("Tailscale-Node-ID");
	const hostname = headers.get("Tailscale-Node-Name");
	const user = headers.get("Tailscale-User-Login");
	const address = headers.get("Tailscale-Client-IP");
	if (!nodeId || !hostname || !user || !address || !isTailnetAddress(address)) return undefined;
	return { address, source: "serve", identity: { nodeId, hostname, user, addresses: [address], source: "serve" } };
}
export function directPeer(address: string, nodeId: string): ListenerPeerContext {
	const normalized = normalizeIpAddress(address);
	if (!isTailnetAddress(normalized)) throw new Error("peer is not a Tailscale address");
	return { address: normalized, source: "direct", identity: { nodeId, addresses: [normalized], source: "direct" } };
}
type SocketData = { peer: ListenerPeerContext; connectionId: string; reserved: boolean; opened: boolean };
type SocketEntry = {
	ws: Bun.ServerWebSocket<SocketData>;
	connection: RemoteConnection;
	closed: boolean;
	disconnected: Promise<void>;
};
type RunState = {
	stopping: boolean;
	pending: number;
	sockets: Map<string, SocketEntry>;
	server?: Bun.Server<SocketData>;
};
type RemoteSocketLike = {
	readonly connectionId: string;
	readonly peer: ListenerPeerContext;
	closed: boolean;
	send(text: string): boolean;
	close(code?: number, reason?: string): void;
};
function immutablePeer(peer: ListenerPeerContext): ListenerPeerContext {
	const identity: RemotePeerIdentity = Object.freeze({
		...peer.identity,
		addresses: Object.freeze([...peer.identity.addresses]),
	});
	return Object.freeze({ ...peer, identity });
}

export class BunRemoteListener {
	#run?: RunState;
	constructor(
		private readonly plan: ListenerPlan,
		private readonly hooks: RemoteConnectionHooks,
		private readonly config: RemoteListenerConfig,
		private readonly resolver?: { resolve(address: string): Promise<RemotePeerIdentity> },
	) {}
	start(): void {
		if (this.#run) throw new Error("remote listener already started");
		const run: RunState = { stopping: false, pending: 0, sockets: new Map() };
		this.#run = run;
		const maxConnections = this.config.maxConnections ?? 32;
		const maxFrameBytes = this.config.maxFrameBytes ?? 1024 * 1024;
		run.server = Bun.serve<SocketData>({
			hostname: this.plan.address,
			port: this.plan.port,
			fetch: async (request, server) => {
				const url = new URL(request.url);
				if (url.pathname === "/healthz" && request.method === "GET") return Response.json({ ok: true });
				if (url.pathname !== this.plan.path) return new Response("Not Found", { status: 404 });
				if (!originAllowed(request.headers.get("origin"), this.config.originAllowlist))
					return new Response("Forbidden", { status: 403 });
				if (run.sockets.size + run.pending >= maxConnections) return new Response("Busy", { status: 503 });
				run.pending++;
				let upgraded = false;
				try {
					const requested = server.requestIP(request)?.address;
					if (!requested) return new Response("Unauthorized", { status: 401 });
					const address = normalizeIpAddress(requested);
					let peer: ListenerPeerContext | undefined;
					if (this.plan.mode === "direct") {
						if (!isTailnetAddress(address) || !this.resolver)
							return new Response("Unauthorized", { status: 401 });
						peer = { address, source: "direct", identity: await this.resolver.resolve(address) };
					} else {
						peer = resolveServePeer(address, request.headers, this.plan.trustedServeProxy);
						if (!peer) return new Response("Forbidden", { status: 403 });
					}
					const connectionId = randomUUID();
					if (
						!server.upgrade(request, {
							data: { peer: immutablePeer(peer), connectionId, reserved: true, opened: false },
						})
					)
						return new Response("Upgrade Required", { status: 426 });
					upgraded = true;
					return undefined;
				} catch {
					return new Response("Unauthorized", { status: 401 });
				} finally {
					if (!upgraded) run.pending--;
				}
			},
			websocket: {
				maxPayloadLength: maxFrameBytes,
				idleTimeout: this.config.idleTimeoutSeconds ?? 120,
				backpressureLimit: this.config.backpressureLimit ?? DEFAULT_REMOTE_BACKPRESSURE_BYTES,
				closeOnBackpressureLimit: true,
				perMessageDeflate: false,
				open: ws => {
					if (this.#run !== run || run.stopping) {
						ws.data.reserved = false;
						ws.close(1001, "listener stopping");
						return;
					}
					if (ws.data.reserved) {
						ws.data.reserved = false;
						run.pending--;
					}
					ws.data.opened = true;
					let entry!: SocketEntry;
					const socket: RemoteSocketLike = {
						connectionId: ws.data.connectionId,
						peer: ws.data.peer,
						closed: false,
						send: text => {
							if (socket.closed) return false;
							try {
								const result = ws.send(text);
								return typeof result === "number" ? result > 0 : true;
							} catch {
								return false;
							}
						},
						close: (code, reason) => {
							if (socket.closed) return;
							socket.closed = true;
							this.#finish(run, entry);
							try {
								ws.close(code, reason);
							} catch {}
						},
					};
					const connection = Object.freeze({ connectionId: socket.connectionId, peer: socket.peer, socket });
					entry = { ws, connection, closed: false, disconnected: Promise.resolve() };
					run.sockets.set(connection.connectionId, entry);
					try {
						const result = this.hooks.connected?.(connection);
						if (result) void result.catch(() => socket.close(1011, "hook failure"));
					} catch {
						socket.close(1011, "hook failure");
					}
				},
				message: (ws, message) => {
					const entry = run.sockets.get(ws.data.connectionId);
					if (this.#run !== run || run.stopping || !entry || entry.closed) return;
					try {
						const result = this.hooks.message?.(
							entry.connection,
							typeof message === "string" ? message : new Uint8Array(message),
						);
						if (result) void result.catch(() => entry.connection.socket.close(1011, "hook failure"));
					} catch {
						entry.connection.socket.close(1011, "hook failure");
					}
				},
				close: ws => {
					const entry = run.sockets.get(ws.data.connectionId);
					if (ws.data.reserved) {
						ws.data.reserved = false;
						run.pending--;
					}
					if (entry) this.#finish(run, entry);
				},
			},
		});
	}
	async stop(): Promise<void> {
		const run = this.#run;
		if (!run) return;
		run.stopping = true;
		const entries = [...run.sockets.values()];
		for (const entry of entries) entry.connection.socket.close(1001, "listener stopping");
		await Promise.allSettled(entries.map(entry => entry.disconnected));
		run.server?.stop(true);
		run.server = undefined;
		run.sockets.clear();
		run.pending = 0;
		if (this.#run === run) this.#run = undefined;
	}
	#finish(run: RunState, entry: SocketEntry): void {
		if (entry.closed) return;
		entry.closed = true;
		(entry.connection.socket as RemoteSocketLike).closed = true;
		run.sockets.delete(entry.connection.connectionId);
		try {
			entry.disconnected = Promise.resolve(this.hooks.disconnected?.(entry.connection)).catch(() => undefined);
		} catch {
			entry.disconnected = Promise.resolve();
		}
	}
}
