import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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
	spawnedSessionPaths: string[] = [];
	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }) {
		this.spawnedSessionPaths.push(spec.session.path);
		const child = new FakeChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
class TransferChild implements ChildHandle {
	#output = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	stdin = { write: () => {} };
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#output.promise;
	}
	kill() {
		if (this.killed) return;
		this.killed = true;
		this.#output.resolve();
		this.#exited.resolve(0);
	}
}
class TransferFactory implements RpcChildFactory {
	children: TransferChild[] = [];
	spawn() {
		const child = new TransferChild();
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
class StatePhaseChild implements ChildHandle {
	#pending: Record<string, unknown>[] = [];
	#drained = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#exited = Promise.withResolvers<number>();
	killed = false;
	todoPhases: unknown = [
		{
			name: "Research",
			tasks: [
				{ content: "Map the call sites", status: "completed" },
				{ content: "Note the shared helper", status: "in_progress" },
				{ content: "Sketch the contract", status: "pending" },
			],
		},
		{
			name: "Implement",
			tasks: [{ content: "Wire the decoder", status: "custom_status" }],
		},
	];
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			if (frame.type !== "get_state") return;
			this.#pending.push(frame);
			this.#drained.resolve();
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		for (;;) {
			if (this.killed) return;
			const frame = this.#pending.shift();
			if (!frame) {
				await Promise.race([this.#drained.promise, this.#finish.promise]);
				this.#drained = Promise.withResolvers<void>();
				continue;
			}
			yield `${JSON.stringify({
				type: "response",
				id: frame.id,
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
					...(this.todoPhases === undefined ? {} : { todoPhases: this.todoPhases }),
				},
			})}\n`;
		}
	}
	kill() {
		this.killed = true;
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
class StatePhaseFactory implements RpcChildFactory {
	children: StatePhaseChild[] = [];
	spawn() {
		const child = new StatePhaseChild();
		this.children.push(child);
		return child;
	}
	argv(path: string) {
		return ["omp", "--mode", "rpc", "--session", path];
	}
}
/**
 * A child that answers prompt and get_state but never emits turn.end,
 * prompt_result, or session_entry — reproducing the silent-supervisor wedge
 * where OMP finishes the turn (isStreaming=false) yet the host never learns
 * completion. SIGTERM is ignored (trapped), so only SIGKILL ends it.
 */
class SilentSupervisorChild implements ChildHandle {
	#pending: Record<string, unknown>[] = [];
	#drained = Promise.withResolvers<void>();
	#finish = Promise.withResolvers<void>();
	#finished = false;
	#exited = Promise.withResolvers<number>();
	#promptReceived = Promise.withResolvers<Record<string, unknown>>();
	killed = false;
	readonly promptReceived = this.#promptReceived.promise;
	stdin = {
		write: (data: string) => {
			const frame = JSON.parse(data) as Record<string, unknown>;
			this.#pending.push(frame);
			if (frame.type === "prompt") this.#promptReceived.resolve(frame);
			this.#drained.resolve();
		},
	};
	stdout: AsyncIterable<string> = this.stream();
	exited = this.#exited.promise;
	private async *stream(): AsyncGenerator<string> {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		for (;;) {
			if (this.killed) return;
			const frame = this.#pending.shift();
			if (!frame) {
				await Promise.race([this.#drained.promise, this.#finish.promise]);
				this.#drained = Promise.withResolvers<void>();
				continue;
			}
			if (frame.type === "prompt") {
				yield `${JSON.stringify({
					type: "response",
					id: frame.id,
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				})}\n`;
			} else if (frame.type === "get_state") {
				yield `${JSON.stringify({
					type: "response",
					id: frame.id,
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
			}
			// Deliberately never emits turn.end / prompt_result / session_entry.
		}
	}
	kill(signal?: string) {
		// SIGTERM is trapped (the wedge); only SIGKILL ends the child.
		if (signal !== "SIGKILL" || this.#finished) return;
		this.killed = true;
		this.#finished = true;
		this.#finish.resolve();
		this.#exited.resolve(0);
	}
}
class SilentSupervisorFactory implements RpcChildFactory {
	children: SilentSupervisorChild[] = [];
	spawn() {
		const child = new SilentSupervisorChild();
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
	test("session.mode.set shapes forwarded prompts, persists, and echoes on the ref", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-session-mode-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		let createCount = 0;
		const sessionAuthority = {
			create: async () => {
				const id = `mode-session-${++createCount}`;
				return {
					...record(id),
					path: join(root, `${id}.jsonl`),
					cwd: root,
					projectId: stableProjectId(root),
				};
			},
			list: async () => [],
			archive: async () => {},
			restore: async () => {},
			delete: async () => {},
		};
		const factory = new DeferredPromptFactory();
		const appserver = createAppserver({
			hostId: host,
			epoch: "session-mode-test",
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
		const PLAN_PREFIX =
			"[PLAN MODE — you may inspect but MUST NOT modify anything: no file writes, edits, patches, or state-changing commands. Analyze the request, then propose a concrete step-by-step plan and stop.]\n\n";
		const READONLY_PREFIX =
			"[READ-ONLY MODE — answer by inspection only: no writes, edits, patches, builds, or commands of any kind.]\n\n";
		try {
			client.sendJson({
				v: "omp-app/1",
				type: "hello",
				protocol: { min: "omp-app/1", max: "omp-app/1" },
				client: { name: "mode-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: [],
				capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");

			const runPrompt = async (mode: "build" | "plan" | "readOnly"): Promise<string> => {
				const projectRoot = stableProjectId(root);
				const reqCreate = `create-${mode}-${createCount + 1}`;
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: reqCreate,
					commandId: `${reqCreate}-command`,
					hostId: host,
					command: "session.create",
					args: { projectId: projectRoot },
				});
				const createResp = await nextResponse(reqCreate);
				expect(createResp).toMatchObject({ ok: true });
				const sid = sessionId((createResp.result as { session: { sessionId: string } }).session.sessionId);

				const reqMode = `mode-${mode}-${createCount}`;
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: reqMode,
					commandId: `${reqMode}-command`,
					hostId: host,
					sessionId: sid,
					command: "session.mode.set",
					args: { mode },
				});
				const modeResp = await nextResponse(reqMode);
				expect(modeResp).toMatchObject({ ok: true, result: { mode } });
				expect(appserver.snapshot(sid)?.ref.mode).toBe(mode === "build" ? undefined : mode);

				const reqPrompt = `prompt-${mode}-${createCount}`;
				client.sendJson({
					v: "omp-app/1",
					type: "command",
					requestId: reqPrompt,
					commandId: `${reqPrompt}-command`,
					hostId: host,
					sessionId: sid,
					command: "session.prompt",
					args: { message: "hello" },
				});
				const child = factory.children.at(-1);
				if (!child) throw new Error("created session did not start its writer");
				const promptFrame = await child.promptReceived;
				child.replyToPrompt();
				await nextResponse(reqPrompt);
				return promptFrame.message as string;
			};

			expect(await runPrompt("plan")).toBe(PLAN_PREFIX + "hello");
			expect(await runPrompt("readOnly")).toBe(READONLY_PREFIX + "hello");
			expect(await runPrompt("build")).toBe("hello");
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
	test("session.state.get surfaces todoPhases reported by the child", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-session-state-phases-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		let createCount = 0;
		const sessionAuthority = {
			create: async () => {
				const id = `state-phase-session-${++createCount}`;
				return {
					...record(id),
					path: join(root, `${id}.jsonl`),
					cwd: root,
					projectId: stableProjectId(root),
				};
			},
			list: async () => [],
			archive: async () => {},
			restore: async () => {},
			delete: async () => {},
		};
		const factory = new StatePhaseFactory();
		const appserver = createAppserver({
			hostId: host,
			epoch: "session-state-phases-test",
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
				client: { name: "state-phases-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: [],
				capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");

			const reqCreate = "create-state-phases";
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: reqCreate,
				commandId: `${reqCreate}-command`,
				hostId: host,
				command: "session.create",
				args: { projectId: stableProjectId(root) },
			});
			const createResp = await nextResponse(reqCreate);
			expect(createResp).toMatchObject({ ok: true });
			const createResult = createResp.result;
			if (!createResult || typeof createResult !== "object" || !("session" in createResult))
				throw new Error("session.create result missing session");
			const sessionShape = createResult.session;
			if (!sessionShape || typeof sessionShape !== "object" || !("sessionId" in sessionShape))
				throw new Error("session.create result missing sessionId");
			const sid = sessionId(sessionShape.sessionId);

			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "state-phases",
				commandId: "state-phases-command",
				hostId: host,
				sessionId: sid,
				command: "session.state.get",
				args: {},
			});
			const stateResp = await nextResponse("state-phases");
			expect(stateResp).toMatchObject({ type: "response", ok: true });
			const stateResult = stateResp.result;
			if (!stateResult || typeof stateResult !== "object" || !("todoPhases" in stateResult))
				throw new Error("session.state.get result missing todoPhases");
			expect(stateResult.todoPhases).toEqual([
				{
					name: "Research",
					tasks: [
						{ content: "Map the call sites", status: "completed" },
						{ content: "Note the shared helper", status: "in_progress" },
						{ content: "Sketch the contract", status: "pending" },
					],
				},
				{
					name: "Implement",
					tasks: [{ content: "Wire the decoder", status: "custom_status" }],
				},
			]);

			// A child that omits todoPhases yields a result without the field.
			const phaseless = factory.children.at(-1);
			if (!phaseless) throw new Error("created session did not start its writer");
			phaseless.todoPhases = undefined;
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "state-no-phases",
				commandId: "state-no-phases-command",
				hostId: host,
				sessionId: sid,
				command: "session.state.get",
				args: {},
			});
			const noPhasesResp = await nextResponse("state-no-phases");
			expect(noPhasesResp).toMatchObject({ type: "response", ok: true });
			const noPhasesResult = noPhasesResp.result;
			expect(
				noPhasesResult && typeof noPhasesResult === "object" && "todoPhases" in noPhasesResult,
			).toBe(false);
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
	test("idle-supervisor watchdog SIGKILLs a silent child and releases the wedged prompt lifecycle", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-idle-supervisor-watchdog-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		const created = {
			...record("silent-supervisor"),
			path: join(root, "silent-supervisor.jsonl"),
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
		const factory = new SilentSupervisorFactory();
		const appserver = createAppserver({
			hostId: host,
			epoch: "idle-supervisor-watchdog-test",
			socketPath,
			discovery: sessionAuthority,
			sessionAuthority,
			sessionOwnershipPath,
			projectRootForProject: () => root,
			childFactory: factory,
			idleSupervisorGraceMs: 60,
			idleSupervisorTickMs: 10,
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
				client: { name: "watchdog-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: [],
				capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "create-watchdog",
				commandId: "create-watchdog-command",
				hostId: host,
				command: "session.create",
				args: { projectId: created.projectId },
			});
			expect(await nextResponse("create-watchdog")).toMatchObject({ ok: true });
			const firstChild = factory.children[0];
			if (!firstChild) throw new Error("created session did not start its writer");

			// First prompt: the child accepts (agentInvoked=true) then goes mute,
			// never emitting turn.end. The lifecycle stays pending.
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-watchdog-1",
				commandId: "prompt-watchdog-1-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "wedge me" },
			});
			await firstChild.promptReceived;
			expect(await nextResponse("prompt-watchdog-1")).toMatchObject({ ok: true, result: { accepted: true } });

			// A second prompt while the first lifecycle is wedged must be busy.
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-watchdog-busy",
				commandId: "prompt-watchdog-busy-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "still busy" },
			});
			expect(await nextResponse("prompt-watchdog-busy")).toMatchObject({
				ok: false,
				error: { code: "session_busy" },
			});

			// Wait for the watchdog to dispose the silent supervisor: the runtime
			// is marked crashed then restartable (status settles to idle) and the
			// child is SIGKILLed.
			await Promise.race([
				(async () => {
					while (appserver.snapshot(created.sessionId)?.ref.status === "active") await Bun.sleep(5);
				})(),
				Bun.sleep(2_000).then(() => {
					throw new Error("watchdog did not release the wedged session");
				}),
			]);
			expect(firstChild.killed).toBe(true);

			// After grace the session accepts a new prompt instead of session_busy.
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-watchdog-2",
				commandId: "prompt-watchdog-2-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "after grace" },
			});
			// The host processes the command asynchronously; wait for it to
			// restart the supervisor (spawn a fresh child) and accept the prompt.
			const secondChild = await Promise.race([
				(async () => {
					while (factory.children.at(-1) === undefined || factory.children.at(-1) === firstChild)
						await Bun.sleep(5);
					return factory.children.at(-1)!;
				})(),
				Bun.sleep(2_000).then(() => {
					throw new Error("watchdog did not restart the supervisor");
				}),
			]);
			await secondChild.promptReceived;
			expect(await nextResponse("prompt-watchdog-2")).toMatchObject({ ok: true, result: { accepted: true } });
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
	test("state-refresh reconciliation releases a wedged prompt lifecycle without killing the child", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-state-refresh-reconcile-"));
		const socketPath = join(root, "run", "appserver.sock");
		const sessionOwnershipPath = join(root, "profile", "owned-sessions.json");
		const created = {
			...record("reconcile-supervisor"),
			path: join(root, "reconcile-supervisor.jsonl"),
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
		const factory = new SilentSupervisorFactory();
		// A grace window large enough that the watchdog never fires during the
		// test: only the explicit state refresh reconciles the stale lifecycle.
		const appserver = createAppserver({
			hostId: host,
			epoch: "state-refresh-reconcile-test",
			socketPath,
			discovery: sessionAuthority,
			sessionAuthority,
			sessionOwnershipPath,
			projectRootForProject: () => root,
			childFactory: factory,
			idleSupervisorGraceMs: 60,
			idleSupervisorTickMs: 10_000,
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
				client: { name: "reconcile-test", version: "1", build: "test", platform: "linux" },
				requestedFeatures: [],
				capabilities: { client: ["sessions.manage", "sessions.read", "sessions.prompt"] },
				savedCursors: [],
			});
			expect(await client.nextServer()).toMatchObject({ type: "welcome" });
			expect((await client.nextServer()).type).toBe("sessions");
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "create-reconcile",
				commandId: "create-reconcile-command",
				hostId: host,
				command: "session.create",
				args: { projectId: created.projectId },
			});
			expect(await nextResponse("create-reconcile")).toMatchObject({ ok: true });
			const child = factory.children[0];
			if (!child) throw new Error("created session did not start its writer");

			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-reconcile-1",
				commandId: "prompt-reconcile-1-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "wedge me" },
			});
			await child.promptReceived;
			expect(await nextResponse("prompt-reconcile-1")).toMatchObject({ ok: true, result: { accepted: true } });

			// Before grace, a state refresh sees isStreaming=false but the
			// lifecycle is not yet stale, so it must stay pending (busy).
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "state-before-grace",
				commandId: "state-before-grace-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.state.get",
				args: {},
			});
			expect(await nextResponse("state-before-grace")).toMatchObject({ ok: true });
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-reconcile-busy",
				commandId: "prompt-reconcile-busy-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "still busy" },
			});
			expect(await nextResponse("prompt-reconcile-busy")).toMatchObject({
				ok: false,
				error: { code: "session_busy" },
			});

			// After grace, a state refresh reconciles the stale lifecycle: OMP
			// finished (isStreaming=false) so the transient is released honestly
			// and the session settles to idle — without killing the child.
			// Cross the grace window on the real platform clock: the watchdog and
			// lifecycle timestamps use Date.now/setInterval, so deterministic fake
			// timers cannot drive them without rewiring the host clock injection.
			await Bun.sleep(80);
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "state-after-grace",
				commandId: "state-after-grace-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.state.get",
				args: {},
			});
			expect(await nextResponse("state-after-grace")).toMatchObject({ ok: true });
			expect(child.killed).toBe(false);
			await Promise.race([
				(async () => {
					while (appserver.snapshot(created.sessionId)?.ref.status === "active") await Bun.sleep(5);
				})(),
				Bun.sleep(1_000).then(() => {
					throw new Error("reconciliation did not settle the wedged session");
				}),
			]);

			// The same child (still alive) now accepts a new prompt.
			client.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId: "prompt-reconcile-2",
				commandId: "prompt-reconcile-2-command",
				hostId: host,
				sessionId: created.sessionId,
				command: "session.prompt",
				args: { message: "after reconcile" },
			});
			await child.promptReceived;
			expect(await nextResponse("prompt-reconcile-2")).toMatchObject({ ok: true, result: { accepted: true } });
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
});
