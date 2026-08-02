import { expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionOwnershipStore } from "@t4-code/host-service";
import { sessionId } from "@t4-code/host-wire";
import { claimDedicatedSessionOwnership } from "../src/session-host-main.ts";

it("claims the bridge-created dedicated session before clients can attach", async () => {
	const root = await mkdtemp(join(tmpdir(), "t4-session-host-ownership-"));
	try {
		const ownershipPath = join(root, "private", "owned-sessions.json");
		const transcriptPath = join(root, "authority", "session.jsonl");
		const id = sessionId("session-dedicated");
		await claimDedicatedSessionOwnership(ownershipPath, { sessionId: id, path: transcriptPath });

		const persisted = new SessionOwnershipStore(ownershipPath);
		await persisted.load();
		expect(persisted.owns(id, transcriptPath)).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
