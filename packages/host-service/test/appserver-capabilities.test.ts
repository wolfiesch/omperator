import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_CATALOG_COMMANDS } from "@t4-code/host-wire";
import { stableProjectId } from "../src/discovery.ts";
import { SessionOwnershipStore } from "../src/session-ownership-store.ts";
import { appserverSupportedCapabilities, appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import type { SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";
import { host, record, FakeFactory, DeferredPromptFactory, StaticDiscovery } from "./appserver-fixtures.ts";

describe("appserver capabilities and creation", () => {
	test("advertises the exact default implemented feature set", () => {
			expect(appserverSupportedFeatures({})).toEqual([
				"resume",
				"session.delta",
				"prompt.images",
				"agent.transcript",
				"session.observer",
				"session.unverified",
				"artifacts.read",
			]);
		});
	
	test("advertises session forking only with both a forking authority and a loader", () => {
			const authority = {
				create: async () => {
					throw new Error("unused");
				},
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const forking = {
				...authority,
				fork: async () => {
					throw new Error("unused");
				},
			};
			const withLoader = { list: async () => [], load: async (session: SessionRecord) => session };
			const withoutLoader = { list: async () => [] };
			expect(
				appserverSupportedFeatures({ sessionAuthority: authority, discovery: withLoader }),
			).not.toContain("session.fork");
			// A fork answered without a transcript body needs the loader to read the
			// copy's history back, so the feature stays off without one.
			expect(
				appserverSupportedFeatures({ sessionAuthority: forking, discovery: withoutLoader }),
			).not.toContain("session.fork");
			expect(appserverSupportedFeatures({ sessionAuthority: forking, discovery: withLoader })).toContain(
				"session.fork",
			);
		});
	
	test("advertises transcript image reads only with an explicit blob root", () => {
			expect(appserverSupportedFeatures({})).not.toContain("transcript.images");
			expect(appserverSupportedFeatures({ transcriptImageRoot: "/tmp/omp-blobs" })).toContain("transcript.images");
			expect(
				appserverSupportedFeatures({ supportedFeatures: ["transcript.images"], transcriptImageRoot: undefined }),
			).not.toContain("transcript.images");
		});
	
	test("advertises native project reveal only to local clients with both required authorities", () => {
			const options = {
				projectRootForProject: () => "/tmp/project",
				projectRevealer: async () => true,
			};
			expect(appserverSupportedFeatures(options)).toContain("project.reveal");
			expect(appserverSupportedFeatures(options, true)).not.toContain("project.reveal");
			expect(appserverSupportedFeatures({ projectRootForProject: options.projectRootForProject })).not.toContain(
				"project.reveal",
			);
		});
	
	test("advertises preview feature and capabilities from the authority methods actually present", () => {
			const stateOnly = { previewState: async () => ({ previews: [] }) };
			expect(appserverSupportedFeatures({ operationsAuthority: stateOnly })).toContain("preview.control");
			expect(appserverSupportedCapabilities({ operationsAuthority: stateOnly })).toContain("preview.read");
			expect(appserverSupportedCapabilities({ operationsAuthority: stateOnly })).not.toContain("preview.control");
			expect(appserverSupportedCapabilities({ operationsAuthority: stateOnly })).not.toContain("preview.input");
	
			const inputOnly = { previewClick: async () => ({ preview: {} }) };
			expect(appserverSupportedFeatures({ operationsAuthority: inputOnly })).toContain("preview.control");
			expect(appserverSupportedCapabilities({ operationsAuthority: inputOnly })).toContain("preview.input");
			expect(appserverSupportedCapabilities({ operationsAuthority: inputOnly })).not.toContain("preview.read");
		});
	
	test("advertises project file search only when its concrete authority exists", () => {
			expect(appserverSupportedFeatures({ operationsAuthority: {} })).not.toContain("files.search");
			expect(
				appserverSupportedFeatures({
					operationsAuthority: { filesSearch: async () => ({ matches: [], truncated: false }) },
				}),
			).toContain("files.search");
			expect(
				appserverSupportedCapabilities({
					operationsAuthority: { filesSearch: async () => ({ matches: [], truncated: false }) },
				}),
			).toContain("files.list");
		});
	
	test("advertises usage reads only when a concrete read authority exists", () => {
			expect(appserverSupportedCapabilities({})).not.toContain("usage.read");
			expect(
				appserverSupportedCapabilities({
					usageAuthority: {
						read: async () => ({ generatedAt: 0, reports: [], accountsWithoutUsage: [], capacity: {} }),
					},
				}),
			).toContain("usage.read");
			expect(() => createAppserver({ supportedCapabilities: ["usage.read"] })).toThrow(
				"unsupported capability has no handler",
			);
		});
	
	test("every desktop catalog command has a live appserver handler", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-desktop-catalog-"));
			try {
				const appserver = createAppserver({
					operationsAuthority: {
						brokerStatus: async () => ({ state: "local", generation: 0 }),
					},
					usageAuthority: {
						read: async () => ({ generatedAt: 0, reports: [], accountsWithoutUsage: [], capacity: {} }),
					},
					projectRootForProject: () => "/tmp/project",
					projectRevealer: async () => true,
					sessionOwnershipPath: join(root, "owned-sessions.json"),
				});
				const unhandled = DESKTOP_CATALOG_COMMANDS.filter(command => !appserver.hasDesktopCatalogCommandHandler(command));
				expect(unhandled).toEqual([]);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("indexes three sessions, starts one child each, and removes socket", async () => {
			const root = await mkdtemp(join(tmpdir(), "omp-appserver-"));
			const socketPath = join(root, "run", "appserver.sock");
			const factory = new FakeFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "epoch-test",
				socketPath,
				discovery: new StaticDiscovery([record("a"), record("b"), record("c")]),
				childFactory: factory,
			});
			await appserver.start();
			expect(factory.children).toHaveLength(0);
			const socket = await stat(socketPath);
			expect(socket.mode & 0o777).toBe(0o600);
			const parent = await stat(join(root, "run"));
			expect(parent.mode & 0o777).toBe(0o700);
			await appserver.stop();
			await expect(stat(socketPath)).rejects.toThrow();
			for (const child of factory.children) expect(child.killed).toBe(true);
		});
	
	test("starts a writer from an indexed project before returning a session created through T4", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-created-session-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const existing = {
				...record("existing-session"),
				path: join(root, "existing-session.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const created = {
				...record("created-session"),
				path: join(root, "created-session.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const factory = new FakeFactory();
			let visible = false;
			let createdCwd: string | undefined;
			const sessionAuthority = {
				create: async (cwd: string) => {
					createdCwd = cwd;
					visible = true;
					return created;
				},
				list: async () => visible ? [created, existing] : [existing],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "created-session-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
				projectRootForProject: () => {
					throw new Error("partial authority inventory cannot resolve project roots");
				},
				childFactory: factory,
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "create-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-session",
					commandId: "create-session-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type !== "response" || frame.requestId !== "create-session") continue;
					expect(frame).toMatchObject({ ok: true });
					break;
				}
				expect(factory.children).toHaveLength(1);
				expect(factory.children[0]?.killed).toBe(false);
				expect(createdCwd).toBe(await realpath(root));
				const ownership = new SessionOwnershipStore(sessionOwnershipPath);
				await ownership.load();
				expect(ownership.owns(created.sessionId, created.path)).toBe(true);
	
				const list = async (suffix: string): Promise<void> => {
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: `list-${suffix}`,
						commandId: `list-${suffix}-command`,
						hostId: host,
						command: "session.list",
						args: {},
					});
					for (;;) {
						const frame = await client.nextServer();
						if (frame.type !== "response" || frame.requestId !== `list-${suffix}`) continue;
						expect(frame.ok).toBe(true);
						return;
					}
				};
				await list("visible");
				visible = false;
				await list("missing-once");
				await list("missing-twice");
				const pruned = new SessionOwnershipStore(sessionOwnershipPath);
				await pruned.load();
				expect(pruned.owns(created.sessionId, created.path)).toBe(false);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("ignores external runtime records when resolving a native session project", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-created-session-external-record-"));
			const worktree = join(root, "external-worktree");
			await mkdir(worktree);
			const socketPath = join(root, "run", "appserver.sock");
			const requestedProject = stableProjectId(root);
			const external = {
				...record("external-session"),
				path: worktree,
				cwd: worktree,
				projectId: requestedProject,
				runtime: { id: "external-runtime", workspaceInstanceId: "external-worktree" },
			};
			const created = {
				...record("native-created-session"),
				path: join(root, "native-created-session.jsonl"),
				cwd: root,
				projectId: requestedProject,
			};
			let createdCwd: string | undefined;
			let resolverCalls = 0;
			const sessionAuthority = {
				create: async (cwd: string) => {
					createdCwd = cwd;
					return created;
				},
				list: async () => [external],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "external-record-project-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				projectRootForProject: () => {
					resolverCalls += 1;
					return root;
				},
				childFactory: new FakeFactory(),
			});
			await appserver.start();
			const client = await RawUdsWebSocket.connect(socketPath);
			try {
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "external-record-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-native-session",
					commandId: "create-native-session-command",
					hostId: host,
					command: "session.create",
					args: { projectId: requestedProject },
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type !== "response" || frame.requestId !== "create-native-session") continue;
					expect(frame).toMatchObject({ ok: true });
					break;
				}
				expect(resolverCalls).toBe(1);
				expect(createdCwd).toBe(await realpath(root));
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("prunes ownership when a created session never enters discovery", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-created-session-missing-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const created = {
				...record("created-session-missing"),
				path: join(root, "created-session-missing.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const sessionAuthority = {
				create: async () => created,
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const appserver = createAppserver({
				hostId: host,
				epoch: "created-session-missing-test",
				socketPath,
				discovery: sessionAuthority,
				sessionAuthority,
				sessionOwnershipPath,
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
					client: { name: "missing-create-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-missing",
					commandId: "create-missing-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				for (;;) {
					const frame = await client.nextServer();
					if (frame.type === "response" && frame.requestId === "create-missing") {
						expect(frame.ok).toBe(true);
						break;
					}
				}
				const owned = new SessionOwnershipStore(sessionOwnershipPath);
				await owned.load();
				expect(owned.owns(created.sessionId, created.path)).toBe(true);
	
				for (const suffix of ["once", "twice"]) {
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: `list-missing-${suffix}`,
						commandId: `list-missing-${suffix}-command`,
						hostId: host,
						command: "session.list",
						args: {},
					});
					for (;;) {
						const frame = await client.nextServer();
						if (frame.type !== "response" || frame.requestId !== `list-missing-${suffix}`) continue;
						expect(frame.ok).toBe(true);
						break;
					}
				}
				const pruned = new SessionOwnershipStore(sessionOwnershipPath);
				await pruned.load();
				expect(pruned.owns(created.sessionId, created.path)).toBe(false);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
	
	test("defers missing-created-session cleanup while its first prompt is in flight", async () => {
			const root = await mkdtemp(join(tmpdir(), "t4-created-session-busy-"));
			const socketPath = join(root, "run", "appserver.sock");
			const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
			const created = {
				...record("created-session-busy"),
				path: join(root, "created-session-busy.jsonl"),
				cwd: root,
				projectId: stableProjectId(root),
			};
			const sessionAuthority = {
				create: async () => created,
				list: async () => [],
				archive: async () => {},
				restore: async () => {},
				delete: async () => {},
			};
			const factory = new DeferredPromptFactory();
			const appserver = createAppserver({
				hostId: host,
				epoch: "created-session-busy-test",
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
				client.sendJson({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "busy-create-test", version: "1", build: "test", platform: "linux" },
					requestedFeatures: [],
					capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
					savedCursors: [],
				});
				expect(await client.nextServer()).toMatchObject({ type: "welcome" });
				expect((await client.nextServer()).type).toBe("sessions");
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "create-busy",
					commandId: "create-busy-command",
					hostId: host,
					command: "session.create",
					args: { projectId: created.projectId },
				});
				expect(await nextResponse("create-busy")).toMatchObject({ ok: true });
				const child = factory.children[0];
				if (!child) throw new Error("created session did not start its writer");
	
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "prompt-busy",
					commandId: "prompt-busy-command",
					hostId: host,
					sessionId: created.sessionId,
					command: "session.prompt",
					args: { message: "keep the first prompt active" },
				});
				await child.promptReceived;
	
				for (const suffix of ["once", "twice"]) {
					client.sendJson({
						v: "omp-app/1",
						type: "command",
						requestId: `list-busy-${suffix}`,
						commandId: `list-busy-${suffix}-command`,
						hostId: host,
						command: "session.list",
						args: {},
					});
					expect(await nextResponse(`list-busy-${suffix}`)).toMatchObject({ ok: true });
				}
				expect(child.killed).toBe(false);
				expect(appserver.snapshot(created.sessionId)).toBeDefined();
				const retained = new SessionOwnershipStore(sessionOwnershipPath);
				await retained.load();
				expect(retained.owns(created.sessionId, created.path)).toBe(true);
	
				child.replyToPrompt();
				expect(await nextResponse("prompt-busy")).toMatchObject({ ok: false });
				await Promise.race([
					(async () => {
						while (appserver.snapshot(created.sessionId)?.ref.status === "active") await Bun.sleep(5);
					})(),
					Bun.sleep(1_000).then(() => {
						throw new Error("prompt state did not settle");
					}),
				]);
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: "list-busy-settled",
					commandId: "list-busy-settled-command",
					hostId: host,
					command: "session.list",
					args: {},
				});
				expect(await nextResponse("list-busy-settled")).toMatchObject({ ok: true });
				expect(child.killed).toBe(true);
				expect(appserver.snapshot(created.sessionId)).toBeUndefined();
				const pruned = new SessionOwnershipStore(sessionOwnershipPath);
				await pruned.load();
				expect(pruned.owns(created.sessionId, created.path)).toBe(false);
			} finally {
				client.destroy();
				await client.closed();
				await appserver.stop();
				await rm(root, { recursive: true, force: true });
			}
		});
});
