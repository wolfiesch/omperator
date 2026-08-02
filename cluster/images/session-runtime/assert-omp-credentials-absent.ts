import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import path from "node:path";

const AUTH_SCHEMA_VERSION = 6;
const AUTH_COLUMNS = [
	"id",
	"provider",
	"credential_type",
	"data",
	"disabled_cause",
	"identity_key",
	"created_at",
	"updated_at",
] as const;
const SETTINGS_COLUMNS = ["key", "value", "updated_at"] as const;
const SECRET_SETTING_KEYS = [
	"auth.broker.token",
	"hindsight.apiToken",
	"searxng.token",
	"dev.autoqaPush.token",
] as const;

type ColumnRow = { name?: unknown };
type CountRow = { count?: unknown };
type VersionRow = { version?: unknown };

function tableExists(database: Database, table: string): boolean {
	const row = database
		.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(table) as { present?: unknown } | null;
	return row?.present === 1;
}

function requireExactColumns(database: Database, table: string, expected: readonly string[]): void {
	const rows = database.query(`PRAGMA table_info(${table})`).all() as ColumnRow[];
	const actual = rows.map(row => row.name);
	if (
		actual.length !== expected.length ||
		actual.some((column, index) => typeof column !== "string" || column !== expected[index])
	) {
		throw new Error(`unsupported ${table} schema`);
	}
}

async function requireDirectory(directoryPath: string): Promise<void> {
	const metadata = await lstat(directoryPath);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error(`OMP profile path must be a real directory: ${path.basename(directoryPath)}`);
	}
}

async function requireDirectoryChain(root: string, child: string): Promise<void> {
	await requireDirectory(root);
	const relativeChild = path.relative(root, child);
	if (
		relativeChild === "" ||
		relativeChild.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeChild)
	) {
		throw new Error("OMP credential check paths are outside the runtime root");
	}
	let current = root;
	for (const segment of relativeChild.split(path.sep)) {
		current = path.join(current, segment);
		await requireDirectory(current);
	}
}

async function requireAbsent(filePath: string): Promise<void> {
	try {
		await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`credential state is present: ${path.basename(filePath)}`);
}

export async function assertOMPProfileCredentialsAbsent(input: {
	readonly agentDir: string;
	readonly home: string;
	readonly runtimeRoot: string;
}): Promise<void> {
	if (!path.isAbsolute(input.agentDir) || !path.isAbsolute(input.home) || !path.isAbsolute(input.runtimeRoot)) {
		throw new Error("OMP credential check paths must be absolute");
	}
	const agentDir = path.resolve(input.agentDir);
	const home = path.resolve(input.home);
	const runtimeRoot = path.resolve(input.runtimeRoot);
	if (home !== path.join(runtimeRoot, "home") || agentDir !== path.join(runtimeRoot, "authority", "agent")) {
		throw new Error("OMP credential check paths do not match the runtime profile layout");
	}
	await Promise.all([requireDirectoryChain(runtimeRoot, home), requireDirectoryChain(runtimeRoot, agentDir)]);

	const databasePath = path.join(agentDir, "agent.db");
	const tokenPath = path.join(home, ".omp", "auth-broker.token");
	const cachePath = path.join(home, ".omp", "cache");
	const snapshotPath = path.join(cachePath, "auth-broker-snapshot.enc");
	await requireAbsent(tokenPath);
	try {
		await requireDirectory(cachePath);
		await requireAbsent(snapshotPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}

	let databaseMetadata;
	try {
		databaseMetadata = await lstat(databasePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) await requireAbsent(sidecar);
		return;
	}
	if (!databaseMetadata.isFile() || databaseMetadata.isSymbolicLink()) {
		throw new Error("agent.db must be a regular file");
	}

	const database = new Database(databasePath, { create: false, readonly: true });
	try {
		if (tableExists(database, "auth_credentials")) {
			requireExactColumns(database, "auth_credentials", AUTH_COLUMNS);
			if (!tableExists(database, "auth_schema_version")) throw new Error("auth schema version is missing");
			requireExactColumns(database, "auth_schema_version", ["id", "version"]);
			const version = database.query("SELECT version FROM auth_schema_version WHERE id = 1").get() as VersionRow | null;
			if (version?.version !== AUTH_SCHEMA_VERSION) throw new Error("unsupported auth schema version");
			const count = database.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as CountRow;
			if (typeof count.count !== "number" || count.count !== 0) {
				throw new Error("OMP auth credentials must be absent");
			}
		}
		if (tableExists(database, "settings")) {
			requireExactColumns(database, "settings", SETTINGS_COLUMNS);
			const placeholders = SECRET_SETTING_KEYS.map(() => "?").join(", ");
			const count = database
				.query(`SELECT COUNT(*) AS count FROM settings WHERE key IN (${placeholders})`)
				.get(...SECRET_SETTING_KEYS) as CountRow;
			if (typeof count.count !== "number" || count.count !== 0) {
				throw new Error("OMP secret settings must be absent");
			}
		}
	} finally {
		database.close();
	}
}

if (import.meta.main) {
	const [agentDir, home, runtimeRoot] = process.argv.slice(2);
	if (!agentDir || !home || !runtimeRoot) throw new Error("usage: assert-omp-credentials-absent <agent-dir> <home> <runtime-root>");
	await assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot });
	process.stdout.write(JSON.stringify({ component: "session-runtime", result: "credential_state_absent" }) + "\n");
}
