import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, projectId, sessionId } from "@t4-code/host-wire";
import { createAppserver } from "../src/server.ts";
import type {
	AppserverTestControl,
	AppserverTestControlStatus,
	AppserverTestSeedRequest,
	SessionRecord,
} from "../src/types.ts";

const TEST_TOKEN = "test-control-token-0000000000000000";

async function withTestMode<T>(operation: () => Promise<T> | T): Promise<T> {
	const previous = process.env.OMP_APP_TEST_MODE;
	process.env.OMP_APP_TEST_MODE = "1";
	try {
		return await operation();
	} finally {
		if (previous === undefined) delete process.env.OMP_APP_TEST_MODE;
		else process.env.OMP_APP_TEST_MODE = previous;
	}
}

function request(
	socketPath: string,
	path: string,
	body: Record<string, unknown>,
	token?: string,
): Promise<{ status: number; body: unknown }> {
	const payload = JSON.stringify(body);
	const gate = Promise.withResolvers<{ status: number; body: unknown }>();
	const call = http.request(
		{
			socketPath,
			path,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
		},
		response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(Buffer.from(chunk)));
			response.once("error", gate.reject);
			response.once("end", () => {
				const text = Buffer.concat(chunks).toString("utf8");
				gate.resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
			});
		},
	);
	call.once("error", gate.reject);
	call.end(payload);
	return gate.promise;
}

function status(runId: string, state: "seeded" | "clean", count: number): AppserverTestControlStatus {
	return {
		v: 1,
		runId,
		profile: "test",
		state,
		sessions: { seeded: count, indexed: count },
		locks: { live: 0, suspect: 0, stale: 0, malformed: 0 },
		workers: { supervisors: 0, starting: 0, pendingRpc: 0 },
		remainingFiles: count,
		errors: [],
	};
}

test("test control routes are absent unless explicitly configured", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-test-control-absent-"));
	const appserver = createAppserver({ hostId: hostId("test-host"), socketPath: join(root, "app.sock") });
	await appserver.start();
	try {
		expect((await request(appserver.socketPath, "/admin/test/status", { runId: "run" })).status).toBe(404);
	} finally {
		await appserver.stop();
	}
});

test("test control refuses remote listeners", () => {
	const control: AppserverTestControl = {
		token: TEST_TOKEN,
		async sessionIds() {
			return [];
		},
		async seed(request) {
			return status(request.runId, "seeded", request.sessionCount);
		},
		async status(runId) {
			return status(runId, "seeded", 0);
		},
		async cleanup(runId) {
			return status(runId, "clean", 0);
		},
	};
	expect(() =>
		createAppserver({
			testControl: control,
			remoteEndpoint: { address: "127.0.0.1", port: 0 },
		}),
	).toThrow("appserver test control is local-only");
});

test("test control requires explicit test mode and a bounded bearer token", async () => {
	const control: AppserverTestControl = {
		token: TEST_TOKEN,
		async sessionIds() {
			return [];
		},
		async seed(request) {
			return status(request.runId, "seeded", request.sessionCount);
		},
		async status(runId) {
			return status(runId, "clean", 0);
		},
		async cleanup(runId) {
			return status(runId, "clean", 0);
		},
	};
	expect(() => createAppserver({ testControl: control })).toThrow(
		"appserver test control requires OMP_APP_TEST_MODE=1",
	);
	await withTestMode(async () => {
		expect(() => createAppserver({ testControl: { ...control, token: "" } })).toThrow(
			"appserver test control token must contain 32 to 256 bytes",
		);
	});
});

test("test control requires its bearer token and dispatches bounded requests", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-test-control-auth-"));
	const calls: AppserverTestSeedRequest[] = [];
	const control: AppserverTestControl = {
		token: TEST_TOKEN,
		async sessionIds() {
			return [];
		},
		async seed(seedRequest) {
			calls.push(seedRequest);
			return status(seedRequest.runId, "seeded", seedRequest.sessionCount);
		},
		async status(runId) {
			return status(runId, "seeded", calls.length === 0 ? 0 : calls[0]!.sessionCount);
		},
		async cleanup(runId) {
			return status(runId, "clean", 0);
		},
	};
	await withTestMode(async () => {
		const appserver = createAppserver({
			hostId: hostId("test-host"),
			socketPath: join(root, "app.sock"),
			testControl: control,
		});
		await appserver.start();
		try {
			const body = { runId: "run-1", projectRoot: root, sessionCount: 25, historyEntries: 10_000 };
			expect((await request(appserver.socketPath, "/admin/test/seed", body)).status).toBe(404);
			const seeded = await request(appserver.socketPath, "/admin/test/seed", body, control.token);
			expect(seeded).toMatchObject({ status: 200, body: { state: "seeded", sessions: { seeded: 25 } } });
			expect(calls).toEqual([body]);
			expect(
				(
					await request(
						appserver.socketPath,
						"/admin/test/seed",
						{ ...body, historyEntries: 10_001 },
						control.token,
					)
				).status,
			).toBe(400);
		} finally {
			await appserver.stop();
		}
	});
});

test("test control streams the fixed ordered-turn scenario only to its disposable session", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-test-control-stream-"));
	const sid = sessionId("ordered-stream-session");
	const record: SessionRecord = {
		sessionId: sid,
		path: join(root, "ordered-stream-session.jsonl"),
		cwd: root,
		projectId: projectId("ordered-stream-project"),
		title: "Ordered stream",
		updatedAt: new Date(0).toISOString(),
		status: "idle",
		entries: [],
	};
	const control: AppserverTestControl = {
		token: TEST_TOKEN,
		async sessionIds(runId) {
			return runId === "ordered-stream-run" ? [sid] : [];
		},
		async seed(request) {
			return status(request.runId, "seeded", 1);
		},
		async status(runId) {
			return status(runId, "seeded", 1);
		},
		async cleanup(runId) {
			return status(runId, "clean", 0);
		},
	};
	await withTestMode(async () => {
		const appserver = createAppserver({
			hostId: hostId("ordered-stream-host"),
			socketPath: join(root, "app.sock"),
			discovery: { list: async () => [record] },
			testControl: control,
		});
		await appserver.start();
		try {
			const denied = await request(appserver.socketPath, "/admin/test/stream", {
				runId: "ordered-stream-run",
				scenario: "ordered-turn-v1",
				stepMs: 0,
			});
			expect(denied.status).toBe(404);
			const unknown = await request(
				appserver.socketPath,
				"/admin/test/stream",
				{ runId: "ordered-stream-run", scenario: "caller-supplied", stepMs: 0 },
				control.token,
			);
			expect(unknown.status).toBe(400);

			const streamed = await request(
				appserver.socketPath,
				"/admin/test/stream",
				{ runId: "ordered-stream-run", scenario: "ordered-turn-v1", stepMs: 0 },
				control.token,
			);
			expect(streamed).toMatchObject({
				status: 200,
				body: {
					v: 1,
					runId: "ordered-stream-run",
					scenario: "ordered-turn-v1",
					sessionId: sid,
				},
			});
			const frames = appserver.replay(sid, { epoch: appserver.epoch, seq: 0 });
			const events = frames
				.filter(frame => frame.type === "event")
				.map(frame => (frame.type === "event" ? frame.event : undefined));
			const orderedBlockIndices = [
				...new Set(
					events.flatMap(event =>
						event?.type === "assistant.block.update" ? [event.blockIndex] : [],
					),
				),
			];
			expect(orderedBlockIndices).toEqual([0, 1, 2, 3, 4]);
			const primaryWriteSnapshots = events.flatMap(event =>
				event?.type === "assistant.block.update" &&
				event.blockIndex === 2 &&
				typeof event.content === "string"
					? [event.content]
					: [],
			);
			expect(primaryWriteSnapshots.length).toBeGreaterThan(1);
			expect(primaryWriteSnapshots.every((content, index) =>
				index === 0 || content.length > primaryWriteSnapshots[index - 1]!.length
			)).toBe(true);
			expect(primaryWriteSnapshots.at(-1)).toContain("let isSmooth = true");
			expect(events[0]).toMatchObject({ type: "turn.start" });
			expect(events.at(-1)).toMatchObject({ type: "turn.end" });
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "assistant.block.update",
					blockIndex: 0,
					blockKind: "thinking",
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "assistant.block.update",
					blockIndex: 2,
					blockKind: "tool-input",
					callId: "test-write-primary",
				}),
			);
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "assistant.block.update",
					blockIndex: 4,
					blockKind: "tool-input",
					callId: "test-write-coverage",
				}),
			);
		} finally {
			await appserver.stop();
		}
	});
});
