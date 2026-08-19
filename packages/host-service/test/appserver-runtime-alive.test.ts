import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableProjectId } from "../src/discovery.ts";
import { createAppserver } from "../src/server.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, DeferredPromptFactory } from "./appserver-fixtures.ts";

describe("appserver runtimeAlive projection", () => {
	test("create stamps runtimeAlive, discovered idle sessions omit it, close clears it", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-runtime-alive-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		const discovered = { ...record("idle-discovered"), path: join(root, "idle-discovered.jsonl"), cwd: root };
		const created = {
			...record("created-alive"),
			path: join(root, "created-alive.jsonl"),
			cwd: root,
			projectId: stableProjectId(root),
		};
		let visible = false;
		const sessionAuthority = {
			create: async () => {
				visible = true;
				return created;
			},
			list: async () => (visible ? [discovered, created] : [discovered]),
			archive: async () => {},
			restore: async () => {},
			delete: async () => {},
		};
		const factory = new DeferredPromptFactory();
		const appserver = createAppserver({
			hostId: host,
			epoch: "runtime-alive-test",
			socketPath,
			discovery: sessionAuthority,
			sessionAuthority,
			sessionOwnershipPath,
			projectRootForProject: () => root,
			childFactory: factory,
		});
		await appserver.start();
		const client = await RawUdsWebSocket.connect(socketPath);
		const nextResponse = async (requestId: string) => {
			for (;;) {
				const frame = await client.nextServer();
				if (frame.type === "response" && frame.requestId === requestId) return frame;
			}
		};
		try {
			// Discovery alone must not mark a session as running.
			expect(appserver.snapshot(discovered.sessionId)?.ref.runtimeAlive).toBeUndefined();

			client.sendJson({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				client: { name: "runtime-alive-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: [],
				capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");

			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "create-alive",
				commandId: "create-alive-command",
				hostId: host,
				command: "session.create",
				args: { projectId: created.projectId },
			});
			const createdResponse = await nextResponse("create-alive");
			expect(createdResponse).toMatchObject({ ok: true });
			expect(createdResponse).toMatchObject({ result: { session: { runtimeAlive: true } } });
			expect(appserver.snapshot(created.sessionId)?.ref.runtimeAlive).toBe(true);

			// session.list reflects liveness: created alive, discovered omitted.
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "list-alive",
				commandId: "list-alive-command",
				hostId: host,
				command: "session.list",
				args: {},
			});
			const listResponse = (await nextResponse("list-alive")) as {
				result: { sessions: Array<{ sessionId: string; runtimeAlive?: boolean }> };
			};
			const byId = new Map(listResponse.result.sessions.map(session => [session.sessionId, session]));
			expect(byId.get(created.sessionId)?.runtimeAlive).toBe(true);
			expect(byId.get(discovered.sessionId)?.runtimeAlive).toBeUndefined();

			const revision = appserver.snapshot(created.sessionId)?.revision;
			if (!revision) throw new Error("created session snapshot missing revision");
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "close-alive",
				commandId: "close-alive-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.close",
				expectedRevision: revision,
				args: {},
			});
			let closeResponse: Record<string, unknown> | undefined;
			for (;;) {
				const frame = await client.nextServer();
				if (frame.type === "confirmation" && frame.commandId === "close-alive-command") {
					client.sendJson({
						v: "omp-app/1",
						type: "confirm",
						requestId: "close-alive-confirm",
						confirmationId: frame.confirmationId,
						commandId: frame.commandId,
						hostId: host,
						sessionId: created.sessionId,
						decision: "approve",
					});
					continue;
				}
				if (frame.type === "response" && frame.requestId === "close-alive") {
					closeResponse = frame;
					break;
				}
			}
			expect(closeResponse).toMatchObject({ ok: true });
			const closedRef = appserver.snapshot(created.sessionId)?.ref;
			expect(closedRef?.status).toBe("closed");
			expect(closedRef).not.toHaveProperty("runtimeAlive");
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	}, 20_000);
});
