import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "../src/operations/dispatcher.ts";
import { OmpSettingsAuthority } from "../src/omp-settings-authority.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "t4-settings-atomic-"));
	roots.push(root);
	const agent = join(root, "agent");
	await mkdir(agent);
	await writeFile(join(root, "config.yml"), "defaultThinkingLevel: medium\n", { mode: 0o600 });
	const databasePath = join(agent, "agent.db");
	const db = new Database(databasePath);
	db.run(`
		CREATE TABLE auth_credentials (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			provider TEXT NOT NULL,
			credential_type TEXT NOT NULL,
			data TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
	db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, 'api_key', ?, 1, 1)",
	).run("openai", JSON.stringify({ key: "sk-original-key" }));
	db.close();
	return {
		root,
		databasePath,
		authority: new OmpSettingsAuthority({ ompRoot: root, agentDbPath: databasePath }),
	};
}

function context(expectedRevision?: string): OperationContext {
	return {
		hostId: "settings-host" as never,
		deviceId: "settings-device",
		connectionId: "settings-connection",
		capabilities: new Set(["config.write"]),
		abortSignal: new AbortController().signal,
		...(expectedRevision ? { expectedRevision: expectedRevision as never } : {}),
	};
}

describe("atomic OMP settings authority", () => {
	test("provider-only writes advance the shared revision and reject stale writers", async () => {
		const { authority, databasePath } = await fixture();
		const before = await authority.settingsRead();
		const revision = String(before.revision);
		const written = await authority.settingsWrite(
			{ settings: { providerKeys: { openai: "sk-replacement-key" } } } as never,
			context(revision),
		);
		expect(written.revision).not.toBe(revision);

		await expect(
			authority.settingsWrite(
				{ settings: { providerKeys: { openai: "sk-stale-writer-key" } } } as never,
				context(revision),
			),
		).rejects.toThrow("revision conflict");
		const db = new Database(databasePath, { readonly: true });
		const row = db
			.prepare("SELECT data FROM auth_credentials WHERE provider = 'openai' AND credential_type = 'api_key'")
			.get() as { data: string };
		db.close();
		expect(JSON.parse(row.data).key).toBe("sk-replacement-key");
	});

	test("validates the full provider patch before mutating either store", async () => {
		const { authority, databasePath, root } = await fixture();
		const before = await authority.settingsRead();
		const configBefore = await readFile(join(root, "config.yml"), "utf8");
		await expect(
			authority.settingsWrite(
				{
					settings: {
						defaultThinkingLevel: "high",
						providerKeys: {
							openai: "sk-would-have-changed",
							"bad provider": "sk-invalid-provider",
						},
					},
				} as never,
				context(String(before.revision)),
			),
		).rejects.toThrow("provider key");
		expect(await readFile(join(root, "config.yml"), "utf8")).toBe(configBefore);
		const db = new Database(databasePath, { readonly: true });
		const row = db.prepare("SELECT data FROM auth_credentials WHERE provider = 'openai'").get() as {
			data: string;
		};
		db.close();
		expect(JSON.parse(row.data).key).toBe("sk-original-key");
		expect(await Bun.file(join(root, ".settings-write-journal.json")).exists()).toBe(false);
	});
});
