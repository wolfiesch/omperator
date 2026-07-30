import { createServer } from "node:http";
import { chmod, unlink } from "node:fs/promises";
import type { Socket } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

const PROTOCOL = "omp-app/1";
const MAX_FRAME_BYTES = 1_048_576;
const MAX_BUFFERED_BYTES = 1_048_576;
const TERMINAL_CAPABILITIES: Readonly<Record<string, true>> = {
	"sessions.read": true,
	"sessions.prompt": true,
	"sessions.control": true,
};
const TERMINAL_FEATURES: Readonly<Record<string, true>> = { resume: true, "session.state": true };
const TERMINAL_COMMANDS: Readonly<Record<string, true>> = {
	"session.state.get": true,
	"session.attach": true,
	"session.prompt": true,
	"session.steer": true,
	"session.followUp": true,
	"session.cancel": true,
};

export interface TerminalAttachBrokerOptions {
	readonly listenPath: string;
	readonly appserverPath: string;
	readonly generation: string;
	readonly hostId: string;
	readonly sessionId: string;
}

export interface TerminalAttachBrokerHandle {
	readonly socketPath: string;
	stop(): Promise<void>;
	activity(): Readonly<{ terminalConnections: number; terminalLeases: number }>;
	beginDrain(): void;
	rollbackDrain(): void;
	quiesce(): Promise<void>;

}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactStrings(value: unknown, allowed: Readonly<Record<string, true>>): boolean {
	return Array.isArray(value) && value.every(item => typeof item === "string" && allowed[item] === true) && new Set(value).size === value.length;
}

function pinnedTarget(frame: Record<string, unknown>, options: TerminalAttachBrokerOptions): boolean {
	return frame.hostId === options.hostId && frame.sessionId === options.sessionId;
}

function validHello(frame: Record<string, unknown>, options: TerminalAttachBrokerOptions): boolean {
	const protocol = record(frame.protocol);
	const capabilities = record(frame.capabilities);
	if (frame.v !== PROTOCOL || frame.type !== "hello" || protocol?.min !== PROTOCOL || protocol.max !== PROTOCOL) return false;
	if (!exactStrings(frame.requestedFeatures, TERMINAL_FEATURES) || !exactStrings(capabilities?.client, TERMINAL_CAPABILITIES)) return false;
	if (frame.authentication !== undefined || !Array.isArray(frame.savedCursors)) return false;
	return frame.savedCursors.every(value => {
		const cursor = record(value);
		return cursor !== undefined && cursor.hostId === options.hostId && cursor.sessionId === options.sessionId;
	});
}

function validClientFrame(frame: Record<string, unknown>, options: TerminalAttachBrokerOptions): boolean {
	if (frame.v !== PROTOCOL) return false;
	if (frame.type === "command") return pinnedTarget(frame, options) && typeof frame.command === "string" && TERMINAL_COMMANDS[frame.command] === true;
	if (frame.type === "confirm") return pinnedTarget(frame, options) && (frame.decision === "approve" || frame.decision === "deny");
	if (frame.type === "ack") return pinnedTarget(frame, options);
	return false;
}


function sendBounded(socket: WebSocket, body: string | Buffer): void {
	if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer.byteLength(body) > MAX_BUFFERED_BYTES) {
		socket.close(1009, "terminal attach backpressure limit exceeded");
		return;
	}
	socket.send(body);
}

export async function startTerminalAttachBroker(options: TerminalAttachBrokerOptions): Promise<TerminalAttachBrokerHandle> {
	await unlink(options.listenPath).catch(error => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
	const server = createServer();
	const downstreamServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
	const connections = new Set<Socket>();
	const leased = new Set<WebSocket>();
	let draining = false;

	server.on("connection", socket => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
	});
	server.on("upgrade", (request, socket, head) => {
		const generationHeader = request.headers["x-t4-runtime-generation"];
		if (draining || request.url !== "/ws" || typeof generationHeader !== "string" || generationHeader !== options.generation) {
			socket.end(`HTTP/1.1 ${draining ? "503 Service Unavailable" : "403 Forbidden"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
			return;
		}
		downstreamServer.handleUpgrade(request, socket, head, client => downstreamServer.emit("connection", client, request));
	});
	downstreamServer.on("connection", downstream => {
		let upstream: WebSocket | undefined;
		let acceptedHello = false;
		const reject = (reason: string): void => {
			downstream.close(1008, reason);
			upstream?.terminate();
		};
		downstream.on("message", raw => {
			const body = raw.toString("utf8");
			let frame: Record<string, unknown> | undefined;
			try { frame = record(JSON.parse(body)); } catch { /* rejected below */ }
			if (!frame) return reject("invalid terminal attach frame");
			if (!acceptedHello) {
				if (!validHello(frame, options)) return reject("terminal attach hello exceeds its policy");
				acceptedHello = true;
				leased.add(downstream);

				upstream = new WebSocket(`ws+unix://${options.appserverPath}:/ws`, { followRedirects: false, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });
				upstream.once("open", () => sendBounded(upstream!, body));
				upstream.on("message", value => sendBounded(downstream, Buffer.from(value as Buffer)));
				upstream.on("close", (code, reason) => {
					if (code === 1006) downstream.terminate();
					else downstream.close(code, reason.toString("utf8"));
				});
				upstream.on("error", () => downstream.close(1011, "terminal attach authority unavailable"));
				return;
			}
			if (!validClientFrame(frame, options)) return reject("terminal attach operation exceeds its policy");
			if (!upstream || upstream.readyState !== WebSocket.OPEN) return reject("terminal attach authority unavailable");
			sendBounded(upstream, body);
		});
		downstream.on("close", () => { leased.delete(downstream); upstream?.terminate(); });
		downstream.on("error", () => upstream?.terminate());
	});
	const listening = Promise.withResolvers<void>();
	server.once("listening", listening.resolve);
	server.once("error", listening.reject);
	server.listen(options.listenPath);
	await listening.promise;
	await chmod(options.listenPath, 0o660);
	let stopPromise: Promise<void> | undefined;
	return {
		socketPath: options.listenPath,
		activity: () => ({ terminalConnections: downstreamServer.clients.size, terminalLeases: leased.size }),
		beginDrain(): void { draining = true; },
		rollbackDrain(): void { draining = false; },
		async quiesce(): Promise<void> {
			for (const client of downstreamServer.clients) client.terminate();
			downstreamServer.clients.clear();
			for (const connection of connections) connection.destroy();
			await Promise.resolve();
		},
		stop(): Promise<void> {
			stopPromise ??= (async () => {
				server.close();
				server.closeAllConnections();
				for (const client of downstreamServer.clients) client.terminate();
				// Bun's ws compatibility layer does not always remove terminated UDS peers
				// from the public client registry, which otherwise makes close() wait forever.
				downstreamServer.clients.clear();
				const downstreamClosed = new Promise<void>((resolve, reject) => downstreamServer.close(error => error ? reject(error) : resolve()));
				for (const connection of connections) connection.destroy();
				await downstreamClosed;
				await unlink(options.listenPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
			})();
			return stopPromise;
		},
	};
}
