import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { OmpSettingsAuthority } from "../src/omp-settings-authority.ts";
import type { OperationContext } from "../src/operations/dispatcher.ts";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "t4-omp-settings-"));
	const agent = join(root, "agent");
	const databasePath = join(agent, "agent.db");
	await mkdir(agent, { recursive: true });
	await writeFile(
		join(root, "config.yml"),
		[
			"unknownSetting: preserved",
			"defaultThinkingLevel: high",
			"modelRoles:",
			"  default: openai/gpt-5",
			"tools:",
			"  approvalMode: write",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	const database = new Database(databasePath);
	database.run(
		"CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, credential_type TEXT, data TEXT, created_at INTEGER, updated_at INTEGER)",
	);
	database
		.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, 'api_key', ?, 1, 1)",
		)
		.run("openai", JSON.stringify({ key: "sk-existing-secret", source: "test" }));
	database.close();
	return {
		root,
		databasePath,
		authority: new OmpSettingsAuthority({ ompRoot: root, agentDbPath: databasePath }),
	};
}

test("official settings reads wire-safe metadata and masks provider secrets", async () => {
	const { authority } = await fixture();
	const result = await authority.settingsRead();

	expect(result.settings).toMatchObject({
		defaultThinkingLevel: { type: "string", effective: "high" },
		modelRoles: { type: "map", effective: { default: "openai/gpt-5" } },
		"tools.approvalMode": {
			type: "enum",
			effective: "write",
			options: ["always-ask", "write", "yolo"],
		},
		providerKeys: {
			type: "map",
			effective: {
				openai: { type: "string", effective: "sk-…cret" },
			},
		},
	});
	expect(String(JSON.stringify(result.settings))).not.toContain("sk-existing-secret");
	expect(result.revision).toMatch(/^[a-f0-9]{16}$/u);
});

test("official settings writes preserve unknown config and update provider credentials", async () => {
	const { authority, databasePath, root } = await fixture();
	const before = await authority.settingsRead();
	const context = { expectedRevision: before.revision } as OperationContext;
	const written = await authority.settingsWrite(
		{
			settings: {
				defaultThinkingLevel: "xhigh",
				"tools.approvalMode": "always-ask",
				providerKeys: { anthropic: "sk-ant-new-secret" },
			},
		},
		context,
	);

	expect(written).toMatchObject({ written: true });
	expect(written.revision).not.toBe(before.revision);
	const config = parseYaml(await readFile(join(root, "config.yml"), "utf8")) as Record<string, unknown>;
	expect(config.unknownSetting).toBe("preserved");
	expect(config.defaultThinkingLevel).toBe("xhigh");
	expect(config.tools).toMatchObject({ approvalMode: "always-ask" });

	const database = new Database(databasePath, { readonly: true });
	const row = database
		.prepare("SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key'")
		.get("anthropic") as { data: string };
	database.close();
	expect(JSON.parse(row.data)).toEqual({ key: "sk-ant-new-secret", source: "settings" });

	const after = await authority.settingsRead();
	expect(after.settings).toMatchObject({
		providerKeys: {
			effective: {
				anthropic: { effective: "sk-…cret" },
			},
		},
	});
});

test("official settings reject stale revisions before mutating config", async () => {
	const { authority, root } = await fixture();
	const before = await readFile(join(root, "config.yml"), "utf8");

	await expect(
		authority.settingsWrite(
			{ settings: { defaultThinkingLevel: "off" } },
			{ expectedRevision: "stale-revision" } as OperationContext,
		),
	).rejects.toThrow("settings revision conflict");
	expect(await readFile(join(root, "config.yml"), "utf8")).toBe(before);
});
