import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { hostId } from "@t4-code/host-wire";
import { createAppserver, type LocalAppserver } from "../src/server.ts";
import type { AppserverOptions, RuntimeExternalActivity } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("host-test");
const epoch = "epoch-test";
const idleSignals = {
	clients: 0, ompTurns: 0, ompRetries: 0, ompCompactions: 0, bashCommands: 0,
	jobs: 0, tasks: 0, approvals: 0, uiPending: 0, terminalConnections: 0,
	terminalLeases: 0, browserPreviews: 0, browserLeases: 0, gatewayUpstreams: 0,
};
const idleActivity = { schemaVersion: 1, active: false, keepalive: false, policy: "allow-idle-sleep", signals: idleSignals };
interface AdminResponse { status: number; body: unknown; }
const started: LocalAppserver[] = [];
const roots: string[] = [];
afterEach(async () => {
	await Promise.allSettled(started.splice(0).map(appserver => appserver.stop()));
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function startAppserver(options: Partial<AppserverOptions> = {}): Promise<LocalAppserver> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-appserver-drain-"));
	roots.push(root);
	const appserver = createAppserver({ hostId: host, epoch, socketPath: path.join(root, "appserver.sock"), ...options });
	await appserver.start(); started.push(appserver); return appserver;
}
function adminRequest(socketPath: string, route: string, body: object): Promise<AdminResponse> {
	const payload = JSON.stringify(body); const gate = Promise.withResolvers<AdminResponse>();
	const request = http.request({ socketPath, path: route, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, response => {
		const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(Buffer.from(chunk)));
		response.once("error", gate.reject); response.once("end", () => gate.resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
	});
	request.once("error", gate.reject); request.end(payload); return gate.promise;
}
const identity = { expectedRuntimeUid: String(host), expectedGeneration: epoch };
const activity = (socketPath: string, body: object = identity) => adminRequest(socketPath, "/admin/runtime-activity", body);
const drain = (socketPath: string, body: object = identity) => adminRequest(socketPath, "/admin/drain-if-idle", body);
const quiesce = (socketPath: string, body: object = identity) => adminRequest(socketPath, "/admin/quiesce", body);
const reopen = (socketPath: string, body: object = identity) => adminRequest(socketPath, "/admin/reopen", body);

describe("bounded runtime activity and atomic drain", () => {
	test("wrong host or generation rejects activity and cannot fence ingress", async () => {
		const appserver = await startAppserver();
		expect(await activity(appserver.socketPath, { expectedRuntimeUid: String(host), expectedGeneration: "stale" })).toEqual({ status: 403, body: { error: "invalid admin request" } });
		expect(await drain(appserver.socketPath, { expectedRuntimeUid: "another-runtime", expectedGeneration: epoch })).toEqual({ status: 200, body: { state: "identity_mismatch", activity: idleActivity } });
		const client = await RawUdsWebSocket.connect(appserver.socketPath); await client.close();
	});

	test("each external signal, keepalive, and policy independently blocks drain without leaking values", async () => {
		const external: RuntimeExternalActivity = {};
		const mutable = external as Record<string, unknown>;
		const appserver = await startAppserver({ runtimeActivity: () => external });
		for (const signal of ["terminalConnections", "terminalLeases", "browserPreviews", "browserLeases", "gatewayUpstreams"] as const) {
			mutable[signal] = 1;
			const response = await drain(appserver.socketPath);
			expect(response.body).toMatchObject({ state: "busy", activity: { active: true, signals: { [signal]: 1 } } });
			delete mutable[signal];
		}
		mutable.keepalive = true;
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "busy", activity: { active: true, keepalive: true } });
		delete mutable.keepalive; mutable.policy = "keep-awake";
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "busy", activity: { active: true, policy: "keep-awake" } });
	});

	test("a connected Appserver client is authoritative activity", async () => {
		const appserver = await startAppserver(); const client = await RawUdsWebSocket.connect(appserver.socketPath);
		expect((await activity(appserver.socketPath)).body).toMatchObject({ active: true, signals: { clients: 1 } });
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "busy", activity: { signals: { clients: 1 } } });
		await client.close();
	});

	test("durable flush failure leaves ingress running", async () => {
		const appserver = await startAppserver({ durableFlush: async () => { throw new Error("disk unavailable"); } });
		expect(await drain(appserver.socketPath)).toEqual({ status: 200, body: { state: "flush_failed", activity: idleActivity } });
		const client = await RawUdsWebSocket.connect(appserver.socketPath); await client.close();
	});

	test("idle drain flushes once and returns a generation-bound durable shutdown acknowledgement", async () => {
		let flushes = 0; const appserver = await startAppserver({ durableFlush: async () => { flushes += 1; } });
		expect(await drain(appserver.socketPath)).toEqual({ status: 200, body: { state: "drained", activity: idleActivity, shutdownAck: { schemaVersion: 1, generation: epoch, durable: true } } });
		expect(flushes).toBe(1);
		await expect(RawUdsWebSocket.connect(appserver.socketPath)).rejects.toThrow("websocket handshake failed");
	});

	test("generation-bound reopen clears a completed drain for wake-sleep-wake", async () => {
		const transitions: string[] = [];
		let flushes = 0;
		const appserver = await startAppserver({
			runtimeIngress: {
				beginDrain: mode => { transitions.push(`begin:${mode}`); },
				rollbackDrain: () => { transitions.push("reopen"); },
				quiesce: async () => undefined,
			},
			durableFlush: async () => { flushes += 1; },
		});
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "drained" });
		expect((await reopen(appserver.socketPath, { ...identity, expectedGeneration: "stale" })).body).toEqual({ state: "identity_mismatch", generation: epoch });
		await expect(RawUdsWebSocket.connect(appserver.socketPath)).rejects.toThrow("websocket handshake failed");
		expect(await reopen(appserver.socketPath)).toEqual({ status: 200, body: { state: "reopened", generation: epoch } });
		expect(await reopen(appserver.socketPath)).toEqual({ status: 200, body: { state: "already_reopened", generation: epoch } });
		const client = await RawUdsWebSocket.connect(appserver.socketPath);
		await client.close();
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "drained" });
		expect(flushes).toBe(2);
		expect(transitions).toEqual(["begin:idle", "reopen", "begin:idle"]);
	});

	test("concurrent drain retries await the same durable flush acknowledgement", async () => {
		let flushes = 0;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const appserver = await startAppserver({
			durableFlush: async () => {
				flushes += 1;
				entered.resolve();
				await release.promise;
			},
		});
		const first = drain(appserver.socketPath);
		await entered.promise;
		let secondSettled = false;
		const second = drain(appserver.socketPath).finally(() => { secondSettled = true; });
		await Bun.sleep(10);
		expect(secondSettled).toBe(false);
		release.resolve();
		const expected = { status: 200, body: { state: "drained", activity: idleActivity, shutdownAck: { schemaVersion: 1, generation: epoch, durable: true } } };
		expect(await first).toEqual(expected);
		expect(await second).toEqual(expected);
		expect(flushes).toBe(1);
	});
	test("external ingress is fenced before snapshot and rolled back on flush failure", async () => {
		let gated = false;
		const transitions: string[] = [];
		const appserver = await startAppserver({
			runtimeIngress: {
				beginDrain: mode => { transitions.push(`begin:${mode}`); gated = true; },
				rollbackDrain: () => { transitions.push("rollback"); gated = false; },
				quiesce: async () => undefined,
			},
			durableFlush: async () => {
				expect(gated).toBe(true);
				throw new Error("checkpoint failed");
			},
		});
		expect((await drain(appserver.socketPath)).body).toMatchObject({ state: "flush_failed" });
		expect(transitions).toEqual(["begin:idle", "rollback"]);
		expect(gated).toBe(false);
	});

	test("does not acknowledge when activity appears during the durable flush", async () => {
		const external: RuntimeExternalActivity = {};
		const mutable = external as Record<string, unknown>;
		const appserver = await startAppserver({
			runtimeActivity: () => external,
			durableFlush: async () => { mutable.terminalConnections = 1; },
		});
		const response = await drain(appserver.socketPath);
		expect(response.body).toMatchObject({ state: "busy", activity: { active: true, signals: { terminalConnections: 1 } } });
		expect(response.body).not.toHaveProperty("shutdownAck");
		const client = await RawUdsWebSocket.connect(appserver.socketPath);
		await client.close();
	});

	test("explicit quiesce closes active clients and converges despite keep-awake policy", async () => {
		const transitions: string[] = [];
		const appserver = await startAppserver({
			runtimeActivity: () => ({ keepalive: true, policy: "keep-awake" }),
			runtimeIngress: {
				beginDrain: mode => { transitions.push(`begin:${mode}`); },
				rollbackDrain: () => { transitions.push("rollback"); },
				quiesce: async () => { transitions.push("quiesce"); },
			},
			durableFlush: async () => { transitions.push("flush"); },
		});
		const client = await RawUdsWebSocket.connect(appserver.socketPath);
		const response = await quiesce(appserver.socketPath);
		expect(response).toEqual({
			status: 200,
			body: { state: "drained", activity: idleActivity, shutdownAck: { schemaVersion: 1, generation: epoch, durable: true } },
		});
		expect(transitions).toEqual(["begin:explicit", "quiesce", "flush"]);
		await client.close().catch(() => undefined);
	});
});
