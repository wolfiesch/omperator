import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { IdentityAuthenticationError, MtlsIdentityAdapter, OidcIdentityAdapter, RequestIdentityResolver, TailscaleIdentityAdapter, identityAdapterConfigsFromJson, type OidcFetch } from "../src/identity.ts";

const NOW = 1_800_000_000_000;
const ISSUER = "https://issuer.example.test/tenant";
const AUDIENCE = "t4-cluster";
const request = (headers: HeadersInit) => new Request("https://cluster.example.test/v1/ws", { headers });
const context = (headers: HeadersInit, remoteAddress = "100.64.0.7") => ({ request: request(headers), remoteAddress, isTrustedProxy: (address: string) => address === "100.64.0.7" });

function jwt(privateKey: KeyObject, kid: string, claims: Record<string, unknown>, algorithm: "RS256" | "ES256" = "RS256"): string {
	const header = Buffer.from(JSON.stringify({ alg: algorithm, kid, typ: "JWT" })).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const input = Buffer.from(`${header}.${payload}`);
	const signature = algorithm === "ES256" ? sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" }) : sign("RSA-SHA256", input, privateKey);
	return `${header}.${payload}.${signature.toString("base64url")}`;
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(NOW / 1000);
	return { iss: ISSUER, aud: AUDIENCE, sub: "subject-7", iat: now - 10, nbf: now - 10, exp: now + 300, groups: ["operators"], ...overrides };
}

function oidcFixture(algorithm: "RS256" | "ES256" = "RS256") {
	const pair = algorithm === "RS256" ? generateKeyPairSync("rsa", { modulusLength: 2048 }) : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = pair.publicKey.export({ format: "jwk" });
	Object.assign(jwk, { kid: "key-1", use: "sig", alg: algorithm });
	const calls: string[] = [];
	const fetchImplementation: OidcFetch = async input => { calls.push(String(input)); return Response.json({ keys: [jwk] }); };
	const adapter = new OidcIdentityAdapter({
		id: "workforce", type: "oidc", policyRevision: "policy-7", issuer: ISSUER,
		jwksUri: "https://issuer.example.test/jwks", audience: AUDIENCE, algorithms: [algorithm],
		claimMappings: [{ claim: "groups", value: "operators", grants: [{ scopeId: "team-red", roles: ["writer"] }] }],
	}, { fetch: fetchImplementation, now: () => NOW });
	return { adapter, privateKey: pair.privateKey, calls };
}

describe("provider-neutral request identity", () => {
	it("derives an opaque Tailscale principal only across the canonical trusted HTTPS proxy boundary", async () => {
		const adapter = new TailscaleIdentityAdapter({ id: "tailnet", type: "tailscale", policyRevision: "7", grants: [{ scopeId: "personal", roles: ["admin"] }] });
		const accepted = await adapter.authenticate(context({ "x-forwarded-proto": "https", "tailscale-user-login": "operator@example.test" }));
		expect(accepted).toMatchObject({ adapter: { id: "tailnet", type: "tailscale" }, policyRevision: "7", authorizedScopes: [{ scopeId: "personal", roles: ["admin"] }] });
		expect(accepted?.principalId).toMatch(/^id_[A-Za-z0-9_-]{43}$/u);
		expect(accepted?.principalId).not.toContain("operator");
		const ingressTerminated = await adapter.authenticate({
			request: new Request("http://cluster-server:8080/v1/ws", { headers: { "x-forwarded-proto": "https", "tailscale-user-login": "operator@example.test" } }),
			remoteAddress: "100.64.0.7",
			isTrustedProxy: address => address === "100.64.0.7",
		});
		expect(ingressTerminated?.principalId).toBe(accepted?.principalId);
		await expect(adapter.authenticate(context({ "x-forwarded-proto": "https", "tailscale-user-login": "operator@example.test" }, "198.51.100.2"))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		await expect(adapter.authenticate(context({ "x-forwarded-proto": "http", "tailscale-user-login": "operator@example.test" }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
	});

	it("rejects duplicate identity headers and simultaneous identity sources", async () => {
		const tailscale = new TailscaleIdentityAdapter({ id: "tailnet", type: "tailscale", policyRevision: "7" });
		const duplicate = new Headers({ "x-forwarded-proto": "https" });
		duplicate.append("tailscale-user-login", "first@example.test");
		duplicate.append("tailscale-user-login", "second@example.test");
		await expect(tailscale.authenticate(context(duplicate))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		const fixture = oidcFixture();
		const resolver = new RequestIdentityResolver([tailscale, fixture.adapter]);
		await expect(resolver.authenticate(context({ "x-forwarded-proto": "https", "tailscale-user-login": "operator@example.test", authorization: `Bearer ${jwt(fixture.privateKey, "key-1", validClaims())}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
	});

	for (const algorithm of ["RS256", "ES256"] as const) {
		it(`verifies ${algorithm}, derives mapped scopes, and reuses the bounded key cache`, async () => {
			const fixture = oidcFixture(algorithm);
			const token = jwt(fixture.privateKey, "key-1", validClaims(), algorithm);
			const first = await fixture.adapter.authenticate(context({ authorization: `Bearer ${token}` }, "198.51.100.9"));
			const second = await fixture.adapter.authenticate(context({ authorization: `Bearer ${token}` }, "198.51.100.9"));
			expect(first).toEqual(second);
			expect(first).toMatchObject({ adapter: { type: "oidc", issuer: ISSUER }, policyRevision: "policy-7", authorizedScopes: [{ scopeId: "team-red", roles: ["writer"] }] });
			expect(fixture.calls).toHaveLength(1);
		});
	}

	it("rejects bearer credentials before network validation on a non-canonical transport", async () => {
		const fixture = oidcFixture();
		const token = jwt(fixture.privateKey, "key-1", validClaims());
		await expect(fixture.adapter.authenticate({
			request: new Request("http://cluster.example.test/v1/ws", { headers: { authorization: `Bearer ${token}` } }),
			remoteAddress: "198.51.100.9",
			isTrustedProxy: () => false,
		})).rejects.toBeInstanceOf(IdentityAuthenticationError);
		expect(fixture.calls).toEqual([]);
	});

	it("discovers an exact HTTPS issuer and then fetches only its advertised HTTPS JWKS", async () => {
		const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const jwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "discovered", use: "sig", alg: "RS256" };
		const calls: string[] = [];
		const adapter = new OidcIdentityAdapter({ id: "discovery", type: "oidc", policyRevision: "1", issuer: ISSUER, audience: AUDIENCE }, {
			now: () => NOW,
			fetch: async input => {
				calls.push(input);
				return Response.json(input.endsWith("/.well-known/openid-configuration")
					? { issuer: ISSUER, jwks_uri: "https://keys.example.test/jwks" }
					: { keys: [jwk] });
			},
		});
		await expect(adapter.authenticate(context({ authorization: `Bearer ${jwt(pair.privateKey, "discovered", validClaims())}` }))).resolves.toMatchObject({ adapter: { issuer: ISSUER } });
		expect(calls).toEqual([`${ISSUER}/.well-known/openid-configuration`, "https://keys.example.test/jwks"]);
	});

	it("refreshes once for an unknown kid and fails closed across rotation or outage without leaking the token", async () => {
		const oldPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const newPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const oldJwk = { ...oldPair.publicKey.export({ format: "jwk" }), kid: "old", use: "sig", alg: "RS256" };
		const newJwk = { ...newPair.publicKey.export({ format: "jwk" }), kid: "new", use: "sig", alg: "RS256" };
		let calls = 0;
		let unavailable = false;
		const adapter = new OidcIdentityAdapter({ id: "oidc", type: "oidc", policyRevision: "1", issuer: ISSUER, jwksUri: "https://issuer.example.test/jwks", audience: AUDIENCE }, { now: () => NOW, fetch: async () => { calls++; if (unavailable) throw new Error("upstream included a sensitive credential"); return Response.json({ keys: calls === 1 ? [oldJwk] : [newJwk] }); } });
		await adapter.authenticate(context({ authorization: `Bearer ${jwt(oldPair.privateKey, "old", validClaims())}` }));
		await adapter.authenticate(context({ authorization: `Bearer ${jwt(newPair.privateKey, "new", validClaims())}` }));
		expect(calls).toBe(2);
		unavailable = true;
		await expect(adapter.authenticate(context({ authorization: `Bearer ${jwt(newPair.privateKey, "missing", validClaims())}` }))).rejects.toMatchObject({ message: "request identity was not accepted" });
	});

	it("rejects unsupported JOSE features, malformed claims, excessive lifetime, and multi-valued authorization", async () => {
		const fixture = oidcFixture();
		for (const claims of [validClaims({ aud: "other" }), validClaims({ sub: undefined }), validClaims({ exp: Math.floor(NOW / 1000) + 7200 }), validClaims({ iat: Math.floor(NOW / 1000) + 120 })])
			await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${jwt(fixture.privateKey, "key-1", claims)}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		const token = jwt(fixture.privateKey, "key-1", validClaims());
		await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${token}, Bearer ${token}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		const none = `${Buffer.from('{"alg":"none","kid":"key-1"}').toString("base64url")}.${Buffer.from(JSON.stringify(validClaims())).toString("base64url")}.x`;
		await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${none}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		const claims = Buffer.from(JSON.stringify(validClaims())).toString("base64url");
		for (const protectedHeader of [
			'{"alg":"RS256","alg":"RS256","kid":"key-1"}',
			'{"alg":"RS256","kid":"key-1","crit":["b64"],"b64":false}',
			'{"alg":"RS256","kid":"key-1","cty":"JWT","zip":"DEF"}',
		]) {
			const malformed = `${Buffer.from(protectedHeader).toString("base64url")}.${claims}.eA`;
			await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${malformed}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		}
		const normalHeader = Buffer.from('{"alg":"RS256","kid":"key-1"}').toString("base64url");
		const duplicateClaims = Buffer.from(`{"iss":"${ISSUER}","aud":"${AUDIENCE}","sub":"first","sub":"second","iat":1,"nbf":1,"exp":2}`).toString("base64url");
		await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${normalHeader}.${duplicateClaims}.eA` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		await expect(fixture.adapter.authenticate(context({ authorization: `Bearer ${"a".repeat(16_385)}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		const tooManyKeys = new OidcIdentityAdapter({ id: "bounded", type: "oidc", policyRevision: "1", issuer: ISSUER, jwksUri: "https://issuer.example.test/jwks", audience: AUDIENCE }, {
			now: () => NOW,
			fetch: async () => Response.json({ keys: Array.from({ length: 33 }, () => ({ kty: "RSA", kid: "key-1" })) }),
		});
		await expect(tooManyKeys.authenticate(context({ authorization: `Bearer ${token}` }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
	});

	it("accepts only mapped mTLS fingerprint or SPIFFE identities from a verified trusted proxy", async () => {
		const adapter = new MtlsIdentityAdapter({ id: "services", type: "mtls", policyRevision: "m2", mappings: [
			{ certificateSha256: "ab".repeat(32), principalId: "service-build", grants: [{ scopeId: "build", roles: ["writer"] }] },
			{ serviceId: "spiffe://services.example.test/ci/runner", principalId: "service-ci" },
		] });
		const accepted = await adapter.authenticate(context({ "x-forwarded-proto": "https", "x-t4-client-cert-verified": "SUCCESS", "x-t4-client-cert-sha256": "ab".repeat(32) }));
		expect(accepted).toMatchObject({ principalId: expect.stringMatching(/^id_[A-Za-z0-9_-]{43}$/u), authorizedScopes: [{ scopeId: "build", roles: ["writer"] }] });
		expect(accepted?.principalId).not.toContain("service-build");
		await expect(adapter.authenticate(context({ "x-forwarded-proto": "https", "x-t4-client-cert-verified": "SUCCESS", "x-t4-client-cert-sha256": "cd".repeat(32) }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
		await expect(adapter.authenticate(context({ "x-forwarded-proto": "https", "x-t4-client-cert-verified": "SUCCESS", "x-forwarded-client-cert": "sensitive certificate material", "x-t4-service-id": "spiffe://services.example.test/ci/runner" }))).rejects.toBeInstanceOf(IdentityAuthenticationError);
	});

	it("parses only complete reference-file configuration and rejects inline credential fields", () => {
		expect(identityAdapterConfigsFromJson(JSON.stringify({ adapters: [{ id: "tailnet", type: "tailscale", policyRevision: "1" }] }))).toHaveLength(1);
		expect(() => identityAdapterConfigsFromJson(JSON.stringify({ adapters: [] }))).toThrow(IdentityAuthenticationError);
		expect(() => identityAdapterConfigsFromJson(JSON.stringify({ adapters: [{ id: "oidc", type: "oidc", policyRevision: "1", issuer: ISSUER, audience: AUDIENCE, clientSecret: "must-not-be-inline" }] }))).toThrow(IdentityAuthenticationError);
		expect(() => identityAdapterConfigsFromJson(JSON.stringify({ adapters: [{ id: "tailnet", type: "tailscale", policyRevision: "1", grants: [{ scopeId: "personal", roles: ["owner"] }] }] }))).toThrow(IdentityAuthenticationError);
	});
});
