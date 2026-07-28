import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, sessionId } from "@t4-code/host-wire";
import { ensureSecureSocketDirectory } from "../src/ownership.ts";
import { FileSessionDiscovery, realFs, stableProjectId } from "../src/discovery.ts";
import { SessionOwnershipStore } from "../src/session-ownership-store.ts";
import { createAppserver } from "../src/server.ts";
import type { SessionDiscovery, SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, FakeFactory, DeferredPromptFactory, entry } from "./appserver-fixtures.ts";

describe("appserver observer lifecycle", () => {
	test("persists ownership after safely promoting an external session", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-promoted-session-restart-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const transcriptPath = join(root, "promoted-session.jsonl");
			const sid = sessionId("promoted-session-restart");
			const timestamp = "2026-07-23T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sid,
					cwd: root,
					timestamp,
					title: "Promoted session",
					authorityProtocol: "t4-omp-authority/1",
				})}\n`,
			);
			let lockStatus: "live" | "missing" = "live";
			const factory = new DeferredPromptFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "promoted-session-restart-test",
				socketPath,
				sessionOwnershipPath,
				discovery: new FileSessionDiscovery(root, realFs, host, true),
				childFactory: factory,
				lockStatus: () => lockStatus,
				lockCheck: async () => {
					if (lockStatus !== "missing") throw new Error("session lock is still live");
				},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "promoted-restart-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-promoted",
					commandId: "attach-promoted-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-promoted") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "observer") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("external session did not enter observer mode");
					}),
				]);
	
				lockStatus = "missing";
				await Promise.race([
					(async () => {
						while (factory.children.length === 0) await Bun.sleep(10);
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl !== undefined) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error(
							`external session was not promoted: ${JSON.stringify({
								children: factory.children.length,
								killed: factory.children.map(child => child.killed),
								control: appserver.snapshot(sid)?.ref.liveState?.sessionControl,
							})}`,
						);
					}),
				]);
	
				const ownership = new SessionOwnershipStore(sessionOwnershipPath);
				await ownership.load();
				expect(ownership.owns(sid, transcriptPath)).toBe(true);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("does not promote an unmarked session after its live lock disappears", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-unmarked-live-session-"));
			const socketPath = join(root, "run", "appserver.sock");
			const transcriptPath = join(root, "unmarked-session.jsonl");
			const sid = sessionId("unmarked-live-session");
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session", version: 3, id: sid, cwd: root, timestamp, title: "Unmarked session" })}\n`,
			);
			let lockStatus: "live" | "missing" = "live";
			const factory = new FakeFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "unmarked-live-session-test",
				socketPath,
				discovery: new FileSessionDiscovery(root, realFs, host, true),
				childFactory: factory,
				lockStatus: () => lockStatus,
				lockCheck: async () => {},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "unmarked-live-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.unverified"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-unmarked-live",
					commandId: "attach-unmarked-live-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-unmarked-live") break;
				}
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "observer") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("unmarked live session did not enter observer mode");
					}),
				]);
	
				lockStatus = "missing";
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "unverified") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("unmarked session did not become unverified after its lock disappeared");
					}),
				]);
				await Bun.sleep(100);
				expect(factory.children).toHaveLength(0);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("hydrates a T4-created session without replacing its writer projection", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-created-session-hydration-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sid = sessionId("created-session-hydration");
			const created = {
				...record(sid),
				path: join(root, "created-session-hydration.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const hydratedEntry = {
				...entry("hydrated-entry"),
				hostId: hostId("upstream-host"),
				sessionId: sessionId("upstream-session"),
			};
			let visible = false;
			const sessionAuthority = {
				create: async () => {
					visible = true;
					return created;
				},
				list: async () =>
					visible
						? [{ ...created, updatedAt: new Date(1).toISOString(), entries: [], entriesLoaded: false }]
						: [],
				load: async () => ({
					...created,
					updatedAt: new Date(1).toISOString(),
					entries: [hydratedEntry],
				}),
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "created-session-hydration-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				projectRootForProject: () => root,
				childFactory: new FakeFactory(),
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "hydration-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-hydration",
					commandId: "create-hydration-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "create-hydration") break;
				}
				const writerProjection = appserver.snapshot(sid);
				expect(writerProjection).toBeDefined();
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "list-hydration",
					commandId: "list-hydration-command",
					hostId: host,
					command: "session.list",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "list-hydration") break;
				}
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-hydration",
					commandId: "attach-hydration-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				let attachResponse;
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-hydration") {
						attachResponse = frame;
						break;
					}
				}
	
				expect(appserver.snapshot(sid)).toBe(writerProjection);
				expect(appserver.snapshot(sid)?.entries).toEqual([{ ...hydratedEntry, hostId: host, sessionId: sid }]);
				expect(attachResponse).toMatchObject({
					ok: true,
					result: { attached: true, cursor: { epoch: "created-session-hydration-test", seq: 1 } },
				});
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("restores an archived observed session after a fresh missing-lock check", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-archived-restore-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sid = sessionId("archived-observer-session");
			let current: SessionRecord = {
				...record(sid),
				path: join(root, "archived-observer-session.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
				archivedAt: "2026-07-23T00:00:00.000Z",
			};
			const authority = {
				create: async () => {
					throw new Error("not used");
				},
				list: async () => [current],
				archive: async () => {},
				restore: async () => {
					const next = { ...current };
					delete next.archivedAt;
					current = next;
				},
				delete: async () => {},
			};
			let lockStatus: "live" | "missing" = "live";
			const appserver = createAppserver({
				hostId: host,
				epoch: "archived-restore-test",
				socketPath,
				discovery: authority,
				sessionAuthority: authority,
				childFactory: new FakeFactory(),
				lockStatus: () => lockStatus,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "archived-restore-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer"],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-archived-observer",
					commandId: "attach-archived-observer-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-archived-observer") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toBeDefined();
				lockStatus = "missing";
				const expectedRevision = appserver.snapshot(sid)?.revision;
				if (expectedRevision === undefined) throw new Error("missing archived session revision");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "restore-archived-observer",
					commandId: "restore-archived-observer-command",
					hostId: host,
					sessionId: sid,
					command: "session.restore",
					expectedRevision,
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "restore-archived-observer") {
						expect(frame).toMatchObject({ ok: true, result: { restored: true } });
						break;
					}
				}
				expect(current.archivedAt).toBeUndefined();
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("keeps an archived observed session read-only while its authority lock is live", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-archived-restore-live-lock-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sid = sessionId("archived-live-lock-session");
			let current: SessionRecord = {
				...record(sid),
				path: join(root, "archived-live-lock-session.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
				archivedAt: "2026-07-23T00:00:00.000Z",
			};
			const authority = {
				create: async () => {
					throw new Error("not used");
				},
				list: async () => [current],
				archive: async () => {},
				restore: async () => {
					const next = { ...current };
					delete next.archivedAt;
					current = next;
				},
				delete: async () => {},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "archived-live-lock-test",
				socketPath,
				discovery: authority,
				sessionAuthority: authority,
				childFactory: new FakeFactory(),
				lockStatus: () => "live",
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "archived-live-lock-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer"],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-archived-live-lock",
					commandId: "attach-archived-live-lock-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-archived-live-lock") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				const expectedRevision = appserver.snapshot(sid)?.revision;
				if (expectedRevision === undefined) throw new Error("missing archived session revision");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "restore-archived-live-lock",
					commandId: "restore-archived-live-lock-command",
					hostId: host,
					sessionId: sid,
					command: "session.restore",
					expectedRevision,
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "restore-archived-live-lock") {
						expect(frame).toMatchObject({
							ok: false,
							error: { code: "session_locked" },
						});
						break;
					}
				}
				expect(current.archivedAt).toBe("2026-07-23T00:00:00.000Z");
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("never evicts omitted sessions from a partial authority inventory", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-partial-inventory-"));
			const socketPath = join(root, "run", "appserver.sock");
			const retained = record("partial-retained");
			const omitted = record("partial-omitted");
			let records = [retained, omitted];
			let complete = true;
			let totalCount = 2;
			const discovery: SessionDiscovery = {
				list: async () => records,
				inventoryComplete: () => complete,
				inventoryTotalCount: () => totalCount,
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "partial-inventory-test",
				socketPath,
				discovery,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "partial-inventory-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect(await client.nextServer()).toMatchObject({ type: "sessions", totalCount: 2, truncated: false });
				records = [retained];
				complete = false;
				totalCount = 3;
				for (let attempt = 0; attempt < 2; attempt += 1) {
					const requestId = `partial-list-${attempt}`;
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId,
						commandId: `${requestId}-command`,
						hostId: host,
						command: "session.list",
						args: {},
					});
					for (;;) {
						const frame = await client.nextServer();
						if (frame.type === "response" && frame.requestId === requestId) {
							expect(frame).toMatchObject({
								ok: true,
								result: { totalCount: 3, truncated: true },
							});
							break;
						}
					}
				}
				expect(appserver.snapshot(omitted.sessionId)).toBeDefined();
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("rejects shared system socket roots before changing their modes", async () => {
			if (process.platform === "win32") return;
			for (const directory of ["/", "/tmp", "/var", "/private/tmp", "/private/var"]) {
				await expect(ensureSecureSocketDirectory(join(directory, "appserver.sock"))).rejects.toThrow(
					"appserver socket directory must not be a shared system directory",
				);
			}
		});
	
	test("rejects user-controlled symlink components below the system temp root", async () => {
			const root = await mkdtemp(join(tmpdir(), "omp-appserver-symlink-"));
			const target = join(root, "target");
			const alias = join(root, "alias");
			try {
				await mkdir(target);
				await symlink(target, alias);
				await expect(ensureSecureSocketDirectory(join(alias, "run", "appserver.sock"))).rejects.toThrow(
					"appserver socket directory is a symlink",
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("tails an initially lockless session without spawning a writer", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-lockless-observer-"));
			const socketPath = join(root, "run", "appserver.sock");
			const transcriptPath = join(root, "lockless-session.jsonl");
			const sid = sessionId("lockless-session");
			const timestamp = "2026-07-20T00:00:00.000Z";
			const first = {
				type: "message",
				id: "first",
				parentId: null,
				timestamp,
				message: { role: "user", content: "first" },
			};
			const second = {
				type: "message",
				id: "second",
				parentId: "first",
				timestamp,
				message: { role: "assistant", content: "second" },
			};
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session", version: 3, id: sid, cwd: root, timestamp, title: "Lockless session" })}\n${JSON.stringify(first)}\n`,
			);
			const factory = new FakeFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "lockless-observer-test",
				socketPath,
				discovery: new FileSessionDiscovery(root, realFs, host, true),
				childFactory: factory,
				lockStatus: () => "missing",
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "lockless-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.unverified", "transcript.page"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "page-lockless",
					commandId: "page-lockless-command",
					hostId: host,
					sessionId: sid,
					command: "transcript.page",
					args: { limit: 64, maxBytes: 256 * 1024 },
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "page-lockless") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-lockless",
					commandId: "attach-lockless-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-lockless") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "list-lockless",
					commandId: "list-lockless-command",
					hostId: host,
					command: "session.list",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "list-lockless") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "state-lockless",
					commandId: "state-lockless-command",
					hostId: host,
					sessionId: sid,
					command: "session.state.get",
					args: {},
				});
				const stateResponse = await Promise.race([
					(async () => {
						for (;;) {
							const frame = await client.nextServer();
							if (frame.type === "response" && frame.requestId === "state-lockless") return frame;
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("observer state read did not settle");
					}),
				]);
				expect(stateResponse).toMatchObject({
					type: "response",
					ok: false,
					error: { code: "session_locked" },
				});
				expect(factory.children).toHaveLength(0);
	
				await appendFile(transcriptPath, `${JSON.stringify(second)}\n`);
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "entry" && frame.entry.data.text === "second") break;
					if (frame.type === "snapshot" && frame.entries.some(value => value.data.text === "second")) break;
				}
				expect(appserver.snapshot(sid)?.entries.at(-1)?.data.text).toBe("second");
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toEqual({
					mode: "unverified",
					transcript: "live",
				});
				expect(factory.children).toHaveLength(0);
	
				const legacyClient = await RawUdsWebSocket.connect(socketPath);
				try {
					legacyClient.sendJson({
						v: "omp-app/1",
						type: "hello",
						protocol: { min: "omp-app/1", max: "omp-app/1" },
						client: { name: "legacy-lockless-test", version: "0.5.8", build: "test", platform: "linux" },
						requestedFeatures: ["session.observer"],
						capabilities: { client: ["sessions.read"] },
						savedCursors: [],
					});
					expect(await legacyClient.nextServer()).toMatchObject({
						type: "welcome",
						grantedFeatures: ["session.observer"],
					});
					const sessions = await legacyClient.nextServer();
					expect(sessions).toMatchObject({
						type: "sessions",
						sessions: [{
							liveState: {
								sessionControl: { mode: "reconciling", transcript: "live" },
							},
						}],
					});
					legacyClient.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: "legacy-list-lockless",
						commandId: "legacy-list-lockless-command",
						hostId: host,
						command: "session.list",
						args: {},
					});
					for (;;) {
						const frame = await legacyClient.nextServer();
						if (frame.type !== "response" || frame.requestId !== "legacy-list-lockless") continue;
						expect(frame).toMatchObject({
							ok: true,
							result: {
								sessions: [{
									liveState: {
										sessionControl: { mode: "reconciling", transcript: "live" },
									},
								}],
							},
						});
						break;
					}
				} finally {
					legacyClient.destroy();
					await legacyClient.closed();
				}
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
});
