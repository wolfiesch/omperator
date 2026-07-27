import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	hostId,
	type ProjectId,
	type SessionId,
	sessionId,
	type TranscriptPageArguments,
	type TranscriptPageResult,
} from "@t4-code/host-wire";
import { FileSessionDiscovery } from "./discovery.ts";
import type {
	SessionAuthority,
	SessionAuthoritySession,
	SessionDiscovery,
	SessionRecord,
} from "./types.ts";

const TITLE_SLOT_BYTES = 256;
const METADATA_BYTES = 1024 * 1024;
export const OFFICIAL_OMP_OWNER_FILE = ".t4-exclusive-owner.lock";
const OWNER_FILE = OFFICIAL_OMP_OWNER_FILE;

interface OwnerRecord {
	readonly version: 1;
	readonly pid: number;
	readonly ownerId: string;
}

interface FileIdentity {
	readonly device: number;
	readonly inode: number;
}

interface OfficialProfileMetadata {
	readonly version: 1;
	readonly archived: Readonly<Record<string, string>>;
}

export interface OfficialOmpProfileAuthorityOptions {
	readonly sessionsRoot: string;
	readonly metadataPath: string;
}

function titleSlot(title: string, updatedAt: string): string {
	const encoder = new TextEncoder();
	const codePoints = [...title];
	const line = (value: string, pad: string): string =>
		`${JSON.stringify({ type: "title", v: 1, title: value, source: "user", updatedAt, pad })}\n`;
	let low = 0;
	let high = codePoints.length;
	let bounded = "";
	while (low <= high) {
		const middle = (low + high) >>> 1;
		const candidate = codePoints.slice(0, middle).join("");
		if (encoder.encode(line(candidate, "")).byteLength <= TITLE_SLOT_BYTES) {
			bounded = candidate;
			low = middle + 1;
		} else high = middle - 1;
	}
	const unpadded = line(bounded, "");
	const pad = " ".repeat(TITLE_SLOT_BYTES - encoder.encode(unpadded).byteLength);
	const result = line(bounded, pad);
	if (encoder.encode(result).byteLength !== TITLE_SLOT_BYTES) throw new Error("official OMP title slot is invalid");
	return result;
}

function decodeMetadata(value: unknown): OfficialProfileMetadata {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("official OMP metadata is invalid");
	const root = value as Record<string, unknown>;
	if (root.version !== 1 || !root.archived || typeof root.archived !== "object" || Array.isArray(root.archived))
		throw new Error("official OMP metadata is invalid");
	const archived: Record<string, string> = {};
	for (const [id, timestamp] of Object.entries(root.archived)) {
		if (id.length === 0 || id.length > 256 || typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))
			throw new Error("official OMP metadata is invalid");
		archived[id] = timestamp;
	}
	return { version: 1, archived };
}

function decodeOwnerRecord(value: unknown): OwnerRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("official OMP owner lease is invalid");
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.ownerId !== "string" ||
		!/^[0-9a-f-]{36}$/u.test(record.ownerId)
	)
		throw new Error("official OMP owner lease is invalid");
	return { version: 1, pid: record.pid, ownerId: record.ownerId };
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/**
 * T4-owned host management for an isolated official-OMP profile. The caller
 * must give this authority an exclusive sessions root because stock OMP has no
 * cross-process writer lock. OMP remains the per-session runtime and JSONL
 * authority; this class supplies only host-wide discovery and lifecycle seams.
 */
export class OfficialOmpProfileAuthority implements SessionAuthority, SessionDiscovery {
	readonly #sessionsRoot: string;
	readonly #metadataPath: string;
	readonly #discovery: FileSessionDiscovery;
	readonly #archived = new Map<string, string>();
	readonly #owner: OwnerRecord = { version: 1, pid: process.pid, ownerId: Bun.randomUUIDv7() };
	#canonicalRoot?: string;
	#ownerIdentity?: FileIdentity;
	#metadataMutation: Promise<void> = Promise.resolve();
	#initialized = false;

	constructor(options: OfficialOmpProfileAuthorityOptions) {
		if (!isAbsolute(options.sessionsRoot) || !isAbsolute(options.metadataPath))
			throw new Error("official OMP authority paths must be absolute");
		this.#sessionsRoot = resolve(options.sessionsRoot);
		this.#metadataPath = resolve(options.metadataPath);
		this.#discovery = new FileSessionDiscovery(this.#sessionsRoot, undefined, hostId("official-omp"), true);
	}

	async initialize(): Promise<void> {
		if (this.#initialized) return;
		await Promise.all([
			mkdir(this.#sessionsRoot, { recursive: true, mode: 0o700 }),
			mkdir(dirname(this.#metadataPath), { recursive: true, mode: 0o700 }),
		]);
		const rootInfo = await lstat(this.#sessionsRoot);
		const metadataRootInfo = await lstat(dirname(this.#metadataPath));
		const uid = process.getuid?.();
		if (
			!rootInfo.isDirectory() ||
			rootInfo.isSymbolicLink() ||
			!metadataRootInfo.isDirectory() ||
			metadataRootInfo.isSymbolicLink() ||
			(uid !== undefined && (rootInfo.uid !== uid || metadataRootInfo.uid !== uid))
		)
			throw new Error("official OMP authority root is unsafe");
		await Promise.all([chmod(this.#sessionsRoot, 0o700), chmod(dirname(this.#metadataPath), 0o700)]);
		this.#canonicalRoot = await realpath(this.#sessionsRoot);
		await this.#acquireLease();
		try {
			try {
				const info = await lstat(this.#metadataPath);
				if (info.isSymbolicLink() || !info.isFile() || info.size > METADATA_BYTES)
					throw new Error("official OMP metadata is invalid");
				const metadata = decodeMetadata(JSON.parse(await readFile(this.#metadataPath, "utf8")));
				for (const [id, timestamp] of Object.entries(metadata.archived)) this.#archived.set(id, timestamp);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			this.#initialized = true;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (!this.#ownerIdentity || !this.#canonicalRoot) return;
		await this.#metadataMutation.catch(() => undefined);
		const ownerPath = join(this.#canonicalRoot, OWNER_FILE);
		try {
			const info = await lstat(ownerPath);
			const current = decodeOwnerRecord(JSON.parse(await readFile(ownerPath, "utf8")));
			if (
				info.dev === this.#ownerIdentity.device &&
				info.ino === this.#ownerIdentity.inode &&
				current.pid === this.#owner.pid &&
				current.ownerId === this.#owner.ownerId
			) {
				await unlink(ownerPath);
				await syncDirectory(this.#canonicalRoot);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			this.#ownerIdentity = undefined;
			this.#initialized = false;
		}
	}

	async list(): Promise<SessionRecord[]> {
		await this.#assertLease();
		await this.#assertDiscoveryTree();
		const records = await this.#discovery.list();
		await Promise.all(records.map(record => this.#assertOwnedSession(record)));
		return records.map(record => {
			const archivedAt = this.#archived.get(record.sessionId);
			return archivedAt ? { ...record, archivedAt } : record;
		});
	}

	async load(session: SessionRecord): Promise<SessionRecord> {
		await this.#assertLease();
		await this.#assertOwnedSession(session);
		const loaded = await this.#discovery.load(session);
		await this.#assertOwnedSession(loaded);
		const archivedAt = this.#archived.get(loaded.sessionId);
		return archivedAt ? { ...loaded, archivedAt } : loaded;
	}

	async page(session: SessionRecord, args: TranscriptPageArguments): Promise<TranscriptPageResult> {
		await this.#assertLease();
		await this.#assertOwnedSession(session);
		if (!this.#discovery.page) throw new Error("official OMP transcript paging is unavailable");
		return this.#discovery.page(session, args);
	}

	async create(cwd: string, title = "Session"): Promise<SessionAuthoritySession> {
		await this.#assertLease();
		const canonicalCwd = await realpath(cwd);
		if (!(await stat(canonicalCwd)).isDirectory()) throw new Error("official OMP session cwd is unavailable");
		const id = Bun.randomUUIDv7();
		const timestamp = new Date().toISOString();
		const configuredDirectory = join(this.#sessionsRoot, "-t4");
		await mkdir(configuredDirectory, { recursive: true, mode: 0o700 });
		const directory = await this.#assertOwnedDirectory(configuredDirectory);
		const path = join(directory, `session-${id}.jsonl`);
		const body = `${titleSlot(title, timestamp)}${JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd: canonicalCwd,
		})}\n`;
		const handle = await open(path, "wx", 0o600);
		try {
			await handle.writeFile(body, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return { sessionId: sessionId(id), path, cwd: canonicalCwd, title, entries: [] };
	}

	async archive(session: SessionRecord, archivedAt: string): Promise<void> {
		await this.#assertLease();
		await this.#assertOwnedSession(session);
		await this.#mutateMetadata(async () => {
			const previous = this.#archived.get(session.sessionId);
			this.#archived.set(session.sessionId, archivedAt);
			try {
				await this.#persist();
			} catch (error) {
				if (previous === undefined) this.#archived.delete(session.sessionId);
				else this.#archived.set(session.sessionId, previous);
				throw error;
			}
		});
	}

	async restore(session: SessionRecord): Promise<void> {
		await this.#assertLease();
		await this.#assertOwnedSession(session);
		await this.#mutateMetadata(async () => {
			const previous = this.#archived.get(session.sessionId);
			this.#archived.delete(session.sessionId);
			try {
				await this.#persist();
			} catch (error) {
				if (previous !== undefined) this.#archived.set(session.sessionId, previous);
				throw error;
			}
		});
	}

	async delete(session: SessionRecord): Promise<void> {
		await this.#assertLease();
		const path = await this.#assertOwnedSession(session);
		const artifacts = path.slice(0, -".jsonl".length);
		let artifactsExist = false;
		try {
			const info = await lstat(artifacts);
			const uid = process.getuid?.();
			if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid))
				throw new Error("official OMP artifact root is unsafe");
			const canonicalArtifacts = await realpath(artifacts);
			const child = relative(this.#canonicalRoot!, canonicalArtifacts);
			if (child === "" || child.startsWith("..") || isAbsolute(child))
				throw new Error("official OMP artifact root is outside the exclusive root");
			artifactsExist = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const trash = join(this.#canonicalRoot!, ".t4-trash");
		await mkdir(trash, { mode: 0o700 });
		await this.#assertOwnedDirectory(trash);
		const nonce = Bun.randomUUIDv7();
		const trashedPath = join(trash, `${nonce}.jsonl`);
		const trashedArtifacts = join(trash, nonce);
		await rename(path, trashedPath);
		try {
			if (artifactsExist) await rename(artifacts, trashedArtifacts);
		} catch (error) {
			await rename(trashedPath, path).catch(() => undefined);
			throw error;
		}
		await syncDirectory(dirname(path));
		await syncDirectory(trash);
		await this.#mutateMetadata(async () => {
			this.#archived.delete(session.sessionId);
			await this.#persist().catch(() => undefined);
		});
		await Promise.all([
			rm(trashedPath, { force: true }),
			artifactsExist ? rm(trashedArtifacts, { recursive: true, force: true }) : Promise.resolve(),
		]);
	}

	async projectRootForProject(project: ProjectId): Promise<string> {
		const roots = new Set((await this.list()).filter(record => record.projectId === project).map(record => record.cwd));
		if (roots.size !== 1) throw new Error("official OMP project root is unavailable");
		return [...roots][0]!;
	}

	async projectRootForSession(id: SessionId): Promise<string> {
		const session = (await this.list()).find(record => record.sessionId === id);
		if (!session) throw new Error("official OMP session root is unavailable");
		return session.cwd;
	}

	lockStatus(): "missing" {
		return "missing";
	}

	async lockCheck(session: SessionRecord): Promise<void> {
		await this.#assertLease();
		await this.#assertOwnedSession(session);
	}

	#assertInitialized(): void {
		if (!this.#initialized || !this.#canonicalRoot) throw new Error("official OMP authority is not initialized");
	}

	async #assertOwnedSession(session: SessionRecord): Promise<string> {
		this.#assertInitialized();
		if (!session.path.endsWith(".jsonl")) throw new Error("official OMP session path is invalid");
		const pathInfo = await lstat(session.path);
		if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) throw new Error("official OMP session path is invalid");
		const canonical = await realpath(session.path);
		const child = relative(this.#canonicalRoot!, canonical);
		if (child === "" || child.startsWith("..") || isAbsolute(child))
			throw new Error("official OMP session is outside the exclusive root");
		return canonical;
	}

	async #assertDiscoveryTree(): Promise<void> {
		for (const entry of await readdir(this.#canonicalRoot!, { withFileTypes: true })) {
			const path = join(this.#canonicalRoot!, entry.name);
			const info = await lstat(path);
			if (info.isSymbolicLink()) throw new Error("official OMP discovery tree contains a symlink");
			if (!info.isDirectory() || entry.name === ".t4-trash") continue;
			if (!entry.name.startsWith("-")) continue;
			await this.#assertOwnedDirectory(path);
			for (const child of await readdir(path, { withFileTypes: true })) {
				const childInfo = await lstat(join(path, child.name));
				if (childInfo.isSymbolicLink()) throw new Error("official OMP discovery tree contains a symlink");
			}
		}
	}

	async #assertLease(): Promise<void> {
		this.#assertInitialized();
		if (!this.#ownerIdentity) throw new Error("official OMP exclusive owner lease is unavailable");
		const ownerPath = join(this.#canonicalRoot!, OWNER_FILE);
		const info = await lstat(ownerPath);
		const record = decodeOwnerRecord(JSON.parse(await readFile(ownerPath, "utf8")));
		if (
			info.isSymbolicLink() ||
			!info.isFile() ||
			info.dev !== this.#ownerIdentity.device ||
			info.ino !== this.#ownerIdentity.inode ||
			record.pid !== this.#owner.pid ||
			record.ownerId !== this.#owner.ownerId
		)
			throw new Error("official OMP exclusive owner lease changed");
	}

	async #acquireLease(): Promise<void> {
		const ownerPath = join(this.#canonicalRoot!, OWNER_FILE);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const temporary = join(this.#canonicalRoot!, `.t4-owner-${this.#owner.ownerId}.tmp`);
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(this.#owner)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			try {
				await link(temporary, ownerPath);
				await syncDirectory(this.#canonicalRoot!);
				const info = await lstat(ownerPath);
				this.#ownerIdentity = { device: info.dev, inode: info.ino };
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const info = await lstat(ownerPath);
				if (info.isSymbolicLink() || !info.isFile()) throw new Error("official OMP owner lease is invalid");
				const existing = decodeOwnerRecord(JSON.parse(await readFile(ownerPath, "utf8")));
				if (processIsAlive(existing.pid)) throw new Error("official OMP sessions root already has a live owner");
				const unchanged = await lstat(ownerPath);
				if (unchanged.dev !== info.dev || unchanged.ino !== info.ino)
					throw new Error("official OMP owner lease changed during recovery");
				await unlink(ownerPath);
				await syncDirectory(this.#canonicalRoot!);
			} finally {
				await unlink(temporary).catch(() => undefined);
			}
		}
		throw new Error("official OMP sessions root owner lease could not be acquired");
	}

	async #assertOwnedDirectory(path: string): Promise<string> {
		this.#assertInitialized();
		const info = await lstat(path);
		const uid = process.getuid?.();
		if (info.isSymbolicLink() || !info.isDirectory() || (uid !== undefined && info.uid !== uid))
			throw new Error("official OMP session directory is unsafe");
		const canonical = await realpath(path);
		const child = relative(this.#canonicalRoot!, canonical);
		if (child === "" || child.startsWith("..") || isAbsolute(child))
			throw new Error("official OMP session directory is outside the exclusive root");
		await chmod(canonical, 0o700);
		return canonical;
	}

	async #persist(): Promise<void> {
		const metadata: OfficialProfileMetadata = { version: 1, archived: Object.fromEntries(this.#archived) };
		const body = `${JSON.stringify(metadata)}\n`;
		if (Buffer.byteLength(body, "utf8") > METADATA_BYTES) throw new Error("official OMP metadata exceeds 1 MiB");
		const temporary = `${this.#metadataPath}.${Bun.randomUUIDv7()}.tmp`;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(body, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.#metadataPath);
			await syncDirectory(dirname(this.#metadataPath));
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	async #mutateMetadata(mutation: () => Promise<void>): Promise<void> {
		const next = this.#metadataMutation.then(mutation);
		this.#metadataMutation = next.catch(() => undefined);
		await next;
	}
}
