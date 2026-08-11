import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import { describe, expect, it } from "vite-plus/test";
import { startTerminalAttachBroker } from "../src/terminal-attach-broker.ts";
import { createTerminalAttachClient, type TerminalAttachConfig } from "../src/terminal-attach-client.ts";

const HOST = "pod:session-fixture";
const SESSION = "session-fixture";
const GENERATION = "gen_123456789012345678901234";

// This integration boundary uses real UDS/WebSocket events, so a wall-clock deadline
// turns a missing platform event into a focused failure instead of the suite timeout.
async function beforeDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); }),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

describe("terminal attach broker wire", () => {
	it("preserves exact omp-app/1 attach and deterministically reattaches at the saved cursor", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-attach-wire-"));
		const appserverPath = join(root, "private-appserver.sock");
		const attachPath = join(root, "attach.sock");
		const http = createServer();
		const server = new WebSocketServer({ server: http, path: "/ws", maxPayload: 1_048_576, perMessageDeflate: false });
		const frames: Array<Record<string, unknown>> = [];
		const reattached = Promise.withResolvers<void>();
		let connections = 0;
		let firstSocket: WebSocket | undefined;
		server.on("connection", socket => {
			connections += 1;
			firstSocket ??= socket;
			socket.on("message", raw => {
				const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
				frames.push(frame);
				if (frame.type === "hello") {
					socket.send(JSON.stringify({
						v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: HOST,
						ompVersion: "fixture", ompBuild: "fixture", appserverVersion: "fixture", appserverBuild: "fixture",
						epoch: "epoch-fixture", authentication: "local",
						grantedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control"],
						grantedFeatures: ["resume", "session.state"], negotiatedLimits: {}, resumed: false,
					}));
					return;
				}
				if (frame.type !== "command") return;
				const response = { v: "omp-app/1", type: "response", requestId: frame.requestId, commandId: frame.commandId, hostId: HOST, sessionId: SESSION, command: frame.command, ok: true };
				if (frame.command === "session.attach") {
					socket.send(JSON.stringify({ ...response, result: { attached: true, cursor: { epoch: "epoch-fixture", seq: 7 } } }));
					socket.send(JSON.stringify({ v: "omp-app/1", type: "snapshot", cursor: { epoch: "epoch-fixture", seq: 7 }, revision: "revision-fixture", hostId: HOST, sessionId: SESSION, entries: [] }));
					if (connections === 2) reattached.resolve();
				} else if (frame.command === "session.prompt") {
					socket.send(JSON.stringify({ ...response, result: { accepted: true } }));
				}
			});
		});
		const listening = Promise.withResolvers<void>();
		http.once("listening", listening.resolve);
		http.once("error", listening.reject);
		http.listen(appserverPath);
		await listening.promise;
		const broker = await startTerminalAttachBroker({ listenPath: attachPath, appserverPath, generation: GENERATION, hostId: HOST, sessionId: SESSION });
		const config: TerminalAttachConfig = { runtimeId: "runtime-fixture", generation: GENERATION, hostId: HOST, sessionId: SESSION, socketPath: attachPath, identityPath: join(root, "terminal-attach.json") };
		const client = createTerminalAttachClient(config);
		try {
			await client.connect();
			expect((await client.attach(HOST, SESSION)).ok).toBe(true);
			expect((await client.command({ hostId: HOST, sessionId: SESSION, command: "session.prompt", args: { message: "fixture prompt" } })).ok).toBe(true);
			firstSocket!.terminate();
			await beforeDeadline(reattached.promise, 3_000, "terminal attach client did not reconnect through the broker");
			expect({ connections, state: client.snapshot().state }).toEqual({ connections: 2, state: "ready" });
			expect(frames.filter(frame => frame.type === "hello")).toHaveLength(2);
			expect(frames.filter(frame => frame.command === "session.attach")).toHaveLength(2);
			expect(frames.filter(frame => frame.type === "hello")[1]).toMatchObject({ savedCursors: [{ hostId: HOST, sessionId: SESSION, cursor: { epoch: "epoch-fixture", seq: 7 } }] });
		} finally {
			await client.close();
			await broker.stop();
			for (const socket of server.clients) socket.terminate();
			server.clients.clear();
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			http.close();
			http.closeAllConnections();
			await rm(root, { recursive: true, force: true });
		}
	});
});
