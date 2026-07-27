import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunProcessRunner, noninteractiveProcessEnvironment } from "../src/remote/runtime.ts";

test("Tailscale process runner supplies a noninteractive terminal marker", async () => {
	const root = mkdtempSync(join(tmpdir(), "t4-tailscale-runner-"));
	const executable = join(root, "tailscale");
	writeFileSync(executable, '#!/bin/sh\nprintf \'{"term":"%s"}\' "${TERM-}"\n');
	chmodSync(executable, 0o700);
	expect(noninteractiveProcessEnvironment({ HOME: "/tmp/test" })).toEqual({
		HOME: "/tmp/test",
		TERM: "dumb",
	});
	const result = await new BunProcessRunner(executable, {}).run(["tailscale", "whois", "--json", "100.64.0.1"], {
		timeoutMs: 1_000,
		maxOutputBytes: 1_024,
	});
	expect(result).toEqual({ stdout: '{"term":"dumb"}', exitCode: 0 });
});
