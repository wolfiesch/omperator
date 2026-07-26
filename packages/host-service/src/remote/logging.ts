import { appendFile, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal structured host logger. Appends one NDJSON line per event to
 * `<stateRoot>/logs/host-<YYYY-MM-DD>.ndjson` with size-based rotation.
 *
 * Rotation keeps the newest `maxFiles` files (default 5) each bounded by
 * `maxFileBytes` (default 4 MiB). When the active file reaches the bound it is
 * rolled to `.1`, `.2`, … and the oldest beyond the keep count is deleted.
 *
 * Events carry no PII: callers must never pass tokens, secrets, or credentials.
 * The `level` field defaults to "info"; pass `fields.level` to override.
 */
export interface HostLoggerOptions {
	/** Absolute profile state root; logs are written under `<stateRoot>/logs/`. */
	readonly stateRoot: string;
	/** Max bytes per active log file before rotation. Default 4 MiB. */
	readonly maxFileBytes?: number;
	/** Max files to retain after rotation (active + rolled). Default 5. */
	readonly maxFiles?: number;
	/** Injectable clock for deterministic tests. Default `() => new Date()`. */
	readonly now?: () => Date;
}

export interface HostLogger {
	/** Queue an event. Never throws; writes are serialized internally. */
	log(event: string, fields?: Record<string, unknown>): void;
	/** Await all queued writes and rotations. */
	flush(): Promise<void>;
	/** Flush and stop accepting further events. */
	close(): Promise<void>;
}

const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const LOG_DIR_NAME = "logs";
const LOG_PREFIX = "host-";
const LOG_SUFFIX = ".ndjson";

function dateStamp(now: Date): string {
	const year = now.getUTCFullYear();
	const month = String(now.getUTCMonth() + 1).padStart(2, "0");
	const day = String(now.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function activeFileName(now: Date): string {
	return `${LOG_PREFIX}${dateStamp(now)}${LOG_SUFFIX}`;
}

function rolledFileName(base: string, index: number): string {
	return `${base}.${index}`;
}

export function createHostLogger(options: HostLoggerOptions): HostLogger {
	const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0)
		throw new Error("maxFileBytes must be a positive integer");
	if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("maxFiles must be a positive integer");
	const now = options.now ?? (() => new Date());
	const logDir = join(options.stateRoot, LOG_DIR_NAME);

	let activeName: string | undefined;
	let activeBytes = 0;
	let tail: Promise<void> = Promise.resolve();
	let closed = false;
	let dirReady: Promise<void> | undefined;

	function ensureDir(): Promise<void> {
		if (!dirReady) dirReady = mkdir(logDir, { recursive: true }).then(() => undefined, () => undefined);
		return dirReady;
	}

	function serialize(task: () => Promise<void>): void {
		tail = tail.then(task, task);
	}
	async function rotate(currentName: string): Promise<void> {
		// Roll .{n-1} -> .n, drop the oldest beyond the keep count, then roll
		// the active file to .1. Best-effort: rotation failures must not raise
		// into the write path.
		try {
			const keep = maxFiles - 1; // rolled slots after the active file is renamed
			for (let i = keep; i >= 1; i--) {
				const from = rolledFileName(currentName, i);
				const to = rolledFileName(currentName, i + 1);
				await rename(join(logDir, from), join(logDir, to)).catch(() => undefined);
			}
			await rename(join(logDir, currentName), join(logDir, rolledFileName(currentName, 1))).catch(
				() => undefined,
			);
			// Prune any stale rolls beyond the keep count (e.g. after a config shrink).
			const entries = await readdir(logDir).catch(() => []);
			const base = currentName;
			for (const entry of entries) {
				if (!entry.startsWith(`${base}.`)) continue;
				const index = Number(entry.slice(`${base}.`.length));
				if (Number.isInteger(index) && index > maxFiles - 1) {
					await unlink(join(logDir, entry)).catch(() => undefined);
				}
			}
		} catch {
			/* rotation is best-effort */
		}
	}

	function writeLine(line: string): Promise<void> {
		return ensureDir().then(async () => {

			const name = activeFileName(now());
			if (activeName !== name) {
				activeName = name;
				activeBytes = (await stat(join(logDir, name)).then(s => Number(s.size)).catch(() => 0)) || 0;
			}
			if (activeBytes + Buffer.byteLength(line, "utf8") > maxFileBytes && activeBytes > 0) {
				await rotate(name);
				activeName = name;
				activeBytes = 0;
			}
			await appendFile(join(logDir, name), line, "utf8");
			activeBytes += Buffer.byteLength(line, "utf8");
		});
	}

	function log(event: string, fields?: Record<string, unknown>): void {
		if (closed) return;
		const ts = now().toISOString();
		const payload: Record<string, unknown> = { ts, level: "info", event };
		if (fields) {
			for (const [key, value] of Object.entries(fields)) {
				if (key === "ts" || key === "event") continue;
				if (key === "level" && typeof value === "string") payload.level = value;
				else payload[key] = value;
			}
		}
		let line: string;
		try {
			line = `${JSON.stringify(payload)}\n`;
		} catch {
			return; // unserializable field; drop rather than throw
		}
		serialize(() => writeLine(line));
	}

	function flush(): Promise<void> {
		const current = tail;
		return current.then(() => undefined, () => undefined);
	}

	async function close(): Promise<void> {
		closed = true;
		await flush();
	}

	return { log, flush, close };
}
