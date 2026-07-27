import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { HostId } from "@t4-code/host-wire";
import { hostId } from "@t4-code/host-wire";

export function createHostId(value?: string): HostId {
	return hostId(value ?? `host-${randomUUID()}`);
}
export function createEpoch(value?: string): string {
	return value ?? `epoch-${randomUUID()}`;
}
export function defaultHostIdPath(home = process.env.HOME || homedir()): string {
	return join(home, ".omp", "agent", "appserver", "host-id");
}
/**
 * A deep HOME (a development sandbox nested in a worktree) produced a socket
 * path long enough that connect(2) failed with EINVAL on every attempt.
 * T4_HOST_RUNTIME_DIR relocates the socket to a short absolute directory; the
 * desktop app and the host service both honor it and must agree on the result.
 */

export function defaultSocketPath(
	platform = process.platform,
	home = homedir(),
	runtime = process.env.XDG_RUNTIME_DIR,
	// An explicit override is honored on every platform. A deep sandbox HOME
	// cannot otherwise produce a socket path that fits.
	override = process.env.T4_HOST_RUNTIME_DIR,
): string {
	if (override !== undefined && override.length > 0) {
		if (!override.startsWith("/")) throw new Error("T4_HOST_RUNTIME_DIR must be an absolute path");
		return join(override, "appserver.sock");
	}
	return platform === "darwin"
		? join(home, ".omp", "run", "appserver.sock")
		: join(runtime || join(home, ".omp", "run"), "omp", "appserver.sock");
}

/**
 * Resolve the public Unix-socket alias for an OMP profile.
 *
 * The implicit/default profile deliberately delegates to {@link defaultSocketPath}
 * so its path remains byte-for-byte compatible. Named profiles share the same
 * secured runtime directory while receiving a deterministic, fixed-width alias.
 * Hashing keeps the pathname bounded even for the longest valid OMP profile name
 * and prevents profile text from becoming a path segment.
 */
export function profileSocketPath(
	profile: string | undefined,
	platform = process.platform,
	home = homedir(),
	runtime = process.env.XDG_RUNTIME_DIR,
): string {
	if (!profile || profile === "default") return defaultSocketPath(platform, home, runtime);
	const digest = createHash("sha256").update(profile).digest("hex").slice(0, 24);
	return join(dirname(defaultSocketPath(platform, home, runtime)), `appserver-profile-${digest}.sock`);
}
export async function loadPersistentHostId(path = defaultHostIdPath()): Promise<HostId> {
	try {
		const value = (await readFile(path, "utf8")).trim();
		if (value) return hostId(value);
	} catch {}
	const value = createHostId();
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await chmod(dirname(path), 0o700);
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, `${value}\n`, { mode: 0o600 });
	await rename(temp, path);
	await chmod(path, 0o600);
	return value;
}
export async function unixSocketActive(path: string): Promise<boolean> {
	const gate = Promise.withResolvers<boolean>();
	const socket = createConnection(path);
	socket.once("connect", () => {
		socket.destroy();
		gate.resolve(true);
	});
	socket.once("error", error => {
		socket.destroy();
		gate.resolve(
			(error as NodeJS.ErrnoException).code !== "ECONNREFUSED" && (error as NodeJS.ErrnoException).code !== "ENOENT",
		);
	});
	return gate.promise;
}
