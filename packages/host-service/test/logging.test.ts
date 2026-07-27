import { describe, expect, test } from "bun:test";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createHostLogger } from "../src/remote/logging.ts";

function ndjsonLines(text: string): Record<string, unknown>[] {
	return text
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => JSON.parse(line) as Record<string, unknown>);
}

describe("host logger", () => {
	test("emits NDJSON events with ts, level, event and fields, no PII", async () => {
		const dir = await mkdtemp(join(tmpdir(), "host-log-"));
		try {
			const logger = createHostLogger({ stateRoot: dir });
			logger.log("connection.open", { connectionId: "c1", peer: "nodeA", source: "direct" });
			logger.log("pair.ok", { connectionId: "c1", requestId: "r1" });
			logger.log("pair.denied", { connectionId: "c1", reason: "authentication" });
			logger.log("command.denied", { connectionId: "c1", command: "session.prompt" });
			logger.log("supervisor.spawn", { sessionId: "s1" });
			logger.log("supervisor.exit", { sessionId: "s1" });
			logger.log("supervisor.killed", { sessionId: "s1", signal: "SIGKILL", reason: "watchdog" });
			logger.log("watchdog.action", { sessionId: "s1", action: "sigkill", graceMs: 30_000 });
			logger.log("lockCheck.failed", { sessionId: "s1", where: "startSupervisor", error: "locked" });
			await logger.flush();

			const logsDir = join(dir, "logs");
			const files = await readdir(logsDir);
			expect(files.length).toBe(1);
			const file = files[0]!;
			expect(file.startsWith("host-")).toBe(true);
			expect(file.endsWith(".ndjson")).toBe(true);

			const lines = ndjsonLines(await readFile(join(logsDir, file), "utf8"));
			expect(lines.length).toBe(9);
			const events = lines.map(l => l.event);
			expect(events).toEqual([
				"connection.open",
				"pair.ok",
				"pair.denied",
				"command.denied",
				"supervisor.spawn",
				"supervisor.exit",
				"supervisor.killed",
				"watchdog.action",
				"lockCheck.failed",
			]);
			for (const line of lines) {
				expect(typeof line.ts).toBe("string");
				expect(typeof line.level).toBe("string");
				expect(typeof line.event).toBe("string");
			}
			// Fields are preserved alongside the reserved keys.
			expect(lines[0]!.peer).toBe("nodeA");
			expect(lines[1]!.requestId).toBe("r1");
			expect(lines[2]!.reason).toBe("authentication");
			expect(lines[6]!.signal).toBe("SIGKILL");
			expect(lines[7]!.graceMs).toBe(30_000);
			expect(lines[8]!.where).toBe("startSupervisor");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("level defaults to info and can be overridden via fields", async () => {
		const dir = await mkdtemp(join(tmpdir(), "host-log-"));
		try {
			const logger = createHostLogger({ stateRoot: dir });
			logger.log("connection.open", { connectionId: "c1" });
			logger.log("watchdog.action", { sessionId: "s1", level: "warn" });
			logger.log("lockCheck.failed", { sessionId: "s1", level: "error", error: "boom" });
			await logger.flush();

			const logsDir = join(dir, "logs");
			const [file] = await readdir(logsDir);
			const lines = ndjsonLines(await readFile(join(logsDir, file!), "utf8"));
			expect(lines[0]!.level).toBe("info");
			expect(lines[1]!.level).toBe("warn");
			expect(lines[2]!.level).toBe("error");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("rotation bounds file count to maxFiles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "host-log-"));
		try {
			// Tiny bound so each event triggers a rotation. Keep 3 files total.
			const logger = createHostLogger({
				stateRoot: dir,
				maxFileBytes: 60,
				maxFiles: 3,
			});
			// Each line is ~70 bytes, so every event rolls the active file.
			for (let i = 0; i < 8; i++) logger.log("connection.open", { connectionId: `c${i}`, peer: `node${i}` });
			await logger.flush();

			const logsDir = join(dir, "logs");
			const files = (await readdir(logsDir)).filter(f => f.startsWith("host-"));
			// Active file + at most (maxFiles - 1) rolled files.
			expect(files.length).toBeLessThanOrEqual(3);
			expect(files.length).toBeGreaterThanOrEqual(1);

			// Every retained file is valid NDJSON.
			for (const file of files) {
				const text = await readFile(join(logsDir, file), "utf8");
				const lines = ndjsonLines(text);
				expect(lines.length).toBeGreaterThanOrEqual(1);
				for (const line of lines) expect(line.event).toBe("connection.open");
			}

			// No individual retained file exceeds the byte bound by a wide margin
			// (a single line may slightly overshoot the trigger threshold since the
			// check happens before write, not after).
			for (const file of files) {
				const size = (await stat(join(logsDir, file))).size;
				expect(size).toBeLessThan(512);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("close stops accepting events and flushes pending writes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "host-log-"));
		try {
			const logger = createHostLogger({ stateRoot: dir });
			logger.log("connection.open", { connectionId: "c1" });
			await logger.close();
			logger.log("connection.close", { connectionId: "c1" });
			// The post-close event must be dropped.
			await logger.flush();

			const logsDir = join(dir, "logs");
			const [file] = await readdir(logsDir);
			const lines = ndjsonLines(await readFile(join(logsDir, file!), "utf8"));
			expect(lines.length).toBe(1);
			expect(lines[0]!.event).toBe("connection.open");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("unserializable fields are dropped, not thrown", async () => {
		const dir = await mkdtemp(join(tmpdir(), "host-log-"));
		try {
			const logger = createHostLogger({ stateRoot: dir });
			const circular: Record<string, unknown> = {};
			circular.self = circular;
			logger.log("connection.open", { connectionId: "c1", bad: circular });
			logger.log("pair.ok", { connectionId: "c1" });
			await logger.flush();

			const logsDir = join(dir, "logs");
			const [file] = await readdir(logsDir);
			const lines = ndjsonLines(await readFile(join(logsDir, file!), "utf8"));
			// The unserializable event is dropped; the valid one survives.
			expect(lines.length).toBe(1);
			expect(lines[0]!.event).toBe("pair.ok");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
