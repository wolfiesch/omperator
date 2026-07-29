import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OfficialOmpProfileAuthority } from "../src/official-omp-profile-authority.ts";

test("isolated official OMP profile authority persists compatible lifecycle state", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-"));
	const cwd = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	const metadataPath = join(root, "state", "sessions.json");
	await mkdir(cwd);
	const authority = new OfficialOmpProfileAuthority({ sessionsRoot, metadataPath });
	await authority.initialize();
	const created = await authority.create(cwd, "Official session");
	const body = await readFile(created.path, "utf8");
	const newline = body.indexOf("\n");
	expect(Buffer.byteLength(body.slice(0, newline + 1), "utf8")).toBe(256);
	expect(JSON.parse(body.slice(0, newline))).toMatchObject({
		type: "title",
		v: 1,
		title: "Official session",
		source: "user",
	});
	expect(JSON.parse(body.slice(newline + 1))).toMatchObject({
		type: "session",
		version: 3,
		id: created.sessionId,
		cwd: created.cwd,
	});
	const [record] = await authority.list();
	expect(record).toMatchObject({ sessionId: created.sessionId, cwd: created.cwd, title: "Official session" });
	expect(await authority.projectRootForSession(created.sessionId)).toBe(created.cwd);
	expect(await authority.projectRootForProject(record!.projectId)).toBe(created.cwd);

	const archivedAt = "2026-07-21T00:00:00.000Z";
	await authority.archive(record!, archivedAt);
	await authority.close();
	const restarted = new OfficialOmpProfileAuthority({ sessionsRoot, metadataPath });
	await restarted.initialize();
	const [archived] = await restarted.list();
	expect(archived?.archivedAt).toBe(archivedAt);
	await restarted.restore(archived!);

	const artifacts = created.path.slice(0, -".jsonl".length);
	await mkdir(artifacts);
	await writeFile(join(artifacts, "proof.txt"), "owned");
	await restarted.delete({ ...archived!, archivedAt: undefined });
	await expect(stat(created.path)).rejects.toThrow();
	await expect(stat(artifacts)).rejects.toThrow();
	await restarted.close();
});

test("official OMP profile authority rejects a second live owner for the same root", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-owner-"));
	const sessionsRoot = join(root, "sessions");
	const first = new OfficialOmpProfileAuthority({
		sessionsRoot,
		metadataPath: join(root, "state-a", "sessions.json"),
	});
	const second = new OfficialOmpProfileAuthority({
		sessionsRoot,
		metadataPath: join(root, "state-b", "sessions.json"),
	});
	await first.initialize();
	await expect(second.initialize()).rejects.toThrow("live owner");
	await first.close();
	await second.initialize();
	await second.close();
});

test("official OMP profile authority serializes concurrent archive metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-metadata-"));
	const cwd = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	const metadataPath = join(root, "state", "sessions.json");
	await mkdir(cwd);
	const authority = new OfficialOmpProfileAuthority({ sessionsRoot, metadataPath });
	await authority.initialize();
	const first = await authority.create(cwd, "First");
	const second = await authority.create(cwd, "Second");
	const records = await authority.list();
	await Promise.all(
		records.map((record, index) => authority.archive(record, `2026-07-21T00:00:0${index}.000Z`)),
	);
	const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
		archived: Record<string, string>;
	};
	expect(Object.keys(metadata.archived).sort()).toEqual([first.sessionId, second.sessionId].sort());
	await authority.close();
});

test("official OMP delete validates artifact ownership before moving the transcript", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-delete-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	const authority = new OfficialOmpProfileAuthority({
		sessionsRoot: join(root, "sessions"),
		metadataPath: join(root, "state", "sessions.json"),
	});
	await authority.initialize();
	const created = await authority.create(cwd);
	const [record] = await authority.list();
	await writeFile(created.path.slice(0, -".jsonl".length), "not a directory");
	await expect(authority.delete(record!)).rejects.toThrow("artifact root is unsafe");
	expect((await stat(created.path)).isFile()).toBe(true);
	await authority.close();
});

test("official OMP profile authority rejects paths outside its exclusive root", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-boundary-"));
	const cwd = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	await mkdir(cwd);
	const authority = new OfficialOmpProfileAuthority({
		sessionsRoot,
		metadataPath: join(root, "state", "sessions.json"),
	});
	await authority.initialize();
	const created = await authority.create(cwd);
	const [record] = await authority.list();
	const outside = join(root, "outside.jsonl");
	await writeFile(outside, await readFile(created.path));
	await expect(authority.delete({ ...record!, path: outside })).rejects.toThrow("outside");
	expect((await stat(outside)).isFile()).toBe(true);
	await authority.close();
});

test("official OMP profile authority refuses a symlinked session directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-symlink-"));
	const cwd = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	const outside = join(root, "outside");
	await Promise.all([mkdir(cwd), mkdir(sessionsRoot), mkdir(outside)]);
	await symlink(outside, join(sessionsRoot, "-t4"));
	const authority = new OfficialOmpProfileAuthority({
		sessionsRoot,
		metadataPath: join(root, "state", "sessions.json"),
	});
	await authority.initialize();
	await expect(authority.create(cwd)).rejects.toThrow("unsafe");
	expect((await stat(outside)).isDirectory()).toBe(true);
	await authority.close();
});

test("official OMP discovery fails closed on symlinked transcript directories and files", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-official-authority-discovery-"));
	const cwd = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	const outside = join(root, "outside");
	await Promise.all([mkdir(cwd), mkdir(outside)]);
	const authority = new OfficialOmpProfileAuthority({
		sessionsRoot,
		metadataPath: join(root, "state", "sessions.json"),
	});
	await authority.initialize();
	const created = await authority.create(cwd);
	const copied = join(outside, "session-outside.jsonl");
	await writeFile(copied, await readFile(created.path));
	await symlink(outside, join(sessionsRoot, "-outside"));
	await expect(authority.list()).rejects.toThrow("symlink");
	await authority.close();

	const cleanRoot = join(root, "clean-sessions");
	const fileAuthority = new OfficialOmpProfileAuthority({
		sessionsRoot: cleanRoot,
		metadataPath: join(root, "state-file", "sessions.json"),
	});
	await fileAuthority.initialize();
	await mkdir(join(cleanRoot, "-linked"));
	await symlink(copied, join(cleanRoot, "-linked", "session-linked.jsonl"));
	await expect(fileAuthority.list()).rejects.toThrow("symlink");
	await fileAuthority.close();
});
