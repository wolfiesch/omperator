/**
 * T4-owned pseudo-terminal authority.
 *
 * This replaces the OMP fork's `operation.termOpen` bridge method. It is
 * deliberately generic: nothing here reads OMP session state, so the same
 * authority composes onto whichever session authority the host selected.
 *
 * Every primitive below uses a non-obvious mechanism, because the obvious one
 * is wrong on at least one supported platform:
 *
 * - The child gets a CONTROLLING terminal from a `posix_spawn` file action that
 *   OPENS the slave path after `POSIX_SPAWN_SETSID`. Inheriting the slave fd
 *   through `dup2` alone leaves the child with no controlling tty, which
 *   silently disables job control, SIGWINCH, and Ctrl-C.
 * - `ioctl` is variadic. On Apple arm64 its third argument is passed on the
 *   stack, so a fixed-arity `bun:ffi` binding passes garbage while still
 *   reaching the kernel: the window-size ioctl appears to work and delivers
 *   SIGWINCH, but sets a random size. A header-free C shim keeps the variadic
 *   declaration and therefore the correct ABI. The shim needs a linkable libc
 *   at runtime, which a shipped desktop app cannot assume, so it is optional
 *   and `stty` is the fallback.
 * - Reads and writes are gated by `poll` (non-variadic) rather than made
 *   non-blocking through the variadic `fcntl`. `Bun.file(fd).stream()` does not
 *   drive a pty master.
 *
 * All native bindings are created lazily. Importing this module must stay free
 * of side effects: the host-service barrel is loaded by every host process,
 * including bridge mode and platforms with no POSIX pty at all.
 */
import { type Cursor, type HostId, type SessionId, terminalId, type TerminalId } from "@t4-code/host-wire";
import { cc, CString, dlopen, FFIType, ptr } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { closeSync, mkdtempSync, readSync, write, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { DesktopOperationsAuthority, OperationContext } from "./dispatcher.ts";
import { PTY_WINSIZE_SOURCE } from "./pty-winsize-source.ts";

const DARWIN = process.platform === "darwin";
const O_RDWR = 2;
const POLLIN = 0x0001;
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 1_000;
const MAX_ROWS = 500;
/**
 * Bytes read per emitted frame. The wire caps one `terminal.output` at
 * MAX_TERMINAL_OUTPUT_BYTES (256 KB) measured on the decoded string, and an
 * invalid input byte decodes to a 3-byte replacement char, so the read cap
 * stays at or under a third of the wire limit.
 */
const OUTPUT_CHUNK_BYTES = 64 * 1024;
/** Chunks emitted per tick before yielding, so one loud terminal cannot starve the rest. */
const MAX_OUTPUT_CHUNKS_PER_TICK = 8;
/** A single write kept small enough that a POLLOUT-ready tty will not block on it. */
const INPUT_CHUNK_BYTES = 4 * 1024;
/** Backlog ceiling for a child that is not reading its input. */
const MAX_PENDING_INPUT_BYTES = 1024 * 1024;
const PUMP_INTERVAL_MS = 8;
const MAX_TERMINALS = 32;
/** Matches the fork's allowlist: a login shell, never an arbitrary program. */
const ALLOWED_SHELLS: Record<string, true> = { "/bin/sh": true, "/bin/bash": true, "/bin/zsh": true, "/bin/fish": true };

export function operationError(code: string, message: string): Error {
	return Object.assign(new Error(message), { code });
}

interface WinsizeShim {
	t4_set_winsize: (fd: number, request: bigint, rows: number, cols: number) => number;
	t4_get_winsize: (fd: number, request: bigint, out: number) => number;
}

/**
 * Native bindings are built on first construction, never at import time. The
 * host-service barrel is loaded by every host process, including bridge mode
 * and platforms with no POSIX pty, so importing this module must stay free of
 * side effects. Field initializers run only when the class is instantiated.
 */
class PtyBindings {
	readonly util = (() => {
		const spec = {
			openpty: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		};
		if (DARWIN) return dlopen("libSystem.B.dylib", spec);
		try {
			return dlopen("libutil.so.1", spec);
		} catch {
			return dlopen("libc.so.6", spec);
		}
	})();
	readonly libc = dlopen(DARWIN ? "libSystem.B.dylib" : "libc.so.6", {
		posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
		posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
		posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
		posix_spawn_file_actions_init: { args: [FFIType.ptr], returns: FFIType.i32 },
		posix_spawn_file_actions_addopen: {
			args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
			returns: FFIType.i32,
		},
		posix_spawn_file_actions_adddup2: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		posix_spawn_file_actions_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
		posix_spawn: {
			args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		kill: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		// poll is not variadic, unlike ioctl and fcntl, so a direct binding is correct.
		poll: { args: [FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
		strerror: { args: [FFIType.i32], returns: FFIType.cstring },
	});
	readonly winsize = compileWinsizeShim();
	readonly tiocswinsz = DARWIN ? 0x80087467n : 0x5414n;
	readonly tiocgwinsz = DARWIN ? 0x40087468n : 0x5413n;
	readonly setsid = DARWIN ? 0x0400 : 0x0080;
	readonly sttyFlag = DARWIN ? "-f" : "-F";
}

let bindings: PtyBindings | undefined;

function nativeBindings(): PtyBindings {
	if (bindings) return bindings;
	if (process.platform === "win32")
		throw operationError("UNSUPPORTED", "terminals require a POSIX pty; Windows needs a ConPTY backend");
	bindings = new PtyBindings();
	return bindings;
}

function compileWinsizeShim(): WinsizeShim | undefined {
	if (process.env.T4_PTY_FORCE_STTY === "1") return undefined;
	try {
		const sourcePath = join(mkdtempSync(join(tmpdir(), "t4-pty-")), "winsize.c");
		writeFileSync(sourcePath, PTY_WINSIZE_SOURCE, { mode: 0o600 });
		return cc({
			source: sourcePath,
			symbols: {
				t4_set_winsize: { args: ["int", "u64", "u16", "u16"], returns: "int" },
				t4_get_winsize: { args: ["int", "u64", "ptr"], returns: "int" },
			},
		}).symbols as WinsizeShim;
	} catch {
		return undefined;
	}
}

/** Which window-size mechanism this host resolved to. Forces binding setup. */
export function ptyResizeStrategy(): "ioctl" | "stty" {
	return nativeBindings().winsize ? "ioctl" : "stty";
}

function cstring(value: string): Uint8Array {
	const bytes = new Uint8Array(Buffer.byteLength(value) + 1);
	bytes.set(Buffer.from(value));
	return bytes;
}

/** Null-terminated `char *[]`. The backing buffers must outlive the call. */
function cstringArray(values: readonly string[]): { pointers: BigUint64Array; retain: Uint8Array[] } {
	const retain = values.map(cstring);
	const pointers = new BigUint64Array(values.length + 1);
	for (const [index, buffer] of retain.entries()) pointers[index] = BigInt(ptr(buffer));
	pointers[values.length] = 0n;
	return { pointers, retain };
}

function dimension(value: unknown, fallback: number, max: number, label: string): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
		throw operationError("BOUNDS", `invalid terminal ${label}`);
	return value;
}

export interface PtySpawnOptions {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly rows: number;
	readonly cols: number;
}

export interface PtyExit {
	readonly exitCode: number;
	readonly signal?: string;
}

export interface PtyProcess {
	readonly pid: number;
	readonly slavePath: string;
	/** Queues bytes; they are flushed only when the pty reports writable. */
	write(data: string | Uint8Array): void;
	/** Pushes queued input toward the child. Safe to call on every tick. */
	flushInput(): void;
	pendingInputBytes(): number;
	drain(maxBytes?: number): string;
	resize(rows: number, cols: number): void;
	windowSize(): { rows: number; cols: number };
	exited(): PtyExit | undefined;
	kill(signal?: number): void;
	close(): void;
}

/** Spawn a child on a new pty that it owns as its controlling terminal. */
export function spawnPty(options: PtySpawnOptions): PtyProcess {
	const { util, libc, winsize, tiocswinsz, tiocgwinsz, setsid, sttyFlag } = nativeBindings();
	const masterOut = new Int32Array(1);
	const slaveOut = new Int32Array(1);
	const nameOut = new Uint8Array(1024);
	const initial = new Uint16Array([options.rows, options.cols, 0, 0]);
	if (util.symbols.openpty(ptr(masterOut), ptr(slaveOut), ptr(nameOut), null, ptr(initial)) !== 0)
		throw operationError("OPERATION_FAILED", "terminal allocation failed");
	const master = masterOut[0]!;
	const slave = slaveOut[0]!;
	const slavePath = new CString(ptr(nameOut)).toString();

	// macOS makes both spawn types opaque pointers; glibc makes them real
	// structs (posix_spawnattr_t is 336 bytes on x86_64). Over-allocate for both.
	const attr = new Uint8Array(512);
	const actions = new Uint8Array(512);
	const pidOut = new Int32Array(1);
	libc.symbols.posix_spawnattr_init(ptr(attr));
	libc.symbols.posix_spawnattr_setflags(ptr(attr), setsid);
	libc.symbols.posix_spawn_file_actions_init(ptr(actions));
	const slavePathBuffer = cstring(slavePath);
	// This open, not the dup2s, is what makes the pty the controlling terminal.
	libc.symbols.posix_spawn_file_actions_addopen(ptr(actions), 0, ptr(slavePathBuffer), O_RDWR, 0);
	libc.symbols.posix_spawn_file_actions_adddup2(ptr(actions), 0, 1);
	libc.symbols.posix_spawn_file_actions_adddup2(ptr(actions), 0, 2);

	const argv = cstringArray(options.argv);
	const envp = cstringArray(Object.entries(options.env).map(([key, value]) => `${key}=${value}`));
	const executable = cstring(options.argv[0]!);
	const previousCwd = process.cwd();
	let code: number;
	try {
		process.chdir(options.cwd);
		code = libc.symbols.posix_spawn(
			ptr(pidOut),
			ptr(executable),
			ptr(actions),
			ptr(attr),
			ptr(argv.pointers),
			ptr(envp.pointers),
		);
	} finally {
		process.chdir(previousCwd);
		libc.symbols.posix_spawn_file_actions_destroy(ptr(actions));
		libc.symbols.posix_spawnattr_destroy(ptr(attr));
	}
	// Keep the argv/envp buffers alive across the call.
	void argv.retain;
	void envp.retain;
	closeSync(slave);
	if (code !== 0) {
		closeSync(master);
		throw operationError("OPERATION_FAILED", `terminal spawn failed: ${libc.symbols.strerror(code)}`);
	}

	const pid = pidOut[0]!;
	const pollfd = new DataView(new ArrayBuffer(8));
	pollfd.setInt32(0, master, LITTLE_ENDIAN);
	const readBuffer = Buffer.allocUnsafe(OUTPUT_CHUNK_BYTES);
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const pending: Uint8Array[] = [];
	let pendingBytes = 0;
	let writing = false;
	let closePending = false;
	let masterClosed = false;
	let closed = false;
	let exit: PtyExit | undefined;

	const ready = (events: number): boolean => {
		pollfd.setInt16(4, events, LITTLE_ENDIAN);
		pollfd.setInt16(6, 0, LITTLE_ENDIAN);
		if (libc.symbols.poll(ptr(pollfd.buffer as ArrayBuffer), 1, 0) <= 0) return false;
		return (pollfd.getInt16(6, LITTLE_ENDIAN) & events) !== 0;
	};

	/**
	 * The master fd must outlive any dispatched write: `closeSync` frees the
	 * number for reuse immediately, and those bytes would then land in whatever
	 * descriptor next claims it.
	 */
	const closeMaster = (): void => {
		if (masterClosed) return;
		masterClosed = true;
		closeSync(master);
	};

	/**
	 * A canonical-mode tty applies backpressure and `poll` reporting POLLOUT
	 * only promises one writable byte, so a synchronous write can park the host
	 * event loop until the child reads. Writes go through async `fs.write` on
	 * the threadpool instead, one in flight per terminal, the rest queued in
	 * order.
	 *
	 * A blocking write to a full input buffer is the residual risk here, and on
	 * darwin it did not materialize: the tty discards input once the queue is
	 * full rather than parking the writer. Measured on darwin 25.2.0 with Bun
	 * 1.3.14, driving the exact scenario this comment used to claim was fatal.
	 * Eight terminals whose foreground shell was killed while a background job
	 * group kept the slave open each absorbed 1 MiB bursts, left nothing queued,
	 * and moved unrelated async fs latency not at all (0.7ms baseline, 0.1-0.2ms
	 * throughout).
	 *
	 * That result is platform-specific. Linux ttys can block the writer where
	 * BSD-derived ones discard, so a port needs its own measurement before
	 * trusting this. If a stall ever is observed, note that `dup`-ing the master
	 * per write does NOT help: the duplicate keeps the master open, so closing
	 * the original cannot raise hangup. The fix would be a non-blocking owner of
	 * the fd (libuv via `net.Socket({ fd })`, or a guaranteed O_NONBLOCK from a
	 * shipped helper rather than the optional runtime compiler).
	 */
	const flushInput = (): void => {
		if (closed || writing || pending.length === 0) return;
		const head = pending[0]!;
		const slice = head.subarray(0, Math.min(head.byteLength, INPUT_CHUNK_BYTES));
		writing = true;
		write(master, slice, 0, slice.byteLength, null, (error, written) => {
			writing = false;
			if (closePending) {
				closePending = false;
				closeMaster();
				return;
			}
			if (closed) return;
			if (error) {
				pending.length = 0;
				pendingBytes = 0;
				return;
			}
			pendingBytes -= written;
			if (written < head.byteLength) pending[0] = head.subarray(written);
			else pending.shift();
			flushInput();
		});
	};

	return {
		pid,
		slavePath,
		write(data) {
			if (closed) throw operationError("NOT_FOUND", "terminal is closed");
			const payload: Uint8Array = typeof data === "string" ? Buffer.from(data, "utf8") : data;
			if (payload.byteLength === 0) return;
			if (pendingBytes + payload.byteLength > MAX_PENDING_INPUT_BYTES)
				throw operationError("BOUNDS", "terminal input backlog is full");
			pending.push(payload);
			pendingBytes += payload.byteLength;
			flushInput();
		},
		flushInput,
		pendingInputBytes: () => pendingBytes,
		/**
		 * Reads at most `maxBytes` per call. A fast producer can otherwise fill an
		 * unbounded string in one tick, and the wire rejects any single output
		 * frame over MAX_TERMINAL_OUTPUT_BYTES. Capping the READ side keeps
		 * multi-byte characters intact, because the streaming decoder holds
		 * partial sequences until the next call.
		 */
		drain(maxBytes = OUTPUT_CHUNK_BYTES) {
			let output = "";
			let remaining = maxBytes;
			while (!closed && remaining > 0) {
				if (!ready(POLLIN)) break;
				let read = 0;
				try {
					read = readSync(master, readBuffer, 0, Math.min(remaining, readBuffer.length), null);
				} catch {
					break;
				}
				if (read <= 0) break;
				remaining -= read;
				output += decoder.decode(readBuffer.subarray(0, read), { stream: true });
			}
			return output;
		},
		resize(rows, cols) {
			if (winsize) {
				if (winsize.t4_set_winsize(master, tiocswinsz, rows, cols) !== 0)
					throw operationError("OPERATION_FAILED", "terminal resize failed");
				return;
			}
			const result = Bun.spawnSync(["stty", sttyFlag, slavePath, "rows", String(rows), "columns", String(cols)]);
			if (result.exitCode !== 0) throw operationError("OPERATION_FAILED", "terminal resize failed");
		},
		windowSize() {
			if (winsize) {
				const out = new Uint16Array(2);
				if (winsize.t4_get_winsize(master, tiocgwinsz, ptr(out)) !== 0)
					throw operationError("OPERATION_FAILED", "terminal size read failed");
				return { rows: out[0]!, cols: out[1]! };
			}
			const result = Bun.spawnSync(["stty", sttyFlag, slavePath, "size"]);
			const [rows, cols] = result.stdout.toString().trim().split(/\s+/u).map(Number);
			if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols))
				throw operationError("OPERATION_FAILED", "terminal size read failed");
			return { rows: rows!, cols: cols! };
		},
		exited() {
			if (exit) return exit;
			const status = new Int32Array(1);
			// WNOHANG is 1 on both Linux and Darwin.
			if (libc.symbols.waitpid(pid, ptr(status), 1) !== pid) return undefined;
			const raw = status[0]!;
			const signal = raw & 0x7f;
			exit = signal === 0 ? { exitCode: (raw >> 8) & 0xff } : { exitCode: 128 + signal, signal: `SIG${signal}` };
			return exit;
		},
		/**
		 * Signals the shell's process group (`POSIX_SPAWN_SETSID` makes the child a
		 * session and group leader, so its pgid is its pid). A job-control shell
		 * puts background jobs in their OWN groups, so those are not covered here;
		 * they are hung up when the master closes, exactly as in a real terminal.
		 *
		 * Never signal after the child has been reaped. `waitpid` frees the pid for
		 * reuse, so a late `kill` could hit an unrelated process. A dead but
		 * unreaped child still holds its pid, so signalling it stays safe.
		 */
		kill(signal = 9) {
			if (exit) return;
			libc.symbols.kill(-pid, signal);
		},
		close() {
			if (closed) return;
			closed = true;
			pending.length = 0;
			pendingBytes = 0;
			if (!exit) {
				libc.symbols.kill(-pid, 9);
				// SIGKILL cannot be caught or ignored, so a blocking reap of a direct
				// child is bounded. This daemon is long-lived: leaving the child
				// unreaped would accumulate a zombie per closed terminal.
				const status = new Int32Array(1);
				libc.symbols.waitpid(pid, ptr(status), 0);
				exit = { exitCode: 137, signal: "SIGKILL" };
			}
			// A dispatched write still owns this fd; the callback closes it.
			if (writing) closePending = true;
			else closeMaster();
		},
	};
}

interface TerminalRecord {
	readonly process: PtyProcess;
	readonly hostId: HostId;
	readonly sessionId: SessionId;
	readonly terminalId: TerminalId;
	readonly epoch: string;
	readonly pump: ReturnType<typeof setInterval>;
	seq: number;
	closed: boolean;
}

export interface PtyTerminalAuthorityOptions {
	/** Absolute project root for a session; terminals may not escape it. */
	readonly projectRootForSession: (sessionId: SessionId) => Promise<string>;
	readonly defaultShell?: string;
	readonly maxTerminals?: number;
}

/**
 * Owns pty lifecycle for `term.open` and the terminal.* client frames. The
 * dispatcher claims ownership of a terminal id after `termOpen` resolves, so
 * output emitted before that point is buffered by the dispatcher, not here.
 */
export class PtyTerminalAuthority {
	readonly #terminals = new Map<TerminalId, TerminalRecord>();
	readonly #options: Required<PtyTerminalAuthorityOptions>;

	constructor(options: PtyTerminalAuthorityOptions) {
		this.#options = {
			projectRootForSession: options.projectRootForSession,
			defaultShell: options.defaultShell ?? process.env.SHELL ?? "/bin/sh",
			maxTerminals: options.maxTerminals ?? MAX_TERMINALS,
		};
	}

	async termOpen(args: Record<string, unknown>, context: OperationContext): Promise<Record<string, unknown>> {
		const sessionId = context.sessionId;
		if (sessionId === undefined) throw operationError("NOT_FOUND", "session was not found");
		if (this.#terminals.size >= this.#options.maxTerminals) throw operationError("BOUNDS", "terminal limit reached");
		const shell = typeof args.shell === "string" ? args.shell : this.#options.defaultShell;
		if (ALLOWED_SHELLS[shell] !== true) throw operationError("FORBIDDEN", "shell is not allowed");
		const cols = dimension(args.cols, DEFAULT_COLS, MAX_COLS, "columns");
		const rows = dimension(args.rows, DEFAULT_ROWS, MAX_ROWS, "rows");
		const root = await this.#options.projectRootForSession(sessionId);
		const cwd = await this.#resolveCwd(root, args.cwd);

		const id = terminalId(randomUUID());
		const child = spawnPty({ argv: [shell], cwd, env: this.#childEnvironment(args.env, cwd), rows, cols });
		this.#terminals.set(id, {
			process: child,
			hostId: context.hostId,
			sessionId,
			terminalId: id,
			epoch: randomUUID(),
			seq: 0,
			closed: false,
			pump: setInterval(() => this.#pump(id, context), PUMP_INTERVAL_MS),
		});
		return { terminalId: id };
	}

	/**
	 * The wire allows `encoding: "base64"` for input that is not valid UTF-8
	 * (pasted binary, raw key sequences). Writing the base64 text itself would
	 * inject literal characters into the shell.
	 */
	async terminalInput(frame: Record<string, unknown>, _context: OperationContext): Promise<void> {
		const data = typeof frame.data === "string" ? frame.data : "";
		this.#record(frame).process.write(frame.encoding === "base64" ? Buffer.from(data, "base64") : data);
	}

	async terminalResize(frame: Record<string, unknown>, _context: OperationContext): Promise<void> {
		this.#record(frame).process.resize(
			dimension(frame.rows, DEFAULT_ROWS, MAX_ROWS, "rows"),
			dimension(frame.cols, DEFAULT_COLS, MAX_COLS, "columns"),
		);
	}

	async terminalClose(frame: Record<string, unknown>, _context: OperationContext): Promise<void> {
		this.#release(this.#record(frame));
	}

	/** Close every terminal. Used on host shutdown. */
	closeAll(): void {
		for (const record of this.#terminals.values()) this.#release(record);
	}

	operations(): Pick<DesktopOperationsAuthority, "termOpen" | "terminalInput" | "terminalResize" | "terminalClose"> {
		return {
			termOpen: (args, context) => this.termOpen(args, context),
			terminalInput: (frame, context) => this.terminalInput(frame as never, context),
			terminalResize: (frame, context) => this.terminalResize(frame as never, context),
			terminalClose: (frame, context) => this.terminalClose(frame as never, context),
		};
	}

	#record(frame: Record<string, unknown>): TerminalRecord {
		const record = this.#terminals.get(frame.terminalId as TerminalId);
		if (!record || record.closed) throw operationError("NOT_FOUND", "terminal was not found");
		return record;
	}

	/**
	 * Containment must be checked on canonical paths. A lexical `resolve` +
	 * `relative` check passes for an in-project symlink that points outside the
	 * root, which would launch the shell anywhere on disk.
	 */
	async #resolveCwd(root: string, raw: unknown): Promise<string> {
		const canonicalRoot = await realpath(resolve(root));
		if (raw === undefined) return canonicalRoot;
		if (typeof raw !== "string") throw operationError("FORBIDDEN", "terminal cwd is invalid");
		let candidate: string;
		try {
			candidate = await realpath(resolve(canonicalRoot, raw));
		} catch {
			throw operationError("FORBIDDEN", "terminal cwd is invalid");
		}
		const escaped = relative(canonicalRoot, candidate);
		if (escaped.startsWith("..") || isAbsolute(escaped)) throw operationError("FORBIDDEN", "terminal cwd is invalid");
		return candidate;
	}

	/** Never inherit the host environment: it carries broker and provider secrets. */
	#childEnvironment(raw: unknown, cwd: string): Record<string, string> {
		const environment: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: process.env.HOME ?? cwd,
			TERM: "xterm-256color",
			PWD: cwd,
			LANG: process.env.LANG ?? "en_US.UTF-8",
		};
		if (raw && typeof raw === "object" && !Array.isArray(raw))
			for (const [key, value] of Object.entries(raw as Record<string, unknown>))
				if (typeof value === "string") environment[key] = value;
		return environment;
	}

	#cursor(record: TerminalRecord): Cursor {
		record.seq += 1;
		return { epoch: record.epoch, seq: record.seq };
	}

	#emit(record: TerminalRecord, context: OperationContext, frame: Record<string, unknown>): void {
		context.emitTerminalOutput?.({
			v: "omp-app/1",
			hostId: record.hostId,
			sessionId: record.sessionId,
			terminalId: record.terminalId,
			cursor: this.#cursor(record),
			...frame,
		});
	}

	/**
	 * Runs on an interval, so it must never throw: an exception here would
	 * escape into the timer and take down the host.
	 *
	 * Exit is announced only once the pty buffer is empty. A child can write far
	 * more than one chunk and then exit immediately, and closing the master on
	 * the first sight of exit would discard the rest.
	 */
	#pump(id: TerminalId, context: OperationContext): void {
		const record = this.#terminals.get(id);
		if (!record || record.closed) return;
		try {
			record.process.flushInput();
			for (let chunk = 0; chunk < MAX_OUTPUT_CHUNKS_PER_TICK; chunk += 1) {
				const data = record.process.drain(OUTPUT_CHUNK_BYTES);
				if (data.length > 0) {
					this.#emit(record, context, { type: "terminal.output", stream: "stdout", data, encoding: "utf8" });
					continue;
				}
				const exit = record.process.exited();
				if (!exit) return;
				this.#emit(record, context, {
					type: "terminal.exit",
					exitCode: exit.exitCode,
					...(exit.signal ? { signal: exit.signal } : {}),
				});
				this.#release(record);
				return;
			}
			// Chunk budget spent: yield the tick and continue draining on the next.
		} catch {
			// A publish failure must close the terminal, not wedge the interval.
			this.#release(record);
		}
	}

	#release(record: TerminalRecord): void {
		if (record.closed) return;
		record.closed = true;
		clearInterval(record.pump);
		record.process.close();
		this.#terminals.delete(record.terminalId);
	}
}
