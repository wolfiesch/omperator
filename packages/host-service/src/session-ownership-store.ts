import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type SessionId, sessionId } from "@t4-code/host-wire";

const LEDGER_VERSION = 1;
const MAX_SESSIONS = 10_000;
const MAX_LEDGER_BYTES = 3 * 1024 * 1024;
const MAX_PATH_BYTES = 16 * 1024;

interface OwnedSessionRecord {
	readonly sessionId: SessionId;
	readonly path: string;
}

interface SessionOwnershipLedger {
	readonly version: typeof LEDGER_VERSION;
	readonly sessions: readonly OwnedSessionRecord[];
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	return keys.length === expected.length && [...expected].sort().every((key, index) => keys[index] === key);
}

function decodeRecord(value: unknown): OwnedSessionRecord | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["sessionId", "path"]) || typeof record.path !== "string") return undefined;
	if (!path.isAbsolute(record.path) || Buffer.byteLength(record.path, "utf8") > MAX_PATH_BYTES) return undefined;
	try {
		return { sessionId: sessionId(record.sessionId, "sessions[].sessionId"), path: record.path };
	} catch {
		return undefined;
	}
}

function decodeLedger(value: unknown): SessionOwnershipLedger | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const ledger = value as Record<string, unknown>;
	if (!exactKeys(ledger, ["version", "sessions"]) || ledger.version !== LEDGER_VERSION) return undefined;
	if (!Array.isArray(ledger.sessions) || ledger.sessions.length > MAX_SESSIONS) return undefined;
	const sessions: OwnedSessionRecord[] = [];
	const seen = new Set<SessionId>();
	for (const value of ledger.sessions) {
		const record = decodeRecord(value);
		if (!record || seen.has(record.sessionId)) return undefined;
		seen.add(record.sessionId);
		sessions.push(record);
	}
	return { version: LEDGER_VERSION, sessions };
}

/** Private profile-local proof that a session was created through this T4 host profile. */
export class SessionOwnershipStore {
	readonly path: string;
	#sessions = new Map<SessionId, string>();
	#tail = Promise.resolve();
	constructor(filePath: string) {
		this.path = filePath;
	}
	async load(): Promise<void> {
		this.#sessions.clear();
		let metadata: Awaited<ReturnType<typeof fs.lstat>>;
		try {
			metadata = await fs.lstat(this.path);
		} catch {
			return;
		}
		if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_LEDGER_BYTES) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await Bun.file(this.path).text()) as unknown;
		} catch {
			return;
		}
		const ledger = decodeLedger(parsed);
		if (!ledger) return;
		this.#sessions = new Map(ledger.sessions.map(record => [record.sessionId, record.path]));
	}
	owns(id: SessionId, transcriptPath: string): boolean {
		return this.#sessions.get(id) === transcriptPath;
	}
	add(id: SessionId, transcriptPath: string): Promise<void> {
		if (!path.isAbsolute(transcriptPath) || Buffer.byteLength(transcriptPath, "utf8") > MAX_PATH_BYTES)
			return Promise.reject(new Error("owned session path must be a bounded absolute path"));
		const operation = this.#tail.catch(() => undefined).then(async () => {
			if (!this.#sessions.has(id) && this.#sessions.size >= MAX_SESSIONS)
				throw new Error("owned session ledger is full");
			const previous = this.#sessions.get(id);
			this.#sessions.set(id, transcriptPath);
			try {
				await this.#write(this.#ledger());
			} catch (error) {
				if (previous === undefined) this.#sessions.delete(id);
				else this.#sessions.set(id, previous);
				throw error;
			}
		});
		this.#tail = operation;
		return operation;
	}
	delete(id: SessionId): Promise<void> {
		const operation = this.#tail.catch(() => undefined).then(async () => {
			const previous = this.#sessions.get(id);
			if (previous === undefined) return;
			this.#sessions.delete(id);
			try {
				await this.#write(this.#ledger());
			} catch (error) {
				this.#sessions.set(id, previous);
				throw error;
			}
		});
		this.#tail = operation;
		return operation;
	}
	async flush(): Promise<void> {
		await this.#tail;
	}
	#ledger(): SessionOwnershipLedger {
		return {
			version: LEDGER_VERSION,
			sessions: [...this.#sessions]
				.map(([id, transcriptPath]) => ({ sessionId: id, path: transcriptPath }))
				.sort((left, right) => left.sessionId.localeCompare(right.sessionId)),
		};
	}
	async #write(ledger: SessionOwnershipLedger): Promise<void> {
		const directory = path.dirname(this.path);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		await fs.chmod(directory, 0o700);
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		try {
			const handle = await fs.open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(ledger)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await fs.rename(temporary, this.path);
			await fs.chmod(this.path, 0o600);
		} catch (error) {
			await fs.unlink(temporary).catch(() => undefined);
			throw error;
		}
	}
}
