import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { readBoundedRegularFile } from "./config.ts";
import type { CiRunResult, SessionCiState } from "@t4-code/host-wire";

export const WOODPECKER_MAX_PIPELINES = 100;
export const WOODPECKER_MAX_RESPONSE_BYTES = 1024 * 1024;
export const WOODPECKER_MAX_INFLIGHT_TRIGGERS = 128;
export const WOODPECKER_MAX_STAGES = 128;

export interface CiCorrelation {
	readonly sessionId: string;
	readonly repositoryId: string;
	readonly ref: string;
	readonly commit: string;
}
export interface CiRunCorrelation extends CiCorrelation { readonly commandId: string; }
export interface CiProvider {
	readonly name: "woodpecker";
	query(correlation: CiCorrelation, signal?: AbortSignal): Promise<SessionCiState>;
	run(correlation: CiRunCorrelation, signal?: AbortSignal): Promise<CiRunResult>;
}
export interface WoodpeckerRepositoryConfig { readonly slug: string; }
export interface WoodpeckerProviderOptions {
	readonly baseUrl: string;
	readonly webBaseUrl?: string;
	readonly token?: string;
	readonly tokenFile?: string;
	readonly repositories: Readonly<Record<string, WoodpeckerRepositoryConfig>>;
	readonly fetch?: typeof globalThis.fetch;
}
interface WoodpeckerPipeline {
	readonly number?: unknown;
	readonly status?: unknown;
	readonly ref?: unknown;
	readonly branch?: unknown;
	readonly commit?: unknown;
	readonly created?: unknown;
	readonly started?: unknown;
	readonly finished?: unknown;
	readonly variables?: unknown;
	readonly stages?: unknown;
}
function httpsBase(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error("Woodpecker web base URL must use HTTPS without credentials");
	return url.href.replace(/\/$/u, "");
}
function apiBase(value: string): string {
	const url = new URL(value);
	const inCluster = url.protocol === "http:" && url.hostname.endsWith(".svc.cluster.local");
	if (!(url.protocol === "https:" || inCluster) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname))
		throw new Error("Woodpecker API base URL must use HTTPS or an exact in-cluster Service URL without credentials");
	return url.href.replace(/\/$/u, "");
}
function bounded(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > max || /\p{Cc}/u.test(value))
		throw new Error(`${name} is invalid`);
	return value;
}
function slug(value: string): string {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value) || value.includes("..")) throw new Error("Woodpecker repository slug is invalid");
	return value;
}
function pipelineStatus(value: unknown): NonNullable<SessionCiState["status"]> {
	switch (value) {
		case "pending": case "queued": case "blocked": return value === "blocked" ? "unknown" : "queued";
		case "running": return "running";
		case "success": return "success";
		case "failure": case "error": return "failure";
		case "killed": case "canceled": case "cancelled": return "killed";
		default: return "unknown";
	}
}
function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function timestamp(value: unknown): string | undefined {
	const seconds = typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
	return seconds === undefined ? undefined : new Date(seconds * 1_000).toISOString();
}
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function exactPipeline(pipeline: WoodpeckerPipeline, correlation: CiCorrelation, idempotencyKey?: string): boolean {
	const variables = object(pipeline.variables);
	return pipeline.ref === correlation.ref && pipeline.commit === correlation.commit &&
		variables.T4_SESSION_ID === correlation.sessionId &&
		(idempotencyKey === undefined || variables.T4_IDEMPOTENCY_KEY === idempotencyKey);
}

export function mapWoodpeckerPipeline(
	pipeline: WoodpeckerPipeline,
	correlation: CiCorrelation,
	link?: string,
): SessionCiState {
	const number = positiveInteger(pipeline.number);
	if (Array.isArray(pipeline.stages) && pipeline.stages.length > WOODPECKER_MAX_STAGES) throw new Error("Woodpecker stage response limit exceeded");
	const stages = Array.isArray(pipeline.stages) ? pipeline.stages.map(object) : [];
	const current = stages.find(stage => stage.status === "running")?.name;
	const repositoryId = bounded(correlation.repositoryId, "CI repository id", 256);
	const ref = bounded(correlation.ref, "CI ref", 512);
	const commit = bounded(correlation.commit, "CI commit", 512);
	return {
		provider: "woodpecker",
		correlation: "exact",
		repositoryId,
		...(typeof pipeline.branch === "string" ? { branch: bounded(pipeline.branch, "Woodpecker branch", 512) } : {}),
		ref,
		commit,
		...(number === undefined ? {} : { pipelineNumber: number }),
		status: pipelineStatus(pipeline.status),
		...(typeof current === "string" ? { currentStage: bounded(current, "Woodpecker stage", 256) } : {}),
		...(timestamp(pipeline.created) ? { createdAt: timestamp(pipeline.created)! } : {}),
		...(timestamp(pipeline.started) ? { startedAt: timestamp(pipeline.started)! } : {}),
		...(timestamp(pipeline.finished) ? { finishedAt: timestamp(pipeline.finished)! } : {}),
		...(link ? { link: httpsBase(link) } : {}),
	};
}

export class WoodpeckerProvider implements CiProvider {
	readonly name = "woodpecker" as const;
	readonly #baseUrl: string;
	readonly #webBaseUrl: string;
	readonly #token?: string;
	readonly #tokenFile?: string;
	readonly #repositories: Readonly<Record<string, WoodpeckerRepositoryConfig>>;
	readonly #fetch: typeof globalThis.fetch;
	readonly #inflight = new Map<string, Promise<CiRunResult>>();

	constructor(options: WoodpeckerProviderOptions) {
		this.#baseUrl = apiBase(options.baseUrl);
		this.#webBaseUrl = options.webBaseUrl ? httpsBase(options.webBaseUrl) : httpsBase(options.baseUrl);
		if (Boolean(options.token) === Boolean(options.tokenFile)) throw new Error("Woodpecker provider requires exactly one credential source");
		if (options.token) this.#token = bounded(options.token, "Woodpecker token", 16_384);
		if (options.tokenFile) {
			if (!isAbsolute(options.tokenFile)) throw new Error("Woodpecker token file must be absolute");
			this.#tokenFile = options.tokenFile;
		}
		const repositories: Record<string, WoodpeckerRepositoryConfig> = {};
		for (const [id, config] of Object.entries(options.repositories)) {
			bounded(id, "Woodpecker repository id", 256);
			repositories[id] = { slug: slug(config.slug) };
		}
		this.#repositories = Object.freeze(repositories);
		this.#fetch = options.fetch ?? globalThis.fetch;
	}
	async query(correlation: CiCorrelation, signal?: AbortSignal): Promise<SessionCiState> {
		return await this.#queryExact(correlation, signal);
	}

	async #queryExact(correlation: CiCorrelation, signal?: AbortSignal, idempotencyKey?: string): Promise<SessionCiState> {
		const repository = this.#repository(correlation.repositoryId);
		this.#validateCorrelation(correlation);
		const query = new URLSearchParams({ ref: correlation.ref, commit: correlation.commit, limit: String(WOODPECKER_MAX_PIPELINES) });
		const pipelines = await this.#json(`/api/repos/${encodeURIComponent(repository.slug)}/pipelines?${query}`, { signal });
		if (!Array.isArray(pipelines)) throw new Error("Woodpecker pipeline response is invalid");
		if (pipelines.length > WOODPECKER_MAX_PIPELINES) throw new Error("Woodpecker pipeline response limit exceeded");
		const exact = (pipelines as WoodpeckerPipeline[]).find(value => exactPipeline(value, correlation, idempotencyKey));
		if (!exact) return {
			provider: "woodpecker", correlation: "unknown", repositoryId: correlation.repositoryId,
			ref: correlation.ref, commit: correlation.commit,
		};
		const number = positiveInteger(exact.number);
		return mapWoodpeckerPipeline(exact, correlation, number ? `${this.#webBaseUrl}/repos/${repository.slug}/pipeline/${number}` : undefined);
	}
	async run(correlation: CiRunCorrelation, signal?: AbortSignal): Promise<CiRunResult> {
		const key = `${correlation.repositoryId}\u0000${correlation.ref}\u0000${correlation.commit}\u0000${correlation.sessionId}\u0000${correlation.commandId}`;
		const pending = this.#inflight.get(key);
		if (pending) return await pending;
		if (this.#inflight.size >= WOODPECKER_MAX_INFLIGHT_TRIGGERS) throw new Error("Woodpecker trigger concurrency limit exceeded");
		const operation = this.#runExact(correlation, signal);
		this.#inflight.set(key, operation);
		try { return await operation; }
		finally { if (this.#inflight.get(key) === operation) this.#inflight.delete(key); }
	}
	async #runExact(correlation: CiRunCorrelation, signal?: AbortSignal): Promise<CiRunResult> {
		const idempotencyKey = createHash("sha256")
			.update(correlation.sessionId).update("\u0000").update(correlation.commandId)
			.digest("base64url");
		const existing = await this.#queryExact(correlation, signal, idempotencyKey);
		if (existing.correlation === "exact" && existing.pipelineNumber !== undefined)
			return { triggered: false, pipelineNumber: existing.pipelineNumber, ...(existing.status ? { status: existing.status } : {}) };
		const repository = this.#repository(correlation.repositoryId);
		const created = object(await this.#json(`/api/repos/${encodeURIComponent(repository.slug)}/pipelines`, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": `t4-${idempotencyKey}` },
			body: JSON.stringify({ ref: correlation.ref, commit: correlation.commit, event: "manual", variables: { T4_SESSION_ID: correlation.sessionId, T4_IDEMPOTENCY_KEY: idempotencyKey } }),
			signal,
		}));
		if (created.idempotencyKey !== idempotencyKey)
			throw new Error("Woodpecker adapter did not confirm provider-side idempotency");
		const mapped = mapWoodpeckerPipeline(created, correlation);
		return {
			triggered: true,
			...(mapped.pipelineNumber === undefined ? {} : { pipelineNumber: mapped.pipelineNumber }),
			...(mapped.status === undefined ? {} : { status: mapped.status }),
		};
	}

	#repository(repositoryId: string): WoodpeckerRepositoryConfig {
		const repository = this.#repositories[repositoryId];
		if (!repository) throw new Error("Woodpecker repository is not allowlisted");
		return repository;
	}

	#validateCorrelation(value: CiCorrelation): void {
		bounded(value.sessionId, "CI session id", 256);
		bounded(value.repositoryId, "CI repository id", 256);
		bounded(value.ref, "CI ref", 512);
		bounded(value.commit, "CI commit", 512);
		if ("commandId" in value) bounded(value.commandId, "CI command id", 256);
	}
	async #credential(): Promise<string> {
		if (this.#token) return this.#token;
		const token = (await readBoundedRegularFile(this.#tokenFile!, 16_384, "Woodpecker token")).trim();
		if (new TextEncoder().encode(token).byteLength < 32 || /\s/u.test(token)) throw new Error("Woodpecker token file is invalid");
		return token;
	}
	async #json(path: string, init: RequestInit): Promise<unknown> {
		const headers = { Authorization: `Bearer ${await this.#credential()}`, ...Object.fromEntries(new Headers(init.headers).entries()) };
		const response = await this.#fetch(`${this.#baseUrl}${path}`, { ...init, headers });
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > WOODPECKER_MAX_RESPONSE_BYTES) throw new Error("Woodpecker response exceeds byte limit");
		if (!response.body) throw new Error("Woodpecker response body is unavailable");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let byteLength = 0;
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			byteLength += chunk.value.byteLength;
			if (byteLength > WOODPECKER_MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Woodpecker response exceeds byte limit"); }
			chunks.push(chunk.value);
		}
		const bytes = new Uint8Array(byteLength);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
		let value: unknown;
		try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
		catch { throw new Error("Woodpecker response is not JSON"); }
		if (!response.ok) throw new Error(`Woodpecker request failed with ${response.status}`);
		return value;
	}
}
