import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { SessionId } from "@t4-code/host-wire";
import type {
	AppserverTestControl,
	AppserverTestControlStatus,
	AppserverTestSeedRequest,
	SessionAuthority,
	SessionLockInspector,
	SessionLockStatus,
	SessionRecord,
} from "./types.ts";

const MANIFEST_VERSION = 1;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_RUNS = 32;
const MAX_ERRORS = 16;
/** Filename- and entry-id-safe. The wire layer bounds length; this bounds shape. */
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface SeededSession {
	readonly sessionId: SessionId;
	readonly path: string;
}

interface SeededRun {
	readonly projectRoot: string;
	readonly seededAt: string;
	readonly sessions: readonly SeededSession[];
}

/** Sessions this control created, so cleanup can never reach a session it did not seed. */
interface SeedManifest {
	readonly version: typeof MANIFEST_VERSION;
	readonly runs: Readonly<Record<string, SeededRun>>;
}

export interface SeedingTestControlOptions {
	readonly token: string;
	readonly profile: string;
	/** Private profile-local record of seeded sessions. */
	readonly manifestPath: string;
	readonly authority: SessionAuthority;
	readonly lockStatus: SessionLockInspector;
	readonly now?: () => Date;
}

function decodeManifest(value: unknown): SeedManifest | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const root = value as Record<string, unknown>;
	if (root.version !== MANIFEST_VERSION || !root.runs || typeof root.runs !== "object" || Array.isArray(root.runs))
		return undefined;
	const runs: Record<string, SeededRun> = {};
	for (const [runId, raw] of Object.entries(root.runs as Record<string, unknown>)) {
		if (!RUN_ID.test(runId) || !raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
		const run = raw as Record<string, unknown>;
		if (
			typeof run.projectRoot !== "string" ||
			typeof run.seededAt !== "string" ||
			!Array.isArray(run.sessions) ||
			run.sessions.length > 100
		)
			return undefined;
		const sessions: SeededSession[] = [];
		for (const item of run.sessions) {
			if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
			const session = item as Record<string, unknown>;
			if (typeof session.sessionId !== "string" || typeof session.path !== "string" || !isAbsolute(session.path))
				return undefined;
			sessions.push({ sessionId: session.sessionId as SessionId, path: session.path });
		}
		runs[runId] = { projectRoot: run.projectRoot, seededAt: run.seededAt, sessions };
	}
	return { version: MANIFEST_VERSION, runs };
}

/**
 * Deterministic disposable session seeding for local integration runs.
 *
 * The appserver already refuses to expose the routes that reach this control
 * unless OMP_APP_TEST_MODE is set and the listener is local, so this class
 * carries the remaining guarantees: it creates sessions only through the
 * session authority, records exactly what it created, and deletes only what it
 * recorded. Seeded transcript text is generated from the run id and an index,
 * so a seeded profile never contains caller-supplied content.
 */
export class SeedingTestControl implements AppserverTestControl {
	readonly token: string;
	readonly #profile: string;
	readonly #manifestPath: string;
	readonly #authority: SessionAuthority;
	readonly #lockStatus: SessionLockInspector;
	readonly #now: () => Date;
	#manifest: SeedManifest = { version: MANIFEST_VERSION, runs: {} };
	#loaded = false;
	#errors: string[] = [];

	constructor(options: SeedingTestControlOptions) {
		if (!isAbsolute(options.manifestPath)) throw new Error("test control manifest path must be absolute");
		this.token = options.token;
		this.#profile = options.profile;
		this.#manifestPath = resolve(options.manifestPath);
		this.#authority = options.authority;
		this.#lockStatus = options.lockStatus;
		this.#now = options.now ?? (() => new Date());
	}

	async sessionIds(runId: string): Promise<readonly SessionId[]> {
		await this.#load();
		return (this.#manifest.runs[runId]?.sessions ?? []).map(session => session.sessionId);
	}

	async seed(request: AppserverTestSeedRequest): Promise<AppserverTestControlStatus> {
		await this.#load();
		if (!RUN_ID.test(request.runId)) throw new Error("test control run id is invalid");
		if (this.#manifest.runs[request.runId]) throw new Error("test control run id is already seeded");
		if (Object.keys(this.#manifest.runs).length >= MAX_RUNS) throw new Error("test control manifest is full");
		const projectRoot = resolve(request.projectRoot);
		if (!isAbsolute(projectRoot) || !(await this.#isDirectory(projectRoot)))
			throw new Error("test control project root is unavailable");
		this.#errors = [];
		const sessions: SeededSession[] = [];
		try {
			for (let index = 0; index < request.sessionCount; index += 1) {
				const created = await this.#authority.create(projectRoot, `T4 seeded ${request.runId} ${index + 1}`);
				sessions.push({ sessionId: created.sessionId, path: created.path });
				await this.#appendHistory(created.path, request.runId, index, request.historyEntries);
			}
		} catch (error) {
			// A partial seed must not leave unrecorded files behind, so record
			// what exists before surfacing the failure.
			await this.#persist(this.#run(request, projectRoot, sessions));
			throw error;
		}
		await this.#persist(this.#run(request, projectRoot, sessions));
		return this.status(request.runId);
	}

	async status(runId: string): Promise<AppserverTestControlStatus> {
		await this.#load();
		const run = this.#manifest.runs[runId];
		const records = new Map<SessionId, SessionRecord>();
		for (const record of await this.#authority.list()) records.set(record.sessionId, record);
		const locks: Record<Exclude<SessionLockStatus, "missing">, number> = {
			live: 0,
			suspect: 0,
			stale: 0,
			malformed: 0,
		};
		let indexed = 0;
		let remainingFiles = 0;
		for (const session of run?.sessions ?? []) {
			const record = records.get(session.sessionId);
			if (record) {
				indexed += 1;
				const state = await this.#lockStatus(record);
				if (state !== "missing") locks[state] += 1;
			}
			if (await this.#isFile(session.path)) remainingFiles += 1;
		}
		const seeded = run?.sessions.length ?? 0;
		return {
			v: 1,
			runId,
			profile: this.#profile,
			state: seeded > 0 ? "seeded" : "clean",
			sessions: { seeded, indexed },
			locks,
			// The appserver owns live worker counts and replaces this before responding.
			workers: { supervisors: 0, starting: 0, pendingRpc: 0 },
			remainingFiles,
			errors: [...this.#errors],
		};
	}

	/**
	 * Deletion goes through the session authority only. The authority validates
	 * ownership, symlinks, and canonical containment before it removes a
	 * transcript; a direct unlink of a manifest path would skip all of that and
	 * trust a file to name an arbitrary absolute path. A session the authority
	 * no longer lists is therefore retained and reported rather than removed.
	 */
	async cleanup(runId: string): Promise<AppserverTestControlStatus> {
		await this.#load();
		const run = this.#manifest.runs[runId];
		this.#errors = [];
		if (run) {
			const records = new Map<SessionId, SessionRecord>();
			for (const record of await this.#authority.list()) records.set(record.sessionId, record);
			const retained: SeededSession[] = [];
			for (const session of run.sessions) {
				const record = records.get(session.sessionId);
				if (!record || record.path !== session.path) {
					if (await this.#isFile(session.path)) {
						this.#recordError(new Error("unlisted_session"));
						retained.push(session);
					}
					continue;
				}
				try {
					await this.#authority.delete(record);
				} catch (error) {
					this.#recordError(error);
					retained.push(session);
				}
			}
			const runs = { ...this.#manifest.runs };
			if (retained.length > 0) runs[runId] = { ...run, sessions: retained };
			else delete runs[runId];
			await this.#persistRuns(runs);
		}
		return this.status(runId);
	}

	#run(request: AppserverTestSeedRequest, projectRoot: string, sessions: readonly SeededSession[]): SeedManifest {
		return {
			version: MANIFEST_VERSION,
			runs: {
				...this.#manifest.runs,
				[request.runId]: { projectRoot, seededAt: this.#now().toISOString(), sessions },
			},
		};
	}

	#recordError(error: unknown): void {
		if (this.#errors.length >= MAX_ERRORS) return;
		this.#errors.push(error instanceof Error ? error.name : "unknown_error");
	}

	/**
	 * Append durable transcript entries directly to the authority JSONL. The
	 * session has no live writer yet, and OMP transcripts are append-only, so
	 * this adds history without rewriting anything the authority produced.
	 */
	async #appendHistory(path: string, runId: string, sessionIndex: number, entries: number): Promise<void> {
		if (entries === 0) return;
		const base = this.#now().getTime();
		let body = "";
		for (let index = 0; index < entries; index += 1) {
			body += `${JSON.stringify({
				type: "message",
				id: `${runId}-${sessionIndex}-${index}`,
				parentId: null,
				timestamp: new Date(base + index).toISOString(),
				message: {
					role: index % 2 === 0 ? "user" : "assistant",
					content: `seeded ${runId} entry ${index + 1}`,
				},
			})}\n`;
		}
		await fs.appendFile(path, body, { mode: 0o600 });
	}

	async #isDirectory(path: string): Promise<boolean> {
		try {
			return (await fs.stat(path)).isDirectory();
		} catch {
			return false;
		}
	}

	async #isFile(path: string): Promise<boolean> {
		try {
			return (await fs.lstat(path)).isFile();
		} catch {
			return false;
		}
	}

	/**
	 * The manifest is the only record of which sessions this control may delete,
	 * so it fails closed. A missing file is a legitimate empty state; anything
	 * else - wrong mode, oversize, unreadable, or invalid - is refused so a
	 * later seed can never overwrite a damaged ledger and strand the sessions
	 * it still names.
	 */
	async #load(): Promise<void> {
		if (this.#loaded) return;
		let metadata: Stats;
		try {
			metadata = await fs.lstat(this.#manifestPath);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			this.#loaded = true;
			return;
		}
		if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_MANIFEST_BYTES)
			throw new Error("test control manifest is unsafe");
		const manifest = decodeManifest(JSON.parse(await fs.readFile(this.#manifestPath, "utf8")) as unknown);
		if (!manifest) throw new Error("test control manifest is invalid");
		this.#manifest = manifest;
		this.#loaded = true;
	}

	async #persistRuns(runs: Readonly<Record<string, SeededRun>>): Promise<void> {
		await this.#persist({ version: MANIFEST_VERSION, runs });
	}

	async #persist(manifest: SeedManifest): Promise<void> {
		const directory = dirname(this.#manifestPath);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.#manifestPath}.${randomUUID()}.tmp`;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(manifest)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, this.#manifestPath);
			await fs.chmod(this.#manifestPath, 0o600);
		} catch (error) {
			await fs.unlink(temporary).catch(() => undefined);
			throw error;
		}
		this.#manifest = manifest;
	}
}
