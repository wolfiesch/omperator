import { createServer, type Server } from "node:http";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { startTerminalAttachBroker, type TerminalAttachBrokerHandle } from "../src/terminal-attach-broker.ts";

const HOST = "pod:session-fixture";
const SESSION = "session-fixture";
const GENERATION = "gen_123456789012345678901234";
const roots: string[] = [];

interface BrokerFixture {
	readonly broker: TerminalAttachBrokerHandle;
	readonly attachPath: string;
	readonly server: WebSocketServer;
	readonly http: Server;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function hello(capabilities = ["sessions.read", "sessions.prompt", "sessions.control"]): Record<string, unknown> {
	return {
		v: "omp-app/1", type: "hello", protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "hostile-fixture", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["resume", "session.state"], capabilities: { client: capabilities }, savedCursors: [],
	};
}

async function fixture(): Promise<BrokerFixture> {
	const root = await mkdtemp(join(tmpdir(), "t4-attach-policy-"));
	roots.push(root);
	const appserverPath = join(root, "private.sock");
	const attachPath = join(root, "attach.sock");
	const http = createServer();
	const server = new WebSocketServer({ server: http, path: "/ws", perMessageDeflate: false });
	const listening = Promise.withResolvers<void>();
	http.once("listening", listening.resolve);
	http.once("error", listening.reject);
	http.listen(appserverPath);
	await listening.promise;
	const broker = await startTerminalAttachBroker({ listenPath: attachPath, appserverPath, generation: GENERATION, hostId: HOST, sessionId: SESSION });
	return { broker, attachPath, server, http };
}

async function closeFixture(value: BrokerFixture): Promise<void> {
	await value.broker.stop();
	for (const socket of value.server.clients) socket.terminate();
	value.server.clients.clear();
	await new Promise<void>((resolve, reject) => value.server.close(error => error ? reject(error) : resolve()));
	value.http.close();
	value.http.closeAllConnections();
}

describe("terminal attach broker policy", () => {
	it("publishes only the group-scoped shell-principal socket", async () => {
		const value = await fixture();
		try {
			const stat = await lstat(value.attachPath);
			expect(stat.isSocket()).toBe(true);
			expect(stat.mode & 0o777).toBe(0o660);
		} finally { await closeFixture(value); }
	});

	it("rejects a stale generation before WebSocket upgrade", async () => {
		const value = await fixture();
		try {
			const socket = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": "gen_000000000000000000000000" } });
			const closed = new Promise<void>(resolve => socket.once("close", () => resolve()));
			const error = await new Promise<Error>(resolve => {
				let first = true;
				socket.on("error", value => {
					if (first) {
						first = false;
						resolve(value);
					}
				});
			});
			expect(error.message).toMatch(/403|Connection ended/);
			await closed;
			expect(socket.readyState).toBe(WebSocket.CLOSED);
		} finally { await closeFixture(value); }
	});

	it("rejects an over-capability hello without opening the authority socket", async () => {
		const value = await fixture();
		let authorityConnections = 0;
		value.server.on("connection", () => { authorityConnections += 1; });
		try {
			for (const forbidden of ["sessions.manage", "agents.control"]) {
				const socket = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": GENERATION } });
				await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
				socket.send(JSON.stringify(hello(["sessions.read", forbidden])));
				const code = await new Promise<number>(resolve => socket.once("close", resolve));
				expect(code).toBe(1008);
			}
			expect(authorityConnections).toBe(0);
		} finally { await closeFixture(value); }
	});
	it("rejects an authority operation even when it names the pinned session", async () => {
		const value = await fixture();
		const authorityFrames: Array<Record<string, unknown>> = [];
		value.server.on("connection", socket => socket.on("message", raw => {
			const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			authorityFrames.push(frame);
			if (frame.type === "hello") socket.send(JSON.stringify({ v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: HOST, ompVersion: "fixture", ompBuild: "fixture", appserverVersion: "fixture", appserverBuild: "fixture", epoch: "fixture", authentication: "local", grantedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control"], grantedFeatures: ["resume", "session.state"], negotiatedLimits: {}, resumed: false }));
		}));
		try {
			const socket = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": GENERATION } });
			await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
			socket.send(JSON.stringify(hello()));
			await new Promise<void>(resolve => socket.once("message", () => resolve()));
			socket.send(JSON.stringify({ v: "omp-app/1", type: "command", requestId: "request-delete", commandId: "command-delete", hostId: HOST, sessionId: SESSION, command: "session.delete", args: {} }));
			expect(await new Promise<number>(resolve => socket.once("close", resolve))).toBe(1008);
			expect(authorityFrames.filter(frame => frame.type === "command")).toEqual([]);
		} finally { await closeFixture(value); }
	});


	it("pins every command to the broker's one session", async () => {
		const value = await fixture();
		const authorityFrames: Array<Record<string, unknown>> = [];
		value.server.on("connection", socket => socket.on("message", raw => {
			const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
			authorityFrames.push(frame);
			if (frame.type === "hello") socket.send(JSON.stringify({ v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: HOST, ompVersion: "fixture", ompBuild: "fixture", appserverVersion: "fixture", appserverBuild: "fixture", epoch: "fixture", authentication: "local", grantedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control"], grantedFeatures: ["resume", "session.state"], negotiatedLimits: {}, resumed: false }));
		}));
		try {
			const socket = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": GENERATION } });
			await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
			socket.send(JSON.stringify(hello()));
			await new Promise<void>(resolve => socket.once("message", () => resolve()));
			expect(value.broker.activity()).toEqual({ terminalConnections: 1, terminalLeases: 1 });
			socket.send(JSON.stringify({ v: "omp-app/1", type: "command", requestId: "request-1", commandId: "command-1", hostId: HOST, sessionId: "another-session", command: "session.prompt", args: { message: "escape" } }));
			const code = await new Promise<number>(resolve => socket.once("close", resolve));
			expect(code).toBe(1008);
			expect(value.broker.activity()).toEqual({ terminalConnections: 0, terminalLeases: 0 });
			expect(authorityFrames.filter(frame => frame.type === "command")).toEqual([]);
		} finally { await closeFixture(value); }
	});
	it("rejects attaches while drain is gated and reopens only on rollback", async () => {
		const value = await fixture();
		try {
			value.broker.beginDrain();
			const rejected = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": GENERATION } });
			const error = await new Promise<Error>(resolve => rejected.on("error", resolve));
			expect(error.message).toMatch(/503|Connection ended/);
			value.broker.rollbackDrain();
			const accepted = new WebSocket(`ws+unix://${value.attachPath}:/ws`, { headers: { "x-t4-runtime-generation": GENERATION } });
			accepted.on("error", () => undefined);
			await new Promise<void>((resolve, reject) => { accepted.once("open", resolve); accepted.once("error", reject); });
			accepted.terminate();
		} finally { await closeFixture(value); }
	});
});
