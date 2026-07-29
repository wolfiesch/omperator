import { lstat, readFile, unlink } from "node:fs/promises";

/**
 * Boot-time reaping of state a previous host incarnation left behind when it
 * died without a graceful shutdown.
 *
 * Two kinds of stale state are cleaned:
 *
 * 1. Orphan omp children. The host daemon spawns per-session OMP runtime
 *    children (`RpcChildSupervisor`) inside its own process group. If the host
 *    dies, those children are reparented to PID 1 but keep running, still
 *    holding their session locks and transcripts. Each host incarnation
 *    records its pid in an owner marker (the appserver socket `.owner` file
 *    and, in official mode, the exclusive `.t4-exclusive-owner.lock`). When a
 *    marker's pid is no longer alive, the previous host is gone and any
 *    survivors in its process group are orphans; signalling the negative pid
 *    reaps exactly that group without tracking individual child pids.
 *
 * 2. Stale owner locks. The same markers are the locks the previous host
 *    incarnation took. Clearing them lets the fresh incarnation acquire them
 *    cleanly. The appserver marker is left in place for the appserver's own
 *    `recoverStale` (which also removes the backing socket and symlink); the
 *    official exclusive lock is unlinked directly because it is a standalone
 *    file.
 *
 * Everything fails closed: a marker whose pid is still alive, or that cannot be
 * parsed, is left untouched and reported, never killed or cleared.
 */

export interface OwnerMarkerSpec {
	/** Absolute path to the owner/lock marker file. */
	readonly path: string;
	/** Label for log lines, e.g. "appserver" or "official". */
	readonly source: string;
	/**
	 * Whether the reaper may unlink the marker after killing orphans. Set false
	 * when a downstream component reclaims the marker as part of a fuller
	 * cleanup (the appserver also removes its backing socket and symlink).
	 */
	readonly clearLock: boolean;
}

export interface OwnerMarker extends OwnerMarkerSpec {
	/** The pid of the previous host incarnation that wrote the marker. */
	readonly pid: number;
}

export interface ReapSkipped {
	readonly source: string;
	readonly path: string;
	readonly pid?: number;
	readonly reason: string;
}

export interface ReapResult {
	/** Pids whose orphan process group was signalled. */
	readonly killedPids: readonly number[];
	/** Marker paths that were unlinked. */
	readonly clearedLocks: readonly string[];
	/** Markers left in place (live owner, malformed, or missing). */
	readonly skipped: readonly ReapSkipped[];
}

export type ReapLog = (event: string, fields?: Record<string, unknown>) => void;

export interface ReadOwnerMarkersOptions {
	readonly specs: readonly OwnerMarkerSpec[];
	readonly readFile?: (path: string) => Promise<string>;
	readonly lstat?: (path: string) => Promise<{ isFile(): boolean }>;
	readonly log?: ReapLog;
}

export interface ReapBootStateOptions {
	readonly markers: readonly OwnerMarker[];
	readonly pidIsAlive?: (pid: number) => boolean;
	/** Deprecated. Legacy owner markers do not contain enough identity to authorize a signal. */
	readonly kill?: (pid: number, signal?: number) => void;
	readonly unlink?: (path: string) => Promise<void>;
	readonly log?: ReapLog;
}

function defaultPidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH: no such process. EPERM or anything else: treat as alive so a
		// permissions glitch can never trigger an orphan kill.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function extractPid(value: unknown): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const pid = record.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
	return pid;
}

/**
 * Reads owner marker files from disk and extracts their pid. Missing files are
 * skipped silently (a fresh boot has no previous marker); malformed files are
 * skipped with a warning rather than parsed defensively.
 */
export async function readOwnerMarkers(
	options: ReadOwnerMarkersOptions,
): Promise<OwnerMarker[]> {
	const readFileFn = options.readFile ?? ((path: string) => readFile(path, "utf8"));
	const stat = options.lstat ?? ((path: string) => lstat(path));
	const log = options.log ?? (() => {});
	const markers: OwnerMarker[] = [];
	for (const spec of options.specs) {
		try {
			const info = await stat(spec.path);
			if (!info.isFile()) {
				log("reap.skip", { source: spec.source, path: spec.path, reason: "marker is not a regular file", level: "warn" });
				continue;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			log("reap.skip", { source: spec.source, path: spec.path, reason: "marker stat failed", level: "warn", error: String(error) });
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFileFn(spec.path));
		} catch (error) {
			log("reap.skip", { source: spec.source, path: spec.path, reason: "marker is malformed", level: "warn", error: String(error) });
			continue;
		}
		const pid = extractPid(parsed);
		if (pid === undefined) {
			log("reap.skip", { source: spec.source, path: spec.path, reason: "marker has no valid pid", level: "warn" });
			continue;
		}
		markers.push({ ...spec, pid });
	}
	return markers;
}

/**
 * Reaps stale state for the markers already read from disk. Each marker whose
 * pid is dead triggers an orphan process-group kill and, when `clearLock` is
 * set, removal of the marker file. Live or unparseable owners are skipped.
 */
export async function reapBootState(options: ReapBootStateOptions): Promise<ReapResult> {
	const pidIsAlive = options.pidIsAlive ?? defaultPidIsAlive;
	const unlinkFile = options.unlink ?? unlink;
	const log = options.log ?? (() => {});
	const killedPids: number[] = [];
	const clearedLocks: string[] = [];
	const skipped: ReapSkipped[] = [];
	for (const marker of options.markers) {
		let alive: boolean;
		try {
			alive = pidIsAlive(marker.pid);
		} catch {
			// A liveness probe that throws must never authorize a kill.
			alive = true;
		}
		if (alive) {
			skipped.push({ source: marker.source, path: marker.path, pid: marker.pid, reason: "owner still alive" });
			log("reap.skip", { source: marker.source, path: marker.path, pid: marker.pid, reason: "owner still alive" });
			continue;
		}
		// A legacy owner marker proves only that one PID used to own the lock.
		// It does not prove the PGID, boot identity, start time, or executable,
		// so it can authorize stale-lock cleanup but never a process signal.
		skipped.push({
			source: marker.source,
			path: marker.path,
			pid: marker.pid,
			reason: "legacy marker cannot authorize process signaling",
		});
		log("reap.signal.skipped", {
			source: marker.source,
			path: marker.path,
			pid: marker.pid,
			reason: "legacy marker lacks process identity",
			level: "warn",
		});
		if (!marker.clearLock) continue;
		try {
			await unlinkFile(marker.path);
			clearedLocks.push(marker.path);
			log("reap.lock.cleared", { source: marker.source, path: marker.path, pid: marker.pid });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			skipped.push({ source: marker.source, path: marker.path, pid: marker.pid, reason: "lock clear failed" });
			log("reap.lock.clear.failed", { source: marker.source, path: marker.path, pid: marker.pid, level: "warn", error: String(error) });
		}
	}
	return { killedPids, clearedLocks, skipped };
}
