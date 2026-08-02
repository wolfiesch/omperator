import { chmodSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
	SharedControlLedgerConflictError,
	SharedControlLedgerUnavailableError,
	type SharedControlLedgerSnapshot,
	type SharedControlLedgerState,
	type SharedControlLedgerStorage,
} from "./shared-control-store.ts";

const MAX_STATE_BYTES = 768 * 1024;
const encoder = new TextEncoder();

/** SQLite CAS storage for a SharedControlStore used by multiple local driver processes. */
export class SqliteSharedControlLedgerStorage implements SharedControlLedgerStorage {
	readonly #database: Database;
	constructor(databasePath: string, busyTimeoutMilliseconds = 5_000) {
		if (!databasePath || databasePath.length > 4_096) throw new TypeError("databasePath is invalid");
		if (!Number.isSafeInteger(busyTimeoutMilliseconds) || busyTimeoutMilliseconds < 1 || busyTimeoutMilliseconds > 60_000)
			throw new TypeError("busyTimeoutMilliseconds is invalid");
		this.#database = new Database(databasePath, { create: true, strict: true });
		if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
		this.#database.run(`PRAGMA busy_timeout = ${busyTimeoutMilliseconds}`);
		this.#database.run("PRAGMA journal_mode = WAL");
		this.#database.run("CREATE TABLE IF NOT EXISTS shared_control_ledger(singleton INTEGER PRIMARY KEY CHECK(singleton=1),resource_version INTEGER NOT NULL CHECK(resource_version>=1),state TEXT NOT NULL)");
	}
	async read(): Promise<SharedControlLedgerSnapshot | undefined> {
		try {
			const row = this.#database.query("SELECT resource_version,state FROM shared_control_ledger WHERE singleton=1").get() as Record<string, unknown> | null;
			if (!row) return undefined;
			return this.#snapshot(row);
		} catch (error) {
			if (error instanceof SharedControlLedgerUnavailableError) throw error;
			throw new SharedControlLedgerUnavailableError();
		}
	}
	async create(state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		const serialized = this.#serialized(state);
		try {
			this.#database.run("INSERT INTO shared_control_ledger(singleton,resource_version,state) VALUES (1,1,?)", [serialized]);
			return { resourceVersion: "1", state: structuredClone(state) };
		} catch (error) {
			if (String(error).includes("UNIQUE constraint failed")) throw new SharedControlLedgerConflictError();
			throw new SharedControlLedgerUnavailableError();
		}
	}
	async replace(resourceVersion: string, state: SharedControlLedgerState): Promise<SharedControlLedgerSnapshot> {
		if (!/^[1-9][0-9]{0,15}$/u.test(resourceVersion)) throw new SharedControlLedgerUnavailableError();
		const current = Number(resourceVersion);
		if (!Number.isSafeInteger(current) || current === Number.MAX_SAFE_INTEGER) throw new SharedControlLedgerUnavailableError();
		const serialized = this.#serialized(state);
		try {
			const result = this.#database.run("UPDATE shared_control_ledger SET resource_version=?,state=? WHERE singleton=1 AND resource_version=?", [current + 1, serialized, current]);
			if (result.changes !== 1) throw new SharedControlLedgerConflictError();
			return { resourceVersion: String(current + 1), state: structuredClone(state) };
		} catch (error) {
			if (error instanceof SharedControlLedgerConflictError) throw error;
			throw new SharedControlLedgerUnavailableError();
		}
	}
	close(): void { this.#database.close(false); }
	#serialized(state: SharedControlLedgerState): string {
		const value = JSON.stringify(state);
		if (encoder.encode(value).byteLength > MAX_STATE_BYTES) throw new SharedControlLedgerUnavailableError();
		return value;
	}
	#snapshot(row: Record<string, unknown>): SharedControlLedgerSnapshot {
		const resourceVersion = Number(row.resource_version);
		if (!Number.isSafeInteger(resourceVersion) || resourceVersion < 1 || typeof row.state !== "string" || encoder.encode(row.state).byteLength > MAX_STATE_BYTES)
			throw new SharedControlLedgerUnavailableError();
		try { return { resourceVersion: String(resourceVersion), state: JSON.parse(row.state) as SharedControlLedgerState }; }
		catch { throw new SharedControlLedgerUnavailableError(); }
	}
}
