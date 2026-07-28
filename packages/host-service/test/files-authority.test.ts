import { afterEach, describe, expect, test } from "bun:test";
import { MAX_FILE_BYTES, hostId, sessionId, type SessionId } from "@t4-code/host-wire";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "../src/operations/dispatcher.ts";
import { FilesAuthority } from "../src/operations/files-authority.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}

function context(signal = new AbortController().signal): OperationContext {
	return {
		hostId: hostId("files-host"),
		sessionId: sessionId("files-session"),
		deviceId: "device-1",
		connectionId: "connection-1",
		capabilities: new Set(["files.list", "files.read", "files.diff"]),
		abortSignal: signal,
	};
}

async function initializeGitRepository(root: string): Promise<void> {
	for (const args of [
		["init"],
		["add", "."],
		["-c", "user.name=T4 Test", "-c", "user.email=t4@example.invalid", "commit", "-m", "base"],
	]) {
		const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "ignore", stderr: "pipe" });
		if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
	}
}

function authorityFixture(root: string): { authority: FilesAuthority; ctx: OperationContext } {
	const authority = new FilesAuthority({ projectRootForSession: async (_id: SessionId) => root });
	return { authority, ctx: context() };
}

describe("FilesAuthority filesList", () => {
	test("lists entries relative to the session root, skipping hidden unless asked", async () => {
		const root = await temporaryDirectory("t4-files-list-");
		await mkdir(join(root, "src"));
		await writeFile(join(root, "src", "app.ts"), "export {}\n");
		await writeFile(join(root, "README.md"), "hello\n");
		await writeFile(join(root, ".hidden"), "secret\n");
		const { authority, ctx } = authorityFixture(root);

		const result = await authority.filesList({}, ctx);
		expect(result.entries).toEqual([
			{ path: "README.md", kind: "file", size: 6 },
			{ path: "src", kind: "directory" },
		]);

		const nested = await authority.filesList({ path: "src" }, ctx);
		expect(nested.entries).toEqual([{ path: "src/app.ts", kind: "file", size: 10 }]);

		const withHidden = await authority.filesList({ includeHidden: true }, ctx);
		expect((withHidden.entries as Array<{ path: string }>).map(entry => entry.path)).toEqual([".hidden", "README.md", "src"]);
	});

	test("marks the result truncated at the entry cap", async () => {
		const root = await temporaryDirectory("t4-files-trunc-");
		for (let i = 0; i < 8; i++) await writeFile(join(root, `f${i}.txt`), "x");
		const authority = new FilesAuthority({ projectRootForSession: async () => root, maxListEntries: 4 });
		const result = await authority.filesList({}, context());
		expect(result.entries).toHaveLength(4);
		expect(result.truncated).toBe(true);
	});

	test("rejects a path that escapes the root via an in-root symlink", async () => {
		const root = await temporaryDirectory("t4-files-symlink-");
		const outside = await temporaryDirectory("t4-files-symlink-outside-");
		await writeFile(join(outside, "secret.txt"), "secret\n");
		await symlink(outside, join(root, "escape-hatch"), "dir");
		const { authority, ctx } = authorityFixture(root);
		await expect(authority.filesList({ path: "escape-hatch" }, ctx)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("reports NOT_FOUND for a missing path and a missing session root", async () => {
		const root = await temporaryDirectory("t4-files-missing-");
		const { authority, ctx } = authorityFixture(root);
		await expect(authority.filesList({ path: "nope" }, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			new FilesAuthority({ projectRootForSession: async () => join(root, "missing-root") }).filesList({}, ctx),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("requires a session", async () => {
		const root = await temporaryDirectory("t4-files-nosession-");
		const authority = new FilesAuthority({ projectRootForSession: async () => root });
		const noSession: OperationContext = { ...context(), sessionId: undefined };
		await expect(authority.filesList({}, noSession)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("FilesAuthority filesRead", () => {
	test("reads a text file as utf8 content", async () => {
		const root = await temporaryDirectory("t4-files-read-text-");
		await writeFile(join(root, "note.txt"), "hello world\n");
		const { authority, ctx } = authorityFixture(root);
		const result = await authority.filesRead({ path: "note.txt" }, ctx);
		expect(result.content).toBe("hello world\n");
		expect(result.encoding).toBeUndefined();
		expect(result.truncated).toBeUndefined();
	});

	test("reads a binary file as base64 and marks large files truncated", async () => {
		const root = await temporaryDirectory("t4-files-read-binary-");
		const bytes = Buffer.from([0, 1, 2, 255, 0, 10]);
		await writeFile(join(root, "blob.bin"), bytes);
		const { authority, ctx } = authorityFixture(root);
		const result = await authority.filesRead({ path: "blob.bin" }, ctx);
		expect(result.encoding).toBe("base64");
		expect(result.content).toBe(bytes.toString("base64"));
		expect(Buffer.from(result.content as string, "base64")).toEqual(bytes);
	});

	test("truncates a text file larger than MAX_FILE_BYTES and stays within the wire limit", async () => {
		const root = await temporaryDirectory("t4-files-read-huge-");
		// A repeating multibyte sequence exercises the UTF-8 boundary trim.
		const unit = "Ω".repeat(1024); // 2 bytes per char
		const huge = unit.repeat(Math.ceil((MAX_FILE_BYTES + 4096) / 2048));
		await writeFile(join(root, "huge.txt"), huge);
		const { authority, ctx } = authorityFixture(root);
		const result = await authority.filesRead({ path: "huge.txt" }, ctx);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.content as string, "utf8")).toBeLessThanOrEqual(MAX_FILE_BYTES);
	});

	test("rejects reading a directory and an escaping symlink", async () => {
		const root = await temporaryDirectory("t4-files-read-dirsymlink-");
		const outside = await temporaryDirectory("t4-files-read-outside-");
		await mkdir(join(root, "pkg"));
		await writeFile(join(outside, "secret.txt"), "secret\n");
		await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
		const { authority, ctx } = authorityFixture(root);
		await expect(authority.filesRead({ path: "pkg" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(authority.filesRead({ path: "link.txt" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("reports NOT_FOUND for a missing file", async () => {
		const root = await temporaryDirectory("t4-files-read-missing-");
		const { authority, ctx } = authorityFixture(root);
		await expect(authority.filesRead({ path: "nope.txt" }, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

});

describe("FilesAuthority filesDiff", () => {
	test("returns the working-tree diff and optionally narrows it to one file", async () => {
		const root = await temporaryDirectory("t4-files-diff-");
		await writeFile(join(root, "one.txt"), "before one\n");
		await writeFile(join(root, "two.txt"), "before two\n");
		await initializeGitRepository(root);
		await writeFile(join(root, "one.txt"), "after one\n");
		await writeFile(join(root, "two.txt"), "after two\n");
		const { authority, ctx } = authorityFixture(root);

		const all = await authority.filesDiff({}, ctx);
		expect(all.diff).toContain("one.txt");
		expect(all.diff).toContain("two.txt");

		const narrowed = await authority.filesDiff({ path: "one.txt" }, ctx);
		expect(narrowed.diff).toContain("one.txt");
		expect(narrowed.diff).not.toContain("two.txt");
	});

	test("rejects turn snapshots, escaping paths, and missing sessions", async () => {
		const root = await temporaryDirectory("t4-files-diff-errors-");
		const outside = await temporaryDirectory("t4-files-diff-outside-");
		await writeFile(join(root, "tracked.txt"), "base\n");
		await writeFile(join(outside, "secret.txt"), "secret\n");
		await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
		await initializeGitRepository(root);
		const { authority, ctx } = authorityFixture(root);

		await expect(authority.filesDiff({ turnId: "turn-1" }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(authority.filesDiff({ path: "escape.txt" }, ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(authority.filesDiff({}, { ...ctx, sessionId: undefined })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	test("operations() advertises all standalone file operations", () => {
		const { authority } = authorityFixture("/tmp");
		expect(Object.keys(authority.operations()).sort()).toEqual(["filesDiff", "filesList", "filesRead"]);
	});
});
