import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@t4-code/host-wire";
import { SessionOwnershipStore } from "../src/session-ownership-store.ts";

describe("session ownership store", () => {
	test("persists exact private session and transcript identities", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-owned-sessions-"));
		const ledgerPath = join(root, "profile", "owned-sessions.json");
		const transcriptPath = join(root, "session.jsonl");
		const sid = sessionId("owned-session");
		try {
			const writer = new SessionOwnershipStore(ledgerPath);
			await writer.add(sid, transcriptPath);
			expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600);

			const reader = new SessionOwnershipStore(ledgerPath);
			await reader.load();
			expect(reader.owns(sid, transcriptPath)).toBe(true);
			expect(reader.owns(sid, join(root, "replacement.jsonl"))).toBe(false);

			await reader.delete(sid);
			const reloaded = new SessionOwnershipStore(ledgerPath);
			await reloaded.load();
			expect(reloaded.owns(sid, transcriptPath)).toBe(false);
			expect(JSON.parse(await readFile(ledgerPath, "utf8"))).toEqual({ version: 2, sessions: [] });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("persists terminal transfer state and clears it without losing ownership", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-owned-session-transfer-"));
		const ledgerPath = join(root, "profile", "owned-sessions.json");
		const transcriptPath = join(root, "session.jsonl");
		const sid = sessionId("transferred-session");
		try {
			const writer = new SessionOwnershipStore(ledgerPath);
			await writer.add(sid, transcriptPath);
			await writer.release(sid, transcriptPath);

			const waiting = new SessionOwnershipStore(ledgerPath);
			await waiting.load();
			expect(waiting.owns(sid, transcriptPath)).toBe(true);
			expect(waiting.transfer(sid, transcriptPath)).toBe("waiting");

			await waiting.observeReleasedWriter(sid, transcriptPath);
			const observed = new SessionOwnershipStore(ledgerPath);
			await observed.load();
			expect(observed.transfer(sid, transcriptPath)).toBe("observed");

			await observed.clearTransfer(sid, transcriptPath);
			const reclaimed = new SessionOwnershipStore(ledgerPath);
			await reclaimed.load();
			expect(reclaimed.owns(sid, transcriptPath)).toBe(true);
			expect(reclaimed.transfer(sid, transcriptPath)).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed for malformed or non-private ledgers", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-owned-sessions-invalid-"));
		const ledgerPath = join(root, "owned-sessions.json");
		const sid = sessionId("owned-session");
		const transcriptPath = join(root, "session.jsonl");
		try {
			await writeFile(
				ledgerPath,
				`${JSON.stringify({ version: 1, sessions: [{ sessionId: sid, path: transcriptPath }] })}\n`,
				{ mode: 0o644 },
			);
			const publicLedger = new SessionOwnershipStore(ledgerPath);
			await publicLedger.load();
			expect(publicLedger.owns(sid, transcriptPath)).toBe(false);

			await chmod(ledgerPath, 0o600);
			await writeFile(ledgerPath, "{not-json\n");
			const malformedLedger = new SessionOwnershipStore(ledgerPath);
			await malformedLedger.load();
			expect(malformedLedger.owns(sid, transcriptPath)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
