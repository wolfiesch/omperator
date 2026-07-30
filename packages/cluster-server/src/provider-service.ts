import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { SharedProviderConnectionRegistry, createProviderControlSession, runProviderStream, type CmuxRouteOpener, type DuplexByteStream, type ProviderAuthorizationRequest, type ProviderControlSession, type ProviderIngressIdentity, type ProviderMetricsSink } from "@t4-code/provider-engine";
import type { ScopeAdmissionPolicy } from "@t4-code/portable-core";
import type { SharedPortableControlLedger } from "@t4-code/portable-control-store";
import { readBoundedRegularBytes } from "./config.ts";
import { AUTHORIZATION_ACTIONS, Authorizer, createAuthorizationRequestId, type AuthorizationAction, type AuthorizationIdentity } from "./authorization.ts";
import { createKubernetesDriver, type KubernetesDriver, type KubernetesDriverControlStore } from "./kubernetes-driver.ts";
import type { KubernetesResourceApi } from "./kubernetes-client.ts";
import type { ClusterInfrastructureProjection } from "./kubernetes-projection.ts";
import type { ClusterMetrics } from "./observability.ts";

const ACTIONS = new Set<string>(AUTHORIZATION_ACTIONS);
const capabilities = Object.freeze({ apiVersion: "v1" as const, protocols: { machineProvider: { versions: [1] as const, capabilities: ["runtime.lifecycle", "workspace.lifecycle", "cmux.transport"] }, cmux: { versions: [10] as const }, ompApp: { versions: [1] as const } }, limits: { maxActiveRuntimes: 100_000, maxRetainedRuntimes: 100_000, idempotencyRetentionSeconds: 86_400, eventRetentionSeconds: 604_800, maxPageSize: 200 }, features: { restLifecycle: true, sshProvider: true, directCmuxWebSocket: true, browser: true, scaleToZero: true } });
export interface ProviderAuthority { readonly identity: AuthorizationIdentity; readonly scopeId: string; readonly ownerPrincipal: string; readonly gateway: "rest" | "ssh"; }
export interface ClusterProviderServiceOptions { readonly api: KubernetesResourceApi; readonly projection: ClusterInfrastructureProjection; readonly controlStore: SharedPortableControlLedger & KubernetesDriverControlStore; readonly hostRef: string; readonly admissionPolicy: ScopeAdmissionPolicy; readonly authorizer: Authorizer; readonly metrics: ClusterMetrics; readonly routeOpener: (authority: ProviderAuthority) => CmuxRouteOpener; }
export interface OpenProviderControl { readonly session: ProviderControlSession; close(): Promise<void>; }
function providerAction(value: string): AuthorizationAction | undefined { const normalized = value === "destructive.confirmation" ? "destructive.confirm" : value; return ACTIONS.has(normalized) ? normalized as AuthorizationAction : undefined; }
function metricsSink(metrics: ClusterMetrics): ProviderMetricsSink { return { increment(name, labels) { metrics.increment(name, labels); }, observe(name, value, labels) { metrics.observe(name, value, labels); } }; }
function publicId(prefix: string, mutationId: string): string { return `${prefix}_${createHash("sha256").update(mutationId).digest("base64url").slice(0, 24)}`; }
const ASSERTION = /^[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{43}$/u;
const ID = /^[^\p{Cc}]{1,256}$/u;
const KID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
const KEY_OVERLAP_SECONDS = 300;
export const PROVIDER_ASSERTION_PURPOSE = Object.freeze({ control: "provider.control", stream: "provider.stream" } as const);
interface ProviderAssertionKeyring { readonly revision: number; readonly activeKid: string; readonly previousKid?: string; readonly previousNotAfter?: number; readonly keys: readonly { readonly kid: string; readonly secret: Uint8Array; readonly notAfter?: number }[]; }
async function readKeyring(path: string, nowSeconds: number): Promise<ProviderAssertionKeyring> {
	const bytes = await readBoundedRegularBytes(path, 16_384, "provider assertion keyring");
	const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
	if (Object.keys(value).sort().join(",") !== "activeKid,keys,revision" || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.activeKid !== "string" || !KID.test(value.activeKid) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 2) throw new TypeError("provider assertion keyring is invalid");
	const keys = value.keys.map(candidate => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("provider assertion keyring is invalid");
		const item = candidate as Record<string, unknown>, names = Object.keys(item).sort().join(",");
		if (names !== "kid,secret" && names !== "kid,notAfter,secret") throw new TypeError("provider assertion keyring is invalid");
		if (typeof item.kid !== "string" || !KID.test(item.kid) || typeof item.secret !== "string" || !/^[A-Za-z0-9_-]{43,5462}$/u.test(item.secret)) throw new TypeError("provider assertion keyring is invalid");
		const secret = Buffer.from(item.secret, "base64url");
		if (secret.byteLength < 32 || secret.byteLength > 4_096) throw new TypeError("provider assertion keyring is invalid");
		if (item.notAfter !== undefined && (!Number.isSafeInteger(item.notAfter) || (item.notAfter as number) > nowSeconds + KEY_OVERLAP_SECONDS)) throw new TypeError("provider assertion keyring overlap is invalid");
		return { kid: item.kid, secret: new Uint8Array(secret), ...(item.notAfter === undefined ? {} : { notAfter: item.notAfter as number }) };
	});
	if (new Set(keys.map(item => item.kid)).size !== keys.length || !keys.some(item => item.kid === value.activeKid && item.notAfter === undefined) || keys.some(item => item.kid !== value.activeKid && item.notAfter === undefined)) throw new TypeError("provider assertion keyring is invalid");
	const previous = keys.find(item => item.kid !== value.activeKid);
	return { revision: value.revision as number, activeKid: value.activeKid, ...(previous ? { previousKid: previous.kid, previousNotAfter: previous.notAfter! } : {}), keys };
}
export class ProviderAssertionVerifier {
	readonly #keyringPath: string;
	readonly #ledger: SharedPortableControlLedger;
	readonly #audience: string;
	constructor(options: { readonly keyringPath: string; readonly ledger: SharedPortableControlLedger; readonly audience: string }) {
		if (!options.keyringPath || !ID.test(options.keyringPath) || !options.audience || !ID.test(options.audience)) throw new TypeError("provider assertion verifier options are invalid");
		this.#keyringPath = options.keyringPath;
		this.#ledger = options.ledger;
		this.#audience = options.audience;
	}
	async verify(assertion: string | null, mode: "control" | "stream", nowSeconds = Math.floor(Date.now() / 1_000)): Promise<ProviderAuthority | undefined> {
		if (!assertion || !ASSERTION.test(assertion)) return undefined;
		const [encoded, signature] = assertion.split(".") as [string, string];
		let value: Record<string, unknown>;
		try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>; } catch { return undefined; }
		if (Object.keys(value).sort().join(",") !== "aud,authorizedScopes,exp,kid,nonce,policyRevision,principalId,purpose,requestId,scopeId,v") return undefined;
		if (value.v !== 1 || value.aud !== this.#audience || value.purpose !== PROVIDER_ASSERTION_PURPOSE[mode] || typeof value.kid !== "string" || !KID.test(value.kid)) return undefined;
		if (!Number.isSafeInteger(value.exp) || (value.exp as number) < nowSeconds || (value.exp as number) > nowSeconds + 30) return undefined;
		if (typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{24}$/u.test(value.nonce)) return undefined;
		if (![value.principalId, value.scopeId, value.requestId, value.policyRevision].every(candidate => typeof candidate === "string" && ID.test(candidate))) return undefined;
		if (!Array.isArray(value.authorizedScopes) || value.authorizedScopes.length > 32) return undefined;
		const authorizedScopes: Array<{ scopeId: string; roles: string[] }> = [];
		for (const candidate of value.authorizedScopes) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
			const scope = candidate as Record<string, unknown>;
			if (Object.keys(scope).sort().join(",") !== "roles,scopeId" || typeof scope.scopeId !== "string" || !ID.test(scope.scopeId) || !Array.isArray(scope.roles) || scope.roles.length > 16 || !scope.roles.every(role => typeof role === "string" && ID.test(role))) return undefined;
			authorizedScopes.push({ scopeId: scope.scopeId, roles: scope.roles as string[] });
		}
		let keyring: ProviderAssertionKeyring;
		try { keyring = await readKeyring(this.#keyringPath, nowSeconds); } catch { return undefined; }
		try { if (await this.#ledger.acceptProviderAssertionKeyring({ revision: keyring.revision, activeKid: keyring.activeKid, assertionKid: value.kid as string, ...(keyring.previousKid === undefined ? {} : { previousKid: keyring.previousKid, previousNotAfter: keyring.previousNotAfter }) }) !== "accepted") return undefined; }
		catch { return undefined; }
		const key = keyring.keys.find(item => item.kid === value.kid && (item.notAfter === undefined || item.notAfter >= nowSeconds));
		if (!key) return undefined;
		const expected = createHmac("sha256", key.secret).update(encoded).digest(), received = Buffer.from(signature, "base64url");
		if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) return undefined;
		try { if (await this.#ledger.claimProviderAssertionNonce({ nonce: value.nonce, expiresAt: value.exp as number }) !== "claimed") return undefined; }
		catch { return undefined; }
		const identity: AuthorizationIdentity = { principalId: value.principalId as string, authorizedScopes, policyRevision: value.policyRevision as string };
		return { identity, scopeId: value.scopeId as string, ownerPrincipal: identity.principalId, gateway: "ssh" };
	}
}
export class ClusterProviderService {
	readonly #options: ClusterProviderServiceOptions; readonly #connections: SharedProviderConnectionRegistry;
	constructor(options: ClusterProviderServiceOptions) { this.#options = options; this.#connections = new SharedProviderConnectionRegistry(options.controlStore); }
	async #driver(authority: ProviderAuthority): Promise<KubernetesDriver> { return await createKubernetesDriver({ api: this.#options.api, projection: this.#options.projection, controlStore: this.#options.controlStore, hostRef: this.#options.hostRef, scopes: [{ id: authority.scopeId, principal: authority.ownerPrincipal, displayName: "Provider scope", kind: "Personal" }], capabilities, admissionPolicy: this.#options.admissionPolicy }); }
	#identity(authority: ProviderAuthority): ProviderIngressIdentity { return { principalId: authority.identity.principalId, transport: authority.gateway === "ssh" ? "ssh" : "direct", authority }; }
	#authorize = async (request: ProviderAuthorizationRequest) => {
		const authority = request.identity.authority as ProviderAuthority;
		if (!authority || request.selectors.scopeId && request.selectors.scopeId !== authority.scopeId) return { outcome: "denied" as const };
		const actions: AuthorizationAction[] = [];
		for (const candidate of request.canonicalActions) { const action = providerAction(candidate); if (!action) return { outcome: "denied" as const }; actions.push(action); }
		for (const action of actions) { const decision = this.#options.authorizer.decide({ identity: authority.identity, scopeId: authority.scopeId, action, gateway: authority.gateway, requestId: createAuthorizationRequestId(), ...(request.selectors.runtimeId ? { resourceId: request.selectors.runtimeId } : {}) }); if (!decision.allowed) return { outcome: "denied" as const }; }
		return { outcome: "allowed" as const, scopeIds: [authority.scopeId], effectiveCapabilities: request.canonicalActions, policyRevision: authority.identity.policyRevision };
	};
	async openControl(authority: ProviderAuthority): Promise<OpenProviderControl> {
		const driver = await this.#driver(authority), identity = this.#identity(authority);
		const session = createProviderControlSession({ providerId: "omperator-cluster", providerName: "Omperator Cluster", driver, tickets: this.#options.controlStore, connections: this.#connections, authorize: this.#authorize, metrics: metricsSink(this.#options.metrics), creationPolicy: {
			runtime: async request => { const first = driver.listWorkspaces(request.scopeId).items[0]; if (!first) throw new Error("provider scope has no workspace for a runtime"); return { id: publicId("rt", request.mutationId), scopeId: request.scopeId, displayName: "Provider runtime", workspaceId: first.id, hostProfileId: "profile_default", desiredState: "Running", browserPolicy: "Disabled" }; },
			workspace: async request => { const runtime = driver.getRuntime(request.machineId); if (runtime.outcome !== "found") throw new Error("provider runtime is unavailable"); return { id: publicId("ws", request.mutationId), scopeId: runtime.resource.scopeId, displayName: "Provider workspace", capacityBytes: 1_073_741_824, retention: "Retain" }; },
		} }, identity);
		return { session, close: async () => { await session.close(); await driver.close(); } };
	}
	async runStream(transport: DuplexByteStream, authority: ProviderAuthority, signal?: AbortSignal) { const driver = await this.#driver(authority); try { return await runProviderStream({ transport, identity: this.#identity(authority), tickets: this.#options.controlStore, driver, authorize: this.#authorize, routeOpener: this.#options.routeOpener(authority), connections: this.#connections, signal }); } finally { await driver.close(); } }
}
