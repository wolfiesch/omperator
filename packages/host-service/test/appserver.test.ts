import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_CATALOG_COMMANDS, type DurableEntry, hostId, projectId, sessionId } from "@t4-code/host-wire";
import { completeAttachOutput, prepareAttachOutput } from "../src/attach-output.ts";
import { IdempotencyStore } from "../src/idempotency.ts";
import { ensureSecureSocketDirectory } from "../src/ownership.ts";
import { FileSessionDiscovery, realFs } from "../src/discovery.ts";
import { SessionProjection } from "../src/projection.ts";
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
			"prompt.images",
			"agent.transcript",
			"session.observer",
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
				requestedFeatures: ["session.observer", "transcript.page"],
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
				mode: "reconciling",
				transcript: "live",
			});
			expect(factory.children).toHaveLength(0);
		} finally {
			client.destroy();
			await client.closed();
			await appserver.stop();
			await rm(root, { recursive: true, force: true });
		}
	});
});
