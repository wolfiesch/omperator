import type { Cursor } from "./cursor.js";
import { type DurableEntry, decodeEntry } from "./entry.js";
import { fail } from "./errors.js";
import { boundedArray, boundedMetadata, controlFree, finiteNumber, isSecretLikeKey } from "./guards.js";
import { type AgentId, agentId, type HostId, type Revision, revision, type SessionId } from "./ids.js";
import { PROTOCOL_VERSION } from "./limits.js";
import { cur, frame, known, object, own } from "./additive-codec.js";

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
