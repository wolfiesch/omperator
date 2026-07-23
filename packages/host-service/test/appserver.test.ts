import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_CATALOG_COMMANDS, type DurableEntry, hostId, projectId, sessionId } from "@t4-code/host-wire";
import { completeAttachOutput, prepareAttachOutput } from "../src/attach-output.ts";
import { IdempotencyStore } from "../src/idempotency.ts";
import { ensureSecureSocketDirectory } from "../src/ownership.ts";
import { FileSessionDiscovery, realFs, stableProjectId } from "../src/discovery.ts";
import { SessionProjection } from "../src/projection.ts";
import { SessionOwnershipStore } from "../src/session-ownership-store.ts";
import { appserverSupportedCapabilities, appserverSupportedFeatures, createAppserver } from "../src/server.ts";
import { SubagentProjection } from "../src/subagent-projection.ts";
import type { ChildHandle, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const host = hostId("host-test");
function record(id: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("project-test"),
		title: id,
		updatedAt: new Date(0).toISOString(),
		status: "idle",
		entries: [],
	};
}
class FakeChild implements ChildHandle {
	#queue = Promise.withResolvers<void>();
	output: string[] = [];
	killed = false;
	stdin = {
		write: (data: string) => {
			this.output.push(data);
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = Promise.resolve(0);
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#queue.promise;
	}
	push(value: Record<string, unknown>) {
		this.output.push(JSON.stringify(value));
	}
	kill() {
		this.killed = true;
		this.#queue.resolve();
	}
}
class FakeFactory implements RpcChildFactory {
	children: FakeChild[] = [];
	spawn() {
		const child = new FakeChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
class DeferredPromptChild implements ChildHandle {
	#prompt = Promise.withResolvers<Record<string, unknown>>();
	#state = Promise.withResolvers<Record<string, unknown>>();
	#reply = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	promptReceived = this.#prompt.promise;
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type === "prompt") this.#prompt.resolve(frame);
			else if (frame.type === "get_state") this.#state.resolve(frame);
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		const prompt = await this.#prompt.promise;
		await this.#reply.promise;
		yield `${JSON.stringify({
			type: "response",
			id: prompt.id,
			command: "prompt",
			success: false,
		})}\n`;
		const state = await this.#state.promise;
		yield `${JSON.stringify({
			type: "response",
			id: state.id,
			command: "get_state",
			success: true,
			data: {
				isStreaming: false,
				isCompacting: false,
				isPaused: false,
				messageCount: 0,
				queuedMessageCount: 0,
				steeringMode: "all",
				followUpMode: "all",
				interruptMode: "immediate",
			},
		})}\n`;
		await this.#finish.promise;
	}
	replyToPrompt() {
		this.#reply.resolve();
	}
	kill() {
		this.killed = true;
		this.#reply.resolve();
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
class DeferredPromptFactory implements RpcChildFactory {
	children: DeferredPromptChild[] = [];
	spawn() {
		const child = new DeferredPromptChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly records: SessionRecord[]) {}
	async list() {
		return this.records;
	}
}
function entry(id: string, parentId: string | null = null): DurableEntry {
	return {
		id: id as DurableEntry["id"],
		parentId: parentId as DurableEntry["parentId"],
		hostId: host,
		sessionId: sessionId("s"),
		kind: "message",
		timestamp: new Date(0).toISOString(),
		data: { id },
	};
}

describe("projection and replay", () => {
	test("completes attach output across the pre-subscription transcript and subagent gap", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a");
		const subagents = new SubagentProjection(host, sessionId("s"), () => 100);
		const prepared = prepareAttachOutput(projection);
		const appended = projection.appendEntry(entry("during-attach"));
		const agent = subagents.applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: "AttachWorker",
				index: 0,
				agent: "task",
				description: "Attach race worker",
				status: "started",
				lastUpdate: 100,
			},
		});
		if (!appended || !agent) throw new Error("expected attach-gap projection frames");
		const frames = completeAttachOutput(prepared, projection, subagents);

		expect(frames.map(frame => frame.type)).toEqual(["snapshot", "entry", "agent"]);
		expect(frames[0]).toMatchObject({ type: "snapshot", entries: [] });
		expect(frames[1]).toEqual(appended);
		expect(frames[2]).toMatchObject({ type: "agent", agentId: "AttachWorker", state: "started" });
	});
	test("deduplicates durable IDs and emits gap on ring eviction", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 1);
		expect(projection.appendEntry(entry("a"))).toBeDefined();
		expect(projection.appendEntry(entry("a"))).toBeUndefined();
		projection.appendEvent({ type: "live" });
		const replay = projection.replay({ epoch: "epoch-a", seq: 0 });
		expect(replay[0]?.type).toBe("gap");
		expect(projection.value.entries.map(value => String(value.id))).toEqual(["a"]);
	});
	test("publishes title changes and safely fills discovery metadata", () => {
		const source = { ...record("s"), title: "Session" };
		const projection = new SessionProjection(host, source, "epoch-a");
		const discovered = {
			...source,
			projectName: "tmp",
			title: "First substantive request",
			updatedAt: new Date(1).toISOString(),
		};
		const reconciled = projection.reconcileRecord(discovered);
		expect(reconciled).toMatchObject({
			type: "session.delta",
			cursor: { epoch: "epoch-a", seq: 1 },
			upsert: { project: { projectId: "project-test", name: "tmp" }, title: "First substantive request" },
		});
		if (!reconciled) throw new Error("expected discovery metadata delta");
		expect(projection.reconcileRecord(discovered)).toBeUndefined();

		const titled = projection.updateTitle("Explicit title");
		expect(titled).toMatchObject({
			type: "session.delta",
			cursor: { epoch: "epoch-a", seq: 2 },
			upsert: { title: "Explicit title" },
		});
		if (!titled) throw new Error("expected explicit title delta");
		expect(projection.updateTitle("Explicit title")).toBeUndefined();
		expect(
			projection.reconcileRecord({
				...discovered,
				projectName: "stale-project-name",
				title: "Stale discovered title",
			}),
		).toBeUndefined();
		expect(projection.value.ref).toMatchObject({
			project: { projectId: "project-test", name: "tmp" },
			title: "Explicit title",
		});
		expect(projection.replay({ epoch: "epoch-a", seq: 0 })).toEqual([]);
		expect(projection.value.cursor.seq).toBe(0);
		expect(projection.value.indexCursor.seq).toBe(2);
	});
	test("keeps transcript replay contiguous across independent index deltas", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a");
		const first = projection.appendEvent({ type: "before_delta" });
		const delta = projection.updateStatus("active");
		const second = projection.appendEvent({ type: "after_delta" });
		expect(first).toMatchObject({ type: "event", cursor: { epoch: "epoch-a", seq: 1 } });
		expect(delta).toMatchObject({ type: "session.delta", cursor: { epoch: "epoch-a", seq: 1 } });
		expect(second).toMatchObject({ type: "event", cursor: { epoch: "epoch-a", seq: 2 } });
		expect(projection.value.cursor.seq).toBe(2);
		expect(projection.value.indexCursor.seq).toBe(1);
		expect(projection.replay({ epoch: "epoch-a", seq: 0 })).toEqual([first, second]);
	});
	test("projects bounded pending attention and the latest root outcome", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a");
		for (let index = 0; index < 10; index++)
			projection.setPendingAttention({
				kind: index % 2 === 0 ? "approval" : "plan",
				id: `pending-${index}`,
				title: `Pending ${index}`,
				summary: "Safe summary",
				requestedAt: new Date(index).toISOString(),
			});
		expect(projection.value.ref).toMatchObject({
			pendingApproval: true,
			attention: { pendingCount: 10, truncated: true },
		});
		expect(projection.value.ref.attention?.pending).toHaveLength(8);

		projection.removePendingAttention("pending-0");
		expect(projection.value.ref.attention).toMatchObject({ pendingCount: 9, truncated: true });
		const outcome = {
			id: "agent:completed:2026-07-18T12:00:00.000Z",
			kind: "completed" as const,
			at: "2026-07-18T12:00:00.000Z",
			summary: "Agent completed work.",
		};
		projection.settleAttentionOutcome(outcome);
		expect(projection.value.ref).toMatchObject({
			attention: { pending: [], pendingCount: 0, truncated: false, latestOutcome: outcome },
		});
		expect(projection.value.ref.pendingApproval).toBeUndefined();
	});
	test("clears live attention on lifecycle loss but retains the latest outcome", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a");
		projection.setLatestOutcome({
			id: "agent:failed:2026-07-18T12:00:00.000Z",
			kind: "failed",
			at: "2026-07-18T12:00:00.000Z",
			summary: "Agent stopped with an error.",
		});
		projection.setPendingAttention({
			kind: "question",
			id: "question-1",
			question: "Continue?",
			options: [],
			allowText: true,
			requestedAt: "2026-07-18T12:01:00.000Z",
		});
		projection.markRuntimeCrashed();
		expect(projection.value.ref).toMatchObject({
			status: "closed",
			attention: {
				pending: [],
				pendingCount: 0,
				truncated: false,
				latestOutcome: { kind: "failed" },
			},
		});
		expect(projection.value.ref.pendingUserInput).toBeUndefined();
	});
});
describe("idempotency", () => {
	test("same payload replays and changed payload conflicts", () => {
		const store = new IdempotencyStore();
		const id = "command-a" as never;
		expect(store.begin(id, { value: 1 }).kind).toBe("new");
		const outcome = { frame: { v: "omp-app/1", type: "error", code: "x", message: "x" } as never };
		store.complete(id, { value: 1 }, outcome);
		expect(store.begin(id, { value: 1 })).toMatchObject({ kind: "replay" });
		expect(store.begin(id, { value: 2 })).toMatchObject({ kind: "conflict" });
	});
});
describe("appserver lifecycle", () => {
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
	test("every desktop catalog command has a live appserver handler", () => {
		const appserver = createAppserver({
			operationsAuthority: {
				brokerStatus: async () => ({ state: "local", generation: 0 }),
			},
			usageAuthority: {
				read: async () => ({ generatedAt: 0, reports: [], accountsWithoutUsage: [], capacity: {} }),
			},
			projectRootForProject: () => "/tmp/project",
			projectRevealer: async () => true,
		});
		const unhandled = DESKTOP_CATALOG_COMMANDS.filter(command => !appserver.hasDesktopCatalogCommandHandler(command));
		expect(unhandled).toEqual([]);
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
	test("persists ownership after safely promoting an external session", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-promoted-session-restart-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		const transcriptPath = join(root, "promoted-session.jsonl");
		const sid = sessionId("promoted-session-restart");
		const timestamp = "2026-07-23T00:00:00.000Z";
		await writeFile(
			transcriptPath,
			`${JSON.stringify({ type: "session", version: 3, id: sid, cwd: root, timestamp, title: "Promoted session" })}\n`,
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
