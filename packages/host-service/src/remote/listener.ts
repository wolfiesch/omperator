import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type {
	HealthProvider,
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
export function createInternalListenerPlan(config: RemoteListenerConfig): ListenerPlan {
	if (config.address !== "0.0.0.0" && config.address !== "::")
		throw new Error("internal listener must bind an unspecified pod address");
	if (!config.internalPeerNodeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.internalPeerNodeId))
		throw new Error("internal listener peer id is invalid");
	if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
		throw new Error("listener port is invalid");
	return { mode: "direct", address: config.address, port: config.port, path: "/v1/ws", trustedServeProxy: false };
}
export function originAllowed(origin: string | null, allowlist: readonly string[] = []): boolean {
	return origin === null || allowlist.includes(origin);
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
		private readonly health?: HealthProvider,
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
				if (url.pathname === "/healthz" && request.method === "GET")
					return Response.json({
						...(this.health ? this.health() : { ok: true }),
					});
				if (url.pathname !== this.plan.path) return new Response("Not Found", { status: 404 });
				if (!originAllowed(request.headers.get("origin"), this.config.originAllowlist))
					return new Response("Forbidden", { status: 403 });
				if (run.sockets.size + run.pending >= maxConnections) return new Response("Busy", { status: 503 });
				run.pending++;
				let upgraded = false;
				try {
					const requested = server.requestIP(request)?.address;
					if (!requested) return new Response("Unauthorized", { status: 401 });
					// Pod-network (cluster) listeners carry a fixed peer identity
					// authenticated by the cluster's dedicated policy. No other
					// remote listener mode exists.
					if (!this.config.internalPeerNodeId)
						return new Response("Unauthorized", { status: 401 });
					const peer: ListenerPeerContext = {
						address: normalizeIpAddress(requested),
						source: "direct",
						identity: {
							nodeId: this.config.internalPeerNodeId,
							addresses: [normalizeIpAddress(requested)],
							source: "direct",
						},
					};
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
