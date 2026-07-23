import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import {
	entryId,
	projectId,
	sessionId,
	TRANSCRIPT_CONTEXT_MAX_TEXT_BYTES,
	TRANSCRIPT_SEARCH_MAX_QUERY_BYTES,
	TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES,
	type TranscriptContextArguments,
	type TranscriptContextResult,
	type TranscriptSearchArguments,
	type TranscriptSearchHighlight,
	type TranscriptSearchIndexStatus,
	type TranscriptSearchItem,
	type TranscriptSearchResult,
	type TranscriptSearchRole,
} from "@t4-code/host-wire";
import { cleanText, projectMessageText } from "./discovery.ts";
import type { SessionRecord } from "./types.ts";

const SCHEMA_VERSION = 1;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const TAIL_ANCHOR_BYTES = 4096;
const MAX_SEARCH_TEXT_BYTES = 64 * 1024;
const MAX_CONTEXT_TEXT_BYTES = TRANSCRIPT_CONTEXT_MAX_TEXT_BYTES;
const MAX_QUERY_BYTES = TRANSCRIPT_SEARCH_MAX_QUERY_BYTES;

type StoredTranscriptRole = "user" | "assistant" | "summary";
export type TranscriptSearchState = "building" | "ready" | "stale";

export class TranscriptSearchError extends Error {
	constructor(readonly code: "transcript_anchor_not_found" | "transcript_cursor_invalid" | "transcript_cursor_stale") {
		super(code);
		this.name = "TranscriptSearchError";
	}
}

export interface SearchableTranscriptFragment {
	anchor: string;
	role: StoredTranscriptRole;
	timestamp: string;
	text: string;
}

type SessionRow = {
	session_id: string;
	path: string;
	project_id: string;
	project_name: string | null;
	title: string;
	archived_at: string | null;
	dev: number;
	ino: number;
	size: number;
	mtime_ms: number;
	ctime_ms: number;
	committed_offset: number;
	tail_anchor: string;
	state: string;
};

type SearchRow = {
	session_id: string;
	anchor: string;
	role: StoredTranscriptRole;
	timestamp: string;
	text: string;
	project_id: string;
	project_name: string | null;
	title: string;
	archived_at: string | null;
	rank: number;
};

type ContextRow = Pick<SearchRow, "anchor" | "role" | "timestamp" | "text"> & { ordinal: number };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
	try {
		return await fs.lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

type SearchCursor = { generation: number; offset: number; fingerprint: string };

function decodeSearchCursor(value: string): SearchCursor {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
	} catch {
		throw new TranscriptSearchError("transcript_cursor_invalid");
	}
	const cursor = asRecord(parsed);
	if (
		!cursor ||
		!Number.isSafeInteger(cursor.generation) ||
		(cursor.generation as number) < 0 ||
		!Number.isSafeInteger(cursor.offset) ||
		(cursor.offset as number) < 0 ||
		typeof cursor.fingerprint !== "string"
	)
		throw new TranscriptSearchError("transcript_cursor_invalid");
	return {
		generation: cursor.generation as number,
		offset: cursor.offset as number,
		fingerprint: cursor.fingerprint,
	};
}

function timestampOf(raw: Record<string, unknown>, message?: Record<string, unknown>): string {
	const value = raw.timestamp ?? message?.timestamp;
	if (typeof value === "string") {
		const milliseconds = Date.parse(cleanText(value, 128, true));
		if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString();
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
		try {
			return new Date(milliseconds).toISOString();
		} catch {}
	}
	return "1970-01-01T00:00:00.000Z";
}

/** Extract only the visible, durable corpus. This function is deliberately stateless. */
export function extractSearchableTranscriptFragment(line: string): SearchableTranscriptFragment | undefined {
	let raw: Record<string, unknown>;
	try {
		const parsed = JSON.parse(line) as unknown;
		const record = asRecord(parsed);
		if (!record) return undefined;
		raw = record;
	} catch {
		return undefined;
	}
	if (typeof raw.id !== "string") return undefined;
	let anchor: string;
	try {
		anchor = entryId(raw.id);
	} catch {
		return undefined;
	}

	if (raw.type === "compaction" && typeof raw.summary === "string") {
		const text = cleanText(raw.summary, MAX_SEARCH_TEXT_BYTES);
		return text ? { anchor, role: "summary", timestamp: timestampOf(raw), text } : undefined;
	}
	if (raw.type === "custom_message" && raw.display === true) {
		const role: StoredTranscriptRole = raw.attribution === "agent" ? "assistant" : "user";
		const text = projectMessageText(raw.content ?? raw.text, MAX_SEARCH_TEXT_BYTES);
		return text ? { anchor, role, timestamp: timestampOf(raw), text } : undefined;
	}
	if (raw.type !== "message") return undefined;
	const nested = asRecord(raw.message);
	const message = nested ?? raw;
	const role =
		typeof message.role === "string"
			? message.role
			: typeof raw.text === "string"
				? "assistant"
				: typeof raw.message === "string"
					? "user"
					: undefined;
	if (role !== "user" && role !== "assistant") return undefined;
	const content = message.content ?? message.text ?? (nested ? message.message : (raw.text ?? raw.message));
	const text = projectMessageText(content, MAX_SEARCH_TEXT_BYTES);
	return text ? { anchor, role, timestamp: timestampOf(raw, message), text } : undefined;
}

function queryTokens(query: string): string[] {
	const bounded = cleanText(query, MAX_QUERY_BYTES, true).normalize("NFKC");
	const tokens: string[] = [];
	const seen = new Set<string>();
	for (const token of bounded.match(/[\p{L}\p{N}_]+/gu) ?? []) {
		const key = token.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		tokens.push(token);
		if (tokens.length === 16) break;
	}
	return tokens;
}

function normalizedPhrase(value: string): string {
	return cleanText(value, MAX_QUERY_BYTES, true).normalize("NFKC").toLocaleLowerCase();
}

function ftsExpression(tokens: string[]): string {
	return tokens.map(token => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}

function searchFingerprint(input: TranscriptSearchArguments, tokens: readonly string[], limit: number): string {
	const value = JSON.stringify({
		query: normalizedPhrase(input.query),
		tokens,
		limit,
		projectId: input.projectId ?? null,
		roles: input.roles ? [...input.roles].sort() : null,
		archived: input.archived ?? "include",
		from: input.from ?? null,
		to: input.to ?? null,
	});
	return createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

function boundUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value);
	if (bytes.byteLength <= maxBytes) return value;
	return bytes
		.subarray(0, maxBytes)
		.toString("utf8")
		.replace(/\uFFFD$/u, "");
}

function tokenRanges(text: string, token: string): TranscriptSearchHighlight[] {
	const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const matches: TranscriptSearchHighlight[] = [];
	for (const match of text.matchAll(new RegExp(escaped, "giu"))) {
		if (match.index === undefined || match[0].length === 0) continue;
		matches.push({ start: match.index, end: match.index + match[0].length });
	}
	return matches;
}

function snippetFor(text: string, tokens: string[]): { text: string; highlights: TranscriptSearchHighlight[] } {
	let first = Number.POSITIVE_INFINITY;
	for (const token of tokens) {
		const range = tokenRanges(text, token)[0];
		if (range) first = Math.min(first, range.start);
	}
	const start = Number.isFinite(first) ? Math.max(0, first - 240) : 0;
	const prefix = start > 0 ? "…" : "";
	const remainder = text.slice(start);
	const prefixBytes = Buffer.byteLength(prefix);
	const truncated = Buffer.byteLength(remainder) > TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES - prefixBytes;
	const suffix = truncated ? "…" : "";
	const bodyBudget = TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES - prefixBytes - Buffer.byteLength(suffix);
	const snippet = prefix + boundUtf8(remainder, bodyBudget) + suffix;
	const highlights: TranscriptSearchHighlight[] = [];
	for (const token of tokens) {
		for (const range of tokenRanges(snippet, token)) {
			highlights.push(range);
			if (highlights.length === 32) break;
		}
		if (highlights.length === 32) break;
	}
	highlights.sort((a, b) => a.start - b.start || a.end - b.end);
	return { text: snippet, highlights };
}

async function contentAnchor(path: string, offset: number): Promise<string> {
	if (offset <= 0) return "";
	const handle = await fs.open(path, "r");
	try {
		const headLength = Math.min(offset, TAIL_ANCHOR_BYTES);
		const tailStart = Math.max(headLength, offset - TAIL_ANCHOR_BYTES);
		const head = Buffer.allocUnsafe(headLength);
		const tail = Buffer.allocUnsafe(offset - tailStart);
		const headRead = await handle.read(head, 0, head.length, 0);
		const tailRead = await handle.read(tail, 0, tail.length, tailStart);
		return createHash("sha256")
			.update(head.subarray(0, headRead.bytesRead))
			.update(tail.subarray(0, tailRead.bytesRead))
			.digest("hex");
	} finally {
		await handle.close();
	}
}

export class TranscriptSearchIndex {
	readonly #databasePath: string;
	#db?: Database;
	#state: TranscriptSearchState = "building";
	#knownSessions = 0;
	#indexedSessions = 0;
	#generation = 0;

	constructor(databasePath: string) {
		if (!isAbsolute(databasePath)) throw new Error("Transcript search database path must be absolute");
		this.#databasePath = databasePath;
	}

	async initialize(): Promise<void> {
		await this.#prepareStoragePath();
		try {
			this.#openDatabase();
		} catch {
			this.#db?.close();
			this.#db = undefined;
			await Promise.all([
				fs.rm(this.#databasePath, { force: true }),
				fs.rm(`${this.#databasePath}-wal`, { force: true }),
				fs.rm(`${this.#databasePath}-shm`, { force: true }),
			]);
			await this.#prepareStoragePath();
			this.#openDatabase();
		}
		await fs.chmod(this.#databasePath, 0o600);
		this.#refreshStatus();
	}

	async #prepareStoragePath(): Promise<void> {
		const directory = dirname(this.#databasePath);
		const existingDirectory = await lstatIfExists(directory);
		if (existingDirectory?.isSymbolicLink()) throw new Error("Transcript search database directory symlink rejected");
		if (existingDirectory && !existingDirectory.isDirectory())
			throw new Error("Transcript search database directory is not a directory");
		if (!existingDirectory) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const directoryInfo = await fs.lstat(directory);
		if (directoryInfo.isSymbolicLink()) throw new Error("Transcript search database directory symlink rejected");
		if (!directoryInfo.isDirectory()) throw new Error("Transcript search database directory is not a directory");
		await fs.chmod(directory, 0o700);
		const databaseInfo = await lstatIfExists(this.#databasePath);
		if (databaseInfo?.isSymbolicLink()) throw new Error("Transcript search database symlink rejected");
		if (databaseInfo && !databaseInfo.isFile()) throw new Error("Transcript search database is not a file");
	}

	#openDatabase(): void {
		const db = new Database(this.#databasePath, { create: true });
		db.run("PRAGMA busy_timeout = 5000");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA synchronous = NORMAL");
		db.run("PRAGMA secure_delete = ON");
		db.run("PRAGMA foreign_keys = ON");
		const integrity = db.query("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
		if (integrity?.quick_check !== "ok") {
			db.close();
			throw new Error("Transcript search database failed integrity check");
		}
		db.run(`
			CREATE TABLE IF NOT EXISTS metadata (
				id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0
			);
			INSERT OR IGNORE INTO metadata(id, schema_version, generation) VALUES(1, ${SCHEMA_VERSION}, 0);
			CREATE TABLE IF NOT EXISTS sessions (
				session_id TEXT PRIMARY KEY, path TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT,
				title TEXT NOT NULL, archived_at TEXT, dev INTEGER NOT NULL, ino INTEGER NOT NULL,
				size INTEGER NOT NULL, mtime_ms REAL NOT NULL, ctime_ms REAL NOT NULL,
				committed_offset INTEGER NOT NULL DEFAULT 0, tail_anchor TEXT NOT NULL DEFAULT '',
				indexed_at TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'building'
			);
			CREATE TABLE IF NOT EXISTS docs (
				id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, anchor TEXT NOT NULL,
				ordinal INTEGER NOT NULL, role TEXT NOT NULL, timestamp TEXT NOT NULL, text TEXT NOT NULL,
				project_id TEXT NOT NULL, project_name TEXT, title TEXT NOT NULL, archived_at TEXT,
				UNIQUE(session_id, anchor), FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS docs_context ON docs(session_id, ordinal);
			CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text, title, project, content='docs', content_rowid='id', tokenize='unicode61');
			CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
				INSERT INTO docs_fts(rowid, text, title, project) VALUES(new.id, new.text, new.title, coalesce(new.project_name, new.project_id));
			END;
			CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
				INSERT INTO docs_fts(docs_fts, rowid, text, title, project) VALUES('delete', old.id, old.text, old.title, coalesce(old.project_name, old.project_id));
			END;
			CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
				INSERT INTO docs_fts(docs_fts, rowid, text, title, project) VALUES('delete', old.id, old.text, old.title, coalesce(old.project_name, old.project_id));
				INSERT INTO docs_fts(rowid, text, title, project) VALUES(new.id, new.text, new.title, coalesce(new.project_name, new.project_id));
			END;
		`);
		const version = db.query("SELECT schema_version, generation FROM metadata WHERE id=1").get() as {
			schema_version: number;
			generation: number;
		};
		if (version.schema_version !== SCHEMA_VERSION) {
			db.close();
			throw new Error(`Unsupported transcript search schema ${version.schema_version}`);
		}
		this.#generation = version.generation;
		this.#db = db;
	}

	#database(): Database {
		if (!this.#db) throw new Error("Transcript search index is not initialized");
		return this.#db;
	}

	#commitMutation(mutation: () => boolean): boolean {
		const db = this.#database();
		let changed = false;
		db.transaction(() => {
			changed = mutation();
			if (changed) db.run("UPDATE metadata SET generation=generation+1 WHERE id=1");
		})();
		if (changed) {
			const row = db.query("SELECT generation FROM metadata WHERE id=1").get() as { generation: number };
			this.#generation = row.generation;
		}
		return changed;
	}

	#markSessionStale(session: string): void {
		const db = this.#database();
		const current = db.query("SELECT state FROM sessions WHERE session_id=?").get(session) as {
			state: string;
		} | null;
		if (!current || current.state === "stale") return;
		this.#commitMutation(() => db.run("UPDATE sessions SET state='stale' WHERE session_id=?", [session]).changes > 0);
	}

	async reconcile(
		records: readonly SessionRecord[],
		options: { readonly pruneMissing?: boolean } = {},
	): Promise<TranscriptSearchIndexStatus> {
		const db = this.#database();
		this.#state = "building";
		this.#knownSessions = records.length;
		let failed = false;
		const wanted = new Set(records.map(record => String(record.sessionId)));
		const existingIds = db.query("SELECT session_id FROM sessions").all() as Array<{ session_id: string }>;
		if (options.pruneMissing !== false) {
			for (const { session_id } of existingIds) {
				if (!wanted.has(session_id))
					this.#commitMutation(() => db.run("DELETE FROM sessions WHERE session_id=?", [session_id]).changes > 0);
			}
		} else {
			const known = new Set(existingIds.map(({ session_id }) => session_id));
			for (const session_id of wanted) known.add(session_id);
			this.#knownSessions = known.size;
		}
		for (const record of records) {
			try {
				await this.#reconcileSession(record);
			} catch {
				failed = true;
				this.#markSessionStale(String(record.sessionId));
			}
		}
		this.#state = failed || options.pruneMissing === false ? "stale" : "ready";
		this.#refreshStatus();
		return this.status();
	}

	async #reconcileSession(record: SessionRecord): Promise<boolean> {
		const db = this.#database();
		const info = await fs.stat(record.path);
		if (!info.isFile()) throw new Error(`Transcript is not a file: ${record.path}`);
		const id = String(record.sessionId);
		const previous = db.query("SELECT * FROM sessions WHERE session_id=?").get(id) as SessionRow | null;
		const metadata = {
			projectId: String(record.projectId),
			projectName: record.projectName ?? null,
			title: cleanText(record.title, 512, true) || "Untitled",
			archivedAt: record.archivedAt ?? null,
		};
		let rebuild = !previous;
		if (previous) {
			if (
				previous.path !== record.path ||
				previous.dev !== info.dev ||
				previous.ino !== info.ino ||
				info.size < previous.committed_offset
			)
				rebuild = true;
			else if (
				info.size === previous.size &&
				(info.mtimeMs !== previous.mtime_ms || info.ctimeMs !== previous.ctime_ms)
			)
				rebuild = true;
			else if ((await contentAnchor(record.path, previous.committed_offset)) !== previous.tail_anchor)
				rebuild = true;
		}

		if (!previous) {
			this.#commitMutation(
				() =>
					db.run(
						"INSERT INTO sessions(session_id,path,project_id,project_name,title,archived_at,dev,ino,size,mtime_ms,ctime_ms,committed_offset,tail_anchor,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'building')",
						[
							id,
							record.path,
							metadata.projectId,
							metadata.projectName,
							metadata.title,
							metadata.archivedAt,
							info.dev,
							info.ino,
							info.size,
							info.mtimeMs,
							info.ctimeMs,
							0,
							"",
						],
					).changes > 0,
			);
		} else if (rebuild) {
			this.#commitMutation(() => {
				const deleted = db.run("DELETE FROM docs WHERE session_id=?", [id]).changes;
				const updated = db.run(
					"UPDATE sessions SET path=?,project_id=?,project_name=?,title=?,archived_at=?,dev=?,ino=?,size=?,mtime_ms=?,ctime_ms=?,committed_offset=0,tail_anchor='',state='building' WHERE session_id=?",
					[
						record.path,
						metadata.projectId,
						metadata.projectName,
						metadata.title,
						metadata.archivedAt,
						info.dev,
						info.ino,
						info.size,
						info.mtimeMs,
						info.ctimeMs,
						id,
					],
				).changes;
				return deleted > 0 || updated > 0;
			});
		} else {
			const metadataChanged =
				previous.project_id !== metadata.projectId ||
				previous.project_name !== metadata.projectName ||
				previous.title !== metadata.title ||
				previous.archived_at !== metadata.archivedAt;
			if (metadataChanged) {
				this.#commitMutation(() => {
					db.run("UPDATE sessions SET project_id=?,project_name=?,title=?,archived_at=? WHERE session_id=?", [
						metadata.projectId,
						metadata.projectName,
						metadata.title,
						metadata.archivedAt,
						id,
					]);
					const updated = db.run(
						"UPDATE docs SET project_id=?,project_name=?,title=?,archived_at=? WHERE session_id=?",
						[metadata.projectId, metadata.projectName, metadata.title, metadata.archivedAt, id],
					).changes;
					return updated > 0;
				});
			}
		}

		const startOffset = rebuild || !previous ? 0 : previous.committed_offset;
		const wrote = await this.#indexFile(record.path, id, startOffset, metadata, info);
		return (
			rebuild ||
			wrote ||
			!previous ||
			previous.project_id !== metadata.projectId ||
			previous.project_name !== metadata.projectName ||
			previous.title !== metadata.title ||
			previous.archived_at !== metadata.archivedAt
		);
	}

	async #indexFile(
		path: string,
		sessionId: string,
		startOffset: number,
		metadata: { projectId: string; projectName: string | null; title: string; archivedAt: string | null },
		initialStat: Stats,
	): Promise<boolean> {
		const db = this.#database();
		const handle = await fs.open(path, "r");
		let committedOffset = startOffset;
		let readOffset = startOffset;
		let carry = Buffer.alloc(0);
		let skippingOversizedLine = false;
		let ordinal =
			((
				db.query("SELECT coalesce(max(ordinal), -1) AS value FROM docs WHERE session_id=?").get(sessionId) as {
					value: number;
				}
			).value ?? -1) + 1;
		let wrote = false;
		try {
			const opened = await handle.stat();
			if (opened.dev !== initialStat.dev || opened.ino !== initialStat.ino)
				throw new Error("Transcript changed while opening");
			while (true) {
				const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
				const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset);
				if (bytesRead === 0) break;
				const chunkStart = readOffset;
				const chunk = buffer.subarray(0, bytesRead);
				readOffset += bytesRead;
				const fragments: SearchableTranscriptFragment[] = [];
				let cursor = 0;
				let nextOffset = committedOffset;
				while (cursor < chunk.length) {
					const newline = chunk.indexOf(10, cursor);
					if (newline < 0) {
						if (!skippingOversizedLine) {
							const remainder = chunk.subarray(cursor);
							if (carry.length + remainder.length > MAX_LINE_BYTES) {
								carry = Buffer.alloc(0);
								skippingOversizedLine = true;
							} else carry = Buffer.concat([carry, remainder]);
						}
						break;
					}
					if (!skippingOversizedLine) {
						const segment = chunk.subarray(cursor, newline);
						if (carry.length + segment.length <= MAX_LINE_BYTES) {
							const line = Buffer.concat([carry, segment]).toString("utf8");
							const fragment = extractSearchableTranscriptFragment(line);
							if (fragment) fragments.push(fragment);
						}
					}
					carry = Buffer.alloc(0);
					skippingOversizedLine = false;
					nextOffset = chunkStart + newline + 1;
					cursor = newline + 1;
				}
				if (nextOffset === committedOffset) continue;
				const current = await handle.stat();
				if (current.dev !== initialStat.dev || current.ino !== initialStat.ino)
					throw new Error("Transcript changed while indexing");
				const nextAnchor = await contentAnchor(path, nextOffset);
				this.#commitMutation(() => {
					for (const fragment of fragments) {
						const inserted = db.run(
							"INSERT OR IGNORE INTO docs(session_id,anchor,ordinal,role,timestamp,text,project_id,project_name,title,archived_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
							[
								sessionId,
								fragment.anchor,
								ordinal,
								fragment.role,
								fragment.timestamp,
								fragment.text,
								metadata.projectId,
								metadata.projectName,
								metadata.title,
								metadata.archivedAt,
							],
						).changes;
						if (inserted > 0) ordinal++;
					}
					db.run(
						"UPDATE sessions SET committed_offset=?,tail_anchor=?,size=?,mtime_ms=?,ctime_ms=?,indexed_at=?,state='ready' WHERE session_id=?",
						[
							nextOffset,
							nextAnchor,
							current.size,
							current.mtimeMs,
							current.ctimeMs,
							new Date().toISOString(),
							sessionId,
						],
					);
					return true;
				});
				committedOffset = nextOffset;
				wrote = true;
			}
			if (!wrote) {
				const current = await handle.stat();
				this.#commitMutation(
					() =>
						db.run(
							"UPDATE sessions SET size=?,mtime_ms=?,ctime_ms=?,indexed_at=?,state='ready' WHERE session_id=? AND (size<>? OR mtime_ms<>? OR ctime_ms<>? OR state<>'ready')",
							[
								current.size,
								current.mtimeMs,
								current.ctimeMs,
								new Date().toISOString(),
								sessionId,
								current.size,
								current.mtimeMs,
								current.ctimeMs,
							],
						).changes > 0,
				);
			}
			return wrote;
		} finally {
			await handle.close();
		}
	}

	deleteSession(session: string): void {
		const db = this.#database();
		if (this.#commitMutation(() => db.run("DELETE FROM sessions WHERE session_id=?", [session]).changes > 0)) {
			this.#knownSessions = Math.max(0, this.#knownSessions - 1);
			this.#refreshStatus();
		}
	}

	search(input: TranscriptSearchArguments): TranscriptSearchResult {
		const db = this.#database();
		const tokens = queryTokens(input.query);
		if (tokens.length === 0) return { items: [], incomplete: this.#state !== "ready", index: this.status() };
		const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 20)));
		const fingerprint = searchFingerprint(input, tokens, limit);
		let offset = 0;
		if (input.cursor) {
			const cursor = decodeSearchCursor(input.cursor);
			if (cursor.generation !== this.#generation || cursor.fingerprint !== fingerprint)
				throw new TranscriptSearchError("transcript_cursor_stale");
			offset = cursor.offset;
		}
		const clauses = ["docs_fts MATCH ?"];
		const bindings: Array<string | number> = [ftsExpression(tokens)];
		if (input.archived === "only") clauses.push("d.archived_at IS NOT NULL");
		if (input.archived === "exclude") clauses.push("d.archived_at IS NULL");
		if (input.from) {
			clauses.push("d.timestamp>=?");
			bindings.push(input.from);
		}
		if (input.to) {
			clauses.push("d.timestamp<=?");
			bindings.push(input.to);
		}
		if (input.projectId) {
			clauses.push("d.project_id=?");
			bindings.push(String(input.projectId));
		}
		if (input.roles?.length) {
			const values = input.roles.slice(0, 3);
			clauses.push(`d.role IN (${values.map(() => "?").join(",")})`);
			bindings.push(...values);
		}
		const phrase = normalizedPhrase(input.query);
		const page = db
			.query(`WITH matches AS (
					SELECT d.session_id,d.anchor,d.role,d.timestamp,d.text,d.project_id,d.project_name,d.title,d.archived_at,
						bm25(docs_fts, 1.0, 0.25, 0.15) AS rank,
						CASE WHEN instr(lower(d.text || char(10) || d.title || char(10) || coalesce(d.project_name,d.project_id)), ?) > 0
							THEN 0 ELSE 1 END AS exact_priority
					FROM docs_fts JOIN docs d ON d.id=docs_fts.rowid WHERE ${clauses.join(" AND ")}
				), per_session AS (
					SELECT *, row_number() OVER (
						PARTITION BY session_id
						ORDER BY exact_priority,rank ASC,timestamp DESC,anchor
					) AS session_rank
					FROM matches
				)
				SELECT session_id,anchor,role,timestamp,text,project_id,project_name,title,archived_at,rank
				FROM per_session WHERE session_rank <= 3
				ORDER BY exact_priority,rank ASC,timestamp DESC,session_id,anchor
				LIMIT ? OFFSET ?`)
			.all(phrase, ...bindings, limit + 1, offset) as SearchRow[];
		const hasMore = page.length > limit;
		const items: TranscriptSearchItem[] = page.slice(0, limit).map(row => {
			const snippet = snippetFor(row.text, tokens);
			return {
				sessionId: sessionId(row.session_id),
				projectId: projectId(row.project_id),
				sessionTitle: row.title,
				...(row.archived_at ? { archivedAt: row.archived_at } : {}),
				anchorId: entryId(row.anchor),
				role: row.role as TranscriptSearchRole,
				timestamp: row.timestamp,
				snippet: snippet.text,
				highlights: snippet.highlights,
			};
		});
		return {
			items,
			...(hasMore
				? {
						nextCursor: Buffer.from(
							JSON.stringify({ generation: this.#generation, offset: offset + limit, fingerprint }),
						).toString("base64url"),
					}
				: {}),
			incomplete: this.#state !== "ready" || this.#indexedSessions < this.#knownSessions,
			index: this.status(),
		};
	}

	context(session: string, input: TranscriptContextArguments): TranscriptContextResult {
		const db = this.#database();
		const before = Math.max(0, Math.min(20, Math.trunc(input.before ?? 8)));
		const after = Math.max(0, Math.min(20, Math.trunc(input.after ?? 8)));
		const target = db
			.query("SELECT ordinal FROM docs WHERE session_id=? AND anchor=?")
			.get(session, input.anchorId) as { ordinal: number } | null;
		if (!target) throw new TranscriptSearchError("transcript_anchor_not_found");
		const rows = db
			.query(
				"SELECT anchor,role,timestamp,text,ordinal FROM docs WHERE session_id=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal",
			)
			.all(session, target.ordinal - before, target.ordinal + after) as ContextRow[];
		const extent = db
			.query("SELECT min(ordinal) AS first, max(ordinal) AS last FROM docs WHERE session_id=?")
			.get(session) as { first: number; last: number };
		return {
			anchorId: input.anchorId,
			rows: rows.map(row => ({
				anchorId: entryId(row.anchor),
				role: row.role as TranscriptSearchRole,
				timestamp: row.timestamp,
				text: boundUtf8(row.text, MAX_CONTEXT_TEXT_BYTES),
			})),
			anchorIndex: rows.findIndex(row => row.anchor === input.anchorId),
			hasBefore: extent.first < rows[0]!.ordinal,
			hasAfter: extent.last > rows.at(-1)!.ordinal,
			generation: String(this.#generation),
		};
	}

	status(): TranscriptSearchIndexStatus {
		return {
			state: this.#state,
			indexedSessions: this.#indexedSessions,
			knownSessions: this.#knownSessions,
			generation: String(this.#generation),
		};
	}

	#refreshStatus(): void {
		if (!this.#db) return;
		this.#indexedSessions = (
			this.#db.query("SELECT count(*) AS count FROM sessions WHERE state='ready'").get() as { count: number }
		).count;
		if (this.#knownSessions === 0)
			this.#knownSessions = (
				this.#db.query("SELECT count(*) AS count FROM sessions").get() as { count: number }
			).count;
	}

	close(): void {
		this.#db?.close();
		this.#db = undefined;
	}
}
