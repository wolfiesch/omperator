import { MAX_FILE_BYTES, type SessionId } from "@t4-code/host-wire";
import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { DesktopOperationsAuthority, OperationContext } from "./dispatcher.ts";

const execFileAsync = promisify(execFile);

/**
 * Maximum entries returned by one `files.list` call. The wire decoder bounds
 * the result array independently; this cap keeps a pathological directory from
 * producing a frame that exceeds it and bounds the work for a single request.
 */
const MAX_LIST_ENTRIES = 512;
/**
 * Raw bytes read for a binary file before base64 encoding. The `files.read`
 * command result decoder bounds `content` to `MAX_FILE_BYTES` UTF-8 bytes, and
 * base64 inflates by 4/3, so reading this many bytes keeps the encoded payload
 * under that limit: `ceil(589824 / 3) * 4 === 786432 === MAX_FILE_BYTES`.
 */
const BINARY_READ_BYTES = Math.floor((MAX_FILE_BYTES * 3) / 4);
/** A file larger than this (in bytes) omits its size rather than fail decoding. */
const MAX_REPORTED_SIZE = MAX_FILE_BYTES * 1024;

export interface FilesAuthorityOptions {
	/** Absolute project root for a session; file paths may not escape it. */
	readonly projectRootForSession: (sessionId: SessionId) => Promise<string>;
	readonly maxListEntries?: number;
}

function operationError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

type FileKind = "file" | "directory" | "symlink";

/**
 * Standalone-host file operations for `files.list` and `files.read`. Roots
 * every path at the session's recorded cwd via `projectRootForSession` and
 * contains it by canonical `realpath`, so an in-project symlink that points
 * outside the root cannot list or read beyond it.
 *
 * The desktop bridge forwards these commands to the OMP RPC; this authority
 * gives the T4-owned standalone host (official mode) the same capability so
 * remote clients get the files pane without a bridge runtime.
 */
export class FilesAuthority {
	readonly #projectRootForSession: (sessionId: SessionId) => Promise<string>;
	readonly #maxListEntries: number;

	constructor(options: FilesAuthorityOptions) {
		this.#projectRootForSession = options.projectRootForSession;
		this.#maxListEntries = options.maxListEntries ?? MAX_LIST_ENTRIES;
	}

	async filesList(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		const root = await this.#canonicalRoot(await this.#projectRootForSession(sessionId));
		const rel = typeof args.path === "string" && args.path.length > 0 ? args.path : "";
		const dir = await this.#contained(root, rel);
		const includeHidden = args.includeHidden === true;
		let dirents: Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			throw operationError("NOT_FOUND", "path was not found");
		}
		dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		const entries: Array<{ path: string; kind: FileKind; size?: number }> = [];
		let truncated = false;
		for (const dirent of dirents) {
		if (!includeHidden && dirent.name.startsWith(".")) continue;
			if (entries.length >= this.#maxListEntries) {
				truncated = true;
				break;
			}
			const kind: FileKind = dirent.isSymbolicLink()
				? "symlink"
				: dirent.isDirectory()
					? "directory"
					: "file";
			const entry: { path: string; kind: FileKind; size?: number } = {
				path: rel === "" ? dirent.name : `${rel}/${dirent.name}`,
				kind,
			};
			if (kind === "file") {
				try {
					const info = await stat(join(dir, dirent.name));
					if (info.size <= MAX_REPORTED_SIZE) entry.size = info.size;
				} catch {
					// A file that vanished mid-listing is reported without a size.
				}
			}
			entries.push(entry);
		}
		return { entries, ...(truncated ? { truncated: true } : {}) };
	}

	async filesRead(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		const root = await this.#canonicalRoot(await this.#projectRootForSession(sessionId));
		if (typeof args.path !== "string" || args.path.length === 0)
			throw operationError("INVALID_FRAME", "path is required");
		const target = await this.#contained(root, args.path);
		let info;
		try {
			info = await stat(target);
		} catch {
			throw operationError("NOT_FOUND", "path was not found");
		}
		if (info.isDirectory()) throw operationError("FORBIDDEN", "path is a directory");
		const total = info.size;
		const handle = await open(target, "r");
		try {
			const buffer = Buffer.alloc(MAX_FILE_BYTES);
			const { bytesRead } = await handle.read(buffer, 0, MAX_FILE_BYTES, 0);
			const data = buffer.subarray(0, bytesRead);
			if (data.includes(0)) {
				const payload = data.subarray(0, Math.min(bytesRead, BINARY_READ_BYTES));
				const truncated = total > BINARY_READ_BYTES;
				return {
					content: payload.toString("base64"),
					encoding: "base64",
					...(truncated ? { truncated: true } : {}),
				};
			}
			let text = data.toString("utf8");
			let truncated = bytesRead === MAX_FILE_BYTES && total > MAX_FILE_BYTES;
			// A multibyte sequence split by the read cap decodes to a replacement
			// character whose re-encoded length can exceed the wire limit; trim
			// trailing characters until the UTF-8 byte length fits.
			if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
				while (text.length > 0 && Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) text = text.slice(0, -1);
				truncated = true;
			}
			return { content: text, ...(truncated ? { truncated: true } : {}) };
		} finally {
			await handle.close();
		}
	}

	/**
	 * Working-tree diff for `files.diff` (no turnId): `git diff HEAD` rooted at
	 * the session cwd, optionally narrowed to one relative path. Turn-review
	 * snapshots stay with the bridge authority because this standalone host has
	 * no turn artifact store.
	 */
	async filesDiff(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		if (args.turnId !== undefined)
			throw operationError("UNSUPPORTED", "turn review snapshots require a desktop bridge host");
		const root = await this.#canonicalRoot(await this.#projectRootForSession(sessionId));
		const rel = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
		if (rel !== undefined) await this.#contained(root, rel);
		const argv = ["-C", root, "diff", "HEAD", "--", ...(rel !== undefined ? [rel] : [])];
		let stdout: string;
		try {
			({ stdout } = await execFileAsync("git", argv, {
				maxBuffer: MAX_FILE_BYTES * 2,
				timeout: 15_000,
			}));
		} catch (error) {
			throw operationError("FAILED", `git diff failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		let diff = stdout;
		let truncated = false;
		while (Buffer.byteLength(diff, "utf8") > MAX_FILE_BYTES) {
			diff = diff.slice(0, -1);
			truncated = true;
		}
		return { diff, ...(truncated ? { truncated: true } : {}) };
	}

	operations(): Pick<DesktopOperationsAuthority, "filesList" | "filesRead" | "filesDiff"> {
		return {
			filesList: (args, context) => this.filesList(args, context),
			filesRead: (args, context) => this.filesRead(args, context),
			filesDiff: (args, context) => this.filesDiff(args, context),
		};
	}

	async #canonicalRoot(root: string): Promise<string> {
		try {
			return await realpath(resolve(root));
		} catch {
			throw operationError("NOT_FOUND", "session root was not found");
		}
	}

	/**
	 * Resolve a safe-relative path under the canonical root and contain it by
	 * canonical `realpath`. A lexical check passes for an in-project symlink
	 * that points outside the root; only the resolved path reveals the escape.
	 */
	async #contained(canonicalRoot: string, rel: string): Promise<string> {
		const candidate = join(canonicalRoot, rel);
		let resolved: string;
		try {
			resolved = await realpath(candidate);
		} catch {
			throw operationError("NOT_FOUND", "path was not found");
		}
		const escaped = relative(canonicalRoot, resolved);
		if (escaped.startsWith("..") || isAbsolute(escaped))
			throw operationError("FORBIDDEN", "path escapes the session root");
		return resolved;
	}
}
