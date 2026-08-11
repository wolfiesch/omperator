import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertOMPProfileCredentialsAbsent } from "./assert-omp-credentials-absent";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; runtimeRoot: string; home: string; agentDir: string; databasePath: string }> {
	const root = await mkdtemp(path.join(tmpdir(), "t4-omp-credential-check-"));
	roots.push(root);
	const runtimeRoot = path.join(root, "runtime-live-proof");
	const home = path.join(runtimeRoot, "home");
	const agentDir = path.join(runtimeRoot, "authority", "agent");
	await Promise.all([mkdir(home, { recursive: true }), mkdir(agentDir, { recursive: true })]);
	return { root, runtimeRoot, home, agentDir, databasePath: path.join(agentDir, "agent.db") };
}

function createPinnedSchema(databasePath: string): Database {
	const database = new Database(databasePath);
	database.run(`
		CREATE TABLE auth_schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
		INSERT INTO auth_schema_version(id, version) VALUES (1, 6);
		CREATE TABLE auth_credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL,
			credential_type TEXT NOT NULL,
			data TEXT NOT NULL,
			disabled_cause TEXT DEFAULT NULL,
			identity_key TEXT DEFAULT NULL,
			created_at INTEGER NOT NULL DEFAULT 0,
			updated_at INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
		CREATE TABLE history (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
	`);
	return database;
}

describe("OMP durable credential preflight", () => {
	test("accepts the pinned schema only when credential state is absent", async () => {
		const { runtimeRoot, home, agentDir, databasePath } = await fixture();
		const database = createPinnedSchema(databasePath);
		database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run("theme", JSON.stringify("dark"));
		database.query("INSERT INTO history(id, value) VALUES (?, ?)").run(1, "unrelated session state");
		database.close();

		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).resolves.toBeUndefined();
		const verified = new Database(databasePath, { create: false, readonly: true });
		expect(verified.query("SELECT value FROM settings WHERE key = 'theme'").get()).toEqual({ value: '"dark"' });
		expect(verified.query("SELECT value FROM history WHERE id = 1").get()).toEqual({ value: "unrelated session state" });
		verified.close();
	});

	test("rejects credential rows without mutating them", async () => {
		const { runtimeRoot, home, agentDir, databasePath } = await fixture();
		const database = createPinnedSchema(databasePath);
		database.query("INSERT INTO auth_credentials(provider, credential_type, data) VALUES (?, ?, ?)").run(
			"anthropic",
			"api_key",
			JSON.stringify({ key: "must-remain-until-an-operator-removes-it" }),
		);
		database.close();

		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).rejects.toThrow(
			"OMP auth credentials must be absent",
		);
		const verified = new Database(databasePath, { create: false, readonly: true });
		expect((verified.query("SELECT COUNT(*) AS count FROM auth_credentials").get() as { count: number }).count).toBe(1);
		verified.close();
	});

	test("rejects secret settings and broker files without deleting them", async () => {
		const { runtimeRoot, home, agentDir, databasePath } = await fixture();
		const database = createPinnedSchema(databasePath);
		database.query("INSERT INTO settings(key, value) VALUES (?, ?)").run("auth.broker.token", "present");
		database.close();
		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).rejects.toThrow(
			"OMP secret settings must be absent",
		);

		const tokenPath = path.join(home, ".omp", "auth-broker.token");
		await mkdir(path.dirname(tokenPath), { recursive: true });
		await writeFile(tokenPath, "present", { mode: 0o600 });
		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).rejects.toThrow(
			"credential state is present: auth-broker.token",
		);
	});

	test("fails closed for unknown schemas and symlinked profile directories", async () => {
		const { root, runtimeRoot, home, agentDir, databasePath } = await fixture();
		const database = new Database(databasePath);
		database.run("CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
		database.close();
		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).rejects.toThrow(
			"unsupported auth_credentials schema",
		);

		const linkedRuntimeRoot = path.join(root, "linked-runtime");
		await symlink(runtimeRoot, linkedRuntimeRoot);
		await expect(
			assertOMPProfileCredentialsAbsent({
				agentDir: path.join(linkedRuntimeRoot, "authority", "agent"),
				home: path.join(linkedRuntimeRoot, "home"),
				runtimeRoot: linkedRuntimeRoot,
			}),
		).rejects.toThrow("OMP profile path must be a real directory");
	});

	test("rejects a symlinked broker cache without following it", async () => {
		const { root, runtimeRoot, home, agentDir } = await fixture();
		const outsideCache = path.join(root, "outside-cache");
		await Promise.all([mkdir(outsideCache), mkdir(path.join(home, ".omp"))]);
		await symlink(outsideCache, path.join(home, ".omp", "cache"));

		await expect(assertOMPProfileCredentialsAbsent({ agentDir, home, runtimeRoot })).rejects.toThrow(
			"OMP profile path must be a real directory: cache",
		);
	});
});
