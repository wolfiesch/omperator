import {
	ATTENTION_MAX_QUESTION_OPTIONS,
	type DurableEntry,
	type PendingAttentionItem,
	type SessionEvent,
} from "@t4-code/host-wire";
import type { AgentSessionEvent, RpcSessionEventFrame, RpcSubagentEventFrame } from "./omp-rpc-contract.ts";
import { cleanText, projectToolArguments, projectToolResultDetails } from "./discovery.ts";
import { type XdevWriteCall, xdevExecutionMatches, xdevResultEnvelope, xdevWriteCall } from "./xdev-envelope.ts";

export type TranscriptMessageEvent = {
	type: "message.update";
	entryId: string;
	role: "assistant" | "user";
	text: string;
	reasoning: string;
	/** Safe prompt attachment cardinality; image bytes and transport refs stay out of transcript events. */
	attachmentCount?: number;
	at: string;
};
export type TranscriptMessageSettledEvent = {
	type: "message.settled";
	transientEntryId: string;
	entryId: string;
	at: string;
};
export type TranscriptMessageDiscardedEvent = {
	type: "message.discarded";
	transientEntryId: string;
	reason: "rejected" | "local-only" | "failed" | "cancelled" | "completed-without-entry";
	at: string;
};
export type TranscriptToolStartEvent = {
	type: "tool.start";
	callId: string;
	tool: string;
	title: string;
	args: unknown;
	at: string;
};
export type TranscriptToolProgressEvent = {
	type: "tool.progress";
	callId: string;
	note?: string;
	chunk?: string;
	progress?: number;
	at: string;
};
export type TranscriptToolResultEvent = {
	type: "tool.result";
	callId: string;
	ok: boolean;
	result: unknown;
	at: string;
};
export type TranscriptEvent =
	| { type: "turn.start"; at: string }
	| { type: "turn.end"; at: string }
	| {
			type: "turn.error";
			message: string;
			at: string;
			errorStatus?: number;
			errorId?: number;
	  }
	| TranscriptMessageEvent
	| TranscriptMessageSettledEvent
	| TranscriptMessageDiscardedEvent
	| TranscriptToolStartEvent
	| TranscriptToolProgressEvent
	| TranscriptToolResultEvent;
export type RuntimeLifecycleEvent =
	| { type: "agent.start"; at: string }
	| {
			type: "agent.end";
			status: "completed" | "failed" | "cancelled";
			messageCount: number;
			at: string;
	  }
	| {
			type: "compaction.start";
			reason: "threshold" | "overflow" | "idle" | "incomplete";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			at: string;
	  }
	| {
			type: "compaction.end";
			action: "context-full" | "handoff" | "shake" | "snapcompact";
			status: "completed" | "failed" | "aborted" | "skipped";
			willRetry: boolean;
			at: string;
			summary?: string;
			tokensBefore?: number;
			firstKeptEntryId?: string;
			error?: string;
	  }
	| {
			type: "turn.retry";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			reason: string;
			at: string;
			errorId?: number;
	  }
	| {
			type: "turn.retry.result";
			success: boolean;
			attempt: number;
			at: string;
			finalError?: string;
			recoveredCount?: number;
	  }
	| { type: "model.fallback"; from: string; to: string; role: string; at: string }
	| { type: "model.fallback.result"; model: string; role: string; success: true; at: string }
	| {
			type: "ttsr.triggered";
			rules: Array<{ name: string; description?: string }>;
			truncated: boolean;
			at: string;
	  }
	| {
			type: "todo.reminder";
			todos: Array<{ content: string; status: "pending" | "in_progress" | "completed" | "abandoned" }>;
			attempt: number;
			maxAttempts: number;
			truncated: boolean;
			at: string;
	  }
	| { type: "todo.cleared"; source: "automatic"; at: string }
	| {
			type: "irc.message";
			kind: string;
			text: string;
			at: string;
			from?: string;
			to?: string;
			replyTo?: string;
	  }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; at: string; source?: string }
	| {
			type: "thinking.level.changed";
			thinkingLevel: string | null;
			at: string;
			configured?: string;
			resolved?: string;
	  }
	| {
			type: "goal.updated";
			goal: SafeGoal | null;
			at: string;
			mode?: { enabled: boolean; mode: "active" | "exiting"; reason?: "completed" };
	  }
	| {
			type: "agent.event";
			agentId: string;
			event: string;
			at: string;
			detail?: Record<string, unknown>;
	  };
export interface SafeGoal {
	id: string;
	objective: string;
	status: "active" | "paused" | "budget-limited" | "complete" | "dropped";
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
	tokenBudget?: number;
}
export type AskRequestEvent = {
	type: "ask.request";
	askId: string;
	question: string;
	options?: Array<{ id: string; label: string }>;
	allowText: boolean;
	responseKind: "value";
	source: "rpc-ui";
	at: string;
};
export type ApprovalRequestEvent = {
	type: "approval.request";
	approvalId: string;
	title: string;
	message: string;
	responseKind: "confirmed";
	source: "rpc-ui";
	at: string;
};
export type AskResolvedEvent = { type: "ask.resolved"; askId: string; at: string };
export type ApprovalResolvedEvent = { type: "approval.resolved"; approvalId: string; at: string };
export type AppserverEvent =
	| TranscriptEvent
	| RuntimeLifecycleEvent
	| AskRequestEvent
	| ApprovalRequestEvent
	| AskResolvedEvent
	| ApprovalResolvedEvent;
export type PendingUiRequest =
	| { kind: "ask"; id: string; attention: Extract<PendingAttentionItem, { kind: "question" }> }
	| { kind: "approval"; id: string; attention: Extract<PendingAttentionItem, { kind: "approval" }> };
interface MessageSnapshot {
	text: string;
	reasoning: string;
	at: string;
}
interface ActiveAssistant {
	entryId: string;
	last: MessageSnapshot | undefined;
	ended: boolean;
}
interface ToolState {
	state: "open" | "closed";
	at: string;
	xdevCall?: XdevWriteCall;
}
interface UiState {
	kind: "ask" | "approval";
	at: string;
	attention: Extract<PendingAttentionItem, { kind: "question" | "approval" }>;
}
export type AppserverRpcFrameDisposition = "translated" | "separately-projected" | "intentionally-internal";
type AgentSessionEventType = AgentSessionEvent["type"];
type RpcOutOfBandType = Exclude<RpcSessionEventFrame["type"], AgentSessionEventType>;

/**
 * Exhaustive raw-to-canonical contract for the authoritative session event union.
 * `satisfies` makes an upstream addition a compile failure until appserver makes
 * an explicit broadcast decision for it.
 */
export const AGENT_SESSION_EVENT_DISPOSITIONS = {
	agent_start: { disposition: "translated", canonical: "agent.start" },
	agent_end: { disposition: "translated", canonical: "agent.end" },
	turn_start: { disposition: "translated", canonical: "turn.start" },
	turn_end: { disposition: "translated", canonical: "turn.end" },
	message_start: { disposition: "translated", canonical: "message.update" },
	message_update: { disposition: "translated", canonical: "message.update" },
	message_end: { disposition: "translated", canonical: "message.update" },
	message_persisted: { disposition: "translated", canonical: "message.settled" },
	tool_execution_start: { disposition: "translated", canonical: "tool.start" },
	tool_execution_update: { disposition: "translated", canonical: "tool.progress" },
	tool_execution_end: { disposition: "translated", canonical: "tool.result" },
	auto_compaction_start: { disposition: "translated", canonical: "compaction.start" },
	auto_compaction_end: { disposition: "translated", canonical: "compaction.end" },
	auto_retry_start: { disposition: "translated", canonical: "turn.retry" },
	auto_retry_end: { disposition: "translated", canonical: "turn.retry.result" },
	retry_fallback_applied: { disposition: "translated", canonical: "model.fallback" },
	retry_fallback_succeeded: { disposition: "translated", canonical: "model.fallback.result" },
	ttsr_triggered: { disposition: "translated", canonical: "ttsr.triggered" },
	todo_reminder: { disposition: "translated", canonical: "todo.reminder" },
	todo_auto_clear: { disposition: "translated", canonical: "todo.cleared" },
	irc_message: { disposition: "translated", canonical: "irc.message" },
	notice: { disposition: "translated", canonical: "notice" },
	thinking_level_changed: { disposition: "translated", canonical: "thinking.level.changed" },
	goal_updated: { disposition: "translated", canonical: "goal.updated" },
} as const satisfies Record<
	AgentSessionEventType,
	{ disposition: Extract<AppserverRpcFrameDisposition, "translated">; canonical: string }
>;

/** Frames owned by adjacent projections are called out rather than falling through. */
export const RPC_OUT_OF_BAND_DISPOSITIONS = {
	session_entry: "separately-projected",
	subagent_lifecycle: "separately-projected",
	subagent_progress: "separately-projected",
	subagent_event: "translated",
} as const satisfies Record<RpcOutOfBandType, Exclude<AppserverRpcFrameDisposition, "intentionally-internal">>;

/** RPC metadata acknowledgements are intentionally omitted from durable session history. */
export const RPC_INTERNAL_FRAME_DISPOSITIONS = {
	available_commands_update: "intentionally-internal",
} as const satisfies Record<string, Extract<AppserverRpcFrameDisposition, "intentionally-internal">>;

/** Prompt results are conditional: local-only hints stay internal while late failures are visible. */
export const RPC_PROMPT_RESULT_DISPOSITIONS = {
	agentInvoked: "intentionally-internal",
	error: "translated",
} as const satisfies Record<"agentInvoked" | "error", AppserverRpcFrameDisposition>;

export interface TranscriptFrameContext {
	/** Whether this prompt result belongs to the prompt lifecycle currently owned by the session. */
	currentPromptResult?: boolean;
}

const TEXT_BLOCK = "text";
const THINKING_BLOCK = "thinking";
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const MAX_EVENT_TEXT_BYTES = 2_048;
const MAX_EVENT_LABEL_BYTES = 256;
const MAX_EVENT_ITEMS = 64;
const MAX_EVENT_COUNT = 1_000_000;
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function safeDisplay(value: unknown, limit = 512): string {
	return typeof value === "string" ? cleanText(value, limit, true) : "";
}
function safeOptionalDisplay(value: unknown, limit = MAX_EVENT_LABEL_BYTES): string | undefined {
	const output = safeDisplay(value, limit);
	return output.length > 0 ? output : undefined;
}
export function safeAttentionDisplay(value: unknown, limit: number, fallback: string): string {
	const withoutUrls = typeof value === "string" ? value.replace(/\bhttps?:\/\/[^\s]+/giu, "[url]") : value;
	const safe = safeDisplay(withoutUrls, limit);
	return safe || fallback;
}
function safeRpcUiId(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 256)
		return undefined;
	return [...value].some(character => {
		const code = character.codePointAt(0) ?? 0;
		return code <= 0x1f || code === 0x7f;
	}) ? undefined : value;
}
function safeInteger(value: unknown, fallback = 0, max = MAX_EVENT_COUNT): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}
function optionalSafeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : undefined;
}
function knownValue<const T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	return typeof value === "string" && values.includes(value as T) ? (value as T) : fallback;
}
function asFrame(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}
function assertNever(value: never): never {
	throw new Error(`unhandled agent session event: ${safeDisplay(asFrame(value).type, 128)}`);
}
function flattenParts(content: unknown): { text: string; reasoning: string } {
	if (typeof content === "string") return { text: content, reasoning: "" };
	if (!Array.isArray(content)) return { text: "", reasoning: "" };
	let text = "";
	let reasoning = "";
	for (const part of content) {
		if (typeof part === "string") text += part;
		else if (isRecord(part) && part.type === TEXT_BLOCK && typeof part.text === "string") text += part.text;
		else if (isRecord(part) && part.type === THINKING_BLOCK && typeof part.thinking === "string")
			reasoning += part.thinking;
		else if (isRecord(part) && part.type === "redactedThinking" && typeof part.data === "string")
			reasoning += part.data;
	}
	return { text, reasoning };
}
function stableTimestamp(value: unknown, fallback: () => string): string {
	if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MILLISECONDS)
		return new Date(value).toISOString();
	if (typeof value === "string") {
		const milliseconds = Date.parse(value);
		if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
	}
	return fallback();
}
function valueAt(value: unknown, fallback: () => string): string {
	if (isRecord(value)) return stableTimestamp(value.timestamp, () => stableTimestamp(value.at, fallback));
	return fallback();
}
function assistantSnapshot(message: unknown, fallback: () => string): MessageSnapshot | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	return { ...flattenParts(message.content), at: valueAt(message, fallback) };
}
function sourceId(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	for (const key of ["id", "responseId"]) {
		const id = asString(message[key]);
		if (id) return id;
	}
	return undefined;
}
function textFromUnknown(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!isRecord(value)) return undefined;
	if (typeof value.text === "string") return value.text;
	if (typeof value.note === "string") return value.note;
	if (typeof value.output === "string") return value.output;
	const text = flattenParts(value.content).text;
	return text || undefined;
}
function sameSnapshot(a: MessageSnapshot | undefined, b: MessageSnapshot): boolean {
	return a !== undefined && a.text === b.text && a.reasoning === b.reasoning && a.at === b.at;
}
function isAgentSessionEventType(value: string): value is AgentSessionEventType {
	return Object.hasOwn(AGENT_SESSION_EVENT_DISPOSITIONS, value);
}
function agentEndStatus(frame: Record<string, unknown>): "completed" | "failed" | "cancelled" {
	if (frame.status === "completed" || frame.status === "failed" || frame.status === "cancelled") return frame.status;
	if (!Array.isArray(frame.messages)) return "completed";
	for (let index = frame.messages.length - 1; index >= 0; index--) {
		const message = asFrame(frame.messages[index]);
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "cancelled";
		return "completed";
	}
	return "completed";
}
function agentEndMessageCount(frame: Record<string, unknown>): number {
	if (Number.isSafeInteger(frame.messageCount) && Number(frame.messageCount) >= 0)
		return Math.min(Number(frame.messageCount), MAX_EVENT_COUNT);
	return Array.isArray(frame.messages) ? Math.min(frame.messages.length, MAX_EVENT_COUNT) : 0;
}
function turnErrorEvent(
	frame: Record<string, unknown>,
	at: string,
): Extract<TranscriptEvent, { type: "turn.error" }> | undefined {
	const message = asFrame(frame.message);
	if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
	const output: Extract<TranscriptEvent, { type: "turn.error" }> = {
		type: "turn.error",
		message: safeAttentionDisplay(message.errorMessage, 1_024, "The turn stopped with an error."),
		at,
	};
	const errorStatus = optionalSafeInteger(message.errorStatus, 999);
	if (errorStatus !== undefined) output.errorStatus = errorStatus;
	const errorId = optionalSafeInteger(message.errorId);
	if (errorId !== undefined) output.errorId = errorId;
	return output;
}
function compactionStartEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	return {
		type: "compaction.start",
		reason: knownValue(frame.reason, ["threshold", "overflow", "idle", "incomplete"] as const, "threshold"),
		action: knownValue(frame.action, ["context-full", "handoff", "shake", "snapcompact"] as const, "context-full"),
		at,
	};
}
function compactionEndEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const result = asFrame(frame.result);
	const status =
		frame.skipped === true
			? "skipped"
			: frame.aborted === true
				? "aborted"
				: typeof frame.errorMessage === "string" || frame.result === undefined
					? "failed"
					: "completed";
	const output: Extract<RuntimeLifecycleEvent, { type: "compaction.end" }> = {
		type: "compaction.end",
		action: knownValue(frame.action, ["context-full", "handoff", "shake", "snapcompact"] as const, "context-full"),
		status,
		willRetry: frame.willRetry === true,
		at,
	};
	const summary = safeOptionalDisplay(result.shortSummary ?? result.summary, MAX_EVENT_TEXT_BYTES);
	if (summary !== undefined) output.summary = summary;
	const tokensBefore = optionalSafeInteger(result.tokensBefore);
	if (tokensBefore !== undefined) output.tokensBefore = tokensBefore;
	const firstKeptEntryId = safeOptionalDisplay(result.firstKeptEntryId, MAX_EVENT_LABEL_BYTES);
	if (firstKeptEntryId !== undefined) output.firstKeptEntryId = firstKeptEntryId;
	const error = safeOptionalDisplay(frame.errorMessage, 1_024);
	if (error !== undefined) output.error = error;
	return output;
}
function retryStartEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const output: Extract<RuntimeLifecycleEvent, { type: "turn.retry" }> = {
		type: "turn.retry",
		attempt: safeInteger(frame.attempt, 1),
		maxAttempts: safeInteger(frame.maxAttempts, 1),
		delayMs: safeInteger(frame.delayMs, 0, 86_400_000),
		reason: safeOptionalDisplay(frame.errorMessage, 1_024) ?? "Transient model failure",
		at,
	};
	const errorId = optionalSafeInteger(frame.errorId);
	if (errorId !== undefined) output.errorId = errorId;
	return output;
}
function retryEndEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const output: Extract<RuntimeLifecycleEvent, { type: "turn.retry.result" }> = {
		type: "turn.retry.result",
		success: frame.success === true,
		attempt: safeInteger(frame.attempt, 1),
		at,
	};
	const finalError = safeOptionalDisplay(frame.finalError, 1_024);
	if (finalError !== undefined) output.finalError = finalError;
	if (Array.isArray(frame.recoveredErrors))
		output.recoveredCount = Math.min(frame.recoveredErrors.length, MAX_EVENT_COUNT);
	return output;
}
function fallbackEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	return {
		type: "model.fallback",
		from: safeOptionalDisplay(frame.from, MAX_EVENT_LABEL_BYTES) ?? "unknown",
		to: safeOptionalDisplay(frame.to, MAX_EVENT_LABEL_BYTES) ?? "unknown",
		role: safeOptionalDisplay(frame.role, MAX_EVENT_LABEL_BYTES) ?? "default",
		at,
	};
}
function fallbackResultEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	return {
		type: "model.fallback.result",
		model: safeOptionalDisplay(frame.model, MAX_EVENT_LABEL_BYTES) ?? "unknown",
		role: safeOptionalDisplay(frame.role, MAX_EVENT_LABEL_BYTES) ?? "default",
		success: true,
		at,
	};
}
function ttsrEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const raw = Array.isArray(frame.rules) ? frame.rules : [];
	const rules = raw.slice(0, MAX_EVENT_ITEMS).flatMap(value => {
		const rule = asFrame(value);
		const name = safeOptionalDisplay(rule.name, MAX_EVENT_LABEL_BYTES);
		if (name === undefined) return [];
		const description = safeOptionalDisplay(rule.description, 512);
		return [{ name, ...(description === undefined ? {} : { description }) }];
	});
	return { type: "ttsr.triggered", rules, truncated: raw.length > MAX_EVENT_ITEMS, at };
}
function todoReminderEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const raw = Array.isArray(frame.todos) ? frame.todos : [];
	const todos = raw.slice(0, MAX_EVENT_ITEMS).flatMap(value => {
		const todo = asFrame(value);
		const content = safeOptionalDisplay(todo.content, 512);
		if (content === undefined) return [];
		return [
			{
				content,
				status: knownValue(todo.status, ["pending", "in_progress", "completed", "abandoned"] as const, "pending"),
			},
		];
	});
	return {
		type: "todo.reminder",
		todos,
		attempt: safeInteger(frame.attempt, 1),
		maxAttempts: safeInteger(frame.maxAttempts, 1),
		truncated: raw.length > MAX_EVENT_ITEMS,
		at,
	};
}
function ircEvent(frame: Record<string, unknown>, atFallback: string): RuntimeLifecycleEvent {
	const message = asFrame(frame.message);
	const detail = asFrame(message.details);
	const content = flattenParts(message.content).text;
	const output: Extract<RuntimeLifecycleEvent, { type: "irc.message" }> = {
		type: "irc.message",
		kind: safeOptionalDisplay(message.customType, 128) ?? "irc",
		text: safeOptionalDisplay(content, MAX_EVENT_TEXT_BYTES) ?? "",
		at: valueAt(message, () => atFallback),
	};
	const from = safeOptionalDisplay(detail.from, MAX_EVENT_LABEL_BYTES);
	if (from !== undefined) output.from = from;
	const to = safeOptionalDisplay(detail.to, MAX_EVENT_LABEL_BYTES);
	if (to !== undefined) output.to = to;
	const replyTo = safeOptionalDisplay(detail.replyTo, MAX_EVENT_LABEL_BYTES);
	if (replyTo !== undefined) output.replyTo = replyTo;
	return output;
}
function noticeEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const output: Extract<RuntimeLifecycleEvent, { type: "notice" }> = {
		type: "notice",
		level: knownValue(frame.level, ["info", "warning", "error"] as const, "info"),
		message: safeOptionalDisplay(frame.message, MAX_EVENT_TEXT_BYTES) ?? "Runtime notice",
		at,
	};
	const source = safeOptionalDisplay(frame.source, MAX_EVENT_LABEL_BYTES);
	if (source !== undefined) output.source = source;
	return output;
}
function thinkingEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const output: Extract<RuntimeLifecycleEvent, { type: "thinking.level.changed" }> = {
		type: "thinking.level.changed",
		thinkingLevel: safeOptionalDisplay(frame.thinkingLevel, 64) ?? null,
		at,
	};
	const configured = safeOptionalDisplay(frame.configured, 64);
	if (configured !== undefined) output.configured = configured;
	const resolved = safeOptionalDisplay(frame.resolved, 64);
	if (resolved !== undefined) output.resolved = resolved;
	return output;
}
function safeGoal(value: unknown): SafeGoal | null {
	if (value === null) return null;
	const goal = asFrame(value);
	const id = safeOptionalDisplay(goal.id, MAX_EVENT_LABEL_BYTES);
	const objective = safeOptionalDisplay(goal.objective, 1_024);
	if (id === undefined || objective === undefined) return null;
	const output: SafeGoal = {
		id,
		objective,
		status: knownValue(goal.status, ["active", "paused", "budget-limited", "complete", "dropped"] as const, "active"),
		tokensUsed: safeInteger(goal.tokensUsed),
		timeUsedSeconds: safeInteger(goal.timeUsedSeconds, 0, Number.MAX_SAFE_INTEGER),
		createdAt: safeInteger(goal.createdAt, 0, MAX_DATE_MILLISECONDS),
		updatedAt: safeInteger(goal.updatedAt, 0, MAX_DATE_MILLISECONDS),
	};
	const tokenBudget = optionalSafeInteger(goal.tokenBudget);
	if (tokenBudget !== undefined) output.tokenBudget = tokenBudget;
	return output;
}
function goalEvent(frame: Record<string, unknown>, at: string): RuntimeLifecycleEvent {
	const output: Extract<RuntimeLifecycleEvent, { type: "goal.updated" }> = {
		type: "goal.updated",
		goal: safeGoal(frame.goal),
		at,
	};
	const state = asFrame(frame.state);
	if (typeof state.enabled === "boolean" && (state.mode === "active" || state.mode === "exiting")) {
		output.mode = {
			enabled: state.enabled,
			mode: state.mode,
			...(state.reason === "completed" ? { reason: "completed" as const } : {}),
		};
	}
	return output;
}
function subagentDetail(event: Record<string, unknown>): Record<string, unknown> | undefined {
	switch (event.type) {
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end": {
			const detail: Record<string, unknown> = {};
			const tool = safeOptionalDisplay(event.toolName, 128);
			if (tool !== undefined) detail.tool = tool;
			const callId = safeOptionalDisplay(event.toolCallId, MAX_EVENT_LABEL_BYTES);
			if (callId !== undefined) detail.callId = callId;
			if (event.type === "tool_execution_end") detail.ok = event.isError !== true;
			return Object.keys(detail).length > 0 ? detail : undefined;
		}
		case "auto_retry_start":
			return { attempt: safeInteger(event.attempt, 1), maxAttempts: safeInteger(event.maxAttempts, 1) };
		case "auto_retry_end":
			return { attempt: safeInteger(event.attempt, 1), success: event.success === true };
		case "notice":
			return {
				level: knownValue(event.level, ["info", "warning", "error"] as const, "info"),
				message: safeOptionalDisplay(event.message, 512) ?? "Runtime notice",
			};
		case "goal_updated": {
			const goal = asFrame(event.goal);
			const status = safeOptionalDisplay(goal.status, 64);
			return status === undefined ? undefined : { status };
		}
		default:
			return undefined;
	}
}

export class TranscriptEventTranslator {
	#messageCounter = 0;
	#activeAssistant: ActiveAssistant | undefined;
	#assistantStreams = new Map<string, ActiveAssistant>();
	#projectedMessageIds = new Map<string, string | null>();
	#knownDurableEntryIds = new Set<string>();
	#pendingSettlements = new Map<string, { streamId: string; at: string }>();
	#settledStreams = new Set<string>();
	#toolStates = new Map<string, ToolState>();
	#pendingUi = new Map<string, UiState>();
	#turnAt: string | undefined;
	readonly #now: () => number;
	constructor(now: () => number = Date.now) {
		this.#now = now;
	}
	#nowIso(): string {
		return stableTimestamp(this.#now(), () => new Date(0).toISOString());
	}
	pendingUiRequests(): PendingUiRequest[] {
		return [...this.#pendingUi].map(
			([id, value]) => ({ id, kind: value.kind, attention: value.attention }) as PendingUiRequest,
		);
	}
	observeKnownEntries(entries: readonly DurableEntry[]): void {
		for (const entry of entries) this.#knownDurableEntryIds.add(entry.id);
	}
	pendingUiRequest(id: string): PendingUiRequest | undefined {
		const pending = this.#pendingUi.get(id);
		return pending ? ({ id, kind: pending.kind, attention: pending.attention } as PendingUiRequest) : undefined;
	}
	resolveUiRequest(id: string): AskResolvedEvent | ApprovalResolvedEvent | undefined {
		const pending = this.#pendingUi.get(id);
		if (!pending) return undefined;
		this.#pendingUi.delete(id);
		const at = this.#nowIso();
		return pending.kind === "ask"
			? { type: "ask.resolved", askId: id, at }
			: { type: "approval.resolved", approvalId: id, at };
	}
	translate(frame: Record<string, unknown>, context: TranscriptFrameContext = {}): AppserverEvent[] {
		const type = asString(frame.type);
		if (!type) return [];
		if (isAgentSessionEventType(type)) return this.#translateAgentSessionEvent(frame as unknown as AgentSessionEvent);
		if (type === "subagent_event") return this.#translateSubagentEvent(frame as unknown as RpcSubagentEventFrame);
		if (type === "extension_ui_request") return this.extensionUi(frame);
		if (type === "prompt_result") return this.#translatePromptResult(frame, context.currentPromptResult !== false);
		if (Object.hasOwn(RPC_OUT_OF_BAND_DISPOSITIONS, type)) return [];
		if (Object.hasOwn(RPC_INTERNAL_FRAME_DISPOSITIONS, type)) return [];
		return [];
	}
	#translatePromptResult(frame: Record<string, unknown>, current: boolean): AppserverEvent[] {
		if (typeof frame.error !== "string" || !current) return [];
		const at = this.#nowIso();
		const error: Extract<TranscriptEvent, { type: "turn.error" }> = {
			type: "turn.error",
			message: safeAttentionDisplay(frame.error, 1_024, "The prompt stopped with an error."),
			at,
		};
		if (this.#turnAt === undefined) return [error];
		this.#turnAt = undefined;
		this.#activeAssistant = this.#activeAssistant?.ended ? undefined : this.#activeAssistant;
		return [error, { type: "turn.end", at }];
	}
	#translateAgentSessionEvent(event: AgentSessionEvent): AppserverEvent[] {
		const frame = asFrame(event);
		switch (event.type) {
			case "agent_start":
				return [{ type: "agent.start", at: this.#nowIso() }];
			case "agent_end":
				return [
					{
						type: "agent.end",
						status: agentEndStatus(frame),
						messageCount: agentEndMessageCount(frame),
						at: this.#nowIso(),
					},
				];
			case "turn_start":
				this.#turnAt = this.#nowIso();
				this.#activeAssistant = undefined;
				return [{ type: "turn.start", at: this.#turnAt }];
			case "turn_end": {
				const at = this.#nowIso();
				this.#turnAt = undefined;
				this.#activeAssistant = this.#activeAssistant?.ended ? undefined : this.#activeAssistant;
				const error = turnErrorEvent(frame, at);
				return error ? [error, { type: "turn.end", at }] : [{ type: "turn.end", at }];
			}
			case "message_start":
				return this.messageStart(frame);
			case "message_update":
				return this.messageUpdate(frame);
			case "message_end":
				return this.messageEnd(frame);
			case "message_persisted":
				return this.messagePersisted(frame);
			case "tool_execution_start":
				return this.toolStart(frame);
			case "tool_execution_update":
				return this.toolProgress(frame);
			case "tool_execution_end":
				return this.toolResult(frame);
			case "auto_compaction_start":
				return [compactionStartEvent(frame, this.#nowIso())];
			case "auto_compaction_end":
				return [compactionEndEvent(frame, this.#nowIso())];
			case "auto_retry_start":
				return [retryStartEvent(frame, this.#nowIso())];
			case "auto_retry_end":
				return [retryEndEvent(frame, this.#nowIso())];
			case "retry_fallback_applied":
				return [fallbackEvent(frame, this.#nowIso())];
			case "retry_fallback_succeeded":
				return [fallbackResultEvent(frame, this.#nowIso())];
			case "ttsr_triggered":
				return [ttsrEvent(frame, this.#nowIso())];
			case "todo_reminder":
				return [todoReminderEvent(frame, this.#nowIso())];
			case "todo_auto_clear":
				return [{ type: "todo.cleared", source: "automatic", at: this.#nowIso() }];
			case "irc_message":
				return [ircEvent(frame, this.#nowIso())];
			case "notice":
				return [noticeEvent(frame, this.#nowIso())];
			case "thinking_level_changed":
				return [thinkingEvent(frame, this.#nowIso())];
			case "goal_updated":
				return [goalEvent(frame, this.#nowIso())];
			default:
				return assertNever(event);
		}
	}
	#translateSubagentEvent(frame: RpcSubagentEventFrame): AppserverEvent[] {
		const payload = asFrame(frame.payload);
		const agentId = safeOptionalDisplay(payload.id, 128);
		const event = asFrame(payload.event);
		const rawType = safeOptionalDisplay(event.type, 128);
		if (agentId === undefined || rawType === undefined) return [];
		const canonical = isAgentSessionEventType(rawType)
			? AGENT_SESSION_EVENT_DISPOSITIONS[rawType].canonical
			: "unknown";
		const detail = subagentDetail(event);
		const output: Extract<RuntimeLifecycleEvent, { type: "agent.event" }> = {
			type: "agent.event",
			agentId,
			event: canonical,
			at: valueAt(event, this.#nowIso.bind(this)),
		};
		if (canonical === "unknown") output.detail = { rawType };
		else if (detail !== undefined) output.detail = detail;
		return [output];
	}
	private extensionUi(frame: Record<string, unknown>): AppserverEvent[] {
		const id = safeRpcUiId(frame.id);
		const method = asString(frame.method);
		if (!id || !method) return [];
		if (method === "cancel") {
			const target = asString(frame.targetId);
			const pending = target ? this.#pendingUi.get(target) : undefined;
			if (!target || !pending) return [];
			this.#pendingUi.delete(target);
			return pending.kind === "ask"
				? [{ type: "ask.resolved", askId: target, at: pending.at }]
				: [{ type: "approval.resolved", approvalId: target, at: pending.at }];
		}
		const at = this.#nowIso();
		if (method === "select") {
			const raw = Array.isArray(frame.options) ? frame.options : [];
			const options = raw.flatMap((option, index) => {
				if (typeof option !== "string") return [];
				const label = safeDisplay(option, 256);
				if (!label) return [];
				const optionId = safeRpcUiId(option) ?? `option-${index}`;
				return [{ id: optionId, label }];
			});
			const event: AskRequestEvent = {
				type: "ask.request",
				askId: id,
				question: safeDisplay(frame.title) || "Agent needs an answer.",
				options,
				allowText: false,
				responseKind: "value",
				source: "rpc-ui",
				at,
			};
			this.#pendingUi.set(id, {
				kind: "ask",
				at,
				attention: {
					kind: "question",
					id,
					question: safeAttentionDisplay(frame.title, 2_048, "Agent needs an answer."),
					options: options.slice(0, ATTENTION_MAX_QUESTION_OPTIONS).map(option => ({
						id: option.id,
						label: safeAttentionDisplay(option.label, 256, "Option"),
					})),
					allowText: false,
					requestedAt: at,
				},
			});
			return [event];
		}
		if (method === "input" || method === "editor") {
			const event: AskRequestEvent = {
				type: "ask.request",
				askId: id,
				question: safeDisplay(frame.title) || "Agent needs an answer.",
				allowText: true,
				responseKind: "value",
				source: "rpc-ui",
				at,
			};
			this.#pendingUi.set(id, {
				kind: "ask",
				at,
				attention: {
					kind: "question",
					id,
					question: safeAttentionDisplay(frame.title, 2_048, "Agent needs an answer."),
					options: [],
					allowText: true,
					requestedAt: at,
				},
			});
			return [event];
		}
		if (method === "confirm") {
			const event: ApprovalRequestEvent = {
				type: "approval.request",
				approvalId: id,
				title: safeDisplay(frame.title) || "Approval requested",
				message: safeDisplay(frame.message),
				responseKind: "confirmed",
				source: "rpc-ui",
				at,
			};
			this.#pendingUi.set(id, {
				kind: "approval",
				at,
				attention: {
					kind: "approval",
					id,
					title: safeAttentionDisplay(frame.title, 256, "Approval requested"),
					summary: safeAttentionDisplay(frame.message, 2_048, event.title),
					requestedAt: at,
				},
			});
			return [event];
		}
		return [];
	}
	observeSessionEntry(entry: Record<string, unknown>, projected: readonly DurableEntry[]): TranscriptEvent[] {
		for (const value of projected) this.#knownDurableEntryIds.add(value.id);
		const rawEntryId = asString(entry.id);
		const message = asFrame(entry.message);
		if (!rawEntryId || entry.type !== "message" || message.role !== "assistant") return [];
		const durable = projected.find(value => value.kind === "message" && asFrame(value.data).role === "assistant");
		this.#projectedMessageIds.set(rawEntryId, durable?.id ?? null);
		const pending = this.#pendingSettlements.get(rawEntryId);
		if (!pending || !durable) return [];
		this.#pendingSettlements.delete(rawEntryId);
		return this.settleMessage(pending.streamId, durable.id, pending.at);
	}
	private correlatedAssistant(
		frame: Record<string, unknown>,
	): { active: ActiveAssistant; streamId?: string } | undefined {
		const message = frame.message;
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return undefined;
		const streamId = asString(frame.streamId);
		if (streamId) {
			if (this.#settledStreams.has(streamId)) return undefined;
			let active = this.#assistantStreams.get(streamId);
			if (!active) {
				active = { entryId: `assistant:${streamId}`, last: undefined, ended: false };
				this.#assistantStreams.set(streamId, active);
			}
			this.#activeAssistant = active;
			return { active, streamId };
		}
		let active = this.#activeAssistant;
		const entryId = sourceId(message)
			? `assistant:${sourceId(message)}`
			: active && !active.ended
				? active.entryId
				: `assistant:${++this.#messageCounter}`;
		if (!active || active.entryId !== entryId || active.ended) {
			active = { entryId, last: undefined, ended: false };
			this.#activeAssistant = active;
		}
		return { active };
	}
	private messageStart(frame: Record<string, unknown>): TranscriptEvent[] {
		const message = frame.message;
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return [];
		const correlated = this.correlatedAssistant(frame);
		if (!correlated || correlated.active.ended) return [];
		const { active } = correlated;
		if (!snapshot.text && !snapshot.reasoning) {
			active.last ??= snapshot;
			return [];
		}
		return this.emitMessage(snapshot);
	}
	private messageUpdate(frame: Record<string, unknown>): TranscriptEvent[] {
		const message = frame.message;
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return [];
		const correlated = this.correlatedAssistant(frame);
		if (!correlated || correlated.active.ended) return [];
		return this.emitMessage(snapshot);
	}
	private messageEnd(frame: Record<string, unknown>): TranscriptEvent[] {
		const message = frame.message;
		const snapshot = assistantSnapshot(message, () => this.#activeAssistant?.last?.at ?? this.#nowIso());
		if (!snapshot) return [];
		const correlated = this.correlatedAssistant(frame);
		if (!correlated || correlated.active.ended) return [];
		const output = this.emitMessage(snapshot);
		correlated.active.ended = true;
		return output;
	}
	private messagePersisted(frame: Record<string, unknown>): TranscriptEvent[] {
		const streamId = asString(frame.streamId);
		if (!streamId || this.#settledStreams.has(streamId)) return [];
		const active = this.#assistantStreams.get(streamId);
		const at = active?.last?.at ?? this.#nowIso();
		const rawEntryId = asString(frame.entryId);
		if (!rawEntryId) {
			this.#settledStreams.add(streamId);
			this.#assistantStreams.delete(streamId);
			if (this.#activeAssistant === active) this.#activeAssistant = undefined;
			return [];
		}
		const projectedEntryId = this.#projectedMessageIds.get(rawEntryId);
		if (projectedEntryId === null) {
			this.#settledStreams.add(streamId);
			this.#assistantStreams.delete(streamId);
			if (this.#activeAssistant === active) this.#activeAssistant = undefined;
			return [];
		}
		if (projectedEntryId) return this.settleMessage(streamId, projectedEntryId, at);
		if (this.#knownDurableEntryIds.has(rawEntryId)) return this.settleMessage(streamId, rawEntryId, at);
		this.#pendingSettlements.set(rawEntryId, { streamId, at });
		return [];
	}
	private settleMessage(streamId: string, durableEntryId: string, at: string): TranscriptEvent[] {
		if (this.#settledStreams.has(streamId)) return [];
		this.#settledStreams.add(streamId);
		const active = this.#assistantStreams.get(streamId);
		this.#assistantStreams.delete(streamId);
		if (this.#activeAssistant === active) this.#activeAssistant = undefined;
		const transientEntryId = active?.entryId ?? `assistant:${streamId}`;
		if (durableEntryId === transientEntryId) return [];
		return [{ type: "message.settled", transientEntryId, entryId: durableEntryId, at }];
	}
	private emitMessage(snapshot: MessageSnapshot): TranscriptEvent[] {
		const active = this.#activeAssistant;
		if (!active || sameSnapshot(active.last, snapshot)) return [];
		active.last = snapshot;
		return [
			{
				type: "message.update",
				entryId: active.entryId,
				role: "assistant",
				text: snapshot.text,
				reasoning: snapshot.reasoning,
				at: snapshot.at,
			},
		];
	}
	private toolStart(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		if (!callId || this.#toolStates.has(callId)) return [];
		const at = valueAt(frame, this.#nowIso.bind(this));
		const outerTool = asString(frame.toolName) ?? "tool";
		const xdev = xdevWriteCall(outerTool, frame.args);
		const tool = xdev?.tool ?? outerTool;
		this.#toolStates.set(callId, { state: "open", at, ...(xdev ? { xdevCall: xdev } : {}) });
		return [
			{
				type: "tool.start",
				callId,
				tool,
				title: tool,
				args: xdev ? projectToolArguments(xdev.args) : frame.args,
				at,
			},
		];
	}
	private toolProgress(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		const state = callId ? this.#toolStates.get(callId) : undefined;
		if (!callId || !state || state.state !== "open") return [];
		const partial = frame.partialResult;
		const event: TranscriptToolProgressEvent = {
			type: "tool.progress",
			callId,
			at: valueAt(partial, () => state.at),
		};
		const text = textFromUnknown(partial);
		if (typeof partial === "string") event.chunk = partial;
		else if (text !== undefined) event.note = text;
		const progress = isRecord(partial) ? asFiniteNumber(partial.progress) : asFiniteNumber(partial);
		if (progress !== undefined) event.progress = progress;
		return [event];
	}
	private toolResult(frame: Record<string, unknown>): TranscriptEvent[] {
		const callId = asString(frame.toolCallId);
		const state = callId ? this.#toolStates.get(callId) : undefined;
		if (!callId || !state || state.state === "closed") return [];
		state.state = "closed";
		const rawResult = frame.result;
		const resultRecord = isRecord(rawResult) ? rawResult : undefined;
		const xdev = xdevResultEnvelope(resultRecord?.details);
		let result = rawResult;
		if (resultRecord && xdev && xdevExecutionMatches(state.xdevCall, xdev)) {
			const { details: _details, ...rest } = resultRecord;
			const inner = projectToolResultDetails(xdev.inner);
			result = inner === undefined ? rest : { ...rest, details: inner };
		}
		return [
			{
				type: "tool.result",
				callId,
				ok: frame.isError !== true,
				result,
				at: valueAt(frame, () => state.at),
			},
		];
	}
}
export function asAppWireEvent(event: AppserverEvent): SessionEvent {
	return event;
}
