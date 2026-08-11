import { createHash, randomUUID } from "node:crypto";

export const AUTHORIZATION_ACTIONS = Object.freeze([
	"scope.read",
	"scope.admin",
	"workspace.read",
	"workspace.create",
	"workspace.update",
	"workspace.delete",
	"workspace.purge",
	"runtime.read",
	"runtime.create",
	"runtime.wake",
	"runtime.sleep",
	"runtime.stop",
	"runtime.delete",
	"runtime.purge",
	"runtime.connect.cmux",
	"runtime.connect.omp-app",
	"browser.read",
	"browser.control",
	"browser.input",
	"settings.read",
	"settings.write",
	"config.read",
	"config.write",
	"destructive.confirm",
] as const);

export type AuthorizationAction = (typeof AUTHORIZATION_ACTIONS)[number];
export type AuthorizationRole = "reader" | "writer" | "admin";
export type AuthorizationResult = "allow" | "deny" | "error";
export type AuthorizationGateway = "rest" | "sse" | "omp-app" | "cmux" | "ssh" | "lifecycle";

const READER_ACTIONS = Object.freeze([
	"scope.read",
	"workspace.read",
	"runtime.read",
	"browser.read",
	"settings.read",
	"config.read",
] as const satisfies readonly AuthorizationAction[]);
const WRITER_ACTIONS = Object.freeze([
	...READER_ACTIONS,
	"workspace.create",
	"workspace.update",
	"workspace.delete",
	"runtime.create",
	"runtime.wake",
	"runtime.sleep",
	"runtime.stop",
	"runtime.delete",
	"runtime.connect.cmux",
	"runtime.connect.omp-app",
	"browser.control",
	"browser.input",
	"settings.write",
	"config.write",
	"destructive.confirm",
] as const satisfies readonly AuthorizationAction[]);
const ADMIN_ACTIONS = Object.freeze([
	...WRITER_ACTIONS,
	"scope.admin",
	"workspace.purge",
	"runtime.purge",
] as const satisfies readonly AuthorizationAction[]);

export const AUTHORIZATION_ROLE_ACTIONS: Readonly<Record<AuthorizationRole, readonly AuthorizationAction[]>> = Object.freeze({
	reader: READER_ACTIONS,
	writer: WRITER_ACTIONS,
	admin: ADMIN_ACTIONS,
});
const ROLE_NAMES: Readonly<Record<AuthorizationRole, true>> = Object.freeze({ reader: true, writer: true, admin: true });
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const OPAQUE_PRINCIPAL = /^id_[A-Za-z0-9_-]{16,128}$/u;
const POLICY_REVISION = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ABSENT_RESOURCE = "absent";

export interface AuthorizationIdentity {
	readonly principalId: string;
	readonly authorizedScopes: readonly Readonly<{ readonly scopeId: string; readonly roles: readonly string[] }>[];
	readonly policyRevision: string;
}

export interface AuthorizationAuditEvent {
	readonly principalId: string;
	readonly scopeId: string;
	readonly action: AuthorizationAction;
	readonly resourceId: string;
	readonly result: AuthorizationResult;
	readonly policyRevision: string;
	readonly requestId: string;
	readonly timestamp: string;
	readonly gateway: AuthorizationGateway;
}

export type AuthorizationAuditSink = (event: AuthorizationAuditEvent) => void | Promise<void>;

export interface AuthorizationRequest {
	readonly identity: AuthorizationIdentity;
	readonly scopeId: string;
	readonly action: AuthorizationAction;
	readonly gateway: AuthorizationGateway;
	readonly requestId?: string;
	readonly resourceId?: string;
}

export interface AuthorizationDecision {
	readonly allowed: boolean;
	readonly scopeId: string;
	readonly action: AuthorizationAction;
	readonly requestId: string;
}

export function isAuthorizationRole(value: string): value is AuthorizationRole {
	return Object.hasOwn(ROLE_NAMES, value);
}

export function assertAuthorizationRole(value: string): asserts value is AuthorizationRole {
	if (!isAuthorizationRole(value)) throw new Error("identity authorization role is invalid");
}

export function authorizationScopeId(identity: AuthorizationIdentity, configuredScopeId: string): string {
	return configuredScopeId === "personal"
		? `scope_${createHash("sha256").update(identity.principalId).digest("base64url").slice(0, 24)}`
		: configuredScopeId;
}

export function authorizedScopeActions(identity: AuthorizationIdentity, scopeId: string): ReadonlySet<AuthorizationAction> {
	const personalScopeId = authorizationScopeId(identity, "personal");
	if (identity.authorizedScopes.length === 0)
		return scopeId === personalScopeId ? new Set(ADMIN_ACTIONS) : new Set();
	const actions = new Set<AuthorizationAction>();
	for (const grant of identity.authorizedScopes) {
		if (authorizationScopeId(identity, grant.scopeId) !== scopeId) continue;
		for (const role of grant.roles) {
			if (!isAuthorizationRole(role)) continue;
			for (const action of AUTHORIZATION_ROLE_ACTIONS[role]) actions.add(action);
		}
	}
	return actions;
}

export function isAuthorized(identity: AuthorizationIdentity, scopeId: string, action: AuthorizationAction): boolean {
	return authorizedScopeActions(identity, scopeId).has(action);
}

export function createAuthorizationRequestId(): string {
	return randomUUID();
}

function auditEvent(request: AuthorizationRequest, result: AuthorizationResult, requestId: string): AuthorizationAuditEvent {
	return Object.freeze({
		principalId: OPAQUE_PRINCIPAL.test(request.identity.principalId) ? request.identity.principalId : "id_invalid",
		scopeId: PUBLIC_ID.test(request.scopeId) ? request.scopeId : "invalid",
		action: request.action,
		resourceId: request.resourceId && PUBLIC_ID.test(request.resourceId) ? request.resourceId : ABSENT_RESOURCE,
		result,
		policyRevision: POLICY_REVISION.test(request.identity.policyRevision) ? request.identity.policyRevision : "invalid",
		requestId: REQUEST_ID.test(requestId) ? requestId : createAuthorizationRequestId(),
		timestamp: new Date().toISOString(),
		gateway: request.gateway,
	});
}

export class Authorizer {
	readonly #maximumPending: number;
	readonly #sink: AuthorizationAuditSink | undefined;
	readonly #queue: AuthorizationAuditEvent[] = [];
	#draining = false;

	constructor(sink?: AuthorizationAuditSink, maximumPending = 128) {
		this.#sink = sink;
		this.#maximumPending = Number.isSafeInteger(maximumPending) && maximumPending >= 1 && maximumPending <= 4_096 ? maximumPending : 128;
	}

	decide(request: AuthorizationRequest): AuthorizationDecision {
		const requestId = request.requestId && REQUEST_ID.test(request.requestId) ? request.requestId : createAuthorizationRequestId();
		const allowed = isAuthorized(request.identity, request.scopeId, request.action);
		this.#emit(auditEvent(request, allowed ? "allow" : "deny", requestId));
		return Object.freeze({ allowed, scopeId: request.scopeId, action: request.action, requestId });
	}

	error(request: AuthorizationRequest): void {
		const requestId = request.requestId && REQUEST_ID.test(request.requestId) ? request.requestId : createAuthorizationRequestId();
		this.#emit(auditEvent(request, "error", requestId));
	}

	#emit(event: AuthorizationAuditEvent): void {
		if (!this.#sink) return;
		if (this.#queue.length >= this.#maximumPending) {
			if (event.result === "allow") return;
			const replaceable = this.#queue.findIndex(queued => queued.result === "allow");
			if (replaceable < 0) return;
			this.#queue.splice(replaceable, 1);
		}
		this.#queue.push(event);
		if (this.#draining) return;
		this.#draining = true;
		queueMicrotask(() => { void this.#drain(); });
	}

	async #drain(): Promise<void> {
		try {
			for (let event = this.#queue.shift(); event; event = this.#queue.shift()) {
				try {
					const pending = this.#sink!(event);
					if (pending && typeof pending.then === "function") await pending;
				} catch {
					// Audit transport failure must never affect the authorization decision.
				}
			}
		} finally {
			this.#draining = false;
			if (this.#queue.length > 0) {
				this.#draining = true;
				queueMicrotask(() => { void this.#drain(); });
			}
		}
	}
}
