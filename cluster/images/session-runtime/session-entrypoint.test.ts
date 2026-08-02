import { afterEach, describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import {
	chmod,
	chown,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import path from "node:path";

const entrypoint = path.join(import.meta.dir, "session-entrypoint.sh");
const temporaryRoots: string[] = [];
const rootOnlyTest = (process.getuid?.() ?? -1) === 0 ? test : test.skip;
const linuxOnlyDescribe = process.platform === "linux" ? describe : describe.skip;
const runtimeID = "runtime-contract-test";
const generation = "gen_abcdefghijklmnopqrstuvwx";
const fixtureOwnerToken = "01234567".repeat(4);

interface Fixture {
	readonly root: string;
	readonly runtimeMount: string;
	readonly workspaceMount: string;
	readonly shortMount: string;
	readonly stateRoot: string;
}

async function fixture(shortName = "short"): Promise<Fixture> {
	const unresolved = await mkdtemp("/tmp/t4-runtime-");
	const root = await realpath(unresolved);
	temporaryRoots.push(root);
	const runtimeMount = path.join(root, "runtime-state");
	const workspaceMount = path.join(root, "workspace");
	const shortMount = path.join(root, shortName);
	await mkdir(runtimeMount, { mode: 0o700 });
	await mkdir(workspaceMount, { mode: 0o755 });
	await mkdir(shortMount, { mode: 0o700 });
	const uid = process.getuid?.() ?? 0;
	const gid = process.getgid?.() ?? 0;
	await Promise.all([root, runtimeMount, workspaceMount, shortMount].map((directory) => chown(directory, uid, gid)));
	return { root, runtimeMount, workspaceMount, shortMount, stateRoot: path.join(runtimeMount, runtimeID) };
}

const initializeScript = [
	"set -euo pipefail",
	'source "$1"',
	'runtime_mount="$2"',
	'workspace_mount="$3"',
	'short_mount="$4"',
	'runtime_id="$5"',
	'export T4_SESSION_STATE_ID="${runtime_id}"',
	'root="${runtime_mount}/${runtime_id}"',
	'export T4_RUNTIME_ID="${runtime_id}"',
	'export T4_RUNTIME_GENERATION="${TEST_GENERATION}"',
	"export T4_SESSION_NAME=contract-session",
	'export T4_SESSION_STATE_ROOT="${root}"',
	'export T4_AUTHORITY_STATE_DIR="${root}/authority"',
	'export T4_CMUX_STATE_DIR="${root}/cmux"',
	'export T4_BROWSER_STATE_DIR="${root}/browser"',
	'export T4_ARTIFACT_ROOT="${T4_TEST_ARTIFACT_ROOT:-${root}/artifacts}"',
	'export T4_PRIVATE_RUNTIME_DIR="${root}/private"',
	'export T4_OMP_HOME="${root}/home"',
	'export T4_WRITER_LEASE_PATH="${root}/private/writer-lease"',
	'export T4_HOST_RUNTIME_DIR="${short_mount}/${runtime_id}"',
	'export T4_CMUX_SOCKET_PATH="${T4_HOST_RUNTIME_DIR}/c.sock"',
	"export T4_CMUX_SOCKET_MODE=0660",
	'export T4_WORKSPACE_ROOT="${workspace_mount}"',
	'initialize_runtime_roots "${runtime_mount}" "${workspace_mount}" "${short_mount}" "${TEST_UID}" "${TEST_GID}"',
	`printf '%s\\n' "\${HOME}" "\${XDG_RUNTIME_DIR}" "\${PI_CODING_AGENT_DIR}" "\${T4_OMP_AUTHORITY_DIR}" "\${T4_OMP_ARTIFACT_ROOT}" "\${CMUX_STATE_DIR}" "\${CMUX_SOCKET_PATH}" "\${CMUX_SOCKET_MODE}" "\${CMUX_SESSION}" "\${T4_BROWSER_STATE_DIR}" "\${T4_WORKSPACE_ROOT}" "\${T4_WRITER_LEASE_PATH}" "\${T4_RUNTIME_GENERATION}" "\${T4_HOST_RUNTIME_DIR}" "\${T4_SESSION_HOST_READY_PATH}"`,
].join("\n");
const initializeQuietScript = initializeScript.slice(0, initializeScript.lastIndexOf("\n"));

async function runShell(script: string, args: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn(["bash", "-c", script, "t4-contract", ...args], {
		env: {
			...process.env,
			TEST_UID: String(process.getuid?.() ?? 0),
			TEST_GID: String(process.getgid?.() ?? 0),
			TEST_GENERATION: generation,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function initialize(value: Fixture, env: Record<string, string> = {}) {
	return runShell(initializeScript, [entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID], env);
}

function mode(stat: Stats): number {
	return stat.mode & 0o777;
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("session runtime private roots", () => {
	test("preserves the controller-projected runtime resource UID", async () => {
		const result = await runShell(
			'set -euo pipefail; export T4_RUNTIME_UID="runtime-resource-uid"; source "$1"; printf "%s\\n" "$T4_RUNTIME_UID"',
			[entrypoint],
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "runtime-resource-uid\n", stderr: "" });
	});

	test("initializes distinct durable roots and exports the P3-03 environment contract", async () => {
		const value = await fixture();
		const result = await initialize(value);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		const expectedDirectories: Array<readonly [string, number]> = [
			[value.stateRoot, 0o770],
			[path.join(value.stateRoot, "authority"), 0o700],
			[path.join(value.stateRoot, "authority", "agent"), 0o700],
			[path.join(value.stateRoot, "cmux"), 0o770],
			[path.join(value.stateRoot, "browser"), 0o770],
			[path.join(value.stateRoot, "artifacts"), 0o700],
			[path.join(value.stateRoot, "private"), 0o700],
			[path.join(value.stateRoot, "home"), 0o700],
			[path.join(value.shortMount, runtimeID), 0o770],
		];
		for (const [directory, expectedMode] of expectedDirectories) {
			const stat = await lstat(directory);
			expect(stat.isDirectory()).toBe(true);
			expect(stat.isSymbolicLink()).toBe(false);
			expect(mode(stat)).toBe(expectedMode);
			expect(stat.uid).toBe(process.getuid?.() ?? 0);
			expect(stat.gid).toBe(process.getgid?.() ?? 0);
		}
		expect(result.stdout.trim().split("\n")).toEqual([
			path.join(value.stateRoot, "home"),
			path.join(value.shortMount, runtimeID),
			path.join(value.stateRoot, "authority", "agent"),
			path.join(value.stateRoot, "authority"),
			path.join(value.stateRoot, "artifacts"),
			path.join(value.stateRoot, "cmux"),
			path.join(value.shortMount, runtimeID, "c.sock"),
			"0660",
			"contract-session",
			path.join(value.stateRoot, "browser"),
			value.workspaceMount,
			path.join(value.stateRoot, "private", "writer-lease"),
			generation,
			path.join(value.shortMount, runtimeID),
			path.join(value.shortMount, runtimeID, "host.ready"),
		]);
		expect(await lstat(value.workspaceMount).then(mode)).toBe(0o755);
		expect(await readdir(value.workspaceMount)).toEqual([]);
	});

	test("rejects a symlinked controller-owned root", async () => {
		const value = await fixture();
		const target = path.join(value.root, "outside");
		await mkdir(target, { mode: 0o700 });
		await symlink(target, value.stateRoot);
		const result = await initialize(value);
		expect(result.exitCode).toBe(64);
		expect(result.stderr).toContain("runtime_root");
	});

	test("rejects escape, overlap, and a preexisting wrong mode instead of repairing", async () => {
		const escape = await fixture();
		const escaped = await initialize(escape, { T4_TEST_ARTIFACT_ROOT: path.join(escape.workspaceMount, "artifacts") });
		expect(escaped.exitCode).toBe(64);
		expect(escaped.stderr).toContain("artifact_state_path");

		const overlap = await fixture();
		const overlapped = await runShell(initializeScript, [entrypoint, overlap.runtimeMount, overlap.runtimeMount, overlap.shortMount, runtimeID]);
		expect(overlapped.exitCode).toBe(64);
		expect(overlapped.stderr).toContain("workspace_runtime_overlap");

		const wrongMode = await fixture();
		await mkdir(wrongMode.stateRoot, { mode: 0o755 });
		await chmod(wrongMode.stateRoot, 0o755);
		const rejected = await initialize(wrongMode);
		expect(rejected.exitCode).toBe(64);
		expect(rejected.stderr).toContain("session_state_directory");
		expect(await lstat(wrongMode.stateRoot).then(mode)).toBe(0o755);
	});

	rootOnlyTest("rejects a preexisting root owned by another uid", async () => {
		const value = await fixture();
		await mkdir(value.stateRoot, { mode: 0o700 });
		await chown(value.stateRoot, 1, 1);
		const result = await initialize(value);
		expect(result.exitCode).toBe(64);
		expect(result.stderr).toContain("session_state_directory");
	});

	test("rejects a cmux socket path beyond the portable Unix limit", async () => {
		const value = await fixture(`short-${"x".repeat(90)}`);
		const result = await initialize(value);
		expect(Buffer.byteLength(path.join(value.shortMount, runtimeID, "c.sock"))).toBeGreaterThan(103);
		expect(result.exitCode).toBe(64);
		expect(result.stderr).toContain("cmux_socket_path_too_long");
	});

	test("preserves the shell-owned cmux socket across an authority-container restart", async () => {
		const value = await fixture();
		expect((await initialize(value)).exitCode).toBe(0);
		const socketPath = path.join(value.shortMount, runtimeID, "c.sock");
		await writeFile(socketPath, "", { mode: 0o600 });
		const result = await initialize(value);
		expect(result.exitCode).toBe(0);
		expect(mode(await lstat(socketPath))).toBe(0o600);
	});
});

const leaseScript = [
	initializeQuietScript,
	'acquire_writer_lease "${T4_WRITER_LEASE_PATH}" "${T4_RUNTIME_ID}" "${T4_RUNTIME_GENERATION}" "${TEST_UID}" "${TEST_GID}"',
	'"${T4_LEASE_ACTION:-cleanup_writer_lease}"',
].join("\n");

linuxOnlyDescribe("session runtime writer lease", () => {
	test("reclaims a well-formed stale lease and removes only its own lease on cleanup", async () => {
		const value = await fixture();
		const bootID = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		expect((await initialize(value)).exitCode).toBe(0);
		const lease = path.join(value.stateRoot, "private", "writer-lease");
		await writeFile(lease, `version=1\nruntime_id=${runtimeID}\nruntime_generation=${generation}\nboot_id=${bootID}\npid=999999999\nstart_time=0\nowner_token=${fixtureOwnerToken}\n`, { mode: 0o600 });
		const result = await runShell(leaseScript, [entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID]);
		expect(result.exitCode).toBe(0);
		expect(await lstat(lease).catch(() => null)).toBeNull();
	});

	test("a signal during lease publication removes only the locked inode and permits reacquisition", async () => {
		const value = await fixture();
		const script = [
			initializeQuietScript,
			"trap 'lease_acquisition_signal 143' TERM",
			"trap cleanup_writer_lease EXIT",
			"writer_lease_before_publish() {",
			"  printf 'publishing\\n'",
			'  while [[ -z "${T4_WRITER_LEASE_INTERRUPTED_STATUS}" ]]; do read -r -t 1 _ || true; done',
			"}",
			'acquire_writer_lease "${T4_WRITER_LEASE_PATH}" "${T4_RUNTIME_ID}" "${T4_RUNTIME_GENERATION}" "${TEST_UID}" "${TEST_GID}"',
		].join("\n");
		const holder = Bun.spawn(["bash", "-c", script, "t4-contract", entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID], {
			env: { ...process.env, TEST_UID: String(process.getuid?.() ?? 0), TEST_GID: String(process.getgid?.() ?? 0), TEST_GENERATION: generation },
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = holder.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("publishing");
		holder.kill("SIGTERM");
		expect(await holder.exited).toBe(143);
		const lease = path.join(value.stateRoot, "private", "writer-lease");
		expect(await lstat(lease).catch(() => null)).toBeNull();
		expect((await runShell(leaseScript, [entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID])).exitCode).toBe(0);
	});

	test("fails closed when the durable filesystem cannot fsync the lease", async () => {
		const value = await fixture();
		expect((await initialize(value)).exitCode).toBe(0);
		const bin = path.join(value.root, "bin");
		await mkdir(bin, { mode: 0o700 });
		await writeFile(path.join(bin, "sync"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o700 });
		const result = await runShell(
			leaseScript,
			[entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID],
			{ PATH: `${bin}:${process.env.PATH ?? ""}` },
		);
		expect(result.exitCode).toBe(64);
		expect(result.stderr).toContain("runtime_state_not_durable");
	});

	test("fails closed on malformed, foreign, generation-mismatched, and wrong-mode leases", async () => {
		const malformedFixture = await fixture();
		const bootID = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
		expect((await initialize(malformedFixture)).exitCode).toBe(0);
		const malformed = path.join(malformedFixture.stateRoot, "private", "writer-lease");
		await writeFile(malformed, "not-a-lease\n", { mode: 0o600 });
		const malformedResult = await runShell(leaseScript, [entrypoint, malformedFixture.runtimeMount, malformedFixture.workspaceMount, malformedFixture.shortMount, runtimeID]);
		expect(malformedResult.exitCode).toBe(64);
		expect(malformedResult.stderr).toContain("writer_lease_malformed");

		const mismatchFixture = await fixture();
		expect((await initialize(mismatchFixture)).exitCode).toBe(0);
		const mismatch = path.join(mismatchFixture.stateRoot, "private", "writer-lease");
		await writeFile(mismatch, `version=1\nruntime_id=${runtimeID}\nruntime_generation=gen_zyxwvutsrqponmlkjihgfedc\nboot_id=${bootID}\npid=999999999\nstart_time=0\nowner_token=${fixtureOwnerToken}\n`, { mode: 0o600 });
		const mismatchResult = await runShell(leaseScript, [entrypoint, mismatchFixture.runtimeMount, mismatchFixture.workspaceMount, mismatchFixture.shortMount, runtimeID]);
		expect(mismatchResult.exitCode).toBe(64);
		expect(mismatchResult.stderr).toContain("writer_lease_generation_mismatch");

		await writeFile(mismatch, `version=1\nruntime_id=runtime-foreign\nruntime_generation=${generation}\nboot_id=${bootID}\npid=999999999\nstart_time=0\nowner_token=${fixtureOwnerToken}\n`);
		const foreignResult = await runShell(leaseScript, [entrypoint, mismatchFixture.runtimeMount, mismatchFixture.workspaceMount, mismatchFixture.shortMount, runtimeID]);
		expect(foreignResult.exitCode).toBe(64);
		expect(foreignResult.stderr).toContain("writer_lease_runtime_mismatch");

		await writeFile(mismatch, `version=1\nruntime_id=${runtimeID}\nruntime_generation=${generation}\nboot_id=${bootID}\npid=999999999\nstart_time=0\nowner_token=${fixtureOwnerToken}\n`);
		await chmod(mismatch, 0o644);
		const wrongModeResult = await runShell(leaseScript, [entrypoint, mismatchFixture.runtimeMount, mismatchFixture.workspaceMount, mismatchFixture.shortMount, runtimeID]);
		expect(wrongModeResult.exitCode).toBe(64);
		expect(wrongModeResult.stderr).toContain("writer_lease_file");
	});

	test("rejects a live duplicate and a non-owner cannot clean up its lease", async () => {
		const value = await fixture();
		const holderScript = [
			initializeQuietScript,
			'acquire_writer_lease "${T4_WRITER_LEASE_PATH}" "${T4_RUNTIME_ID}" "${T4_RUNTIME_GENERATION}" "${TEST_UID}" "${TEST_GID}"',
			"trap 'cleanup_writer_lease; exit 0' TERM INT",
			"trap cleanup_writer_lease EXIT",
			"printf 'ready\\n'",
			"while :; do sleep 1; done",
		].join("\n");
		const holder = Bun.spawn(["bash", "-c", holderScript, "t4-contract", entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID], {
			env: { ...process.env, TEST_UID: String(process.getuid?.() ?? 0), TEST_GID: String(process.getgid?.() ?? 0), TEST_GENERATION: generation },
			stdout: "pipe",
			stderr: "pipe",
		});
		const lease = path.join(value.stateRoot, "private", "writer-lease");
		try {
			const reader = holder.stdout.getReader();
			const ready = await reader.read();
			expect(new TextDecoder().decode(ready.value)).toContain("ready");
			const ownerToken = /^owner_token=([0-9a-f]{32})$/mu.exec(await readFile(lease, "utf8"))?.[1];
			expect(ownerToken).toBeDefined();
			if (!ownerToken) throw new Error("writer lease owner token is missing");

			const duplicate = await runShell(leaseScript, [entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID]);
			expect(duplicate.exitCode).toBe(64);
			expect(duplicate.stderr).toContain("writer_lease_live_duplicate");

			const intruder = await runShell([
				"set -euo pipefail",
				'source "$1"',
				'export T4_WRITER_LEASE_PATH="$2"',
				"T4_WRITER_LEASE_HELD=true",
				'T4_WRITER_LEASE_OWNER_BASHPID="${BASHPID}"',
				'T4_WRITER_LEASE_OWNER_TOKEN="$3"',
				"T4_WRITER_LEASE_INODE=\"$(stat -c '%d:%i' -- \"$2\")\"",
				"cleanup_writer_lease",
			].join("\n"), [entrypoint, lease, ownerToken]);
			expect(intruder.exitCode).toBe(0);
			expect((await lstat(lease)).isFile()).toBe(true);
		} finally {
			holder.kill("SIGTERM");
			await holder.exited;
		}
		expect(await lstat(lease).catch(() => null)).toBeNull();
	});

	test("does not swallow a signal after lease acquisition but before supervisor launch", async () => {
		const value = await fixture();
		const script = [
			initializeQuietScript,
			"trap 'lease_acquisition_signal 143' TERM",
			"trap cleanup_writer_lease EXIT",
			'acquire_writer_lease "${T4_WRITER_LEASE_PATH}" "${T4_RUNTIME_ID}" "${T4_RUNTIME_GENERATION}" "${TEST_UID}" "${TEST_GID}"',
			"trap 'forward_supervisor_signal TERM 143' TERM",
			"runtime_before_supervisor_launch() {",
			"  printf 'post-acquire\\n'",
			'  while [[ -z "${entrypoint_pending_signal}" ]]; do read -r -t 1 _ || true; done',
			"}",
			"run_runtime_supervisor() { while :; do read -r -t 1 _ || true; done; }",
			"launch_supervised_runtime",
		].join("\n");
		const holder = Bun.spawn(["bash", "-c", script, "t4-contract", entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID], {
			env: { ...process.env, TEST_UID: String(process.getuid?.() ?? 0), TEST_GID: String(process.getgid?.() ?? 0), TEST_GENERATION: generation },
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = holder.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("post-acquire");
		holder.kill("SIGTERM");
		expect(await holder.exited).toBe(143);
		const lease = path.join(value.stateRoot, "private", "writer-lease");
		expect(await lstat(lease).catch(() => null)).toBeNull();
		expect((await runShell(leaseScript, [entrypoint, value.runtimeMount, value.workspaceMount, value.shortMount, runtimeID])).exitCode).toBe(0);
	});

	test("does not release the writer lease until the supervised child has been reaped", async () => {
		const value = await fixture();
		const events = path.join(value.root, "shutdown-events");
		const script = [
			"set -euo pipefail",
			'source "$1"',
			'events="$2"',
			'cleanup_writer_lease() { printf "lease-cleanup\\n" >> "${events}"; }',
			"run_runtime_supervisor() {",
			"  trap 'printf \"child-reaped\\n\" >> \"${events}\"; exit 0' TERM INT",
			'  printf "ready\\n"',
			"  while :; do read -r -t 1 _ || true; done",
			"}",
			"trap 'forward_supervisor_signal TERM 143' TERM",
			"trap entrypoint_cleanup EXIT",
			"supervise_runtime",
		].join("\n");
		const holder = Bun.spawn(["bash", "-c", script, "t4-contract", entrypoint, events], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const reader = holder.stdout.getReader();
		const ready = await reader.read();
		expect(new TextDecoder().decode(ready.value)).toContain("ready");
		holder.kill("SIGTERM");
		expect(await holder.exited).toBe(0);
		expect((await readFile(events, "utf8")).trim().split("\n")).toEqual(["child-reaped", "lease-cleanup"]);
	});
});
