import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
	ClusterSessionCreateArguments,
	ClusterWorkspaceCreateArguments,
} from "@t4-code/host-wire";
import {
	CLUSTER_MAX_SESSIONS,
	CLUSTER_MAX_WORKSPACES,
	type InfrastructureList,
	type KubernetesResource,
	type KubernetesWatchEvent,
	REST_PUBLIC_ID_ANNOTATION,
	REST_SCOPE_ID_ANNOTATION,
	REST_REVISION_ANNOTATION,
	portableWorkspaceRevision,
	restResourceId,
	restResourceRevision,
	sessionAttachesToWorkspace,
} from "./kubernetes-projection.ts";
import type { RequestIdentity } from "./identity.ts";
import { readBoundedRegularFile, readKubernetesToken } from "./config.ts";

const API_PREFIX = "/apis/cluster.t4.dev/v1alpha1";
const TOKEN_REVIEW_PATH = "/apis/authentication.k8s.io/v1/tokenreviews";
const REST_CREATE_DIGEST_ANNOTATION = "cluster.t4.dev/rest-create-digest";
const REST_LEDGER_ANNOTATION = "cluster.t4.dev/rest-idempotency";
const REST_LEDGER_LIMIT = 32;
const REST_LEDGER_TTL_MS = 86_400_000;
const REST_LEDGER_MAX_BYTES = 48 * 1024;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const MAX_WATCH_LINE_BYTES = 1024 * 1024;
export const CLUSTER_INTERNAL_AUDIENCE = "t4-cluster-internal";

export interface KubernetesApiClientOptions {
	readonly baseUrl: string;
	readonly namespace: string;
	readonly token?: string;
	readonly tokenFile?: string;
	readonly ca?: string;
	readonly fetch?: typeof globalThis.fetch;
}
export interface KubernetesResourceApi {
	readonly namespace: string;
	list(resource: string, limit: number, signal?: AbortSignal): Promise<{ items: KubernetesResource[]; resourceVersion: string }>;
	create(resource: string, body: unknown, signal?: AbortSignal): Promise<KubernetesResource>;
	get(resource: string, name: string, signal?: AbortSignal): Promise<KubernetesResource>;
	delete(resource: string, name: string, preconditions: { readonly uid: string; readonly resourceVersion: string }, signal?: AbortSignal): Promise<unknown>;
	update(resource: string, name: string, body: unknown, signal?: AbortSignal): Promise<KubernetesResource>;
}


function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}
export function semanticResourceHash(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}
function resourceName(prefix: "workspace" | "session", commandId: string): string {
	const digest = createHash("sha256").update(commandId, "utf8").digest("hex").slice(0, 16);
	return `${prefix}-${digest}`;
}
function safeNamespace(value: string): string {
	if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(value)) throw new Error("Kubernetes namespace is invalid");
	return value;
}
function exactHttpsBase(value: string): string {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Kubernetes base URL must use HTTPS");
	return url.href.replace(/\/$/u, "");
}
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class KubernetesApiError extends Error {
	constructor(readonly status: number, message: string, readonly body?: unknown) {
		super(message);
		this.name = "KubernetesApiError";
	}
}

export class KubernetesApiClient implements KubernetesResourceApi {
	readonly baseUrl: string;
	readonly namespace: string;
	readonly #token?: string;
	readonly #tokenFile?: string;
	readonly #ca?: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: KubernetesApiClientOptions) {
		this.baseUrl = exactHttpsBase(options.baseUrl);
		this.namespace = safeNamespace(options.namespace);
		const hasToken = options.token !== undefined;
		const hasTokenFile = options.tokenFile !== undefined;
		if (hasToken === hasTokenFile) throw new Error("Kubernetes API client requires exactly one credential source");
		if (hasToken) {
			if (!options.token || new TextEncoder().encode(options.token).byteLength > 16_384 || /\s/u.test(options.token))
				throw new Error("Kubernetes service account token is invalid");
			this.#token = options.token;
		} else {
			if (!isAbsolute(options.tokenFile!)) throw new Error("Kubernetes service account token file must be absolute");
			this.#tokenFile = options.tokenFile;
		}
		this.#ca = options.ca;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async listInfrastructure(hostName?: string, signal?: AbortSignal): Promise<InfrastructureList> {
		const [hosts, workspaces, sessions] = await Promise.all([
			this.list("t4clusterhosts", 256, signal),
			this.list("t4workspaces", CLUSTER_MAX_WORKSPACES, signal),
			this.list("t4sessions", CLUSTER_MAX_SESSIONS, signal),
		]);
		const host = hostName ? hosts.items.find(value => value.metadata.name === hostName) : hosts.items[0];
		if (!host) throw new Error("T4ClusterHost is unavailable");
		if (hosts.items.length > 1 && !hostName) throw new Error("T4ClusterHost selection is ambiguous");
		const belongsToHost = (resource: KubernetesResource): boolean => object(resource.spec).hostRef === host.metadata.name;
		return {
			host,
			workspaces: workspaces.items.filter(belongsToHost),
			sessions: sessions.items.filter(belongsToHost),
			resourceVersion: sessions.resourceVersion || workspaces.resourceVersion || hosts.resourceVersion,
			resourceVersions: { t4clusterhosts: hosts.resourceVersion, t4workspaces: workspaces.resourceVersion, t4sessions: sessions.resourceVersion },
		};
	}

	async list(resource: string, limit: number, signal?: AbortSignal): Promise<{ items: KubernetesResource[]; resourceVersion: string }> {
		const response = object(await this.request(`${this.#collection(resource)}?limit=${limit}`, { signal }));
		const metadata = object(response.metadata);
		const items = Array.isArray(response.items) ? response.items as KubernetesResource[] : [];
		if (items.length > limit || typeof metadata.continue === "string" && metadata.continue.length > 0)
			throw new Error(`${resource} list exceeds limit`);
		return { items, resourceVersion: typeof metadata.resourceVersion === "string" ? metadata.resourceVersion : "0" };
	}

	async create(resource: string, body: unknown, signal?: AbortSignal): Promise<KubernetesResource> {
		return await this.request(this.#collection(resource), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}) as KubernetesResource;
	}

	async get(resource: string, name: string, signal?: AbortSignal): Promise<KubernetesResource> {
		return await this.request(`${this.#collection(resource)}/${encodeURIComponent(name)}`, { signal }) as KubernetesResource;
	}

	async delete(resource: string, name: string, preconditions: { readonly uid: string; readonly resourceVersion: string }, signal?: AbortSignal): Promise<unknown> {
		return await this.request(`${this.#collection(resource)}/${encodeURIComponent(name)}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground", preconditions }),
			signal,
		});
	}

	async update(resource: string, name: string, body: unknown, signal?: AbortSignal): Promise<KubernetesResource> {
		return await this.request(`${this.#collection(resource)}/${encodeURIComponent(name)}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal,
		}) as KubernetesResource;
	}

	async watch(
		resource: string,
		resourceVersion: string,
		onEvent: (event: KubernetesWatchEvent) => void,
		signal: AbortSignal,
		onStarted?: () => void,
	): Promise<void> {
		const query = new URLSearchParams({ watch: "1", allowWatchBookmarks: "true", resourceVersion, timeoutSeconds: "300" });
		const response = await this.#raw(`${this.#collection(resource)}?${query}`, { signal });
		if (!response.ok) throw new KubernetesApiError(response.status, `Kubernetes watch failed with ${response.status}`);
		if (!response.body) throw new Error("Kubernetes watch body is unavailable");
		const reader = response.body.getReader();
		onStarted?.();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let buffered = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffered += decoder.decode(chunk.value, { stream: true });
			if (new TextEncoder().encode(buffered).byteLength > MAX_WATCH_LINE_BYTES) throw new Error("Kubernetes watch frame exceeds limit");
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (!line) continue;
				const value = object(JSON.parse(line));
				if (value.type === "BOOKMARK") continue;
				if (value.type === "ERROR") throw new KubernetesApiError(Number(object(value.object).code) || 500, "Kubernetes watch error", value.object);
				if (value.type === "ADDED" || value.type === "MODIFIED" || value.type === "DELETED")
					onEvent({ type: value.type, object: value.object as KubernetesResource });
			}
		}
	}

	async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const response = await this.#raw(path, init);
		const body = await response.json().catch(() => undefined) as unknown;
		if (!response.ok) throw new KubernetesApiError(response.status, `Kubernetes API request failed with ${response.status}`, body);
		return body;
	}

	#collection(resource: string): string {
		if (!/^[a-z0-9]+$/u.test(resource)) throw new Error("Kubernetes resource is invalid");
		return `${API_PREFIX}/namespaces/${this.namespace}/${resource}`;
	}
	async #raw(path: string, init: RequestInit): Promise<Response> {
		const token = this.#token ?? await readKubernetesToken(this.#tokenFile!);
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		headers.set("authorization", `Bearer ${token}`);
		const request = { ...init, headers } as RequestInit & { tls?: { ca?: string } };
		if (this.#ca) request.tls = { ca: this.#ca };
		return this.#fetch(`${this.baseUrl}${path}`, request);
	}
}

export interface KubernetesTokenReviewerOptions {
	readonly baseUrl: string;
	readonly tokenPath: string;
	readonly caPath: string;
	readonly namespacePath: string;
	readonly serverServiceAccountName: string;
	readonly timeoutMs?: number;
	readonly fetch?: typeof globalThis.fetch;
}

/** Validates a projected server identity through the Kubernetes authentication authority. */
export class KubernetesTokenReviewer {
	readonly #baseUrl: string;
	readonly #tokenPath: string;
	readonly #caPath: string;
	readonly #namespacePath: string;
	readonly #serverServiceAccountName: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: KubernetesTokenReviewerOptions) {
		this.#baseUrl = exactHttpsBase(options.baseUrl);
		if (![options.tokenPath, options.caPath, options.namespacePath].every(isAbsolute)) throw new Error("Kubernetes projected credential paths must be absolute");
		this.#tokenPath = options.tokenPath;
		this.#caPath = options.caPath;
		this.#namespacePath = options.namespacePath;
		if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(options.serverServiceAccountName)) throw new Error("cluster server ServiceAccount name is invalid");
		this.#serverServiceAccountName = options.serverServiceAccountName;
		this.#timeoutMs = options.timeoutMs ?? 5_000;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 100 || this.#timeoutMs > 30_000) throw new Error("TokenReview timeout is invalid");
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async review(presentedToken: string): Promise<boolean> {
		try {
			const presentedBytes = new TextEncoder().encode(presentedToken).byteLength;
			if (presentedBytes < 32 || presentedBytes > 16_384 || /\s/u.test(presentedToken)) return false;
			const [rawReviewerToken, ca, rawNamespace] = await Promise.all([
				readBoundedRegularFile(this.#tokenPath, 16_384, "Kubernetes reviewer token"),
				readBoundedRegularFile(this.#caPath, 1024 * 1024, "Kubernetes CA"),
				readBoundedRegularFile(this.#namespacePath, 256, "Kubernetes namespace"),
			]);
			const reviewerToken = rawReviewerToken.trim();
			const namespace = safeNamespace(rawNamespace.trim());
			if (!reviewerToken || /\s/u.test(reviewerToken) || !ca.includes("BEGIN CERTIFICATE")) return false;
			const headers = new Headers({ accept: "application/json", authorization: `Bearer ${reviewerToken}`, "content-type": "application/json" });
			const request = {
				method: "POST",
				headers,
				body: JSON.stringify({
					apiVersion: "authentication.k8s.io/v1",
					kind: "TokenReview",
					spec: { token: presentedToken, audiences: [CLUSTER_INTERNAL_AUDIENCE] },
				}),
				signal: AbortSignal.timeout(this.#timeoutMs),
				tls: { ca },
			} as RequestInit & { tls: { ca: string } };
			const response = await this.#fetch(`${this.#baseUrl}${TOKEN_REVIEW_PATH}`, request);
			if (!response.ok) return false;
			let body: unknown;
			try { body = await response.json(); } catch { return false; }
			const root = object(body);
			if (root.apiVersion !== "authentication.k8s.io/v1" || root.kind !== "TokenReview") return false;
			const status = object(root.status);
			if (status.authenticated !== true || Object.hasOwn(status, "error")) return false;
			const user = object(status.user);
			if (typeof user.username !== "string") return false;
			const expectedUsername = `system:serviceaccount:${namespace}:${this.#serverServiceAccountName}`;
			const expectedBytes = Buffer.from(expectedUsername, "utf8");
			const actualBytes = Buffer.from(user.username, "utf8");
			if (expectedBytes.length !== actualBytes.length || !timingSafeEqual(expectedBytes, actualBytes)) return false;
			return Array.isArray(status.audiences) && status.audiences.length === 1 && status.audiences[0] === CLUSTER_INTERNAL_AUDIENCE;
		} catch {
			return false;
		}
	}
}

export interface RestWorkspaceCreateInput {
	readonly scopeId: string;
	readonly displayName: string;
	readonly capacityBytes: number;
	readonly retention: "Retain" | "Delete";
}
export interface RestWorkspacePatchInput {
	readonly displayName?: string;
	readonly retention?: "Retain" | "Delete";
}
export interface RestIdlePolicy { readonly enabled: boolean; readonly idleSeconds?: number; }
export interface RestRuntimeCreateInput {
	readonly scopeId: string;
	readonly displayName: string;
	readonly workspaceId: string;
	readonly hostProfileId: string;
	readonly desiredState: "Running" | "Sleeping" | "Stopped";
	readonly browserPolicy: "Allowed" | "Disabled";
	readonly idlePolicy?: RestIdlePolicy;
}
export interface RestRuntimePatchInput {
	readonly displayName?: string;
	readonly desiredState?: "Running" | "Sleeping" | "Stopped";
	readonly browserPolicy?: "Allowed" | "Disabled";
	readonly idlePolicy?: RestIdlePolicy;
}
export interface RestMutationResult {
	readonly created?: boolean;
	readonly replayed?: boolean;
	readonly resource: KubernetesResource;
	readonly workspace?: KubernetesResource;
	readonly attachmentCount?: number;
	readonly retainedStatus?: number;
	readonly retainedBody?: Readonly<Record<string, unknown>>;
	readonly retainedEtag?: string;
}
export class RestMutationError extends Error {
	constructor(
		readonly code: "not_found" | "revision_mismatch" | "resource_conflict" | "workspace_attached" | "idempotency_conflict" | "idempotency_unavailable" | "invalid_resource" | "unavailable",
		message: string,
		readonly currentRevision?: string,
	) {
		super(message);
		this.name = "RestMutationError";
	}
}
interface LedgerEntry {
	readonly keyHash: string;
	readonly digest: string;
	readonly expiresAt: number;
	readonly status: number;
	readonly etag: string;
	readonly body: Readonly<Record<string, unknown>>;
}
function restPrivateName(prefix: "ws" | "rt", principal: string, publicId: string): string {
	return `${prefix}-${createHash("sha256").update(principal).update("\u0000").update(publicId).digest("hex").slice(0, 40)}`;
}
function internalRuntimeProfile(publicId: string): string {
	return /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(publicId)
		? publicId
		: `rest-${createHash("sha256").update(publicId).digest("hex").slice(0, 24)}`;
}
function restRevisionToken(kind: "workspace" | "runtime", uidOrName: string, seed: string): string {
	return `rev_${createHash("sha256").update(kind).update("\u0000").update(uidOrName).update("\u0000").update(seed).digest("base64url").slice(0, 24)}`;
}
function currentRestRevision(kind: "workspace" | "runtime", resource: KubernetesResource): string {
	return restResourceRevision(kind, resource);
}
function parseLedger(resource: KubernetesResource, now: number): LedgerEntry[] {
	const encoded = resource.metadata.annotations?.[REST_LEDGER_ANNOTATION];
	if (!encoded) return [];
	if (new TextEncoder().encode(encoded).byteLength > REST_LEDGER_MAX_BYTES) throw new RestMutationError("idempotency_unavailable", "The retained idempotency ledger exceeds its safe bound.");
	try {
		const parsed = JSON.parse(encoded) as unknown;
		if (!Array.isArray(parsed) || parsed.length > REST_LEDGER_LIMIT) throw new Error("invalid ledger");
		return parsed.filter((entry): entry is LedgerEntry => {
			const value = object(entry);
			return typeof value.keyHash === "string" && typeof value.digest === "string" &&
				typeof value.expiresAt === "number" && value.expiresAt > now &&
				typeof value.status === "number" && typeof value.etag === "string" &&
				value.body !== null && typeof value.body === "object" && !Array.isArray(value.body);
		});
	} catch (error) {
		if (error instanceof RestMutationError) throw error;
		throw new RestMutationError("idempotency_unavailable", "The retained idempotency ledger is invalid.");
	}
}

export interface KubernetesGatewayMutationBackendOptions {
	readonly client: KubernetesResourceApi;
	readonly hostRef: string;
}
export class KubernetesGatewayMutationBackend {
	readonly #client: KubernetesResourceApi;
	readonly #hostRef: string;
	constructor(options: KubernetesGatewayMutationBackendOptions) {
		this.#client = options.client;
		this.#hostRef = options.hostRef;
	}
	#assertScopeBinding(resource: KubernetesResource, scopeId: string): void {
		if (!PUBLIC_ID.test(scopeId) || resource.metadata.annotations?.[REST_SCOPE_ID_ANNOTATION] !== scopeId)
			throw new RestMutationError("resource_conflict", "The resource scope binding is missing or invalid.");
	}

	async putRestWorkspace(publicId: string, input: RestWorkspaceCreateInput, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<RestMutationResult> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const createDigest = semanticResourceHash(input);
		const existing = await this.#findOwnedWorkspace(publicId, ownerPrincipal);
		if (existing) {
			if (existing.metadata.annotations?.[REST_CREATE_DIGEST_ANNOTATION] !== createDigest)
				throw new RestMutationError("resource_conflict", "The workspace identifier already has incompatible create parameters.");
			this.#assertScopeBinding(existing, input.scopeId);
			return { created: false, resource: existing, attachmentCount: await this.#attachmentCount(existing.metadata.name) };
		}
		const name = restPrivateName("ws", ownerPrincipal, publicId);
		const revision = restRevisionToken("workspace", name, createDigest);
		const body: KubernetesResource = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: {
				name,
				finalizers: ["cluster.t4.dev/workspace-protection"],
				annotations: {
					[REST_PUBLIC_ID_ANNOTATION]: publicId,
					[REST_SCOPE_ID_ANNOTATION]: input.scopeId,
					[REST_CREATE_DIGEST_ANNOTATION]: createDigest,
					[REST_REVISION_ANNOTATION]: revision,
				},
			} as KubernetesResource["metadata"],
			spec: {
				publicId,
				hostRef: this.#hostRef,
				owner: ownerPrincipal,
				displayName: input.displayName,
				size: String(input.capacityBytes),
				retentionPolicy: input.retention,
			},
		};
		try {
			const created = await this.#client.create("t4workspaces", body);
			return { created: true, resource: created, attachmentCount: await this.#attachmentCount(created.metadata.name) };
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 409) throw this.#translate(error);
			const raced = await this.#resolveOwnedWorkspace(publicId, ownerPrincipal);
			if (raced.metadata.annotations?.[REST_CREATE_DIGEST_ANNOTATION] !== createDigest)
				throw new RestMutationError("resource_conflict", "The workspace identifier already has incompatible create parameters.");
			this.#assertScopeBinding(raced, input.scopeId);
			return { created: false, resource: raced, attachmentCount: await this.#attachmentCount(raced.metadata.name) };
		}
	}

	async patchRestWorkspace(publicId: string, expectedRevision: string, patch: RestWorkspacePatchInput, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<RestMutationResult> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const current = await this.#resolveOwnedWorkspace(publicId, ownerPrincipal);
		const rawRevision = currentRestRevision("workspace", current);
		const attachmentCount = await this.#attachmentCount(current.metadata.name);
		const portableRevision = portableWorkspaceRevision(rawRevision, attachmentCount);
		if (rawRevision !== expectedRevision && portableRevision !== expectedRevision)
			throw new RestMutationError("revision_mismatch", "The resource revision does not match.", portableRevision);
		const spec = { ...object(current.spec) };
		if (patch.displayName !== undefined) spec.displayName = patch.displayName;
		if (patch.retention !== undefined) spec.retentionPolicy = patch.retention;
		const updated = await this.#updateOwned("workspace", "t4workspaces", current, spec, semanticResourceHash(patch), ownerPrincipal);
		return { resource: updated, attachmentCount: await this.#attachmentCount(updated.metadata.name) };
	}

	async deleteRestWorkspace(publicId: string, expectedRevision: string, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<void> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const current = await this.#resolveOwnedWorkspace(publicId, ownerPrincipal);
		const rawRevision = currentRestRevision("workspace", current);
		const attachmentCount = await this.#attachmentCount(current.metadata.name);
		const portableRevision = portableWorkspaceRevision(rawRevision, attachmentCount);
		if (rawRevision !== expectedRevision && portableRevision !== expectedRevision)
			throw new RestMutationError("revision_mismatch", "The resource revision does not match.", portableRevision);
		if (attachmentCount > 0)
			throw new RestMutationError("workspace_attached", "The workspace still has attached runtimes.");
		await this.#deleteExact("workspace", "t4workspaces", current, ownerPrincipal);
	}

	async putRestRuntime(publicId: string, input: RestRuntimeCreateInput, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<RestMutationResult> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const createDigest = semanticResourceHash(input);
		const existing = await this.#findOwnedRuntime(publicId, ownerPrincipal);
		if (existing) {
			if (existing.resource.metadata.annotations?.[REST_CREATE_DIGEST_ANNOTATION] !== createDigest)
				throw new RestMutationError("resource_conflict", "The runtime identifier already has incompatible create parameters.");
			this.#assertScopeBinding(existing.resource, input.scopeId);
			return { created: false, resource: existing.resource, workspace: existing.workspace };
		}
		const workspace = await this.#resolveOwnedWorkspace(input.workspaceId, ownerPrincipal);
		if (workspace.metadata.deletionTimestamp)
			throw new RestMutationError("resource_conflict", "The workspace is being deleted.");
		const name = restPrivateName("rt", ownerPrincipal, publicId);
		const revision = restRevisionToken("runtime", name, createDigest);
		const body: KubernetesResource = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name, annotations: {
				[REST_PUBLIC_ID_ANNOTATION]: publicId,
				[REST_SCOPE_ID_ANNOTATION]: input.scopeId,
				[REST_CREATE_DIGEST_ANNOTATION]: createDigest,
				[REST_REVISION_ANNOTATION]: revision,
			} },
			spec: {
				hostRef: this.#hostRef,
				workspaceRef: workspace.metadata.name,
				title: input.displayName,
				publicId,
				publicHostProfileId: input.hostProfileId,
				runtimeProfile: internalRuntimeProfile(input.hostProfileId),
				desiredState: input.desiredState,
				browserPolicy: input.browserPolicy,
				...(input.idlePolicy ? { idlePolicy: input.idlePolicy } : {}),
			},
		};
		try {
			return { created: true, resource: await this.#client.create("t4sessions", body), workspace };
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 409) throw this.#translate(error);
			const raced = await this.#resolveOwnedRuntime(publicId, ownerPrincipal);
			if (raced.resource.metadata.annotations?.[REST_CREATE_DIGEST_ANNOTATION] !== createDigest)
				throw new RestMutationError("resource_conflict", "The runtime identifier already has incompatible create parameters.");
			this.#assertScopeBinding(raced.resource, input.scopeId);
			return { created: false, resource: raced.resource, workspace: raced.workspace };
	}
	}

	async patchRestRuntime(publicId: string, expectedRevision: string, patch: RestRuntimePatchInput, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<RestMutationResult> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const current = await this.#resolveOwnedRuntime(publicId, ownerPrincipal);
		this.#assertRevision("runtime", current.resource, expectedRevision);
		const spec = { ...object(current.resource.spec) };
		if (patch.displayName !== undefined) spec.title = patch.displayName;
		if (patch.desiredState !== undefined) spec.desiredState = patch.desiredState;
		if (patch.browserPolicy !== undefined) spec.browserPolicy = patch.browserPolicy;
		if (patch.idlePolicy !== undefined) spec.idlePolicy = patch.idlePolicy;
		return {
			resource: await this.#updateOwned("runtime", "t4sessions", current.resource, spec, semanticResourceHash(patch), ownerPrincipal),
			workspace: current.workspace,
		};
	}

	async deleteRestRuntime(publicId: string, expectedRevision: string, ownerPrincipal: string, actorIdentity: RequestIdentity): Promise<void> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const current = await this.#resolveOwnedRuntime(publicId, ownerPrincipal);
		this.#assertRevision("runtime", current.resource, expectedRevision);
		await this.#deleteExact("runtime", "t4sessions", current.resource, ownerPrincipal);
	}

	async mutateRestRuntimeAction(
		publicId: string,
		expectedRevision: string,
		idempotencyKey: string,
		bindingDigest: string,
		desiredState: "Running" | "Sleeping",
		ownerPrincipal: string,
		actorIdentity: RequestIdentity,
		now = Date.now(),
	): Promise<RestMutationResult> {
		this.#validateRestIdentity(publicId, ownerPrincipal, actorIdentity);
		const keyHash = semanticResourceHash({ principal: ownerPrincipal, idempotencyKey });
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = await this.#resolveOwnedRuntime(publicId, ownerPrincipal);
			const ledger = parseLedger(current.resource, now);
			const retained = ledger.find(entry => entry.keyHash === keyHash);
			if (retained) {
				if (retained.digest !== bindingDigest)
					throw new RestMutationError("idempotency_conflict", "The idempotency key was already used for a different request.");
				return {
					replayed: true,
					resource: current.resource,
					workspace: current.workspace,
					retainedStatus: retained.status,
					retainedBody: retained.body,
					retainedEtag: retained.etag,
				};
			}
			this.#assertRevision("runtime", current.resource, expectedRevision);
			if (ledger.length >= REST_LEDGER_LIMIT)
				throw new RestMutationError("idempotency_unavailable", "The 24 hour idempotency retention bound is full.");
			const spec = { ...object(current.resource.spec), desiredState };
			const revision = restRevisionToken("runtime", current.resource.metadata.uid ?? current.resource.metadata.name, `${bindingDigest}\u0000${current.resource.metadata.resourceVersion ?? "0"}`);
			const provisional: KubernetesResource = {
				...current.resource,
				metadata: {
					...current.resource.metadata,
					annotations: { ...current.resource.metadata.annotations, [REST_REVISION_ANNOTATION]: revision },
				},
				spec,
			};
			const resultBody = this.#runtimeResultBody(provisional, current.workspace, ownerPrincipal);
			const status = resultBody.phase === (desiredState === "Running" ? "Ready" : "Sleeping") ? 200 : 202;
			const responseEtag = `"${String(resultBody.revision)}"`;
			const entry: LedgerEntry = { keyHash, digest: bindingDigest, expiresAt: now + REST_LEDGER_TTL_MS, status, etag: responseEtag, body: resultBody };
			const encoded = JSON.stringify([...ledger, entry]);
			if (new TextEncoder().encode(encoded).byteLength > REST_LEDGER_MAX_BYTES)
				throw new RestMutationError("idempotency_unavailable", "The 24 hour idempotency retention bound cannot be honored.");
			const updatedResource: KubernetesResource = {
				...provisional,
				metadata: {
					...provisional.metadata,
					annotations: { ...provisional.metadata.annotations, [REST_LEDGER_ANNOTATION]: encoded },
				},
			};
			try {
				const updated = await this.#client.update("t4sessions", current.resource.metadata.name, updatedResource);
				return { resource: updated, workspace: current.workspace, retainedStatus: status, retainedBody: resultBody, retainedEtag: responseEtag };
			} catch (error) {
				if (error instanceof KubernetesApiError && error.status === 409) continue;
				throw this.#translate(error);
			}
		}
		throw new RestMutationError("unavailable", "The runtime could not be mutated atomically.");
	}

	async createWorkspace(commandId: string, args: ClusterWorkspaceCreateArguments, principal: string, requestIdentity: RequestIdentity): Promise<{ id: string; revision: string }> {
		this.#validateGatewayIdentity(principal, requestIdentity);
		const identity = `${principal}\u0000${commandId}`;
		const name = resourceName("workspace", identity);
		const body = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: {
				name,
				finalizers: ["cluster.t4.dev/workspace-protection"],
				annotations: this.#annotations(commandId, args, principal),
			},
			spec: {
				hostRef: this.#hostRef,
				owner: principal,
				displayName: args.displayName,
				retentionPolicy: args.retentionPolicy,
				size: args.capacity,
				...(args.repository ? { repository: { repositoryId: args.repository.repositoryId, ...(args.repository.ref ? { ref: args.repository.ref } : {}), ...(args.repository.commit ? { commit: args.repository.commit } : {}) } } : {}),
			},
		};
		const resource = await this.#createOrRead("t4workspaces", name, body, commandId, semanticResourceHash({ args, principal }), principal);
		return { id: resource.metadata.name, revision: resource.metadata.resourceVersion ?? "0" };
	}

	async createSession(commandId: string, args: ClusterSessionCreateArguments, principal: string, requestIdentity: RequestIdentity): Promise<{ sessionId: string; revision: string }> {
		this.#validateGatewayIdentity(principal, requestIdentity);
		const workspace = await this.#client.get("t4workspaces", args.workspaceId);
		this.#assertWorkspaceOwner(workspace, principal);
		const identity = `${principal}\u0000${commandId}`;
		const name = resourceName("session", identity);
		const body = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Session",
			metadata: { name, annotations: this.#annotations(commandId, args, principal) },
			spec: {
				hostRef: this.#hostRef,
				workspaceRef: args.workspaceId,
				title: args.title ?? "Cluster session",
				runtimeProfile: args.runtimeProfile,
				guiEnabled: args.guiEnabled,
				browserPolicy: args.guiEnabled ? "Allowed" : "Disabled",
				...(args.ci ? { ci: { repositoryId: args.ci.repositoryId, ref: args.ci.ref, commit: args.ci.commit } } : {}),
			},
		};
		const resource = await this.#createOrRead("t4sessions", name, body, commandId, semanticResourceHash({ args, principal }), principal);
		return { sessionId: resource.metadata.name, revision: resource.metadata.resourceVersion ?? "0" };
	}

	async deleteSession(_commandId: string, sessionId: string, principal: string, requestIdentity: RequestIdentity): Promise<{ deleted: true }> {
		this.#validateGatewayIdentity(principal, requestIdentity);
		let session: KubernetesResource;
		try { session = await this.#client.get("t4sessions", sessionId); }
		catch (error) {
			if (error instanceof KubernetesApiError && error.status === 404) return { deleted: true };
			throw error;
		}
		if (object(session.spec).hostRef !== this.#hostRef) throw new Error("session belongs to another cluster host");
		const workspaceRef = object(session.spec).workspaceRef;
		if (typeof workspaceRef !== "string") throw new Error("session workspace reference is invalid");
		const workspace = await this.#client.get("t4workspaces", workspaceRef);
		this.#assertWorkspaceOwner(workspace, principal);
		if (!session.metadata.uid || !session.metadata.resourceVersion) throw new Error("session delete precondition is unavailable");
		try { await this.#client.delete("t4sessions", sessionId, { uid: session.metadata.uid, resourceVersion: session.metadata.resourceVersion }); }
		catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 404) throw error;
		}
		return { deleted: true };
	}
	async #ownedWorkspaces(principal: string): Promise<KubernetesResource[]> {
		try {
			const listed = await this.#client.list("t4workspaces", CLUSTER_MAX_WORKSPACES);
			return listed.items.filter(workspace => {
				const spec = object(workspace.spec);
				return workspace.kind === "T4Workspace" && spec.hostRef === this.#hostRef && spec.owner === principal;
			});
		} catch (error) {
			throw this.#translate(error);
		}
	}
	async #findOwnedWorkspace(publicId: string, principal: string): Promise<KubernetesResource | undefined> {
		const candidates = (await this.#ownedWorkspaces(principal)).filter(workspace => restResourceId("ws", workspace) === publicId);
		if (candidates.length > 1) throw new RestMutationError("resource_conflict", "The public workspace identifier is ambiguous.");
		return candidates[0];
	}
	async #resolveOwnedWorkspace(publicId: string, principal: string): Promise<KubernetesResource> {
		const workspace = await this.#findOwnedWorkspace(publicId, principal);
		if (!workspace) throw new RestMutationError("not_found", "The requested resource was not found.");
		return workspace;
	}
	async #findOwnedRuntime(publicId: string, principal: string): Promise<{ resource: KubernetesResource; workspace: KubernetesResource } | undefined> {
		try {
			const workspaces = new Map((await this.#ownedWorkspaces(principal)).map(workspace => [workspace.metadata.name, workspace]));
			const listed = await this.#client.list("t4sessions", CLUSTER_MAX_SESSIONS);
			const candidates = listed.items.flatMap(resource => {
				const spec = object(resource.spec);
				const workspace = typeof spec.workspaceRef === "string" ? workspaces.get(spec.workspaceRef) : undefined;
				return resource.kind === "T4Session" && spec.hostRef === this.#hostRef && workspace && restResourceId("rt", resource) === publicId
					? [{ resource, workspace }] : [];
			});
			if (candidates.length > 1) throw new RestMutationError("resource_conflict", "The public runtime identifier is ambiguous.");
			return candidates[0];
		} catch (error) {
			throw this.#translate(error);
		}
	}
	async #resolveOwnedRuntime(publicId: string, principal: string): Promise<{ resource: KubernetesResource; workspace: KubernetesResource }> {
		const runtime = await this.#findOwnedRuntime(publicId, principal);
		if (!runtime) throw new RestMutationError("not_found", "The requested resource was not found.");
		return runtime;
	}
	async #attachmentCount(workspaceName: string): Promise<number> {
		try {
			const listed = await this.#client.list("t4sessions", CLUSTER_MAX_SESSIONS);
			return listed.items.filter(session => {
				const spec = object(session.spec);
				return session.kind === "T4Session" && spec.hostRef === this.#hostRef &&
					sessionAttachesToWorkspace(session, workspaceName);
			}).length;
		} catch (error) {
			throw this.#translate(error);
		}
	}

	#validateGatewayIdentity(principal: string, identity: RequestIdentity): void {
		this.#validatePrincipal(principal);
		if (!identity || identity.principalId !== principal) throw new Error("request identity binding is invalid");
	}
	#validateRestIdentity(publicId: string, ownerPrincipal: string, actorIdentity: RequestIdentity): void {
		this.#validatePrincipal(ownerPrincipal);
		if (!actorIdentity) throw new RestMutationError("not_found", "The requested resource was not found.");
		this.#validatePrincipal(actorIdentity.principalId);
		if (!PUBLIC_ID.test(publicId)) throw new RestMutationError("not_found", "The requested resource was not found.");
	}
	async #ownedWorkspace(name: string, principal: string): Promise<KubernetesResource> {
		try {
			const workspace = await this.#client.get("t4workspaces", name);
			const spec = object(workspace.spec);
			if (workspace.kind !== "T4Workspace" || spec.hostRef !== this.#hostRef || spec.owner !== principal)
				throw new RestMutationError("not_found", "The requested resource was not found.");
			return workspace;
		} catch (error) {
			if (error instanceof RestMutationError) throw error;
			if (error instanceof KubernetesApiError && error.status === 404)
				throw new RestMutationError("not_found", "The requested resource was not found.");
			throw this.#translate(error);
		}
	}
	async #ownedRuntime(name: string, principal: string): Promise<{ resource: KubernetesResource; workspace: KubernetesResource }> {
		try {
			const resource = await this.#client.get("t4sessions", name);
			const spec = object(resource.spec);
			if (resource.kind !== "T4Session" || spec.hostRef !== this.#hostRef || typeof spec.workspaceRef !== "string")
				throw new RestMutationError("not_found", "The requested resource was not found.");
			const workspace = await this.#ownedWorkspace(spec.workspaceRef, principal);
			return { resource, workspace };
		} catch (error) {
			if (error instanceof RestMutationError) throw error;
			if (error instanceof KubernetesApiError && error.status === 404)
				throw new RestMutationError("not_found", "The requested resource was not found.");
			throw this.#translate(error);
		}
	}
	#assertRevision(kind: "workspace" | "runtime", resource: KubernetesResource, expected: string): void {
		const current = currentRestRevision(kind, resource);
		if (current !== expected) throw new RestMutationError("revision_mismatch", "The resource revision does not match.", current);
	}
	async #updateOwned(
		kind: "workspace" | "runtime",
		resourceType: "t4workspaces" | "t4sessions",
		current: KubernetesResource,
		spec: Record<string, unknown>,
		seed: string,
		principal: string,
	): Promise<KubernetesResource> {
		if (!current.metadata.uid || !current.metadata.resourceVersion)
			throw new RestMutationError("unavailable", "Kubernetes mutation preconditions are unavailable.");
		const revision = restRevisionToken(kind, current.metadata.uid, `${current.metadata.resourceVersion}\u0000${seed}`);
		const next: KubernetesResource = {
			...current,
			metadata: { ...current.metadata, annotations: { ...current.metadata.annotations, [REST_REVISION_ANNOTATION]: revision } },
			spec,
		};
		try {
			return await this.#client.update(resourceType, current.metadata.name, next);
		} catch (error) {
			if (error instanceof KubernetesApiError && error.status === 409) {
				const fresh = kind === "workspace"
					? await this.#ownedWorkspace(current.metadata.name, principal)
					: (await this.#ownedRuntime(current.metadata.name, principal)).resource;
				const revision = currentRestRevision(kind, fresh);
				const currentRevision = kind === "workspace" ? portableWorkspaceRevision(revision, await this.#attachmentCount(fresh.metadata.name)) : revision;
				throw new RestMutationError("revision_mismatch", "The resource revision does not match.", currentRevision);
			}
			throw this.#translate(error);
		}
	}
	async #deleteExact(
		kind: "workspace" | "runtime",
		resourceType: "t4workspaces" | "t4sessions",
		current: KubernetesResource,
		principal: string,
	): Promise<void> {
		if (!current.metadata.uid || !current.metadata.resourceVersion)
			throw new RestMutationError("unavailable", "Kubernetes deletion preconditions are unavailable.");
		try {
			await this.#client.delete(resourceType, current.metadata.name, { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion });
		} catch (error) {
			if (error instanceof KubernetesApiError && (error.status === 409 || error.status === 422)) {
				const fresh = kind === "workspace"
					? await this.#ownedWorkspace(current.metadata.name, principal)
					: (await this.#ownedRuntime(current.metadata.name, principal)).resource;
				const revision = currentRestRevision(kind, fresh);
				const currentRevision = kind === "workspace" ? portableWorkspaceRevision(revision, await this.#attachmentCount(fresh.metadata.name)) : revision;
				throw new RestMutationError("revision_mismatch", "The resource revision does not match.", currentRevision);
			}
			if (error instanceof KubernetesApiError && error.status === 404)
				throw new RestMutationError("not_found", "The requested resource was not found.");
			throw this.#translate(error);
		}
	}
	#runtimeResultBody(resource: KubernetesResource, workspace: KubernetesResource, principal: string): Readonly<Record<string, unknown>> {
		const spec = object(resource.spec);
		const desiredState = spec.desiredState === "Sleeping" || spec.desiredState === "Stopped" ? spec.desiredState : "Running";
		const statusPhase = object(resource.status).phase;
		const phase = statusPhase === "Running" && desiredState === "Running" ? "Starting"
			: statusPhase === "Sleeping" ? "Sleeping"
			: statusPhase === "Stopped" ? "Stopped"
			: statusPhase === "Failed" ? "Failed"
			: statusPhase === "Pending" ? "Provisioning"
			: resource.metadata.deletionTimestamp ? "Deleting"
			: "Unavailable";
		const createdAt = typeof resource.metadata.creationTimestamp === "string" ? resource.metadata.creationTimestamp : "1970-01-01T00:00:00.000Z";
		return {
			id: restResourceId("rt", resource),
			scopeId: `scope_${createHash("sha256").update(principal).digest("base64url").slice(0, 24)}`,
			displayName: typeof spec.title === "string" ? spec.title : "Runtime",
			workspaceId: restResourceId("ws", workspace),
			hostProfileId: typeof spec.publicHostProfileId === "string" ? spec.publicHostProfileId : typeof spec.runtimeProfile === "string" ? spec.runtimeProfile : "default",
			desiredState,
			phase,
			generation: String(resource.metadata.generation ?? 0),
			revision: currentRestRevision("runtime", resource),
			capabilities: [],
			conditions: [],
			createdAt,
			updatedAt: createdAt,
		};
	}
	#translate(error: unknown): RestMutationError {
		if (error instanceof KubernetesApiError && error.status === 422)
			return new RestMutationError("invalid_resource", "The requested resource is not supported by Kubernetes policy.");
		if (error instanceof RestMutationError) return error;
		if (error instanceof KubernetesApiError && error.status === 404)
			return new RestMutationError("not_found", "The requested resource was not found.");
		return new RestMutationError("unavailable", "Kubernetes mutation authority is unavailable.");
	}
	#validatePrincipal(principal: string): void {
		if (!principal || new TextEncoder().encode(principal).byteLength > 256 || /\p{Cc}/u.test(principal) || principal !== principal.trim())
			throw new Error("gateway principal is invalid");
	}
	#assertWorkspaceOwner(workspace: KubernetesResource, principal: string): void {
		const spec = object(workspace.spec);
		if (workspace.kind !== "T4Workspace" || spec.hostRef !== this.#hostRef || spec.owner !== principal)
			throw new Error("workspace is unavailable for this identity");
	}
	#annotations(commandId: string, args: unknown, principal: string): Record<string, string> {
		return {
			"cluster.t4.dev/command-id": commandId,
			"cluster.t4.dev/principal-hash": semanticResourceHash(principal),
			"cluster.t4.dev/semantic-hash": semanticResourceHash({ args, principal }),
		};
	}
	async #createOrRead(resourceType: string, name: string, body: unknown, commandId: string, hash: string, principal: string): Promise<KubernetesResource> {
		try {
			const created = await this.#client.create(resourceType, body);
			return created.metadata ? created : { ...(body as KubernetesResource), metadata: { ...(body as KubernetesResource).metadata, resourceVersion: "0" } };
		} catch (error) {
			if (!(error instanceof KubernetesApiError) || error.status !== 409) throw error;
			const existing = await this.#client.get(resourceType, name);
			const annotations = existing.metadata.annotations ?? {};
			if (
				annotations["cluster.t4.dev/command-id"] !== commandId ||
				annotations["cluster.t4.dev/principal-hash"] !== semanticResourceHash(principal) ||
				annotations["cluster.t4.dev/semantic-hash"] !== hash
			) throw new Error("idempotency conflict for existing Kubernetes resource");
			return existing;
		}
	}
}
