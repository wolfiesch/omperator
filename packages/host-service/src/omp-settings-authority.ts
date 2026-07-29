// settings.read/settings.write against OMP's config.yml and agent.db.
//
// The two stores are serialized behind one authority lock and one revision.
// A private journal records the exact pre-write state before either store is
// mutated; any interrupted write is rolled back on the next read or write.
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CommandResult } from "@t4-code/host-wire";
import type { OperationContext } from "./operations/dispatcher.ts";

export interface OmpSettingsAuthorityOptions {
	readonly ompRoot?: string;
	readonly agentDbPath?: string;
}

const CONFIG_KEYS = [
	"modelRoles",
	"defaultThinkingLevel",
	"enabledModels",
	"disabledProviders",
	"cycleOrder",
] as const;

interface ProviderRow {
	readonly id: number;
	readonly provider: string;
	readonly credential_type: string;
	readonly data: string;
	readonly created_at: number;
	readonly updated_at: number;
}

interface SettingsJournal {
	readonly version: 1;
	readonly configText: string;
	readonly providers: readonly {
		readonly provider: string;
		readonly rows: readonly ProviderRow[];
	}[];
}

function maskSecret(value: unknown): string {
	const text = String(value ?? "");
	if (text.length <= 8) return "…";
	return `${text.slice(0, 3)}…${text.slice(-4)}`;
}

function parseConfig(text: string): Record<string, unknown> {
	const parsed = text ? parseYaml(text) : undefined;
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: {};
}

export class OmpSettingsAuthority {
	readonly #configPath: string;
	readonly #agentDbPath: string;
	readonly #journalPath: string;
	#lockTail: Promise<void> = Promise.resolve();

	constructor(options: OmpSettingsAuthorityOptions = {}) {
		const root = options.ompRoot ?? join(homedir(), ".omp");
		this.#configPath = join(root, "config.yml");
		this.#agentDbPath = options.agentDbPath ?? join(root, "agent", "agent.db");
		this.#journalPath = join(root, ".settings-write-journal.json");
	}

	async #locked<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#lockTail;
		const gate = Promise.withResolvers<void>();
		this.#lockTail = previous.then(() => gate.promise);
		await previous;
		try {
			return await operation();
		} finally {
			gate.resolve();
		}
	}

	async #readConfigText(): Promise<string> {
		try {
			return await readFile(this.#configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	async #writeAtomic(path: string, text: string): Promise<void> {
		const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, path);
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	#openDb(): Database {
		return new Database(this.#agentDbPath);
	}

	#providerRows(db: Database): ProviderRow[] {
		return db
			.prepare(
				"SELECT id, provider, credential_type, data, created_at, updated_at FROM auth_credentials ORDER BY provider, credential_type, id",
			)
			.all() as ProviderRow[];
	}

	#revision(configText: string, providerRows: readonly ProviderRow[]): string {
		const credentials = providerRows.map(row => [
			row.id,
			row.provider,
			row.credential_type,
			row.data,
			row.created_at,
			row.updated_at,
		]);
		return createHash("sha256")
			.update(configText)
			.update("\0")
			.update(JSON.stringify(credentials))
			.digest("hex")
			.slice(0, 16);
	}

	#maskedProviderKeys(rows: readonly ProviderRow[]): Record<string, string> {
		const output: Record<string, string> = {};
		for (const row of rows) {
			if (row.credential_type !== "api_key") continue;
			let secret: unknown;
			try {
				const data = JSON.parse(row.data) as Record<string, unknown>;
				secret = data.key ?? data.access_token;
			} catch {
				secret = undefined;
			}
			output[row.provider] = maskSecret(secret);
		}
		return output;
	}

	async #writeJournal(journal: SettingsJournal): Promise<void> {
		await this.#writeAtomic(this.#journalPath, `${JSON.stringify(journal)}\n`);
	}

	async #readJournal(): Promise<SettingsJournal | undefined> {
		let text: string;
		try {
			text = await readFile(this.#journalPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value = JSON.parse(text) as SettingsJournal;
		if (value.version !== 1 || typeof value.configText !== "string" || !Array.isArray(value.providers))
			throw new Error("settings recovery journal is malformed");
		return value;
	}

	#restoreProviders(db: Database, journal: SettingsJournal): void {
		for (const snapshot of journal.providers) {
			if (!/^[A-Za-z0-9._-]{1,64}$/u.test(snapshot.provider) || !Array.isArray(snapshot.rows))
				throw new Error("settings recovery journal is malformed");
			db.prepare("DELETE FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key'").run(
				snapshot.provider,
			);
			for (const row of snapshot.rows) {
				db.prepare(
					"INSERT INTO auth_credentials (id, provider, credential_type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
				).run(row.id, row.provider, row.credential_type, row.data, row.created_at, row.updated_at);
			}
		}
	}

	async #recoverJournal(): Promise<void> {
		const journal = await this.#readJournal();
		if (!journal) return;
		const db = this.#openDb();
		db.run("BEGIN IMMEDIATE");
		try {
			this.#restoreProviders(db, journal);
			await this.#writeAtomic(this.#configPath, journal.configText);
			db.run("COMMIT");
			await unlink(this.#journalPath);
		} catch (error) {
			try {
				db.run("ROLLBACK");
			} catch {}
			throw error;
		} finally {
			db.close();
		}
	}

	async settingsRead(): Promise<CommandResult> {
		return this.#locked(async () => {
			await this.#recoverJournal();
			const configText = await this.#readConfigText();
			const doc = parseConfig(configText);
			let providerRows: ProviderRow[];
			const db = this.#openDb();
			try {
				providerRows = this.#providerRows(db);
			} finally {
				db.close();
			}
			const settings: Record<string, unknown> = {};
			for (const key of CONFIG_KEYS) {
				if (doc[key] === undefined) continue;
				settings[key] = {
					type: Array.isArray(doc[key]) ? "list" : typeof doc[key] === "object" ? "map" : "string",
					effective: doc[key],
				};
			}
			const tools = doc.tools;
			if (tools && typeof tools === "object" && !Array.isArray(tools)) {
				const approvalMode = (tools as Record<string, unknown>).approvalMode;
				if (approvalMode !== undefined)
					settings["tools.approvalMode"] = {
						type: "enum",
						effective: approvalMode,
						options: ["always-ask", "write", "yolo"],
					};
				const approval = (tools as Record<string, unknown>).approval;
				if (approval !== undefined) settings["tools.approval"] = { type: "map", effective: approval };
			}
			const keys = this.#maskedProviderKeys(providerRows);
			if (Object.keys(keys).length > 0) {
				settings.providerKeys = {
					type: "map",
					effective: Object.fromEntries(
						Object.entries(keys).map(([provider, masked]) => [
							provider,
							{ type: "string", effective: masked },
						]),
					),
				};
			}
			return { settings, revision: this.#revision(configText, providerRows) };
		});
	}

	async settingsWrite(args: CommandResult, context: OperationContext): Promise<CommandResult> {
		return this.#locked(async () => {
			await this.#recoverJournal();
			const patch = (args.settings ?? args) as Record<string, unknown>;
			const configText = await this.#readConfigText();
			const doc = parseConfig(configText);
			const db = this.#openDb();
			let providerRows: ProviderRow[];
			try {
				providerRows = this.#providerRows(db);
			} catch (error) {
				db.close();
				throw error;
			}
			const revision = this.#revision(configText, providerRows);
			if (typeof context.expectedRevision === "string" && context.expectedRevision !== revision) {
				db.close();
				throw new Error(`settings revision conflict: expected ${context.expectedRevision}, current ${revision}`);
			}

			const next: Record<string, unknown> = { ...doc };
			for (const key of CONFIG_KEYS) if (patch[key] !== undefined) next[key] = patch[key];
			if (patch["tools.approvalMode"] !== undefined || patch["tools.approval"] !== undefined) {
				const tools = { ...(next.tools as Record<string, unknown> | undefined) };
				if (patch["tools.approvalMode"] !== undefined) tools.approvalMode = patch["tools.approvalMode"];
				if (patch["tools.approval"] !== undefined) tools.approval = patch["tools.approval"];
				next.tools = tools;
			}
			const providerPatch: Record<string, string> = {};
			if (patch.providerKeys !== undefined) {
				if (!patch.providerKeys || typeof patch.providerKeys !== "object" || Array.isArray(patch.providerKeys)) {
					db.close();
					throw new Error("providerKeys must be a map");
				}
				for (const [provider, key] of Object.entries(patch.providerKeys as Record<string, unknown>)) {
					if (!/^[A-Za-z0-9._-]{1,64}$/u.test(provider) || typeof key !== "string" || key.length < 8) {
						db.close();
						throw new Error(`provider key for ${provider} is invalid`);
					}
					providerPatch[provider] = key;
				}
			}
			const affected = Object.keys(providerPatch);
			const journal: SettingsJournal = {
				version: 1,
				configText,
				providers: affected.map(provider => ({
					provider,
					rows: providerRows.filter(
						row => row.provider === provider && row.credential_type === "api_key",
					),
				})),
			};
			try {
				await this.#writeJournal(journal);
				db.run("BEGIN IMMEDIATE");
			} catch (error) {
				db.close();
				throw error;
			}
			try {
				const now = Date.now();
				for (const [provider, key] of Object.entries(providerPatch)) {
					const data = JSON.stringify({ key, source: "settings" });
					const existing = db
						.prepare(
							"SELECT id FROM auth_credentials WHERE provider = ? AND credential_type = 'api_key' ORDER BY id",
						)
						.all(provider) as { id: number }[];
					if (existing[0]) {
						db.prepare("UPDATE auth_credentials SET data = ?, updated_at = ? WHERE id = ?").run(
							data,
							now,
							existing[0].id,
						);
						for (const duplicate of existing.slice(1))
							db.prepare("DELETE FROM auth_credentials WHERE id = ?").run(duplicate.id);
					} else {
						db.prepare(
							"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, 'api_key', ?, ?, ?)",
						).run(provider, data, now, now);
					}
				}
				await this.#writeAtomic(this.#configPath, stringifyYaml(next, { indent: 2 }));
				db.run("COMMIT");
				await unlink(this.#journalPath);
			} catch (error) {
				try {
					db.run("ROLLBACK");
				} catch {}
				db.close();
				await this.#recoverJournal();
				throw error;
			}
			try {
				providerRows = this.#providerRows(db);
			} finally {
				db.close();
			}
			const newConfigText = await this.#readConfigText();
			return { written: true, revision: this.#revision(newConfigText, providerRows) };
		});
	}

	operations() {
		return {
			settingsRead: () => this.settingsRead(),
			settingsWrite: (args: CommandResult, context: OperationContext) => this.settingsWrite(args, context),
		};
	}
}
