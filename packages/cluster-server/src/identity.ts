import { createHash, createPublicKey, verify, type JsonWebKey as NodeJsonWebKey, type KeyObject } from "node:crypto";
import { isAuthorizationRole } from "./authorization.ts";

const MAX_TOKEN_BYTES = 16_384;
const MAX_JSON_BYTES = 12_288;
const MAX_JWKS_BYTES = 65_536;
const MAX_JWKS_KEYS = 32;
const MAX_BINDINGS = 64;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;

export type IdentityAdapterType = "tailscale" | "oidc" | "mtls";

export interface AuthorizedIdentityScope {
	readonly scopeId: string;
	readonly roles: readonly string[];
}

export interface RequestIdentity {
	readonly principalId: string;
	readonly authorizedScopes: readonly AuthorizedIdentityScope[];
	readonly adapter: Readonly<{ id: string; type: IdentityAdapterType; issuer?: string }>;
	readonly policyRevision: string;
}

export interface IdentityRequestContext {
	readonly request: Request;
	readonly remoteAddress: string;
	readonly isTrustedProxy: (address: string) => boolean;
}

export interface IdentityAdapter {
	readonly id: string;
	readonly type: IdentityAdapterType;
	authenticate(context: IdentityRequestContext): Promise<RequestIdentity | undefined>;
}

export class IdentityAuthenticationError extends Error {
	constructor() {
		super("request identity was not accepted");
		this.name = "IdentityAuthenticationError";
	}
}

export interface ScopeGrant {
	readonly scopeId: string;
	readonly roles?: readonly string[];
}

interface BaseAdapterConfig {
	readonly id: string;
	readonly policyRevision: string;
	readonly grants?: readonly ScopeGrant[];
}

export interface TailscaleIdentityConfig extends BaseAdapterConfig {
	readonly type: "tailscale";
}

export interface OidcClaimScopeMapping {
	readonly claim: string;
	readonly value: string;
	readonly grants: readonly ScopeGrant[];
}

export interface OidcIdentityConfig extends BaseAdapterConfig {
	readonly type: "oidc";
	readonly issuer: string;
	readonly audience: string;
	readonly jwksUri?: string;
	readonly algorithms?: readonly ("RS256" | "ES256")[];
	readonly clockSkewSeconds?: number;
	readonly maximumTokenLifetimeSeconds?: number;
	readonly cacheTtlSeconds?: number;
	readonly claimMappings?: readonly OidcClaimScopeMapping[];
}

export interface MtlsIdentityMapping {
	readonly certificateSha256?: string;
	readonly serviceId?: string;
	readonly principalId: string;
	readonly grants?: readonly ScopeGrant[];
}

export interface MtlsIdentityConfig extends BaseAdapterConfig {
	readonly type: "mtls";
	readonly mappings: readonly MtlsIdentityMapping[];
}

export type IdentityAdapterConfig = TailscaleIdentityConfig | OidcIdentityConfig | MtlsIdentityConfig;

export type OidcFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface OidcAdapterDependencies {
	readonly fetch?: OidcFetch;
	readonly now?: () => number;
}

function invalid(): never {
	throw new IdentityAuthenticationError();
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedValue(value: unknown, maximum = 256): string {
	if (typeof value !== "string" || value !== value.trim() || byteLength(value) < 1 || byteLength(value) > maximum || !SAFE_VALUE.test(value)) invalid();
	return value;
}
function boundedPrincipal(value: unknown, maximum = 256): string {
	if (typeof value !== "string" || value !== value.trim() || byteLength(value) < 1 || byteLength(value) > maximum || /\p{Cc}/u.test(value)) invalid();
	return value;
}


function adapterId(value: string): string {
	return boundedValue(value, 64);
}

function opaquePrincipal(domain: string, ...parts: readonly string[]): string {
	return `id_${createHash("sha256").update(domain).update("\0").update(parts.join("\0")).digest("base64url")}`;
}

function grants(input: readonly ScopeGrant[] | undefined): readonly AuthorizedIdentityScope[] {
	if (!input) return Object.freeze([]);
	if (input.length > MAX_BINDINGS) invalid();
	const byScope = new Map<string, Set<string>>();
	for (const grant of input) {
		const scopeId = boundedValue(grant.scopeId, 128);
		const current = byScope.get(scopeId) ?? new Set<string>();
		if ((grant.roles?.length ?? 0) > MAX_BINDINGS) invalid();
		for (const role of grant.roles ?? []) {
			const validatedRole = boundedValue(role, 64);
			if (!isAuthorizationRole(validatedRole)) invalid();
			current.add(validatedRole);
		}
		byScope.set(scopeId, current);
	}
	if (byScope.size > MAX_BINDINGS) invalid();
	return Object.freeze([...byScope].map(([scopeId, roles]) => Object.freeze({ scopeId, roles: Object.freeze([...roles].sort()) })));
}

function mergeGrants(...inputs: readonly (readonly ScopeGrant[] | undefined)[]): readonly AuthorizedIdentityScope[] {
	return grants(inputs.flatMap(input => input ?? []));
}

function identity(config: BaseAdapterConfig & { type: IdentityAdapterType }, principalId: string, authorizedScopes: readonly AuthorizedIdentityScope[], issuer?: string): RequestIdentity {
	const adapter = Object.freeze({ id: adapterId(config.id), type: config.type, ...(issuer ? { issuer } : {}) });
	return Object.freeze({
		principalId: boundedPrincipal(principalId),
		authorizedScopes,
		adapter,
		policyRevision: boundedValue(config.policyRevision, 128),
	});
}

function singleHeader(headers: Headers, name: string): string | undefined {
	const value = headers.get(name);
	if (value === null) return undefined;
	if (value.includes(",") || value.includes("\r") || value.includes("\n")) invalid();
	return value;
}

function canonicalProxyRequest(context: IdentityRequestContext): boolean {
	return context.isTrustedProxy(context.remoteAddress) && singleHeader(context.request.headers, "x-forwarded-proto") === "https";
}
function canonicalHttpsRequest(context: IdentityRequestContext): boolean {
	let protocol: string;
	try { protocol = new URL(context.request.url).protocol; } catch { invalid(); }
	const forwarded = singleHeader(context.request.headers, "x-forwarded-proto");
	if (forwarded !== undefined) return canonicalProxyRequest(context);
	return protocol === "https:";
}


const TAILSCALE_HEADERS = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic"] as const;

function hasAnyHeader(headers: Headers, names: readonly string[]): boolean {
	return names.some(name => headers.has(name));
}

export class TailscaleIdentityAdapter implements IdentityAdapter {
	readonly id: string;
	readonly type = "tailscale" as const;
	constructor(private readonly config: TailscaleIdentityConfig) { this.id = adapterId(config.id); }
	async authenticate(context: IdentityRequestContext): Promise<RequestIdentity | undefined> {
		const headers = context.request.headers;
		const signaled = hasAnyHeader(headers, TAILSCALE_HEADERS);
		if (!signaled) return undefined;
		if (!canonicalProxyRequest(context)) invalid();
		for (const name of TAILSCALE_HEADERS) {
			const value = singleHeader(headers, name);
			if (value !== undefined && (byteLength(value) > 2048 || /\p{Cc}/u.test(value))) invalid();
		}
		const login = singleHeader(headers, "tailscale-user-login");
		if (!login) invalid();
		const loginIdentity = boundedPrincipal(login);
		return identity(this.config, opaquePrincipal("t4.identity.tailscale.v1", loginIdentity), grants(this.config.grants));
	}
}

interface ParsedJwt {
	readonly encodedHeader: string;
	readonly encodedClaims: string;
	readonly signature: Buffer;
	readonly header: Record<string, unknown>;
	readonly claims: Record<string, unknown>;
}

function decodeBase64Url(value: string, maximum: number): Buffer {
	if (!value || value.length > Math.ceil(maximum * 4 / 3) + 4 || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalid();
	const decoded = Buffer.from(value, "base64url");
	if (decoded.byteLength > maximum || decoded.toString("base64url") !== value) invalid();
	return decoded;
}

function parseJsonObject(encoded: string): Record<string, unknown> {
	const bytes = decodeBase64Url(encoded, MAX_JSON_BYTES);
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
	assertNoDuplicateJsonMembers(text);
	let value: unknown;
	try { value = JSON.parse(text); } catch { invalid(); }
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function assertNoDuplicateJsonMembers(text: string): void {
	let index = 0;
	const whitespace = () => { while (/\s/u.test(text[index] ?? "")) index++; };
	const string = (): string => {
		if (text[index++] !== '"') invalid();
		const start = index - 1;
		let escaped = false;
		while (index < text.length) {
			const character = text[index++]!;
			if (!escaped && character === '"') {
				try { return JSON.parse(text.slice(start, index)) as string; } catch { invalid(); }
			}
			if (!escaped && character === "\\") escaped = true;
			else escaped = false;
		}
		invalid();
	};
	const value = (depth = 0): void => {
		if (depth > 32) invalid();
		whitespace();
		const character = text[index];
		if (character === '"') { string(); return; }
		if (character === "{") {
			index++; whitespace();
			const keys = new Set<string>();
			if (text[index] === "}") { index++; return; }
			for (;;) {
				whitespace();
				const key = string();
				if (keys.has(key)) invalid();
				keys.add(key);
				whitespace(); if (text[index++] !== ":") invalid();
				value(depth + 1); whitespace();
				const separator = text[index++];
				if (separator === "}") return;
				if (separator !== ",") invalid();
			}
		}
		if (character === "[") {
			index++; whitespace();
			if (text[index] === "]") { index++; return; }
			for (;;) {
				value(depth + 1); whitespace();
				const separator = text[index++];
				if (separator === "]") return;
				if (separator !== ",") invalid();
			}
		}
		const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(index));
		if (!match) invalid();
		index += match[0].length;
	};
	value(); whitespace();
	if (index !== text.length) invalid();
}

function parseJwt(token: string): ParsedJwt {
	if (byteLength(token) > MAX_TOKEN_BYTES) invalid();
	const parts = token.split(".");
	if (parts.length !== 3) invalid();
	const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
	return {
		encodedHeader,
		encodedClaims,
		signature: decodeBase64Url(encodedSignature, 512),
		header: parseJsonObject(encodedHeader),
		claims: parseJsonObject(encodedClaims),
	};
}

interface JwkSet { readonly keys: readonly Record<string, unknown>[] }

async function boundedJsonResponse(response: Response, maximum: number): Promise<Record<string, unknown>> {
	if (!response.ok) invalid();
	const declared = response.headers.get("content-length");
	if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) invalid();
	const reader = response.body?.getReader();
	if (!reader) invalid();
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		length += result.value.byteLength;
		if (length > maximum) { await reader.cancel(); invalid(); }
		chunks.push(result.value);
	}
	const bytes = Buffer.concat(chunks, length);
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid(); }
	assertNoDuplicateJsonMembers(text);
	let value: unknown;
	try { value = JSON.parse(text); } catch { invalid(); }
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

export class OidcIdentityAdapter implements IdentityAdapter {
	readonly id: string;
	readonly type = "oidc" as const;
	private readonly fetchImplementation: OidcFetch;
	private readonly now: () => number;
	private readonly issuer: string;
	private readonly algorithms: ReadonlySet<string>;
	private readonly clockSkew: number;
	private readonly maximumLifetime: number;
	private readonly cacheTtl: number;
	private cachedKeys?: { expiresAt: number; set: JwkSet };
	private jwksUri?: string;

	constructor(private readonly config: OidcIdentityConfig, dependencies: OidcAdapterDependencies = {}) {
		this.id = adapterId(config.id);
		this.fetchImplementation = dependencies.fetch ?? ((input, init) => fetch(input, init));
		this.now = dependencies.now ?? Date.now;
		this.issuer = httpsUrl(config.issuer, "issuer");
		this.jwksUri = config.jwksUri ? httpsUrl(config.jwksUri, "jwks") : undefined;
		const configuredAlgorithms = config.algorithms ?? ["RS256", "ES256"];
		this.algorithms = new Set(configuredAlgorithms);
		if (configuredAlgorithms.length < 1 || configuredAlgorithms.length > 2 || this.algorithms.size !== configuredAlgorithms.length || [...this.algorithms].some(value => value !== "RS256" && value !== "ES256")) invalid();
		this.clockSkew = boundedInteger(config.clockSkewSeconds ?? 30, 0, 300);
		this.maximumLifetime = boundedInteger(config.maximumTokenLifetimeSeconds ?? 3600, 60, 86_400);
		this.cacheTtl = boundedInteger(config.cacheTtlSeconds ?? 300, 30, 3600);
		boundedPrincipal(config.audience, 512);
		if ((config.claimMappings?.length ?? 0) > MAX_BINDINGS) invalid();
		const mappingKeys = (config.claimMappings ?? []).map(mapping => `${mapping.claim}\0${mapping.value}`);
		if (new Set(mappingKeys).size !== mappingKeys.length) invalid();
	}

	async authenticate(context: IdentityRequestContext): Promise<RequestIdentity | undefined> {
		const authorization = singleHeader(context.request.headers, "authorization");
		if (authorization === undefined) return undefined;
		if (!canonicalHttpsRequest(context)) invalid();
		const match = /^[Bb][Ee][Aa][Rr][Ee][Rr] ([A-Za-z0-9._-]+)$/u.exec(authorization);
		if (!match) invalid();
		const jwt = parseJwt(match[1]!);
		const algorithm = jwt.header.alg;
		const kid = jwt.header.kid;
		if (typeof algorithm !== "string" || !this.algorithms.has(algorithm) || (algorithm !== "RS256" && algorithm !== "ES256")) invalid();
		if (typeof kid !== "string" || boundedPrincipal(kid, 128) !== kid) invalid();
		if (Object.keys(jwt.header).some(name => name !== "alg" && name !== "kid" && name !== "typ")) invalid();
		if (jwt.header.typ !== undefined && jwt.header.typ !== "JWT" && jwt.header.typ !== "at+jwt") invalid();
		let key = await this.key(kid, algorithm, false);
		if (!key) key = await this.key(kid, algorithm, true);
		if (!key) invalid();
		let publicKey: KeyObject;
		try { publicKey = createPublicKey({ key, format: "jwk" }); } catch { invalid(); }
		if (algorithm === "ES256" && jwt.signature.byteLength !== 64) invalid();
		const input = Buffer.from(`${jwt.encodedHeader}.${jwt.encodedClaims}`, "ascii");
		let verified = false;
		try {
			verified = algorithm === "ES256"
				? verify("sha256", input, { key: publicKey, dsaEncoding: "ieee-p1363" }, jwt.signature)
				: verify("RSA-SHA256", input, publicKey, jwt.signature);
		} catch { invalid(); }
		if (!verified) invalid();
		const subject = this.validateClaims(jwt.claims);
		const mapped = this.mappedGrants(jwt.claims);
		return identity(this.config, opaquePrincipal("t4.identity.oidc.v1", this.issuer, subject), mergeGrants(this.config.grants, mapped), this.issuer);
	}

	private validateClaims(claims: Record<string, unknown>): string {
		if (claims.iss !== this.issuer || claims.aud !== this.config.audience) invalid();
		const subject = boundedPrincipal(claims.sub, 512);
		const exp = numericDate(claims.exp);
		const nbf = numericDate(claims.nbf);
		const iat = numericDate(claims.iat);
		const now = Math.floor(this.now() / 1000);
		if (exp <= now - this.clockSkew || nbf > now + this.clockSkew || iat > now + this.clockSkew) invalid();
		if (exp <= iat || exp - iat > this.maximumLifetime || now - iat > this.maximumLifetime + this.clockSkew) invalid();
		return subject;
	}

	private mappedGrants(claims: Record<string, unknown>): readonly ScopeGrant[] {
		const output: ScopeGrant[] = [];
		for (const mapping of this.config.claimMappings ?? []) {
			const claim = boundedValue(mapping.claim, 64);
			const expected = boundedPrincipal(mapping.value, 256);
			const actual = claims[claim];
			if (actual === expected || (Array.isArray(actual) && actual.length <= MAX_BINDINGS && actual.every(value => typeof value === "string") && actual.includes(expected))) output.push(...mapping.grants);
		}
		return output;
	}

	private async key(kid: string, algorithm: "RS256" | "ES256", refresh: boolean): Promise<NodeJsonWebKey | undefined> {
		const now = this.now();
		if (refresh || !this.cachedKeys || this.cachedKeys.expiresAt <= now) {
			const set = await this.fetchKeys();
			this.cachedKeys = { expiresAt: now + this.cacheTtl * 1000, set };
		}
		const matches = this.cachedKeys.set.keys.filter(key => key.kid === kid);
		if (matches.length !== 1) return undefined;
		const key = matches[0]!;
		if (key.use !== "sig" || key.alg !== algorithm) invalid();
		if (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== "verify")) invalid();
		const allowedFields = algorithm === "RS256"
			? ["kty", "kid", "use", "alg", "key_ops", "n", "e"]
			: ["kty", "kid", "use", "alg", "key_ops", "crv", "x", "y"];
		if (Object.keys(key).some(field => !allowedFields.includes(field))) invalid();
		if (algorithm === "RS256") {
			if (key.kty !== "RSA" || typeof key.n !== "string" || typeof key.e !== "string") invalid();
			const modulus = decodeBase64Url(key.n, 512);
			const exponent = decodeBase64Url(key.e, 8);
			if (modulus.byteLength < 256 || exponent.byteLength < 1) invalid();
		} else {
			if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") invalid();
			if (decodeBase64Url(key.x, 32).byteLength !== 32 || decodeBase64Url(key.y, 32).byteLength !== 32) invalid();
		}
		return key as NodeJsonWebKey;
	}

	private async fetchKeys(): Promise<JwkSet> {
		const uri = this.jwksUri ?? await this.discoverJwksUri();
		const response = await this.fetchWithTimeout(uri);
		const json = await boundedJsonResponse(response, MAX_JWKS_BYTES);
		if (!Array.isArray(json.keys) || json.keys.length < 1 || json.keys.length > MAX_JWKS_KEYS || json.keys.some(key => !key || typeof key !== "object" || Array.isArray(key))) invalid();
		const keys = json.keys as Record<string, unknown>[];
		const kids = keys.filter(key => typeof key.kid === "string").map(key => key.kid as string);
		if (new Set(kids).size !== kids.length) invalid();
		return { keys };
	}

	private async discoverJwksUri(): Promise<string> {
		const discovery = `${this.issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
		const json = await boundedJsonResponse(await this.fetchWithTimeout(discovery), MAX_JWKS_BYTES);
		if (json.issuer !== this.issuer || typeof json.jwks_uri !== "string") invalid();
		this.jwksUri = httpsUrl(json.jwks_uri, "jwks");
		return this.jwksUri;
	}

	private async fetchWithTimeout(url: string): Promise<Response> {
		try {
			return await this.fetchImplementation(url, {
				method: "GET",
				headers: { accept: "application/json" },
				redirect: "error",
				signal: AbortSignal.timeout(5000),
			});
		} catch { invalid(); }
	}
}

function httpsUrl(value: string, description: string): string {
	if (typeof value !== "string" || value !== value.trim() || /\p{Cc}|\s/u.test(value) || byteLength(value) > (description === "issuer" ? 512 : 2048)) invalid();
	let url: URL;
	try { url = new URL(value); } catch { invalid(); }
	if (url.protocol !== "https:" || url.username || url.password || url.hash || (description === "issuer" && (url.search || url.pathname.length > 1 && url.pathname.endsWith("/")))) invalid();
	return description === "issuer" ? value : url.href;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
	return value;
}

function numericDate(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
	return value as number;
}

const MTLS_HEADERS = ["x-t4-client-cert-verified", "x-t4-client-cert-sha256", "x-t4-service-id", "x-forwarded-client-cert"] as const;

export class MtlsIdentityAdapter implements IdentityAdapter {
	readonly id: string;
	readonly type = "mtls" as const;
	private readonly mappings: readonly MtlsIdentityMapping[];
	constructor(private readonly config: MtlsIdentityConfig) {
		this.id = adapterId(config.id);
		if (config.mappings.length < 1 || config.mappings.length > MAX_BINDINGS) invalid();
		this.mappings = config.mappings.map(mapping => validateMtlsMapping(mapping));
	}
	async authenticate(context: IdentityRequestContext): Promise<RequestIdentity | undefined> {
		const headers = context.request.headers;
		if (!hasAnyHeader(headers, MTLS_HEADERS)) return undefined;
		if (!canonicalProxyRequest(context) || headers.has("x-forwarded-client-cert")) invalid();
		if (singleHeader(headers, "x-t4-client-cert-verified") !== "SUCCESS") invalid();
		const fingerprint = singleHeader(headers, "x-t4-client-cert-sha256");
		const serviceId = singleHeader(headers, "x-t4-service-id");
		if (Boolean(fingerprint) === Boolean(serviceId)) invalid();
		const canonicalFingerprint = fingerprint ? normalizeFingerprint(fingerprint) : undefined;
		const canonicalService = serviceId ? normalizeServiceId(serviceId) : undefined;
		const matches = canonicalFingerprint
			? this.mappings.filter(mapping => mapping.certificateSha256 === canonicalFingerprint)
			: this.mappings.filter(mapping => mapping.serviceId === canonicalService);
		if (matches.length !== 1) invalid();
		const match = matches[0]!;
		return identity(this.config, opaquePrincipal("t4.identity.mtls.v1", match.principalId), mergeGrants(this.config.grants, match.grants));
	}
}

function validateMtlsMapping(mapping: MtlsIdentityMapping): MtlsIdentityMapping {
	if (Boolean(mapping.certificateSha256) === Boolean(mapping.serviceId)) invalid();
	return Object.freeze({
		...(mapping.certificateSha256 ? { certificateSha256: normalizeFingerprint(mapping.certificateSha256) } : { serviceId: normalizeServiceId(mapping.serviceId!) }),
		principalId: boundedValue(mapping.principalId, 128),
		grants: Object.freeze([...(mapping.grants ?? [])]),
	});
}

function normalizeFingerprint(value: string): string {
	const normalized = value.toLowerCase().replaceAll(":", "");
	if (!/^[a-f0-9]{64}$/u.test(normalized)) invalid();
	return normalized;
}

function normalizeServiceId(value: string): string {
	if (byteLength(value) > 512) invalid();
	let url: URL;
	try { url = new URL(value); } catch { invalid(); }
	if (url.protocol !== "spiffe:" || !url.hostname || url.username || url.password || url.search || url.hash) invalid();
	return url.href;
}

function signaledIdentityTypes(headers: Headers): readonly IdentityAdapterType[] {
	const signaled: IdentityAdapterType[] = [];
	if (hasAnyHeader(headers, TAILSCALE_HEADERS)) signaled.push("tailscale");
	if (headers.has("authorization")) signaled.push("oidc");
	if (hasAnyHeader(headers, MTLS_HEADERS)) signaled.push("mtls");
	return signaled;
}

export class RequestIdentityResolver {
	readonly adapters: readonly IdentityAdapter[];
	constructor(adapters: readonly IdentityAdapter[]) {
		if (adapters.length < 1 || adapters.length > 8) invalid();
		const ids = new Set(adapters.map(adapter => adapter.id));
		const types = new Set(adapters.map(adapter => adapter.type));
		if (ids.size !== adapters.length || types.size !== adapters.length) invalid();
		this.adapters = Object.freeze([...adapters]);
	}
	async authenticate(context: IdentityRequestContext): Promise<RequestIdentity | undefined> {
		const signaled = signaledIdentityTypes(context.request.headers);
		if (signaled.length === 0) return undefined;
		if (signaled.length !== 1) invalid();
		const matching = this.adapters.filter(adapter => adapter.type === signaled[0]);
		if (matching.length !== 1) invalid();
		const identity = await matching[0]!.authenticate(context);
		if (!identity) invalid();
		return identity;
	}
}

function objectValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}

function configuredGrants(value: unknown): readonly ScopeGrant[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_BINDINGS) invalid();
	const result = value.map(raw => {
		const entry = objectValue(raw);
		exactKeys(entry, ["scopeId", "roles"]);
		const scopeId = boundedValue(entry.scopeId, 128);
		if (entry.roles !== undefined && (!Array.isArray(entry.roles) || entry.roles.length > MAX_BINDINGS || entry.roles.some(role => typeof role !== "string" || !isAuthorizationRole(role)))) invalid();
		const roles = Object.freeze((entry.roles as string[] | undefined)?.map(role => boundedValue(role, 64)) ?? []);
		return Object.freeze({ scopeId, roles });
	});
	grants(result);
	return Object.freeze(result);
}

export function identityAdapterConfigsFromJson(input: string): readonly IdentityAdapterConfig[] {
	if (byteLength(input) > 131_072) invalid();
	assertNoDuplicateJsonMembers(input);
	let parsed: unknown;
	try { parsed = JSON.parse(input); } catch { invalid(); }
	const root = objectValue(parsed);
	exactKeys(root, ["adapters"]);
	if (!Array.isArray(root.adapters) || root.adapters.length < 1 || root.adapters.length > 8) invalid();
	const configs = root.adapters.map(raw => {
		const entry = objectValue(raw);
		const type = entry.type;
		if (type !== "tailscale" && type !== "oidc" && type !== "mtls") invalid();
		const base = {
			id: boundedValue(entry.id, 64),
			type,
			policyRevision: boundedValue(entry.policyRevision, 128),
			...(entry.grants === undefined ? {} : { grants: configuredGrants(entry.grants) }),
		};
		if (type === "tailscale") {
			exactKeys(entry, ["id", "type", "policyRevision", "grants"]);
			return Object.freeze(base) as TailscaleIdentityConfig;
		}
		if (type === "oidc") {
			exactKeys(entry, ["id", "type", "policyRevision", "grants", "issuer", "audience", "jwksUri", "algorithms", "clockSkewSeconds", "maximumTokenLifetimeSeconds", "cacheTtlSeconds", "claimMappings"]);
			const issuer = httpsUrl(entry.issuer as string, "issuer");
			const audience = boundedPrincipal(entry.audience, 512);
			const jwksUri = entry.jwksUri === undefined ? undefined : httpsUrl(entry.jwksUri as string, "jwks");
			if (entry.algorithms !== undefined && (!Array.isArray(entry.algorithms) || entry.algorithms.length < 1 || entry.algorithms.length > 2 || entry.algorithms.some(algorithm => algorithm !== "RS256" && algorithm !== "ES256"))) invalid();
			if (entry.claimMappings !== undefined && (!Array.isArray(entry.claimMappings) || entry.claimMappings.length > MAX_BINDINGS)) invalid();
			const claimMappings = (entry.claimMappings as unknown[] | undefined)?.map(rawMapping => {
				const mapping = objectValue(rawMapping);
				exactKeys(mapping, ["claim", "value", "grants"]);
				return Object.freeze({
					claim: boundedValue(mapping.claim, 64),
					value: boundedPrincipal(mapping.value, 256),
					grants: configuredGrants(mapping.grants) ?? Object.freeze([]),
				});
			});
			return Object.freeze({
				...base,
				issuer,
				audience,
				...(jwksUri ? { jwksUri } : {}),
				...(entry.algorithms ? { algorithms: Object.freeze([...(entry.algorithms as ("RS256" | "ES256")[])]) } : {}),
				...(entry.clockSkewSeconds === undefined ? {} : { clockSkewSeconds: boundedInteger(entry.clockSkewSeconds as number, 0, 300) }),
				...(entry.maximumTokenLifetimeSeconds === undefined ? {} : { maximumTokenLifetimeSeconds: boundedInteger(entry.maximumTokenLifetimeSeconds as number, 60, 86_400) }),
				...(entry.cacheTtlSeconds === undefined ? {} : { cacheTtlSeconds: boundedInteger(entry.cacheTtlSeconds as number, 30, 3600) }),
				...(claimMappings ? { claimMappings: Object.freeze(claimMappings) } : {}),
			}) as OidcIdentityConfig;
		}
		exactKeys(entry, ["id", "type", "policyRevision", "grants", "mappings"]);
		if (!Array.isArray(entry.mappings) || entry.mappings.length < 1 || entry.mappings.length > MAX_BINDINGS) invalid();
		const mappings = entry.mappings.map(rawMapping => {
			const mapping = objectValue(rawMapping);
			exactKeys(mapping, ["certificateSha256", "serviceId", "principalId", "grants"]);
			return validateMtlsMapping({
				...(mapping.certificateSha256 === undefined ? {} : { certificateSha256: mapping.certificateSha256 as string }),
				...(mapping.serviceId === undefined ? {} : { serviceId: mapping.serviceId as string }),
				principalId: boundedValue(mapping.principalId, 128),
				grants: configuredGrants(mapping.grants) ?? Object.freeze([]),
			});
		});
		return Object.freeze({ ...base, mappings: Object.freeze(mappings) }) as MtlsIdentityConfig;
	});
	createIdentityResolver(configs);
	return Object.freeze(configs);
}

export function requestIdentityScopeId(identity: RequestIdentity): string {
	return `scope_${createHash("sha256").update(identity.principalId).digest("base64url").slice(0, 24)}`;
}

export function requestIdentityOwnsProjectedScope(identity: RequestIdentity, scopeId: string): boolean {
	return requestIdentityScopeId(identity) === scopeId;
}

export function createIdentityResolver(configs: readonly IdentityAdapterConfig[], dependencies: OidcAdapterDependencies = {}): RequestIdentityResolver {
	return new RequestIdentityResolver(configs.map(config => {
		switch (config.type) {
			case "tailscale": return new TailscaleIdentityAdapter(config);
			case "oidc": return new OidcIdentityAdapter(config, dependencies);
			case "mtls": return new MtlsIdentityAdapter(config);
		}
	}));
}
