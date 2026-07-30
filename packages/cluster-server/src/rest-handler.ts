import { createHash } from "node:crypto";
import type {
	ClusterInfrastructureProjection,
	RestRuntimeProjection,
	RestWorkspaceProjection,
} from "./kubernetes-projection.ts";
import {
	RestMutationError,
	type KubernetesGatewayMutationBackend,
	type RestMutationResult,
	type RestRuntimeCreateInput,
	type RestRuntimePatchInput,
	type RestWorkspaceCreateInput,
	type RestWorkspacePatchInput,
} from "./kubernetes-client.ts";
import { portableWorkspaceRevision, restResourceId, restResourceRevision } from "./kubernetes-projection.ts";
import type { ClusterLifecycleEventSource } from "./lifecycle-events.ts";
import { isValidCmuxWebSocketTemplate } from "./cmux-websocket.ts";
import { requestIdentityScopeId, type RequestIdentity } from "./identity.ts";
import { Authorizer, authorizationScopeId, createAuthorizationRequestId, isAuthorized, type AuthorizationAction } from "./authorization.ts";
import { ScopeAdmissionError, type ScopeAdmissionAuthority } from "./scope-admission.ts";

const MAX_PAGE_SIZE = 200;
const MAX_BODY_BYTES = 16 * 1024;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u;
const ENTITY_TAG = /^"([A-Za-z0-9][A-Za-z0-9:._~-]{0,127})"$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const PHASES = new Set(["Pending", "Provisioning", "Starting", "Ready", "Sleeping", "Stopped", "Deleting", "Unavailable", "Degraded", "Failed"]);
const DESIRED_STATES = new Set(["Running", "Sleeping", "Stopped"]);
const PROTOCOLS = Object.freeze({
	machineProvider: Object.freeze(["machine-provider-v1"]),
	cmux: Object.freeze([10]),
	application: Object.freeze(["omp-app/1"]),
});
const JSON_HEADERS = Object.freeze({ "cache-control": "no-store", "content-type": "application/json" });
const PROBLEM_HEADERS = Object.freeze({ "cache-control": "no-store", "content-type": "application/problem+json" });

export interface ClusterRestApiConfig {
	readonly restBaseUrl: string;
	readonly ompAppWebSocketUrl: string;
	readonly cmuxWebSocketTemplate?: string;
	readonly build: {
		readonly version: string;
		readonly revision: string;
		readonly builtAt: string;
	};
}
export interface ClusterRestHandlerOptions {
	readonly projection: ClusterInfrastructureProjection;
	readonly config: ClusterRestApiConfig;
	readonly mutations?: Pick<KubernetesGatewayMutationBackend,
		"putRestWorkspace" | "patchRestWorkspace" | "deleteRestWorkspace" |
		"putRestRuntime" | "patchRestRuntime" | "deleteRestRuntime" | "mutateRestRuntimeAction">;
	readonly admission?: Pick<ScopeAdmissionAuthority, "createWorkspace" | "createRuntime" | "wakeRuntime" | "patchRuntime" | "retireWorkspace" | "retireRuntime" | "beginDeletion" | "resumeDeletion" | "finishDeletion">;
	readonly eventSource?: ClusterLifecycleEventSource;
	readonly directCmuxWebSocket?: boolean;
	readonly now?: () => Date;
	readonly authorizer?: Authorizer;
}


function digest(prefix: string, ...values: readonly string[]): string {
	return `${prefix}_${createHash("sha256").update(values.join("\u0000")).digest("base64url").slice(0, 24)}`;
}
function scopeOwner(options: ClusterRestHandlerOptions, identity: RequestIdentity, scopeId: string): string | undefined {
	if (scopeId === requestIdentityScopeId(identity)) return identity.principalId;
	return options.projection.restPrincipals().find(principal =>
		`scope_${createHash("sha256").update(principal).digest("base64url").slice(0, 24)}` === scopeId
	);
}
function authorizedScopeCandidates(identity: RequestIdentity): readonly string[] {
	const personalScopeId = requestIdentityScopeId(identity);
	return identity.authorizedScopes.length === 0
		? [personalScopeId]
		: [...new Set(identity.authorizedScopes.map(grant => authorizationScopeId(identity, grant.scopeId)))];
}

function resolvedResourceScope(
	options: ClusterRestHandlerOptions,
	identity: RequestIdentity,
	scopeId: string,
	resource: "workspaces" | "runtimes",
	publicId: string,
	action: AuthorizationAction,
	authorize: (scopeId: string, action: AuthorizationAction, resourceId?: string) => boolean,
): { readonly scopeId: string; readonly owner: string } | undefined {
	if (!authorize(scopeId, action, publicId)) return undefined;
	const owner = scopeOwner(options, identity, scopeId);
	if (!owner) return undefined;
	const projection = options.projection.restProjection(owner);
	const items = resource === "workspaces" ? projection.workspaces : projection.runtimes;
	return items.some(item => item.id === publicId) ? { scopeId, owner } : undefined;
}
function json(value: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(value), { ...init, headers: { ...JSON_HEADERS, ...init.headers } });
}
function problem(path: string, status: number, code: string, detail: string, headers?: HeadersInit, currentRevision?: string): Response {
	const titles: Readonly<Record<number, string>> = {
		400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 405: "Method Not Allowed",
		409: "Conflict", 412: "Precondition Failed", 503: "Service Unavailable",
	};
	return new Response(JSON.stringify({
		type: `https://omperator.dev/problems/${code}`,
		title: titles[status] ?? "Request Failed",
		status,
		detail: detail.slice(0, 1024),
		instance: path,
		code,
		retryable: status === 503,
		...(currentRevision ? { currentRevision } : {}),
	}), { status, headers: { ...PROBLEM_HEADERS, ...headers } });
}
function exactQuery(search: URLSearchParams, allowed: readonly string[]): boolean {
	const seen = new Set<string>();
	for (const key of search.keys()) {
		if (!allowed.includes(key) || seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}
function pageLimit(value: string | null): number | undefined {
	if (value === null) return 50;
	if (!/^[1-9][0-9]{0,2}$/u.test(value)) return undefined;
	const parsed = Number(value);
	return parsed <= MAX_PAGE_SIZE ? parsed : undefined;
}
function normalizedTimestamp(value: string | null): string | undefined {
	if (value === null || value.length > 64) return value === null ? "" : undefined;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}
function cursorFor(kind: string, scopeId: string, revision: string, filters: string, boundaryId: string): string {
	return createHash("sha256").update([kind, scopeId, revision, filters, boundaryId].join("\u0000")).digest("base64url");
}
function page<T extends { readonly id: string }>(
	items: readonly T[],
	kind: string,
	scopeId: string,
	revision: string,
	filters: string,
	limit: number,
	requestedCursor: string | null,
): { readonly items: readonly T[]; readonly nextCursor?: string } | undefined {
	let offset = 0;
	if (requestedCursor !== null) {
		if (!CURSOR.test(requestedCursor)) return undefined;
		const boundary = items.findIndex(item => cursorFor(kind, scopeId, revision, filters, item.id) === requestedCursor);
		if (boundary < 0 || boundary === items.length - 1) return undefined;
		offset = boundary + 1;
	}
	const selected = items.slice(offset, offset + limit);
	if (selected.length === 0) return { items: [] };
	const hasMore = offset + selected.length < items.length;
	return {
		items: selected,
		...(hasMore ? { nextCursor: cursorFor(kind, scopeId, revision, filters, selected.at(-1)!.id) } : {}),
	};
}
function publicWorkspace(workspace: RestWorkspaceProjection, scopeId: string): RestWorkspaceProjection & { readonly scopeId: string } {
	return { ...workspace, scopeId };
}
function publicRuntime(runtime: RestRuntimeProjection, scopeId: string): Omit<RestRuntimeProjection, "connectionReady"> & { readonly scopeId: string } {
	const { connectionReady: _connectionReady, ...resource } = runtime;
	return { ...resource, scopeId };
}
class DecodeError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "DecodeError";
	}
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new DecodeError("invalid_body", "The request body must be a JSON object.");
	return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], requireOne = false): void {
	const keys = Object.keys(value);
	if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)) || requireOne && keys.length === 0)
		throw new DecodeError("invalid_body", "The request body does not match the operation schema.");
}
function displayName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || [...value].length > 128 ||
		new TextEncoder().encode(value).byteLength > 512 || /\p{Cc}/u.test(value))
		throw new DecodeError("invalid_body", "displayName is invalid.");
	return value;
}
function opaqueId(value: unknown, field: string): string {
	if (typeof value !== "string" || !ID.test(value)) throw new DecodeError("invalid_body", `${field} is invalid.`);
	return value;
}
function idlePolicy(value: unknown): { readonly enabled: boolean; readonly idleSeconds?: number } {
	const input = record(value);
	if (input.enabled === false) {
		exactKeys(input, ["enabled"], ["enabled"]);
		return { enabled: false };
	}
	if (input.enabled === true) {
		exactKeys(input, ["enabled", "idleSeconds"], ["enabled", "idleSeconds"]);
		if (!Number.isSafeInteger(input.idleSeconds) || Number(input.idleSeconds) < 60 || Number(input.idleSeconds) > 2_592_000)
			throw new DecodeError("invalid_body", "idlePolicy.idleSeconds is invalid.");
		return { enabled: true, idleSeconds: Number(input.idleSeconds) };
	}
	throw new DecodeError("invalid_body", "idlePolicy.enabled is invalid.");
}
async function readJsonBody(request: Request, contentType: string): Promise<Record<string, unknown>> {
	if (request.headers.get("content-type") !== contentType) throw new DecodeError("invalid_content_type", `Content-Type must be ${contentType}.`);
	const declared = request.headers.get("content-length");
	if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > MAX_BODY_BYTES))
		throw new DecodeError("invalid_body", "The request body exceeds the byte limit.");
	if (!request.body) throw new DecodeError("invalid_body", "The request body is required.");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new DecodeError("invalid_body", "The request body exceeds the byte limit.");
		}
		chunks.push(chunk.value);
	}
	if (size === 0) throw new DecodeError("invalid_body", "The request body is required.");
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
	catch { throw new DecodeError("invalid_body", "The request body is not valid UTF-8 JSON."); }
	try { return record(JSON.parse(text)); }
	catch (error) {
		if (error instanceof DecodeError) throw error;
		throw new DecodeError("invalid_body", "The request body is not valid JSON.");
	}
}
function decodeWorkspaceCreate(value: Record<string, unknown>): RestWorkspaceCreateInput {
	exactKeys(value, ["scopeId", "displayName", "capacityBytes", "retention"], ["scopeId", "displayName", "capacityBytes", "retention"]);
	if (!Number.isSafeInteger(value.capacityBytes) || Number(value.capacityBytes) < 1_048_576 || Number(value.capacityBytes) > 1_125_899_906_842_624)
		throw new DecodeError("invalid_body", "capacityBytes is invalid.");
	if (value.retention !== "Retain" && value.retention !== "Delete") throw new DecodeError("invalid_body", "retention is invalid.");
	return {
		scopeId: opaqueId(value.scopeId, "scopeId"),
		displayName: displayName(value.displayName),
		capacityBytes: Number(value.capacityBytes),
		retention: value.retention,
	};
}
function decodeWorkspacePatch(value: Record<string, unknown>): RestWorkspacePatchInput {
	exactKeys(value, ["displayName", "retention"], [], true);
	if (value.retention !== undefined && value.retention !== "Retain" && value.retention !== "Delete")
		throw new DecodeError("invalid_body", "retention is invalid.");
	return {
		...(value.displayName !== undefined ? { displayName: displayName(value.displayName) } : {}),
		...(value.retention !== undefined ? { retention: value.retention } : {}),
	};
}
function decodeRuntimeCreate(value: Record<string, unknown>): RestRuntimeCreateInput {
	exactKeys(value, ["scopeId", "displayName", "workspaceId", "hostProfileId", "desiredState", "browserPolicy", "idlePolicy"],
		["scopeId", "displayName", "workspaceId", "hostProfileId", "desiredState", "browserPolicy"]);
	if (value.desiredState !== "Running" && value.desiredState !== "Sleeping" && value.desiredState !== "Stopped")
		throw new DecodeError("invalid_body", "desiredState is invalid.");
	if (value.browserPolicy !== "Allowed" && value.browserPolicy !== "Disabled")
		throw new DecodeError("invalid_body", "browserPolicy is invalid.");
	return {
		scopeId: opaqueId(value.scopeId, "scopeId"),
		displayName: displayName(value.displayName),
		workspaceId: opaqueId(value.workspaceId, "workspaceId"),
		hostProfileId: opaqueId(value.hostProfileId, "hostProfileId"),
		desiredState: value.desiredState,
		browserPolicy: value.browserPolicy,
		...(value.idlePolicy !== undefined ? { idlePolicy: idlePolicy(value.idlePolicy) } : {}),
	};
}
function decodeRuntimePatch(value: Record<string, unknown>): RestRuntimePatchInput {
	exactKeys(value, ["displayName", "desiredState", "browserPolicy", "idlePolicy"], [], true);
	if (value.desiredState !== undefined && value.desiredState !== "Running" && value.desiredState !== "Sleeping" && value.desiredState !== "Stopped")
		throw new DecodeError("invalid_body", "desiredState is invalid.");
	if (value.browserPolicy !== undefined && value.browserPolicy !== "Allowed" && value.browserPolicy !== "Disabled")
		throw new DecodeError("invalid_body", "browserPolicy is invalid.");
	return {
		...(value.displayName !== undefined ? { displayName: displayName(value.displayName) } : {}),
		...(value.desiredState !== undefined ? { desiredState: value.desiredState } : {}),
		...(value.browserPolicy !== undefined ? { browserPolicy: value.browserPolicy } : {}),
		...(value.idlePolicy !== undefined ? { idlePolicy: idlePolicy(value.idlePolicy) } : {}),
	};
}
function mutationWorkspace(result: RestMutationResult, scopeId: string): Record<string, unknown> {
	const spec = result.resource.spec ?? {};
	const status = result.resource.status ?? {};
	const createdAt = result.resource.metadata.creationTimestamp ?? "1970-01-01T00:00:00.000Z";
	const numericCapacity = typeof spec.size === "string" && /^(?:0|[1-9][0-9]*)$/u.test(spec.size) ? Number(spec.size) : 1_048_576;
	return {
		id: restResourceId("ws", result.resource),
		scopeId,
		displayName: typeof spec.displayName === "string" ? spec.displayName : "Workspace",
		capacityBytes: numericCapacity,
		retention: spec.retentionPolicy === "Delete" ? "Delete" : "Retain",
		phase: result.resource.metadata.deletionTimestamp ? "Deleting" : status.phase === "Ready" ? "Ready" : status.phase === "Failed" ? "Failed" : status.phase === "Pending" ? "Pending" : "Unavailable",
		attachmentCount: result.attachmentCount ?? 0,
		revision: portableWorkspaceRevision(restResourceRevision("workspace", result.resource), result.attachmentCount ?? 0),
		conditions: [],
		createdAt,
		updatedAt: createdAt,
	};
}
function mutationRuntime(result: RestMutationResult, scopeId: string): Record<string, unknown> {
	if (result.retainedBody) return { ...result.retainedBody };
	const spec = result.resource.spec ?? {};
	const status = result.resource.status ?? {};
	const desiredState = spec.desiredState === "Sleeping" || spec.desiredState === "Stopped" ? spec.desiredState : "Running";
	const createdAt = result.resource.metadata.creationTimestamp ?? "1970-01-01T00:00:00.000Z";
	const phase = result.resource.metadata.deletionTimestamp ? "Deleting"
		: status.phase === "Sleeping" ? "Sleeping"
		: status.phase === "Stopped" ? "Stopped"
		: status.phase === "Running" ? desiredState === "Running" ? "Starting" : "Starting"
		: status.phase === "Pending" ? "Provisioning"
		: status.phase === "Failed" ? "Failed" : "Unavailable";
	return {
		id: restResourceId("rt", result.resource),
		scopeId,
		displayName: typeof spec.title === "string" ? spec.title : "Runtime",
		workspaceId: result.workspace ? restResourceId("ws", result.workspace) : "unavailable",
		hostProfileId: typeof spec.publicHostProfileId === "string" ? spec.publicHostProfileId : typeof spec.runtimeProfile === "string" ? spec.runtimeProfile : "default",
		desiredState,
		phase,
		generation: String(result.resource.metadata.generation ?? 0),
		revision: restResourceRevision("runtime", result.resource),
		capabilities: [],
		conditions: [],
		createdAt,
		updatedAt: createdAt,
	};
}

function mutationProblem(path: string, error: unknown): Response {
	if (error instanceof ScopeAdmissionError) {
		const status = error.decision.reason === "creation_rate_limit" ? 429 : error.decision.reason === "admission_unavailable" ? 503 : 409;
		const retryAfter = error.decision.retryAfterSeconds;
		return problem(path, status, error.decision.reason, "Scope admission policy rejected the resource creation.", retryAfter === undefined ? undefined : { "retry-after": String(retryAfter) });
	}
	if (error instanceof DecodeError) return problem(path, 400, error.code, error.message);
	if (error instanceof RestMutationError) {
		const status = error.code === "not_found" ? 404
			: error.code === "revision_mismatch" ? 412
			: error.code === "invalid_resource" ? 422
			: error.code === "unavailable" || error.code === "idempotency_unavailable" ? 503 : 409;
		const detail = error.currentRevision ? `${error.message} Current revision: ${error.currentRevision}.` : error.message;
		return problem(path, status, error.code, detail, status === 503 ? { "retry-after": "1" } : undefined, error.currentRevision);
	}
	return problem(path, 503, "unavailable", "Kubernetes mutation authority is unavailable.", { "retry-after": "1" });
}
function mutationResponse(kind: "workspace" | "runtime", result: RestMutationResult, scopeId: string, status: number): Response {
	const body = kind === "workspace" ? mutationWorkspace(result, scopeId) : mutationRuntime(result, scopeId);
	const id = String(body.id);
	const revision = result.retainedEtag ?? `"${String(body.revision)}"`;
	return json(body, {
		status,
		headers: {
			etag: revision,
			...(status === 201 || status === 202 ? { location: `/v1/${kind === "workspace" ? "workspaces" : "runtimes"}/${id}` } : {}),
			...(status === 202 ? { "retry-after": "1" } : {}),
		},
	});
}
async function handleMutation(
	options: ClusterRestHandlerOptions,
	request: Request,
	identity: RequestIdentity,
	path: string,
	resource: "workspaces" | "runtimes",
	publicId: string,
	action: "wake" | "sleep" | undefined,
	requestId: string,
	authorize: (scopeId: string, action: AuthorizationAction, resourceId?: string) => boolean,
): Promise<Response> {
	const methodAction: AuthorizationAction | undefined = action
		? action === "wake" ? "runtime.wake" : "runtime.sleep"
		: request.method === "PUT" ? resource === "workspaces" ? "workspace.create" : "runtime.create"
		: request.method === "PATCH" ? resource === "workspaces" ? "workspace.update" : "config.write"
		: request.method === "DELETE" ? resource === "workspaces" ? "workspace.delete" : "runtime.delete"
		: undefined;
	const query = new URL(request.url).searchParams;
	if (!exactQuery(query, ["scopeId"])) return problem(path, 400, "invalid_query", "Resource scope selection is invalid.");
	const requestedScope = query.get("scopeId");
	if (requestedScope !== null && !ID.test(requestedScope))
		return problem(path, 400, "invalid_scope", "The requested scope is unavailable.");
	const requestedScopeId = authorizationScopeId(identity, requestedScope ?? "personal");
	let selected: { readonly scopeId: string; readonly owner: string } | undefined;
	try {
		if (request.method === "PUT") {
			if (request.headers.get("if-none-match") !== "*")
				return problem(path, 412, "revision_mismatch", "If-None-Match must be *.");
			if (resource === "workspaces") {
				const decoded = decodeWorkspaceCreate(await readJsonBody(request, "application/json"));
				const scopeId = authorizationScopeId(identity, decoded.scopeId);
				if (requestedScope !== null && requestedScopeId !== scopeId)
					return problem(path, 400, "invalid_scope", "The request scope does not match its body.");
				if (!methodAction || !authorize(scopeId, methodAction, publicId))
					return problem(path, 404, "not_found", "The requested scope was not found.");
				const owner = scopeOwner(options, identity, scopeId);
				if (!owner) return problem(path, 404, "not_found", "The requested scope was not found.");
				selected = { scopeId, owner };
				if (!options.mutations) return problem(path, 503, "unavailable", "REST lifecycle mutation authority is unavailable.", { "retry-after": "1" });
				const operation = () => options.mutations!.putRestWorkspace(publicId, { ...decoded, scopeId }, owner, identity);
				const result = options.admission
					? await options.admission.createWorkspace(scopeId, owner, publicId, { ...decoded, scopeId }, operation)
					: await operation();
				const body = mutationWorkspace(result, scopeId);
				return mutationResponse("workspace", result, scopeId, body.phase === "Ready" ? result.created ? 201 : 200 : 202);
			}
			const decoded = decodeRuntimeCreate(await readJsonBody(request, "application/json"));
			const scopeId = authorizationScopeId(identity, decoded.scopeId);
			if (requestedScope !== null && requestedScopeId !== scopeId)
				return problem(path, 400, "invalid_scope", "The request scope does not match its body.");
			if (!methodAction || !authorize(scopeId, methodAction, publicId))
				return problem(path, 404, "not_found", "The requested scope was not found.");
			const owner = scopeOwner(options, identity, scopeId);
			if (!owner) return problem(path, 404, "not_found", "The requested scope was not found.");
			selected = { scopeId, owner };
			if (!options.mutations) return problem(path, 503, "unavailable", "REST lifecycle mutation authority is unavailable.", { "retry-after": "1" });
			const operation = () => options.mutations!.putRestRuntime(publicId, { ...decoded, scopeId }, owner, identity);
			const result = options.admission
				? await options.admission.createRuntime(scopeId, owner, publicId, { ...decoded, scopeId }, operation)
				: await operation();
			const body = mutationRuntime(result, scopeId);
			return mutationResponse("runtime", result, scopeId, body.phase === "Ready" ? result.created ? 201 : 200 : 202);
		}
		if (!methodAction)
			return problem(path, 405, "method_not_allowed", "The method is not supported for this resource.", { allow: "GET, PUT, PATCH, DELETE" });
		selected = resolvedResourceScope(options, identity, requestedScopeId, resource, publicId, methodAction, authorize);
		if (!selected && request.method === "DELETE" && options.admission && authorize(requestedScopeId, methodAction, publicId)) {
			const owner = scopeOwner(options, identity, requestedScopeId);
			if (owner && await options.admission.resumeDeletion(requestedScopeId, resource === "workspaces" ? "workspace" : "runtime", publicId))
				return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
		}
		if (!selected) return problem(path, 404, "not_found", "The requested resource was not found.");
		if (!options.mutations) return problem(path, 503, "unavailable", "REST lifecycle mutation authority is unavailable.", { "retry-after": "1" });
		const { scopeId, owner } = selected;
		if (action) {
			if (request.method !== "POST") return problem(path, 405, "method_not_allowed", "Only POST is supported for this resource.", { allow: "POST" });
			if (request.body !== null || request.headers.has("content-type")) throw new DecodeError("invalid_body", "Runtime actions do not accept a request body.");
			const key = request.headers.get("idempotency-key");
			if (!key || !IDEMPOTENCY_KEY.test(key)) throw new DecodeError("invalid_idempotency_key", "Idempotency-Key is invalid.");
			const expected = ENTITY_TAG.exec(request.headers.get("if-match") ?? "")?.[1] ?? "";
			const binding = createHash("sha256")
				.update(identity.principalId).update("\u0000").update(owner).update("\u0000").update(scopeId).update("\u0000")
				.update(request.method).update("\u0000").update(path).update("\u0000").update("sha256:e3b0c44298fc1c149afbf4c8996fb924")
				.digest("hex");
			const operation = () => options.mutations!.mutateRestRuntimeAction(publicId, expected, key, binding, action === "wake" ? "Running" : "Sleeping", owner, identity);
			const result = action === "wake" && options.admission
				? await options.admission.wakeRuntime(scopeId, owner, publicId, operation)
				: await operation();
			if (action === "sleep" && options.admission) await options.admission.retireRuntime(scopeId, publicId, ["activate"]);
			return mutationResponse("runtime", result, scopeId, result.retainedStatus ?? 202);
		}
		if (request.method === "PATCH") {
			const expected = ENTITY_TAG.exec(request.headers.get("if-match") ?? "")?.[1] ?? "";
			if (resource === "workspaces") {
				const patch = decodeWorkspacePatch(await readJsonBody(request, "application/merge-patch+json"));
				const result = await options.mutations.patchRestWorkspace(publicId, expected, patch, owner, identity);
				return mutationResponse("workspace", result, scopeId, mutationWorkspace(result, scopeId).phase === "Ready" ? 200 : 202);
			}
			const patch = decodeRuntimePatch(await readJsonBody(request, "application/merge-patch+json"));
			const operation = () => options.mutations!.patchRestRuntime(publicId, expected, patch, owner, identity);
			const result = options.admission
				? await options.admission.patchRuntime(scopeId, owner, publicId, patch, operation)
				: await operation();
			if (options.admission) {
				const retired: ("activate" | "enableBrowser")[] = [];
				if (patch.desiredState === "Sleeping" || patch.desiredState === "Stopped") retired.push("activate");
				if (patch.browserPolicy === "Disabled") retired.push("enableBrowser");
				if (retired.length > 0) await options.admission.retireRuntime(scopeId, publicId, retired);
			}
			return mutationResponse("runtime", result, scopeId, mutationRuntime(result, scopeId).phase === "Ready" ? 200 : 202);
		}
		if (request.method === "DELETE") {
			if (request.body !== null || request.headers.has("content-type")) throw new DecodeError("invalid_body", "DELETE does not accept a request body.");
			const expected = ENTITY_TAG.exec(request.headers.get("if-match") ?? "")?.[1] ?? "";
			const resourceKind = resource === "workspaces" ? "workspace" : "runtime";
			await options.admission?.beginDeletion(scopeId, resourceKind, publicId);
			if (resource === "workspaces") {
				await options.mutations.deleteRestWorkspace(publicId, expected, owner, identity);
			} else {
				await options.mutations.deleteRestRuntime(publicId, expected, owner, identity);
			}
			await options.admission?.finishDeletion(scopeId, resourceKind, publicId);
			return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
		}
		return problem(path, 405, "method_not_allowed", "The method is not supported for this resource.", { allow: "GET, PUT, PATCH, DELETE" });
	} catch (error) {
		if (methodAction && selected)
			options.authorizer?.error({ identity, scopeId: selected.scopeId, action: methodAction, gateway: "rest", requestId, resourceId: publicId });
		return mutationProblem(path, error);
	}
}

async function handleEvents(
	source: ClusterLifecycleEventSource,
	request: Request,
	identity: RequestIdentity,
	path: string,
	scopeId: string,
	principal: string,
	authorizer: Authorizer | undefined,
	requestId: string,
): Promise<Response> {
	const lastEventId = request.headers.get("last-event-id") ?? undefined;
	if (lastEventId !== undefined && !EVENT_ID.test(lastEventId))
		return problem(path, 400, "invalid_event_cursor", "Last-Event-ID is invalid.");
	try {
		return await source.response(principal, lastEventId, request.signal, scopeId, identity);
	} catch {
		authorizer?.error({ identity, scopeId, action: "scope.read", gateway: "sse", requestId });
		return problem(path, 503, "event_stream_unavailable", "The lifecycle event stream is temporarily unavailable.");
	}
}

export function createClusterRestHandler(options: ClusterRestHandlerOptions): (request: Request, identity?: RequestIdentity) => Response | Promise<Response> {
	const now = options.now ?? (() => new Date());
	const directCmuxWebSocket = options.directCmuxWebSocket === true && isValidCmuxWebSocketTemplate(options.config.cmuxWebSocketTemplate);
	return (request, identity) => {
		const requestId = createAuthorizationRequestId();
		const authorize = (scopeId: string, action: AuthorizationAction, resourceId?: string, gateway: "rest" | "sse" = "rest"): boolean =>
			identity !== undefined && (options.authorizer
				? options.authorizer.decide({ identity, scopeId, action, gateway, requestId, ...(resourceId ? { resourceId } : {}) }).allowed
				: isAuthorized(identity, scopeId, action));
		const principal = identity?.principalId;
		const url = new URL(request.url);
		const path = url.pathname;
		const wellKnown = path === "/.well-known/omperator";
		const resourceMatch = /^\/v1\/(workspaces|runtimes)\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127})(\/connections)?$/u.exec(path);
		const actionMatch = /^\/v1\/runtimes\/([A-Za-z0-9][A-Za-z0-9._~-]{0,127}):(wake|sleep)$/u.exec(path);
		const supportedResource = resourceMatch !== null && !(resourceMatch[1] === "workspaces" && resourceMatch[3] !== undefined);
		const recognized = wellKnown || path === "/v1/version" || path === "/v1/capabilities" || path === "/v1/scopes" || path === "/v1/workspaces" || path === "/v1/runtimes" || options.eventSource !== undefined && path === "/v1/events" || supportedResource || actionMatch !== null;
		if (wellKnown) {
			if (request.method !== "GET") return problem(path, 405, "method_not_allowed", "Only GET is supported for this resource.", { allow: "GET" });
			if (url.search !== "") return problem(path, 400, "invalid_query", "Discovery does not accept query parameters.");
			return json({
				service: "omperator",
				apiVersion: "v1",
				restBaseUrl: options.config.restBaseUrl,
				ompAppWebSocketUrl: options.config.ompAppWebSocketUrl,
				...(directCmuxWebSocket ? { cmuxWebSocketTemplate: options.config.cmuxWebSocketTemplate } : {}),
				protocols: PROTOCOLS,
			});
		}
		if (path.startsWith("/v1/") && !principal) return problem(path, 401, "authentication_required", "An authenticated request identity is required.");
		if (!recognized) return problem(path, 404, "not_found", "The requested resource was not found.");
		if (!principal) return problem(path, 404, "not_found", "The requested resource was not found.");
		if (path === "/v1/events") {
			if (request.method !== "GET") return problem(path, 405, "method_not_allowed", "Only GET is supported for this resource.", { allow: "GET" });
			if (!exactQuery(url.searchParams, ["scopeId"])) return problem(path, 400, "invalid_query", "Event filters are invalid.");
			const selectedScope = url.searchParams.get("scopeId");
			const scopeId = authorizationScopeId(identity!, selectedScope ?? "personal");
			if (selectedScope !== null && !ID.test(selectedScope))
				return problem(path, 400, "invalid_scope", "The requested event scope is unavailable.");
			if (!authorize(scopeId, "scope.read", undefined, "sse"))
				return problem(path, 404, "not_found", "The requested scope was not found.");
			const owner = scopeOwner(options, identity!, scopeId);
			if (!owner) return problem(path, 404, "not_found", "The requested scope was not found.");
			return handleEvents(options.eventSource!, request, identity!, path, scopeId, owner, options.authorizer, requestId);
		}
		if (actionMatch) return handleMutation(options, request, identity!, path, "runtimes", actionMatch[1]!, actionMatch[2] as "wake" | "sleep", requestId, authorize);
		if (resourceMatch && resourceMatch[3] === undefined && request.method !== "GET")
			return handleMutation(options, request, identity!, path, resourceMatch[1] as "workspaces" | "runtimes", resourceMatch[2]!, undefined, requestId, authorize);
		if (request.method !== "GET") return problem(path, 405, "method_not_allowed", "Only GET is supported for this resource.", { allow: "GET" });
		const personalScopeId = requestIdentityScopeId(identity!);
		const candidateScopes = authorizedScopeCandidates(identity!);
		if (path === "/v1/version") {
			if (url.search !== "") return problem(path, 400, "invalid_query", "Version does not accept query parameters.");
			if (!candidateScopes.some(scopeId => authorize(scopeId, "scope.read"))) return problem(path, 404, "not_found", "The requested resource was not found.");
			return json({ apiVersion: "v1", build: options.config.build, protocols: PROTOCOLS });
		}
		if (path === "/v1/capabilities") {
			if (url.search !== "") return problem(path, 400, "invalid_query", "Capabilities do not accept query parameters.");
			if (!candidateScopes.some(scopeId => authorize(scopeId, "scope.read")))
				return problem(path, 404, "not_found", "The requested resource was not found.");
			const canMutate = options.mutations !== undefined && candidateScopes.some(scopeId =>
				authorize(scopeId, "workspace.create") ||
				authorize(scopeId, "runtime.create") ||
				authorize(scopeId, "config.write")
			);
			return json({
				apiVersion: "v1",
				protocols: {
					machineProvider: { versions: [1], capabilities: [] },
					cmux: { versions: [10] },
					ompApp: { versions: [1] },
				},
				limits: {
					maxActiveRuntimes: options.projection.maxSessions,
					maxRetainedRuntimes: options.projection.maxSessions,
					idempotencyRetentionSeconds: 86_400,
					eventRetentionSeconds: 60,
					maxPageSize: MAX_PAGE_SIZE,
				},
				features: {
					restLifecycle: canMutate,
					sshProvider: false,
					directCmuxWebSocket: directCmuxWebSocket && candidateScopes.some(scopeId => authorize(scopeId, "runtime.connect.cmux")),
					browser: false,
					scaleToZero: false,
				},
			});
		}
		if (path === "/v1/scopes") {
			if (!exactQuery(url.searchParams, ["limit", "cursor"])) return problem(path, 400, "invalid_query", "Scope filters are invalid.");
			const limit = pageLimit(url.searchParams.get("limit"));
			if (limit === undefined || url.searchParams.has("cursor")) return problem(path, 400, "invalid_cursor", "The scope cursor or limit is invalid.");
			const items = candidateScopes.slice(0, limit).flatMap(scopeId => {
				if (!authorize(scopeId, "scope.read")) return [];
				const owner = scopeOwner(options, identity!, scopeId);
				if (!owner) return [];
				const projection = options.projection.restProjection(owner);
				return [{ id: scopeId, displayName: scopeId === personalScopeId ? "Personal" : "Shared", kind: scopeId === personalScopeId ? "Personal" : "Shared", revision: projection.revision }];
			});
			return json({ items });
		}
		if (path === "/v1/workspaces") {
			if (!exactQuery(url.searchParams, ["limit", "cursor", "phase", "scopeId", "updatedSince"])) return problem(path, 400, "invalid_query", "Workspace filters are invalid.");
			const limit = pageLimit(url.searchParams.get("limit"));
			const phase = url.searchParams.get("phase");
			const selectedScope = url.searchParams.get("scopeId");
			const scopeId = authorizationScopeId(identity!, selectedScope ?? "personal");
			const updatedSince = normalizedTimestamp(url.searchParams.get("updatedSince"));
			if (limit === undefined || phase !== null && !PHASES.has(phase) || selectedScope !== null && !ID.test(selectedScope) || updatedSince === undefined) return problem(path, 400, "invalid_query", "Workspace filters are invalid.");
			if (!authorize(scopeId, "workspace.read")) return problem(path, 404, "not_found", "The requested resource was not found.");
			const owner = scopeOwner(options, identity!, scopeId);
			if (!owner) return problem(path, 404, "not_found", "The requested resource was not found.");
			const projection = options.projection.restProjection(owner);
			const items = projection.workspaces
				.filter(item => phase === null || item.phase === phase)
				.filter(item => updatedSince === "" || item.updatedAt >= updatedSince)
				.map(item => publicWorkspace(item, scopeId));
			const filters = JSON.stringify({ phase, selectedScope, updatedSince });
			const result = page(items, "workspaces", scopeId, projection.revision, filters, limit, url.searchParams.get("cursor"));
			return result ? json(result) : problem(path, 400, "invalid_cursor", "The workspace cursor is invalid or stale.");
		}
		if (path === "/v1/runtimes") {
			if (!exactQuery(url.searchParams, ["limit", "cursor", "desiredState", "phase", "scopeId", "updatedSince", "workspaceId"])) return problem(path, 400, "invalid_query", "Runtime filters are invalid.");
			const limit = pageLimit(url.searchParams.get("limit"));
			const desiredState = url.searchParams.get("desiredState");
			const phase = url.searchParams.get("phase");
			const selectedScope = url.searchParams.get("scopeId");
			const scopeId = authorizationScopeId(identity!, selectedScope ?? "personal");
			const workspaceId = url.searchParams.get("workspaceId");
			const updatedSince = normalizedTimestamp(url.searchParams.get("updatedSince"));
			if (limit === undefined || desiredState !== null && !DESIRED_STATES.has(desiredState) || phase !== null && !PHASES.has(phase) || selectedScope !== null && !ID.test(selectedScope) || workspaceId !== null && !ID.test(workspaceId) || updatedSince === undefined) return problem(path, 400, "invalid_query", "Runtime filters are invalid.");
			if (!authorize(scopeId, "runtime.read")) return problem(path, 404, "not_found", "The requested resource was not found.");
			const owner = scopeOwner(options, identity!, scopeId);
			if (!owner) return problem(path, 404, "not_found", "The requested resource was not found.");
			const projection = options.projection.restProjection(owner);
			const items = projection.runtimes
				.filter(item => desiredState === null || item.desiredState === desiredState)
				.filter(item => phase === null || item.phase === phase)
				.filter(item => workspaceId === null || item.workspaceId === workspaceId)
				.filter(item => updatedSince === "" || item.updatedAt >= updatedSince)
				.map(item => publicRuntime(item, scopeId));
			const filters = JSON.stringify({ desiredState, phase, selectedScope, updatedSince, workspaceId });
			const result = page(items, "runtimes", scopeId, projection.revision, filters, limit, url.searchParams.get("cursor"));
			return result ? json(result) : problem(path, 400, "invalid_cursor", "The runtime cursor is invalid or stale.");
		}
		if (resourceMatch) {
			if (!exactQuery(url.searchParams, ["scopeId"])) return problem(path, 400, "invalid_query", "Resource scope selection is invalid.");
			const selectedScope = url.searchParams.get("scopeId");
			if (selectedScope !== null && !ID.test(selectedScope)) return problem(path, 400, "invalid_scope", "The requested scope is unavailable.");
			const kind = resourceMatch[1] as "workspaces" | "runtimes";
			const id = resourceMatch[2]!;
			const connections = resourceMatch[3] !== undefined;
			const readAction: AuthorizationAction = kind === "workspaces" ? "workspace.read" : "runtime.read";
			const selected = resolvedResourceScope(options, identity!, authorizationScopeId(identity!, selectedScope ?? "personal"), kind, id, readAction, authorize);
			if (!selected) return problem(path, 404, "not_found", "The requested resource was not found.");
			const { scopeId, owner } = selected;
			const projection = options.projection.restProjection(owner);
			if (connections && kind !== "runtimes") return problem(path, 404, "not_found", "The requested resource was not found.");
			if (kind === "workspaces") {
				const workspace = projection.workspaces.find(item => item.id === id);
				return workspace ? json(publicWorkspace(workspace, scopeId), { headers: { etag: `"${workspace.revision}"` } }) : problem(path, 404, "not_found", "The requested resource was not found.");
			}
			const runtime = projection.runtimes.find(item => item.id === id);
			if (!runtime) return problem(path, 404, "not_found", "The requested resource was not found.");
			if (!connections) return json(publicRuntime(runtime, scopeId), { headers: { etag: `"${runtime.revision}"` } });
			if (!runtime.connectionReady) return problem(path, 409, "runtime_not_ready", "The runtime does not currently have an authorized ready route.");
			const ompAppAllowed = authorize(scopeId, "runtime.connect.omp-app", runtime.id);
			const cmuxAllowed = directCmuxWebSocket && authorize(scopeId, "runtime.connect.cmux", runtime.id)
				&& options.projection.cmuxWebSocketRoute(runtime.id, owner) !== undefined;
			const expiresAt = new Date(now().getTime() + 300_000).toISOString();
			const cmuxUrl = cmuxAllowed ? options.config.cmuxWebSocketTemplate!.replace("{runtimeId}", encodeURIComponent(runtime.id)) : undefined;
			const descriptorRevision = digest("rev", runtime.revision, runtime.generation, ompAppAllowed ? options.config.ompAppWebSocketUrl : "", cmuxUrl ?? "", expiresAt);
			return json({
				runtimeId: runtime.id,
				generation: runtime.generation,
				expiresAt,
				routes: [
					...(ompAppAllowed ? [{ kind: "omp-app-websocket", url: options.config.ompAppWebSocketUrl, protocol: "omp-app/1" }] : []),
					...(cmuxUrl ? [{ kind: "cmux-websocket", url: cmuxUrl, protocol: 10 }] : []),
				],
			}, { headers: { etag: `"${descriptorRevision}"` } });
		}
		return problem(path, 404, "not_found", "The requested resource was not found.");
	};
}
