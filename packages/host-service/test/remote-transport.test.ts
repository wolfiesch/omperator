import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, projectId, sessionId } from "@t4-code/host-wire";
import type { DesktopOperationsAuthority } from "../src/operations/dispatcher.ts";
import { BunRemoteListener, createInternalListenerPlan } from "../src/remote/listener.ts";

import type {
	ListenerPeerContext,
	RemoteConnection,
	RemoteConnectionHooks,
	RemotePeerIdentity,
} from "../src/remote/types.ts";
import { createAppserver } from "../src/server.ts";
import type { AppserverOptions, ChildHandle, RpcChildFactory, SessionRecord } from "../src/types.ts";

type FakeClose = { code?: number; reason?: string };
type FakeSocketData = { peer: ListenerPeerContext; connectionId: string; reserved: boolean; opened: boolean };
type FakeWebSocket = {
	data: FakeSocketData;
	sends: string[];
	closes: FakeClose[];
	sendResult: number;
	send(text: string): number;
	close(code?: number, reason?: string): void;
};
type FakeServeConfig = {
	unix?: string;
	hostname?: string;
	fetch?: (request: Request, server: FakeBunServer) => Response | undefined | Promise<Response | undefined>;
	websocket?: {
		backpressureLimit?: number;
		closeOnBackpressureLimit?: boolean;
		open?(socket: FakeWebSocket): void;
		message?(socket: FakeWebSocket, message: string | Uint8Array): void;
		close?(socket: FakeWebSocket): void;
	};
};
class FakeBunServer {
	readonly config: FakeServeConfig;
	readonly stopCalls: boolean[] = [];
	requestAddress = "100.64.0.1";
	lastUpgrade?: { data: FakeSocketData };
	constructor(config: FakeServeConfig) {
		this.config = config;
	}
	requestIP(): { address: string } {
		return { address: this.requestAddress };
	}
	upgrade(_request: Request, options: { data: FakeSocketData }): boolean {
		this.lastUpgrade = options;
		return true;
	}
	stop(force?: boolean): void {
		this.stopCalls.push(force === true);
	}
}
class FakeBunHarness {
	readonly servers: FakeBunServer[] = [];
	readonly original = (Bun as unknown as { serve: (config: unknown) => unknown }).serve;
	install(): void {
		const api = Bun as unknown as { serve: (config: unknown) => unknown };
		api.serve = (unknownConfig: unknown): unknown => {
			const config = unknownConfig as FakeServeConfig;
			if (config.unix) writeFileSync(config.unix, "");
			const server = new FakeBunServer(config);
			this.servers.push(server);
			return server;
		};
	}
	restore(): void {
		(Bun as unknown as { serve: (config: unknown) => unknown }).serve = this.original;
	}
	remote(): FakeBunServer {
		const server = this.servers.find(candidate => candidate.config.hostname !== undefined);
		if (!server) throw new Error("remote fake server missing");
		return server;
	}
	local(): FakeBunServer {
		const server = this.servers.find(candidate => candidate.config.unix !== undefined);
		if (!server) throw new Error("local fake server missing");
		return server;
	}
}
class FakeSocket implements FakeWebSocket {
	data!: FakeSocketData;
	sends: string[] = [];
	closes: FakeClose[] = [];
	sendResult = 1;
	send(text: string): number {
		this.sends.push(text);
		return this.sendResult;
	}
	close(code?: number, reason?: string): void {
		this.closes.push({ code, reason });
	}
}
class LeaseChild implements ChildHandle {
	readonly writes: string[] = [];
	readonly #exit = Promise.withResolvers<number>();
	readonly exited = this.#exit.promise;
	readonly #lines: string[] = [];
	readonly #lineWaiters: Array<{ resolve: (line: string | undefined) => void }> = [];
	readonly #writeWaiters: Array<{ count: number; resolve: () => void }> = [];
	readonly stdin = {
		write: (data: string) => {
			this.writes.push(data);
			for (const waiter of this.#writeWaiters.splice(0)) {
				if (this.writes.length >= waiter.count) waiter.resolve();
				else this.#writeWaiters.push(waiter);
			}
		},
	};
	readonly stdout: AsyncIterable<string> = this.stream();
	readonly stderr: AsyncIterable<string> = (async function* () {})();
	async *stream(): AsyncGenerator<string> {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		while (true) {
			const line = this.#lines.shift() ?? (await this.nextLine());
			if (line === undefined) return;
			yield line;
		}
	}
	private nextLine(): Promise<string | undefined> {
		const waiter = Promise.withResolvers<string | undefined>();
		this.#lineWaiters.push(waiter);
		return waiter.promise;
	}
	push(value: Record<string, unknown>): void {
		const line = `${JSON.stringify(value)}\n`;
		const waiter = this.#lineWaiters.shift();
		if (waiter) waiter.resolve(line);
		else this.#lines.push(line);
	}
	kill(): void {
		this.#lineWaiters.shift()?.resolve(undefined);
		this.#exit.resolve(0);
	}
	async waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return;
		const waiter = Promise.withResolvers<void>();
		this.#writeWaiters.push({ count, resolve: waiter.resolve });
		await waiter.promise;
	}
}
class LeaseFactory implements RpcChildFactory {
	readonly children: LeaseChild[] = [];
	readonly #spawned = Promise.withResolvers<LeaseChild>();
	spawn(): ChildHandle {
		const child = new LeaseChild();
		this.children.push(child);
		this.#spawned.resolve(child);
		return child;
	}
	argv(path: string): string[] {
		return ["fake-omp", "--mode", "rpc", "--session", path];
	}
	child(): Promise<LeaseChild> {
		return Promise.resolve(this.children[0] ?? this.#spawned.promise);
	}
}
function leaseSessionRecord(): SessionRecord {
	return {
		sessionId: sessionId("session"),
		path: "/tmp/session.jsonl",
		cwd: "/tmp",
		projectId: projectId("project"),
		title: "Session",
		updatedAt: "2026-01-01T00:00:00.000Z",
		status: "idle",
		entries: [],
	};
}
function sentFrames(socket: FakeSocket): Array<Record<string, unknown>> {
	return socket.sends.map(text => JSON.parse(text) as Record<string, unknown>);
}
function hello(requestedFeatures: string[] = ["resume"], requestedCapabilities?: string[]): string {
	return JSON.stringify({
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "test", version: "1", build: "b", platform: "linux" },
		requestedFeatures,
		savedCursors: [],
		...(requestedCapabilities === undefined ? {} : { capabilities: { client: requestedCapabilities } }),
	});
}
function listCommand(requestId: string): string {
	return JSON.stringify({
		v: "omp-app/1",
		type: "command",
		requestId,
		commandId: `command-${requestId}`,
		hostId: "host",
		command: "session.list",
		args: {},
	});
}
function ping(): string {
	return JSON.stringify({ v: "omp-app/1", type: "ping", nonce: "nonce", timestamp: "2026-01-01T00:00:00.000Z" });
}

async function flush(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}
async function openRemote(server: FakeBunServer): Promise<FakeSocket> {
	if (!server.config.fetch || !server.config.websocket?.open) throw new Error("remote config incomplete");
	await server.config.fetch(new Request("http://remote.test/v1/ws"), server);
	const socket = new FakeSocket();
	const upgrade = server.lastUpgrade;
	if (!upgrade) throw new Error("remote upgrade missing");
	socket.data = upgrade.data;
	server.config.websocket.open(socket);
	return socket;
}
function operations(methods: Partial<Record<keyof DesktopOperationsAuthority, true>> = {}): DesktopOperationsAuthority {
	const authority: DesktopOperationsAuthority = {};
	for (const method of Object.keys(methods) as (keyof DesktopOperationsAuthority)[]) {
		const value = methods[method];
		if (value === true) authority[method] = async () => ({}) as never;
	}
	return authority;
}

async function grantedFeatures(options: AppserverOptions): Promise<string[]> {
	const harness = new FakeBunHarness();
	harness.install();
	try {
		const appserver = createAppserver(options);
		await appserver.start();
		const local = harness.local();
		const socket = new FakeSocket();
		local.config.websocket?.open?.(socket);
		await local.config.websocket?.message?.(
			socket,
			hello([
				"resume",
				"catalog.metadata",
				"settings.metadata",
				"terminal.io",
				"files.list",
				"files.diff",
				"preview.control",
			]),
		);
		await flush();
		const welcome = JSON.parse(socket.sends[0] ?? "{}") as { grantedFeatures?: unknown };
		const features = welcome.grantedFeatures;
		if (!Array.isArray(features) || !features.every((feature): feature is string => typeof feature === "string"))
			throw new Error("feature welcome missing");
		await appserver.stop();
		return features;
	} finally {
		harness.restore();
	}
}

describe("remote socket lifecycle", () => {
	test("an internal pod-network client gets the fixed listener identity", async () => {
		const harness = new FakeBunHarness();
		try {
			harness.install();
			const listener = new BunRemoteListener(
				createInternalListenerPlan({ address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" }),
				{},
				{ address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
			);
			listener.start();
			const server = harness.remote();
			server.requestAddress = "127.0.0.1";
			const socket = await openRemote(server);
			expect(socket.data.peer.address).toBe("127.0.0.1");
			expect(socket.data.peer.identity).toEqual({
				nodeId: "test-node",
				addresses: ["127.0.0.1"],
				source: "direct",
			});
			await listener.stop();
		} finally {
			harness.restore();
		}
	});

	test("IDs are unique, peer snapshots immutable, sends are bounded, and close cleans the map", async () => {
		const harness = new FakeBunHarness();
		try {
			harness.install();
			const disconnected: string[] = [];
			const connected: RemoteConnection[] = [];
			const hooks: RemoteConnectionHooks = {
				connected: connection => {
					connected.push(connection);
				},
				disconnected: connection => {
					disconnected.push(connection.connectionId);
				},
			};
			const listener = new BunRemoteListener(
				createInternalListenerPlan({ address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" }),
				hooks,
				{ address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
			);
			listener.start();
			const server = harness.remote();
			expect(server.config.websocket?.backpressureLimit).toBe(16 * 1024 * 1024);
			expect(server.config.websocket?.closeOnBackpressureLimit).toBe(true);
			const first = await openRemote(server);
			const second = await openRemote(server);
			expect(first.data.connectionId).not.toBe(second.data.connectionId);
			const firstConnection = connected[0];
			if (!firstConnection) throw new Error("first connection missing");
			expect(Reflect.set(first.data.peer.identity, "nodeId", "changed")).toBe(false);
			expect(first.data.peer.identity.addresses).toEqual(["100.64.0.1"]);
			first.sendResult = 0;
			expect(firstConnection.socket.send("frame")).toBe(false);
			firstConnection.socket.close(1000, "closed");
			expect(first.closes).toHaveLength(1);
			expect(firstConnection.socket.send("late")).toBe(false);
			server.config.websocket?.close?.(first);
			server.config.websocket?.close?.(first);
			expect(disconnected).toEqual([first.data.connectionId]);
			await listener.stop();
			expect(second.closes).toHaveLength(1);
		} finally {
			harness.restore();
		}
	});
});

describe("remote appserver policy transport", () => {
	test("auth precedes Welcome and authorization precedes command dispatch; denied frames close without responses", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		const calls: string[] = [];
		try {
			const appserver = createAppserver({
				hostId: "host" as never,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: {
					authenticate: async () => {
						calls.push("authenticate");
						return { authenticated: true, authentication: "paired" };
					},
					authorize: async (_connection, frame) => {
						calls.push(`authorize:${frame.type}`);
						return frame.type !== "command";
					},
				},
			});
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			await flush();
			expect(calls).toEqual(["authenticate"]);
			const welcomeCount = socket.sends.length;
			await server.config.websocket?.message?.(socket, listCommand("denied"));
			await flush();
			expect(calls).toEqual(["authenticate", "authorize:command"]);
			expect(socket.sends).toHaveLength(welcomeCount);
			expect(socket.closes.at(-1)).toMatchObject({ code: 1008, reason: "remote policy denied" });
			expect((socket.closes.at(-1)?.reason ?? "").length).toBeLessThanOrEqual(123);
			await appserver.stop();
		} finally {
			harness.restore();
		}
	});

	test("authentication rejection sends no Welcome or core state", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		try {
			const appserver = createAppserver({
				hostId: "host" as never,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: { authenticate: async () => ({ authenticated: false }), authorize: async () => true },
			});
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			expect(socket.sends).toEqual([]);
			expect(socket.closes).toEqual([{ code: 1008, reason: "remote authentication denied" }]);
			await appserver.stop();
		} finally {
			harness.restore();
		}
	});

	test("outbound transforms run once, deny drops, and throw fails closed without raw leakage", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		let transforms = 0;
		try {
			const appserver = createAppserver({
				hostId: "host" as never,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: {
					authenticate: async () => ({ authenticated: true }),
					authorize: async () => true,
					transformOutbound: async (_connection, frame) => {
						transforms++;
						if (frame.type === "sessions") return undefined;
						if (frame.type === "pong") throw new Error("deny");
						return frame;
					},
				},
			});
			await appserver.start();
			const server = harness.remote();
			const socket = await openRemote(server);
			await server.config.websocket?.message?.(socket, hello());
			await flush();
			expect(transforms).toBe(2);
			expect(socket.sends).toHaveLength(1);
			await server.config.websocket?.message?.(socket, ping());
			await flush();
			expect(transforms).toBe(3);
			expect(socket.sends).not.toContain(expect.stringContaining('"type":"pong"'));
			expect(socket.closes).toEqual([{ code: 1011, reason: "remote policy failed" }]);
			await appserver.stop();
		} finally {
			harness.restore();
		}
	});

	for (const { name, features, capabilities, forwards } of [
		{
			name: "does not forward session deltas without negotiated session.delta",
			features: ["resume"],
			capabilities: ["sessions.read"],
			forwards: false,
		},
		{
			name: "does not forward negotiated session deltas without sessions.read",
			features: ["resume", "session.delta"],
			capabilities: [] as string[],
			forwards: false,
		},
		{
			name: "grants and forwards requested session deltas with sessions.read",
			features: ["resume", "session.delta"],
			capabilities: ["sessions.read"],
			forwards: true,
		},
	]) {
		test(name, async () => {
			const harness = new FakeBunHarness();
			harness.install();
			let currentTitle = "Session";
			try {
				const appserver = createAppserver({
					hostId: hostId("host"),
					socketPath: join(mkdtempSync(join(tmpdir(), "omp-delta-capability-")), "app.sock"),
					discovery: {
						list: async () => [
							{
								...leaseSessionRecord(),
								title: currentTitle,
								updatedAt:
									currentTitle === "Session" ? "2026-01-01T00:00:00.000Z" : "2026-01-01T00:00:01.000Z",
							},
						],
					},
					remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
					
					remotePolicy: {
						authenticate: async () => ({ authenticated: true, grantedCapabilities: capabilities }),
						authorize: async () => true,
					},
				});
				await appserver.start();
				const remote = harness.remote();
				const socket = await openRemote(remote);
				await remote.config.websocket?.message?.(socket, hello(features, capabilities));
				await flush();
				expect(sentFrames(socket).find(frame => frame.type === "welcome")).toMatchObject({
					grantedCapabilities: capabilities,
					grantedFeatures: features,
				});
				socket.sends.length = 0;

				currentTitle = "Renamed session";
				const refreshSocket = await openRemote(remote);
				await remote.config.websocket?.message?.(refreshSocket, hello(features, capabilities));
				await flush();
				const deltas = sentFrames(socket).filter(frame => frame.type === "session.delta");
				if (forwards) {
					expect(deltas).toHaveLength(1);
					expect(deltas[0]).toMatchObject({
						hostId: "host",
						sessionId: "session",
						upsert: { title: "Renamed session" },
					});
				} else expect(deltas).toEqual([]);
				await appserver.stop();
			} finally {
				harness.restore();
			}
		});
	}

	test("a delayed remote transform cannot let a later response overtake an earlier session delta", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		const factory = new LeaseFactory();
		const releaseActive = Promise.withResolvers<void>();
		const transformOrder: string[] = [];
		let holdActive = false;
		try {
			const appserver = createAppserver({
				hostId: hostId("host"),
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-ordered-transform-")), "app.sock"),
				discovery: { list: async () => [leaseSessionRecord()] },
				childFactory: factory,
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: {
					authenticate: async () => ({
						authenticated: true,
						grantedCapabilities: ["sessions.read", "sessions.prompt"],
					}),
					authorize: async () => true,
					transformOutbound: async (_connection, frame) => {
						if (holdActive && frame.type === "session.delta" && frame.upsert?.status === "active") {
							transformOrder.push("active:start");
							await releaseActive.promise;
							transformOrder.push("active:end");
						} else if (holdActive && frame.type === "response") transformOrder.push("response");
						return frame;
					},
				},
			});
			await appserver.start();
			const remote = harness.remote();
			const socket = await openRemote(remote);
			await remote.config.websocket?.message?.(socket, hello(["resume", "session.delta"], ["sessions.read", "sessions.prompt"]));
			await flush();
			socket.sends.length = 0;
			holdActive = true;

			const promptDispatch = remote.config.websocket?.message?.(
				socket,
				JSON.stringify({
					v: "omp-app/1",
					type: "command",
					requestId: "ordered-prompt-request",
					commandId: "ordered-prompt-command",
					hostId: "host",
					sessionId: "session",
					command: "session.prompt",
					args: { message: "hello" },
				}),
			);
			const child = await factory.child();
			await child.waitForWrites(1);
			const rpcPrompt = JSON.parse(child.writes[0] ?? "{}") as Record<string, unknown>;
			if (typeof rpcPrompt.id !== "string") throw new Error("RPC prompt id missing");
			child.push({
				type: "response",
				id: rpcPrompt.id,
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			});
			await flush();
			expect(transformOrder).toEqual(["active:start"]);
			expect(socket.sends).toEqual([]);

			releaseActive.resolve();
			await promptDispatch;
			await flush();
			expect(transformOrder).toEqual(["active:start", "active:end", "active:start", "active:end", "response"]);
			expect(sentFrames(socket).map(frame => frame.type)).toEqual(["session.delta", "session.delta", "response"]);
			await appserver.stop();
		} finally {
			harness.restore();
		}
	});

	test("concurrent connections keep responses isolated and listener stop closes each once before local cleanup", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		const order: string[] = [];
		try {
			const appserver = createAppserver({
				hostId: "host" as never,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-proof-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: {
					authenticate: async connection => ({
						authenticated: true,
						authentication: "paired",
						deviceId: connection.connectionId,
					}),
					authorize: async () => true,
					transformOutbound: async (connection, frame) => ({ ...frame, marker: connection.connectionId }),
				},
			});
			await appserver.start();
			const remote = harness.remote();
			const first = await openRemote(remote);
			const second = await openRemote(remote);
			await remote.config.websocket?.message?.(first, hello());
			await flush();
			await remote.config.websocket?.message?.(second, hello());
			await flush();
			const firstFrames = first.sends.map(text => JSON.parse(text) as Record<string, unknown>);
			const secondFrames = second.sends.map(text => JSON.parse(text) as Record<string, unknown>);
			expect(firstFrames.every(frame => frame.marker === first.data.connectionId)).toBe(true);
			expect(secondFrames.every(frame => frame.marker === second.data.connectionId)).toBe(true);
			remote.config.websocket?.close?.(first);
			await remote.config.websocket?.message?.(second, listCommand("second"));
			await flush();
			expect(second.sends.length).toBeGreaterThan(secondFrames.length);
			order.push("remote-stop");
			await appserver.stop();
			expect(first.closes).toHaveLength(0);
			expect(second.closes).toHaveLength(1);
			expect(harness.local().stopCalls).toEqual([true]);
		} finally {
			harness.restore();
		}
		expect(order).toEqual(["remote-stop"]);
	});
});

describe("remote healthz", () => {
	test("reports the enriched host snapshot shape", async () => {
		const harness = new FakeBunHarness();
		harness.install();
		try {
			const appserver = createAppserver({
				hostId: "health-host" as never,
				epoch: "health-epoch",
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-health-")), "app.sock"),
				discovery: { list: async () => [] },
				remoteEndpoint: { address: "0.0.0.0", port: 1, internalPeerNodeId: "test-node" },
				
				remotePolicy: { authenticate: async () => ({ authenticated: true }), authorize: async () => true },
				appserverVersion: "9.9.9",
				idleSupervisorGraceMs: 1234,
			});
			await appserver.start();
			const remote = harness.remote();
			const response = await remote.config.fetch?.(new Request("http://remote.test/healthz"), remote);
			if (!response) throw new Error("healthz fetch returned no response");
			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(body).toMatchObject({
				ok: true,
				hostId: "health-host",
				epoch: "health-epoch",
				draining: false,
				version: "9.9.9",
			});
			expect(typeof body.uptimeSec).toBe("number");
			expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
			expect(typeof body.sessions).toBe("number");
			expect(body.sessions).toBe(0);
			expect(typeof body.supervisors).toBe("number");
			expect(body.supervisors).toBe(0);
			expect(body.watchdog).toMatchObject({ graceMs: 1234, actions: 0 });
			await appserver.stop();
		} finally {
			harness.restore();
		}
	});
});

describe("default feature authority matrix", () => {
	test("resume is always available and additive features require coherent handlers", async () => {
		const base = {
			hostId: "host" as never,
			socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"),
		};
		await expect(grantedFeatures({ ...base })).resolves.toEqual(["resume"]);
		const full = operations({
			catalogGet: true,
			settingsRead: true,
			termOpen: true,
			terminalInput: true,
			terminalResize: true,
			terminalClose: true,
			filesList: true,
			filesDiff: true,
			previewLaunch: true,
			previewState: true,
			previewNavigate: true,
			previewCapture: true,
		});
		await expect(
			grantedFeatures({
				...base,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"),
				operationsAuthority: full,
			}),
		).resolves.toEqual([
			"resume",
			"catalog.metadata",
			"settings.metadata",
			"terminal.io",
			"files.list",
			"files.diff",
			"preview.control",
		]);
		const incomplete = operations({ termOpen: true });
		await expect(
			grantedFeatures({
				...base,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"),
				operationsAuthority: incomplete,
			}),
		).resolves.toEqual(["resume"]);
		await expect(
			grantedFeatures({
				...base,
				socketPath: join(mkdtempSync(join(tmpdir(), "omp-feature-")), "app.sock"),
				operationsAuthority: full,
				supportedFeatures: ["files.list", "catalog.metadata", "resume", "host.watch"],
			}),
		).resolves.toEqual(["resume", "catalog.metadata", "files.list"]);
	});
});
