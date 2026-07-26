// Boot reaping cleans state a previous host incarnation left behind when it
// died without a graceful shutdown: orphan omp children still running in the
// dead host's process group, and the stale owner lock files that incarnation
// took. The reaper must fail closed — a live or unparseable owner is never
// killed or cleared — and must log every decision.
import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOwnerMarkers, reapBootState } from "../src/boot-reaper.ts";
import type { OwnerMarker, ReapLog } from "../src/boot-reaper.ts";

// A fake owner record matches the shape the appserver and official authority
// persist: a JSON object whose `pid` names the host incarnation that wrote it.
const fakeAppserverMarker = (pid: number) => ({
	version: 2,
	ownerId: "11111111-1111-4111-8111-111111111111",
	pid,
	backingName: ".appserver-11111111-1111-4111-8111-111111111111.sock",
	device: 0,
	inode: 0,
});
const fakeOfficialMarker = (pid: number) => ({
	version: 1,
	pid,
	ownerId: "22222222-2222-4222-8222-222222222222",
});

function capturingLog(): { log: ReapLog; events: Array<{ event: string; fields?: Record<string, unknown> }> } {
	const events: Array<{ event: string; fields?: Record<string, unknown> }> = [];
	return { log: (event, fields) => events.push({ event, fields }), events };
}

describe("boot reaper reads owner markers", () => {
	test("extracts pids from appserver and official markers and skips missing files silently", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-read-"));
		const appserverPath = join(root, "app.sock.owner");
		const officialPath = join(root, ".t4-exclusive-owner.lock");
		await writeFile(appserverPath, `${JSON.stringify(fakeAppserverMarker(4242))}\n`, { mode: 0o600 });
		await writeFile(officialPath, `${JSON.stringify(fakeOfficialMarker(4243))}\n`, { mode: 0o600 });
		const { log, events } = capturingLog();

		const markers = await readOwnerMarkers({
			specs: [
				{ path: appserverPath, source: "appserver", clearLock: false },
				{ path: officialPath, source: "official", clearLock: true },
				{ path: join(root, "does-not-exist.owner"), source: "appserver", clearLock: false },
			],
			log,
		});

		expect(markers).toEqual([
			{ path: appserverPath, source: "appserver", clearLock: false, pid: 4242 },
			{ path: officialPath, source: "official", clearLock: true, pid: 4243 },
		]);
		// A missing previous marker is the normal fresh-boot case: no log noise.
		expect(events.filter(e => e.fields?.path === join(root, "does-not-exist.owner"))).toEqual([]);
	});

	test("skips malformed markers and markers without a valid pid, with a warning", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-malformed-"));
		const malformed = join(root, "malformed.owner");
		const noPid = join(root, "noid.owner");
		const negativePid = join(root, "neg.owner");
		await writeFile(malformed, "{not json", { mode: 0o600 });
		await writeFile(noPid, JSON.stringify({ version: 2, ownerId: "x" }), { mode: 0o600 });
		await writeFile(negativePid, JSON.stringify({ pid: -1 }), { mode: 0o600 });
		const { log, events } = capturingLog();

		const markers = await readOwnerMarkers({
			specs: [
				{ path: malformed, source: "appserver", clearLock: false },
				{ path: noPid, source: "appserver", clearLock: false },
				{ path: negativePid, source: "appserver", clearLock: false },
			],
			log,
		});

		expect(markers).toEqual([]);
		expect(events.map(e => e.fields?.reason)).toEqual([
			"marker is malformed",
			"marker has no valid pid",
			"marker has no valid pid",
		]);
		expect(events.every(e => e.fields?.level === "warn")).toBe(true);
	});
});

describe("boot reaper kills orphans and clears stale locks", () => {
	test("kills the dead host's process group and clears a clearable lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-dead-"));
		const lockPath = join(root, ".t4-exclusive-owner.lock");
		await writeFile(lockPath, `${JSON.stringify(fakeOfficialMarker(9999))}\n`, { mode: 0o600 });
		const { log, events } = capturingLog();
		const killed: Array<{ pid: number; signal: number }> = [];

		const result = await reapBootState({
			markers: [{ path: lockPath, source: "official", clearLock: true, pid: 9999 }],
			pidIsAlive: () => false,
			kill: (pid, signal) => killed.push({ pid, signal: signal ?? 0 }),
			log,
		});

		// Negative pid targets the dead host's process group, not the pid itself.
		expect(killed).toEqual([{ pid: -9999, signal: 9 }]);
		expect(result.killedPids).toEqual([9999]);
		expect(result.clearedLocks).toEqual([lockPath]);
		expect(result.skipped).toEqual([]);
		// The lock file is gone.
		expect(await Bun.file(lockPath).exists()).toBe(false);
		expect(events.find(e => e.event === "supervisor.killed")?.fields).toMatchObject({
			source: "official",
			pid: 9999,
		});
		expect(events.find(e => e.event === "reap.lock.cleared")?.fields).toMatchObject({
			path: lockPath,
		});
	});

	test("leaves a non-clearable marker in place for downstream reclaim", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-keep-"));
		const markerPath = join(root, "app.sock.owner");
		await writeFile(markerPath, `${JSON.stringify(fakeAppserverMarker(7777))}\n`, { mode: 0o600 });
		const killed: number[] = [];

		const result = await reapBootState({
			markers: [{ path: markerPath, source: "appserver", clearLock: false, pid: 7777 }],
			pidIsAlive: () => false,
			kill: pid => killed.push(pid),
		});

		expect(killed).toEqual([-7777]);
		expect(result.killedPids).toEqual([7777]);
		// The appserver reclaims its own marker (plus backing socket + symlink),
		// so the reaper must not unlink it.
		expect(result.clearedLocks).toEqual([]);
		expect(await Bun.file(markerPath).exists()).toBe(true);
	});

	test("fails closed when the previous owner is still alive", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-live-"));
		const lockPath = join(root, ".t4-exclusive-owner.lock");
		await writeFile(lockPath, `${JSON.stringify(fakeOfficialMarker(5555))}\n`, { mode: 0o600 });
		const killed: number[] = [];

		const result = await reapBootState({
			markers: [{ path: lockPath, source: "official", clearLock: true, pid: 5555 }],
			pidIsAlive: () => true,
			kill: pid => killed.push(pid),
		});

		expect(killed).toEqual([]);
		expect(result.killedPids).toEqual([]);
		expect(result.clearedLocks).toEqual([]);
		expect(result.skipped).toEqual([
			{ source: "official", path: lockPath, pid: 5555, reason: "owner still alive" },
		]);
		expect(await Bun.file(lockPath).exists()).toBe(true);
	});

	test("fails closed when the liveness probe throws", async () => {
		const killed: number[] = [];
		const result = await reapBootState({
			markers: [{ path: "/tmp/ignored", source: "official", clearLock: true, pid: 1234 }],
			pidIsAlive: () => {
				throw new Error("procfs unavailable");
			},
			kill: pid => killed.push(pid),
		});
		expect(killed).toEqual([]);
		expect(result.killedPids).toEqual([]);
		expect(result.skipped[0]?.reason).toBe("owner still alive");
	});

	test("reports a kill failure without clearing the lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-killfail-"));
		const lockPath = join(root, ".t4-exclusive-owner.lock");
		await writeFile(lockPath, `${JSON.stringify(fakeOfficialMarker(8888))}\n`, { mode: 0o600 });
		const { log, events } = capturingLog();

		const result = await reapBootState({
			markers: [{ path: lockPath, source: "official", clearLock: true, pid: 8888 }],
			pidIsAlive: () => false,
			kill: () => {
				throw new Error("EPERM");
			},
			log,
		});

		expect(result.killedPids).toEqual([]);
		expect(result.clearedLocks).toEqual([]);
		expect(result.skipped[0]?.reason).toBe("kill failed");
		expect(events.find(e => e.event === "reap.kill.failed")?.fields?.level).toBe("error");
		expect(await Bun.file(lockPath).exists()).toBe(true);
	});
	test("treats an ENOENT during unlink as benign (lock already gone)", async () => {
		const lockPath = "/tmp/t4-reap-benign-enoent.lock";
		const result = await reapBootState({
			markers: [{ path: lockPath, source: "official", clearLock: true, pid: 6666 }],
			pidIsAlive: () => false,
			kill: () => undefined,
			unlink: async () => {
				throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			},
		});
		// Another reaper (or the authority) removed it first: not a failure.
		expect(result.clearedLocks).toEqual([]);
		expect(result.skipped).toEqual([]);
});
});

describe("boot reaper end-to-end with fake on-disk ownership records", () => {
	test("reads fake markers, reaps dead orphans, and clears the official lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-reap-e2e-"));
		const appserverMarker = join(root, "app.sock.owner");
		const officialLock = join(root, ".t4-exclusive-owner.lock");
		// A previous host incarnation (pid 13579) died, leaving both markers.
		await writeFile(appserverMarker, `${JSON.stringify(fakeAppserverMarker(13579))}\n`, { mode: 0o600 });
		await writeFile(officialLock, `${JSON.stringify(fakeOfficialMarker(13579))}\n`, { mode: 0o600 });
		const { log, events } = capturingLog();
		const killed: number[] = [];

		const markers = await readOwnerMarkers({
			specs: [
				{ path: appserverMarker, source: "appserver", clearLock: false },
				{ path: officialLock, source: "official", clearLock: true },
			],
			log,
		});
		expect(markers.map(m => m.pid)).toEqual([13579, 13579]);

		const result = await reapBootState({
			markers,
			pidIsAlive: () => false,
			kill: pid => killed.push(pid),
			log,
		});

		// Both markers point at the same dead host, so its process group is
		// signalled once per marker.
		expect(killed).toEqual([-13579, -13579]);
		expect(result.killedPids).toEqual([13579, 13579]);
		// Only the official lock is cleared; the appserver marker is left for
		// the appserver's own recoverStale.
		expect(result.clearedLocks).toEqual([officialLock]);
		expect(await Bun.file(officialLock).exists()).toBe(false);
		expect(await Bun.file(appserverMarker).exists()).toBe(true);
		expect(events.filter(e => e.event === "supervisor.killed")).toHaveLength(2);
		expect(events.find(e => e.event === "reap.lock.cleared")?.fields?.path).toBe(officialLock);
	});
});
