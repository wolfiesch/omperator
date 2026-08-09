//  collab/frames.ts
//  Guest-side collab wire frames (COLLAB_PROTO = 3). Mirror of the published
//  @oh-my-pi/pi-wire contract; guests must tolerate unknown frame/event types.

export const COLLAB_PROTO = 3;

export interface CollabContentBlockText {
	type: "text";
	text: string;
}
export interface CollabContentBlockThinking {
	type: "thinking";
	thinking: string;
}
export interface CollabContentBlockToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: unknown;
	intent?: string;
}
export type CollabContentBlock =
	| CollabContentBlockText
	| CollabContentBlockThinking
	| CollabContentBlockToolCall
	| { type: string; [k: string]: unknown };

export type CollabMessage =
	| { role: "user"; content: string | CollabContentBlock[]; synthetic?: boolean; timestamp?: number }
	| { role: "developer"; content: string | CollabContentBlock[]; timestamp?: number }
	| {
			role: "assistant";
			content: CollabContentBlock[];
			model?: string;
			usage?: Record<string, unknown>;
			stopReason?: string;
			errorMessage?: string;
			timestamp?: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: unknown;
			details?: unknown;
			isError?: boolean;
			timestamp?: number;
	  };

export interface CollabEntry {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	[key: string]: unknown;
}
export interface CollabSessionEntry extends CollabEntry {
	type: "session";
	message?: { type: "session"; id: string; title?: string; cwd: string; timestamp?: string };
}
export interface CollabMessageEntry extends CollabEntry {
	type: "message";
	message?: CollabMessage;
}
export interface CollabCustomMessageEntry extends CollabEntry {
	type: "custom_message";
	customType?: string;
	content?: unknown;
	display?: boolean;
	details?: unknown;
}
export interface CollabCompactionEntry extends CollabEntry {
	type: "compaction";
	summary?: string;
	shortSummary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
}
export interface CollabBranchSummaryEntry extends CollabEntry {
	type: "branch_summary";
	fromId?: string;
	summary?: string;
}
export type CollabWireEntry =
	| CollabSessionEntry
	| CollabMessageEntry
	| CollabCustomMessageEntry
	| CollabCompactionEntry
	| CollabBranchSummaryEntry
	| (CollabEntry & { type: string });

export type CollabEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message?: CollabMessage }
	| { type: "message_update"; message?: CollabMessage }
	| { type: "message_end"; message?: CollabMessage }
	| {
			type: "tool_execution_start";
			toolCallId?: string;
			toolName?: string;
			args?: unknown;
			intent?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId?: string;
			toolName?: string;
			args?: unknown;
			partialResult?: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId?: string;
			toolName?: string;
			result?: unknown;
			isError?: boolean;
	  }
	| { type: "notice"; level?: "info" | "warning" | "error"; message?: string; source?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string }
	| { type: string; [k: string]: unknown };

export interface CollabSessionState {
	isStreaming?: boolean;
	queuedMessageCount?: number;
	sessionName?: string;
	cwd?: string;
	model?: { id?: string; name?: string; provider?: string; contextWindow?: number };
	thinkingLevel?: string;
	contextUsage?: { tokens?: number; contextWindow?: number; percent?: number };
	participants?: { name: string; role: "host" | "guest"; readOnly?: boolean }[];
	isAborting?: boolean;
}

export interface CollabAgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: string;
	hasSessionFile?: boolean;
	createdAt?: number;
	lastActivity?: number;
}

export interface CollabUiRequest {
	reqId: number;
	kind: "select" | "editor" | "plan";
	title: string;
	options?: (string | { label: string; description?: string })[];
	initialIndex?: number;
	selectionMarker?: "radio" | "checkbox";
	checkedIndices?: number[];
	markableCount?: number;
	helpText?: string;
	prefill?: string;
}

// Host → guest frames
export type CollabHostFrame =
	| { t: "welcome"; proto: number; header: CollabSessionEntry; state: CollabSessionState; agents: CollabAgentSnapshot[]; entryCount: number; readOnly?: true }
	| { t: "snapshot-chunk"; entries: CollabWireEntry[]; final: boolean }
	| { t: "entry"; entry: CollabWireEntry }
	| { t: "event"; event: CollabEvent }
	| { t: "state"; state: CollabSessionState }
	| { t: "bus"; channel: string; data: unknown }
	| { t: "agents"; agents: CollabAgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string }
	// /enclave extension frames (the Enclave plugin's superset on the same
	// sealed channel). Guests must tolerate their absence.
	| { t: "enclave-caps"; version: number; vision?: boolean; models?: { id: string; name?: string; vision?: boolean }[]; commands?: { name: string; description?: string }[]; current?: { model?: string; thinking?: string } }
	| { t: "enclave-result"; ok: boolean; message?: string; data?: string; mimeType?: string; reqId?: number };

// Guest → host frames
export type CollabGuestFrame =
	| { t: "hello"; proto: number; name: string; writeToken?: string }
	| { t: "prompt"; text: string; images?: { type: "image"; mimeType: string; data: string }[] }
	| { t: "ui-response"; reqId: number; value?: string }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number }
	// /enclave extension: route a control command to the host plugin.
	| { t: "enclave-cmd"; method: string; params?: unknown; reqId: number };

export function isCollabHostFrame(value: unknown): value is CollabHostFrame {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Record<string, unknown>).t === "string" &&
		(value as Record<string, unknown>).t !== "hello"
	);
}
