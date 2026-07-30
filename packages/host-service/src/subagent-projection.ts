import { type AgentFrame, type AgentState, agentId, type HostId, type SessionId } from "@t4-code/host-wire";
import type {
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
} from "./omp-rpc-contract.ts";
import { cleanText } from "./discovery.ts";

const MAX_LABEL_BYTES = 256;
const MAX_MODEL_BYTES = 128;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const TERMINAL_STATUS: Readonly<Record<string, true>> = {
	completed: true,
	failed: true,
	cancelled: true,
};
const RESUMABLE_STATUS: Readonly<Record<string, true>> = {
	idle: true,
	parked: true,
	resumable: true,
};

interface ProjectedAgentState {
	id: string;
	index: number;
	agent: string;
	task?: string;
	description?: string;
	status: string;
	startedAt: number;
	lastActivityAt: number;
	model?: string;
	resumable: boolean;
	progress?: string;
	evidence?: string;
	currentTool?: string;
	contextUsed?: number;
	contextLimit?: number;
	tokenVolume?: number;
	toolCount?: number;
	durationMs?: number;
}

interface ProjectionInput {
	id: string;
	index: number;
	agent: unknown;
	task?: unknown;
	description?: unknown;
	status: unknown;
	lastUpdate?: unknown;
	startedAt?: unknown;
	model?: unknown;
	resumable?: unknown;
	progress?: unknown;
	evidence?: unknown;
	currentTool?: unknown;
	contextUsed?: unknown;
	contextLimit?: unknown;
	tokenVolume?: unknown;
	toolCount?: unknown;
	durationMs?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown, maxBytes = MAX_LABEL_BYTES): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const safe = cleanText(value, maxBytes, true);
	return safe.length > 0 ? safe : undefined;
}

function modelText(value: unknown): string | undefined {
	const safe = text(value, MAX_MODEL_BYTES);
	if (!safe || safe.includes("[path]") || safe.includes("[redacted]")) return undefined;
	return safe;
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown, fallback: number): number {
	const candidate = finiteNonNegative(value);
	return candidate !== undefined && candidate <= MAX_DATE_MILLISECONDS ? candidate : fallback;
}

function status(value: unknown): string | undefined {
	const safe = text(value, 64);
	if (!safe) return undefined;
	if (safe === "aborted") return "cancelled";
	if (safe === "pending") return "started";
	return safe;
}

function hasStatus(table: Readonly<Record<string, true>>, value: string): boolean {
	return Object.hasOwn(table, value);
}

function statusRank(value: string): number {
	if (hasStatus(TERMINAL_STATUS, value) || hasStatus(RESUMABLE_STATUS, value)) return 3;
	if (value === "running") return 2;
	return 1;
}

function isRegressive(current: string, next: string): boolean {
	if (hasStatus(TERMINAL_STATUS, current) && hasStatus(RESUMABLE_STATUS, next)) return false;
	if (hasStatus(TERMINAL_STATUS, current) && !hasStatus(TERMINAL_STATUS, next)) return true;
	return current === "running" && statusRank(next) < statusRank(current);
}

function compareCodeUnits(left: string, right: string): number {
	const length = Math.min(left.length, right.length);
	for (let index = 0; index < length; index++) {
		const difference = left.charCodeAt(index) - right.charCodeAt(index);
		if (difference !== 0) return difference;
	}
	return left.length - right.length;
}

function sameState(left: ProjectedAgentState, right: ProjectedAgentState): boolean {
	return (
		left.id === right.id &&
		left.index === right.index &&
		left.agent === right.agent &&
		left.task === right.task &&
		left.description === right.description &&
		left.status === right.status &&
		left.startedAt === right.startedAt &&
		left.lastActivityAt === right.lastActivityAt &&
		left.model === right.model &&
		left.resumable === right.resumable &&
		left.progress === right.progress &&
		left.evidence === right.evidence &&
		left.currentTool === right.currentTool &&
		left.contextUsed === right.contextUsed &&
		left.contextLimit === right.contextLimit &&
		left.tokenVolume === right.tokenVolume &&
		left.toolCount === right.toolCount &&
		left.durationMs === right.durationMs
	);
}

function asAgentState(value: string): AgentState {
	return value as AgentState;
}

/** Agent identity carried by an RPC lifecycle/progress frame, when valid. */
export function subagentIdFromFrame(frame: Record<string, unknown>): string | undefined {
	const payload = record(frame.payload);
	if (!payload) return undefined;
	if (frame.type === "subagent_lifecycle") return text(payload.id, 128);
	if (frame.type !== "subagent_progress") return undefined;
	return text(record(payload.progress)?.id, 128);
}

export class SubagentProjection {
	#states = new Map<string, ProjectedAgentState>();

	constructor(
		private readonly hostId: HostId,
		private readonly sessionId: SessionId,
		private readonly now: () => number = Date.now,
	) {}

	applySnapshot(snapshot: RpcSubagentSnapshot): AgentFrame | undefined {
		const progress = record(snapshot.progress);
		return this.apply({
			id: snapshot.id,
			index: snapshot.index,
			agent: snapshot.agent,
			task: snapshot.task,
			description: snapshot.description,
			status: snapshot.status,
			lastUpdate: snapshot.lastUpdate,
			model: progress?.resolvedModel,
			resumable: snapshot.resumable,
			progress: progress?.lastIntent,
			evidence: Array.isArray(progress?.recentOutput) ? progress.recentOutput.at(-1) : undefined,
			currentTool: progress?.currentTool,
			contextUsed: progress?.contextTokens,
			contextLimit: progress?.contextWindow,
			tokenVolume: progress?.tokens,
			toolCount: progress?.toolCount,
			durationMs: progress?.durationMs,
		});
	}

	applyLifecycle(frame: RpcSubagentLifecycleFrame): AgentFrame | undefined {
		const payload = record(frame.payload);
		if (!payload) return undefined;
		const id = text(payload.id, 128);
		const agent = text(payload.agent, 128);
		const nextStatus = status(payload.status);
		if (!id || !agent || !nextStatus) return undefined;
		const existing = this.#states.get(id);
		return this.apply({
			id,
			index: finiteNonNegative(payload.index) ?? existing?.index ?? 0,
			agent,
			description: payload.description ?? existing?.description,
			status: nextStatus,
			task: payload.task ?? existing?.task,
			lastUpdate: payload.lastUpdate ?? this.now(),
			startedAt: existing?.startedAt,
			model: existing?.model,
			resumable: payload.resumable ?? existing?.resumable,
			progress: existing?.progress,
			evidence: existing?.evidence,
			currentTool: existing?.currentTool,
			contextUsed: existing?.contextUsed,
			contextLimit: existing?.contextLimit,
			tokenVolume: existing?.tokenVolume,
			toolCount: existing?.toolCount,
			durationMs: existing?.durationMs,
		});
	}

	applyProgress(frame: RpcSubagentProgressFrame): AgentFrame | undefined {
		const payload = record(frame.payload);
		const progress = payload ? record(payload.progress) : undefined;
		if (!payload || !progress) return undefined;
		const id = text(progress.id, 128);
		const agent = text(payload.agent, 128) ?? text(progress.agent, 128);
		const nextStatus = status(progress.status);
		if (!id || !agent || !nextStatus) return undefined;
		const existing = this.#states.get(id);
		return this.apply({
			id,
			index: finiteNonNegative(payload.index) ?? existing?.index ?? 0,
			agent,
			task: payload.task,
			description: progress.description,
			status: nextStatus,
			lastUpdate: this.now(),
			startedAt: existing?.startedAt,
			model: progress.resolvedModel,
			resumable: payload.resumable ?? existing?.resumable,
			progress: progress.lastIntent,
			evidence: Array.isArray(progress.recentOutput) ? progress.recentOutput.at(-1) : undefined,
			currentTool: progress.currentTool,
			contextUsed: progress.contextTokens,
			contextLimit: progress.contextWindow,
			tokenVolume: progress.tokens,
			toolCount: progress.toolCount,
			durationMs: progress.durationMs,
		});
	}

	applyFrame(frame: Record<string, unknown>): AgentFrame | undefined {
		if (frame.type === "subagent_lifecycle")
			return this.applyLifecycle(frame as unknown as RpcSubagentLifecycleFrame);
		if (frame.type === "subagent_progress") return this.applyProgress(frame as unknown as RpcSubagentProgressFrame);
		return undefined;
	}

	frames(): AgentFrame[] {
		return [...this.#states.values()]
			.sort((left, right) => left.index - right.index || compareCodeUnits(left.id, right.id))
			.map(state => this.toFrame(state));
	}
	activeCount(): number {
		let count = 0;
		for (const state of this.#states.values())
			if (!hasStatus(TERMINAL_STATUS, state.status) && !hasStatus(RESUMABLE_STATUS, state.status)) count += 1;
		return count;
	}


	private apply(input: ProjectionInput): AgentFrame | undefined {
		const nextStatus = status(input.status);
		const agent = text(input.agent, 128);
		if (!nextStatus || !agent) return undefined;
		const current = this.#states.get(input.id);
		if (current && isRegressive(current.status, nextStatus)) return undefined;
		const now = timestamp(this.now(), 0);
		const contextUsed = finiteNonNegative(input.contextUsed);
		const contextLimit = finiteNonNegative(input.contextLimit);
		const next: ProjectedAgentState = {
			id: input.id,
			index: Math.trunc(finiteNonNegative(input.index) ?? current?.index ?? 0),
			agent,
			task: text(input.task),
			description: text(input.description),
			status: nextStatus,
			startedAt: timestamp(input.startedAt, current?.startedAt ?? timestamp(input.lastUpdate, now)),
			lastActivityAt: timestamp(input.lastUpdate, now),
			model: modelText(input.model),
			resumable:
				nextStatus !== "cancelled" &&
				(input.resumable === true || hasStatus(RESUMABLE_STATUS, nextStatus) || current?.resumable === true),
			progress: text(input.progress),
			evidence: text(input.evidence),
			currentTool: text(input.currentTool, 128),
			contextUsed:
				contextUsed !== undefined && contextLimit !== undefined && contextUsed <= contextLimit
					? contextUsed
					: undefined,
			contextLimit:
				contextUsed !== undefined && contextLimit !== undefined && contextUsed <= contextLimit
					? contextLimit
					: undefined,
			tokenVolume: finiteNonNegative(input.tokenVolume),
			toolCount: finiteNonNegative(input.toolCount),
			durationMs: finiteNonNegative(input.durationMs),
		};
		if (current && sameState(current, next)) return undefined;
		this.#states.set(input.id, next);
		return this.toFrame(next);
	}

	private toFrame(state: ProjectedAgentState): AgentFrame {
		const title = state.task ?? state.description ?? state.agent;
		const detail: Record<string, unknown> = {
			title: text(title) ?? state.agent,
			name: state.agent,
			agent: state.agent,
			index: state.index,
			startedAt: new Date(state.startedAt).toISOString(),
			lastActivityAt: new Date(state.lastActivityAt).toISOString(),
			resumable: state.resumable,
		};
		if (state.description) detail.description = state.description;
		if (state.model) detail.model = state.model;
		if (state.progress) detail.progress = state.progress;
		if (state.evidence) detail.evidence = state.evidence;
		if (state.currentTool) detail.currentTool = state.currentTool;
		if (state.contextUsed !== undefined && state.contextLimit !== undefined)
			detail.contextUsage = { used: state.contextUsed, limit: state.contextLimit };
		if (state.tokenVolume !== undefined) detail.tokenVolume = state.tokenVolume;
		if (state.toolCount !== undefined) detail.toolCount = state.toolCount;
		if (state.durationMs !== undefined) detail.durationMs = state.durationMs;
		return {
			v: "omp-app/1",
			type: "agent",
			hostId: this.hostId,
			sessionId: this.sessionId,
			agentId: agentId(state.id),
			state: asAgentState(state.status),
			detail,
		};
	}
}
