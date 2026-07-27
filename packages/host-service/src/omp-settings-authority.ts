// omp-settings-authority.ts — settings.read/settings.write against the OMP
// profile's real stores on an official host.
//
// Schema (verified against oh-my-pi v17.0.9 sources):
//   ~/.omp/config.yml      — primary settings store (YAML). modelRoles,
//                            defaultThinkingLevel, tools.approvalMode,
//                            enabledModels, disabledProviders, cycleOrder.
//   ~/.omp/agent/agent.db  — auth_credentials table holds provider keys as
//                            JSON plaintext in `data` ({key, source}).
//
// Reads mask secrets (sk-…last4); writes replace them wholesale. The file
// revision is a content hash so concurrent writers conflict loudly instead of
// silently last-write-winning. Unknown config.yml keys round-trip untouched —
// omp owns the schema, we only touch the paths listed above.
import { createHash } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CommandResult } from "@t4-code/host-wire";
import type { OperationContext } from "./operations/dispatcher.ts";

export interface OmpSettingsAuthorityOptions {
	/** Directory holding config.yml; defaults to ~/.omp. */
	readonly ompRoot?: string;
	/** agent.db path; defaults to <ompRoot>/agent/agent.db. */
	readonly agentDbPath?: string;
}

/** Settings keys this authority exposes/writes. Everything else is left alone. */
const CONFIG_KEYS = [
	"modelRoles",
	"defaultThinkingLevel",
	"enabledModels",
	"disabledProviders",
	"cycleOrder",
] as const;

function maskSecret(value: unknown): string {
	const text = String(value ?? "");
	if (text.length <= 8) return "…";
	return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

export class OmpSettingsAuthority {
	readonly #configPath: string;
	readonly #agentDbPath: string;

	constructor(options: OmpSettingsAuthorityOptions = {}) {
		const root = options.ompRoot ?? join(homedir(), ".omp");
		this.#configPath = join(root, "config.yml");
		this.#agentDbPath = options.agentDbPath ?? join(root, "agent", "agent.db");
	}

	// ── config.yml ──────────────────────────────────────────────────────
	async #readConfig(): Promise<{ doc: Record<string, unknown>; revision: string }> {
		let text = "";
		try {
			text = await readFile(this.#configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const parsed = text ? parseYaml(text) : undefined;
		const doc = parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
		return { doc, revision: createHash("sha256").update(text).digest("hex").slice(0, 16) };
	}

	async #writeConfig(doc: Record<string, unknown>): Promise<void> {
		const text = stringifyYaml(doc, { indent: 2 });
		const tmp = `${this.#configPath}.tmp`;
		const handle = await open(tmp, "w", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, this.#configPath);
	}

	// ── agent.db auth_credentials ────────────────────────────────────────
	#openDb(): DatabaseSync {
		return new DatabaseSync(this.#agentDbPath);
	}

	#readProviderKeys(): Record<string, string> {
		try {
			const db = this.#openDb();
			try {
				const rows = db
					.prepare("SELECT provider, credential_type, data FROM auth_credentials ORDER BY provider")
					.all() as { provider: string; credential_type: string; data: string }[];
				const out: Record<string, string> = {};
				for (const row of rows) {
					let secret: unknown;
					try {
						const data = JSON.parse(row.data) as Record<string, unknown>;
						secret = data.key ?? data.access_token;
					} catch {
						secret = undefined;
					}
					out[row.provider] = maskSecret(secret);
				}
				return out;
			} finally {
				db.close();
			}
		} catch {
			// A missing/corrupt agent.db means "no keys yet", not a settings failure.
			return {};
		}
	}

	#writeProviderKey(provider: string, key: string): void {
		if (!/^[A-Za-z0-9._-]{1,64}$/u.test(provider)) throw new Error("provider name is invalid");
		const db = this.#openDb();
		try {
			const now = Date.now();
			const data = JSON.stringify({ key, source: "settings" });
			// auth_credentials has no unique constraint on (provider, type) —
			// upsert by hand.
			const existing = db
				.prepare("SELECT id FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key'")
				.get(provider) as { id: number } | undefined;
			if (existing)
				db.prepare("UPDATE auth_credentials SET data = ?, updated_at = ? WHERE id = ?").run(data, now, existing.id);
			else
				db.prepare(
					"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, 'api_key', ?, ?, ?)",
				).run(provider, data, now, now);
		} finally {
			db.close();
		}
	}

	// ── operations ──────────────────────────────────────────────────────
	async settingsRead(): Promise<CommandResult> {
		const { doc, revision } = await this.#readConfig();
		const settings: Record<string, unknown> = {};
		for (const key of CONFIG_KEYS) if (doc[key] !== undefined) settings[key] = doc[key];
		const tools = doc.tools;
		if (tools && typeof tools === "object" && !Array.isArray(tools)) {
			const approvalMode = (tools as Record<string, unknown>).approvalMode;
			if (approvalMode !== undefined) settings["tools.approvalMode"] = approvalMode;
			const approval = (tools as Record<string, unknown>).approval;
			if (approval !== undefined) settings["tools.approval"] = approval;
		}
		settings.providerKeys = this.#readProviderKeys();
		return { settings, revision };
	}

	async settingsWrite(args: CommandResult, context: OperationContext): Promise<CommandResult> {
		const patch = (args.settings ?? args) as Record<string, unknown>;
		const { doc, revision } = await this.#readConfig();
		// The dispatcher enforces revision-required; the challenge carries our
		// current revision, so a concurrent change fails here instead of
		// clobbering.
		if (typeof context.expectedRevision === "string" && context.expectedRevision !== revision)
			throw new Error(`settings revision conflict: expected ${context.expectedRevision}, current ${revision}`);

		const next: Record<string, unknown> = { ...doc };
		for (const key of CONFIG_KEYS) {
			if (patch[key] !== undefined) next[key] = patch[key];
		}
		if (patch["tools.approvalMode"] !== undefined || patch["tools.approval"] !== undefined) {
			const tools = { ...((next.tools as Record<string, unknown>) ?? {}) };
			if (patch["tools.approvalMode"] !== undefined) tools.approvalMode = patch["tools.approvalMode"];
			if (patch["tools.approval"] !== undefined) tools.approval = patch["tools.approval"];
			next.tools = tools;
		}
		const providerKeys = patch.providerKeys;
		if (providerKeys && typeof providerKeys === "object" && !Array.isArray(providerKeys)) {
			for (const [provider, key] of Object.entries(providerKeys as Record<string, unknown>)) {
				if (typeof key !== "string" || key.length < 8) throw new Error(`provider key for ${provider} is invalid`);
				this.#writeProviderKey(provider, key);
			}
		}
		await this.#writeConfig(next);
		const { revision: newRevision } = await this.#readConfig();
		return { written: true, revision: newRevision };
	}

	operations() {
		return {
			settingsRead: () => this.settingsRead(),
			settingsWrite: (args: CommandResult, context: OperationContext) => this.settingsWrite(args, context),
		};
	}
}
