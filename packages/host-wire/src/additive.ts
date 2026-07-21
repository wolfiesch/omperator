import { decodeWorkspaceState, type WorkspaceStateFrame } from "./cluster.js";
import { type Cursor, decodeCursor } from "./cursor.js";
import { type DurableEntry, decodeEntry } from "./entry.js";
import { fail } from "./errors.js";
import {
	boundedArray,
	boundedBase64,
	boundedMap,
	boundedMetadata,
	boundedSettings,
	boundedText,
	controlFree,
	finiteNumber,
	inputObject,
	isSecretLikeKey,
	safeRelativePath,
	safeSeq,
} from "./guards.js";
import {
	type AgentId,
	agentId,
	type CatalogId,
	catalogId,
	type DeviceId,
	deviceId,
	type HostId,
	hostId,
	type LeaseId,
	leaseId,
	type OperationId,
	operationId,
	type PreviewCaptureId,
	type PreviewId,
	previewCaptureId,
	previewId,
	type Revision,
	revision,
	type SessionId,
	sessionId,
	type TerminalId,
	terminalId,
	type WatchId,
	watchId,
} from "./ids.js";
import {
	MAX_FILE_BYTES,
	MAX_TERMINAL_OUTPUT_BYTES,
	PREVIEW_CAPTURE_MAX_BYTES,
	PREVIEW_CAPTURE_MAX_PIXELS,
	PROTOCOL_VERSION,
} from "./limits.js";
import { decodeSessionRef, type SessionRef } from "./session-index.js";

export const ADDITIVE_FEATURES = [
	"host.watch",
	"session.watch",
	"session.state",
	"session.delta",
	"session.observer",
	"controller.lease",
	"prompt.lease",
	"prompt.images",
	"transcript.images",
	"transcript.search",
	"transcript.page",
	"project.reveal",
	"agent.lifecycle",
	"agent.progress",
	"agent.event",
	"agent.transcript",
	"terminal.io",
	"files.list",
	"files.search",
	"files.diff",
	"audit.tail",
	"catalog.metadata",
	"settings.metadata",
	"preview.control",
	"cluster.operator",
] as const;
export type AdditiveFeature = (typeof ADDITIVE_FEATURES)[number];
export type WireFeature = AdditiveFeature | "resume";
function frame(input: unknown, expected: readonly string[]): Record<string, unknown> {
	const x = inputObject(input);
	if (x.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (typeof x.type !== "string" || !expected.includes(x.type)) fail("UNKNOWN_FRAME", "unknown discriminant", "type");
	if (x.metadata !== undefined) boundedMetadata(x.metadata, "metadata", isSecretLikeKey);
	return x;
}
function own(x: Record<string, unknown>): { hostId: HostId; sessionId: SessionId } {
	return { hostId: hostId(x.hostId), sessionId: sessionId(x.sessionId) };
}
function cur(x: unknown): Cursor {
	return decodeCursor(x);
}
function known(value: unknown, path: string, values: readonly string[]): string {
	const result = controlFree(value, path, 128);
	if (!values.includes(result)) fail("UNKNOWN_FRAME", `unknown discriminant ${result}`, path);
	return result;
}
function httpUrl(value: unknown, path: string): string {
	const text = controlFree(value, path, 4096);
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		fail("INVALID_FRAME", "invalid preview URL", path);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username !== "" ||
		parsed.password !== ""
	)
		fail("INVALID_FRAME", "preview URL must be http(s) without credentials", path);
	return text;
}
function object(value: unknown, path: string): Record<string, unknown> {
	return boundedMap(value, path);
}

export interface HostWatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "host.watch";
	watchId: WatchId;
	hostId: HostId;
	cursor: Cursor;
	state: "started" | "stopped" | "ready";
	revision: Revision;
	[key: string]: unknown;
}
export interface SessionWatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.watch";
	watchId: WatchId;
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	state: "started" | "stopped" | "ready";
	revision: Revision;
	[key: string]: unknown;
}
export interface SessionStateFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.state";
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	revision: Revision;
	state: string;
	[key: string]: unknown;
}
export interface SessionDeltaFrame {
	v: typeof PROTOCOL_VERSION;
	type: "session.delta";
	hostId: HostId;
	sessionId: SessionId;
	cursor: Cursor;
	revision: Revision;
	upsert?: SessionRef;
	remove?: SessionId;
	[key: string]: unknown;
}
export type WatchFrame = HostWatchFrame | SessionWatchFrame | SessionStateFrame | SessionDeltaFrame;
export function decodeWatch(input: unknown): WatchFrame {
	const x = frame(input, ["host.watch", "session.watch", "session.state", "session.delta"]);
	const type = x.type as string;
	if (type === "host.watch")
		return {
			...x,
			type,
			watchId: watchId(x.watchId),
			hostId: hostId(x.hostId),
			cursor: cur(x.cursor),
			state: known(x.state, "state", ["started", "stopped", "ready"]) as HostWatchFrame["state"],
			revision: revision(x.revision),
		} as HostWatchFrame;
	const ids = own(x),
		cursor = cur(x.cursor),
		rev = revision(x.revision);
	if (type === "session.watch")
		return {
			...x,
			type,
			watchId: watchId(x.watchId),
			...ids,
			cursor,
			state: known(x.state, "state", ["started", "stopped", "ready"]) as SessionWatchFrame["state"],
			revision: rev,
		} as SessionWatchFrame;
	if (type === "session.state")
		return {
			...x,
			type,
			...ids,
			cursor,
			revision: rev,
			state: controlFree(x.state, "state", 128),
		} as SessionStateFrame;
	const result: Record<string, unknown> = { ...x, type, ...ids, cursor, revision: rev };
	if (x.upsert !== undefined) result.upsert = decodeSessionRef(x.upsert, "upsert");
	if (x.remove !== undefined) result.remove = sessionId(x.remove, "remove");
	if (result.upsert === undefined && result.remove === undefined)
		fail("INVALID_FRAME", "session delta requires upsert or remove", "delta");
	if (result.upsert !== undefined && result.remove !== undefined)
		fail("INVALID_FRAME", "session delta cannot upsert and remove", "delta");
	if (result.upsert !== undefined) {
		const upsert = result.upsert as SessionRef;
		if (upsert.hostId !== ids.hostId || upsert.sessionId !== ids.sessionId)
			fail("INVALID_FRAME", "upsert belongs to another session", "upsert");
	}
	if (result.remove !== undefined && result.remove !== ids.sessionId)
		fail("INVALID_FRAME", "remove belongs to another session", "remove");
	return result as unknown as SessionDeltaFrame;
}

export type LeaseKind = "controller" | "prompt";
export type LeaseState = "acquired" | "renewed" | "released" | "expired";
export interface LeaseFrame {
	v: typeof PROTOCOL_VERSION;
	type: "lease" | "prompt.lease";
	hostId: HostId;
	sessionId: SessionId;
	leaseId: LeaseId;
	cursor: Cursor;
	kind: LeaseKind;
	state: LeaseState;
	owner: DeviceId;
	expiresAt: string;
	revision?: Revision;
	[key: string]: unknown;
}
export interface PromptLeaseFrame extends LeaseFrame {
	type: "prompt.lease";
	kind: "prompt";
}
export function decodeLease(input: unknown): LeaseFrame | PromptLeaseFrame {
	const x = frame(input, ["lease", "prompt.lease"]);
	const type = x.type as "lease" | "prompt.lease",
		ids = own(x),
		expected = type === "lease" ? "controller" : "prompt";
	if (x.kind !== expected) fail("INVALID_FRAME", "lease kind does not match type", "kind");
	const result = {
		...x,
		type,
		...ids,
		leaseId: leaseId(x.leaseId),
		cursor: cur(x.cursor),
		kind: expected,
		state: known(x.state, "state", ["acquired", "renewed", "released", "expired"]) as LeaseState,
		owner: deviceId(x.owner),
		expiresAt: controlFree(x.expiresAt, "expiresAt", 128),
	} as LeaseFrame;
	if (x.revision !== undefined) result.revision = revision(x.revision);
	return type === "prompt.lease" ? (result as PromptLeaseFrame) : result;
}

export type AgentLifecycle = "created" | "started" | "running" | "completed" | "failed" | "cancelled";
export interface AgentStateFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent.state";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	cursor: Cursor;
	state: AgentLifecycle;
	revision: Revision;
	[key: string]: unknown;
}
export interface AgentLifecycleFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent.lifecycle";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	cursor: Cursor;
	lifecycle: AgentLifecycle;
	revision: Revision;
	[key: string]: unknown;
}
export interface AgentProgressFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent.progress";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	cursor: Cursor;
	progress: number;
	revision: Revision;
	detail?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface AgentEventFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent.event";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	cursor: Cursor;
	event: string;
	revision: Revision;
	data?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface AgentTranscriptFrame {
	v: typeof PROTOCOL_VERSION;
	type: "agent.transcript";
	hostId: HostId;
	sessionId: SessionId;
	agentId: AgentId;
	cursor: Cursor;
	entries: DurableEntry[];
	revision: Revision;
	[key: string]: unknown;
}
export type AgentAdditiveFrame =
	| AgentStateFrame
	| AgentLifecycleFrame
	| AgentProgressFrame
	| AgentEventFrame
	| AgentTranscriptFrame;
export function decodeAgentAdditive(input: unknown): AgentAdditiveFrame {
	const x = frame(input, ["agent.state", "agent.lifecycle", "agent.progress", "agent.event", "agent.transcript"]),
		type = x.type as string,
		ids = own(x),
		aid = agentId(x.agentId),
		cursor = cur(x.cursor),
		rev = revision(x.revision),
		states = ["created", "started", "running", "completed", "failed", "cancelled"] as const;
	if (type === "agent.state")
		return {
			...x,
			type,
			...ids,
			agentId: aid,
			cursor,
			state: known(x.state, "state", states) as AgentLifecycle,
			revision: rev,
		} as AgentStateFrame;
	if (type === "agent.lifecycle")
		return {
			...x,
			type,
			...ids,
			agentId: aid,
			cursor,
			lifecycle: known(x.lifecycle, "lifecycle", states) as AgentLifecycle,
			revision: rev,
		} as AgentLifecycleFrame;
	if (type === "agent.progress") {
		const progress = finiteNumber(x.progress, "progress");
		if (progress < 0 || progress > 1) fail("BOUNDS", "progress must be between zero and one", "progress");
		const result = { ...x, type, ...ids, agentId: aid, cursor, progress, revision: rev } as AgentProgressFrame;
		if (x.detail !== undefined) result.detail = boundedMetadata(x.detail, "detail", isSecretLikeKey);
		return result;
	}
	if (type === "agent.event") {
		const result = {
			...x,
			type,
			...ids,
			agentId: aid,
			cursor,
			event: controlFree(x.event, "event", 128),
			revision: rev,
		} as AgentEventFrame;
		if (x.data !== undefined) result.data = object(x.data, "data");
		return result;
	}
	const entries = boundedArray(x.entries, "entries").map(value => decodeEntry(value));
	for (const entry of entries)
		if (entry.hostId !== ids.hostId || entry.sessionId !== ids.sessionId)
			fail("INVALID_FRAME", "transcript entry belongs to another session", "entries");
	return { ...x, type, ...ids, agentId: aid, cursor, entries, revision: rev } as AgentTranscriptFrame;
}

export interface TerminalInputFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.input";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	data: string;
	encoding?: "utf8" | "base64";
	[key: string]: unknown;
}
export interface TerminalOutputFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.output";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cursor: Cursor;
	stream: "stdout" | "stderr";
	data: string;
	encoding?: "utf8" | "base64";
	[key: string]: unknown;
}
export interface TerminalResizeFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.resize";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cols: number;
	rows: number;
	[key: string]: unknown;
}
export interface TerminalCloseFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.close";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	reason?: string;
	[key: string]: unknown;
}
export interface TerminalExitFrame {
	v: typeof PROTOCOL_VERSION;
	type: "terminal.exit";
	hostId: HostId;
	sessionId: SessionId;
	terminalId: TerminalId;
	cursor: Cursor;
	exitCode: number;
	signal?: string;
	[key: string]: unknown;
}
export type TerminalClientFrame = TerminalInputFrame | TerminalResizeFrame | TerminalCloseFrame;
export type TerminalServerFrame = TerminalOutputFrame | TerminalExitFrame;
function dimension(value: unknown, path: string): number {
	const n = safeSeq(value, path),
		max = path.endsWith("cols") ? 1000 : 500;
	if (n === 0 || n > max) fail("BOUNDS", "terminal dimension out of range", path);
	return n;
}
export function decodeTerminalClient(input: unknown): TerminalClientFrame {
	const x = frame(input, ["terminal.input", "terminal.resize", "terminal.close"]),
		type = x.type as string,
		ids = own(x),
		tid = terminalId(x.terminalId);
	if (type === "terminal.input") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			data =
				encoding === "base64"
					? boundedBase64(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES)
					: boundedText(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES),
			result = { ...x, type, ...ids, terminalId: tid, data } as TerminalInputFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	if (type === "terminal.resize")
		return {
			...x,
			type,
			...ids,
			terminalId: tid,
			cols: dimension(x.cols, "cols"),
			rows: dimension(x.rows, "rows"),
		} as TerminalResizeFrame;
	const result = { ...x, type, ...ids, terminalId: tid } as TerminalCloseFrame;
	if (x.reason !== undefined) result.reason = controlFree(x.reason, "reason", 256);
	return result;
}
export function decodeTerminalAdditive(input: unknown): TerminalServerFrame {
	const x = frame(input, ["terminal.output", "terminal.exit"]),
		type = x.type as string,
		ids = own(x),
		tid = terminalId(x.terminalId),
		cursor = cur(x.cursor);
	if (type === "terminal.output") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			data =
				encoding === "base64"
					? boundedBase64(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES)
					: boundedText(x.data, "data", MAX_TERMINAL_OUTPUT_BYTES),
			result = {
				...x,
				type,
				...ids,
				terminalId: tid,
				cursor,
				stream: known(x.stream, "stream", ["stdout", "stderr"]) as "stdout" | "stderr",
				data,
			} as TerminalOutputFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	const code = x.exitCode;
	if (typeof code !== "number" || !Number.isSafeInteger(code))
		fail("INVALID_FRAME", "exitCode must be safe integer", "exitCode");
	const result = { ...x, type, ...ids, terminalId: tid, cursor, exitCode: code } as TerminalExitFrame;
	if (x.signal !== undefined) result.signal = controlFree(x.signal, "signal", 128);
	return result;
}

export interface FileListEntry {
	path: string;
	kind: "file" | "directory" | "symlink";
	size?: number;
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesListFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.list";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	entries: FileListEntry[];
	cursor?: Cursor;
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesReadFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.read";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
	revision?: Revision;
	[key: string]: unknown;
}
export interface FilesWriteFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.write";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	content: string;
	encoding?: "utf8" | "base64";
	revision: Revision;
	[key: string]: unknown;
}
export interface FilesPatchFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.patch";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	patch: string;
	revision: Revision;
	[key: string]: unknown;
}
export interface FilesDiffFrame {
	v: typeof PROTOCOL_VERSION;
	type: "files.diff";
	hostId: HostId;
	sessionId: SessionId;
	path: string;
	diff: string;
	fromRevision?: Revision;
	toRevision?: Revision;
	[key: string]: unknown;
}
export type FilesAdditiveFrame = FilesListFrame | FilesReadFrame | FilesWriteFrame | FilesPatchFrame | FilesDiffFrame;
export function decodeFileListEntry(value: unknown, path: string): FileListEntry {
	const x = boundedMap(value, path),
		result = {
			...x,
			path: safeRelativePath(x.path, `${path}.path`),
			kind: known(x.kind, `${path}.kind`, ["file", "directory", "symlink"]) as FileListEntry["kind"],
		} as FileListEntry;
	if (x.size !== undefined) {
		const size = safeSeq(x.size, `${path}.size`);
		if (size > MAX_FILE_BYTES * 1024) fail("BOUNDS", "file size exceeds limit", `${path}.size`);
		result.size = size;
	}
	if (x.revision !== undefined) result.revision = revision(x.revision);
	return result;
}
export function decodeFilesAdditive(input: unknown): FilesAdditiveFrame {
	const x = frame(input, ["files.list", "files.read", "files.write", "files.patch", "files.diff"]),
		type = x.type as string,
		ids = own(x),
		path = safeRelativePath(x.path);
	if (type === "files.list") {
		const result = {
			...x,
			type,
			...ids,
			path,
			entries: boundedArray(x.entries, "entries").map((v, i) => decodeFileListEntry(v, `entries[${i}]`)),
		} as FilesListFrame;
		if (x.cursor !== undefined) result.cursor = cur(x.cursor);
		if (x.revision !== undefined) result.revision = revision(x.revision);
		return result;
	}
	if (type === "files.read") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			result = {
				...x,
				type,
				...ids,
				path,
				content:
					encoding === "base64"
						? boundedBase64(x.content, "content", MAX_FILE_BYTES)
						: boundedText(x.content, "content", MAX_FILE_BYTES),
			} as FilesReadFrame;
		if (encoding !== undefined) result.encoding = encoding;
		if (x.revision !== undefined) result.revision = revision(x.revision);
		return result;
	}
	if (type === "files.write") {
		const encoding =
				x.encoding === undefined
					? undefined
					: (known(x.encoding, "encoding", ["utf8", "base64"]) as "utf8" | "base64"),
			result = {
				...x,
				type,
				...ids,
				path,
				content:
					encoding === "base64"
						? boundedBase64(x.content, "content", MAX_FILE_BYTES)
						: boundedText(x.content, "content", MAX_FILE_BYTES),
				revision: revision(x.revision),
			} as FilesWriteFrame;
		if (encoding !== undefined) result.encoding = encoding;
		return result;
	}
	if (type === "files.patch")
		return {
			...x,
			type,
			...ids,
			path,
			patch: boundedText(x.patch, "patch", MAX_FILE_BYTES),
			revision: revision(x.revision),
		} as FilesPatchFrame;
	const result = { ...x, type, ...ids, path, diff: boundedText(x.diff, "diff", MAX_FILE_BYTES) } as FilesDiffFrame;
	if (x.fromRevision !== undefined) result.fromRevision = revision(x.fromRevision);
	if (x.toRevision !== undefined) result.toRevision = revision(x.toRevision);
	return result;
}

export interface AuditEvent {
	eventId: OperationId;
	hostId: HostId;
	sessionId?: SessionId;
	action: string;
	actor: string;
	timestamp: string;
	detail?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface AuditTailFrame {
	v: typeof PROTOCOL_VERSION;
	type: "audit.tail";
	hostId: HostId;
	cursor: Cursor;
	events: AuditEvent[];
	[key: string]: unknown;
}
export interface AuditEventFrame {
	v: typeof PROTOCOL_VERSION;
	type: "audit.event";
	hostId: HostId;
	event: AuditEvent;
	cursor: Cursor;
	[key: string]: unknown;
}
export function decodeAuditEvent(value: unknown, path: string): AuditEvent {
	const x = boundedMap(value, path),
		result = {
			...x,
			eventId: operationId(x.eventId),
			hostId: hostId(x.hostId),
			action: controlFree(x.action, `${path}.action`, 128),
			actor: controlFree(x.actor, `${path}.actor`, 256),
			timestamp: controlFree(x.timestamp, `${path}.timestamp`, 128),
		} as AuditEvent;
	if (x.sessionId !== undefined) result.sessionId = sessionId(x.sessionId);
	if (x.detail !== undefined) result.detail = boundedMetadata(x.detail, `${path}.detail`, isSecretLikeKey);
	return result;
}
export function decodeAuditAdditive(input: unknown): AuditTailFrame | AuditEventFrame {
	const x = frame(input, ["audit.tail", "audit.event"]),
		type = x.type as string;
	if (type === "audit.tail") {
		const host = hostId(x.hostId),
			events = boundedArray(x.events, "events").map((v, i) => decodeAuditEvent(v, `events[${i}]`));
		for (const event of events)
			if (event.hostId !== host) fail("INVALID_FRAME", "audit event belongs to another host", "events");
		return { ...x, type, hostId: host, cursor: cur(x.cursor), events } as AuditTailFrame;
	}
	const host = hostId(x.hostId),
		event = decodeAuditEvent(x.event, "event");
	if (event.hostId !== host) fail("INVALID_FRAME", "audit event belongs to another host", "event.hostId");
	return { ...x, type, hostId: host, event, cursor: cur(x.cursor) } as AuditEventFrame;
}

export const OPERATION_EXECUTIONS = ["typed", "headless", "terminal-only", "unavailable"] as const;
export type OperationExecution = (typeof OPERATION_EXECUTIONS)[number];

export const OPERATION_DISABLED_REASON_CODES = {
	terminalOnly: "terminal_only",
	capabilityUnavailable: "capability_unavailable",
} as const;

export interface OperationDisabledReason {
	code: string;
	message: string;
	[key: string]: unknown;
}

export interface OperationCapability {
	operationId: OperationId;
	label: string;
	description?: string;
	execution: OperationExecution;
	supported: boolean;
	disabledReason?: OperationDisabledReason;
	capabilities?: string[];
	[key: string]: unknown;
}

export type CatalogKind = "tool" | "model" | "command" | "setting" | "skill" | "agent" | "provider" | "mode";
export interface CatalogItem {
	id: CatalogId;
	kind: CatalogKind;
	name: string;
	description?: string;
	capabilities?: string[];
	supported?: boolean;
	reason?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}
export interface CatalogFrame {
	v: typeof PROTOCOL_VERSION;
	type: "catalog";
	hostId: HostId;
	revision: Revision;
	items: CatalogItem[];
	operations?: OperationCapability[];
	[key: string]: unknown;
}
export interface SettingsFrame {
	v: typeof PROTOCOL_VERSION;
	type: "settings";
	hostId: HostId;
	revision: Revision;
	settings: Record<string, unknown>;
	[key: string]: unknown;
}
function metadata(value: unknown, path: string): Record<string, unknown> {
	return boundedMetadata(value, path, isSecretLikeKey);
}
function decodeOperationDisabledReason(value: unknown, path: string): OperationDisabledReason {
	const x = boundedMap(value, path);
	return {
		...x,
		code: controlFree(x.code, `${path}.code`, 128),
		message: boundedText(x.message, `${path}.message`, 2048),
	};
}

export function decodeOperationCapability(value: unknown, path: string): OperationCapability {
	const x = boundedMap(value, path);
	const execution = known(x.execution, `${path}.execution`, OPERATION_EXECUTIONS) as OperationExecution;
	if (typeof x.supported !== "boolean")
		fail("INVALID_FRAME", "supported must be boolean", `${path}.supported`);
	const disabledReason =
		x.disabledReason === undefined
			? undefined
			: decodeOperationDisabledReason(x.disabledReason, `${path}.disabledReason`);
	if (!x.supported && !disabledReason)
		fail("INVALID_FRAME", "unsupported operation requires disabledReason", `${path}.disabledReason`);
	if (x.supported && disabledReason)
		fail("INVALID_FRAME", "supported operation cannot have disabledReason", `${path}.disabledReason`);
	if ((execution === "terminal-only" || execution === "unavailable") && x.supported)
		fail("INVALID_FRAME", `${execution} operation cannot be supported`, `${path}.supported`);
	const result: OperationCapability = {
		...x,
		operationId: operationId(x.operationId, `${path}.operationId`),
		label: controlFree(x.label, `${path}.label`, 256),
		execution,
		supported: x.supported,
	};
	if (x.description !== undefined)
		result.description = boundedText(x.description, `${path}.description`, 4096);
	if (disabledReason) result.disabledReason = disabledReason;
	if (x.capabilities !== undefined)
		result.capabilities = boundedArray(x.capabilities, `${path}.capabilities`, 128).map((v, i) =>
			controlFree(v, `${path}.capabilities[${i}]`, 128),
		);
	return result;
}

export function decodeCatalogItem(value: unknown, path: string): CatalogItem {
	const x = boundedMap(value, path),
		result = {
			...x,
			id: catalogId(x.id),
			kind: known(x.kind, `${path}.kind`, [
				"tool",
				"model",
				"command",
				"setting",
				"skill",
				"agent",
				"provider",
				"mode",
			]) as CatalogKind,
			name: controlFree(x.name, `${path}.name`, 256),
		} as CatalogItem;
	if (x.description !== undefined) result.description = boundedText(x.description, `${path}.description`, 4096);
	if (x.capabilities !== undefined)
		result.capabilities = boundedArray(x.capabilities, `${path}.capabilities`, 128).map((v, i) =>
			controlFree(v, `${path}.capabilities[${i}]`, 128),
		);
	if (x.supported !== undefined) {
		if (typeof x.supported !== "boolean") fail("INVALID_FRAME", "supported must be boolean", `${path}.supported`);
		result.supported = x.supported;
	}
	if (x.reason !== undefined) result.reason = boundedText(x.reason, `${path}.reason`, 2048);
	if (x.metadata !== undefined) result.metadata = metadata(x.metadata, `${path}.metadata`);
	return result;
}
export function decodeCatalog(input: unknown): CatalogFrame | SettingsFrame {
	const x = frame(input, ["catalog", "settings"]),
		type = x.type as string,
		host = hostId(x.hostId),
		rev = revision(x.revision);
	if (type === "catalog") {
		const result = {
			...x,
			type,
			hostId: host,
			revision: rev,
			items: boundedArray(x.items, "items").map((v, i) => decodeCatalogItem(v, `items[${i}]`)),
		} as CatalogFrame;
		if (x.operations !== undefined)
			result.operations = boundedArray(x.operations, "operations").map((v, i) =>
				decodeOperationCapability(v, `operations[${i}]`),
			);
		return result;
	}
	return {
		...x,
		type,
		hostId: host,
		revision: rev,
		settings: boundedSettings(x.settings, "settings"),
	} as SettingsFrame;
}

export const PREVIEW_CAPTURE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PreviewCaptureMimeType = (typeof PREVIEW_CAPTURE_MIME_TYPES)[number];
export type PreviewState = "launching" | "ready" | "running" | "stopped" | "failed";
export const PREVIEW_AUTHORITY_KINDS = ["isolated-session", "authenticated-profile"] as const;
export type PreviewAuthorityKind = (typeof PREVIEW_AUTHORITY_KINDS)[number];
export interface PreviewAuthorityDescriptor {
	readonly id: string;
	readonly label: string;
	readonly kind: PreviewAuthorityKind;
	readonly requiresExplicitOptIn: boolean;
}
export const PREVIEW_ACTIONS = [
	"activate",
	"navigate",
	"back",
	"forward",
	"reload",
	"close",
	"capture",
	"click",
	"fill",
	"type",
	"press",
	"scroll",
	"select",
	"upload",
	"handoff",
] as const;
export type PreviewAction = (typeof PREVIEW_ACTIONS)[number];
export interface PreviewViewport {
	readonly width: number;
	readonly height: number;
	readonly deviceScaleFactor?: number;
}
export interface PreviewCaptureMetadata {
	readonly captureId: PreviewCaptureId;
	readonly mimeType: PreviewCaptureMimeType;
	readonly size: number;
	readonly width: number;
	readonly height: number;
	readonly capturedAt: number;
	readonly sha256: string;
}
export interface PreviewSnapshot {
	readonly previewId: PreviewId;
	readonly state: PreviewState;
	readonly url: string;
	readonly revision: Revision;
	readonly cursor: Cursor;
	readonly title?: string;
	readonly canGoBack?: boolean;
	readonly canGoForward?: boolean;
	readonly viewport?: PreviewViewport;
	readonly capture?: PreviewCaptureMetadata;
	readonly authority?: PreviewAuthorityDescriptor;
	readonly availableActions?: readonly PreviewAction[];
}
export interface PreviewLaunchFrame extends PreviewSnapshot {
	v: typeof PROTOCOL_VERSION;
	type: "preview.launch";
	hostId: HostId;
	sessionId: SessionId;
	[key: string]: unknown;
}
export interface PreviewStateFrame extends PreviewSnapshot {
	v: typeof PROTOCOL_VERSION;
	type: "preview.state";
	hostId: HostId;
	sessionId: SessionId;
	error?: string;
	[key: string]: unknown;
}
export interface PreviewNavigationFrame extends PreviewSnapshot {
	v: typeof PROTOCOL_VERSION;
	type: "preview.navigation";
	hostId: HostId;
	sessionId: SessionId;
	[key: string]: unknown;
}
export interface PreviewCaptureFrame extends PreviewSnapshot {
	v: typeof PROTOCOL_VERSION;
	type: "preview.capture";
	hostId: HostId;
	sessionId: SessionId;
	capture: PreviewCaptureMetadata;
	[key: string]: unknown;
}
export interface PreviewErrorFrame {
	v: typeof PROTOCOL_VERSION;
	type: "preview.error";
	hostId: HostId;
	sessionId: SessionId;
	previewId: PreviewId;
	cursor: Cursor;
	revision: Revision;
	code: string;
	message: string;
	[key: string]: unknown;
}
export type PreviewFrame =
	| PreviewLaunchFrame
	| PreviewStateFrame
	| PreviewNavigationFrame
	| PreviewCaptureFrame
	| PreviewErrorFrame;

function previewCaptureMimeType(value: unknown, path: string): PreviewCaptureMimeType {
	if (typeof value !== "string" || !(PREVIEW_CAPTURE_MIME_TYPES as readonly string[]).includes(value))
		fail("INVALID_FRAME", "unsupported preview capture MIME type", path);
	return value as PreviewCaptureMimeType;
}

export function decodePreviewViewport(value: unknown, path = "viewport"): PreviewViewport {
	const x = inputObject(value);
	const width = safeSeq(x.width, `${path}.width`);
	const height = safeSeq(x.height, `${path}.height`);
	if (width === 0 || height === 0 || width * height > PREVIEW_CAPTURE_MAX_PIXELS)
		fail("BOUNDS", "preview viewport dimensions exceed limit", path);
	const result: { width: number; height: number; deviceScaleFactor?: number } = { width, height };
	if (x.deviceScaleFactor !== undefined) {
		const scale = finiteNumber(x.deviceScaleFactor, `${path}.deviceScaleFactor`);
		if (scale <= 0 || scale > 8)
			fail("BOUNDS", "preview device scale factor exceeds limit", `${path}.deviceScaleFactor`);
		result.deviceScaleFactor = scale;
	}
	return result;
}

export function decodePreviewCaptureMetadata(value: unknown, path = "capture"): PreviewCaptureMetadata {
	const x = inputObject(value);
	const size = safeSeq(x.size, `${path}.size`);
	const width = safeSeq(x.width, `${path}.width`);
	const height = safeSeq(x.height, `${path}.height`);
	if (size === 0 || size > PREVIEW_CAPTURE_MAX_BYTES)
		fail("BOUNDS", "preview capture size exceeds limit", `${path}.size`);
	if (width === 0 || height === 0 || width * height > PREVIEW_CAPTURE_MAX_PIXELS)
		fail("BOUNDS", "preview capture dimensions exceed limit", path);
	const digest = controlFree(x.sha256, `${path}.sha256`, 64);
	if (!/^[0-9a-f]{64}$/u.test(digest))
		fail("INVALID_FRAME", "preview capture digest must be lowercase sha256", `${path}.sha256`);
	return {
		captureId: previewCaptureId(x.captureId, `${path}.captureId`),
		mimeType: previewCaptureMimeType(x.mimeType, `${path}.mimeType`),
		size,
		width,
		height,
		capturedAt: safeSeq(x.capturedAt, `${path}.capturedAt`),
		sha256: digest,
	};
}

export function decodePreviewAuthority(value: unknown, path = "authority"): PreviewAuthorityDescriptor {
	const x = inputObject(value);
	if (typeof x.requiresExplicitOptIn !== "boolean")
		fail("INVALID_FRAME", "preview authority requiresExplicitOptIn must be boolean", `${path}.requiresExplicitOptIn`);
	return {
		id: controlFree(x.id, `${path}.id`, 128),
		label: boundedText(x.label, `${path}.label`, 256),
		kind: known(x.kind, `${path}.kind`, PREVIEW_AUTHORITY_KINDS) as PreviewAuthorityKind,
		requiresExplicitOptIn: x.requiresExplicitOptIn,
	};
}

function decodePreviewActions(value: unknown, path: string): readonly PreviewAction[] {
	const actions = boundedArray(value, path, PREVIEW_ACTIONS.length).map((item, index) =>
		known(item, `${path}[${index}]`, PREVIEW_ACTIONS),
	) as PreviewAction[];
	if (new Set(actions).size !== actions.length) fail("INVALID_FRAME", "preview actions must be unique", path);
	return actions;
}

export function decodePreviewSnapshot(value: unknown, path = "preview"): PreviewSnapshot {
	const x = inputObject(value);
	const result: {
		previewId: PreviewId;
		state: PreviewState;
		url: string;
		revision: Revision;
		cursor: Cursor;
		title?: string;
		canGoBack?: boolean;
		canGoForward?: boolean;
		viewport?: PreviewViewport;
		capture?: PreviewCaptureMetadata;
		authority?: PreviewAuthorityDescriptor;
		availableActions?: readonly PreviewAction[];
	} = {
		previewId: previewId(x.previewId, `${path}.previewId`),
		state: known(x.state, `${path}.state`, ["launching", "ready", "running", "stopped", "failed"]) as PreviewState,
		url: httpUrl(x.url, `${path}.url`),
		revision: revision(x.revision, `${path}.revision`),
		cursor: decodeCursor(x.cursor, `${path}.cursor`),
	};
	if (x.title !== undefined) result.title = boundedText(x.title, `${path}.title`, 512);
	if (x.canGoBack !== undefined) {
		if (typeof x.canGoBack !== "boolean") fail("INVALID_FRAME", "canGoBack must be boolean", `${path}.canGoBack`);
		result.canGoBack = x.canGoBack;
	}
	if (x.canGoForward !== undefined) {
		if (typeof x.canGoForward !== "boolean")
			fail("INVALID_FRAME", "canGoForward must be boolean", `${path}.canGoForward`);
		result.canGoForward = x.canGoForward;
	}
	if (x.viewport !== undefined) result.viewport = decodePreviewViewport(x.viewport, `${path}.viewport`);
	if (x.capture !== undefined) result.capture = decodePreviewCaptureMetadata(x.capture, `${path}.capture`);
	if (x.authority !== undefined) result.authority = decodePreviewAuthority(x.authority, `${path}.authority`);
	if (x.availableActions !== undefined)
		result.availableActions = decodePreviewActions(x.availableActions, `${path}.availableActions`);
	return result;
}

export function decodePreview(input: unknown): PreviewFrame {
	const x = frame(input, [
			"preview.launch",
			"preview.state",
			"preview.navigation",
			"preview.capture",
			"preview.error",
		]),
		type = x.type as string,
		ids = own(x);
	if (type === "preview.error")
		return {
			...x,
			type,
			...ids,
			previewId: previewId(x.previewId),
			cursor: decodeCursor(x.cursor),
			revision: revision(x.revision),
			code: controlFree(x.code, "code", 128),
			message: boundedText(x.message, "message", 2048),
		} as PreviewErrorFrame;
	const snapshot = decodePreviewSnapshot(x, "preview");
	const result = { ...x, type, ...ids, ...snapshot };
	if (type === "preview.state" && x.error !== undefined)
		return { ...result, error: boundedText(x.error, "error", 2048) } as PreviewStateFrame;
	if (type === "preview.launch") return result as PreviewLaunchFrame;
	if (type === "preview.navigation") return result as PreviewNavigationFrame;
	if (type === "preview.capture") {
		if (snapshot.capture === undefined)
			fail("INVALID_FRAME", "preview capture frame requires capture metadata", "capture");
		return result as PreviewCaptureFrame;
	}
	return result as PreviewStateFrame;
}

export type AdditiveServerFrame =
	| WatchFrame
	| LeaseFrame
	| PromptLeaseFrame
	| AgentAdditiveFrame
	| TerminalServerFrame
	| FilesAdditiveFrame
	| AuditTailFrame
	| AuditEventFrame
	| CatalogFrame
	| SettingsFrame
	| WorkspaceStateFrame
	| PreviewFrame;
export function decodeAdditiveServerFrame(input: unknown): AdditiveServerFrame {
	const type = inputObject(input).type;
	if (typeof type !== "string") fail("INVALID_FRAME", "frame type must be string", "type");
	if (type === "workspace.state") return decodeWorkspaceState(input);
	if (["host.watch", "session.watch", "session.state", "session.delta"].includes(type)) return decodeWatch(input);
	if (type === "lease" || type === "prompt.lease") return decodeLease(input);
	if (type.startsWith("agent.")) return decodeAgentAdditive(input);
	if (type === "terminal.output" || type === "terminal.exit") return decodeTerminalAdditive(input);
	if (type.startsWith("files.")) return decodeFilesAdditive(input);
	if (type === "audit.tail" || type === "audit.event") return decodeAuditAdditive(input);
	if (type === "catalog" || type === "settings") return decodeCatalog(input);
	if (type.startsWith("preview.")) return decodePreview(input);
	fail("UNKNOWN_FRAME", "unknown additive server frame family", "type");
}
export function isNegotiatedFeature(feature: string, granted: readonly string[]): boolean {
	return granted.includes(feature);
}
