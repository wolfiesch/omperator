import { createHash } from "node:crypto";
import type {
	CommandFrame,
	ServerFrame,
	SessionId,
} from "@t4-code/host-wire";
import { projectMessageText } from "./discovery.ts";
import type { SessionProjection } from "./projection.ts";
import { asAppWireEvent } from "./transcript-events.ts";

const PENDING_PROMPT_TEXT_BYTES = 8 * 1024;
const PENDING_PROMPT_EVENT_TEXT_BYTES = 24 * 1024;
export const MAX_PENDING_PROMPTS = 16;

export interface PromptLifecycle {
	requestId: string;
	commandId: string;
	commandHash: string;
	kind: "prompt" | "steer" | "followUp";
	accepted?: true;
	cancelRequested?: true;
	internalId?: string;
	transientEntryId?: string;
	registeredAt: number;
}

export type PromptDiscardReason =
	| "rejected"
	| "local-only"
	| "failed"
	| "cancelled"
	| "completed-without-entry";

interface PromptLifecycleControllerOptions {
	readonly now: () => Date;
	readonly projection: (sessionId: SessionId) => SessionProjection | undefined;
	readonly broadcast: (sessionId: SessionId, frame: ServerFrame) => void;
	readonly advanceStateRefreshGeneration: (sessionId: SessionId) => void;
	readonly idleGraceMs: () => number;
}

export class PromptLifecycleController {
	readonly #options: PromptLifecycleControllerOptions;
	readonly #activePrompts = new Map<SessionId, PromptLifecycle>();
	readonly #messages = new Map<SessionId, PromptLifecycle[]>();
	readonly #messagesByCommandId = new Map<string, PromptLifecycle>();

	constructor(options: PromptLifecycleControllerOptions) {
		this.#options = options;
	}

	clear(): void {
		this.#activePrompts.clear();
		this.#messages.clear();
		this.#messagesByCommandId.clear();
	}

	activeCount(): number {
		let count = 0;
		for (const lifecycles of this.#messages.values()) count += lifecycles.length;
		return count;
	}

	activePrompt(sessionId: SessionId): PromptLifecycle | undefined {
		return this.#activePrompts.get(sessionId);
	}

	setActivePrompt(sessionId: SessionId, lifecycle: PromptLifecycle): void {
		this.#activePrompts.set(sessionId, lifecycle);
	}

	lifecycleForCommand(commandId: string): PromptLifecycle | undefined {
		return this.#messagesByCommandId.get(commandId);
	}

	pendingCount(sessionId: SessionId): number {
		return this.#messages.get(sessionId)?.length ?? 0;
	}

	has(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		return this.#messages.get(sessionId)?.includes(lifecycle) === true;
	}

	register(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messages.get(sessionId) ?? [];
		if (
			current.length >= MAX_PENDING_PROMPTS ||
			this.#messagesByCommandId.has(lifecycle.commandId)
		)
			return false;
		this.#messages.set(sessionId, [...current, lifecycle]);
		this.#messagesByCommandId.set(lifecycle.commandId, lifecycle);
		this.#options.advanceStateRefreshGeneration(sessionId);
		return true;
	}

	find(sessionId: SessionId, internalId: string | undefined): PromptLifecycle | undefined {
		if (internalId === undefined) return undefined;
		return this.#messages
			.get(sessionId)
			?.find(lifecycle => lifecycle.internalId === internalId);
	}

	remove(sessionId: SessionId, lifecycle: PromptLifecycle): boolean {
		const current = this.#messages.get(sessionId);
		if (!current?.includes(lifecycle)) return false;
		const next = current.filter(candidate => candidate !== lifecycle);
		if (next.length > 0) this.#messages.set(sessionId, next);
		else this.#messages.delete(sessionId);
		if (this.#messagesByCommandId.get(lifecycle.commandId) === lifecycle)
			this.#messagesByCommandId.delete(lifecycle.commandId);
		if (this.#activePrompts.get(sessionId) === lifecycle)
			this.#activePrompts.delete(sessionId);
		this.#options.advanceStateRefreshGeneration(sessionId);
		return true;
	}

	emitTransient(
		sessionId: SessionId,
		command: CommandFrame,
		lifecycle: PromptLifecycle,
		message: string,
		attachmentCount: number,
	): void {
		if (!this.has(sessionId, lifecycle) || lifecycle.transientEntryId) return;
		const transientEntryId = `user:${createHash("sha256")
			.update(command.commandId)
			.digest("hex")
			.slice(0, 32)}`;
		lifecycle.transientEntryId = transientEntryId;
		const projection = this.#options.projection(sessionId);
		if (!projection) return;
		const at = this.#options.now().toISOString();
		const pending = projection.addPendingPrompt({
			entryId: transientEntryId,
			text: projectMessageText(message, PENDING_PROMPT_TEXT_BYTES),
			attachmentCount,
			at,
		});
		if (pending) this.#options.broadcast(sessionId, pending);
		this.#options.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.update",
					entryId: transientEntryId,
					role: "user",
					text: projectMessageText(message, PENDING_PROMPT_EVENT_TEXT_BYTES),
					reasoning: "",
					attachmentCount,
					at,
				}),
			),
		);
	}

	settleTransient(
		sessionId: SessionId,
		lifecycle: PromptLifecycle | undefined,
		entryId: string,
	): void {
		const transientEntryId = lifecycle?.transientEntryId;
		if (!lifecycle || !this.has(sessionId, lifecycle) || !transientEntryId)
			return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#options.projection(sessionId);
		if (!projection) return;
		this.#options.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.settled",
					transientEntryId,
					entryId,
					at: this.#options.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.#options.broadcast(sessionId, pending);
		if (lifecycle.kind !== "prompt") this.remove(sessionId, lifecycle);
	}

	discardTransient(
		sessionId: SessionId,
		lifecycle: PromptLifecycle,
		reason: PromptDiscardReason,
	): void {
		const transientEntryId = lifecycle.transientEntryId;
		if (!transientEntryId) return;
		lifecycle.transientEntryId = undefined;
		const projection = this.#options.projection(sessionId);
		if (!projection) return;
		this.#options.broadcast(
			sessionId,
			projection.appendEvent(
				asAppWireEvent({
					type: "message.discarded",
					transientEntryId,
					reason,
					at: this.#options.now().toISOString(),
				}),
			),
		);
		const pending = projection.clearPendingPrompt(transientEntryId);
		if (pending) this.#options.broadcast(sessionId, pending);
	}

	release(
		sessionId: SessionId,
		lifecycle?: PromptLifecycle,
		reason: PromptDiscardReason = "completed-without-entry",
	): boolean {
		if (!lifecycle || !this.has(sessionId, lifecycle)) return false;
		this.discardTransient(sessionId, lifecycle, reason);
		return this.remove(sessionId, lifecycle);
	}

	releaseAll(
		sessionId: SessionId,
		reason: PromptDiscardReason,
	): boolean {
		const lifecycles = [...(this.#messages.get(sessionId) ?? [])];
		let released = false;
		for (const lifecycle of lifecycles)
			if (this.release(sessionId, lifecycle, reason)) released = true;
		return released;
	}

	stale(sessionId: SessionId): PromptLifecycle[] {
		const now = this.#options.now().getTime();
		const lifecycles = this.#messages.get(sessionId);
		if (!lifecycles || lifecycles.length === 0) return [];
		return lifecycles.filter(
			lifecycle =>
				now - lifecycle.registeredAt >= this.#options.idleGraceMs(),
		);
	}
}
