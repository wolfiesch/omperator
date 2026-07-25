import { describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdtemp, rename, stat, symlink, writeFile } from "node:fs/promises";
import { type Server, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DurableEntry,
	decodeServerFrame,
	entryId,
	hostId,
	parseBounded,
	projectId,
	sessionId,
} from "@t4-code/host-wire";
import { FileSessionDiscovery, projectNameFromCwd, stableProjectId } from "../src/discovery.ts";
import { IdempotencyStore } from "../src/idempotency.ts";
import {
	createEpoch,
	createHostId,
	defaultSocketPath,
	loadPersistentHostId,
	profileSocketPath,
	unixSocketActive,
} from "../src/identity.ts";
import type { RpcSessionEntryFrame } from "../src/omp-rpc-contract.ts";
import { SessionProjection } from "../src/projection.ts";
import { RpcChildSupervisor, resolveRpcChildInvocation } from "../src/rpc-child.ts";
import { createAppserver } from "../src/server.ts";
import type { ChildHandle, FileSystem, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";

function wsFrame(text: string): Uint8Array {
	const payload = new TextEncoder().encode(text);
	const extended = payload.length >= 126;
	const offset = extended ? 8 : 6;
	const frame = new Uint8Array(offset + payload.length);
	frame[0] = 0x81;
	frame[1] = 0x80 | (extended ? 126 : payload.length);
	if (extended) {
		frame[2] = payload.length >> 8;
		frame[3] = payload.length & 0xff;
		frame.set([1, 2, 3, 4], 4);
	} else frame.set([1, 2, 3, 4], 2);
	const maskOffset = extended ? 4 : 2;
	for (let i = 0; i < payload.length; i++) frame[offset + i] = payload[i] ^ frame[maskOffset + (i % 4)];
	return frame;
}
function wsPayload(frame: Buffer): Uint8Array {
	let offset = 2;
	let length = frame[1] & 0x7f;
	if (length === 126) {
		length = (frame[2] << 8) | frame[3];
		offset = 4;
	}
	return frame.slice(offset, offset + length);
}

const host = hostId("hardening-host");
const stamp = "2026-01-01T00:00:00.000Z";
function record(id: string): SessionRecord {
	return {
		sessionId: sessionId(id),
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		projectId: projectId("project-test"),
		title: id,
		updatedAt: stamp,
		status: "idle",
		entries: [],
	};
}
function durable(id: string, session = "s"): DurableEntry {
	return {
		id: entryId(id),
		parentId: null,
		hostId: host,
		sessionId: sessionId(session),
		kind: "message",
		timestamp: stamp,
		data: { message: id },
	};
}
class StaticDiscovery implements SessionDiscovery {
	constructor(private readonly values: SessionRecord[]) {}
	async list() {
		return this.values;
	}
}
class IdleChild implements ChildHandle {
	#queue = Promise.withResolvers<void>();
	stdin = { write: () => undefined };
	stdout: AsyncIterable<string> = this.stream();
	stderr: AsyncIterable<string> = (async function* () {})();
	exited = Promise.resolve(0);
	killed = false;
	async *stream() {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		await this.#queue.promise;
	}
	kill() {
		this.killed = true;
		this.#queue.resolve();
	}
}
class IdleFactory implements RpcChildFactory {
	children: IdleChild[] = [];
	argvCalls: string[][] = [];
	constructor(private readonly executable = "omp") {}
	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }) {
		const child = new IdleChild();
		this.children.push(child);
		this.argvCalls.push(spec.argv);
		return child;
	}
	argv(path: string) {
		return [this.executable, "--mode", "rpc", "--session", path];
	}
}
function fakeFs(files: Record<string, string | Uint8Array>, directories: string[]): FileSystem {
	return {
		mkdir: async () => {},
		chmod: async () => {},
		unlink: async () => {},
		readdir: async path =>
			path === "/root"
				? ["/root/-tmp-project", "/root/current.jsonl", "/root/arbitrary.jsonl", "/root/title-only.jsonl"]
				: [
						"/root/-tmp-project/ok.jsonl",
						"/root/-tmp-project/bad.jsonl",
						"/root/-tmp-project/huge.jsonl",
						"/root/-tmp-project/duplicate.jsonl",
						"/root/-tmp-project/invalid-utf8.jsonl",
					],
		stat: async path => ({
			isFile: () => path in files,
			isDirectory: () => directories.includes(path),
			mode: 0o644,
			mtimeMs: path.endsWith("ok.jsonl") ? 20 : 10,
			size: path.endsWith("huge.jsonl")
				? 70 * 1024 * 1024
				: typeof files[path] === "string"
					? new TextEncoder().encode(files[path]).byteLength
					: (files[path]?.byteLength ?? 0),
		}),
		readFile: async path => files[path] ?? "",
	};
}

const validTranscript = `${JSON.stringify({ type: "session", id: "ok", cwd: "/tmp/project", title: "Good", timestamp: stamp })}\n${JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: stamp, message: "hello" })}\n`;

const currentTranscript = `${JSON.stringify({ type: "title", v: 1, title: "Mutable title" })}\n${JSON.stringify({ type: "session", version: 3, id: "current", timestamp: stamp, cwd: "/tmp/current", title: "Stale title" })}\n${JSON.stringify({ type: "message", id: "entry", parentId: null, timestamp: stamp, message: "hello" })}\n`;

describe("discovery hardening", () => {
	test("lists encoded project-directory mains and sorts newest first", async () => {
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs(
				{
					"/root/-tmp-project/ok.jsonl": validTranscript,
					"/root/-tmp-project/bad.jsonl": "{bad\n",
					"/root/-tmp-project/huge.jsonl": "",
				},
				["/root", "/root/-tmp-project"],
			),
			host,
		);
		const sessions = await discovery.list();
		expect(sessions.map(session => String(session.sessionId))).toEqual(["ok"]);
		expect(sessions[0]?.cwd).toBe("/tmp/project");
	});
	test("discovers current title-prelude format without pseudo-entries", async () => {
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/current.jsonl": currentTranscript }, ["/root"]),
			host,
		);
		const [session] = await discovery.list();
		expect(String(session?.sessionId)).toBe("current");
		expect(session?.cwd).toBe("/tmp/current");
		expect(session?.projectId).toBe(stableProjectId("/tmp/current"));
		expect(session?.title).toBe("Mutable title");
		expect(session?.entries).toHaveLength(1);
		expect(session?.entries[0]?.kind).toBe("message");
	});
	test("rejects arbitrary or missing preludes", async () => {
		const files = {
			"/root/arbitrary.jsonl": `${JSON.stringify({ type: "other", title: "x" })}\n${JSON.stringify({ type: "session", id: "x", cwd: "/tmp", timestamp: stamp })}\n`,
			"/root/title-only.jsonl": `${JSON.stringify({ type: "title", v: 1, title: "x" })}\n`,
		};
		const discovery = new FileSessionDiscovery("/root", fakeFs(files, ["/root"]), host);
		expect(await discovery.list()).toEqual([]);
	});
	test("rejects malformed and primitive transcripts as whole files", async () => {
		const files = {
			"/root/-tmp-project/ok.jsonl": `${JSON.stringify({ type: "session", id: "primitive", cwd: "/tmp" })}\n1\n`,
			"/root/-tmp-project/bad.jsonl": "not-json\n",
		};
		const discovery = new FileSessionDiscovery("/root", fakeFs(files, ["/root", "/root/-tmp-project"]), host);
		expect(await discovery.list()).toEqual([]);
	});
	test("rejects oversized transcript by stat before read allocation", async () => {
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/-tmp-project/huge.jsonl": "" }, ["/root", "/root/-tmp-project"]),
			host,
		);
		expect(await discovery.list()).toEqual([]);
	});
	test("rejects duplicate keys and invalid UTF-8 without partial indexing", async () => {
		const header = `${JSON.stringify({ type: "session", id: "dup", cwd: "/tmp" })}\n`;
		const duplicate = new TextEncoder().encode(
			`${header}{"type":"message","id":"x","parentId":null,"timestamp":"${stamp}","type":"message"}\n`,
		);
		const invalid = new Uint8Array([...new TextEncoder().encode(header), 0xff, 0xfe, 0x0a]);
		const discovery = new FileSessionDiscovery(
			"/root",
			fakeFs({ "/root/-tmp-project/duplicate.jsonl": duplicate, "/root/-tmp-project/invalid-utf8.jsonl": invalid }, [
				"/root",
				"/root/-tmp-project",
			]),
			host,
		);
		expect(await discovery.list()).toEqual([]);
	});
});

describe("identity and socket ownership", () => {
	test("default and named profile socket aliases preserve the public path contract", () => {
		expect(defaultSocketPath("linux", "/home/test", "/run/user/1000")).toBe("/run/user/1000/omp/appserver.sock");
		expect(profileSocketPath(undefined, "linux", "/home/test", "/run/user/1000")).toBe(
			"/run/user/1000/omp/appserver.sock",
		);
		expect(profileSocketPath("default", "darwin", "/Users/test")).toBe("/Users/test/.omp/run/appserver.sock");
		expect(profileSocketPath("alpha", "linux", "/home/test", "/run/user/1000")).toBe(
			"/run/user/1000/omp/appserver-profile-8ed3f6ad685b959ead702251.sock",
		);
		expect(profileSocketPath("alpha", "darwin", "/Users/test")).toBe(
			"/Users/test/.omp/run/appserver-profile-8ed3f6ad685b959ead702251.sock",
		);
	});
	test("host identity persists while epochs are fresh", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-id-"));
		const path = join(root, "host-id");
		const first = await loadPersistentHostId(path);
		const second = await loadPersistentHostId(path);
		expect(first).toBe(second);
		expect(String(createHostId("explicit"))).toBe("explicit");
		expect(createEpoch("explicit-epoch")).toBe("explicit-epoch");
		expect(createEpoch()).not.toBe(createEpoch());
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
	test("two named profiles coexist with isolated persistent host identities", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-profile-appservers-"));
		const runtime = join(root, "runtime");
		const home = join(root, "home");
		const alphaSocket = profileSocketPath("alpha", "linux", home, runtime);
		const betaSocket = profileSocketPath("beta", "linux", home, runtime);
		const alphaIdentity = join(root, "profiles", "alpha", "agent", "appserver", "host-id");
		const betaIdentity = join(root, "profiles", "beta", "agent", "appserver", "host-id");
		const alpha = createAppserver({
			socketPath: alphaSocket,
			hostIdPath: alphaIdentity,
			discovery: new StaticDiscovery([]),
		});
		const beta = createAppserver({
			socketPath: betaSocket,
			hostIdPath: betaIdentity,
			discovery: new StaticDiscovery([]),
		});
		try {
			await Promise.all([alpha.start(), beta.start()]);
			expect(alpha.socketPath).not.toBe(beta.socketPath);
			expect(await unixSocketActive(alphaSocket)).toBe(true);
			expect(await unixSocketActive(betaSocket)).toBe(true);
			expect(alpha.hostId).not.toBe(beta.hostId);
			expect(await loadPersistentHostId(alphaIdentity)).toBe(alpha.hostId);
			expect(await loadPersistentHostId(betaIdentity)).toBe(beta.hostId);
		} finally {
			await Promise.allSettled([alpha.stop(), beta.stop()]);
		}
		expect(await unixSocketActive(alphaSocket)).toBe(false);
		expect(await unixSocketActive(betaSocket)).toBe(false);
	});
	test("refuses regular path and removes stale socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-sock-"));
		const path = join(root, "app.sock");
		await writeFile(path, "regular");
		const regular = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await expect(regular.start()).rejects.toThrow("non-socket");
		await writeFile(path, "");
	});
	test("recovers confirmed-dead owner residue with stale socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-stale-"));
		const path = join(root, "app.sock");
		const ownerId = "11111111-1111-4111-8111-111111111111";
		await writeFile(
			`${path}.owner`,
			JSON.stringify({
				version: 2,
				ownerId,
				pid: 999999,
				backingName: `.appserver-${ownerId}.sock`,
				device: 0,
				inode: 0,
			}),
			{ mode: 0o600 },
		);
		const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await appserver.start();
		await appserver.stop();
		await expect(stat(`${path}.owner`)).rejects.toThrow();
	});
	/**
	 * Stage the on-disk residue of an owner whose recorded identity no longer
	 * describes the files it names, which is what every reboot produces: `st_dev`
	 * is assigned at mount time and inode numbers are recycled. A silent endpoint
	 * is built by renaming the socket out from under its own listener, leaving
	 * exactly the file a crashed owner leaves behind.
	 */
	async function stageStaleOwnerResidue(
		root: string,
		options: { readonly ownerId: string; readonly pid: number; readonly answering: boolean },
	): Promise<{ path: string; listener: Server }> {
		const path = join(root, "app.sock");
		const backingName = `.appserver-${options.ownerId}.sock`;
		const backingPath = join(root, backingName);
		const staged = options.answering ? backingPath : join(root, "staged.sock");
		const listener = createServer();
		await new Promise<void>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(staged, resolve);
		});
		if (!options.answering) {
			await rename(staged, backingPath);
			await new Promise<void>(resolve => listener.close(() => resolve()));
		}
		await symlink(backingName, path);
		const residue = await lstat(backingPath);
		await writeFile(
			`${path}.owner`,
			JSON.stringify({
				version: 2,
				ownerId: options.ownerId,
				pid: options.pid,
				backingName,
				device: Number(residue.dev) + 1,
				inode: Number(residue.ino) + 1,
			}),
			{ mode: 0o600 },
		);
		return { path, listener };
	}
	test("recovers a rebooted owner whose recorded device and inode no longer match", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-reboot-"));
		const { path } = await stageStaleOwnerResidue(root, {
			ownerId: "22222222-2222-4222-8222-222222222222",
			pid: 999999,
			answering: false,
		});
		const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await appserver.start();
		expect(await unixSocketActive(path)).toBe(true);
		await appserver.stop();
		await expect(stat(`${path}.owner`)).rejects.toThrow();
	});
	test("reclaims a reused live pid once the recorded endpoint proves silent", async () => {
		// After a reboot the recorded pid can belong to an unrelated live
		// process, so liveness alone cannot decide. The endpoint has to answer.
		const root = await mkdtemp(join(tmpdir(), "omp-pid-reuse-"));
		const { path } = await stageStaleOwnerResidue(root, {
			ownerId: "33333333-3333-4333-8333-333333333333",
			pid: process.pid,
			answering: false,
		});
		const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await appserver.start();
		expect(await unixSocketActive(path)).toBe(true);
		await appserver.stop();
		await expect(stat(`${path}.owner`)).rejects.toThrow();
	});
	test("refuses a live owner whose endpoint still answers even when its record looks stale", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-live-endpoint-"));
		const { path, listener } = await stageStaleOwnerResidue(root, {
			ownerId: "44444444-4444-4444-8444-444444444444",
			pid: process.pid,
			answering: true,
		});
		const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		try {
			await expect(appserver.start()).rejects.toThrow("another owner");
			expect(await stat(`${path}.owner`)).toBeDefined();
		} finally {
			await new Promise<void>(resolve => listener.close(() => resolve()));
		}
	});
	test("active and concurrent owners are rejected", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-owner-"));
		const path = join(root, "app.sock");
		const first = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		const second = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await first.start();
		expect(await unixSocketActive(path)).toBe(true);
		await expect(second.start()).rejects.toThrow();
		await first.stop();
		expect(await unixSocketActive(path)).toBe(false);
	});
});

describe("project identity projection", () => {
	test("root cwd is serialized as a non-empty project name and empty optional names are omitted", () => {
		const rootRecord: SessionRecord = {
			...record("root-project"),
			cwd: "/",
			projectId: stableProjectId("/"),
			projectName: projectNameFromCwd("/"),
		};
		const rootProjection = new SessionProjection(host, rootRecord, "epoch-root").value;
		const projected = rootProjection.ref;
		expect(projected.project).toEqual({ projectId: stableProjectId("/"), name: "/" });
		const decodedRoot = decodeServerFrame(
			JSON.stringify({
				v: "omp-app/1",
				type: "sessions",
				hostId: host,
				cursor: rootProjection.cursor,
				sessions: [projected],
				totalCount: 1,
				truncated: false,
			}),
		);
		expect(decodedRoot.type).toBe("sessions");
		if (decodedRoot.type === "sessions") expect(decodedRoot.sessions[0]?.project.name).toBe("/");

		const unnamedProjection = new SessionProjection(host, { ...rootRecord, projectName: "" }, "epoch-unnamed").value;
		const unnamed = unnamedProjection.ref;
		expect(Object.hasOwn(unnamed.project, "name")).toBe(false);
		const decodedUnnamed = decodeServerFrame(
			JSON.stringify({
				v: "omp-app/1",
				type: "sessions",
				hostId: host,
				cursor: unnamedProjection.cursor,
				sessions: [unnamed],
				totalCount: 1,
				truncated: false,
			}),
		);
		expect(decodedUnnamed.type).toBe("sessions");
		if (decodedUnnamed.type === "sessions")
			expect(Object.hasOwn(decodedUnnamed.sessions[0]!.project, "name")).toBe(false);
	});
});

describe("projection, replay, and idempotency", () => {
	test("incremental projection preserves entries and deterministic revision", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 3);
		projection.appendEntry(durable("a"));
		projection.appendEntry(durable("b"));
		expect(projection.value.entries.map(entry => String(entry.id))).toEqual(["a", "b"]);
		expect(projection.value.cursor.seq).toBe(2);
	});
	test("keeps attach and gap snapshots within wire limits after live transcript growth", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 3);
		for (let i = 0; i < 1200; i++) {
			projection.appendEntry({
				id: entryId(`live-${i}`),
				parentId: i === 0 ? null : entryId(`live-${i - 1}`),
				hostId: host,
				sessionId: sessionId("s"),
				kind: "message",
				timestamp: stamp,
				data: { role: "assistant", text: `${"x".repeat(4096)} ${i}` },
			});
		}
		projection.appendEntry({
			id: entryId("snapshot-truncation-s"),
			parentId: entryId("live-1199"),
			hostId: host,
			sessionId: sessionId("s"),
			kind: "message",
			timestamp: stamp,
			data: { role: "assistant", text: "latest entry collides with the omission notice base id" },
		});

		expect(projection.value.entries).toHaveLength(1201);
		const snapshots = [
			projection.snapshot(),
			projection.replay({ epoch: "old-epoch", seq: 0 }).at(-1),
			projection.replay({ epoch: "epoch-a", seq: 0 }).at(-1),
		];
		for (const snapshot of snapshots) {
			if (snapshot?.type !== "snapshot") throw new Error("expected bounded snapshot");
			const serialized = JSON.stringify(snapshot);
			expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_048_576);
			expect(() => parseBounded(serialized)).not.toThrow();
			expect(() => decodeServerFrame(serialized)).not.toThrow();
			expect(snapshot.entries.length).toBeLessThanOrEqual(1000);
			expect(snapshot.entries[0]?.kind).toBe("compaction");
			expect(snapshot.entries.at(-1)?.id).toBe(entryId("snapshot-truncation-s"));
			expect(snapshot.entries[0]?.id).not.toBe(snapshot.entries.at(-1)?.id);
			expect(new Set(snapshot.entries.map(entry => entry.id)).size).toBe(snapshot.entries.length);
			const ids = new Set(snapshot.entries.map(entry => entry.id));
			expect(snapshot.entries.every(entry => entry.parentId === null || ids.has(entry.parentId))).toBe(true);
		}

		expect(
			projection.appendEntry({
				id: entryId("live-0"),
				parentId: null,
				hostId: host,
				sessionId: sessionId("s"),
				kind: "message",
				timestamp: stamp,
				data: { role: "assistant", text: `${"x".repeat(4096)} 0` },
			}),
		).toBeUndefined();
	});
	test("status deltas advance the advertised revision exactly once", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 3);
		const before = projection.value.revision;
		const delta = projection.updateStatus("active");
		expect(delta?.type).toBe("session.delta");
		expect(projection.value.revision).not.toBe(before);
		expect(projection.value.ref.revision).toBe(projection.value.revision);
		if (delta?.type === "session.delta") {
			expect(delta.revision).toBe(projection.value.revision);
			expect(delta.upsert?.revision).toBe(projection.value.revision);
			expect(delta.upsert?.status).toBe("active");
		}
		expect(projection.updateStatus("active")).toBeUndefined();
	});
	test("idle and closed status transitions clear projected streaming state", () => {
		for (const status of ["idle", "closed"] as const) {
			const projection = new SessionProjection(host, record(`streaming-${status}`), "epoch-a", 3);
			projection.updateState({
				isStreaming: true,
				isCompacting: false,
				isPaused: false,
				messageCount: 1,
				queuedMessageCount: 0,
				steeringMode: "one-at-a-time",
				followUpMode: "all",
				interruptMode: "wait",
			});
			expect(projection.value.ref).toMatchObject({
				status: "active",
				liveState: { isStreaming: true },
			});

			const delta = projection.updateStatus(status);
			expect(delta).toMatchObject({
				type: "session.delta",
				upsert: { status, liveState: { isStreaming: false } },
			});
			expect(projection.value.ref).toMatchObject({
				status,
				liveState: { isStreaming: false },
			});
		}
	});
	test("closed status settles compacting, queued, and pending state while preserving durable metadata", () => {
		const projection = new SessionProjection(host, record("working-close"), "epoch-a", 3);
		projection.updateState({
			isStreaming: true,
			isCompacting: true,
			isPaused: true,
			messageCount: 7,
			queuedMessageCount: 2,
			queuedMessages: { steering: ["steer"], followUp: ["follow"] },
			steeringMode: "one-at-a-time",
			followUpMode: "all",
			interruptMode: "wait",
			model: { id: "gpt-5.6", provider: "openai-codex", displayName: "GPT 5.6" },
			thinking: "auto",
			thinkingEffective: "medium",
			thinkingResolved: "high",
			thinkingLevels: ["minimal", "low", "medium", "high"],
			thinkingSupported: true,
			thinkingOffFloored: false,
			fast: true,
			fastAvailable: true,
			fastActive: true,
			contextUsage: { used: 12, limit: 100 },
		});
		projection.value.ref = {
			...projection.value.ref,
			pendingApproval: true,
			pendingUserInput: true,
			liveState: {
				...projection.value.ref.liveState,
				pendingApproval: true,
				pendingUserInput: true,
			},
		};

		const delta = projection.updateStatus("closed");
		expect(delta).toMatchObject({
			type: "session.delta",
			upsert: {
				status: "closed",
				model: "openai-codex/gpt-5.6",
				thinking: "auto",
				contextUsage: { used: 12, limit: 100 },
				liveState: {
					isStreaming: false,
					isCompacting: false,
					isPaused: true,
					messageCount: 7,
					queuedMessageCount: 0,
					thinkingEffective: "medium",
					thinkingResolved: "high",
					thinkingLevels: ["minimal", "low", "medium", "high"],
					thinkingSupported: true,
					thinkingOffFloored: false,
					fast: true,
					fastAvailable: true,
					fastActive: true,
				},
			},
		});
		expect(projection.value.ref).not.toHaveProperty("pendingApproval");
		expect(projection.value.ref).not.toHaveProperty("pendingUserInput");
		expect(projection.value.ref.liveState).not.toHaveProperty("queuedMessages");
		expect(projection.value.ref.liveState).not.toHaveProperty("pendingApproval");
		expect(projection.value.ref.liveState).not.toHaveProperty("pendingUserInput");
		expect(projection.updateStatus("closed")).toBeUndefined();
	});
	test("old epoch returns gap and snapshot", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-new", 3);
		projection.appendEvent({ type: "live" });
		const replay = projection.replay({ epoch: "epoch-old", seq: 9 });
		expect(replay.map(frame => frame.type)).toEqual(["gap", "snapshot"]);
		for (const frame of replay) expect(decodeServerFrame(frame)).toBeDefined();
	});
	test("evicted cursor returns gap and snapshot", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 1);
		projection.appendEvent({ type: "one" });
		projection.appendEvent({ type: "two" });
		expect(projection.replay({ epoch: "epoch-a", seq: 0 }).map(frame => frame.type)).toEqual(["gap", "snapshot"]);
	});
	test("oversized contiguous replay falls back to a bounded gap snapshot", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 256);
		for (let i = 0; i < 80; i++) {
			projection.appendEntry({
				id: entryId(`replay-${i}`),
				parentId: i === 0 ? null : entryId(`replay-${i - 1}`),
				hostId: host,
				sessionId: sessionId("s"),
				kind: "message",
				timestamp: stamp,
				data: { role: "assistant", text: "x".repeat(8192) },
			});
		}

		const replay = projection.replay({ epoch: "epoch-a", seq: 0 });
		expect(replay.map(frame => frame.type)).toEqual(["gap", "snapshot"]);
		expect(replay[0]).toMatchObject({ type: "gap", reason: "replay_budget_exceeded" });
		const serialized = JSON.stringify(replay[1]);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_048_576);
		expect(() => decodeServerFrame(serialized)).not.toThrow();
	});
	test("oversized observer append backlog collapses to one bounded snapshot", () => {
		const projection = new SessionProjection(host, record("s"), "epoch-a", 4096);
		const entries = Array.from({ length: 80 }, (_, index) => ({
			id: entryId(`observer-${index}`),
			parentId: index === 0 ? null : entryId(`observer-${index - 1}`),
			hostId: host,
			sessionId: sessionId("s"),
			kind: "message",
			timestamp: stamp,
			data: { role: "assistant", text: "x".repeat(8192) },
		}));

		const frames = projection.rebaseEntries(entries);

		expect(frames.map(frame => frame.type)).toEqual(["gap", "snapshot"]);
		expect(frames[0]).toMatchObject({ type: "gap", reason: "rebase_budget_exceeded" });
		expect(projection.value.entries).toHaveLength(entries.length);
		const serialized = JSON.stringify(frames[1]);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_048_576);
		expect(() => decodeServerFrame(serialized)).not.toThrow();
	});
	test("same command id pending waiters settle once and replay", async () => {
		const store = new IdempotencyStore();
		const id = "same" as never;
		const first = store.begin(id, { requestId: "r1", command: "session.list", args: { a: 1, b: 2 } });
		const second = store.begin(id, { requestId: "r2", args: { b: 2, a: 1 }, command: "session.list" });
		expect(first.kind).toBe("new");
		expect(second.kind).toBe("pending");
		const outcome = { frame: { v: "omp-app/1", type: "error", code: "x", message: "x" } as never };
		store.complete(id, { requestId: "r1", command: "session.list", args: { a: 1, b: 2 } }, outcome);
		expect(await (second.kind === "pending" ? second.outcome : Promise.reject(new Error("not pending")))).toEqual(
			outcome,
		);
		expect(store.begin(id, { requestId: "r3", command: "session.list", args: { a: 1, b: 2 } }).kind).toBe("replay");
	});
	test("same command id conflicting payload is rejected", () => {
		const store = new IdempotencyStore();
		const id = "conflict" as never;
		store.begin(id, { command: "host.list", args: { value: 1 } });
		expect(store.begin(id, { command: "host.list", args: { value: 2 } }).kind).toBe("conflict");
	});
});

describe("child supervision", () => {
	test("reconciles official OMP JSONL and conservatively correlates the durable user entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-official-jsonl-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			[
				JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root }),
				JSON.stringify({
					type: "message",
					id: "existing-user",
					message: { role: "user", content: "before" },
				}),
				JSON.stringify({
					type: "message",
					id: "existing-assistant",
					message: { role: "assistant", content: "done" },
				}),
			].join("\n") + "\n",
		);
		const written = Promise.withResolvers<Record<string, unknown>>();
		const finish = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: data => written.resolve(JSON.parse(data) as Record<string, unknown>) },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				const command = await written.promise;
				await appendFile(
					path,
					`${JSON.stringify({ type: "message", id: "official-user", message: { role: "user", content: command.message } })}\n`,
				);
				yield `${JSON.stringify({ type: "response", id: command.id, command: "prompt", success: true })}\n`;
				await appendFile(
					path,
					`${JSON.stringify({ type: "message", id: "official-assistant", message: { role: "assistant", content: "after" } })}\n`,
				);
				yield `${JSON.stringify({ type: "message_end", message: { role: "assistant" } })}\n`;
				await finish.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				finish.resolve();
				exited.resolve(0);
			},
		};
		const session = { ...record("official-jsonl"), path, cwd: root };
		const entries: Array<Record<string, unknown>> = [];
		const reconciled = Promise.withResolvers<void>();
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			session,
			{
				entry: frame => {
					entries.push(frame.entry as Record<string, unknown>);
					if (entries.length === 2) reconciled.resolve();
				},
				event: () => {},
				crashed: error => reconciled.reject(error),
			},
		);
		await supervisor.start();
		expect(supervisor.loadedWatermark()).toEqual({
			lastEntryId: "existing-assistant",
			entryCount: 2,
		});
		await supervisor.prompt("outer", "after");
		await reconciled.promise;
		expect(entries).toEqual([
			{
				type: "message",
				id: "official-user",
				message: { role: "user", content: "after", clientCorrelationId: "outer:1" },
			},
			{
				type: "message",
				id: "official-assistant",
				message: { role: "assistant", content: "after" },
			},
		]);
		expect(supervisor.loadedWatermark()).toEqual({
			lastEntryId: "official-assistant",
			entryCount: 4,
		});
		supervisor.stop();
	});

	test("discards local-only prompt correlation before the next durable user entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-official-local-prompt-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const firstWrite = Promise.withResolvers<Record<string, unknown>>();
		const secondWrite = Promise.withResolvers<Record<string, unknown>>();
		let writes = 0;
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: {
				write: data => {
					writes += 1;
					(writes === 1 ? firstWrite : secondWrite).resolve(JSON.parse(data) as Record<string, unknown>);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				const local = await firstWrite.promise;
				yield `${JSON.stringify({
					type: "response",
					id: local.id,
					command: "prompt",
					success: true,
					data: { agentInvoked: false },
				})}\n`;
				const durable = await secondWrite.promise;
				await appendFile(
					path,
					`${JSON.stringify({ type: "message", id: "durable-user", message: { role: "user", content: durable.message } })}\n`,
				);
				yield `${JSON.stringify({
					type: "response",
					id: durable.id,
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				})}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const entries: Array<Record<string, unknown>> = [];
		const reconciled = Promise.withResolvers<void>();
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			{ ...record("official-local-prompt"), path, cwd: root },
			{
				entry: frame => {
					entries.push(frame.entry as Record<string, unknown>);
					reconciled.resolve();
				},
				event: () => {},
				crashed: error => { throw error; },
			},
		);
		await supervisor.start();
		await supervisor.prompt("local", "/local-only");
		await supervisor.prompt("durable", "real prompt");
		await reconciled.promise;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			id: "durable-user",
			message: { role: "user", content: "real prompt", clientCorrelationId: "durable:2" },
		});
		supervisor.stop();
	});

	test("deduplicates a fork live entry against the same durable JSONL entry", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-fork-jsonl-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const entry = {
			type: "message",
			id: "shared-entry",
			message: { role: "assistant", content: "once" },
		};
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready", transcriptWatermark: { lastEntryId: null, entryCount: 0 } })}\n`;
				await appendFile(path, `${JSON.stringify(entry)}\n`);
				yield `${JSON.stringify({ type: "session_entry", entry })}\n`;
				yield `${JSON.stringify({ type: "message_end", message: { role: "assistant" } })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const entries: unknown[] = [];
		const seen = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			{ ...record("fork-jsonl"), path, cwd: root },
			{
				entry: frame => {
					entries.push(frame.entry);
					seen.resolve();
				},
				event: frame => {
					if (frame.type === "message_end") settled.resolve();
				},
				crashed: seen.reject,
			},
		);
		await supervisor.start();
		await seen.promise;
		await settled.promise;
		expect(entries).toEqual([entry]);
		expect(supervisor.loadedWatermark()).toEqual({ lastEntryId: "shared-entry", entryCount: 1 });
		supervisor.stop();
	});

	test("waits for a crash-truncated JSONL record to become durable", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-partial-jsonl-"));
		const path = join(root, "session.jsonl");
		const partial = JSON.stringify({
			type: "message",
			id: "completed-later",
			message: { role: "assistant", content: "complete" },
		});
		const split = Math.floor(partial.length / 2);
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n${partial.slice(0, split)}`,
		);
		const complete = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await complete.promise;
				yield `${JSON.stringify({ type: "message_end", message: { role: "assistant" } })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const seen = Promise.withResolvers<RpcSessionEntryFrame>();
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			{ ...record("partial-jsonl"), path, cwd: root },
			{ entry: seen.resolve, event: () => {}, crashed: seen.reject },
		);
		await supervisor.start();
		expect(supervisor.loadedWatermark()).toEqual({ lastEntryId: null, entryCount: 0 });
		await appendFile(path, `${partial.slice(split)}\n`);
		complete.resolve();
		expect((await seen.promise).entry).toEqual(JSON.parse(partial));
		expect(supervisor.loadedWatermark()).toEqual({ lastEntryId: "completed-later", entryCount: 1 });
		supervisor.stop();
	});

	test("skips an oversized live JSONL record and resumes reconciliation", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-oversized-live-jsonl-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const append = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await append.promise;
				yield `${JSON.stringify({ type: "message_end", message: { role: "assistant" } })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const entry = Promise.withResolvers<RpcSessionEntryFrame>();
		const omittedOffsets: number[] = [];
		const crashed: Error[] = [];
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			{ ...record("oversized-live-jsonl"), path, cwd: root },
			{
				entry: entry.resolve,
				event: () => {},
				transcriptRecordOmitted: offset => omittedOffsets.push(offset),
				crashed: error => crashed.push(error),
			},
		);

		await supervisor.start();
		const oversizedOffset = (await stat(path)).size;
		await appendFile(path, `${"x".repeat(10 * 1024 * 1024 + 1024)}\n`);
		await appendFile(
			path,
			`${JSON.stringify({
				type: "message",
				id: "after-oversized",
				message: { role: "assistant", content: "still live" },
			})}\n`,
		);
		append.resolve();

		expect((await entry.promise).entry).toMatchObject({
			id: "after-oversized",
			message: { role: "assistant", content: "still live" },
		});
		expect(omittedOffsets).toEqual([oversizedOffset]);
		expect(crashed).toEqual([]);
		expect(supervisor.loadedWatermark()).toEqual({ lastEntryId: "after-oversized", entryCount: 1 });
		supervisor.stop();
	});

	test("invalidates stale prompt correlations after an oversized JSONL record", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-oversized-correlation-jsonl-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const firstCommand = Promise.withResolvers<Record<string, unknown>>();
		const secondCommand = Promise.withResolvers<Record<string, unknown>>();
		const firstReconcile = Promise.withResolvers<void>();
		const secondReconcile = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		let writes = 0;
		const child: ChildHandle = {
			stdin: {
				write: line => {
					const command = JSON.parse(String(line)) as Record<string, unknown>;
					const target = writes === 0 ? firstCommand : secondCommand;
					writes += 1;
					target.resolve(command);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				const first = await firstCommand.promise;
				yield `${JSON.stringify({
					type: "response",
					id: first.id,
					command: first.type,
					success: true,
				})}\n`;
				await firstReconcile.promise;
				yield `${JSON.stringify({ type: "notice", message: "first reconciliation" })}\n`;
				const second = await secondCommand.promise;
				yield `${JSON.stringify({
					type: "response",
					id: second.id,
					command: second.type,
					success: true,
				})}\n`;
				await secondReconcile.promise;
				yield `${JSON.stringify({ type: "notice", message: "second reconciliation" })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const omitted = Promise.withResolvers<number>();
		const entry = Promise.withResolvers<RpcSessionEntryFrame>();
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath] },
			{ ...record("oversized-correlation-jsonl"), path, cwd: root },
			{
				entry: entry.resolve,
				event: () => {},
				transcriptRecordOmitted: omitted.resolve,
				crashed: error => expect.unreachable(error.message),
			},
		);

		await supervisor.start();
		await supervisor.call({ type: "prompt", message: "omitted prompt" }, "omitted-prompt");
		await appendFile(
			path,
			`${JSON.stringify({
				type: "message",
				id: "oversized-user",
				message: { role: "user", content: "x".repeat(10 * 1024 * 1024 + 1024) },
			})}\n`,
		);
		firstReconcile.resolve();
		await omitted.promise;

		const second = supervisor.call({ type: "prompt", message: "visible prompt" }, "visible-prompt");
		const secondInternalId = String((await secondCommand.promise).id);
		await second;
		await appendFile(
			path,
			`${JSON.stringify({
				type: "message",
				id: "visible-user",
				message: { role: "user", content: "visible prompt" },
			})}\n`,
		);
		secondReconcile.resolve();
		expect((await entry.promise).entry).toMatchObject({
			id: "visible-user",
			message: { role: "user", content: "visible prompt", clientCorrelationId: secondInternalId },
		});
		supervisor.stop();
		await child.exited;
	});
	test("scans and projects large 2 MiB transcript records without omitting them", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-large-transcript-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const firstCommand = Promise.withResolvers<Record<string, unknown>>();
		const firstReconcile = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: {
				write: line => {
					const command = JSON.parse(String(line)) as Record<string, unknown>;
					firstCommand.resolve(command);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				const cmd = await firstCommand.promise;
				yield `${JSON.stringify({
					type: "response",
					id: cmd.id,
					command: cmd.type,
					success: true,
				})}\n`;
				await firstReconcile.promise;
				yield `${JSON.stringify({ type: "notice", message: "reconciled" })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const entry = Promise.withResolvers<RpcSessionEntryFrame>();
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath] },
			{ ...record("large-transcript-jsonl"), path, cwd: root },
			{
				entry: entry.resolve,
				event: () => {},
				transcriptRecordOmitted: () => expect.unreachable("large valid transcript record should not be omitted"),
				crashed: error => expect.unreachable(error.message),
			},
		);

		await supervisor.start();
		const promptCall = supervisor.call({ type: "prompt", message: "large prompt" }, "large-prompt");
		await appendFile(
			path,
			`${JSON.stringify({
				type: "message",
				id: "large-user",
				message: { role: "user", content: "x".repeat(2 * 1024 * 1024) },
			})}\n`,
		);
		firstReconcile.resolve();
		await promptCall;

		const projected = await entry.promise;
		expect(projected.entry).toMatchObject({
			id: "large-user",
			message: { role: "user" },
		});
		expect(((projected.entry as Record<string, unknown>).message as Record<string, unknown>).content).toHaveLength(
			2 * 1024 * 1024,
		);
		supervisor.stop();
		await child.exited;
	});

	test("negotiates RPC v2 and reassembles exact-boundary and oversized responses losslessly", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-rpc-v2-"));
		const path = join(root, "session.jsonl");
		await writeFile(
			path,
			`${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: stamp, cwd: root })}\n`,
		);
		const negotiate = Promise.withResolvers<Record<string, unknown>>();
		const exactBoundaryRequest = Promise.withResolvers<Record<string, unknown>>();
		const oversizedRequest = Promise.withResolvers<Record<string, unknown>>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		let requestCount = 0;
		const oversizedPayload = "😀".repeat(400_000);
		const child: ChildHandle = {
			stdin: {
				write: line => {
					const command = JSON.parse(String(line)) as Record<string, unknown>;
					if (command.type === "negotiate_protocol") negotiate.resolve(command);
					else if (requestCount++ === 0) exactBoundaryRequest.resolve(command);
					else oversizedRequest.resolve(command);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				})}\n`;
				const negotiation = await negotiate.promise;
				yield `${JSON.stringify({
					type: "response",
					id: negotiation.id,
					command: "negotiate_protocol",
					success: true,
					data: { protocolVersion: 2 },
				})}\n`;
				for (let responseIndex = 0; responseIndex < 2; responseIndex++) {
					const command = await (responseIndex === 0
						? exactBoundaryRequest.promise
						: oversizedRequest.promise);
					const payload = responseIndex === 0 ? undefined : oversizedPayload;
					const chunkId = responseIndex === 0 ? "response-boundary" : "response-oversized";
					const response = {
						type: "response",
						id: command.id,
						command: command.type,
						success: true,
						data: { payload: payload ?? "" },
					};
					if (payload === undefined) {
						const emptyBytes = Buffer.byteLength(JSON.stringify(response), "utf8");
						response.data.payload = "x".repeat(1024 * 1024 - emptyBytes);
					}
					const logical = Buffer.from(JSON.stringify(response), "utf8");
					if (payload === undefined) expect(logical.byteLength).toBe(1024 * 1024);
					const chunkBytes = 256 * 1024;
					const count = Math.ceil(logical.byteLength / chunkBytes);
					const frames: string[] = [];
					for (let index = 0; index < count; index++) {
						frames.push(`${JSON.stringify({
							type: "rpc_chunk",
							chunkId,
							index,
							count,
							byteLength: logical.byteLength,
							data: logical.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
						})}\n`);
					}
					yield frames.join("");
				}
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => child,
				argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath],
			},
			{ ...record("rpc-v2"), path, cwd: root },
			{ entry: () => {}, event: () => {}, crashed: error => expect.unreachable(error.message) },
		);

		await supervisor.start();
		expect(await negotiate.promise).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
		const exactBoundary = await supervisor.call({ type: "get_state" }, "boundary-response");
		expect(exactBoundary).toMatchObject({ success: true });
		expect(Buffer.byteLength(JSON.stringify(exactBoundary), "utf8")).toBe(1024 * 1024);
		const oversized = await supervisor.call({ type: "get_messages" }, "large-response");
		expect(oversized).toMatchObject({ success: true, data: { payload: oversizedPayload } });
		supervisor.stop();
	});

	test("keeps the legacy v1 path when ready does not advertise protocol v2", async () => {
		const request = Promise.withResolvers<Record<string, unknown>>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const commands: Record<string, unknown>[] = [];
		const child: ChildHandle = {
			stdin: {
				write: line => {
					const command = JSON.parse(String(line)) as Record<string, unknown>;
					commands.push(command);
					request.resolve(command);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready", protocolVersion: 1 })}\n`;
				const command = await request.promise;
				yield `${JSON.stringify({
					type: "response",
					id: command.id,
					command: command.type,
					success: true,
					data: { legacy: true },
				})}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath] },
			record("rpc-v1"),
			{ entry: () => {}, event: () => {}, crashed: error => expect.unreachable(error.message) },
		);

		await supervisor.start();
		expect(await supervisor.call({ type: "get_state" }, "legacy-response")).toMatchObject({
			success: true,
			data: { legacy: true },
		});
		expect(commands.map(command => command.type)).toEqual(["get_state"]);
		supervisor.stop();
	});

	test("bounds protocol v2 negotiation during startup", async () => {
		const negotiation = Promise.withResolvers<Record<string, unknown>>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		let killed = false;
		const child: ChildHandle = {
			stdin: {
				write: line => negotiation.resolve(JSON.parse(String(line)) as Record<string, unknown>),
			},
			stdout: (async function* () {
				yield `${JSON.stringify({
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				})}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				killed = true;
				release.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath] },
			record("rpc-v2-negotiation-timeout"),
			{ entry: () => {}, event: () => {}, crashed: () => {} },
			undefined,
			undefined,
			undefined,
			10,
		);

		const startup = supervisor.start();
		expect(await negotiation.promise).toMatchObject({ type: "negotiate_protocol", protocolVersion: 2 });
		const outcome = await Promise.race([
			startup.then(
				() => ({ kind: "resolved" as const }),
				error => ({ kind: "rejected" as const, error }),
			),
			Bun.sleep(100).then(() => ({ kind: "pending" as const })),
		]);
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected")
			expect(outcome.error).toHaveProperty("message", "rpc protocol v2 negotiation timed out");
		expect(killed).toBe(true);
		await child.exited;
	});

	test("fails closed when a protocol v2 chunk sequence is interrupted", async () => {
		const negotiate = Promise.withResolvers<Record<string, unknown>>();
		const request = Promise.withResolvers<Record<string, unknown>>();
		const release = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const crashed = Promise.withResolvers<Error>();
		const child: ChildHandle = {
			stdin: {
				write: line => {
					const command = JSON.parse(String(line)) as Record<string, unknown>;
					if (command.type === "negotiate_protocol") negotiate.resolve(command);
					else request.resolve(command);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				})}\n`;
				const negotiation = await negotiate.promise;
				yield `${JSON.stringify({
					type: "response",
					id: negotiation.id,
					command: "negotiate_protocol",
					success: true,
					data: { protocolVersion: 2 },
				})}\n`;
				await request.promise;
				yield `${JSON.stringify({
					type: "rpc_chunk",
					chunkId: "interrupted-response",
					index: 0,
					count: 2,
					byteLength: 1024 * 1024,
					data: Buffer.from("{").toString("base64"),
				})}\n`;
				yield `${JSON.stringify({ type: "notice", message: "interleaved" })}\n`;
				await release.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				release.resolve();
				exited.resolve(1);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: sessionPath => ["omp", "--mode", "rpc", "--session", sessionPath] },
			record("rpc-v2-interrupted"),
			{ entry: () => {}, event: () => {}, crashed: crashed.resolve },
		);

		await supervisor.start();
		await expect(supervisor.call({ type: "get_state" }, "interrupted-response")).rejects.toThrow(
			"rpc chunk sequence interrupted",
		);
		expect((await crashed.promise).message).toBe("rpc chunk sequence interrupted");
	});

	test("daemon entrypoints resolve RPC children in source and installed layouts", () => {
		const cases = [
			["/checkout/packages/coding-agent/src/cli/ompd.ts", "/checkout/packages/coding-agent/src/cli.ts"],
			[
				"/install/node_modules/@oh-my-pi/pi-coding-agent/src/cli/ompd.ts",
				"/install/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts",
			],
		] as const;
		for (const [main, expectedMain] of cases) {
			expect(resolveRpcChildInvocation({ compiled: false, executable: "/usr/bin/bun", main })).toEqual({
				executable: "/usr/bin/bun",
				prefixArgv: [expectedMain],
			});
		}
	});
	test("ordinary source entrypoints remain the RPC child main", () => {
		expect(
			resolveRpcChildInvocation({
				compiled: false,
				executable: "/usr/bin/bun",
				main: "/checkout/packages/coding-agent/src/cli.ts",
			}),
		).toEqual({
			executable: "/usr/bin/bun",
			prefixArgv: ["/checkout/packages/coding-agent/src/cli.ts"],
		});
	});
	test("startup uses exact argv and session path", async () => {
		const factory = new IdleFactory();
		const supervisor = new RpcChildSupervisor(
			factory,
			record("session"),
			{ entry: () => {}, event: () => {}, crashed: () => {} },
			["omp", "--mode", "rpc", "--session", "/tmp/session.jsonl"],
		);
		await supervisor.start();
		expect(factory.children).toHaveLength(1);
		expect(factory.children[0]?.killed).toBe(false);
		supervisor.stop();
		expect(factory.children[0]?.killed).toBe(true);
	});
	test("malformed child frame fails startup", async () => {
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield "not-json\n";
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => exited.resolve(1),
		};
		const factory: RpcChildFactory = {
			spawn: () => child,
			argv: path => ["omp", "--mode", "rpc", "--session", path],
		};
		const supervisor = new RpcChildSupervisor(factory, record("s"), {
			entry: () => {},
			event: () => {},
			crashed: () => {},
		});
		await expect(supervisor.start()).rejects.toThrow("malformed rpc stdout");
	});
	test("duplicate-key child frames fail before schema dispatch", async () => {
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield '{"type":"ready","type":"ready"}\n';
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => exited.resolve(1),
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{ entry: () => {}, event: () => {}, crashed: () => {} },
		);
		await expect(supervisor.start()).rejects.toThrow("malformed rpc stdout");
	});
	test("oversized no-newline stdout fails before dispatch", async () => {
		const exited = Promise.withResolvers<number>();
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield "x".repeat(1024 * 1024 + 1);
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => exited.resolve(1),
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{ entry: () => {}, event: () => {}, crashed: () => {} },
		);
		await expect(supervisor.start()).rejects.toThrow("exceeds 1MiB");
	});
	test("reader failure after ready terminates and reaps a signal-resistant child", async () => {
		const emitMalformed = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const crashed = Promise.withResolvers<Error>();
		const killSignals: string[] = [];
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await emitMalformed.promise;
				yield "not-json\n";
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: signal => {
				killSignals.push(signal ?? "SIGTERM");
				if (signal === "SIGKILL") exited.resolve(1);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{ entry: () => {}, event: () => {}, crashed: crashed.resolve },
			["omp", "--mode", "rpc"],
			1,
		);

		await supervisor.start();
		emitMalformed.resolve();
		expect((await crashed.promise).message).toBe("malformed rpc stdout");
		expect(await child.exited).toBe(1);
		expect(killSignals).toEqual(["SIGTERM", "SIGKILL"]);
	});
	test("unknown string-typed child frames do not crash the supervisor", async () => {
		const gate = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const seen = Promise.withResolvers<void>();
		const events: Record<string, unknown>[] = [];
		const crashed: Error[] = [];
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				yield `${JSON.stringify({ type: "unknown_frame", payload: "future" })}\n`;
				await gate.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				gate.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{
				entry: () => {},
				event: frame => {
					events.push(frame);
					seen.resolve();
				},
				crashed: error => crashed.push(error),
			},
		);
		await supervisor.start();
		await seen.promise;
		expect(events).toEqual([{ type: "unknown_frame", payload: "future" }]);
		expect(crashed).toHaveLength(0);
		supervisor.stop();
		expect(crashed).toHaveLength(0);
	});
	test("an already-aborted call never writes the original command or a compensating abort", async () => {
		const finish = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const writes: Record<string, unknown>[] = [];
		const child: ChildHandle = {
			stdin: {
				write: data => {
					writes.push(JSON.parse(data) as Record<string, unknown>);
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await finish.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				finish.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{ entry: () => {}, event: () => {}, crashed: () => {} },
		);

		await supervisor.start();
		const controller = new AbortController();
		controller.abort();
		await expect(supervisor.prompt("outer", "never run", controller.signal)).rejects.toThrow("rpc call aborted");
		expect(writes).toEqual([]);
		supervisor.stop();
	});
	test("a child crash after command dispatch rejects the unknown outcome without replay", async () => {
		const written = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const writes: Record<string, unknown>[] = [];
		const crashErrors: Error[] = [];
		let spawnCount = 0;
		const child: ChildHandle = {
			stdin: {
				write: data => {
					writes.push(JSON.parse(data) as Record<string, unknown>);
					written.resolve();
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await written.promise;
				exited.resolve(137);
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => exited.resolve(137),
		};
		const supervisor = new RpcChildSupervisor(
			{
				spawn: () => {
					spawnCount += 1;
					return child;
				},
				argv: path => ["omp", "--mode", "rpc", "--session", path],
			},
			record("s"),
			{ entry: () => {}, event: () => {}, crashed: error => crashErrors.push(error) },
		);
		await supervisor.start();
		let internalId: string | undefined;
		await expect(supervisor.prompt("outer", "run once", undefined, id => (internalId = id))).rejects.toThrow(
			/rpc child (?:stdout EOF|exited)/u,
		);
		expect(internalId).toBe("outer:1");
		expect(writes).toEqual([{ type: "prompt", message: "run once", id: "outer:1" }]);
		expect(supervisor.hasPendingCalls()).toBe(false);
		expect(spawnCount).toBe(1);
		expect(crashErrors).toHaveLength(1);
	});
	test("buffered child frames are discarded after an explicit stop", async () => {
		const releaseBuffered = Promise.withResolvers<void>();
		const bufferedDrained = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const entries: unknown[] = [];
		const events: unknown[] = [];
		const crashed: Error[] = [];
		const child: ChildHandle = {
			stdin: { write: () => {} },
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await releaseBuffered.promise;
				yield `${JSON.stringify({ type: "session_entry", entry: { id: "late" } })}\n`;
				yield `${JSON.stringify({ type: "agent_end", messages: [] })}\n`;
				bufferedDrained.resolve();
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				releaseBuffered.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{
				entry: frame => entries.push(frame),
				event: frame => events.push(frame),
				crashed: error => crashed.push(error),
			},
		);

		await supervisor.start();
		supervisor.stop();
		await bufferedDrained.promise;
		expect(entries).toEqual([]);
		expect(events).toEqual([]);
		expect(crashed).toEqual([]);
	});
	test("late prompt failures remain events after the acceptance response settles", async () => {
		const firstWrite = Promise.withResolvers<void>();
		const secondWrite = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<number>();
		const lateFailureSeen = Promise.withResolvers<void>();
		const writes: Record<string, unknown>[] = [];
		const events: Record<string, unknown>[] = [];
		const crashed: Error[] = [];
		const child: ChildHandle = {
			stdin: {
				write: data => {
					writes.push(JSON.parse(data) as Record<string, unknown>);
					if (writes.length === 1) firstWrite.resolve();
					else secondWrite.resolve();
				},
			},
			stdout: (async function* () {
				yield `${JSON.stringify({ type: "ready" })}\n`;
				await firstWrite.promise;
				yield `${JSON.stringify({
					type: "response",
					id: writes[0]?.id,
					command: "prompt",
					success: true,
				})}\n`;
				yield `${JSON.stringify({ type: "prompt_result", id: writes[0]?.id, error: "missing auth" })}\n`;
				await secondWrite.promise;
				yield `${JSON.stringify({
					type: "response",
					id: writes[1]?.id,
					command: "get_state",
					success: true,
					data: {},
				})}\n`;
				await finish.promise;
			})(),
			stderr: (async function* () {})(),
			exited: exited.promise,
			kill: () => {
				finish.resolve();
				exited.resolve(0);
			},
		};
		const supervisor = new RpcChildSupervisor(
			{ spawn: () => child, argv: path => ["omp", "--mode", "rpc", "--session", path] },
			record("s"),
			{
				entry: () => {},
				event: frame => {
					events.push(frame);
					if (frame.type === "prompt_result") lateFailureSeen.resolve();
				},
				crashed: error => crashed.push(error),
			},
		);

		await supervisor.start();
		expect(await supervisor.prompt("outer", "hello")).toMatchObject({
			type: "response",
			command: "prompt",
			success: true,
		});
		await lateFailureSeen.promise;
		expect(events).toEqual([{ type: "prompt_result", id: "outer:1", error: "missing auth" }]);
		expect(crashed).toHaveLength(0);
		expect(await supervisor.call({ type: "get_state" }, "state")).toMatchObject({
			type: "response",
			command: "get_state",
			success: true,
		});
		expect(crashed).toHaveLength(0);
		supervisor.stop();
	});
	test("real Unix WebSocket upgrades on the local socket", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-ws-"));
		const path = join(root, "app.sock");
		const appserver = createAppserver({ hostId: host, socketPath: path, discovery: new StaticDiscovery([]) });
		await appserver.start();
		const socket = createConnection(path);
		await new Promise<void>(resolve => socket.once("connect", resolve));
		const websocketKey = Buffer.from("0123456789abcdef", "utf8").toString("base64");
		socket.write(
			`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		const handshake = await new Promise<Buffer>(resolve => socket.once("data", resolve));
		expect(handshake.toString()).toContain("101");
		socket.write(
			wsFrame(
				JSON.stringify({
					v: "omp-app/1",
					type: "hello",
					protocol: { min: "omp-app/1", max: "omp-app/1" },
					client: { name: "test", version: "1", build: "b", platform: "linux" },
					requestedFeatures: ["resume"],
					savedCursors: [],
				}),
			),
		);
		const frame = await new Promise<Buffer>(resolve => socket.once("data", resolve));
		const welcome = decodeServerFrame(wsPayload(frame));
		expect(welcome.type).toBe("welcome");
		if (welcome.type === "welcome") expect(welcome.grantedFeatures).toEqual(["resume"]);
		await appserver.stop();
		socket.destroy();
		expect(await unixSocketActive(path)).toBe(false);
	});
});
describe("appserver startup and cleanup", () => {
	test("startup does not wait for discovery and stop releases ownership", async () => {
		const root = await mkdtemp(join(tmpdir(), "omp-clean-"));
		const path = join(root, "app.sock");
		const factory = new IdleFactory();
		const appserver = createAppserver({
			hostId: host,
			socketPath: path,
			discovery: new StaticDiscovery([record("s")]),
			childFactory: factory,
		});
		await appserver.start();
		await appserver.stop();
		expect(factory.children).toHaveLength(0);
		await expect(stat(path)).rejects.toThrow();
		await expect(stat(`${path}.owner`)).rejects.toThrow();
		let discoveryCalls = 0;
		const deferred = createAppserver({
			hostId: host,
			socketPath: path,
			discovery: {
				list: async () => {
					discoveryCalls += 1;
					throw new Error("discovery failed");
				},
			},
		});
		await deferred.start();
		expect(discoveryCalls).toBe(0);
		await deferred.stop();
		expect(await unixSocketActive(path)).toBe(false);
		await expect(stat(`${path}.owner`)).rejects.toThrow();
	});
});
