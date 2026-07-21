import {
	decodeSessionCiState,
	decodeSessionClusterState,
	type SessionCiState,
	type SessionClusterState,
} from "./cluster.js";
import { type Cursor, decodeCursor } from "./cursor.js";
import { fail } from "./errors.js";
import {
	bool,
	boundedArray,
	boundedMap,
	boundedMetadata,
	controlFree,
	inputObject,
	isSecretLikeKey,
	optionalString,
	safeSeq,
} from "./guards.js";
import {
	type HostId,
	hostId,
	type ProjectId,
	projectId,
	type Revision,
	revision,
	type SessionId,
	sessionId,
} from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";

export const ATTENTION_MAX_PENDING_ITEMS = 8;
export const ATTENTION_MAX_QUESTION_OPTIONS = 32;
export const ATTENTION_MAX_ID_BYTES = 256;
export const ATTENTION_MAX_TITLE_BYTES = 256;
export const ATTENTION_MAX_SUMMARY_BYTES = 2_048;

export interface AttentionOption {
	id: string;
	label: string;
}

export type PendingAttentionItem =
	| {
			kind: "approval";
			id: string;
			title: string;
			summary: string;
			requestedAt: string;
	  }
	| {
			kind: "question";
			id: string;
			question: string;
			options: AttentionOption[];
			allowText: boolean;
			requestedAt: string;
	  }
	| {
			kind: "plan";
			id: string;
			title: string;
			summary: string;
			requestedAt: string;
	  };

export interface AttentionOutcome {
	id: string;
	kind: "completed" | "failed" | "cancelled";
	at: string;
	summary: string;
}

export interface SessionAttentionState {
	pending: PendingAttentionItem[];
	pendingCount: number;
	truncated: boolean;
	latestOutcome?: AttentionOutcome;
}
export interface ProjectIdentity {
	projectId: ProjectId;
	name?: string;
}
export interface ContextUsage {
	used: number;
	limit: number;
}
export interface SessionRuntime {
	id: string;
	workspaceInstanceId?: string;
}
export type SessionObserverLockStatus = "live" | "suspect" | "malformed";
export type SessionObserverTranscript = "live" | "snapshot";
export type ProviderTransportPolicy = "auto" | "on" | "off";
export type ProviderTransportKind = "websocket" | "sse";
export interface ProviderTransportState {
	provider: "openai-codex";
	configuredPolicy: ProviderTransportPolicy;
	websocketPreferred: boolean;
	lastTransport?: ProviderTransportKind;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	fullContextRequests: number;
	deltaRequests: number;
	inputJsonBytes: number;
	lastInputJsonBytes?: number;
}
export type SessionControlState =
	| {
			mode: "observer";
			lockStatus: SessionObserverLockStatus;
			transcript: SessionObserverTranscript;
	  }
	| {
			mode: "reconciling";
			transcript: SessionObserverTranscript;
	  };
export interface SessionLiveState {
	sessionControl?: SessionControlState;
	providerTransport?: ProviderTransportState;
	cluster?: SessionClusterState;
	ci?: SessionCiState;
	[key: string]: unknown;
}
export interface SessionRef {
	hostId: HostId;
	sessionId: SessionId;
	project: ProjectIdentity;
	revision: Revision;
	title: string;
	status: "active" | "idle" | "closed" | (string & {});
	updatedAt: string;
	archivedAt?: string;
	liveState?: SessionLiveState;
	model?: string;
	thinking?: string;
	pendingApproval?: boolean;
	pendingUserInput?: boolean;
	proposedPlan?: string;
	contextUsage?: ContextUsage;
	attention?: SessionAttentionState;
	runtime?: SessionRuntime;
}
export interface SessionListResult {
	cursor: Cursor;
	sessions: SessionRef[];
	totalCount: number;
	truncated: boolean;
}
export interface SessionsFrame {
	v: typeof PROTOCOL_VERSION;
	type: "sessions";
	hostId?: HostId;
	cursor: Cursor;
	sessions: SessionRef[];
	totalCount?: number;
	truncated?: boolean;
}
function decodeSessionControl(value: unknown, path: string): SessionControlState {
	const control = boundedMap(value, path);
	if (control.mode === "observer") {
		if (control.lockStatus !== "live" && control.lockStatus !== "suspect" && control.lockStatus !== "malformed")
			fail("INVALID_FRAME", "invalid observer lock status", `${path}.lockStatus`);
		if (control.transcript !== "live" && control.transcript !== "snapshot")
			fail("INVALID_FRAME", "invalid observer transcript state", `${path}.transcript`);
		if (Object.keys(control).some(key => !["mode", "lockStatus", "transcript"].includes(key)))
			fail("INVALID_FRAME", "unknown observer session control field", path);
		return control as unknown as SessionControlState;
	}
	if (control.mode === "reconciling") {
		if (control.transcript !== "live" && control.transcript !== "snapshot")
			fail("INVALID_FRAME", "invalid reconciling transcript state", `${path}.transcript`);
		if (Object.keys(control).some(key => !["mode", "transcript"].includes(key)))
			fail("INVALID_FRAME", "unknown reconciling session control field", path);
		return control as unknown as SessionControlState;
	}
	fail("INVALID_FRAME", "invalid session control mode", `${path}.mode`);
}
const PROVIDER_TRANSPORT_KEYS = new Set([
	"provider",
	"configuredPolicy",
	"websocketPreferred",
	"lastTransport",
	"websocketDisabled",
	"websocketConnected",
	"fallbackCount",
	"canAppend",
	"prewarmed",
	"hasSessionState",
	"hasTurnState",
	"fullContextRequests",
	"deltaRequests",
	"inputJsonBytes",
	"lastInputJsonBytes",
]);
export function decodeProviderTransportState(value: unknown, path: string): ProviderTransportState {
	const raw = boundedMap(value, path);
	for (const key of Object.keys(raw))
		if (!PROVIDER_TRANSPORT_KEYS.has(key))
			fail("INVALID_FRAME", "unknown provider transport field", `${path}.${key}`);
	if (raw.provider !== "openai-codex")
		fail("INVALID_FRAME", "invalid provider transport provider", `${path}.provider`);
	if (raw.configuredPolicy !== "auto" && raw.configuredPolicy !== "on" && raw.configuredPolicy !== "off")
		fail("INVALID_FRAME", "invalid provider transport policy", `${path}.configuredPolicy`);
	if (raw.lastTransport !== undefined && raw.lastTransport !== "websocket" && raw.lastTransport !== "sse")
		fail("INVALID_FRAME", "invalid provider transport kind", `${path}.lastTransport`);
	return {
		provider: raw.provider,
		configuredPolicy: raw.configuredPolicy,
		websocketPreferred: bool(raw.websocketPreferred, `${path}.websocketPreferred`),
		...(raw.lastTransport === undefined ? {} : { lastTransport: raw.lastTransport }),
		websocketDisabled: bool(raw.websocketDisabled, `${path}.websocketDisabled`),
		websocketConnected: bool(raw.websocketConnected, `${path}.websocketConnected`),
		fallbackCount: safeSeq(raw.fallbackCount, `${path}.fallbackCount`),
		canAppend: bool(raw.canAppend, `${path}.canAppend`),
		prewarmed: bool(raw.prewarmed, `${path}.prewarmed`),
		hasSessionState: bool(raw.hasSessionState, `${path}.hasSessionState`),
		hasTurnState: bool(raw.hasTurnState, `${path}.hasTurnState`),
		fullContextRequests: safeSeq(raw.fullContextRequests, `${path}.fullContextRequests`),
		deltaRequests: safeSeq(raw.deltaRequests, `${path}.deltaRequests`),
		inputJsonBytes: safeSeq(raw.inputJsonBytes, `${path}.inputJsonBytes`),
		...(raw.lastInputJsonBytes === undefined
			? {}
			: { lastInputJsonBytes: safeSeq(raw.lastInputJsonBytes, `${path}.lastInputJsonBytes`) }),
	};
}
function decodeListMetadata(
	value: Record<string, unknown>,
	path: string,
	sessionCount: number,
): { totalCount: number; truncated: boolean } {
	const totalCount = value.totalCount === undefined ? sessionCount : safeSeq(value.totalCount, `${path}.totalCount`);
	const truncated = value.truncated === undefined ? totalCount > sessionCount : value.truncated;
	if (typeof truncated !== "boolean") fail("INVALID_FRAME", "truncated must be boolean", `${path}.truncated`);
	if (totalCount < sessionCount)
		fail("INVALID_FRAME", "totalCount cannot be less than sessions length", `${path}.totalCount`);
	if (truncated !== totalCount > sessionCount) fail("INVALID_FRAME", "truncated does not match totalCount", path);
	return { totalCount, truncated };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(value))
		if (!allowedKeys.has(key) || isSecretLikeKey(key))
			fail("INVALID_FRAME", "unknown attention field", `${path}.${key}`);
}

function canonicalTimestamp(value: unknown, path: string): string {
	const timestamp = controlFree(value, path, 128);
	const milliseconds = Date.parse(timestamp);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp)
		fail("INVALID_FRAME", "timestamp must be canonical ISO", path);
	return timestamp;
}

function decodeAttentionOption(value: unknown, path: string): AttentionOption {
	const option = boundedMap(value, path);
	exactKeys(option, ["id", "label"], path);
	return {
		id: controlFree(option.id, `${path}.id`, ATTENTION_MAX_ID_BYTES),
		label: controlFree(option.label, `${path}.label`, ATTENTION_MAX_TITLE_BYTES),
	};
}

function decodePendingAttentionItem(value: unknown, path: string): PendingAttentionItem {
	const item = boundedMap(value, path);
	if (item.kind === "approval" || item.kind === "plan") {
		exactKeys(item, ["kind", "id", "title", "summary", "requestedAt"], path);
		return {
			kind: item.kind,
			id: controlFree(item.id, `${path}.id`, ATTENTION_MAX_ID_BYTES),
			title: controlFree(item.title, `${path}.title`, ATTENTION_MAX_TITLE_BYTES),
			summary: controlFree(item.summary, `${path}.summary`, ATTENTION_MAX_SUMMARY_BYTES),
			requestedAt: canonicalTimestamp(item.requestedAt, `${path}.requestedAt`),
		};
	}
	if (item.kind === "question") {
		exactKeys(item, ["kind", "id", "question", "options", "allowText", "requestedAt"], path);
		const options = boundedArray(item.options, `${path}.options`, ATTENTION_MAX_QUESTION_OPTIONS).map(
			(option, index) => decodeAttentionOption(option, `${path}.options[${index}]`),
		);
		if (new Set(options.map(option => option.id)).size !== options.length)
			fail("INVALID_FRAME", "duplicate attention option id", `${path}.options`);
		return {
			kind: "question",
			id: controlFree(item.id, `${path}.id`, ATTENTION_MAX_ID_BYTES),
			question: controlFree(item.question, `${path}.question`, ATTENTION_MAX_SUMMARY_BYTES),
			options,
			allowText: bool(item.allowText, `${path}.allowText`),
			requestedAt: canonicalTimestamp(item.requestedAt, `${path}.requestedAt`),
		};
	}
	fail("INVALID_FRAME", "invalid pending attention kind", `${path}.kind`);
}

function decodeAttentionOutcome(value: unknown, path: string): AttentionOutcome {
	const outcome = boundedMap(value, path);
	exactKeys(outcome, ["id", "kind", "at", "summary"], path);
	if (outcome.kind !== "completed" && outcome.kind !== "failed" && outcome.kind !== "cancelled")
		fail("INVALID_FRAME", "invalid attention outcome kind", `${path}.kind`);
	return {
		id: controlFree(outcome.id, `${path}.id`, ATTENTION_MAX_ID_BYTES),
		kind: outcome.kind,
		at: canonicalTimestamp(outcome.at, `${path}.at`),
		summary: controlFree(outcome.summary, `${path}.summary`, ATTENTION_MAX_SUMMARY_BYTES),
	};
}

export function decodeSessionAttentionState(value: unknown, path: string): SessionAttentionState {
	const attention = boundedMap(value, path);
	exactKeys(attention, ["pending", "pendingCount", "truncated", "latestOutcome"], path);
	const pending = boundedArray(attention.pending, `${path}.pending`, ATTENTION_MAX_PENDING_ITEMS).map((item, index) =>
		decodePendingAttentionItem(item, `${path}.pending[${index}]`),
	);
	if (new Set(pending.map(item => item.id)).size !== pending.length)
		fail("INVALID_FRAME", "duplicate pending attention id", `${path}.pending`);
	const pendingCount = safeSeq(attention.pendingCount, `${path}.pendingCount`);
	if (pendingCount < pending.length)
		fail("INVALID_FRAME", "pendingCount cannot be less than pending length", `${path}.pendingCount`);
	const truncated = bool(attention.truncated, `${path}.truncated`);
	if (truncated !== pendingCount > pending.length)
		fail("INVALID_FRAME", "attention truncated does not match pendingCount", path);
	return {
		pending,
		pendingCount,
		truncated,
		...(attention.latestOutcome === undefined
			? {}
			: { latestOutcome: decodeAttentionOutcome(attention.latestOutcome, `${path}.latestOutcome`) }),
	};
}
function decodeSessionRuntime(value: unknown, path: string): SessionRuntime {
	const runtime = boundedMap(value, path);
	for (const key of Object.keys(runtime))
		if (key !== "id" && key !== "workspaceInstanceId")
			fail("INVALID_FRAME", "unknown session runtime field", `${path}.${key}`);
	return {
		id: controlFree(runtime.id, `${path}.id`, 64),
		...(runtime.workspaceInstanceId === undefined
			? {}
			: { workspaceInstanceId: controlFree(runtime.workspaceInstanceId, `${path}.workspaceInstanceId`, 128) }),
	};
}

export function decodeSessionRef(value: unknown, path: string): SessionRef {
	const session = boundedMap(value, path);
	hostId(session.hostId, `${path}.hostId`);
	sessionId(session.sessionId, `${path}.sessionId`);
	revision(session.revision, `${path}.revision`);
	const project = boundedMap(session.project, `${path}.project`);
	projectId(project.projectId, `${path}.project.projectId`);
	if (project.name !== undefined) optionalString(project.name, `${path}.project.name`, 256);
	controlFree(session.title, `${path}.title`, 512);
	controlFree(session.status, `${path}.status`, 64);
	controlFree(session.updatedAt, `${path}.updatedAt`, 128);
	if (session.archivedAt !== undefined) {
		const archivedAt = controlFree(session.archivedAt, `${path}.archivedAt`, 128);
		const timestamp = Date.parse(archivedAt);
		if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== archivedAt)
			fail("INVALID_FRAME", "archivedAt must be a canonical ISO timestamp", `${path}.archivedAt`);
	}
	if (session.liveState !== undefined) {
		boundedMetadata(session.liveState, `${path}.liveState`, isSecretLikeKey);
		const liveState = session.liveState as Record<string, unknown>;
		if (liveState.sessionControl !== undefined)
			decodeSessionControl(liveState.sessionControl, `${path}.liveState.sessionControl`);
		if (liveState.providerTransport !== undefined)
			decodeProviderTransportState(liveState.providerTransport, `${path}.liveState.providerTransport`);
		if (liveState.cluster !== undefined)
			decodeSessionClusterState(liveState.cluster, `${path}.liveState.cluster`);
		if (liveState.ci !== undefined) decodeSessionCiState(liveState.ci, `${path}.liveState.ci`);
	}
	if (session.model !== undefined) controlFree(session.model, `${path}.model`, 256);
	if (session.thinking !== undefined) controlFree(session.thinking, `${path}.thinking`, 256);
	if (session.pendingApproval !== undefined && typeof session.pendingApproval !== "boolean")
		fail("INVALID_FRAME", "pendingApproval must be boolean", `${path}.pendingApproval`);
	if (session.pendingUserInput !== undefined && typeof session.pendingUserInput !== "boolean")
		fail("INVALID_FRAME", "pendingUserInput must be boolean", `${path}.pendingUserInput`);
	if (session.proposedPlan !== undefined) optionalString(session.proposedPlan, `${path}.proposedPlan`, 4096);
	if (session.contextUsage !== undefined) {
		const usage = boundedMap(session.contextUsage, `${path}.contextUsage`);
		if (
			typeof usage.used !== "number" ||
			!Number.isSafeInteger(usage.used) ||
			usage.used < 0 ||
			typeof usage.limit !== "number" ||
			!Number.isSafeInteger(usage.limit) ||
			usage.limit < 0 ||
			usage.used > usage.limit
		)
			fail("BOUNDS", "invalid context usage", `${path}.contextUsage`);
	}
	if (session.attention !== undefined) decodeSessionAttentionState(session.attention, `${path}.attention`);
	if (session.runtime !== undefined) decodeSessionRuntime(session.runtime, `${path}.runtime`);
	return session as unknown as SessionRef;
}
export function decodeSessionListResult(value: unknown): SessionListResult {
	const result = boundedMap(value, "result");
	const cursor = decodeCursor(result.cursor, "result.cursor");
	const values = boundedArray(result.sessions, "result.sessions");
	const sessions = values.map((entry, index) => decodeSessionRef(entry, `result.sessions[${index}]`));
	return {
		...result,
		cursor,
		sessions,
		...decodeListMetadata(result, "result", sessions.length),
	} as SessionListResult;
}
export function decodeSessions(input: unknown): SessionsFrame {
	const frame = inputObject(input);
	if (frame.v !== PROTOCOL_VERSION) fail("MISSING_VERSION", `expected ${PROTOCOL_VERSION}`, "v");
	if (frame.type !== "sessions") fail("INVALID_FRAME", "expected sessions frame", "type");
	const decodedHostId = frame.hostId === undefined ? undefined : hostId(frame.hostId, "hostId");
	const cursor = decodeCursor(frame.cursor);
	const values = boundedArray(frame.sessions, "sessions");
	const sessions = values.map((entry, index) => decodeSessionRef(entry, `sessions[${index}]`));
	const metadata = decodeListMetadata(frame, "frame", sessions.length);
	return {
		...frame,
		...(decodedHostId ? { hostId: decodedHostId } : {}),
		cursor,
		sessions,
		...metadata,
	} as unknown as SessionsFrame;
}
