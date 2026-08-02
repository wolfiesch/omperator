import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vite-plus/test";
import {
	removeTerminalAttachIdentity,
	terminalAttachConfigFromEnv,
	writeTerminalAttachIdentity,
} from "../src/terminal-attach-identity.ts";

const GENERATION = "gen_123456789012345678901234";

describe("terminal attach identity", () => {
	it("publishes the fixed host/session and runtime-local socket as a private bounded manifest", async () => {
		const runtimeRoot = await mkdtemp(join(tmpdir(), "t4-attach-"));
		try {
			const path = await writeTerminalAttachIdentity(runtimeRoot, {
				runtimeId: "runtime-fixture",
				generation: GENERATION,
				hostId: "pod:session-fixture",
				sessionId: "session-fixture",
			});
			expect(path).toBe(join(runtimeRoot, "terminal-attach.json"));
			expect((await stat(path)).mode & 0o777).toBe(0o640);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				runtimeId: "runtime-fixture",
				generation: GENERATION,
				hostId: "pod:session-fixture",
				sessionId: "session-fixture",
				socketPath: join(runtimeRoot, "attach.sock"),
			});
			await removeTerminalAttachIdentity(runtimeRoot);
			await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(runtimeRoot, { recursive: true, force: true });
		}
	});

	it("fails closed before file access when the inherited runtime root or generation is not fixed", async () => {
		await expect(terminalAttachConfigFromEnv({
			T4_RUNTIME_ID: "runtime-fixture",
			T4_RUNTIME_GENERATION: GENERATION,
			T4_SESSION_NAME: "session-fixture",
			T4_HOST_RUNTIME_DIR: "/run/t4/other-runtime",
		})).rejects.toThrow("does not match T4_RUNTIME_ID");
		await expect(terminalAttachConfigFromEnv({
			T4_RUNTIME_ID: "runtime-fixture",
			T4_RUNTIME_GENERATION: "gen_stale",
			T4_SESSION_NAME: "session-fixture",
			T4_HOST_RUNTIME_DIR: "/run/t4/runtime-fixture",
		})).rejects.toThrow("T4_RUNTIME_GENERATION");
	});
});
