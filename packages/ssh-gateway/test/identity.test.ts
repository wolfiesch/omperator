import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { authenticatedSshIdentity, authenticatedSshPrincipal } from "../src/identity.ts";

const directories: string[] = [];
const PUBLIC_KEY = "publickey ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGQ2YjM0NzI4OWQ2YjM0NzI4OWQ2YjM0NzI4OWQ2YjM0NzI4\n";
const CERTIFICATE = "publickey ssh-ed25519-cert-v01@openssh.com SHA256:AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd certificate-id\n";

async function fixture(contents: string, mode = 0o600): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "t4-ssh-auth-"));
	directories.push(directory);
	const path = join(directory, "auth-info");
	await writeFile(path, contents, { mode });
	await chmod(path, mode);
	return path;
}
const rejectedFixtures: ReadonlyArray<{ readonly name: string; readonly prepare: () => Promise<string> }> = [
	{ name: "ambiguous multiple public keys", prepare: () => fixture(`${PUBLIC_KEY}${CERTIFICATE}`) },
	{ name: "malformed authentication method", prepare: () => fixture("password\n") },
	{ name: "group-writable file", prepare: () => fixture(PUBLIC_KEY, 0o620) },
	{ name: "oversized file", prepare: () => fixture(`publickey ssh-ed25519 ${"A".repeat(16_385)}\n`) },
	{ name: "relative path", prepare: async () => "relative-auth-info" },
	{ name: "symbolic link", prepare: async () => {
		const target = await fixture(PUBLIC_KEY);
		const link = join(directories.at(-1)!, "auth-link");
		await symlink(target, link);
		return link;
	} },
];


afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("OpenSSH ExposeAuthInfo identity adapter", () => {
	test.each([PUBLIC_KEY, CERTIFICATE])("derives a versioned opaque principal from authenticated key or certificate info", async authInfo => {
		const path = await fixture(authInfo);
		const identity = await authenticatedSshIdentity(path);
		expect(identity).toMatchObject({
			adapter: { id: "openssh-expose-auth-info", type: "ssh" },
			authorizedScopes: [],
			policyRevision: "ssh-expose-auth-info-v1",
		});
		expect(identity.principalId).toMatch(/^id_[A-Za-z0-9_-]{43}$/u);
		expect(await authenticatedSshPrincipal(path)).toBe(identity.principalId);
	});

	test("is independent of SSH username because only the authenticated ExposeAuthInfo file is consumed", async () => {
		const path = await fixture(PUBLIC_KEY);
		const previous = process.env.USER;
		try {
			process.env.USER = "first-user";
			const first = await authenticatedSshPrincipal(path);
			process.env.USER = "different-user";
			expect(await authenticatedSshPrincipal(path)).toBe(first);
		} finally {
			if (previous === undefined) delete process.env.USER;
			else process.env.USER = previous;
		}
	});

	test.each(rejectedFixtures)("rejects $name", async ({ prepare }) => {
		await expect(authenticatedSshPrincipal(await prepare())).rejects.toMatchObject({ code: "IDENTITY_REQUIRED" });
	});
});
