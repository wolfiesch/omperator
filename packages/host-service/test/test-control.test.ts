import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId } from "@t4-code/host-wire";
import { createAppserver } from "../src/server.ts";
import type { AppserverTestControl, AppserverTestControlStatus, AppserverTestSeedRequest } from "../src/types.ts";

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
