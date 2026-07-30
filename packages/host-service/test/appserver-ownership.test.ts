import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@t4-code/host-wire";
import { FileSessionDiscovery, realFs, stableProjectId } from "../src/discovery.ts";
import { SessionOwnershipStore } from "../src/session-ownership-store.ts";
import { createAppserver } from "../src/server.ts";
import type { SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, FakeFactory, TransferFactory } from "./appserver-fixtures.ts";

describe("appserver ownership and forks", () => {
	test("reclaims only an exact T4-owned lockless session after host restart", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-owned-session-restart-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const transcriptPath = join(root, "owned-session.jsonl");
			const sid = sessionId("owned-session-restart");
			const timestamp = "2026-07-22T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({ type: "session", version: 3, id: sid, cwd: root, timestamp, title: "Owned session" })}\n`,
			);
			const ownership = new SessionOwnershipStore(sessionOwnershipPath);
			await ownership.add(sid, transcriptPath);
			const factory = new FakeFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "owned-session-restart-test",
				socketPath,
				sessionOwnershipPath,
				discovery: new FileSessionDiscovery(root, realFs, host, true),
				childFactory: factory,
				lockStatus: () => "missing",
				lockCheck: async () => {},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "owned-restart-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-owned",
					commandId: "attach-owned-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-owned") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				await Promise.race([
					(async () => {
						while (factory.children.length === 0) await Bun.sleep(20);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("owned session was not reclaimed");
					}),
				]);
				expect(factory.children).toHaveLength(1);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("restores a waiting terminal transfer after restart and reclaims it after a stale terminal lock", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-terminal-transfer-restart-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const transcriptPath = join(root, "transferred-session.jsonl");
			const sid = sessionId("transferred-session-restart");
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sid,
					cwd: root,
					timestamp,
					title: "Transferred session after restart",
					authorityProtocol: "t4-omp-authority/1",
				})}\n`,
			);
			const ownership = new SessionOwnershipStore(sessionOwnershipPath);
			await ownership.add(sid, transcriptPath);
			await ownership.release(sid, transcriptPath);
			let lockStatus: "live" | "missing" | "stale" = "missing";
			const factory = new TransferFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "terminal-transfer-restart-test",
				socketPath,
				sessionOwnershipPath,
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
					client: { name: "transfer-restart-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.transfer"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-released-after-restart",
					commandId: "attach-released-after-restart-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-released-after-restart") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "released") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("waiting terminal transfer was not restored after restart");
					}),
				]);
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toEqual({
					mode: "released",
					transcript: "live",
					resumeCommand: "t4-omp --resume transferred-session-restart",
				});
				expect(factory.children).toHaveLength(0);
	
				lockStatus = "live";
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "observer") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("terminal writer was not observed after restart");
					}),
				]);
				const observed = new SessionOwnershipStore(sessionOwnershipPath);
				await observed.load();
				expect(observed.transfer(sid, transcriptPath)).toBe("observed");
	
				lockStatus = "stale";
				await Promise.race([
					(async () => {
						while (factory.children.length === 0) await Bun.sleep(10);
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl !== undefined) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error(
							`stale terminal writer was not reclaimed after restart: ${JSON.stringify({
								children: factory.children.length,
								control: appserver.snapshot(sid)?.ref.liveState?.sessionControl,
								transfer: observed.transfer(sid, transcriptPath),
							})}`,
						);
					}),
				]);
				const returned = new SessionOwnershipStore(sessionOwnershipPath);
				await returned.load();
				expect(returned.owns(sid, transcriptPath)).toBe(true);
				expect(returned.transfer(sid, transcriptPath)).toBeUndefined();
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("releases an owned session to a terminal writer and automatically resumes after it exits", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-terminal-transfer-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const transcriptPath = join(root, "transferred-session.jsonl");
			const sid = sessionId("transferred-session;echo-bad");
			const resumeCommand = "t4-omp --resume 'transferred-session;echo-bad'";
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sid,
					cwd: root,
					timestamp,
					title: "Transferred session",
					authorityProtocol: "t4-omp-authority/1",
				})}\n`,
			);
			const created = {
				...record(sid),
				path: transcriptPath,
				cwd: root,
				projectId: stableProjectId(root),
				authorityProtocol: "t4-omp-authority/1" as const,
			};
			let visible = false;
			const sessionAuthority = {
				create: async () => {
					visible = true;
					return created;
				},
				list: async () => (visible ? [created] : []),
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			let lockStatus: "live" | "missing" = "missing";
			const factory = new TransferFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "terminal-transfer-test",
				socketPath,
				sessionOwnershipPath,
				discovery: sessionAuthority,
				sessionAuthority,
				projectRootForProject: () => root,
				childFactory: factory,
				lockStatus: () => lockStatus,
				lockCheck: async () => {
					if (lockStatus !== "missing") throw new Error("session lock is live");
				},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			const nextResponse = async (requestId: string) => {
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === requestId) return frame;
				}
			};
			const approveRelease = async (requestId: string, expectedRevision: string) => {
				const commandId = `${requestId}-command`;
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId,
					commandId,
					hostId: host,
					sessionId: sid,
					command: "session.release",
					expectedRevision,
					args: {},
				});
				let confirmationId: string | undefined;
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "confirmation" && frame.commandId === commandId) {
						confirmationId = frame.confirmationId;
						break;
					}
					if (frame.type === "response" && frame.requestId === requestId)
						throw new Error(`release was rejected before confirmation: ${JSON.stringify(frame)}`);
				}
				client.sendJson({
					v: "omp-app/1",
					type: "confirm",
					requestId: `${requestId}-confirm`,
					confirmationId,
					commandId,
					hostId: host,
					sessionId: sid,
					decision: "approve",
				});
				return nextResponse(requestId);
			};
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "terminal-transfer-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.transfer"],
					capabilities: { client: ["sessions.read", "sessions.manage", "sessions.control"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({
					type: "welcome",
					grantedFeatures: expect.arrayContaining(["session.transfer"]),
				});
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-transfer",
					commandId: "create-transfer-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				expect(await nextResponse("create-transfer")).toMatchObject({
					ok: true,
					result: { session: { sessionId: sid } },
				});
				await Promise.race([
					(async () => {
						while (factory.children.length === 0) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("created session was not started");
					}),
				]);
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toBeUndefined();
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-transfer",
					commandId: "attach-transfer-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				expect(await nextResponse("attach-transfer")).toMatchObject({ ok: true });
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toBeUndefined();
	
				const expectedRevision = appserver.snapshot(sid)?.revision;
				if (expectedRevision === undefined) throw new Error("missing session revision");
				expect(await approveRelease("release-transfer", expectedRevision)).toMatchObject({
					ok: true,
					result: { released: true, resumeCommand },
				});
				expect(factory.children[0]?.killed).toBe(true);
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toEqual({
					mode: "released",
					transcript: "live",
					resumeCommand,
				});
	
				const releasedRevision = appserver.snapshot(sid)?.revision;
				if (releasedRevision === undefined) throw new Error("missing released session revision");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "reclaim-transfer",
					commandId: "reclaim-transfer-command",
					hostId: host,
					sessionId: sid,
					command: "session.reclaim",
					expectedRevision: releasedRevision,
					args: {},
				});
				expect(await nextResponse("reclaim-transfer")).toMatchObject({
					ok: true,
					result: { reclaimed: true },
				});
				expect(factory.children).toHaveLength(2);
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl).toBeUndefined();
	
				const rereleaseRevision = appserver.snapshot(sid)?.revision;
				if (rereleaseRevision === undefined) throw new Error("missing reclaimed session revision");
				expect(await approveRelease("release-transfer-again", rereleaseRevision)).toMatchObject({
					ok: true,
					result: { released: true },
				});
				expect(factory.children[1]?.killed).toBe(true);
	
				lockStatus = "live";
				await Promise.race([
					(async () => {
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode !== "observer") {
							await Bun.sleep(10);
						}
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("terminal writer was not observed");
					}),
				]);
				const observed = new SessionOwnershipStore(sessionOwnershipPath);
				await observed.load();
				expect(observed.transfer(sid, transcriptPath)).toBe("observed");
	
				lockStatus = "missing";
				await Promise.race([
					(async () => {
						while (factory.children.length < 3) await Bun.sleep(10);
						while (appserver.snapshot(sid)?.ref.liveState?.sessionControl !== undefined) await Bun.sleep(10);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("session did not return to Omperator after the terminal exited");
					}),
				]);
				const returned = new SessionOwnershipStore(sessionOwnershipPath);
				await returned.load();
				expect(returned.owns(sid, transcriptPath)).toBe(true);
				expect(returned.transfer(sid, transcriptPath)).toBeUndefined();
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("reclaims a completed short T4 session from its durable authority protocol", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-short-session-receipt-"));
			const socketPath = join(root, "run", "appserver.sock");
			const transcriptPath = join(root, "short-session.jsonl");
			const sid = sessionId("short-session-receipt");
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				transcriptPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sid,
					cwd: root,
					timestamp,
					title: "Short session",
					authorityProtocol: "t4-omp-authority/1",
				})}\n`,
			);
			const factory = new FakeFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "short-session-receipt-test",
				socketPath,
				discovery: new FileSessionDiscovery(root, realFs, host, true),
				childFactory: factory,
				lockStatus: () => "missing",
				lockCheck: async () => {},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "short-receipt-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.unverified"],
					capabilities: { client: ["sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-short-receipt",
					commandId: "attach-short-receipt-command",
					hostId: host,
					sessionId: sid,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-short-receipt") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				await Promise.race([
					(async () => {
						while (factory.children.length === 0) await Bun.sleep(20);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("short T4 session was not reclaimed");
					}),
				]);
				expect(factory.children).toHaveLength(1);
				expect(appserver.snapshot(sid)?.ref.liveState?.sessionControl?.mode).not.toBe("unverified");
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("forks an observed session into an owned copy without touching the source", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-fork-observed-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const sourcePath = join(root, "observed-source.jsonl");
			const forkPath = join(root, "forked-copy.jsonl");
			const sourceId = sessionId("observed-source");
			const forkId = sessionId("forked-copy");
			const timestamp = "2026-07-24T00:00:00.000Z";
			const sourceBody =
				`${JSON.stringify({ type: "session", version: 3, id: sourceId, cwd: root, timestamp, title: "Observed" })}\n` +
				`${JSON.stringify({
					type: "message",
					id: "source-entry",
					parentId: null,
					timestamp,
					message: { role: "user", content: "carried history" },
				})}\n`;
			await writeFile(sourcePath, sourceBody);
			const discovery = new FileSessionDiscovery(root, realFs, host, true);
			const factory = new FakeFactory();
			let forkedFrom: string | undefined;
			const sessionAuthority = {
				create: async () => {
					throw new Error("create is not used by this test");
				},
				list: () => discovery.list(),
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
				fork: async (source: SessionRecord) => {
					forkedFrom = source.path;
					await writeFile(
						forkPath,
						`${JSON.stringify({
							type: "session",
							version: 3,
							id: forkId,
							cwd: root,
							timestamp,
							title: "Observed",
							parentSession: sourceId,
						})}\n`,
					);
					return { sessionId: forkId, path: forkPath, cwd: root, title: "Observed", entries: [] };
				},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "fork-observed-test",
				socketPath,
				sessionOwnershipPath,
				discovery,
				sessionAuthority,
				childFactory: factory,
				// The source stays owned by another writer for the whole test; the copy
				// T4 makes is a different file and carries no lock.
				lockStatus: session => (session.path === sourcePath ? "live" : "missing"),
				lockCheck: async session => {
					if (session.path === sourcePath) throw new Error("session lock is still live");
				},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "fork-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.fork"],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				const welcome = await client.nextServer();
				expect(welcome).toMatchObject({ type: "welcome" });
				if (welcome.type !== "welcome") throw new Error("host did not send a welcome frame");
				expect(welcome.grantedFeatures).toContain("session.fork");
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-source",
					commandId: "attach-source-command",
					hostId: host,
					sessionId: sourceId,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-source") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				// Attach itself publishes the control state, so no settling wait is needed.
				expect(appserver.snapshot(sourceId)?.ref.liveState?.sessionControl?.mode).toBe("observer");
				// The observer barrier must not refuse a fork: it only reads the source.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "fork-source",
					commandId: "fork-source-command",
					hostId: host,
					sessionId: sourceId,
					command: "session.fork",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "fork-source") {
						expect(frame).toMatchObject({ ok: true, result: { session: { sessionId: forkId } } });
						break;
					}
				}
				expect(forkedFrom).toBe(sourcePath);
				expect(await readFile(sourcePath, "utf8")).toBe(sourceBody);
				// The source keeps its other writer; only the copy becomes ours.
				expect(appserver.snapshot(sourceId)?.ref.liveState?.sessionControl?.mode).toBe("observer");
				const owned = new SessionOwnershipStore(sessionOwnershipPath);
				await owned.load();
				expect(owned.owns(forkId, forkPath)).toBe(true);
				expect(owned.owns(sourceId, sourcePath)).toBe(false);
				// A writer was started for the copy, and never for the locked source.
				expect(factory.spawnedSessionPaths).toContain(forkPath);
				expect(factory.spawnedSessionPaths).not.toContain(sourcePath);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("forks an unverified lockless session, the historic-session install path", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-fork-unverified-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const sourcePath = join(root, "historic-source.jsonl");
			const forkPath = join(root, "historic-copy.jsonl");
			const sourceId = sessionId("historic-source");
			const forkId = sessionId("historic-copy");
			const timestamp = "2026-03-02T00:00:00.000Z";
			const sourceBody =
				`${JSON.stringify({ type: "session", version: 3, id: sourceId, cwd: root, timestamp, title: "Historic" })}\n` +
				`${JSON.stringify({
					type: "message",
					id: "historic-entry",
					parentId: null,
					timestamp,
					message: { role: "user", content: "written months ago" },
				})}\n`;
			await writeFile(sourcePath, sourceBody);
			const discovery = new FileSessionDiscovery(root, realFs, host, true);
			const factory = new FakeFactory();
			const sessionAuthority = {
				create: async () => {
					throw new Error("create is not used by this test");
				},
				list: () => discovery.list(),
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
				fork: async (source: SessionRecord) => {
					expect(source.path).toBe(sourcePath);
					// Mirror what SessionManager.forkFrom writes: a fresh header naming
					// the parent, then the copied history.
					await writeFile(
						forkPath,
						`${JSON.stringify({
							type: "session",
							version: 3,
							id: forkId,
							cwd: root,
							timestamp,
							title: "Historic",
							parentSession: sourceId,
						})}\n${JSON.stringify({
							type: "message",
							id: "historic-entry",
							parentId: null,
							timestamp,
							message: { role: "user", content: "written months ago" },
						})}\n`,
					);
					// A bridge authority answers without the transcript body.
					return { sessionId: forkId, path: forkPath, cwd: root, title: "Historic", entries: [] };
				},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "fork-unverified-test",
				socketPath,
				sessionOwnershipPath,
				discovery,
				sessionAuthority,
				childFactory: factory,
				// No lock was ever written, and T4 did not create this session, so it
				// classifies as unverified and stays read-only in place.
				lockStatus: () => "missing",
				lockCheck: async () => {},
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "fork-unverified-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: ["session.observer", "session.unverified", "session.fork"],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-historic",
					commandId: "attach-historic-command",
					hostId: host,
					sessionId: sourceId,
					command: "session.attach",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "attach-historic") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				// A lockless observer needs one unchanged end-of-file sample before it
				// publishes control, so wait on the host's own broadcast rather than a
				// clock: every iteration blocks until the host sends the next frame.
				while (appserver.snapshot(sourceId)?.ref.liveState?.sessionControl?.mode !== "unverified")
					await client.nextServer();
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "fork-historic",
					commandId: "fork-historic-command",
					hostId: host,
					sessionId: sourceId,
					command: "session.fork",
					args: {},
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "fork-historic") {
						expect(frame).toMatchObject({ ok: true, result: { session: { sessionId: forkId } } });
						break;
					}
				}
				// The copy must carry the history, not just a new id. The authority
				// returned no entries, so the host has to read them back from the file.
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "attach-copy",
					commandId: "attach-copy-command",
					hostId: host,
					sessionId: forkId,
					command: "session.attach",
					args: {},
				});
				// The attach response is sent first and the snapshot follows it, so keep
				// reading past the response. Bounded so a blank copy fails fast.
				let copyTraffic = "";
				let attachedToCopy = false;
				for (let frames = 0; frames < 20 && !copyTraffic.includes("written months ago"); frames += 1) {
					const frame = await client.nextServer();
					copyTraffic += JSON.stringify(frame);
					if (frame.type === "response" && frame.requestId === "attach-copy") {
						expect(frame.ok).toBe(true);
						attachedToCopy = true;
					}
				}
				expect(attachedToCopy).toBe(true);
				expect(copyTraffic).toContain("written months ago");
				expect(await readFile(sourcePath, "utf8")).toBe(sourceBody);
				// The historic session stays exactly as read-only as it was.
				expect(appserver.snapshot(sourceId)?.ref.liveState?.sessionControl?.mode).toBe("unverified");
				// The copy is ours and has a writer.
				const owned = new SessionOwnershipStore(sessionOwnershipPath);
				await owned.load();
				expect(owned.owns(forkId, forkPath)).toBe(true);
				expect(owned.owns(sourceId, sourcePath)).toBe(false);
				// The copy is writable: it has its own RPC child, and the historic
				// source never got one.
				expect(factory.spawnedSessionPaths).toContain(forkPath);
				expect(factory.spawnedSessionPaths).not.toContain(sourcePath);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	// The other fork tests stub the child factory, so none of them exercise what
		// happens when a copy's runtime genuinely refuses to start. That gap let a
		// failed fork ship an orphan session plus the lock its dead child took.
		async function forkWithFailingRuntime(childScript: string, deleteFails = false) {
			const root = await mkdtemp(join(tmpdir(), "t4-fork-runtime-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const sourcePath = join(root, "source.jsonl");
			const forkPath = join(root, "copy.jsonl");
			const sourceId = sessionId("runtime-source");
			const forkId = sessionId("runtime-copy");
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				sourcePath,
				`${JSON.stringify({ type: "session", version: 3, id: sourceId, cwd: root, timestamp, title: "Source" })}\n`,
			);
			const discovery = new FileSessionDiscovery(root, realFs, host, true);
			const sessionAuthority = {
				create: async () => {
					throw new Error("create is not used by this test");
				},
				list: () => discovery.list(),
				archive: async () => {},
				restore: async () => {},
				delete: async (session: SessionRecord) => {
					if (deleteFails) throw new Error("durable delete refused");
					await rm(session.path, { force: true });
				},
				fork: async () => {
					await writeFile(
						forkPath,
						`${JSON.stringify({ type: "session", version: 3, id: forkId, cwd: root, timestamp, title: "Source" })}\n`,
					);
					return { sessionId: forkId, path: forkPath, cwd: root, title: "Source", entries: [] };
				},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "fork-runtime-test",
				socketPath,
				sessionOwnershipPath,
				discovery,
				sessionAuthority,
				// The real factory, spawning a real process that fails the way a
				// misconfigured runtime does.
				rpcChildInvocation: { executable: "/bin/sh", prefixArgv: ["-c", childScript] },
				// Keep the SIGTERM-to-SIGKILL escalation quick when a child ignores the
				// first signal.
				lifecycleQuiesceTimeoutMs: 300,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			client.sendJson({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				client: { name: "fork-runtime", version: "1", build: "test", platform: "linux" },
				requestedFeatures: ["session.observer", "session.unverified", "session.fork"],
				capabilities: { client: ["sessions.manage", "sessions.read"] },
				savedCursors: [],
			});
			while ((await client.nextServer()).type !== "sessions") {
				/* drain welcome */
			}
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "fork-runtime",
				commandId: "fork-runtime-command",
				hostId: host,
				sessionId: sourceId,
				command: "session.fork",
				args: {},
			});
			let response: Record<string, unknown> | undefined;
			for (;;) {
				const frame = await client.nextServer();
				if (frame.type === "response" && frame.requestId === "fork-runtime") {
					response = frame as unknown as Record<string, unknown>;
					break;
				}
			}
			return { appserver, client, root, forkPath, sourcePath, forkId, response };
		}
	
	test("a fork whose runtime cannot start fails cleanly and leaves no copy behind", async () => {
			const scenario = await forkWithFailingRuntime("echo 'No models available. Use /login' >&2; exit 1");
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(scenario.response?.ok).toBe(false);
				// Not outcome_unknown: the command definitively failed and was undone.
				expect(error?.code).toBe("session_start_failed");
				expect(error?.message).toContain("no model is configured");
				// The child's raw stderr can carry secrets, so none of it crosses.
				expect(error?.message).not.toContain("/login");
				expect(error?.message).not.toContain(scenario.root);
				// The orphan is the real regression: the copy must be gone.
				expect(await Bun.file(scenario.forkPath).exists()).toBe(false);
				expect(scenario.appserver.snapshot(scenario.forkId)).toBeUndefined();
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
			}
		});
	
	test("a fork keeps the copy visible when its runtime fails and cleanup also fails", async () => {
			const scenario = await forkWithFailingRuntime("exit 1", true);
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(scenario.response?.ok).toBe(false);
				expect(error?.message).toContain("could not be removed");
				// Cleanup failed, so the copy survives. Keeping the record is what lets
				// an operator still see and retry it instead of silently orphaning it.
				expect(await Bun.file(scenario.forkPath).exists()).toBe(true);
				expect(scenario.appserver.snapshot(scenario.forkId)).toBeDefined();
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
			}
		});
	
	// stdout EOF and the stderr reader race. A child that writes its diagnostic
		// and exits in the same breath is the ordering that previously lost it and
		// reported a bare EOF instead.
		test("classifies a runtime that prints its reason and exits immediately", async () => {
			const scenario = await forkWithFailingRuntime("printf 'No models available\\n' >&2; exit 1");
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(error?.code).toBe("session_start_failed");
				expect(error?.message).toContain("no model is configured");
				expect(await Bun.file(scenario.forkPath).exists()).toBe(false);
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
			}
		});
	
	// `stop()` only signals. A child that ignores SIGTERM must still be gone
		// before the copy is deleted, or it can rewrite the lock afterwards.
		test("escalates to SIGKILL before removing the copy of a child that ignores SIGTERM", async () => {
			const pidFile = join(tmpdir(), `t4-stubborn-child-${Date.now()}.pid`);
			const scenario = await forkWithFailingRuntime(
				`trap '' TERM; echo $$ > ${pidFile}; echo not-json; sleep 30`,
			);
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(scenario.response?.ok).toBe(false);
				expect(error?.code).toBe("session_start_failed");
				// The contract is the ordering: the child must already be gone by the
				// time the response lands, not merely signalled. Without that wait this
				// assertion fails while the copy check still passes.
				const childPid = Number.parseInt(await Bun.file(pidFile).text(), 10);
				expect(Number.isInteger(childPid)).toBe(true);
				expect(() => process.kill(childPid, 0)).toThrow();
				expect(await Bun.file(scenario.forkPath).exists()).toBe(false);
				expect(scenario.appserver.snapshot(scenario.forkId)).toBeUndefined();
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
				await rm(pidFile, { force: true });
			}
		});
	
	// A historic transcript often names a project directory that has since been
		// deleted. The copy needs somewhere real to run, so the caller chooses; the
		// host never substitutes a directory on its own.
		async function forkIntoDirectory(sourceCwd: string, requestedCwd: string | undefined) {
			const root = await mkdtemp(join(tmpdir(), "t4-fork-cwd-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const sourcePath = join(root, "source.jsonl");
			const forkPath = join(root, "copy.jsonl");
			const sourceId = sessionId("cwd-source");
			const forkId = sessionId("cwd-copy");
			const timestamp = "2026-07-25T00:00:00.000Z";
			await writeFile(
				sourcePath,
				`${JSON.stringify({ type: "session", version: 3, id: sourceId, cwd: sourceCwd, timestamp, title: "Source" })}\n`,
			);
			const discovery = new FileSessionDiscovery(root, realFs, host, true);
			let forkedInto: string | undefined;
			const appserver = createAppserver({
				hostId: host,
				epoch: "fork-cwd-test",
				socketPath,
				sessionOwnershipPath,
				discovery,
				sessionAuthority: {
					create: async () => {
						throw new Error("create is not used by this test");
					},
					list: () => discovery.list(),
					archive: async () => {},
					restore: async () => {},
					delete: async (session: SessionRecord) => {
						await rm(session.path, { force: true });
					},
					fork: async (_source: SessionRecord, cwd?: string) => {
						forkedInto = cwd;
						const effective = cwd ?? sourceCwd;
						await writeFile(
							forkPath,
							`${JSON.stringify({ type: "session", version: 3, id: forkId, cwd: effective, timestamp, title: "Source" })}\n`,
						);
						return { sessionId: forkId, path: forkPath, cwd: effective, title: "Source", entries: [] };
					},
				},
				// Any spawn fails; these tests only care about the directory decision.
				rpcChildInvocation: { executable: "/bin/sh", prefixArgv: ["-c", "exit 1"] },
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			client.sendJson({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				client: { name: "fork-cwd", version: "1", build: "test", platform: "linux" },
				requestedFeatures: ["session.observer", "session.unverified", "session.fork"],
				capabilities: { client: ["sessions.manage", "sessions.read"] },
				savedCursors: [],
			});
			while ((await client.nextServer()).type !== "sessions") {
				/* drain welcome */
			}
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "fork-cwd",
				commandId: "fork-cwd-command",
				hostId: host,
				sessionId: sourceId,
				command: "session.fork",
				args: requestedCwd === undefined ? {} : { cwd: requestedCwd },
			});
			let response: Record<string, unknown> | undefined;
			for (;;) {
				const frame = await client.nextServer();
				if (frame.type === "response" && frame.requestId === "fork-cwd") {
					response = frame as unknown as Record<string, unknown>;
					break;
				}
			}
			return { appserver, client, root, response, forkedInto: () => forkedInto };
		}
	
	test("asks for a working directory when the source project directory is gone", async () => {
			const scenario = await forkIntoDirectory(join(tmpdir(), "t4-deleted-project-fixture"), undefined);
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(scenario.response?.ok).toBe(false);
				// Actionable, so the caller can prompt and retry, not a raw ENOENT.
				expect(error?.code).toBe("session_cwd_missing");
				expect(error?.message).toContain("choose a working directory");
				// Nothing was copied: the decision comes before any write.
				expect(scenario.forkedInto()).toBeUndefined();
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
			}
		});
	
	test("forks a session with a gone directory into the one the caller chose", async () => {
			const chosen = await mkdtemp(join(tmpdir(), "t4-chosen-project-"));
			const scenario = await forkIntoDirectory(join(tmpdir(), "t4-deleted-project-fixture"), chosen);
			try {
				// The authority receives the choice, so it lands in the copy's header
				// rather than living only in this process's memory.
				expect(scenario.forkedInto()).toBe(chosen);
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
				await rm(chosen, { recursive: true, force: true });
			}
		});
	
	test("refuses a chosen working directory that does not exist", async () => {
			const scenario = await forkIntoDirectory(tmpdir(), join(tmpdir(), "t4-absent-choice-fixture"));
			try {
				const error = scenario.response?.error as { code?: string; message?: string } | undefined;
				expect(error?.code).toBe("session_cwd_invalid");
				expect(scenario.forkedInto()).toBeUndefined();
			} finally {
				scenario.client.destroy();
				await scenario.client.closed();
				await scenario.appserver.stop();
				await rm(scenario.root, { recursive: true, force: true });
			}
		});
});
