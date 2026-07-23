import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decodeTranscriptContextResult,
	decodeTranscriptSearchResult,
	entryId,
	projectId,
	sessionId,
} from "@t4-code/host-wire";
import {
	extractSearchableTranscriptFragment,
	TranscriptSearchError,
	TranscriptSearchIndex,
} from "../src/transcript-search-index.ts";
import type { SessionRecord } from "../src/types.ts";

const stamp = "2026-07-18T12:00:00.000Z";

function line(value: Record<string, unknown>): string {
	return `${JSON.stringify(value)}\n`;
}

function message(id: string, role: "user" | "assistant" | "toolResult", text: string): string {
	return line({
		type: "message",
		id,
		parentId: null,
		timestamp: stamp,
		message: { role, content: [{ type: "text", text }] },
	});
}

function record(id: string, path: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
	return {
		sessionId: sessionId(id),
		path,
		cwd: "/private/project",
		projectId: projectId("project-one"),
		projectName: "Project One",
		title: "Search work",
		updatedAt: stamp,
		status: "idle",
		entries: [],
		...overrides,
	};
}

async function fixture(): Promise<{ root: string; transcript: string; index: TranscriptSearchIndex }> {
	const root = await fs.mkdtemp(join(tmpdir(), "omp-transcript-search-"));
	const transcript = join(root, "session.jsonl");
	const index = new TranscriptSearchIndex(join(root, "private", "search.sqlite"));
	await index.initialize();
	return { root, transcript, index };
}

function cursorError(run: () => unknown): TranscriptSearchError {
	try {
		run();
	} catch (error) {
		if (error instanceof TranscriptSearchError) return error;
		throw error;
	}
	throw new Error("Expected transcript search to reject the cursor");
}

function encodeCursor(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("searchable transcript extraction", () => {
	test("keeps visible message text and summaries but excludes hidden and tool content", () => {
		expect(extractSearchableTranscriptFragment(message("u1", "user", "choose the durable cache"))).toMatchObject({
			role: "user",
			text: "choose the durable cache",
		});
		expect(
			extractSearchableTranscriptFragment(
				line({ type: "compaction", id: "c1", timestamp: stamp, summary: "We selected SQLite." }),
			),
		).toMatchObject({ role: "summary", text: "We selected SQLite." });
		expect(extractSearchableTranscriptFragment(message("t1", "toolResult", "secret tool output"))).toBeUndefined();
		expect(
			extractSearchableTranscriptFragment(
				line({ type: "custom_message", id: "x1", display: false, content: "hidden injection" }),
			),
		).toBeUndefined();
		expect(
			extractSearchableTranscriptFragment(
				line({
					type: "message",
					id: "a1",
					timestamp: stamp,
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "private chain" },
							{ type: "toolCall", name: "read", arguments: { path: "/private/secret" } },
							{ type: "text", text: "Public answer" },
						],
					},
				}),
			),
		).toMatchObject({ text: "Public answer" });
	});

	test("redacts absolute paths and credentials using the durable projection sanitizer", () => {
		const fragment = extractSearchableTranscriptFragment(
			message("u1", "user", "open /Users/alice/private.txt token=test-credential"),
		);
		expect(fragment?.text).toContain("[path]");
		expect(fragment?.text).toContain("token=[redacted]");
		expect(fragment?.text).not.toContain("alice");
	});

	test("keeps legacy visible messages and displayed custom messages", () => {
		expect(
			extractSearchableTranscriptFragment(
				line({ type: "message", id: "legacy-user", timestamp: stamp, message: "legacy user decision" }),
			),
		).toMatchObject({ role: "user", text: "legacy user decision" });
		expect(
			extractSearchableTranscriptFragment(
				line({ type: "message", id: "legacy-assistant", timestamp: stamp, text: "legacy assistant answer" }),
			),
		).toMatchObject({ role: "assistant", text: "legacy assistant answer" });
		expect(
			extractSearchableTranscriptFragment(
				line({
					type: "custom_message",
					id: "visible-custom",
					timestamp: stamp,
					display: true,
					attribution: "agent",
					content: "visible custom conclusion",
				}),
			),
		).toMatchObject({ role: "assistant", text: "visible custom conclusion" });
		expect(
			extractSearchableTranscriptFragment(
				line({
					type: "custom_message",
					id: "hidden-custom",
					timestamp: stamp,
					display: false,
					content: "hidden custom instruction",
				}),
			),
		).toBeUndefined();
	});
});

describe("TranscriptSearchIndex", () => {
	test("requires a platform-absolute database path", () => {
		expect(() => new TranscriptSearchIndex("relative/search.sqlite")).toThrow(
			"Transcript search database path must be absolute",
		);
		expect(() => new TranscriptSearchIndex(join(tmpdir(), "omp-absolute-search.sqlite"))).not.toThrow();
	});

	test("rejects symlinked database directories and files before SQLite opens", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "omp-transcript-search-symlink-"));
		try {
			const realDirectory = join(root, "real");
			await fs.mkdir(realDirectory);
			const linkedDirectory = join(root, "linked");
			await fs.symlink(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
			const directoryIndex = new TranscriptSearchIndex(join(linkedDirectory, "search.sqlite"));
			await expect(directoryIndex.initialize()).rejects.toThrow(
				"Transcript search database directory symlink rejected",
			);
			expect(await fs.readdir(realDirectory)).toEqual([]);

			const safeDirectory = join(root, "safe");
			await fs.mkdir(safeDirectory);
			const protectedFile = join(root, "protected.txt");
			await fs.writeFile(protectedFile, "protected");
			const linkedDatabase = join(safeDirectory, "search.sqlite");
			await fs.symlink(protectedFile, linkedDatabase, "file");
			const databaseIndex = new TranscriptSearchIndex(linkedDatabase);
			await expect(databaseIndex.initialize()).rejects.toThrow("Transcript search database symlink rejected");
			expect(await fs.readFile(protectedFile, "utf8")).toBe("protected");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("indexes, filters, paginates, and returns bounded context", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(
				transcript,
				message("u1", "user", "alpha architecture choice") +
					message("a1", "assistant", "alpha uses a local sqlite index") +
					line({
						type: "compaction",
						id: "s1",
						timestamp: "2026-07-18T12:01:00.000Z",
						summary: "alpha decision summary",
					}),
			);
			await index.reconcile([record("session-one", transcript)]);
			const result = index.search({ query: "alpha arch", roles: ["user"], archived: "exclude" });
			expect(decodeTranscriptSearchResult(result)).toEqual(result);
			expect(result.items).toHaveLength(1);
			expect(result.items[0]).toMatchObject({ anchorId: "u1", role: "user", sessionTitle: "Search work" });
			expect(result.items[0]?.highlights.length).toBeGreaterThan(0);
			expect(Buffer.byteLength(result.items[0]?.snippet ?? "")).toBeLessThanOrEqual(768);
			const context = index.context("session-one", { anchorId: entryId("a1"), before: 1, after: 1 });
			expect(decodeTranscriptContextResult(context)).toEqual(context);
			expect(context.rows.map(row => String(row.anchorId))).toEqual(["u1", "a1", "s1"]);
			expect(context.anchorIndex).toBe(1);
			expect(context.hasBefore).toBe(false);
			expect(context.hasAfter).toBe(false);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("appends complete lines and ignores a partial final line until completed", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(transcript, `${message("u1", "user", "first durable thought")}{"type":"message","id":"u2"`);
			await index.reconcile([record("session-one", transcript)]);
			expect(index.search({ query: "durable" }).items.map(item => String(item.anchorId))).toEqual(["u1"]);
			await fs.writeFile(
				transcript,
				`${message("u1", "user", "first durable thought")}${message("u2", "user", "second durable thought")}`,
			);
			await index.reconcile([record("session-one", transcript)]);
			expect(new Set(index.search({ query: "durable" }).items.map(item => String(item.anchorId)))).toEqual(
				new Set(["u1", "u2"]),
			);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("skips an oversized excluded line and continues after an unrelated session failure", async () => {
		const { root, transcript, index } = await fixture();
		try {
			const oversizedToolResult = message("huge-tool", "toolResult", "x".repeat(2 * 1024 * 1024 + 128));
			await fs.writeFile(transcript, oversizedToolResult + message("kept", "assistant", "durable kestrel decision"));
			const status = await index.reconcile([
				record("missing-session", join(root, "missing.jsonl")),
				record("healthy-session", transcript),
			]);
			expect(status.state).toBe("stale");
			expect(index.search({ query: "kestrel" }).items.map(item => String(item.anchorId))).toEqual(["kept"]);
			expect(index.search({ query: "xxxx" }).items).toHaveLength(0);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("binds cursors to one search and invalidates them atomically after index changes", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(
				transcript,
				message("a1", "user", "alpha first beta first") +
					message("a2", "assistant", "alpha second beta second") +
					message("a3", "user", "alpha third beta third"),
			);
			await index.reconcile([record("session-one", transcript)]);
			const first = index.search({ query: "alpha", limit: 1 });
			expect(first.nextCursor).toBeDefined();
			expect(cursorError(() => index.search({ query: "beta", limit: 1, cursor: first.nextCursor })).code).toBe(
				"transcript_cursor_stale",
			);

			for (const malformed of [
				"not-json",
				encodeCursor(null),
				encodeCursor([]),
				encodeCursor({}),
				encodeCursor({ generation: "0", offset: 1, fingerprint: "wrong" }),
				encodeCursor({ generation: 0, offset: -1, fingerprint: "wrong" }),
				encodeCursor({ generation: 0, offset: 1 }),
			]) {
				expect(cursorError(() => index.search({ query: "alpha", limit: 1, cursor: malformed })).code).toBe(
					"transcript_cursor_invalid",
				);
			}

			await fs.appendFile(transcript, message("a4", "assistant", "alpha fourth decision"));
			await index.reconcile([record("session-one", transcript)]);
			expect(cursorError(() => index.search({ query: "alpha", limit: 1, cursor: first.nextCursor })).code).toBe(
				"transcript_cursor_stale",
			);

			index.close();
			const reopened = new TranscriptSearchIndex(join(root, "private", "search.sqlite"));
			await reopened.initialize();
			try {
				expect(
					cursorError(() => reopened.search({ query: "alpha", limit: 1, cursor: first.nextCursor })).code,
				).toBe("transcript_cursor_stale");
			} finally {
				reopened.close();
			}
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("ranks an exact normalized phrase ahead of a generic all-token match", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(
				transcript,
				message("generic", "user", "alpha has several unrelated details before architecture") +
					message("exact", "assistant", "The alpha   architecture is settled."),
			);
			await index.reconcile([record("session-one", transcript)]);
			expect(String(index.search({ query: "alpha architecture" }).items[0]?.anchorId)).toBe("exact");
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("paginates every session-capped result when more than one thousand rows match", async () => {
		const { root, index } = await fixture();
		try {
			const records = await Promise.all(
				Array.from({ length: 334 }, async (_, sessionIndex) => {
					const id = `session-${sessionIndex.toString().padStart(3, "0")}`;
					const path = join(root, `${id}.jsonl`);
					await Bun.write(
						path,
						Array.from({ length: 4 }, (_, entryIndex) =>
							message(`entry-${entryIndex}`, "assistant", "zebra architecture decision"),
						).join(""),
					);
					return record(id, path);
				}),
			);
			await index.reconcile(records);

			const counts = new Map<string, number>();
			let cursor: string | undefined;
			do {
				const page = index.search({ query: "zebra", limit: 50, ...(cursor ? { cursor } : {}) });
				for (const item of page.items) {
					const id = String(item.sessionId);
					counts.set(id, (counts.get(id) ?? 0) + 1);
				}
				cursor = page.nextCursor;
			} while (cursor);

			expect([...counts.values()].reduce((sum, count) => sum + count, 0)).toBe(1_002);
			expect(counts.size).toBe(334);
			expect(new Set(counts.values())).toEqual(new Set([3]));
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rebuilds one session after truncate/rewrite or inode replacement", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(transcript, message("old", "user", "obsolete walrus decision"));
			await index.reconcile([record("session-one", transcript)]);
			await fs.writeFile(transcript, message("new", "assistant", "replacement narwhal decision"));
			await index.reconcile([record("session-one", transcript)]);
			expect(index.search({ query: "walrus" }).items).toHaveLength(0);
			expect(String(index.search({ query: "narwhal" }).items[0]?.anchorId)).toBe("new");

			const swapped = join(root, "swapped.jsonl");
			await fs.writeFile(swapped, message("swap", "user", "injected platypus decision"));
			await fs.rename(swapped, transcript);
			await index.reconcile([record("session-one", transcript)]);
			expect(index.search({ query: "narwhal" }).items).toHaveLength(0);
			expect(String(index.search({ query: "platypus" }).items[0]?.anchorId)).toBe("swap");
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("rebuilds after an early same-inode rewrite followed by an append", async () => {
		const { root, transcript, index } = await fixture();
		try {
			const unchangedTail = message("tool", "toolResult", "z".repeat(6_000));
			await fs.writeFile(transcript, message("old", "user", "walrus decision") + unchangedTail);
			await index.reconcile([record("session-one", transcript)]);
			expect(index.search({ query: "walrus" }).items).toHaveLength(1);

			await fs.writeFile(
				transcript,
				message("new", "user", "badger decision") +
					unchangedTail +
					message("append", "assistant", "platypus follow-up"),
			);
			await index.reconcile([record("session-one", transcript)]);
			expect(index.search({ query: "walrus" }).items).toHaveLength(0);
			expect(index.search({ query: "badger" }).items.map(item => String(item.anchorId))).toEqual(["new"]);
			expect(index.search({ query: "platypus" }).items.map(item => String(item.anchorId))).toEqual(["append"]);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("uses FTS unicode61 case folding for non-ASCII tokens", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(transcript, message("unicode", "user", "İstanbul architecture decision"));
			await index.reconcile([record("session-one", transcript)]);
			const result = index.search({ query: "İstanbul" });
			expect(result.items.map(item => String(item.anchorId))).toEqual(["unicode"]);
			expect(decodeTranscriptSearchResult(result)).toEqual(result);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("removes missing and explicitly deleted sessions and uses private file modes", async () => {
		const { root, transcript, index } = await fixture();
		try {
			await fs.writeFile(transcript, message("u1", "user", "erasable quokka decision"));
			await index.reconcile([record("session-one", transcript, { archivedAt: stamp })]);
			expect(index.search({ query: "quokka", archived: "only" }).items).toHaveLength(1);
			index.deleteSession("session-one");
			expect(index.search({ query: "quokka" }).items).toHaveLength(0);
			await index.reconcile([record("session-one", transcript)]);
			await index.reconcile([]);
			expect(index.search({ query: "quokka" }).items).toHaveLength(0);
			const directoryMode = (await fs.stat(join(root, "private"))).mode & 0o777;
			const databaseMode = (await fs.stat(join(root, "private", "search.sqlite"))).mode & 0o777;
			expect(directoryMode).toBe(0o700);
			expect(databaseMode).toBe(0o600);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("retains sessions omitted from a partial inventory until a complete inventory confirms removal", async () => {
		const { root, transcript, index } = await fixture();
		const omitted = join(root, "omitted.jsonl");
		try {
			await fs.writeFile(transcript, message("kept", "user", "retained koala decision"));
			await fs.writeFile(omitted, message("omitted", "assistant", "protected wombat decision"));
			const keptRecord = record("session-one", transcript);
			const omittedRecord = record("session-two", omitted);
			await index.reconcile([keptRecord, omittedRecord]);

			const partial = await index.reconcile([keptRecord], { pruneMissing: false });
			expect(partial).toMatchObject({ state: "stale", indexedSessions: 2, knownSessions: 2 });
			const partialSearch = index.search({ query: "wombat" });
			expect(partialSearch.items).toHaveLength(1);
			expect(partialSearch.incomplete).toBe(true);

			await index.reconcile([keptRecord]);
			expect(index.search({ query: "wombat" }).items).toHaveLength(0);
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("counts the union of retained and newly discovered sessions in a partial inventory", async () => {
		const { root, transcript, index } = await fixture();
		const retained = join(root, "retained.jsonl");
		const discovered = join(root, "discovered.jsonl");
		try {
			await fs.writeFile(transcript, message("old-one", "user", "first retained session"));
			await fs.writeFile(retained, message("old-two", "assistant", "second retained session"));
			await fs.writeFile(discovered, message("new-one", "assistant", "newly discovered session"));
			await index.reconcile([
				record("session-old-one", transcript),
				record("session-old-two", retained),
			]);

			const partial = await index.reconcile(
				[record("session-new-one", discovered)],
				{ pruneMissing: false },
			);
			expect(partial).toMatchObject({ state: "stale", indexedSessions: 3, knownSessions: 3 });
			expect(index.search({ query: "session" })).toMatchObject({
				incomplete: true,
				index: { indexedSessions: 3, knownSessions: 3 },
			});
		} finally {
			index.close();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
