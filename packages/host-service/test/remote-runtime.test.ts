import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BunProcessRunner,
	noninteractiveProcessEnvironment,
	resolveTailnetOwnerUserId,
} from "../src/remote/runtime.ts";

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

function ownerOptions(stdout: string, exitCode = 0) {
	return {
		stateDir: "/tmp/t4-owner-test",
		remoteEndpoint: { address: "100.64.0.1", port: 1 },
		tailscaleExecutable: "/usr/bin/tailscale",
		processRunner: {
			run: async () => ({ stdout, exitCode }),
		},
	};
}

test("owner resolution prefers Self.UserID and falls back to a lone User map entry", async () => {
	expect(
		await resolveTailnetOwnerUserId(
			ownerOptions(JSON.stringify({ Self: { UserID: 42 }, User: { "42": { ID: 42, LoginName: "a" } } })),
		),
	).toBe("42");
	expect(
		await resolveTailnetOwnerUserId(ownerOptions(JSON.stringify({ Self: { ID: "node" }, User: { "7": { ID: 7 } } }))),
	).toBe("7");
});

test("owner resolution is undefined when the user is ambiguous or the lookup fails", async () => {
	expect(
		await resolveTailnetOwnerUserId(
			ownerOptions(
				JSON.stringify({ Self: { ID: "node" }, User: { "7": { ID: 7 }, "8": { ID: 8 } } }),
			),
		),
	).toBeUndefined();
	expect(await resolveTailnetOwnerUserId(ownerOptions(JSON.stringify({ Self: { ID: "node" } })))).toBeUndefined();
	expect(await resolveTailnetOwnerUserId(ownerOptions("{", 0))).toBeUndefined();
	expect(await resolveTailnetOwnerUserId(ownerOptions("", 1))).toBeUndefined();
	expect(
		await resolveTailnetOwnerUserId({
			stateDir: "/tmp/t4-owner-test",
			remoteEndpoint: { address: "100.64.0.1", port: 1 },
			tailscaleExecutable: "/usr/bin/tailscale",
			processRunner: {
				run: async () => {
					throw new Error("boom");
				},
			},
		}),
	).toBeUndefined();
	expect(
		await resolveTailnetOwnerUserId({
			stateDir: "/tmp/t4-owner-test",
			remoteEndpoint: { address: "100.64.0.1", port: 1 },
			tailscaleExecutable: join(tmpdir(), "missing-tailscale-" + process.pid),
		}),
	).toBeUndefined();
});
