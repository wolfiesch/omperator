import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostId, sessionId, type SessionId } from "@t4-code/host-wire";
import { ptyResizeStrategy, PtyTerminalAuthority, spawnPty } from "../src/operations/pty.ts";
import type { OperationContext } from "../src/operations/dispatcher.ts";

const HOST = hostId("pty-host");
const SESSION = sessionId("pty-session");

/**
 * These are integration tests against real OS processes on real pty file
 * descriptors. Output arrives on the kernel's schedule, not the JS event
 * loop's, so fake timers cannot drive them: advancing a virtual clock would
 * never make a child process write. Every wait below polls for the actual
 * signal with a bounded budget rather than sleeping a guessed duration.
 */
function settle(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll a synchronous drain until it yields the expected text or the budget elapses. */
async function drainUntil(read: () => string, match: RegExp, budgetMs = 4_000): Promise<string> {
	let output = "";
	const deadline = Date.now() + budgetMs;
	while (Date.now() < deadline && !match.test(output)) {
		output += read();
		await settle(40);
	}
	return output;
}

function cursorSeq(frame: Record<string, unknown>): number {
	const cursor = frame.cursor;
	if (!cursor || typeof cursor !== "object" || !("seq" in cursor) || typeof cursor.seq !== "number")
		throw new Error("terminal frame is missing a cursor sequence");
	return cursor.seq;
}

/**
 * bash 5.x wraps real lines in bracketed-paste CSI sequences, so assertions
 * compare rendered text rather than raw terminal bytes.
 */
function rendered(frames: Record<string, unknown>[]): string[] {
	return frames
		.filter(frame => frame.type === "terminal.output")
		.map(frame => String(frame.data))
		.join("")
		// eslint-disable-next-line no-control-regex -- stripping real ANSI escapes is the point.
		.replaceAll(/\u001B\[[0-9;?]*[ -/]*[@-~]/gu, "")
		.replaceAll("\r", "")
		.split("\n")
		.map(line => line.trim());
}

function context(root: string, frames: Record<string, unknown>[]): OperationContext {
	return {
		hostId: HOST,
		sessionId: SESSION,
		deviceId: "device",
		connectionId: "connection",
		capabilities: new Set(["term.open"]),
		abortSignal: new AbortController().signal,
		emitTerminalOutput: frame => void frames.push(frame as Record<string, unknown>),
	};
}

async function authorityFixture(): Promise<{
	root: string;
	authority: PtyTerminalAuthority;
	frames: Record<string, unknown>[];
	ctx: OperationContext;
}> {
	const root = await mkdtemp(join(tmpdir(), "t4-pty-authority-"));
	const frames: Record<string, unknown>[] = [];
	const authority = new PtyTerminalAuthority({
		projectRootForSession: async (_id: SessionId) => root,
		defaultShell: "/bin/bash",
	});
	return { root, authority, frames, ctx: context(root, frames) };
}

/**
 * Poll until the frames satisfy the caller's own condition, or the budget
 * elapses.
 *
 * The predicate must be the SAME condition the test then asserts. A looser wait
 * is a race rather than a shortcut: a pty echoes the command line before the
 * shell ever runs it, so waiting on the substring "STREAMED" is satisfied by
 * the echo of `echo STREAMED`, and the assertion then inspects output that has
 * not arrived yet. That reads as a pass on darwin only because the result
 * usually lands in the same drained batch, and fails on Linux where the echo
 * arrives alone.
 */
async function waitForLines(
	frames: Record<string, unknown>[],
	satisfied: (lines: readonly string[]) => boolean,
	budgetMs = 4_000,
): Promise<string[]> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const lines = rendered(frames);
		if (satisfied(lines) || Date.now() >= deadline) return lines;
		await settle(40);
	}
}

describe("spawnPty", () => {
	test("gives the child a controlling terminal with job control", async () => {
		// Assert the contract EXTERNALLY (child is a session leader attached to
		// a real tty) instead of round-tripping a command through the shell —
		// interactive bash startup is unboundedly slow under full-suite load,
		// which made the read-back probe flaky on loaded machines.
		const root = await mkdtemp(join(tmpdir(), "t4-pty-ctty-"));
		const child = spawnPty({
			argv: ["/bin/bash", "-c", "sleep 30"],
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", PS1: "" },
			rows: 24,
			cols: 80,
		});
		try {
			// Give the spawn a moment to exec, then ask the kernel about it.
			await settle(200);
			const stat = execFileSync("ps", ["-o", "tty=,stat=", "-p", String(child.pid)]).toString().trim();
			const [tty, state] = stat.split(/\s+/u);
			expect(tty).not.toBe("??"); // has a controlling tty
			expect(state).toMatch(/^S.*s/u); // S: sleeping, s: session leader
			expect(child.slavePath).toMatch(/^\/dev\//u);
		} finally {
			child.close();
		}
	}, 15_000);

	test("round-trips the window size and signals the child", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-pty-winsize-"));
		const child = spawnPty({
			argv: ["/bin/bash"],
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", PS1: "" },
			rows: 24,
			cols: 80,
		});
		try {
			expect(child.windowSize()).toEqual({ rows: 24, cols: 80 });
			// Register the trap and confirm it is live before resizing, so the
			// SIGWINCH assertion cannot pass or fail on registration timing.
			child.write("trap 'echo WINCH_SEEN' WINCH; echo TRAP_READY\n");
			await drainUntil(() => child.drain(), /TRAP_READY/u);
			child.resize(40, 120);
			expect(child.windowSize()).toEqual({ rows: 40, cols: 120 });
			const output = await drainUntil(() => child.drain(), /WINCH_SEEN/u);
			expect(output).toContain("WINCH_SEEN");
		} finally {
			child.close();
		}
	});
});

describe("PtyTerminalAuthority", () => {
	test("streams output frames with a monotonic cursor and reports exit", async () => {
		const { authority, frames, ctx } = await authorityFixture();
		const opened = await authority.termOpen({ shell: "/bin/bash" }, ctx);
		expect(typeof opened.terminalId).toBe("string");
		const id = opened.terminalId as string;

		await authority.terminalInput({ terminalId: id, data: "echo STREAMED\n" }, ctx);
		const lines = await waitForLines(frames, current => current.includes("STREAMED"));
		expect(lines).toContain("STREAMED");

		const outputs = frames.filter(frame => frame.type === "terminal.output");
		expect(outputs.length).toBeGreaterThan(0);
		for (const frame of outputs) {
			expect(frame.hostId).toBe(HOST);
			expect(frame.sessionId).toBe(SESSION);
			expect(frame.terminalId).toBe(id);
		}
		const seqs = outputs.map(cursorSeq);
		expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
		expect(new Set(seqs).size).toBe(seqs.length);

		await authority.terminalInput({ terminalId: id, data: "exit 3\n" }, ctx);
		const exitDeadline = Date.now() + 5_000;
		while (Date.now() < exitDeadline && !frames.some(frame => frame.type === "terminal.exit")) await settle(50);
		const exit = frames.find(frame => frame.type === "terminal.exit");
		expect(exit).toBeDefined();
		expect(exit?.exitCode).toBe(3);
		authority.closeAll();
	});

	test("decodes base64 terminal input instead of typing the encoding", async () => {
		const { authority, frames, ctx } = await authorityFixture();
		const opened = await authority.termOpen({ shell: "/bin/bash" }, ctx);
		const id = opened.terminalId as string;
		const command = "echo B64_DECODED\n";
		await authority.terminalInput(
			{ terminalId: id, data: Buffer.from(command, "utf8").toString("base64"), encoding: "base64" },
			ctx,
		);
		const lines = await waitForLines(frames, current => current.includes("B64_DECODED"));
		expect(lines).toContain("B64_DECODED");
		// The literal base64 text must never have reached the shell.
		expect(lines.some(line => line.includes("ZWNobyBC"))).toBe(false);
		authority.closeAll();
	});

	test("delivers output larger than one frame before announcing exit", async () => {
		const { authority, frames, ctx } = await authorityFixture();
		const opened = await authority.termOpen({ shell: "/bin/bash" }, ctx);
		const id = opened.terminalId as string;
		const total = 300_000;
		// Writes well past MAX_TERMINAL_OUTPUT_BYTES and exits immediately, so a
		// pump that closed the master on first sight of exit would truncate it.
		await authority.terminalInput(
			{ terminalId: id, data: `echo FILL_BEGIN; head -c ${total} /dev/zero | tr '\\0' 'X'; exit 0\n` },
			ctx,
		);
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && !frames.some(frame => frame.type === "terminal.exit")) await settle(40);

		const exitIndex = frames.findIndex(frame => frame.type === "terminal.exit");
		expect(exitIndex).toBeGreaterThan(-1);
		const outputs = frames.slice(0, exitIndex).filter(frame => frame.type === "terminal.output");
		expect(outputs.length).toBeGreaterThan(1);
		for (const frame of outputs) expect(Buffer.byteLength(String(frame.data), "utf8")).toBeLessThanOrEqual(256_000);
		// The pty echoes the command, and that echo also contains 'X', so count
		// only what follows the last marker: the command's own output.
		const transcript = outputs.map(frame => String(frame.data)).join("");
		const fill = transcript.slice(transcript.lastIndexOf("FILL_BEGIN"));
		expect(fill.match(/X/gu)?.length ?? 0).toBe(total);
		// Nothing may arrive after exit.
		expect(frames.slice(exitIndex + 1)).toHaveLength(0);
		authority.closeAll();
	});

	test("rejects a shell outside the allowlist", async () => {
		const { authority, ctx } = await authorityFixture();
		await expect(authority.termOpen({ shell: "/usr/bin/env" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		authority.closeAll();
	});

	test("refuses a cwd that escapes the project root", async () => {
		const { authority, ctx } = await authorityFixture();
		await expect(authority.termOpen({ cwd: "../escape" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		authority.closeAll();
	});

	test("refuses an in-project symlink that points outside the root", async () => {
		const { root, authority, ctx } = await authorityFixture();
		const outside = await mkdtemp(join(tmpdir(), "t4-pty-outside-"));
		// Lexically "escape-hatch" sits under the root; only realpath reveals it does not.
		await symlink(outside, join(root, "escape-hatch"), "dir");
		await expect(authority.termOpen({ cwd: "escape-hatch" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		authority.closeAll();
	});

	test("starts the child inside a relative cwd under the project root", async () => {
		const { root, authority, frames, ctx } = await authorityFixture();
		await mkdir(join(root, "nested"), { recursive: true });
		const opened = await authority.termOpen({ shell: "/bin/bash", cwd: "nested" }, ctx);
		await authority.terminalInput({ terminalId: opened.terminalId as string, data: "basename $PWD\n" }, ctx);
		const lines = await waitForLines(frames, current => current.includes("nested"));
		expect(lines).toContain("nested");
		authority.closeAll();
	});

	test("does not leak host provider secrets into the child environment", async () => {
		const { authority, frames, ctx } = await authorityFixture();
		process.env.T4_PTY_SECRET_PROBE = "super-secret-value";
		try {
			const opened = await authority.termOpen({ shell: "/bin/bash" }, ctx);
			await authority.terminalInput(
				{ terminalId: opened.terminalId as string, data: "echo probe=[${T4_PTY_SECRET_PROBE:-unset}]\n" },
				ctx,
			);
			const lines = await waitForLines(frames, current =>
				current.some(line => line.includes("probe=[unset]")),
			);
			expect(lines.some(line => line.includes("probe=[unset]"))).toBe(true);
			expect(lines.some(line => line.includes("super-secret-value"))).toBe(false);
		} finally {
			delete process.env.T4_PTY_SECRET_PROBE;
			authority.closeAll();
		}
	});

	test("survives close while a large input write is in flight", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-pty-close-race-"));
		const child = spawnPty({
			argv: ["/bin/bash"],
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", PS1: "" },
			rows: 24,
			cols: 80,
		});
		// Far more than one write chunk, so a write is dispatched and unfinished
		// when close() runs. Closing the fd underneath it would let those bytes
		// land in whatever descriptor next claims the number.
		child.write("#".repeat(512 * 1024) + "\n");
		expect(child.pendingInputBytes()).toBeGreaterThan(0);
		expect(() => child.close()).not.toThrow();
		// Give the in-flight write's callback a chance to run its deferred close.
		await settle(200);
		// A second close must not double-close the descriptor.
		expect(() => child.close()).not.toThrow();
		expect(child.exited()).toMatchObject({ signal: "SIGKILL" });
	});

	test("reaps the child on close and never signals a reaped pid", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-pty-reap-"));
		const child = spawnPty({
			argv: ["/bin/bash"],
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", PS1: "" },
			rows: 24,
			cols: 80,
		});
		const { pid } = child;
		child.close();
		// close() must leave no zombie: the pid is gone, not merely dead.
		expect(child.exited()).toMatchObject({ signal: "SIGKILL" });
		expect(() => process.kill(pid, 0)).toThrow();

		// Once reaped the pid may be recycled, so further signals must be dropped
		// rather than delivered to whatever now owns that pid.
		child.kill(9);
		child.close();
		expect(child.exited()).toMatchObject({ signal: "SIGKILL" });
	});

	test("exits on its own without close() reporting a kill", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-pty-selfexit-"));
		const child = spawnPty({
			argv: ["/bin/bash"],
			cwd: root,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, TERM: "xterm-256color", PS1: "" },
			rows: 24,
			cols: 80,
		});
		try {
			child.write("exit 7\n");
			const deadline = Date.now() + 5_000;
			while (Date.now() < deadline && !child.exited()) await settle(40);
			expect(child.exited()).toEqual({ exitCode: 7 });
		} finally {
			child.close();
		}
	});

	test("rejects input for an unknown or closed terminal", async () => {
		const { authority, ctx } = await authorityFixture();
		const opened = await authority.termOpen({ shell: "/bin/bash" }, ctx);
		const id = opened.terminalId as string;
		await authority.terminalClose({ terminalId: id }, ctx);
		await expect(authority.terminalInput({ terminalId: id, data: "x" }, ctx)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(authority.terminalInput({ terminalId: "missing", data: "x" }, ctx)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		authority.closeAll();
	});

	test("advertises exactly the four terminal lifecycle methods", async () => {
		const { authority } = await authorityFixture();
		expect(Object.keys(authority.operations()).sort()).toEqual([
			"termOpen",
			"terminalClose",
			"terminalInput",
			"terminalResize",
		]);
		expect(["ioctl", "stty"]).toContain(ptyResizeStrategy());
		authority.closeAll();
	});
});
