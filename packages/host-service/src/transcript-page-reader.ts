import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
	type DurableEntry,
	type HostId,
	MAX_TRANSCRIPT_LINE_BYTES,
	TRANSCRIPT_PAGE_MAX_BYTES,
	TRANSCRIPT_PAGE_MAX_CURSOR_BYTES,
	TRANSCRIPT_PAGE_MAX_ENTRIES,
	TRANSCRIPT_PAGE_MAX_RESULT_BYTES,
	TRANSCRIPT_PAGE_MIN_BYTES,
	type TranscriptPageArguments,
	type TranscriptPageResult,
} from "@t4-code/host-wire";
import { parseSessionTranscriptMetadata, SessionEntryProjector } from "./discovery.ts";
import type { SessionRecord } from "./types.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = TRANSCRIPT_PAGE_MAX_ENTRIES;
const DEFAULT_MAX_BYTES = TRANSCRIPT_PAGE_MAX_BYTES;
const MIN_MAX_BYTES = TRANSCRIPT_PAGE_MIN_BYTES;
const MAX_MAX_BYTES = TRANSCRIPT_PAGE_MAX_BYTES;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const PROJECTOR_BACKSCAN_BYTES = 512 * 1024;
const HEADER_BYTES = 128 * 1024;
const ANCHOR_BYTES = 4 * 1024;
const MAX_LINE_BYTES = MAX_TRANSCRIPT_LINE_BYTES;
const CURSOR_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type TranscriptPageErrorCode =
	| "transcript_cursor_invalid"
	| "transcript_cursor_stale"
	| "transcript_page_unavailable";

export class TranscriptPageError extends Error {
	constructor(readonly code: TranscriptPageErrorCode) {
		super(code);
		this.name = "TranscriptPageError";
	}
}

export interface TranscriptPageFileSystem {
	stat(path: string): Promise<{
		isFile(): boolean;
		size: number;
		mtimeMs: number;
		ctimeMs?: number;
		dev?: number;
		ino?: number;
	}>;
	readFileSlice(path: string, maxBytes: number): Promise<string | Uint8Array>;
	readFileRange(
		path: string,
		offset: number,
		maxBytes: number,
		expectedIdentity?: string,
	): Promise<string | Uint8Array>;
}

interface CursorPayload {
	v: number;
	sessionId: string;
	identity: string;
	generation: string;
	frozenEnd: number;
	frozenStamp: string;
	before: number;
	endAnchor: string;
	boundaryAnchor: string;
}

interface RawLine {
	readonly start: number;
	readonly value: Record<string, unknown>;
}

interface ProjectedEntry {
	readonly sourceOffset: number;
	readonly entry: DurableEntry;
}

function bytes(value: string | Uint8Array): Uint8Array {
	return typeof value === "string" ? encoder.encode(value) : value;
}

function digest(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function encodedBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function numericArgument(value: number | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new TranscriptPageError("transcript_page_unavailable");
	return value;
}

function identityOf(info: { dev?: number; ino?: number }, fallback: string): { cursor: string; open?: string } {
	if (!Number.isSafeInteger(info.dev) || !Number.isSafeInteger(info.ino)) return { cursor: digest(fallback) };
	const value = `${info.dev}:${info.ino}`;
	return { cursor: value, open: value };
}

function exactCursorPayload(value: unknown): CursorPayload {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TranscriptPageError("transcript_cursor_invalid");
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate).sort();
	const expected = [
		"before",
		"boundaryAnchor",
		"endAnchor",
		"frozenEnd",
		"frozenStamp",
		"generation",
		"identity",
		"sessionId",
		"v",
	].sort();
	if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
		throw new TranscriptPageError("transcript_cursor_invalid");
	if (
		candidate.v !== CURSOR_VERSION ||
		typeof candidate.sessionId !== "string" ||
		typeof candidate.identity !== "string" ||
		typeof candidate.generation !== "string" ||
		typeof candidate.frozenStamp !== "string" ||
		typeof candidate.endAnchor !== "string" ||
		typeof candidate.boundaryAnchor !== "string" ||
		!Number.isSafeInteger(candidate.frozenEnd) ||
		(candidate.frozenEnd as number) < 0 ||
		!Number.isSafeInteger(candidate.before) ||
		(candidate.before as number) < 0 ||
		(candidate.before as number) > (candidate.frozenEnd as number)
	)
		throw new TranscriptPageError("transcript_cursor_invalid");
	return candidate as unknown as CursorPayload;
}

/**
 * Reads transcript history backward from disk without materializing the whole
 * JSONL file. Cursors are encrypted so file paths and byte positions never
 * cross the app-wire boundary.
 */
export class TranscriptPageReader {
	readonly #host: HostId;
	readonly #fs: TranscriptPageFileSystem;
	readonly #cursorKey: Uint8Array;

	constructor(host: HostId, fs: TranscriptPageFileSystem, cursorKey: Uint8Array = randomBytes(32)) {
		if (cursorKey.byteLength !== 32) throw new Error("transcript page cursor key must contain 32 bytes");
		this.#host = host;
		this.#fs = fs;
		this.#cursorKey = new Uint8Array(cursorKey);
	}

	#seal(payload: CursorPayload): string {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
		return Buffer.concat([Buffer.from([CURSOR_VERSION]), iv, cipher.getAuthTag(), encrypted]).toString("base64url");
	}

	#open(cursor: string): CursorPayload {
		try {
			if (
				typeof cursor !== "string" ||
				cursor.length < 40 ||
				encoder.encode(cursor).byteLength > TRANSCRIPT_PAGE_MAX_CURSOR_BYTES ||
				/[^A-Za-z0-9_-]/u.test(cursor)
			)
				throw new Error("invalid cursor encoding");
			const packed = Buffer.from(cursor, "base64url");
			if (packed.toString("base64url") !== cursor) throw new Error("non-canonical cursor encoding");
			if (packed[0] !== CURSOR_VERSION || packed.byteLength < 30) throw new Error("invalid cursor envelope");
			const decipher = createDecipheriv("aes-256-gcm", this.#cursorKey, packed.subarray(1, 13));
			decipher.setAuthTag(packed.subarray(13, 29));
			const plaintext = Buffer.concat([decipher.update(packed.subarray(29)), decipher.final()]).toString("utf8");
			return exactCursorPayload(JSON.parse(plaintext));
		} catch (error) {
			if (error instanceof TranscriptPageError) throw error;
			throw new TranscriptPageError("transcript_cursor_invalid");
		}
	}

	async #range(path: string, start: number, length: number, openIdentity?: string): Promise<Uint8Array> {
		if (length <= 0) return new Uint8Array();
		const value = bytes(await this.#fs.readFileRange(path, start, length, openIdentity));
		if (value.byteLength > length) throw new TranscriptPageError("transcript_page_unavailable");
		return value;
	}

	async #anchor(path: string, position: number, frozenEnd: number, openIdentity?: string): Promise<string> {
		const start = Math.max(0, Math.min(position, frozenEnd) - ANCHOR_BYTES);
		const end = Math.min(frozenEnd, Math.max(position, 0) + ANCHOR_BYTES);
		return digest(await this.#range(path, start, end - start, openIdentity));
	}

	async #fileState(session: SessionRecord): Promise<{
		identity: string;
		openIdentity?: string;
		generation: string;
		stamp: string;
		size: number;
	}> {
		const info = await this.#fs.stat(session.path);
		if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0)
			throw new TranscriptPageError("transcript_page_unavailable");
		const identity = identityOf(info, `${session.sessionId}\0${session.path}`);
		const prefix = await this.#range(session.path, 0, Math.min(info.size, HEADER_BYTES), identity.open);
		const metadata = parseSessionTranscriptMetadata(prefix, session.path);
		if (metadata.sessionId !== session.sessionId) throw new TranscriptPageError("transcript_cursor_stale");
		let headerEnd = prefix.indexOf(10);
		if (headerEnd < 0) headerEnd = prefix.byteLength;
		const firstLine = prefix.subarray(0, headerEnd);
		try {
			const first = JSON.parse(decoder.decode(firstLine)) as { type?: unknown };
			if (first.type === "title" && headerEnd < prefix.byteLength) {
				const secondEnd = prefix.indexOf(10, headerEnd + 1);
				headerEnd = secondEnd < 0 ? prefix.byteLength : secondEnd;
			}
		} catch {
			throw new TranscriptPageError("transcript_page_unavailable");
		}
		const headerFingerprint = digest(prefix.subarray(0, headerEnd));
		return {
			identity: identity.cursor,
			...(identity.open ? { openIdentity: identity.open } : {}),
			generation: digest(`${session.sessionId}\0${identity.cursor}\0${headerFingerprint}`),
			stamp: `${info.mtimeMs}:${info.ctimeMs ?? ""}`,
			size: info.size,
		};
	}

	#lines(chunk: Uint8Array, absoluteStart: number, absoluteEnd: number): RawLine[] {
		let start = 0;
		if (absoluteStart > 0) {
			const newline = chunk.indexOf(10);
			if (newline < 0) return [];
			start = newline + 1;
		}
		const output: RawLine[] = [];
		while (start < chunk.byteLength) {
			let end = chunk.indexOf(10, start);
			if (end < 0) end = chunk.byteLength;
			const lineStart = absoluteStart + start;
			if (lineStart >= absoluteEnd) break;
			let line = chunk.subarray(start, Math.min(end, absoluteEnd - absoluteStart));
			if (line.at(-1) === 13) line = line.subarray(0, line.byteLength - 1);
			if (line.byteLength > 0 && line.byteLength <= MAX_LINE_BYTES) {
				try {
					const parsed = JSON.parse(decoder.decode(line));
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
						output.push({ start: lineStart, value: parsed as Record<string, unknown> });
				} catch {
					// Ignore malformed/crash-truncated records, matching ordinary discovery.
				}
			}
			if (end === chunk.byteLength) break;
			start = end + 1;
		}
		return output;
	}

	async page(session: SessionRecord, args: TranscriptPageArguments): Promise<TranscriptPageResult> {
		const limit = numericArgument(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
		const maxBytes = numericArgument(args.maxBytes, DEFAULT_MAX_BYTES, MIN_MAX_BYTES, MAX_MAX_BYTES);
		const state = await this.#fileState(session);
		let frozenEnd = state.size;
		let frozenStamp = state.stamp;
		let before = frozenEnd;
		let endAnchor = await this.#anchor(session.path, frozenEnd, frozenEnd, state.openIdentity);
		if (args.before !== undefined) {
			const cursor = this.#open(args.before);
			if (
				cursor.sessionId !== session.sessionId ||
				cursor.identity !== state.identity ||
				cursor.generation !== state.generation ||
				cursor.frozenEnd > state.size ||
				(cursor.frozenEnd === state.size && cursor.frozenStamp !== state.stamp)
			)
				throw new TranscriptPageError("transcript_cursor_stale");
			frozenEnd = cursor.frozenEnd;
			frozenStamp = cursor.frozenStamp;
			before = cursor.before;
			endAnchor = await this.#anchor(session.path, frozenEnd, frozenEnd, state.openIdentity);
			const boundaryAnchor = await this.#anchor(session.path, before, frozenEnd, state.openIdentity);
			if (endAnchor !== cursor.endAnchor || boundaryAnchor !== cursor.boundaryAnchor)
				throw new TranscriptPageError("transcript_cursor_stale");
		}

		const candidateStart = Math.max(0, before - MAX_SCAN_BYTES);
		const readStart = Math.max(0, candidateStart - PROJECTOR_BACKSCAN_BYTES);
		const chunk = await this.#range(session.path, readStart, before - readStart, state.openIdentity);
		const after = await this.#fs.stat(session.path);
		if (identityOf(after, `${session.sessionId}\0${session.path}`).cursor !== state.identity || after.size < frozenEnd)
			throw new TranscriptPageError("transcript_cursor_stale");

		const lines = this.#lines(chunk, readStart, before);
		const projector = new SessionEntryProjector(this.#host, session.sessionId, "live");
		const projected: ProjectedEntry[] = [];
		const projectedIds = new Set<string>();
		for (const line of lines) {
			try {
				for (const entry of projector.project(line.value))
					if (line.start >= candidateStart && !projectedIds.has(entry.id)) {
						projectedIds.add(entry.id);
						projected.push({ sourceOffset: line.start, entry });
					}
			} catch {
				// One malformed foreign record must not hide the rest of a transcript page.
			}
		}

		const selected: ProjectedEntry[] = [];
		let selectedBytes = 0;
		for (let index = projected.length - 1; index >= 0 && selected.length < limit; index--) {
			const candidate = projected[index]!;
			const candidateBytes = encodedBytes(candidate.entry);
			if (candidateBytes > maxBytes) throw new TranscriptPageError("transcript_page_unavailable");
			if (selectedBytes + candidateBytes > maxBytes) break;
			selected.push(candidate);
			selectedBytes += candidateBytes;
		}
		selected.reverse();

		for (;;) {
			let nextBefore: number;
			if (selected.length > 0) nextBefore = selected[0]!.sourceOffset;
			else {
				const firstCandidateLine = lines.find(line => line.start >= candidateStart);
				nextBefore = firstCandidateLine?.start ?? candidateStart;
				if (nextBefore >= before && before > 0) nextBefore = candidateStart;
			}
			const hasMore =
				readStart > 0 ||
				projected.some(value => value.sourceOffset < nextBefore) ||
				(selected.length === 0 && nextBefore > 0);
			const nextCursor = hasMore
				? this.#seal({
						v: CURSOR_VERSION,
						sessionId: session.sessionId,
						identity: state.identity,
						generation: state.generation,
						frozenEnd,
						frozenStamp,
						before: nextBefore,
						endAnchor,
						boundaryAnchor: await this.#anchor(session.path, nextBefore, frozenEnd, state.openIdentity),
					})
				: undefined;
			const result: TranscriptPageResult = {
				entries: selected.map(value => value.entry),
				...(nextCursor ? { nextCursor } : {}),
				hasMore,
				generation: state.generation,
			};
			if (encodedBytes(result) <= Math.min(maxBytes, TRANSCRIPT_PAGE_MAX_RESULT_BYTES)) return result;
			if (selected.length <= 1) throw new TranscriptPageError("transcript_page_unavailable");
			selected.shift();
		}
	}
}
