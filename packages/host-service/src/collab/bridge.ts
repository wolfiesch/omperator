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
import { parseCollabLink, type CollabLink } from "./link.ts";
import {
	type CollabEvent,
	type CollabGuestFrame,
	type CollabHostFrame,
	type CollabWireEntry,
} from "./frames.ts";
import type { HostId, SessionId, DurableEntry, SessionEvent } from "@t4-code/host-wire";

export interface CollabBridgeHandlers {
	/** Rebase the session onto a fresh snapshot of durable entries. */
	rebase(entries: DurableEntry[]): void;
	/** One new durable entry appended live. */
	appendEntry(entry: DurableEntry): void;
	/** One live app-wire event (message.update, tool.*, turn.*, …). */
	appendEvent(event: SessionEvent): void;
	/** Host changed streaming/status (isStreaming). */
	setStreaming(streaming: boolean): void;
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
			emit.appendEvent({ type: "turn.start", at });
			return;
		case "turn_end":
		case "agent_end":
			emit.appendEvent({ type: "turn.end", at });
			return;
		case "message_update":
		case "message_start": {
			const { text, reasoning } = messageTextAndReasoning(event);
			emit.appendEvent({ type: "message.update", entryId: "", role: "assistant", text, reasoning, at });
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
	let parsed: { link?: unknown };
	try {
		parsed = JSON.parse(text) as { link?: unknown };
	} catch {
		return undefined;
	}
	if (typeof parsed.link !== "string") return undefined;
	try {
		return parseCollabLink(parsed.link);
	} catch {
		return undefined;
	}
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

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#client.close();
	}
}

export { parseCollabLink };
export type { CollabGuestFrame, CollabHostFrame };
