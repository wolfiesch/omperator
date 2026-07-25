// Seeded sessions are created through the authority, not the session.create
// command, so the appserver has to claim them itself. Without that claim a
// lockless discovered transcript stays an unverified foreign session forever,
// which is exactly what makes a seeded fixture useless: listed, never writable.
// "tails an initially lockless session without spawning a writer" in
// appserver.test.ts pins the unclaimed half of this contract; this pins the
// claimed half.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, sessionId } from "@t4-code/host-wire";
import { FileSessionDiscovery } from "../src/discovery.ts";
import { createAppserver } from "../src/server.ts";
import type {
	AppserverTestControl,
	AppserverTestControlStatus,
	ChildHandle,
	RpcChildFactory,
} from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const TOKEN = "ownership-control-token-0000000000";
const HOST = hostId("ownership-host");
const STAMP = "2026-07-20T00:00:00.000Z";
const SEEDED = sessionId("seeded-owned-session");

class SilentChild implements ChildHandle {
	#queue = Promise.withResolvers<void>();
	stdin = { write: () => undefined };
	stdout: AsyncIterable<string> = this.stream();
	exited = Promise.resolve(0);
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#queue.promise;
	}
	kill() {
		this.#queue.resolve();
	}
}

/** Exposes the spawn as a promise so the test awaits the real signal, not a delay. */
class SpawnSignalFactory implements RpcChildFactory {
	readonly spawned = Promise.withResolvers<void>();
	children: SilentChild[] = [];
	spawn() {
		const child = new SilentChild();
		this.children.push(child);
		this.spawned.resolve();
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}

function post(socketPath: string, path: string, body: Record<string, unknown>): Promise<number> {
	const payload = JSON.stringify(body);
	const gate = Promise.withResolvers<number>();
	const call = http.request(
		{
			socketPath,
			path,
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
				authorization: `Bearer ${TOKEN}`,
			},
		},
		response => {
			response.resume();
			response.once("end", () => gate.resolve(response.statusCode ?? 0));
		},
	);
	call.once("error", gate.reject);
	call.end(payload);
	return gate.promise;
}

function controlStatus(runId: string, seeded: number): AppserverTestControlStatus {
	return {
		v: 1,
		runId,
		profile: "disposable",
		state: seeded > 0 ? "seeded" : "clean",
		sessions: { seeded, indexed: seeded },
		locks: { live: 0, suspect: 0, stale: 0, malformed: 0 },
		workers: { supervisors: 0, starting: 0, pendingRpc: 0 },
		remainingFiles: seeded,
		errors: [],
	};
}

async function withTestMode<T>(operation: () => Promise<T>): Promise<T> {
	const previous = process.env.OMP_APP_TEST_MODE;
	process.env.OMP_APP_TEST_MODE = "1";
	try {
		return await operation();
	} finally {
		if (previous === undefined) delete process.env.OMP_APP_TEST_MODE;
		else process.env.OMP_APP_TEST_MODE = previous;
	}
}

test("a seeded session is claimed and promoted instead of staying unverified", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-control-ownership-"));
	const transcriptPath = join(root, "seeded-owned-session.jsonl");
	const ownershipPath = join(root, "state", "owned-sessions.json");
	const control: AppserverTestControl = {
		token: TOKEN,
		async sessionIds() {
			return [SEEDED];
		},
		async seed() {
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: SEEDED,
					cwd: root,
					timestamp: STAMP,
					title: "Seeded",
				})}\n${JSON.stringify({
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: STAMP,
					message: { role: "user", content: "seeded entry 1" },
				})}\n`,
				{ mode: 0o600 },
			);
			return controlStatus("run-own", 1);
		},
		async status(runId) {
			return controlStatus(runId, 1);
		},
		async cleanup(runId) {
			return controlStatus(runId, 0);
		},
	};
	const factory = new SpawnSignalFactory();
	await withTestMode(async () => {
		const appserver = createAppserver({
			hostId: HOST,
			epoch: "control-ownership-test",
			socketPath: join(root, "run", "appserver.sock"),
			discovery: new FileSessionDiscovery(root, undefined, HOST, true),
			sessionOwnershipPath: ownershipPath,
			childFactory: factory,
			lockStatus: () => "missing",
			// Matches the owned-session precedent in appserver.test.ts: the real
			// write-lock gate belongs to the authority, which this fixture omits.
			lockCheck: async () => {},
			testControl: control,
		});
		await appserver.start();
		const client = await RawUdsWebSocket.connect(appserver.socketPath);
		try {
			client.sendJson({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				client: { name: "ownership-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: ["session.observer", "session.unverified"],
				capabilities: { client: ["sessions.read"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });

			expect(
				await post(appserver.socketPath, "/admin/test/seed", {
					runId: "run-own",
					projectRoot: root,
					sessionCount: 1,
					historyEntries: 1,
				}),
			).toBe(200);

			// The durable half of the claim.
			const ledger = JSON.parse(await readFile(ownershipPath, "utf8"));
			expect(ledger.sessions).toEqual([{ sessionId: SEEDED, path: transcriptPath }]);

			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "attach-seeded",
				commandId: "attach-seeded-command",
				hostId: HOST,
				sessionId: SEEDED,
				command: "session.attach",
				args: {},
			});
			for (;;) {
				const frame = await client.nextServer();
				if (frame.type === "response" && frame.requestId === "attach-seeded") {
					expect(frame.ok).toBe(true);
					break;
				}
			}

			// The behavioural half: an unverified lockless session never spawns a
			// writer, so a spawned child proves the observer was rebuilt with
			// ownership visible rather than pinned lockless.
			await Promise.race([
				factory.spawned.promise,
				// Bounded so the regression fails with this message instead of
				// hanging the suite until the runner's own timeout.
				Bun.sleep(3_000).then(() => {
					throw new Error("seeded session was never promoted to a writer");
				}),
			]);
			expect(factory.children.length).toBeGreaterThan(0);
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
		}
	});
});
// refreshSessions joins an in-flight refresh. If that refresh read the
// inventory before seeding wrote the transcript, the seeded id is missing from
// records and the claim would silently skip it, leaving an unowned foreign
// session behind while the endpoint still reported success.
test("a seed whose inventory snapshot predates it fails instead of leaving the session unowned", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-control-stale-"));
	const transcriptPath = join(root, "seeded-owned-session.jsonl");
	const ownershipPath = join(root, "state", "owned-sessions.json");
	const discovery = new FileSessionDiscovery(root, undefined, HOST, true);
	let releaseFirstList: (() => void) | undefined;
	const gate = new Promise<void>(resolve => {
		releaseFirstList = resolve;
	});
	let listCalls = 0;
	const stalledDiscovery = {
		list: async () => {
			listCalls += 1;
			// Hold the very first inventory read open across the seed write so a
			// later join would observe a pre-seed snapshot.
			if (listCalls === 1) await gate;
			return discovery.list();
		},
	};
	const control: AppserverTestControl = {
		token: TOKEN,
		async sessionIds() {
			return [SEEDED];
		},
		async seed() {
			releaseFirstList?.();
			return controlStatus("run-stale", 1);
		},
		async status(runId) {
			return controlStatus(runId, 1);
		},
		async cleanup(runId) {
			return controlStatus(runId, 0);
		},
	};
	await withTestMode(async () => {
		const appserver = createAppserver({
			hostId: HOST,
			epoch: "control-stale-test",
			socketPath: join(root, "run", "appserver.sock"),
			discovery: stalledDiscovery,
			sessionOwnershipPath: ownershipPath,
			childFactory: new SpawnSignalFactory(),
			lockStatus: () => "missing",
			lockCheck: async () => {},
			testControl: control,
		});
		await appserver.start();
		try {
			// The control reports a seeded session that was never written, so it
			// can never be indexed. The endpoint must fail rather than answer 200
			// with an unclaimed session.
			expect(
				await post(appserver.socketPath, "/admin/test/seed", {
					runId: "run-stale",
					projectRoot: root,
					sessionCount: 1,
					historyEntries: 0,
				}),
			).toBe(500);
			expect(await Bun.file(ownershipPath).exists()).toBe(false);
			expect(await Bun.file(transcriptPath).exists()).toBe(false);
		} finally {
			await appserver.stop();
		}
	});
});
