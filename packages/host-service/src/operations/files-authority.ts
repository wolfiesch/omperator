import { MAX_FILE_BYTES, type SessionId } from "@t4-code/host-wire";
import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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
		const dir = await this.#openBeneath(root, rel, true);
		const includeHidden = args.includeHidden === true;
		try {
			const dirents: Dirent[] = await readdir(dir.path, { withFileTypes: true });
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
						const child = await this.#openBeneathHandle(dir.handle, dirent.name, false);
						const info = await child.stat();
						await child.close();
						if (info.size <= MAX_REPORTED_SIZE) entry.size = info.size;
					} catch {
						// A file that vanished mid-listing is reported without a size.
					}
				}
				entries.push(entry);
			}
			return { entries, ...(truncated ? { truncated: true } : {}) };
		} catch (error) {
			if ((error as { code?: string }).code === "NOT_FOUND")
				throw operationError("NOT_FOUND", "path was not found");
			throw error;
		} finally {
			await dir.handle.close();
		}
	}

	async filesRead(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		const root = await this.#canonicalRoot(await this.#projectRootForSession(sessionId));
		if (typeof args.path !== "string" || args.path.length === 0)
			throw operationError("INVALID_FRAME", "path is required");
		const target = await this.#openBeneath(root, args.path, false);
		const handle = target.handle;
		try {
			const info = await handle.stat();
			if (info.isDirectory()) throw operationError("FORBIDDEN", "path is a directory");
			const total = info.size;
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
	 * snapshots stay with the bridge authority — this standalone host has no
	 * turn artifact store, so a turnId request is an explicit UNSUPPORTED.
	 */
	async filesDiff(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		if (args.turnId !== undefined)
			throw operationError("UNSUPPORTED", "turn review snapshots require a desktop bridge host");
		const root = await this.#canonicalRoot(await this.#projectRootForSession(sessionId));
		const rel = typeof args.path === "string" && args.path.length > 0 ? args.path : undefined;
		const rootAnchor = await this.#openBeneath(root, "", true);
		if (rel !== undefined) {
			try {
				const target = await this.#openBeneathHandle(rootAnchor.handle, rel, false);
				await target.close();
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "NOT_FOUND") {
					await rootAnchor.handle.close();
					throw error;
				}
				const parts = this.#components(rel);
				const parent = parts.slice(0, -1).join("/");
				if (parent) {
					const parentHandle = await this.#openBeneathHandle(rootAnchor.handle, parent, true);
					await parentHandle.close();
				}
			}
		}
		const pathspec = rel !== undefined ? ["--", rel] : [];
		let statusOutput: string;
		let trackedDiff: string;
		try {
			[{ stdout: statusOutput }, { stdout: trackedDiff }] = await Promise.all([
				execFileAsync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...pathspec], {
					cwd: rootAnchor.path,
					maxBuffer: MAX_FILE_BYTES * 2,
					timeout: 15_000,
				}),
				execFileAsync("git", ["diff", "HEAD", ...pathspec], {
					cwd: rootAnchor.path,
					maxBuffer: MAX_FILE_BYTES * 2,
					timeout: 15_000,
				}),
			]);
		} catch (error) {
			await rootAnchor.handle.close();
			throw operationError("FAILED", `git diff failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		const untracked = statusOutput
			.split("\0")
			.filter(record => record.startsWith("? "))
			.map(record => record.slice(2));
		let diff = trackedDiff;
		for (const path of untracked) {
			const file = await this.#openBeneathHandle(rootAnchor.handle, path, false);
			try {
				const info = await file.stat();
				if (!info.isFile()) continue;
				const cap = Math.max(0, MAX_FILE_BYTES - Buffer.byteLength(diff, "utf8"));
				if (cap === 0) break;
				const buffer = Buffer.alloc(Math.min(cap, Number(info.size), MAX_FILE_BYTES));
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				const bytes = buffer.subarray(0, bytesRead);
				const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
				if (bytes.includes(0)) diff += `${header}Binary files /dev/null and b/${path} differ\n`;
				else {
					const text = bytes.toString("utf8");
					diff += `${header}@@ -0,0 +1,${text.split("\n").length} @@\n${text
						.split("\n")
						.map(line => `+${line}`)
						.join("\n")}\n`;
				}
			} finally {
				await file.close();
			}
		}
		await rootAnchor.handle.close();
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
	 * Traverse from an already-open directory descriptor. Each component is
	 * opened with O_NOFOLLOW; subsequent components are addressed through the
	 * descriptor rather than by reopening the validated pathname.
	 */
	async #openBeneath(
		canonicalRoot: string,
		rel: string,
		directory: boolean,
	): Promise<{ handle: FileHandle; path: string }> {
		const root = await open(
			canonicalRoot,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
		);
		try {
			const handle = await this.#openBeneathHandle(root, rel, directory);
			if (handle !== root) await root.close();
			return { handle, path: this.#descriptorPath(handle.fd) };
		} catch (error) {
			await root.close();
			throw error;
		}
	}

	async #openBeneathHandle(root: FileHandle, rel: string, directory: boolean): Promise<FileHandle> {
		const components = this.#components(rel);
		if (components.length === 0) return root;
		let current = root;
		let ownsCurrent = false;
		try {
			for (let index = 0; index < components.length; index += 1) {
				const final = index === components.length - 1;
				const flags =
					constants.O_RDONLY |
					constants.O_NOFOLLOW |
					(!final || directory ? constants.O_DIRECTORY : 0);
				const next = await open(`${this.#descriptorPath(current.fd)}/${components[index]}`, flags);
				if (ownsCurrent) await current.close();
				current = next;
				ownsCurrent = true;
			}
			return current;
		} catch (error) {
			if (ownsCurrent) await current.close();
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ELOOP" || code === "ENOTDIR")
				throw operationError("FORBIDDEN", "symlinks and non-directories are not permitted in file paths");
			if (code === "ENOENT") throw operationError("NOT_FOUND", "path was not found");
			throw error;
		}
	}

	#components(rel: string): string[] {
		if (isAbsolute(rel) || rel.includes("\\") || rel.includes("\0"))
			throw operationError("FORBIDDEN", "path escapes the session root");
		const components = rel.split("/").filter(Boolean);
		if (components.some(component => component === "." || component === ".."))
			throw operationError("FORBIDDEN", "path escapes the session root");
		return components;
	}

	#descriptorPath(fd: number): string {
		if (process.platform === "linux") return `/proc/self/fd/${fd}`;
		if (process.platform === "darwin") return `/dev/fd/${fd}`;
		throw operationError("UNSUPPORTED", "descriptor-relative file access is unavailable on this platform");
	}
}
