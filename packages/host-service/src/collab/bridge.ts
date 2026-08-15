//  collab/bridge.ts
//  A collab guest bound to one externally-owned session. It joins the room
//  the host runtime publishes, replays the snapshot into durable entries, and
//  projects live entry/event frames into app-wire events — so clients see a
//  live shared transcript without the appserver ever spawning a second runtime.
//  Prompts route through the bridge to the live host.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { projectSessionEntries, SessionEntryProjector } from "../discovery.ts";
import { CollabGuestClient, type CollabGuestSnapshot } from "./client.ts";
import { parseCollabLink, readCollabLinkFromGateway, type CollabLink } from "./link.ts";
import {
	type CollabEvent,
	type CollabGuestFrame,
	type CollabHostFrame,
	type CollabUiRequest,
	type CollabWireEntry,
} from "./frames.ts";
import type { HostId, SessionId, DurableEntry, SessionEvent } from "@t4-code/host-wire";

export interface EnclaveCaps {
	version?: number;
	vision?: boolean;
	models?: { id: string; name?: string; vision?: boolean }[];
	commands?: { name: string; description?: string }[];
	current?: { model?: string; thinking?: string };
}

export interface CollabControlResult {
	ok: boolean;
	message?: string;
	data?: string;
	mimeType?: string;
}

export interface CollabBridgeHandlers {
	/** Rebase the session onto a fresh snapshot of durable entries. */
	rebase(entries: DurableEntry[]): void;
	/** One new durable entry appended live. */
	appendEntry(entry: DurableEntry): void;
	/** One live app-wire event (message.update, tool.*, turn.*, …). */
	appendEvent(event: SessionEvent): void;
	/** Host changed streaming/status (isStreaming). */
	setStreaming(streaming: boolean): void;
	/** The /enclave plugin announced its capability handshake. */
	onCaps?(caps: EnclaveCaps): void;
	/** The host wants interactive input (plan approval, select, editor). */
	onUiRequest?(request: CollabUiRequest): void;
	/** The room is gone; drop the bridge. */
	fatal(reason: string): void;
}

const MAX_EVENT_TEXT = 65_536;

function eventAt(timestamp?: number): string {
	return new Date(timestamp ?? Date.now()).toISOString();
}

function messageTextAndReasoning(message: CollabGuestFrame extends never ? never : unknown): {
	text: string;
	reasoning: string;
} {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return { text: content, reasoning: "" };
	if (!Array.isArray(content)) return { text: "", reasoning: "" };
	let text = "";
	let reasoning = "";
	for (const block of content) {
		const b = block as { type?: string; text?: string; thinking?: string };
		if (b.type === "text" && typeof b.text === "string") text += b.text;
		else if (b.type === "thinking" && typeof b.thinking === "string") reasoning += b.thinking;
	}
	return { text: text.slice(0, MAX_EVENT_TEXT), reasoning: reasoning.slice(0, MAX_EVENT_TEXT) };
}

function toolCallId(event: CollabEvent): string {
	return typeof (event as { toolCallId?: unknown }).toolCallId === "string"
		? ((event as { toolCallId: string }).toolCallId)
		: `tool-${createHash("sha1").update(JSON.stringify(event)).digest("hex").slice(0, 12)}`;
}

function toolName(event: CollabEvent): string {
	const value = (event as { toolName?: unknown }).toolName;
	return typeof value === "string" ? value : "tool";
}

/**
 * Maps a live collab host frame onto the bridge callbacks. Returns true if
 * the frame carried durable/event state, false if it was ignored.
 */
export function projectCollabFrame(frame: CollabHostFrame, host: HostId, sessionId: SessionId, emit: CollabBridgeHandlers): boolean {
	if (frame.t === "state") {
		emit.setStreaming(frame.state.isStreaming === true);
		return true;
	}
	if (frame.t === "entry") return projectCollabEntry(frame.entry, host, sessionId, emit);
	if (frame.t === "event") {
		projectCollabEvent(frame.event, emit);
		return true;
	}
	return false;
}

/** Per-bridge accumulated block content for the runtime's delta frames. */
const collabBlockContents = new WeakMap<CollabBridgeHandlers, Map<string, string>>();

/** Stable non-empty entryId for live blocks (the timeline drops empty ids). */
const COLLAB_ASSISTANT_ENTRY_ID = "collab:assistant";

/** Read a string field off an unknown record without trusting its shape. */
function collabString(value: unknown, key: string): string | undefined {
	if (value && typeof value === "object" && key in value) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === "string") return v;
	}
	return undefined;
}

/** Read a number field off an unknown record without trusting its shape. */
function collabNumber(value: unknown, key: string): number | undefined {
	if (value && typeof value === "object" && key in value) {
		const v = (value as Record<string, unknown>)[key];
		if (typeof v === "number" && Number.isSafeInteger(v)) return v;
	}
	return undefined;
}

/**
 * Emit ordered assistant.block.update events for a collab message frame, so
 * native clients' live-turn timelines stream text and thinking letter by
 * letter. Delta frames (assistantMessageEvent text_delta/thinking_delta)
 * accumulate per contentIndex; snapshot-only frames project the accumulated
 * extraction with stable indices (thinking 0, text 1). Mirrors the RPC
 * translator's textOrThinkingBlock.
 */
function emitCollabBlockUpdates(
	event: CollabEvent,
	message: unknown,
	emit: CollabBridgeHandlers,
	text: string,
	reasoning: string,
	at: string,
): void {
	let store = collabBlockContents.get(emit);
	if (!store) {
		store = new Map();
		collabBlockContents.set(emit, store);
	}
	const ame = "assistantMessageEvent" in event ? event.assistantMessageEvent : undefined;
	const ameType = collabString(ame, "type");
	const blockKind = ameType === "text_delta" ? "text" : ameType === "thinking_delta" ? "thinking" : undefined;
	if (blockKind) {
		const blockIndex = collabNumber(ame, "contentIndex") ?? 0;
		const key = `${blockIndex}|${blockKind}`;
		// Prefer the runtime's accumulated partial snapshot when present.
		const partial = ame && typeof ame === "object" && "partial" in ame ? ame.partial : undefined;
		const partialContent = partial && typeof partial === "object" && "content" in partial ? partial.content : undefined;
		const blocks = Array.isArray(partialContent) ? partialContent : [];
		const block = blocks[blockIndex];
		const snapshot = blockKind === "text" ? collabString(block, "text") : collabString(block, "thinking");
		if (snapshot !== undefined) store.set(key, snapshot);
		else {
			const delta = collabString(ame, "delta");
			if (delta === undefined) return;
			store.set(key, (store.get(key) ?? "") + delta);
		}
		const content = store.get(key) ?? "";
		if (!content) return;
		emit.appendEvent({
			type: "assistant.block.update",
			entryId: COLLAB_ASSISTANT_ENTRY_ID,
			blockIndex,
			blockKind,
			content,
			at,
		});
		return;
	}
	// Snapshot-only frame: project the accumulated extraction as blocks —
	// but only for kinds the delta path has not produced this turn (the
	// delta path is authoritative when both shapes appear in one stream).
	// Assistant content only — the collab host echoes user prompts back as
	// message_update frames, and those must never become assistant blocks.
	const role = collabString(message, "role");
	if (role !== "assistant") return;
	const hasDelta = (kind: string) => [...store.keys()].some(k => k.endsWith(`|${kind}`));
	if (reasoning && !hasDelta("thinking")) {
		emit.appendEvent({
			type: "assistant.block.update",
			entryId: COLLAB_ASSISTANT_ENTRY_ID,
			blockIndex: 0,
			blockKind: "thinking",
			content: reasoning,
			at,
		});
	}
	if (text && !hasDelta("text")) {
		emit.appendEvent({
			type: "assistant.block.update",
			entryId: COLLAB_ASSISTANT_ENTRY_ID,
			blockIndex: 1,
			blockKind: "text",
			content: text,
			at,
		});
	}
}

/** Convert one raw collab entry to a durable entry using the OMP projector. */
export function projectCollabEntry(
	raw: CollabWireEntry,
	host: HostId,
	sessionId: SessionId,
	emit: CollabBridgeHandlers,
): boolean {
	// The host echoes guest prompts back as custom_message "collab-prompt"
	// entries; the appserver already projects the durable user bubble itself,
	// so the echo would duplicate it.
	if (
		raw.type === "custom_message" &&
		(raw as { customType?: unknown }).customType === "collab-prompt"
	)
		return false;
	const projected = projectSessionEntries([raw], host, sessionId, new Date().toISOString());
	for (const entry of projected.entries) emit.appendEntry(entry);
	return projected.entries.length > 0;
}

export function projectCollabEvent(event: CollabEvent, emit: CollabBridgeHandlers): void {
	const ts = (event as { timestamp?: unknown }).timestamp;
	const at = eventAt(typeof ts === "number" ? ts : undefined);
	switch (event.type) {
		case "turn_start":
		case "agent_start":
			collabBlockContents.get(emit)?.clear();
			emit.appendEvent({ type: "turn.start", at });
			return;
		case "turn_end":
		case "agent_end":
			emit.appendEvent({ type: "turn.end", at });
			return;
		case "message_update":
		case "message_start": {
			// Extract from event.message — the runtime snapshot lives there,
			// not on the event itself (reading event.content always yields "").
			const { text, reasoning } = messageTextAndReasoning(event.message);
			emit.appendEvent({ type: "message.update", entryId: "", role: "assistant", text, reasoning, at });
			emitCollabBlockUpdates(event, event.message, emit, text, reasoning, at);
			return;
		}
		case "tool_execution_start": {
			const callId = toolCallId(event);
			const tool = toolName(event);
			emit.appendEvent({ type: "tool.start", callId, tool, title: tool, args: (event as { args?: unknown }).args ?? {}, at });
			return;
		}
		case "tool_execution_update": {
			const partial = (event as { partialResult?: unknown }).partialResult;
			const note = typeof partial === "string" ? partial.slice(0, MAX_EVENT_TEXT) : "";
			if (!note) return;
			emit.appendEvent({ type: "tool.progress", callId: toolCallId(event), note, at });
			return;
		}
		case "tool_execution_end": {
			const callId = toolCallId(event);
			const result = (event as { result?: unknown }).result;
			emit.appendEvent({
				type: "tool.result",
				callId,
				ok: (event as { isError?: boolean }).isError !== true,
				result: typeof result === "string" ? { output: result.slice(0, MAX_EVENT_TEXT) } : (result ?? {}),
				at,
			});
			return;
		}
		case "notice": {
			const level = (event as { level?: string }).level;
			const message = (event as { message?: string }).message ?? "";
			if (!message) return;
			emit.appendEvent({
				type: "notice",
				level: level === "error" ? "error" : level === "warning" ? "warning" : "info",
				message: message.slice(0, MAX_EVENT_TEXT),
				at,
			});
			return;
		}
		default:
			// Unknown event types are tolerated (protocol requirement).
			return;
	}
}

const COLLAB_JSON_NAME = "collab.json";

/**
 * Read the room link a host runtime publishes for a session at
 * `<transcript minus .jsonl>/collab.json`. Returns undefined when there is no
 * live room. A freshness window keeps stale files (host died without cleanup)
 * from being bridged forever.
 */
export async function readCollabLinkForTranscript(
	transcriptPath: string,
	freshWindowMs = 30_000,
): Promise<CollabLink | undefined> {
	if (!transcriptPath.endsWith(".jsonl")) return undefined;
	const file = `${transcriptPath.slice(0, -".jsonl".length)}/${COLLAB_JSON_NAME}`;
	let info;
	try {
		info = await stat(file);
	} catch {
		return undefined;
	}
	if (Date.now() - info.mtimeMs > freshWindowMs) return undefined;
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	let parsed: { link?: unknown; token?: unknown };
	try {
		parsed = JSON.parse(text) as { link?: unknown; token?: unknown };
	} catch {
		return undefined;
	}
	if (typeof parsed.link !== "string") return undefined;
	try {
		const link = parseCollabLink(parsed.link);
		return typeof parsed.token === "string" ? { ...link, token: parsed.token } : link;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the live room link for a session: the on-disk collab.json first
 * (with its freshness window), then the gateway push registry. Never
 * throws; returns undefined when there is no live room anywhere.
 */
export async function readCollabLink(
	sessionId: SessionId,
	path: string,
): Promise<CollabLink | undefined> {
	const fromFile = await readCollabLinkForTranscript(path);
	if (fromFile) return fromFile;
	return readCollabLinkFromGateway(sessionId);
}

export class CollabSessionBridge {
	readonly sessionId: SessionId;
	readonly path: string;
	readonly link: CollabLink;
	readonly #client: CollabGuestClient;
	readonly #emit: CollabBridgeHandlers;
	readonly #host: HostId;
	#projector: SessionEntryProjector;
	#emittedEntryIds = new Set<string>();
	#disposed = false;
	readonly #onFatalInternal: () => void;
	#pendingControl = new Map<number, (result: CollabControlResult) => void>();
	#controlSeq = 0;

	constructor(
		sessionId: SessionId,
		path: string,
		link: CollabLink,
		host: HostId,
		emit: CollabBridgeHandlers,
		onFatal: () => void,
	) {
		this.sessionId = sessionId;
		this.path = path;
		this.link = link;
		this.#emit = emit;
		this.#host = host;
		this.#onFatalInternal = onFatal;
		this.#projector = new SessionEntryProjector(host, sessionId, "live", [], undefined);
		this.#client = new CollabGuestClient(link, {
			onSnapshot: snapshot => this.#applySnapshot(snapshot),
			onFrame: frame => this.#applyLiveFrame(frame),
			onFatal: reason => this.#fatal(reason),
		});
	}

	start(): void {
		this.#client.start();
	}

	get connected(): boolean {
		return this.#client.connected;
	}

	#applySnapshot(snapshot: CollabGuestSnapshot): void {
		if (this.#disposed) return;
		// Fresh projector for the snapshot; a reconnect resyncs from scratch.
		this.#projector = new SessionEntryProjector(this.#host, this.sessionId, "live", [], undefined);
		this.#emittedEntryIds.clear();
		const projected = projectSessionEntries(
			snapshot.entries,
			this.#host,
			this.sessionId,
			new Date().toISOString(),
			undefined,
		);
		const durable = projected.entries;
		for (const entry of durable) this.#emittedEntryIds.add(entry.id);
		this.#emit.rebase(durable);
	}

	#applyLiveFrame(frame: CollabHostFrame): void {
		if (this.#disposed) return;
		if (frame.t === "snapshot-chunk") {
			// Snapshot chunks are accumulated by the client and delivered as one
			// onSnapshot; stray chunks are ignored.
			return;
		}
		if (frame.t === "entry") {
			const entry = frame.entry;
			// Feed the persistent projector so tool-call correlation is kept.
			try {
				this.#projector.project(entry as never);
			} catch {
				// The batch projector below is authoritative for durables.
			}
			const projected = projectSessionEntries([entry], this.#host, this.sessionId, new Date().toISOString(), undefined);
			for (const durable of projected.entries) {
				if (this.#emittedEntryIds.has(durable.id)) continue;
				this.#emittedEntryIds.add(durable.id);
				this.#emit.appendEntry(durable);
			}
			return;
		}
		if (frame.t === "enclave-caps") {
			this.#emit.onCaps?.({
				version: frame.version,
				vision: frame.vision,
				models: frame.models,
				commands: frame.commands,
				current: frame.current,
			});
			return;
		}
		if (frame.t === "enclave-result") {
			const resolve = frame.reqId !== undefined ? this.#pendingControl.get(frame.reqId) : undefined;
			if (resolve) {
				this.#pendingControl.delete(frame.reqId!);
				resolve({ ok: frame.ok, message: frame.message, data: frame.data, mimeType: frame.mimeType });
			}
			return;
		}
		if (frame.t === "ui-request") {
			this.#emit.onUiRequest?.(frame.request);
			return;
		}
		projectCollabFrame(frame, this.#host, this.sessionId, this.#emit);
	}

	#fatal(reason: string): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#onFatalInternal();
		this.#emit.fatal(reason);
	}

	prompt(text: string): void {
		this.#client.prompt(text);
	}
	cancel(): void {
		this.#client.abort();
	}
	uiResponse(reqId: number, value?: string): void {
		this.#client.uiResponse(reqId, value);
	}
	/** /enclave extension: run a control command on the host plugin. */
	control(method: string, params?: unknown): Promise<CollabControlResult> {
		if (this.#disposed) return Promise.resolve({ ok: false, message: "bridge closed" });
		const reqId = ++this.#controlSeq;
		const { promise, resolve } = Promise.withResolvers<CollabControlResult>();
		this.#pendingControl.set(reqId, resolve);
		const timer = setTimeout(() => {
			const pending = this.#pendingControl.get(reqId);
			if (pending) {
				this.#pendingControl.delete(reqId);
				pending({ ok: false, message: `control ${method} timed out` });
			}
		}, 15_000);
		void promise.finally(() => clearTimeout(timer));
		this.#client.control(method, params, reqId);
		return promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#client.close();
	}
}

export { parseCollabLink };
export type { CollabGuestFrame, CollabHostFrame };
