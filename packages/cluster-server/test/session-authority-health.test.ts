import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionCredentialClient } from "../src/session-credential-client.ts";
import { probeSessionAuthority, startSessionAuthorityHealth } from "../src/session-authority-health.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("session authority active health", () => {
	it("requires a fresh registered host and held generation writer Lease", async () => {
		const root = await mkdtemp(join(tmpdir(), "t4-authority-health-")); roots.push(root);
		const socketPath = join(root, "health.sock");
		let fresh = true;
		let leaseHeld = true;
		const credential = { state: async () => ({ generation: "gen_current", generationAuthSha256: "0".repeat(64), registered: true, fresh, leaseHeld }) } as unknown as SessionCredentialClient;
		const health = await startSessionAuthorityHealth(socketPath, "gen_current", credential);
		await expect(probeSessionAuthority(socketPath, "gen_current")).resolves.toBeUndefined();
		fresh = false;
		await expect(probeSessionAuthority(socketPath, "gen_current")).rejects.toThrow("not registered, fresh");
		fresh = true; leaseHeld = false;
		await expect(probeSessionAuthority(socketPath, "gen_current")).rejects.toThrow("not registered, fresh");
		await expect(probeSessionAuthority(socketPath, "gen_stale")).rejects.toThrow("not registered, fresh");
		await health.stop();
	});
});
