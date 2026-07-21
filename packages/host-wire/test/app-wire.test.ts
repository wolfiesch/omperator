import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
	ADDITIVE_FEATURES,
	APP_WIRE_VERSION,
	AppWireError,
	COMMAND_ARGUMENT_DECODERS,
	COMMAND_DESCRIPTORS,
	COMMAND_RESULT_DECODERS,
	DESKTOP_CATALOG_COMMANDS,
	decodeAdditiveServerFrame,
	decodeArtifactDescriptor,
	decodeClientFrame,
	decodeCommandArguments,
	decodeCommandResult,
	decodeDurableEntryFrame,
	decodeEntry,
	decodeServerFrame,
	decodeSessionListResult,
	decodeSessionRef,
	decodeOperationCapability,
	decodeTurnReviewSnapshot,
	deviceToken,
	IMAGE_UPLOAD_CHUNK_BYTES,
	inputObject,
	isSecretLikeKey,
	isServerFrame,
	MAX_ARRAY_ITEMS,
	MAX_FILE_BYTES,
	MAX_INPUT_BYTES,
	MAX_MAP_KEYS,
	PREVIEW_CAPTURE_CHUNK_BYTES,
	PROMPT_IMAGE_MAX_COUNT,
	PROTOCOL_FEATURES,
	safeRelativePath,
	sameSession,
	TRANSCRIPT_IMAGE_CHUNK_BYTES,
	TRANSCRIPT_IMAGE_MAX_BYTES,
	validateCommandDescriptor,
} from "../src/index.js";

const operationCapabilityFixture = new URL("./fixtures/operation-capabilities.json", import.meta.url);
const root = new URL("../fixtures/v1/", import.meta.url);
async function fixture(name: string): Promise<unknown> {
	return JSON.parse(await Bun.file(new URL(name, root)).text()) as unknown;
}

function previewSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		previewId: "preview-1",
		state: "ready",
		url: "https://example.com/",
		revision: "preview-revision-1",
		cursor: { epoch: "preview-1", seq: 1 },
		...overrides,
	};
}

describe("app-wire authority", () => {
	const hello = {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "desktop", version: "1", build: "b", platform: "linux" },
		requestedFeatures: ["resume"],
		savedCursors: [{ hostId: "h", sessionId: "s", cursor: { epoch: "e1", seq: 1 } }],
	};
	test("every canonical golden decodes through public guards", async () => {
		const files = (await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: fileURLToPath(root) })))
			.filter(name => !name.endsWith(".invalid.json"))
			.sort();
		const client = new Set([
			"hello.json",
			"hello-auth.json",
			"command.json",
			"confirmation.json",
			"pair-start.json",
			"host-list.json",
			"ping.json",
			"transcript-search-request.json",
			"transcript-context-request.json",
		]);
		for (const name of files) {
			const value = await fixture(name);
			if (name === "entry.json") decodeEntry(value);
			else if (client.has(name)) decodeClientFrame(value);
			else expect(isServerFrame(value)).toBe(true);
		}
	});
	test("Agent View lifecycle corpus decodes through the public server guard", async () => {
		const scenario = (await fixture("scenarios/agent-view-lifecycle.json")) as {
			schema: unknown;
			frames: unknown;
		};
		expect(scenario.schema).toBe("agent-view/1");
		expect(Array.isArray(scenario.frames)).toBe(true);
		if (!Array.isArray(scenario.frames)) throw new Error("Agent View fixture frames must be an array");
		const frames = scenario.frames.map(frame => decodeServerFrame(frame));
		expect(frames.map(frame => frame.type)).toEqual(Array(6).fill("agent"));
		expect(
			frames.map(frame => (frame.type === "agent" ? [frame.agentId, frame.state, frame.detail.resumable] : null)),
		).toEqual([
			["WorkerA", "started", false],
			["WorkerA", "running", false],
			["WorkerA", "completed", false],
			["WorkerA", "parked", true],
			["WorkerA", "started", true],
			["WorkerA", "cancelled", false],
		]);
	});
	test("operation capability corpus distinguishes execution classes and explicit rejections", async () => {
		const scenario = JSON.parse(await Bun.file(operationCapabilityFixture).text()) as {
			schema: unknown;
			catalog: unknown;
			rejections: unknown;
		};
		expect(scenario.schema).toBe("operation-capabilities/1");
		const catalog = decodeServerFrame(scenario.catalog) as unknown as Record<string, unknown>;
		expect(catalog.type).toBe("response");
		expect(catalog.ok).toBe(true);
		const result = catalog.result as Record<string, unknown>;
		expect(result.revision).toBe("capabilities-v1");
		const operations = result.operations as Array<Record<string, unknown>>;
		expect(operations.map(operation => [operation.operationId, operation.execution, operation.supported])).toEqual([
			["session.prompt", "typed", true],
			["slash.compact", "headless", true],
			["slash.plan", "terminal-only", false],
			["goal.create", "unavailable", false],
		]);
		expect(
			operations.slice(2).map(operation => (operation.disabledReason as Record<string, unknown>).code),
		).toEqual(["terminal_only", "capability_unavailable"]);
		expect(Array.isArray(scenario.rejections)).toBe(true);
		const rejections = (scenario.rejections as unknown[]).map(frame => {
			const decoded = decodeServerFrame(frame) as unknown as Record<string, unknown>;
			expect(decoded.type).toBe("response");
			expect(decoded.ok).toBe(false);
			return decoded.error as Record<string, unknown>;
		});
		expect(rejections.map(error => error.code)).toEqual(["terminal_only", "capability_unavailable"]);
	});
	test("operation capabilities reject ambiguous availability states", () => {
		const operation = {
			operationId: "slash.compact",
			label: "/compact",
			execution: "headless",
			supported: true,
		};
		expect(decodeOperationCapability(operation, "operation")).toMatchObject(operation);
		for (const invalid of [
			{ ...operation, operationId: undefined },
			{ ...operation, label: undefined },
			{ ...operation, execution: "future" },
			{ ...operation, supported: "yes" },
			{ ...operation, supported: false },
			{ ...operation, disabledReason: { code: "terminal_only", message: "not disabled" } },
			{ ...operation, execution: "terminal-only", supported: true },
			{
				...operation,
				supported: false,
				disabledReason: { code: 42, message: "invalid code" },
			},
		])
			expect(() => decodeOperationCapability(invalid, "operation")).toThrow(AppWireError);
	});
	test("session list metadata remains bounded at the wire cap", () => {
		const sessions = Array.from({ length: 1_000 }, (_, index) => ({
			hostId: "h",
			sessionId: `session-${index}`,
			project: { projectId: "project-test" },
			revision: "revision-test",
			title: `Session ${index}`,
			status: "idle",
			updatedAt: new Date(index).toISOString(),
		}));
		const result = decodeSessionListResult({
			cursor: { epoch: "epoch", seq: 0 },
			sessions,
			totalCount: 5_000,
			truncated: true,
			future: "keep",
		});
		expect(result.sessions).toHaveLength(1_000);
		expect(result.totalCount).toBe(5_000);
		expect(result.truncated).toBe(true);
		expect((result as unknown as Record<string, unknown>).future).toBe("keep");
	});
	test("session attention is a strict bounded additive contract", () => {
		const base = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p" },
			revision: "r",
			title: "Task",
			status: "idle",
			updatedAt: "2026-07-18T12:00:00.000Z",
		};
		const attention = {
			pending: [
				{
					kind: "approval",
					id: "approval-1",
					title: "Run command",
					summary: "Approve the safe operation",
					requestedAt: "2026-07-18T12:01:00.000Z",
				},
				{
					kind: "question",
					id: "question-1",
					question: "Which option?",
					options: [{ id: "one", label: "One" }],
					allowText: true,
					requestedAt: "2026-07-18T12:02:00.000Z",
				},
			],
			pendingCount: 3,
			truncated: true,
			latestOutcome: {
				id: "agent-end:2026-07-18T12:00:00.000Z",
				kind: "completed",
				at: "2026-07-18T12:00:00.000Z",
				summary: "Agent completed work.",
			},
		};
		expect(decodeSessionRef({ ...base, attention }, "session")).toMatchObject({ attention });

		for (const invalid of [
			{ ...attention, pendingCount: 1 },
			{ ...attention, pendingCount: 2, truncated: true },
			{ ...attention, pendingCount: 3, truncated: false },
			{
				...attention,
				pending: [{ ...attention.pending[0], requestedAt: "2026-07-18T12:01:00Z" }],
				pendingCount: 1,
				truncated: false,
			},
			{
				...attention,
				pending: [attention.pending[0], { ...attention.pending[1], id: "approval-1" }],
				pendingCount: 2,
				truncated: false,
			},
			{ ...attention, credential: "must-not-cross" },
		])
			expect(() => decodeSessionRef({ ...base, attention: invalid }, "session")).toThrow(AppWireError);

		expect(() =>
			decodeSessionRef(
				{
					...base,
					attention: {
						pending: Array.from({ length: 9 }, (_, index) => ({
							kind: "question",
							id: `q-${index}`,
							question: "Question",
							options: [],
							allowText: true,
							requestedAt: "2026-07-18T12:00:00.000Z",
						})),
						pendingCount: 9,
						truncated: false,
					},
				},
				"session",
			),
		).toThrow(AppWireError);
	});
	test("session runtime projection is exact and bounded", () => {
		const base = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p" },
			revision: "r",
			title: "Task",
			status: "idle",
			updatedAt: "2026-07-18T12:00:00.000Z",
		};
		expect(
			decodeSessionRef(
				{ ...base, runtime: { id: "external-runtime", workspaceInstanceId: "workspace-instance" } },
				"session",
			).runtime,
		).toEqual({ id: "external-runtime", workspaceInstanceId: "workspace-instance" });
		expect(decodeSessionRef({ ...base, runtime: { id: "native-runtime" } }, "session").runtime).toEqual({
			id: "native-runtime",
		});
		for (const runtime of [
			{},
			{ workspaceInstanceId: "workspace-instance" },
			{ id: "runtime", providerSessionId: "provider-session" },
			{ id: "runtime", cwd: "src/project" },
			{ id: "x".repeat(65) },
			{ id: "runtime", workspaceInstanceId: "x".repeat(129) },
		])
			expect(() => decodeSessionRef({ ...base, runtime }, "session")).toThrow(AppWireError);
	});
	test("hello and durable lineage decode in string and parsed modes", () => {
		expect(decodeClientFrame(hello).type).toBe("hello");
		for (const protocol of [
			{ min: "omp-app/1", max: "omp-app/2" },
			{ min: "omp-app/1", max: "omp-app/10" },
		])
			expect(decodeClientFrame({ ...hello, protocol }).type).toBe("hello");
		for (const protocol of [
			{ min: "omp-app/2", max: "omp-app/1" },
			{ min: "omp-app/x", max: "omp-app/2" },
		])
			expect(() => decodeClientFrame({ ...hello, protocol })).toThrow(AppWireError);
		const frame = {
			v: "omp-app/1",
			type: "entry",
			cursor: { epoch: "e1", seq: 2 },
			revision: "rev-2",
			hostId: "h",
			sessionId: "s",
			entry: {
				id: "i2",
				parentId: "i1",
				hostId: "h",
				sessionId: "s",
				kind: "message",
				timestamp: "2026-01-01T00:00:00Z",
				data: { text: "ok" },
			},
		};
		expect(decodeDurableEntryFrame(JSON.stringify(frame)).entry.parentId).toBe("i1");
		expect(decodeDurableEntryFrame(new TextEncoder().encode(JSON.stringify(frame))).revision).toBe("rev-2");
	});
	test("hello preserves unknown additive feature requests while welcome grants stay strict", async () => {
		const futureHello = decodeClientFrame({ ...hello, requestedFeatures: ["resume", "future.client.feature"] });
		expect(futureHello.type).toBe("hello");
		if (futureHello.type !== "hello") throw new Error("expected hello frame");
		expect(futureHello.requestedFeatures).toEqual(["resume", "future.client.feature"]);
		const welcome = (await fixture("welcome.json")) as Record<string, unknown>;
		const transcriptWelcome = decodeServerFrame({
			...welcome,
			grantedFeatures: ["resume", "agent.transcript"],
		});
		expect(transcriptWelcome).toMatchObject({
			type: "welcome",
			grantedFeatures: ["resume", "agent.transcript"],
		});
		expect(() => decodeServerFrame({ ...welcome, grantedFeatures: ["resume", "future.server.feature"] })).toThrow(
			AppWireError,
		);
	});
	test("cursor epochs are opaque bounded strings", () => {
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "event",
				cursor: { epoch: 1, seq: 1 },
				hostId: "h",
				sessionId: "s",
				event: { type: "x" },
			}),
		).toThrow(AppWireError);
	});
	test("unknown families, duplicate keys, invalid UTF-8 and cycles reject", () => {
		expect(() => decodeServerFrame({ v: "omp-app/1", type: "future" })).toThrow(AppWireError);
		expect(() => inputObject('{"a":1,"a":2}')).toThrow(AppWireError);
		expect(() => inputObject(new Uint8Array([0xff]))).toThrow(AppWireError);
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => inputObject(cycle)).toThrow(AppWireError);
	});
	test("malformed object-key escapes surface as protocol errors", () => {
		let caught: unknown;
		try {
			inputObject(String.raw`{"\uZZZZ":1}`);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AppWireError);
		if (!(caught instanceof AppWireError)) throw new Error("expected an AppWireError");
		expect(caught.code).toBe("INVALID_JSON");
	});
	test("settings preserve __proto__ as an own data property", () => {
		const metadata = { configured: true, sensitive: false };
		const result = decodeCommandResult("settings.read", {
			revision: "revision-1",
			settings: Object.fromEntries([["__proto__", metadata]]),
		});
		const settings = result.settings as Record<string, unknown>;
		expect(Object.getOwnPropertyDescriptor(settings, "__proto__")).toEqual({
			value: metadata,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		expect(Object.getPrototypeOf(settings)).toBe(Object.prototype);
	});
	test("paths and protocol controls are safe", () => {
		expect(safeRelativePath("src/a.ts")).toBe("src/a.ts");
		for (const path of ["/etc/passwd", "../x", "a/../x", "C:/x", "\\\\server\\x", "a\\b"])
			expect(() => safeRelativePath(path)).toThrow(AppWireError);
	});
	test("input byte limit and additive fields", () => {
		expect(() => decodeServerFrame(`{${"x".repeat(MAX_INPUT_BYTES)}`)).toThrow(AppWireError);
		const raw = {
			v: "omp-app/1",
			type: "event",
			cursor: { epoch: "e", seq: 1 },
			hostId: "h",
			sessionId: "s",
			event: { type: "future", added: true },
			addedByFuture: { safe: true },
		};
		expect((decodeServerFrame(raw) as Record<string, unknown>).addedByFuture).toEqual({ safe: true });
	});
	test("parsed-object approximate byte accounting covers keys and primitive values", () => {
		const huge = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["k".repeat(60_000) + i, 1]));
		expect(() => inputObject(huge)).toThrow(AppWireError);
	});
	test("entry identity and empty file content are validated", () => {
		const entry = {
			id: "entry",
			parentId: null,
			hostId: "h",
			sessionId: "s",
			kind: "message",
			timestamp: "now",
			data: {},
		};
		expect(() => decodeEntry({ ...entry, id: undefined })).toThrow(AppWireError);
		expect(() => decodeEntry({ ...entry, parentId: 1 })).toThrow(AppWireError);
		expect(() => decodeEntry({ ...entry, parentId: "" })).toThrow(AppWireError);
		const cyclicData: Record<string, unknown> = {};
		cyclicData.self = cyclicData;
		const legacyPathCall = decodeEntry as unknown as (value: unknown, path: string) => unknown;
		expect(() => legacyPathCall({ ...entry, data: cyclicData }, "entries[0]")).toThrow(AppWireError);
		expect(
			decodeServerFrame({ v: "omp-app/1", type: "files", hostId: "h", sessionId: "s", path: "empty", content: "" }),
		).toMatchObject({ path: "empty" });
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "files",
				hostId: "h",
				sessionId: "s",
				path: "x",
				content: "é".repeat(700000),
			}),
		).toThrow(AppWireError);
	});
	test("command scopes fail closed and file/frame bounds stay ordered", () => {
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "unknown",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "session.list",
				args: {},
			}),
		).not.toThrow();
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				command: "session.prompt",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "session.list",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "files.write",
				args: {},
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "files.write",
				args: { path: "a", content: "x" },
			}),
		).toThrow(AppWireError);
		const base = { v: "omp-app/1", type: "command", requestId: "r", commandId: "c", hostId: "h", args: {} } as const;
		expect(() =>
			decodeClientFrame({ ...base, command: "session.create", args: { projectId: "project-1" } }),
		).not.toThrow();
		expect(() =>
			decodeClientFrame({
				...base,
				command: "session.create",
				args: { projectId: "project-1", runtimeId: "external-runtime", workspaceInstanceId: "workspace-instance" },
			}),
		).not.toThrow();
		for (const args of [
			{ projectId: "project-1", runtimeId: "external-runtime" },
			{ projectId: "project-1", workspaceInstanceId: "workspace-instance" },
		])
			expect(() => decodeClientFrame({ ...base, command: "session.create", args })).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({ ...base, command: "project.reveal", args: { projectId: "project-1" } }),
		).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "project.reveal", args: { cwd: "/tmp/project" } })).toThrow(
			AppWireError,
		);
		for (const args of [
			{ projectId: "project-1", cwd: "/tmp/project" },
			{ projectId: "project-1", path: "src/project" },
			{ projectId: "project-1", workspacePath: "src/project" },
			{ projectId: "project-1", executable: "provider" },
			{ projectId: "project-1", providerSessionId: "provider-session" },
		])
			expect(() => decodeClientFrame({ ...base, command: "session.create", args })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("term.open", { cwd: "/tmp/project" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("term.open", { cwd: "../project" })).toThrow(AppWireError);
		expect(decodeCommandArguments("term.open", { cwd: "src/project" }).cwd).toBe("src/project");
		expect(() => decodeClientFrame({ ...base, command: "session.attach" })).toThrow(AppWireError);
		expect(() => decodeClientFrame({ ...base, sessionId: "s", command: "session.attach" })).not.toThrow();
		expect(() => decodeClientFrame({ ...base, command: "session.create", expectedRevision: "rev" })).toThrow(
			AppWireError,
		);
		expect(COMMAND_DESCRIPTORS["session.create"]).toEqual({
			capability: "sessions.manage",
			scope: "host",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
			desktopCatalog: true,
		});
		expect(COMMAND_DESCRIPTORS["project.reveal"]).toEqual({
			capability: "sessions.manage",
			scope: "host",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
			desktopCatalog: true,
		});
		expect(COMMAND_DESCRIPTORS["session.attach"]).toEqual({
			capability: "sessions.read",
			scope: "session",
			revision: "none",
			revisionOwner: "none",
			confirmation: "none",
		});
		expect(Object.values(COMMAND_DESCRIPTORS).every(descriptor => typeof descriptor.capability === "string")).toBe(
			true,
		);
		expect(decodeCommandArguments("runtime.list", {})).toEqual({});
		expect(
			decodeCommandArguments("workspace.create", {
				projectId: "project-1",
				name: "review",
				branch: "agent/review",
				sourceCommit: "HEAD",
			}),
		).toMatchObject({ projectId: "project-1", name: "review", branch: "agent/review", sourceCommit: "HEAD" });
		expect(() =>
			decodeCommandArguments("workspace.create", {
				projectId: "project-1",
				name: "review",
				branch: "agent/review",
				sourceCommit: "HEAD",
				targetPath: "/tmp/escape",
			}),
		).toThrow(AppWireError);
		expect(COMMAND_DESCRIPTORS["workspace.archive"]?.confirmation).toBe("challenge");
		const runtimeResult = {
			id: "omp",
			displayName: "Oh My Pi",
			command: { executable: "omp", arguments: [], cwdArgument: "--cwd" },
			capabilities: { prompt: "native" },
			availability: { state: "available" },
		};
		expect(decodeCommandResult("runtime.list", { runtimes: [runtimeResult] }).runtimes).toHaveLength(1);
		expect(
			decodeCommandResult("runtime.list", {
				runtimes: [{ ...runtimeResult, availability: { state: "unknown" } }],
			}).runtimes,
		).toHaveLength(1);
		for (const invalid of [
			{ runtimes: [{ ...runtimeResult, canonicalPath: "/private/path" }] },
			{ runtimes: [{ ...runtimeResult, capabilities: { prompt: "maybe" } }] },
			{ runtimes: [{ ...runtimeResult, availability: { state: "unknown", executable: "unexpected" } }] },
			{ runtimes: [runtimeResult], extra: true },
		])
			expect(() => decodeCommandResult("runtime.list", invalid)).toThrow(AppWireError);
		const workspaceResult = {
			repositoryId: "project-1",
			instanceId: "workspace-1",
			ownership: "managed",
			branch: "agent/review",
			sourceCommit: "a".repeat(40),
			expectedHead: "b".repeat(40),
			lifecycle: "active",
			createdAt: 1,
			updatedAt: 2,
		};
		expect(decodeCommandResult("workspace.list", { workspaces: [workspaceResult] }).workspaces).toHaveLength(1);
		for (const invalid of [
			{ workspaces: [{ ...workspaceResult, canonicalPath: "/private/path" }] },
			{ workspaces: [{ ...workspaceResult, ownership: "unknown" }] },
			{ workspaces: [{ ...workspaceResult, lifecycle: "unknown" }] },
		])
			expect(() => decodeCommandResult("workspace.list", invalid)).toThrow(AppWireError);
		expect(MAX_FILE_BYTES).toBeLessThan(MAX_INPUT_BYTES);
	});
	test("welcome identity requires every version and build field", async () => {
		const welcome = (await fixture("welcome.json")) as Record<string, unknown>;
		for (const field of ["ompVersion", "ompBuild", "appserverVersion", "appserverBuild"]) {
			expect(() => decodeServerFrame({ ...welcome, [field]: undefined })).toThrow(AppWireError);
			expect(() => decodeServerFrame({ ...welcome, [field]: "bad\nidentity" })).toThrow(AppWireError);
		}
	});
	test("session lifecycle commands require revision, use empty args, and decode exact results", () => {
		for (const name of ["session.archive", "session.restore"] as const) {
			expect(COMMAND_DESCRIPTORS[name]).toEqual({
				capability: "sessions.manage",
				scope: "session",
				revision: "required",
				revisionOwner: "session",
				confirmation: "none",
				desktopCatalog: true,
			});
		}
		expect(COMMAND_DESCRIPTORS["session.delete"]).toEqual({
			capability: "sessions.manage",
			scope: "session",
			revision: "required",
			revisionOwner: "session",
			confirmation: "challenge",
			desktopCatalog: true,
		});
		expect(COMMAND_DESCRIPTORS["session.close"]).toEqual({
			capability: "sessions.manage",
			scope: "session",
			revision: "required",
			revisionOwner: "session",
			confirmation: "challenge",
			desktopCatalog: true,
		});
		for (const name of ["session.archive", "session.restore", "session.delete"] as const) {
			expect(decodeCommandArguments(name, {})).toEqual({});
			expect(() => decodeCommandArguments(name, { leaseId: "lease" })).toThrow(AppWireError);
		}
		expect(decodeCommandArguments("session.close", {})).toEqual({});
		expect(decodeCommandArguments("session.close", { leaseId: "lease" })).toEqual({ leaseId: "lease" });
		expect(() => decodeCommandArguments("session.close", { extra: true })).toThrow(AppWireError);
		expect(decodeCommandResult("session.archive", { archived: true })).toEqual({ archived: true });
		expect(decodeCommandResult("session.restore", { restored: true })).toEqual({ restored: true });
		expect(decodeCommandResult("session.delete", { deleted: true })).toEqual({ deleted: true });
		expect(decodeCommandResult("session.close", { closed: true })).toEqual({ closed: true });
		expect(() => decodeCommandResult("session.delete", { deleted: true, sessionId: "s" })).toThrow(AppWireError);
		const base = {
			v: "omp-app/1",
			type: "command",
			requestId: "r",
			commandId: "c",
			hostId: "h",
			sessionId: "s",
			args: {},
		};
		expect(() => decodeClientFrame({ ...base, command: "session.archive" })).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({ ...base, command: "session.archive", expectedRevision: "revision" }),
		).not.toThrow();
	});
	test("archivedAt is canonical ISO metadata and sessions host identity remains additive", () => {
		const session = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p" },
			revision: "r",
			title: "Archived",
			status: "idle",
			updatedAt: "now",
			archivedAt: "2026-07-13T12:34:56.000Z",
		};
		const legacy = {
			v: "omp-app/1",
			type: "sessions",
			cursor: { epoch: "e", seq: 0 },
			sessions: [session],
		};
		expect(decodeServerFrame(legacy)).toMatchObject({ sessions: [{ archivedAt: session.archivedAt }] });
		expect(decodeServerFrame({ ...legacy, hostId: "h" })).toMatchObject({ hostId: "h" });
		expect(() => decodeServerFrame({ ...legacy, hostId: 1 })).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...legacy, sessions: [{ ...session, archivedAt: "next Tuesday" }] })).toThrow(
			AppWireError,
		);
	});
	test("exports the bridge schema version independently from the T4 package release", async () => {
		const metadata = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as { version: string };
		expect(APP_WIRE_VERSION).toBe("0.7.0");
		expect(metadata.version).toBe("0.1.30");
	});
	test("session project wire data is opaque and live state is secret-free", () => {
		const providerTransport = {
			provider: "openai-codex",
			configuredPolicy: "auto",
			websocketPreferred: true,
			lastTransport: "websocket",
			websocketDisabled: false,
			websocketConnected: true,
			fallbackCount: 0,
			canAppend: true,
			prewarmed: true,
			hasSessionState: true,
			hasTurnState: true,
			fullContextRequests: 2,
			deltaRequests: 19,
			inputJsonBytes: 78_297,
			lastInputJsonBytes: 126,
		};
		const session = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p", name: "Demo" },
			revision: "r",
			title: "Demo",
			status: "idle",
			updatedAt: "now",
			liveState: { phase: "work", phaseLabel: "human", providerTransport },
		};
		const frame = { v: "omp-app/1", type: "sessions", cursor: { epoch: "e", seq: 1 }, sessions: [session] };
		const decoded = decodeServerFrame(frame);
		expect(decoded).toMatchObject({ sessions: [{ liveState: { providerTransport } }] });
		expect(JSON.stringify(decoded)).not.toContain("canonicalCwd");
		expect(
			JSON.stringify(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [session] })),
		).not.toContain("/workspace");
		expect(() =>
			decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { deviceToken: "x" } }] }),
		).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { nested: { session_key: "x" } } }] }),
		).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({ ...frame, sessions: [{ ...session, liveState: { nested: { "session.key": "x" } } }] }),
		).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({
				...frame,
				sessions: [
					{
						...session,
						liveState: { providerTransport: { ...providerTransport, configuredPolicy: "sometimes" } },
					},
				],
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({
				...frame,
				sessions: [{ ...session, liveState: { providerTransport: { ...providerTransport, accessToken: "x" } } }],
			}),
		).toThrow(AppWireError);
	});
	test("session observer control is additive, categorical, and exact", () => {
		expect(ADDITIVE_FEATURES).toContain("session.observer");
		expect(PROTOCOL_FEATURES).toContain("session.observer");
		const session = {
			hostId: "h",
			sessionId: "s",
			project: { projectId: "p" },
			revision: "r",
			title: "Observed",
			status: "idle",
			updatedAt: "now",
		};
		const frame = (sessionControl: unknown) => ({
			v: "omp-app/1",
			type: "sessions",
			cursor: { epoch: "e", seq: 1 },
			sessions: [{ ...session, liveState: { sessionControl } }],
		});
		for (const lockStatus of ["live", "suspect", "malformed"])
			expect(() => decodeServerFrame(frame({ mode: "observer", lockStatus, transcript: "live" }))).not.toThrow();
		expect(() => decodeServerFrame(frame({ mode: "reconciling", transcript: "snapshot" }))).not.toThrow();
		for (const invalid of [
			null,
			{ mode: "observer", transcript: "live" },
			{ mode: "observer", lockStatus: "future", transcript: "live" },
			{ mode: "future", transcript: "live" },
			{ mode: "reconciling", transcript: "future" },
			{ mode: "reconciling", transcript: "live", path: "/secret" },
		])
			expect(() => decodeServerFrame(frame(invalid))).toThrow(AppWireError);
	});
	test("secret-like metadata keys cannot hide behind separators", () => {
		for (const key of [
			"api.key",
			"api_key",
			"API KEY",
			"private/key",
			"session:key",
			"pass.word",
			"to\u200bken",
			"ＡＰＩ．ＫＥＹ",
		])
			expect(isSecretLikeKey(key)).toBe(true);
		for (const key of ["public.key", "api.version", "session.id"]) expect(isSecretLikeKey(key)).toBe(false);
		expect(() => decodeCommandArguments("settings.write", { values: { "api.key": "must-not-cross" } })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("config.write", { provider: { "private/key": "must-not-cross" } })).toThrow(
			AppWireError,
		);
		expect(decodeCommandArguments("config.write", { provider: { "public.key": "visible", version: 1 } })).toEqual({
			provider: { "public.key": "visible", version: 1 },
		});
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "catalog",
				hostId: "h",
				revision: "r",
				items: [{ id: "tool", kind: "tool", name: "shell", metadata: { "api\u200bkey": "must-not-cross" } }],
			}),
		).toThrow(AppWireError);
	});
	test("malicious secret metadata fixture is rejected", async () => {
		const malicious = await fixture("session-secret.invalid.json");
		expect(() => decodeServerFrame(malicious)).toThrow(AppWireError);
	});
	test("session delta removals cannot target another session", () => {
		const delta = {
			v: "omp-app/1",
			type: "session.delta",
			hostId: "h",
			sessionId: "s",
			cursor: { epoch: "e", seq: 1 },
			revision: "r",
			remove: "s",
		};
		expect(decodeAdditiveServerFrame(delta)).toMatchObject({ sessionId: "s", remove: "s" });
		expect(() => decodeAdditiveServerFrame({ ...delta, remove: "other" })).toThrow(AppWireError);
	});
	test("pairing success requires a bounded expiration and preserves it", async () => {
		const pairing = (await fixture("pairing.json")) as Record<string, unknown>;
		expect(decodeServerFrame(pairing)).toMatchObject({
			type: "pair.ok",
			expiresAt: pairing.expiresAt,
		});
		const missingExpiration = { ...pairing };
		delete missingExpiration.expiresAt;
		expect(() => decodeServerFrame(missingExpiration)).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...pairing, expiresAt: 1 })).toThrow(AppWireError);
		expect(() => decodeServerFrame({ ...pairing, expiresAt: "x".repeat(129) })).toThrow(AppWireError);
	});
	test("preview captures carry bounded metadata instead of inline browser bytes", async () => {
		const capture = (await fixture("preview-capture.json")) as Record<string, unknown>;
		expect(decodeServerFrame(capture)).toMatchObject({
			type: "preview.capture",
			capture: { captureId: "capture-1", mimeType: "image/png", size: 1 },
		});
		const missingMetadata = { ...capture };
		delete missingMetadata.capture;
		expect(() => decodeServerFrame(missingMetadata)).toThrow(AppWireError);
		expect(() =>
			decodeServerFrame({
				...capture,
				capture: { ...(capture.capture as Record<string, unknown>), mimeType: "text/html" },
			}),
		).toThrow(AppWireError);
	});
	test("authenticated hello fixtures reject partial/bad auth without echoing token", async () => {
		const partial = await fixture("hello-auth-partial.invalid.json");
		const bad = await fixture("hello-auth-bad.invalid.json");
		expect(() => decodeClientFrame(partial)).toThrow(AppWireError);
		let caught: unknown;
		try {
			decodeClientFrame(bad);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AppWireError);
		expect(String(caught)).not.toContain("not-a-token");
		const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		for (const [index, last] of Array.from(base64urlAlphabet).entries()) {
			const decode = () => deviceToken(`${"A".repeat(42)}${last}`);
			if (index % 4 === 0) expect(decode()).toHaveLength(43);
			else expect(decode).toThrow(AppWireError);
		}
	});
	test("additive watch, lease, PTY, files, audit, catalog, preview discriminants are bounded", () => {
		const frames = [
			{
				v: "omp-app/1",
				type: "host.watch",
				watchId: "w",
				hostId: "h",
				cursor: { epoch: "e", seq: 1 },
				state: "ready",
				revision: "r",
			},
			{
				v: "omp-app/1",
				type: "session.delta",
				hostId: "h",
				sessionId: "s",
				cursor: { epoch: "e", seq: 2 },
				revision: "r",
				upsert: {
					hostId: "h",
					sessionId: "s",
					project: { projectId: "p" },
					revision: "r",
					title: "Demo",
					status: "idle",
					updatedAt: "now",
				},
			},
			{
				v: "omp-app/1",
				type: "prompt.lease",
				hostId: "h",
				sessionId: "s",
				leaseId: "l",
				cursor: { epoch: "e", seq: 3 },
				kind: "prompt",
				state: "acquired",
				owner: "desktop",
				expiresAt: "now",
			},
			{
				v: "omp-app/1",
				type: "agent.progress",
				hostId: "h",
				sessionId: "s",
				agentId: "a",
				cursor: { epoch: "e", seq: 4 },
				progress: 0.5,
				revision: "r",
			},
			{
				v: "omp-app/1",
				type: "terminal.output",
				hostId: "h",
				sessionId: "s",
				terminalId: "t",
				cursor: { epoch: "e", seq: 5 },
				stream: "stdout",
				data: "ok",
			},
			{ v: "omp-app/1", type: "files.diff", hostId: "h", sessionId: "s", path: "src/a.ts", diff: "@@\\n" },
			{
				v: "omp-app/1",
				type: "audit.event",
				hostId: "h",
				cursor: { epoch: "e", seq: 1 },
				event: { eventId: "op", hostId: "h", action: "read", actor: "desktop", timestamp: "now" },
			},
			{
				v: "omp-app/1",
				type: "catalog",
				hostId: "h",
				revision: "r",
				items: [{ id: "tool", kind: "tool", name: "shell" }],
			},
			{
				v: "omp-app/1",
				type: "preview.capture",
				hostId: "h",
				sessionId: "s",
				...previewSnapshot({
					capture: {
						captureId: "capture-1",
						mimeType: "image/png",
						size: 1,
						width: 1,
						height: 1,
						capturedAt: 1,
						sha256: "a".repeat(64),
					},
				}),
			},
		] as const;
		for (const value of frames) expect(decodeServerFrame(value).type).toBe(value.type);
		expect(() => decodeAdditiveServerFrame({ ...frames[0], state: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[2], kind: "controller" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[4], data: "x", stream: "future" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[5], path: "../secret" })).toThrow(AppWireError);
		expect(() => decodeAdditiveServerFrame({ ...frames[6], event: { ...frames[6].event, hostId: "other" } })).toThrow(
			AppWireError,
		);
	});
	test("agent transcript is a bounded negotiated additive frame with same-session durable entries", () => {
		expect(ADDITIVE_FEATURES).toContain("agent.transcript");
		expect(PROTOCOL_FEATURES).toContain("agent.transcript");
		const entry = {
			id: "worker-entry",
			parentId: null,
			hostId: "h",
			sessionId: "s",
			kind: "tool-use",
			timestamp: "2026-07-15T00:00:00.000Z",
			data: {
				tool: "read",
				result: { content: [{ type: "text", text: "contents" }], details: { lines: 1 }, isError: false },
			},
		};
		const frame = {
			v: "omp-app/1",
			type: "agent.transcript",
			hostId: "h",
			sessionId: "s",
			agentId: "WorkerA",
			cursor: { epoch: "agent-epoch", seq: 1 },
			entries: [entry],
			revision: "r",
		};
		expect(decodeAdditiveServerFrame(frame)).toMatchObject(frame);
		expect(() =>
			decodeAdditiveServerFrame({
				...frame,
				entries: [{ ...entry, sessionId: "other" }],
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeAdditiveServerFrame({
				...frame,
				entries: Array.from({ length: MAX_ARRAY_ITEMS + 1 }, (_, index) => ({ ...entry, id: `entry-${index}` })),
			}),
		).toThrow(AppWireError);
	});
	test("every command has typed bounded argument and result decoders", () => {
		for (const command of Object.keys(COMMAND_DESCRIPTORS)) {
			expect(COMMAND_ARGUMENT_DECODERS[command]).toBeFunction();
			expect(COMMAND_RESULT_DECODERS[command]).toBeFunction();
			const descriptor = COMMAND_DESCRIPTORS[command];
			expect(descriptor).toBeDefined();
		}
	});
	test("browser preview commands expose bounded controls, capture reads, leases, policy, and handoff", () => {
		const validArguments: Record<string, Record<string, unknown>> = {
			"preview.launch": { url: "https://example.com/", authorityId: "isolated" },
			"preview.state": {},
			"preview.activate": { previewId: "preview-1" },
			"preview.navigate": { previewId: "preview-1", url: "https://example.com/next" },
			"preview.back": { previewId: "preview-1" },
			"preview.forward": { previewId: "preview-1" },
			"preview.reload": { previewId: "preview-1" },
			"preview.close": { previewId: "preview-1" },
			"preview.capture": { previewId: "preview-1" },
			"preview.capture.read": { previewId: "preview-1", captureId: "capture-1", offset: 0 },
			"preview.click": { previewId: "preview-1", selector: "button[data-save]" },
			"preview.fill": { previewId: "preview-1", selector: "input", text: "value" },
			"preview.scroll": { previewId: "preview-1", deltaX: 0, deltaY: 100 },
			"preview.type": { previewId: "preview-1", text: "value" },
			"preview.select": { previewId: "preview-1", selector: "select", value: "one" },
			"preview.press": { previewId: "preview-1", key: "Enter" },
			"preview.upload": { previewId: "preview-1", selector: "input[type=file]", path: "uploads/a.txt" },
			"preview.policy.check": { action: "navigate", url: "https://example.com/" },
			"preview.lease.acquire": { previewId: "preview-1", ttlMs: 1_000 },
			"preview.lease.renew": { previewId: "preview-1", leaseId: "lease-1", ttlMs: 1_000 },
			"preview.lease.release": { previewId: "preview-1", leaseId: "lease-1" },
			"preview.handoff": { previewId: "preview-1", message: "Complete sign-in", mode: "manual" },
		};
		for (const [command, args] of Object.entries(validArguments))
			expect(decodeCommandArguments(command, args)).toMatchObject(args);

		expect(COMMAND_DESCRIPTORS["preview.click"]).toMatchObject({
			capability: "preview.input",
			scope: "session",
		});
		expect(COMMAND_DESCRIPTORS["preview.launch"]?.confirmation).toBe("challenge");
		expect(COMMAND_DESCRIPTORS["preview.upload"]?.confirmation).toBe("challenge");
		expect(() =>
			decodeCommandArguments("preview.click", { previewId: "preview-1", selector: "button", x: 1, y: 1 }),
		).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("preview.handoff", {
				previewId: "preview-1",
				message: "Complete sign-in",
				mode: "selector",
			}),
		).toThrow(AppWireError);
		for (const [command, args] of [
			["preview.click", { previewId: "preview-1", selector: "" }],
			["preview.fill", { previewId: "preview-1", selector: "input\n", text: "value" }],
			["preview.handoff", { previewId: "preview-1", message: "Complete sign-in", mode: "selector", selector: "" }],
			["preview.handoff", { previewId: "preview-1", message: "Complete sign-in", mode: "url", urlSubstring: "\n" }],
			["preview.handoff", { previewId: "preview-1", message: "Complete sign-in", mode: "text", text: "" }],
		] as const)
			expect(() => decodeCommandArguments(command, args)).toThrow(AppWireError);
		expect(
			decodeCommandArguments("preview.handoff", {
				previewId: "preview-1",
				message: "Complete sign-in",
				mode: "text",
				text: "Signed in",
			}),
		).toMatchObject({ mode: "text", text: "Signed in" });
	});
	test("every descriptor declares an exhaustive revision owner", () => {
		const expected: Record<string, string> = {
			"session.prompt": "session",
			"session.image.begin": "none",
			"session.image.chunk": "none",
			"session.image.discard": "none",
			"session.image.read": "none",
			"session.cancel": "session",
			"session.close": "session",
			"agent.cancel": "session",
			"bash.run": "session",
			"term.open": "session",
			"session.state.get": "none",
			"session.steer": "session",
			"session.followUp": "session",
			"session.rename": "session",
			"session.retry": "session",
			"session.compact": "session",
			"session.pause": "session",
			"session.resume": "session",
			"session.archive": "session",
			"session.restore": "session",
			"session.delete": "session",
			"session.model.set": "session",
			"session.thinking.set": "session",
			"session.fast.set": "session",
			"session.ui.respond": "session",
			"controller.lease.acquire": "session",
			"controller.lease.renew": "session",
			"controller.lease.release": "session",
			"prompt.lease.acquire": "session",
			"prompt.lease.renew": "session",
			"prompt.lease.release": "session",
			"preview.launch": "session",
			"preview.state": "session",
			"preview.activate": "session",
			"preview.navigate": "session",
			"preview.back": "session",
			"preview.forward": "session",
			"preview.reload": "session",
			"preview.close": "session",
			"preview.capture": "session",
			"preview.capture.read": "none",
			"preview.click": "session",
			"preview.fill": "session",
			"preview.scroll": "session",
			"preview.type": "session",
			"preview.select": "session",
			"preview.press": "session",
			"preview.upload": "session",
			"preview.policy.check": "none",
			"preview.lease.acquire": "session",
			"preview.lease.renew": "session",
			"preview.lease.release": "session",
			"preview.handoff": "session",
			"ci.run": "session",
			"files.read": "authority",
			"files.write": "authority",
			"files.patch": "authority",
			"files.list": "authority",
			"files.search": "authority",
			"files.diff": "authority",
			"review.read": "authority",
			"review.apply": "authority",
			"config.write": "authority",
			"settings.write": "authority",
			"runtime.list": "none",
			"workspace.list": "none",
			"workspace.create": "none",
			"workspace.import": "none",
			"workspace.archive": "none",
			"workspace.recover": "none",
			"host.list": "none",
			"session.list": "none",
			"transcript.search": "none",
			"transcript.context": "none",
			"transcript.page": "none",
			"project.reveal": "none",
			"session.create": "none",
			"session.attach": "none",
			"audit.read": "none",
			"audit.tail": "none",
			"settings.read": "none",
			"broker.status": "none",
			"catalog.get": "none",
			"usage.read": "none",
			"artifact.read": "none",
			"host.watch": "none",
			"session.watch": "none",
		};
		expect(Object.keys(COMMAND_DESCRIPTORS).sort()).toEqual(Object.keys(expected).sort());
		for (const [command, descriptor] of Object.entries(COMMAND_DESCRIPTORS)) {
			expect(descriptor.revisionOwner).toBe(expected[command]);
			expect(descriptor.revision === "none").toBe(descriptor.revisionOwner === "none");
		}
	});
	test("desktop catalog commands are an explicit canonical descriptor subset", () => {
		const expected = [
			"broker.status",
			"project.reveal",
			"session.create",
			"session.rename",
			"session.archive",
			"session.restore",
			"session.delete",
			"session.close",
			"session.model.set",
			"session.thinking.set",
			"session.fast.set",
			"session.cancel",
			"usage.read",
		];
		expect([...DESKTOP_CATALOG_COMMANDS].sort()).toEqual(expected.sort());
		for (const command of DESKTOP_CATALOG_COMMANDS) expect(COMMAND_DESCRIPTORS[command].desktopCatalog).toBe(true);
	});
	test("descriptor validator rejects mismatched revision policy and owner", () => {
		expect(() =>
			validateCommandDescriptor("invalid", {
				capability: "files.read",
				scope: "host",
				revision: "none",
				revisionOwner: "authority",
				confirmation: "none",
			}),
		).toThrow(AppWireError);
		expect(() =>
			validateCommandDescriptor("invalid", {
				capability: "files.read",
				scope: "host",
				revision: "required",
				revisionOwner: "none",
				confirmation: "none",
			}),
		).toThrow(AppWireError);
	});
	test("terminal direction and command payload/result contracts are explicit", () => {
		const base = { v: "omp-app/1", hostId: "h", sessionId: "s", terminalId: "t" };
		expect(decodeClientFrame({ ...base, type: "terminal.input", data: "x" }).type).toBe("terminal.input");
		expect(decodeClientFrame({ ...base, type: "terminal.resize", cols: 80, rows: 24 }).type).toBe("terminal.resize");
		expect(() => decodeServerFrame({ ...base, type: "terminal.input", data: "x" })).toThrow(AppWireError);
		expect(
			decodeServerFrame({
				...base,
				type: "terminal.output",
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			}).type,
		).toBe("terminal.output");
		expect(() =>
			decodeClientFrame({
				...base,
				type: "terminal.output",
				cursor: { epoch: "e", seq: 1 },
				stream: "stdout",
				data: "x",
			}),
		).toThrow(AppWireError);
		expect(decodeServerFrame({ ...base, type: "terminal", stream: "stderr", data: "x" }).type).toBe("terminal");
		expect(decodeServerFrame({ ...base, type: "terminal", stream: "exit", exitCode: 0 }).type).toBe("terminal");
		for (const malformed of [
			{ ...base, type: "terminal", stream: "future", data: "x" },
			{ ...base, type: "terminal", stream: "stdout" },
			{ ...base, type: "terminal", stream: "stdout", data: "x", exitCode: 0 },
			{ ...base, type: "terminal", stream: "exit" },
			{ ...base, type: "terminal", stream: "exit", data: "x", exitCode: 0 },
		])
			expect(() => decodeServerFrame(malformed)).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.prompt", { prompt: "wrong" })).toThrow(AppWireError);
		expect(decodeCommandArguments("session.prompt", { message: "hello" }).message).toBe("hello");
		expect(decodeCommandArguments("session.prompt", { message: "hello", leaseId: "lease-1" })).toMatchObject({
			message: "hello",
			leaseId: "lease-1",
		});
		expect(() => decodeCommandArguments("session.prompt", { message: "hello", unexpected: true })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("session.prompt", { message: "" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.prompt", { message: "hello", leaseId: "bad\u0000lease" })).toThrow(
			AppWireError,
		);
		expect(() => decodeCommandArguments("preview.launch", { url: "javascript:alert(1)" })).toThrow(AppWireError);
		expect(
			decodeCommandArguments("session.model.set", { selector: "openai/gpt-5.5", persistence: "session" }),
		).toMatchObject({ selector: "openai/gpt-5.5", persistence: "session" });
		expect(decodeCommandArguments("session.model.set", { role: "slow", persistence: "settings" })).toMatchObject({
			role: "slow",
			persistence: "settings",
		});
		expect(() =>
			decodeCommandArguments("session.model.set", {
				selector: "openai/gpt-5.5",
				role: "slow",
				persistence: "session",
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("session.model.set", { selector: "openai/gpt-5.5", persistence: "bad" }),
		).toThrow(AppWireError);
		expect(() => decodeCommandArguments("session.thinking.set", { level: "auto" })).not.toThrow();
		expect(() => decodeCommandArguments("session.thinking.set", { level: "unsupported" })).toThrow(AppWireError);
		expect(decodeCommandArguments("session.fast.set", { enabled: true })).toMatchObject({ enabled: true });
		expect(() => decodeCommandArguments("session.fast.set", { enabled: "yes" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { apiKey: "secret" })).toThrow(AppWireError);
		const state = {
			isStreaming: false,
			isCompacting: false,
			isPaused: false,
			messageCount: 0,
			queuedMessageCount: 0,
			steeringMode: "all",
			followUpMode: "all",
			interruptMode: "immediate",
		};
		expect(() => decodeCommandResult("session.state.get", { ...state, thinking: "bogus" })).toThrow(AppWireError);
		for (const level of ["inherit", "off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(() => decodeCommandResult("session.state.get", { ...state, thinking: level })).not.toThrow();
		}
		for (const level of ["invalid", "ultra", "extreme"]) {
			expect(() => decodeCommandResult("session.state.get", { ...state, thinking: level })).toThrow(AppWireError);
		}
		const semanticState = {
			...state,
			thinking: "auto",
			thinkingEffective: "medium",
			thinkingResolved: "high",
			thinkingLevels: ["minimal", "low", "medium", "high"],
			thinkingSupported: true,
			thinkingOffFloored: false,
			fast: true,
			fastAvailable: true,
			fastActive: true,
		};
		expect(decodeCommandResult("session.state.get", semanticState)).toEqual(semanticState);
		for (const malformed of [
			{ ...semanticState, thinkingEffective: "auto" },
			{ ...semanticState, thinkingResolved: "off" },
			{ ...semanticState, thinkingLevels: ["low", "low"] },
			{ ...semanticState, thinkingLevels: ["inherit"] },
			{ ...semanticState, fastAvailable: "yes" },
		])
			expect(() => decodeCommandResult("session.state.get", malformed)).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "session.prompt",
				args: { prompt: "wrong" },
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeClientFrame({
				v: "omp-app/1",
				type: "command",
				requestId: "r",
				commandId: "c",
				hostId: "h",
				sessionId: "s",
				command: "files.list",
				args: { path: "../secret" },
			}),
		).toThrow(AppWireError);
		expect(decodeCommandResult("session.list", { cursor: { epoch: "e", seq: 1 }, sessions: [] }).sessions).toEqual(
			[],
		);
		expect(() => decodeCommandResult("session.list", { sessions: [] })).toThrow(AppWireError);
		expect(decodeCommandResult("session.attach", { attached: true, cursor: { epoch: "e", seq: 1 } }).attached).toBe(
			true,
		);
		expect(() => decodeCommandResult("session.create", { session: {} })).toThrow(AppWireError);
		expect(decodeCommandResult("session.cancel", { cancelled: true }).cancelled).toBe(true);
		expect(() => decodeCommandResult("session.cancel", { ok: true })).toThrow(AppWireError);
		expect(decodeCommandResult("session.prompt", { accepted: true }).accepted).toBe(true);
		expect(decodeCommandResult("term.open", { terminalId: "t" }).terminalId).toBe("t");
		expect(() => decodeCommandResult("term.open", { terminalId: 1 })).toThrow(AppWireError);
		expect(decodeCommandResult("preview.capture", { preview: previewSnapshot() })).toMatchObject({
			preview: { previewId: "preview-1" },
		});
		expect(() => decodeCommandResult("preview.capture", { preview: {} })).toThrow(AppWireError);
		const maximumCapture = Buffer.alloc(PREVIEW_CAPTURE_CHUNK_BYTES).toString("base64");
		const captureRead = {
			previewId: "preview-1",
			captureId: "capture-1",
			size: PREVIEW_CAPTURE_CHUNK_BYTES,
			offset: 0,
			nextOffset: PREVIEW_CAPTURE_CHUNK_BYTES,
			complete: true,
			content: maximumCapture,
		};
		expect(decodeCommandResult("preview.capture.read", captureRead).content).toBe(maximumCapture);
		const partialCapture = {
			previewId: "preview-1",
			captureId: "capture-1",
			size: 4,
			offset: 1,
			nextOffset: 3,
			complete: false,
			content: "AgM=",
		};
		expect(decodeCommandResult("preview.capture.read", partialCapture)).toMatchObject(partialCapture);
		for (const invalid of [
			{ ...partialCapture, nextOffset: 1, content: "" },
			{ ...partialCapture, content: "Ag==" },
			{ ...partialCapture, nextOffset: 2, content: "AR==" },
			{ ...partialCapture, nextOffset: 3, content: "AQJ=" },
		])
			expect(() => decodeCommandResult("preview.capture.read", invalid)).toThrow(AppWireError);
		expect(() =>
			decodeCommandResult("preview.capture.read", {
				...captureRead,
				size: PREVIEW_CAPTURE_CHUNK_BYTES + 1,
				nextOffset: PREVIEW_CAPTURE_CHUNK_BYTES + 1,
				content: `${maximumCapture}AAAA`,
			}),
		).toThrow(AppWireError);
		expect(() => decodeCommandResult("files.list", { entries: [{ path: "src", kind: "future" }] })).toThrow(
			AppWireError,
		);
		const fileEntries = decodeCommandResult("files.list", {
			entries: [
				{ path: "src/file.ts", kind: "file", size: 42, revision: "revision-1" },
				{ path: "src", kind: "directory" },
				{ path: "link", kind: "symlink" },
			],
		}).entries as Record<string, unknown>[];
		expect(fileEntries).toHaveLength(3);
		expect(fileEntries[0]).toMatchObject({ size: 42, revision: "revision-1" });
		for (const entry of [
			{ path: "src/file.ts", kind: "file", size: "42" },
			{ path: "src/file.ts", kind: "file", size: -1 },
			{ path: "src/file.ts", kind: "file", size: 1.5 },
			{ path: "src/file.ts", kind: "file", size: MAX_FILE_BYTES * 1024 + 1 },
			{ path: "src/file.ts", kind: "file", revision: 42 },
		])
			expect(() => decodeCommandResult("files.list", { entries: [entry] })).toThrow(AppWireError);
		const auditEvent = {
			eventId: "operation-1",
			hostId: "host-1",
			sessionId: "session-1",
			action: "files.read",
			actor: "desktop",
			timestamp: "2026-07-14T00:00:00Z",
			detail: { path: "src/file.ts" },
		};
		expect(decodeCommandResult("audit.read", { events: [auditEvent] }).events).toHaveLength(1);
		for (const field of ["eventId", "hostId", "action", "actor", "timestamp"])
			expect(() => decodeCommandResult("audit.read", { events: [{ ...auditEvent, [field]: undefined }] })).toThrow(
				AppWireError,
			);
		for (const event of [
			{ ...auditEvent, sessionId: 42 },
			{ ...auditEvent, detail: { apiToken: "must-not-cross" } },
		])
			expect(() => decodeCommandResult("audit.tail", { events: [event] })).toThrow(AppWireError);
		const catalogItem = {
			id: "tool-shell",
			kind: "tool",
			name: "shell",
			description: "Run a shell command",
			capabilities: ["bash.run"],
			supported: true,
			reason: "available",
			metadata: { category: "system" },
		};
		expect(decodeCommandResult("catalog.get", { revision: "catalog-1", items: [catalogItem] }).items).toHaveLength(1);
		expect(() => decodeCommandResult("catalog.get", { items: [catalogItem] })).toThrow(AppWireError);
		for (const item of [
			{ ...catalogItem, id: undefined },
			{ ...catalogItem, kind: "future" },
			{ ...catalogItem, name: undefined },
			{ ...catalogItem, description: 42 },
			{ ...catalogItem, capabilities: [42] },
			{ ...catalogItem, supported: "yes" },
			{ ...catalogItem, reason: 42 },
			{ ...catalogItem, metadata: { apiToken: "must-not-cross" } },
		])
			expect(() =>
				decodeCommandResult("catalog.get", { revision: "catalog-1", items: [item] }),
			).toThrow(AppWireError);
		expect(
			decodeCommandResult("controller.lease.renew", { leaseId: "l", cursor: { epoch: "e", seq: 1 } }).leaseId,
		).toBe("l");
		expect(() => decodeCommandResult("host.watch", { watchId: "w" })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { values: { nested: [{ ok: true }] } })).not.toThrow();
		const supportedSettings = Object.fromEntries(
			Array.from({ length: 410 }, (_, index) => [`setting-${index}`, { configured: true, sensitive: false }]),
		);
		expect(() =>
			decodeCommandResult("settings.read", { revision: "revision-1", settings: supportedSettings }),
		).not.toThrow();
		expect(() =>
			decodeCommandResult("settings.read", {
				revision: "revision-1",
				settings: {
					...supportedSettings,
					"auth.broker.token": {
						configured: true,
						effectiveSource: "global",
						sensitive: true,
					},
				},
			}),
		).not.toThrow();
		const settingsFrame = decodeAdditiveServerFrame({
			v: "omp-app/1",
			type: "settings",
			hostId: "real-host",
			revision: "revision-1",
			settings: {
				...supportedSettings,
				"auth.broker.token": { configured: true, sensitive: true },
			},
		});
		expect(settingsFrame).toMatchObject({
			type: "settings",
			hostId: "real-host",
			settings: { "auth.broker.token": { configured: true, sensitive: true } },
		});
		expect(() =>
			decodeAdditiveServerFrame({
				v: "omp-app/1",
				type: "settings",
				hostId: "real-host",
				revision: "revision-1",
				settings: { "auth.broker.token": { sensitive: true, default: "must-not-cross" } },
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeAdditiveServerFrame({
				v: "omp-app/1",
				type: "settings",
				hostId: "real-host",
				revision: "revision-1",
				settings: { "visible.setting": { metadata: { token: "must-not-cross" } } },
			}),
		).toThrow(AppWireError);
		expect(() =>
			decodeCommandResult("settings.read", {
				revision: "revision-1",
				settings: {
					"auth.broker.token": {
						configured: true,
						effective: "must-not-cross",
						sensitive: true,
					},
				},
			}),
		).toThrow(AppWireError);
		const oversizedSettings = Object.fromEntries(
			Array.from({ length: MAX_MAP_KEYS + 1 }, (_, index) => [`setting-${index}`, index]),
		);
		expect(() =>
			decodeCommandResult("settings.read", { revision: "revision-1", settings: oversizedSettings }),
		).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { values: { password: "nope" } })).toThrow(AppWireError);
		expect(() => decodeCommandArguments("settings.write", { value: Number.NaN })).toThrow(AppWireError);
		const deep: Record<string, unknown> = {};
		let node = deep;
		for (let i = 0; i < 40; i++) {
			const next: Record<string, unknown> = {};
			node.next = next;
			node = next;
		}
		expect(() => decodeCommandArguments("settings.write", deep)).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("settings.write", { values: Array.from({ length: 1001 }, () => true) }),
		).toThrow(AppWireError);
	});
	test("managed prompt images have strict bounded upload contracts", () => {
		expect(ADDITIVE_FEATURES).toContain("prompt.images");
		expect(PROTOCOL_FEATURES).toContain("prompt.images");
		const id = "123e4567-e89b-42d3-a456-426614174000";
		const digest = "a".repeat(64);
		expect(decodeCommandArguments("session.prompt", { message: "", images: [{ imageId: id }] })).toMatchObject({
			message: "",
			images: [{ imageId: id }],
		});
		expect(() => decodeCommandArguments("session.prompt", { message: "", images: [] })).toThrow(AppWireError);
		expect(() =>
			decodeCommandArguments("session.prompt", {
				message: "images",
				images: Array.from({ length: PROMPT_IMAGE_MAX_COUNT + 1 }, () => ({ imageId: id })),
			}),
		).toThrow(AppWireError);
		for (const invalid of ["../secret", id.toUpperCase(), "123e4567-e89b-12d3-a456-426614174000"])
			expect(() =>
				decodeCommandArguments("session.prompt", { message: "image", images: [{ imageId: invalid }] }),
			).toThrow(AppWireError);

		expect(
			decodeCommandArguments("session.image.begin", {
				mimeType: "image/png",
				size: 8,
				sha256: digest,
			}),
		).toEqual({ mimeType: "image/png", size: 8, sha256: digest });
		for (const value of [
			{ mimeType: "image/svg+xml", size: 8, sha256: digest },
			{ mimeType: "image/png", size: 0, sha256: digest },
			{ mimeType: "image/png", size: 8, sha256: digest.toUpperCase() },
		])
			expect(() => decodeCommandArguments("session.image.begin", value)).toThrow(AppWireError);

		expect(decodeCommandArguments("session.image.chunk", { imageId: id, offset: 0, content: "AQ==" })).toEqual({
			imageId: id,
			offset: 0,
			content: "AQ==",
		});
		for (const content of ["AR==", "AQJ=", "AQ", "%%%%"])
			expect(() => decodeCommandArguments("session.image.chunk", { imageId: id, offset: 0, content })).toThrow(
				AppWireError,
			);
		expect(() =>
			decodeCommandArguments("session.image.chunk", {
				imageId: id,
				offset: 0,
				content: Buffer.alloc(IMAGE_UPLOAD_CHUNK_BYTES + 1).toString("base64"),
			}),
		).toThrow(AppWireError);
		expect(decodeCommandArguments("session.image.discard", { imageId: id })).toEqual({ imageId: id });
		expect(() => decodeCommandArguments("session.image.discard", { imageId: id, extra: true })).toThrow(AppWireError);

		expect(decodeCommandResult("session.image.begin", { imageId: id, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES })).toEqual(
			{ imageId: id, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES },
		);
		expect(decodeCommandResult("session.image.chunk", { imageId: id, received: 1, complete: true })).toEqual({
			imageId: id,
			received: 1,
			complete: true,
		});
		expect(decodeCommandResult("session.image.discard", { discarded: true })).toEqual({ discarded: true });
		expect(() => decodeCommandResult("session.image.discard", { discarded: true, extra: true })).toThrow(
			AppWireError,
		);
		expect(() =>
			decodeCommandResult("session.image.begin", {
				imageId: id,
				chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES,
				extra: true,
			}),
		).toThrow(AppWireError);

		const frame = {
			v: "omp-app/1",
			type: "command",
			requestId: "request",
			commandId: "command",
			hostId: "host",
			sessionId: "session",
			command: "session.image.begin",
			args: { mimeType: "image/png", size: 8, sha256: digest },
		};
		expect(() => decodeClientFrame(frame)).not.toThrow();
		expect(() => decodeClientFrame({ ...frame, expectedRevision: "revision" })).toThrow(AppWireError);
	});
	test("transcript images expose ordered metadata and bounded read chunks", () => {
		expect(ADDITIVE_FEATURES).toContain("transcript.images");
		expect(PROTOCOL_FEATURES).toContain("transcript.images");
		const digest = "a".repeat(64);
		const entry = {
			id: "entry-image",
			parentId: null,
			hostId: "host",
			sessionId: "session",
			kind: "message",
			timestamp: "2026-07-14T12:00:00.000Z",
			data: {
				role: "user",
				text: "look",
				images: [
					{ sha256: digest, mimeType: "image/png" },
					{ sha256: "b".repeat(64), mimeType: "image/webp" },
				],
			},
		};
		expect(decodeEntry(entry).data.images).toEqual(entry.data.images);
		for (const images of [
			[{ sha256: digest.toUpperCase(), mimeType: "image/png" }],
			[{ sha256: digest, mimeType: "image/svg+xml" }],
			[{ sha256: digest, mimeType: "image/png", content: "AQ==" }],
		])
			expect(() => decodeEntry({ ...entry, data: { ...entry.data, images } })).toThrow(AppWireError);

		expect(decodeCommandArguments("session.image.read", { entryId: entry.id, sha256: digest, offset: 0 })).toEqual({
			entryId: entry.id,
			sha256: digest,
			offset: 0,
		});
		for (const args of [
			{ entryId: entry.id, sha256: digest.toUpperCase(), offset: 0 },
			{ entryId: "bad\nentry", sha256: digest, offset: 0 },
			{ entryId: entry.id, sha256: digest, offset: TRANSCRIPT_IMAGE_MAX_BYTES },
			{ entryId: entry.id, sha256: digest, offset: 0, path: "/tmp/image" },
		])
			expect(() => decodeCommandArguments("session.image.read", args)).toThrow(AppWireError);

		const result = {
			sha256: digest,
			mimeType: "image/png",
			size: 4,
			offset: 0,
			nextOffset: 3,
			complete: false,
			content: "AQID",
		};
		expect(decodeCommandResult("session.image.read", result)).toEqual(result);
		for (const invalid of [
			{ ...result, nextOffset: 2 },
			{ ...result, complete: true },
			{ ...result, content: "AQJ=" },
			{ ...result, path: "/tmp/image" },
		])
			expect(() => decodeCommandResult("session.image.read", invalid)).toThrow(AppWireError);
		expect(() =>
			decodeCommandResult("session.image.read", {
				...result,
				size: TRANSCRIPT_IMAGE_CHUNK_BYTES + 1,
				nextOffset: TRANSCRIPT_IMAGE_CHUNK_BYTES + 1,
				content: Buffer.alloc(TRANSCRIPT_IMAGE_CHUNK_BYTES + 1).toString("base64"),
			}),
		).toThrow(AppWireError);
	});
	test("artifacts and turn reviews accept standard MIME types and reject untrusted descriptor fields", () => {
		const patch = {
			artifactId: "2001",
			kind: "patch",
			mediaType: "text/x-diff",
			size: 128,
			sha256: "a".repeat(64),
			name: "2001.turn-review.log",
			disposition: "attachment",
			retention: "session",
		};
		expect(decodeArtifactDescriptor(patch, "artifact")).toEqual(patch);
		expect(
			decodeTurnReviewSnapshot({
				turnId: "turn-1",
				baseTree: "base",
				headTree: "head",
				changes: [
					{
						path: "src/index.ts",
						status: "modified",
						kind: "text",
						state: "pending",
						additions: 2,
						deletions: 1,
					},
				],
				patch,
			}),
		).toMatchObject({ turnId: "turn-1", patch });
		expect(() => decodeArtifactDescriptor({ ...patch, mediaType: "invalid" }, "artifact")).toThrow(AppWireError);
		expect(() => decodeArtifactDescriptor({ ...patch, path: "/tmp/patch" }, "artifact")).toThrow(AppWireError);
	});
	test("session identity remains host scoped", () => {
		expect(
			(
				decodeServerFrame({
					v: "omp-app/1",
					type: "response",
					requestId: "r",
					hostId: "h",
					command: "session.cancel",
					ok: true,
					result: { cancelled: true },
				}) as Record<string, unknown>
			).result,
		).toEqual({ cancelled: true });
		expect(() =>
			decodeServerFrame({
				v: "omp-app/1",
				type: "response",
				requestId: "r",
				hostId: "h",
				ok: true,
				result: { cancelled: true },
			}),
		).toThrow(AppWireError);
		const failed = {
			v: "omp-app/1",
			type: "response",
			requestId: "r",
			hostId: "h",
			command: "session.cancel",
			ok: false,
			error: { code: "cancel_failed", message: "cancel failed" },
		} as const;
		expect(decodeServerFrame(failed).ok).toBe(false);
		for (const result of [null, false, { cancelled: true }])
			expect(() =>
				decodeServerFrame({
					...failed,
					result,
				}),
			).toThrow(AppWireError);
		expect(sameSession({ hostId: "h", sessionId: "s" }, { hostId: "other", sessionId: "s" })).toBe(false);
	});
});
