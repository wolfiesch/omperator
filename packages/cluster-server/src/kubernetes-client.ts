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
} from "./kubernetes-projection.ts";
import { readBoundedRegularFile, readKubernetesToken } from "./config.ts";

const API_PREFIX = "/apis/cluster.t4.dev/v1alpha1";
const TOKEN_REVIEW_PATH = "/apis/authentication.k8s.io/v1/tokenreviews";
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

export class KubernetesApiClient {
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

export interface KubernetesGatewayMutationBackendOptions {
	readonly client: KubernetesApiClient;
	readonly hostRef: string;
}
export class KubernetesGatewayMutationBackend {
	readonly #client: KubernetesApiClient;
	readonly #hostRef: string;
	constructor(options: KubernetesGatewayMutationBackendOptions) {
		this.#client = options.client;
		this.#hostRef = options.hostRef;
	}

	async createWorkspace(commandId: string, args: ClusterWorkspaceCreateArguments, principal: string): Promise<{ id: string; revision: string }> {
		this.#validatePrincipal(principal);
		const identity = `${principal}\u0000${commandId}`;
		const name = resourceName("workspace", identity);
		const body = {
			apiVersion: "cluster.t4.dev/v1alpha1",
			kind: "T4Workspace",
			metadata: { name, annotations: this.#annotations(commandId, args, principal) },
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

	async createSession(commandId: string, args: ClusterSessionCreateArguments, principal: string): Promise<{ sessionId: string; revision: string }> {
		this.#validatePrincipal(principal);
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
				...(args.ci ? { ci: { repositoryId: args.ci.repositoryId, ref: args.ci.ref, commit: args.ci.commit } } : {}),
			},
		};
		const resource = await this.#createOrRead("t4sessions", name, body, commandId, semanticResourceHash({ args, principal }), principal);
		return { sessionId: resource.metadata.name, revision: resource.metadata.resourceVersion ?? "0" };
	}

	async deleteSession(_commandId: string, sessionId: string, principal: string): Promise<{ deleted: true }> {
		this.#validatePrincipal(principal);
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
