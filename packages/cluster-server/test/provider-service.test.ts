import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SharedPortableControlLedger } from "@t4-code/portable-control-store";
import { ProviderAssertionVerifier } from "../src/provider-service.ts";

const secrets = { current: Buffer.alloc(32, 7), previous: Buffer.alloc(32, 8), next: Buffer.alloc(32, 9) };
const roots: string[] = [];
const audience = "t4-server.default.svc:8080/internal/provider";
function assertion(secret: Uint8Array, overrides: Record<string, unknown> = {}): string {
	const payload = Buffer.from(JSON.stringify({
		v: 1,
		kid: "current",
		aud: audience,
		purpose: "provider.control",
		principalId: "principal",
		scopeId: "scope",
		requestId: "request",
		exp: 120,
		nonce: "abcdefghijklmnopqrstuvwx",
		authorizedScopes: [{ scopeId: "scope", roles: ["member"] }],
		policyRevision: "ssh-policy-v1",
		...overrides,
	})).toString("base64url");
	return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "provider-keyring-"));
	roots.push(root);
	const path = join(root, "keyring.json");
	const claims = new Set<string>();
	let floorNow = 100;
	let keyringFloor: { revision: number; activeKid: string; previousKid?: string; previousNotAfter?: number } | undefined;
	const ledger = {
		acceptProviderAssertionKeyring: (request: { revision: number; activeKid: string; assertionKid: string; previousKid?: string; previousNotAfter?: number }) => {
			const kidAccepted = (floor: typeof keyringFloor): boolean => Boolean(floor) && (request.assertionKid === floor!.activeKid || request.assertionKid === floor!.previousKid && (floor!.previousNotAfter ?? 0) >= floorNow);
			if (!keyringFloor) {
				if (request.assertionKid !== request.activeKid && (request.assertionKid !== request.previousKid || (request.previousNotAfter ?? 0) < floorNow)) return "rollback" as const;
				keyringFloor = request; return "accepted" as const;
			}
			if (request.revision < keyringFloor.revision) return keyringFloor.previousKid === request.activeKid && (keyringFloor.previousNotAfter ?? 0) >= floorNow && request.assertionKid === request.activeKid ? "accepted" as const : "rollback" as const;
			if (request.revision === keyringFloor.revision) return request.activeKid === keyringFloor.activeKid && request.previousKid === keyringFloor.previousKid && request.previousNotAfter === keyringFloor.previousNotAfter && kidAccepted(keyringFloor) ? "accepted" as const : "rollback" as const;
			if (request.previousKid !== keyringFloor.activeKid || (request.previousNotAfter ?? 0) < floorNow || request.assertionKid !== request.activeKid && request.assertionKid !== request.previousKid) return "rollback" as const;
			keyringFloor = request; return "accepted" as const;
		},
		claimProviderAssertionNonce: ({ nonce }: { nonce: string }) => claims.has(nonce) ? "replayed" as const : (claims.add(nonce), "claimed" as const),
	} as unknown as SharedPortableControlLedger;
	const write = (activeKid: string, keys: readonly { kid: string; secret: Uint8Array; notAfter?: number }[], revision = activeKid === "next" ? 2 : 1) => writeFileSync(path, JSON.stringify({ revision, activeKid, keys: keys.map(key => ({ kid: key.kid, secret: Buffer.from(key.secret).toString("base64url"), ...(key.notAfter === undefined ? {} : { notAfter: key.notAfter }) })) }));
	write("current", [{ kid: "current", secret: secrets.current }, { kid: "previous", secret: secrets.previous, notAfter: 110 }]);
	return { verifier: new ProviderAssertionVerifier({ keyringPath: path, ledger, audience }), write, path, setFloorNow: (value: number) => { floorNow = value; } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("provider assertion verifier", () => {
	it("validates exact audience and mode before atomically claiming replay state", async () => {
		const { verifier } = fixture();
		expect(await verifier.verify(assertion(secrets.current), "control", 100)).toEqual({
			identity: {
				principalId: "principal",
				authorizedScopes: [{ scopeId: "scope", roles: ["member"] }],
				policyRevision: "ssh-policy-v1",
			},
			scopeId: "scope",
			ownerPrincipal: "principal",
			gateway: "ssh",
		});
		expect(await verifier.verify(assertion(secrets.current), "control", 100)).toBeUndefined();
		expect(await verifier.verify(assertion(secrets.current, { nonce: "bbbbbbbbbbbbbbbbbbbbbbbb", aud: "other.default.svc:8080/internal/provider" }), "control", 100)).toBeUndefined();
		expect(await verifier.verify(assertion(secrets.current, { nonce: "cccccccccccccccccccccccc" }), "stream", 100)).toBeUndefined();
		expect(await verifier.verify(assertion(secrets.current, { nonce: "dddddddddddddddddddddddd", purpose: "provider.stream" }), "stream", 100)).toBeDefined();
	});

	it("reloads current and bounded previous keys and rejects them after overlap", async () => {
		const { verifier, write, setFloorNow } = fixture();
		expect(await verifier.verify(assertion(secrets.previous, { kid: "previous", nonce: "eeeeeeeeeeeeeeeeeeeeeeee" }), "control", 100)).toBeDefined();
		expect(await verifier.verify(assertion(secrets.previous, { kid: "previous", nonce: "ffffffffffffffffffffffff" }), "control", 111)).toBeUndefined();
		write("next", [{ kid: "next", secret: secrets.next }, { kid: "current", secret: secrets.current, notAfter: 130 }]);
		expect(await verifier.verify(assertion(secrets.next, { kid: "next", nonce: "gggggggggggggggggggggggg" }), "control", 100)).toBeDefined();
		expect(await verifier.verify(assertion(secrets.current, { nonce: "hhhhhhhhhhhhhhhhhhhhhhhh" }), "control", 100)).toBeDefined();
		write("current", [{ kid: "current", secret: secrets.current }]);
		expect(await verifier.verify(assertion(secrets.current, { nonce: "kkkkkkkkkkkkkkkkkkkkkkkk" }), "control", 100)).toBeDefined();
		setFloorNow(131);
		expect(await verifier.verify(assertion(secrets.current, { exp: 150, nonce: "llllllllllllllllllllllll" }), "control", 131)).toBeUndefined();
	});

	it("rejects oversized keyrings and overlap windows beyond the configured bound", async () => {
		const { verifier, write, path } = fixture();
		write("next", [{ kid: "next", secret: secrets.next }, { kid: "current", secret: secrets.current, notAfter: 401 }]);
		expect(await verifier.verify(assertion(secrets.next, { kid: "next", nonce: "iiiiiiiiiiiiiiiiiiiiiiii" }), "control", 100)).toBeUndefined();
		writeFileSync(path, "x".repeat(16_385));
		expect(await verifier.verify(assertion(secrets.next, { kid: "next", nonce: "jjjjjjjjjjjjjjjjjjjjjjjj" }), "control", 100)).toBeUndefined();
	});
	it("rejects expired, overlong, and tampered assertions", async () => {
		const { verifier } = fixture();
		expect(await verifier.verify(assertion(secrets.current, { exp: 99 }), "control", 100)).toBeUndefined();
		expect(await verifier.verify(assertion(secrets.current, { exp: 131 }), "control", 100)).toBeUndefined();
		const valid = assertion(secrets.current, { nonce: "zyxwvutsrqponmlkjihgfedc" });
		expect(await verifier.verify(`${valid.slice(0, -1)}A`, "control", 100)).toBeUndefined();
		expect(await verifier.verify("x".repeat(5_000), "control", 100)).toBeUndefined();
	});
});
