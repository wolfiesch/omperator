// The seeder creates real disposable sessions and later deletes files, so the
// contracts pinned here are containment ones: it may only delete what it
// recorded, it must survive a restart through its manifest, and it must never
// write caller-supplied text into a transcript.
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionId } from "@t4-code/host-wire";
import { SeedingTestControl } from "../src/test-control.ts";
import type {
	SessionAuthority,
	SessionAuthoritySession,
	SessionLockStatus,
	SessionRecord,
} from "../src/types.ts";

const STAMP = "2026-07-15T00:00:00.000Z";

class FakeAuthority implements SessionAuthority {
	readonly created: string[] = [];
	readonly deleted: string[] = [];
	#records: SessionRecord[] = [];
	#next = 0;
	#failAfter = Number.POSITIVE_INFINITY;

	constructor(private readonly root: string) {}

	failAfter(count: number): void {
		this.#failAfter = count;
	}

	async create(cwd: string, title = "Session"): Promise<SessionAuthoritySession> {
		if (this.created.length >= this.#failAfter) throw new Error("authority refused");
		this.#next += 1;
		const id = `seeded-${this.#next}`;
		const path = join(this.root, `${id}.jsonl`);
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: STAMP, title })}\n`,
			{ mode: 0o600 },
		);
		this.created.push(path);
		this.#records.push({
			sessionId: sessionId(id),
			path,
			cwd,
			projectId: "project" as SessionRecord["projectId"],
			title,
			updatedAt: STAMP,
			status: "idle",
			entries: [],
		});
		return { sessionId: sessionId(id), path, cwd, title, entries: [] };
	}

	async list(): Promise<SessionRecord[]> {
		return [...this.#records];
	}

	async archive(): Promise<void> {}

	async restore(): Promise<void> {}

	async delete(session: SessionRecord): Promise<void> {
		this.deleted.push(session.path);
		this.#records = this.#records.filter(record => record.sessionId !== session.sessionId);
		await Bun.file(session.path).delete();
	}
}

async function harness(lock: SessionLockStatus = "missing") {
	const root = await mkdtemp(join(tmpdir(), "t4-seeding-control-"));
	const authority = new FakeAuthority(root);
	const control = new SeedingTestControl({
		token: "seeding-control-token-000000000000",
		profile: "disposable",
		manifestPath: join(root, "state", "manifest.json"),
		authority,
		lockStatus: () => lock,
		now: () => new Date(STAMP),
	});
	return { root, authority, control };
}

test("seeds sessions with the requested durable history and reports them indexed", async () => {
	const { root, authority, control } = await harness();

	const status = await control.seed({ runId: "run-a", projectRoot: root, sessionCount: 2, historyEntries: 70 });

	expect(status).toMatchObject({
		v: 1,
		runId: "run-a",
		profile: "disposable",
		state: "seeded",
		sessions: { seeded: 2, indexed: 2 },
		remainingFiles: 2,
		errors: [],
	});
	// 70 durable entries is the point: it clears the 64-entry initial page so
	// the app exposes backward paging at all.
	for (const path of authority.created) {
		const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
		expect(lines).toHaveLength(71);
		expect(JSON.parse(lines[1]!)).toMatchObject({
			type: "message",
			parentId: null,
			message: { role: "user" },
		});
		expect(JSON.parse(lines[2]!)).toMatchObject({ message: { role: "assistant" } });
	}
});

test("seeded transcript text is derived only from the run id and entry index", async () => {
	const { root, authority, control } = await harness();

	await control.seed({ runId: "run-derived", projectRoot: root, sessionCount: 1, historyEntries: 4 });

	const lines = (await readFile(authority.created[0]!, "utf8")).trimEnd().split("\n").slice(1);
	expect(lines.map(line => JSON.parse(line).message.content)).toEqual([
		"seeded run-derived entry 1",
		"seeded run-derived entry 2",
		"seeded run-derived entry 3",
		"seeded run-derived entry 4",
	]);
});

test("cleanup deletes only sessions this control recorded", async () => {
	const { root, authority, control } = await harness();
	await control.seed({ runId: "run-b", projectRoot: root, sessionCount: 1, historyEntries: 1 });
	const foreign = await authority.create(root, "not seeded");

	const status = await control.cleanup("run-b");

	expect(status).toMatchObject({ state: "clean", sessions: { seeded: 0, indexed: 0 }, remainingFiles: 0 });
	expect(authority.deleted).toEqual([authority.created[0]!]);
	expect(await Bun.file(foreign.path).exists()).toBe(true);
	expect(await control.sessionIds("run-b")).toEqual([]);
});

test("a manifest written by an earlier process still bounds cleanup", async () => {
	const { root, authority, control } = await harness();
	await control.seed({ runId: "run-c", projectRoot: root, sessionCount: 1, historyEntries: 1 });
	const manifestPath = join(root, "state", "manifest.json");
	expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);

	const restarted = new SeedingTestControl({
		token: "seeding-control-token-000000000000",
		profile: "disposable",
		manifestPath,
		authority,
		lockStatus: () => "missing",
	});

	expect(await restarted.sessionIds("run-c")).toHaveLength(1);
	await restarted.cleanup("run-c");
	expect(authority.deleted).toEqual([authority.created[0]!]);
});
// The manifest names the only files cleanup is allowed to delete. Failing open
// on a damaged one would let the next seed overwrite it and strand whatever it
// still named, so every state except "absent" must refuse.
test("a damaged manifest is refused rather than silently replaced", async () => {
	const { root, authority, control } = await harness();
	await control.seed({ runId: "run-h", projectRoot: root, sessionCount: 1, historyEntries: 1 });
	const manifestPath = join(root, "state", "manifest.json");
	const original = await readFile(manifestPath, "utf8");
	await writeFile(manifestPath, "{ not json", { mode: 0o600 });

	const restarted = new SeedingTestControl({
		token: "seeding-control-token-000000000000",
		profile: "disposable",
		manifestPath,
		authority,
		lockStatus: () => "missing",
	});

	await expect(
		restarted.seed({ runId: "run-i", projectRoot: root, sessionCount: 1, historyEntries: 1 }),
	).rejects.toBeDefined();
	expect(await readFile(manifestPath, "utf8")).toBe("{ not json");

	await writeFile(manifestPath, original);
	await chmod(manifestPath, 0o644);
	await expect(restarted.sessionIds("run-h")).rejects.toThrow("unsafe");
});

test("a partial seed still records what it created", async () => {
	const { root, authority, control } = await harness();
	authority.failAfter(1);

	await expect(
		control.seed({ runId: "run-d", projectRoot: root, sessionCount: 3, historyEntries: 1 }),
	).rejects.toThrow("authority refused");

	// Without this the first session would be an untracked leftover that
	// cleanup could never reach.
	expect(await control.sessionIds("run-d")).toHaveLength(1);
	await control.cleanup("run-d");
	expect(authority.deleted).toEqual([authority.created[0]!]);
});

test("run ids are rejected when they are reused or unsafe", async () => {
	const { root, control } = await harness();
	await control.seed({ runId: "run-e", projectRoot: root, sessionCount: 1, historyEntries: 0 });

	await expect(
		control.seed({ runId: "run-e", projectRoot: root, sessionCount: 1, historyEntries: 0 }),
	).rejects.toThrow("already seeded");
	await expect(
		control.seed({ runId: "../escape", projectRoot: root, sessionCount: 1, historyEntries: 0 }),
	).rejects.toThrow("invalid");
	await expect(
		control.seed({ runId: "run-f", projectRoot: join(root, "missing"), sessionCount: 1, historyEntries: 0 }),
	).rejects.toThrow("unavailable");
});

test("lock states of seeded sessions are reported", async () => {
	const { root, control } = await harness("live");

	const status = await control.seed({ runId: "run-g", projectRoot: root, sessionCount: 2, historyEntries: 0 });

	expect(status.locks).toEqual({ live: 2, suspect: 0, stale: 0, malformed: 0 });
});
// Two integration runs can hit /admin/test/seed at once. The admin layer tracks
// those mutations but does not order them, so without serialization here both
// calls read the same manifest snapshot and the last write wins, dropping one
// run's records and orphaning the session files it created.
test("concurrent seeds both stay in the manifest", async () => {
	const { root, authority, control } = await harness();

	const [first, second] = await Promise.all([
		control.seed({ runId: "run-parallel-a", projectRoot: root, sessionCount: 1, historyEntries: 1 }),
		control.seed({ runId: "run-parallel-b", projectRoot: root, sessionCount: 1, historyEntries: 1 }),
	]);

	expect(first.sessions.seeded).toBe(1);
	expect(second.sessions.seeded).toBe(1);
	expect(await control.sessionIds("run-parallel-a")).toHaveLength(1);
	expect(await control.sessionIds("run-parallel-b")).toHaveLength(1);

	// Every created file must still be reachable by cleanup.
	await control.cleanup("run-parallel-a");
	await control.cleanup("run-parallel-b");
	expect(authority.deleted.sort()).toEqual([...authority.created].sort());
});
