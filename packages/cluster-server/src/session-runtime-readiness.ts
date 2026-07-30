#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { access, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CMUX_PROTOCOL_VERSION, CMUX_SOURCE_COMMIT } from "../../cmux-runtime/src/index.ts";

const execute = promisify(execFile);
const MAX_IDENTITY_BYTES = 16 * 1024;
const MAX_READY_BYTES = 4 * 1024;
const BROWSER_TIMEOUT_MS = 750;
const CMUX_IDENTITY_KEYS = ["app", "build_commit", "capabilities", "pid", "protocol", "session"] as const;
const CMUX_CAPABILITIES = ["provider-managed-workspace-authority-v2"] as const;

export type RuntimeProbeKind = "startup" | "readiness" | "liveness";

export interface RuntimeReadinessConfig {
	readonly runtimeId: string;
	readonly generation: string;
	readonly sessionName: string;
	readonly stateRoot: string;
	readonly workspaceRoot: string;
	readonly hostRuntimeRoot: string;
	readonly cmuxStateRoot: string;
	readonly browserStateRoot: string;
	readonly authorityStateRoot: string;
	readonly artifactRoot: string;
	readonly privateRuntimeRoot: string;
	readonly ompHome: string;
	readonly cmuxSocketPath: string;
	readonly hostReadyPath: string;
	readonly generationAuthPath: string;
	readonly browserEnabled: boolean;
	readonly browserUrl: string;
	readonly cmuxExecutable: string;
}

export interface RuntimeReadinessDependencies {
	readonly validateControlledRoot: (path: string, writable: boolean) => Promise<void>;
	readonly identifyCmux: (config: RuntimeReadinessConfig) => Promise<Record<string, unknown>>;
	readonly readHostReady: (config: RuntimeReadinessConfig) => Promise<Record<string, unknown>>;
	readonly processAlive: (pid: number) => boolean;
	readonly readGenerationAuth: (path: string) => Promise<Buffer>;
	readonly browserReady: (url: string) => Promise<boolean>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function absolute(value: string, name: string): string {
	if (!isAbsolute(value) || resolve(value) !== value || value === "/") throw new Error(`${name} must be a canonical absolute path`);
	return value;
}

function exactBoolean(value: string | undefined, name: string): boolean {
	if (value === "true") return true;
	if (value === "false" || value === undefined) return false;
	throw new Error(`${name} must be true or false`);
}

export function runtimeReadinessConfigFromEnv(env: NodeJS.ProcessEnv): RuntimeReadinessConfig {
	const runtimeId = required(env, "T4_RUNTIME_ID");
	const generation = required(env, "T4_RUNTIME_GENERATION");
	const sessionName = required(env, "T4_SESSION_NAME");
	if (!/^runtime-[a-z0-9](?:[-a-z0-9]{0,53}[a-z0-9])?$/u.test(runtimeId)) throw new Error("T4_RUNTIME_ID is invalid");
	if (!/^gen_[A-Za-z0-9_-]{24}$/u.test(generation)) throw new Error("T4_RUNTIME_GENERATION is invalid");
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u.test(sessionName)) throw new Error("T4_SESSION_NAME is invalid");
	const stateRoot = absolute(required(env, "T4_SESSION_STATE_ROOT"), "T4_SESSION_STATE_ROOT");
	const workspaceRoot = absolute(required(env, "T4_WORKSPACE_ROOT"), "T4_WORKSPACE_ROOT");
	const hostRuntimeRoot = absolute(required(env, "T4_HOST_RUNTIME_DIR"), "T4_HOST_RUNTIME_DIR");
	const config: RuntimeReadinessConfig = {
		runtimeId,
		generation,
		sessionName,
		stateRoot,
		workspaceRoot,
		hostRuntimeRoot,
		cmuxStateRoot: absolute(required(env, "T4_CMUX_STATE_DIR"), "T4_CMUX_STATE_DIR"),
		browserStateRoot: absolute(required(env, "T4_BROWSER_STATE_DIR"), "T4_BROWSER_STATE_DIR"),
		authorityStateRoot: absolute(env.T4_AUTHORITY_STATE_DIR ?? join(stateRoot, "authority"), "T4_AUTHORITY_STATE_DIR"),
		artifactRoot: absolute(env.T4_ARTIFACT_ROOT ?? join(stateRoot, "artifacts"), "T4_ARTIFACT_ROOT"),
		privateRuntimeRoot: absolute(env.T4_PRIVATE_RUNTIME_DIR ?? join(stateRoot, "private"), "T4_PRIVATE_RUNTIME_DIR"),
		ompHome: absolute(env.T4_OMP_HOME ?? join(stateRoot, "home"), "T4_OMP_HOME"),
		cmuxSocketPath: absolute(required(env, "T4_CMUX_SOCKET_PATH"), "T4_CMUX_SOCKET_PATH"),
		hostReadyPath: absolute(required(env, "T4_SESSION_HOST_READY_PATH"), "T4_SESSION_HOST_READY_PATH"),
		generationAuthPath: absolute(env.T4_GENERATION_AUTH_PATH ?? "/run/t4-generation-auth/key", "T4_GENERATION_AUTH_PATH"),
		browserEnabled: exactBoolean(env.T4_GUI_ENABLED, "T4_GUI_ENABLED"),
		browserUrl: env.T4_BROWSER_READY_URL ?? "http://127.0.0.1:9222/json/version",
		cmuxExecutable: absolute(env.T4_CMUX_EXECUTABLE ?? "/usr/local/bin/cmux-tui", "T4_CMUX_EXECUTABLE"),
	};
	const exactPaths: ReadonlyArray<readonly [string, string]> = [
		[config.stateRoot, `/runtime-state/${runtimeId}`],
		[config.workspaceRoot, "/workspace"],
		[config.hostRuntimeRoot, `/run/t4/${runtimeId}`],
		[config.cmuxStateRoot, join(config.stateRoot, "cmux")],
		[config.browserStateRoot, join(config.stateRoot, "browser")],
		[config.authorityStateRoot, join(config.stateRoot, "authority")],
		[config.artifactRoot, join(config.stateRoot, "artifacts")],
		[config.privateRuntimeRoot, join(config.stateRoot, "private")],
		[config.ompHome, join(config.stateRoot, "home")],
		[config.cmuxSocketPath, join(config.hostRuntimeRoot, "c.sock")],
		[config.hostReadyPath, join(config.hostRuntimeRoot, "host.ready")],
	];
	for (const [actual, expected] of exactPaths) if (actual !== expected) throw new Error(`controlled runtime path ${actual} does not match ${expected}`);
	if (config.browserUrl !== "http://127.0.0.1:9222/json/version") throw new Error("T4_BROWSER_READY_URL must remain loopback-only");
	return config;
}

export async function validateControlledRoot(
	path: string,
	writable: boolean,
	openProbe: (path: string, flags: number, mode: number) => ReturnType<typeof open> = open,
): Promise<void> {
	let current = "/";
	for (const component of path.split("/").filter(Boolean)) {
		current = join(current, component);
		const stat = await lstat(current);
		if (stat.isSymbolicLink()) throw new Error(`controlled root contains a symlink: ${path}`);
	}
	const stat = await lstat(path);
	if (!stat.isDirectory()) throw new Error(`controlled root is not a directory: ${path}`);
	if (await realpath(path) !== path) throw new Error(`controlled root escapes its canonical path: ${path}`);
	await access(path, fsConstants.R_OK | fsConstants.X_OK);
	if (!writable) return;
	const probePath = join(path, `.t4-write-probe-${process.pid}-${randomUUID()}`);
	let probe: Awaited<ReturnType<typeof open>> | undefined;
	try {
		probe = await openProbe(
			probePath,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
			0o600,
		);
		await probe.write(Buffer.from([0x54]));
		await probe.sync();
	} finally {
		if (probe) {
			try { await probe.close(); }
			finally { await unlink(probePath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
		}
	}
}

async function identifyCmux(config: RuntimeReadinessConfig): Promise<Record<string, unknown>> {
	const { stdout } = await execute(config.cmuxExecutable, ["identify", "--socket", config.cmuxSocketPath, "--json"], {
		cwd: config.workspaceRoot,
		timeout: 1_000,
		maxBuffer: MAX_IDENTITY_BYTES,
		encoding: "utf8",
	});
	if (Buffer.byteLength(stdout) > MAX_IDENTITY_BYTES) throw new Error("cmux identity exceeds its bound");
	return JSON.parse(stdout) as Record<string, unknown>;
}

async function readHostReady(config: RuntimeReadinessConfig): Promise<Record<string, unknown>> {
	const stat = await lstat(config.hostReadyPath);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_READY_BYTES) throw new Error("host.ready is not a bounded regular file");
	return JSON.parse(await readFile(config.hostReadyPath, "utf8")) as Record<string, unknown>;
}

function processAlive(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid < 1) return false;
	try { process.kill(pid, 0); return true; }
	catch { return false; }
}

async function browserReady(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS), redirect: "error" });
		if (!response.ok) return false;
		const body = await response.json() as Record<string, unknown>;
		return typeof body.Browser === "string" && typeof body.webSocketDebuggerUrl === "string" &&
			/^ws:\/\/(?:127\.0\.0\.1|localhost):9222\//u.test(body.webSocketDebuggerUrl);
	} catch { return false; }
}

export const runtimeReadinessDependencies: RuntimeReadinessDependencies = {
	validateControlledRoot,
	identifyCmux,
	readHostReady,
	processAlive,
	readGenerationAuth: path => readFile(path),
	browserReady,
};

function exactKeys(record: Record<string, unknown>, keys: readonly string[], name: string): void {
	if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error(`${name} has an unexpected schema`);
}

function authenticateHostReady(config: RuntimeReadinessConfig, ready: Record<string, unknown>, auth: Buffer, processIsAlive: (pid: number) => boolean): void {
	exactKeys(ready, ["generation", "generationAuthSha256", "pid", "schemaVersion"], "host.ready");
	if (ready.schemaVersion !== 1 || ready.generation !== config.generation) throw new Error("host.ready is from a stale runtime generation");
	if (typeof ready.pid !== "number" || !processIsAlive(ready.pid)) throw new Error("host.ready PID is not a current process");
	if (auth.length !== 32) throw new Error("generation authentication key is invalid");
	const expected = createHash("sha256").update(auth).digest();
	if (typeof ready.generationAuthSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(ready.generationAuthSha256)) throw new Error("host.ready generation authentication is invalid");
	const actual = Buffer.from(ready.generationAuthSha256, "hex");
	if (!timingSafeEqual(actual, expected)) throw new Error("host.ready generation authentication does not match the mounted key");
}

export async function probeSessionRuntime(
	kind: RuntimeProbeKind,
	config: RuntimeReadinessConfig,
	dependencies: RuntimeReadinessDependencies = runtimeReadinessDependencies,
	component: "composite" | "shell" = "composite",
): Promise<void> {
	if (component === "composite") {
		const auth = await dependencies.readGenerationAuth(config.generationAuthPath);
		const ready = await dependencies.readHostReady(config);
		authenticateHostReady(config, ready, auth, dependencies.processAlive);
	}
	const identity = await dependencies.identifyCmux(config);
	exactKeys(identity, CMUX_IDENTITY_KEYS, "cmux identify");
	if (identity.protocol !== CMUX_PROTOCOL_VERSION) throw new Error("cmux identify protocol is not version 10");
	if (identity.app !== "cmux-tui" || identity.build_commit !== CMUX_SOURCE_COMMIT) throw new Error("cmux identify build identity does not match the pinned runtime");
	if (identity.session !== config.sessionName) throw new Error("cmux identify session does not match the controlled runtime");
	if (typeof identity.pid !== "number" || !dependencies.processAlive(identity.pid)) throw new Error("cmux identify PID is not a current process");
	if (!Array.isArray(identity.capabilities) || identity.capabilities.length !== CMUX_CAPABILITIES.length ||
		identity.capabilities.some((value, index) => typeof value !== "string" || value !== CMUX_CAPABILITIES[index]))
		throw new Error("cmux provider-managed workspace capability set is invalid");
	if (config.browserEnabled && !await dependencies.browserReady(config.browserUrl)) throw new Error("profile-required browser is unavailable");
	if (kind === "liveness") return;
	const controlledRoots = component === "shell"
		? [config.stateRoot, config.cmuxStateRoot, config.browserStateRoot, config.hostRuntimeRoot]
		: [config.stateRoot, config.cmuxStateRoot, config.browserStateRoot, config.authorityStateRoot, config.artifactRoot, config.privateRuntimeRoot, config.ompHome, config.hostRuntimeRoot];
	for (const root of controlledRoots) {
		await dependencies.validateControlledRoot(root, true);
	}
	await dependencies.validateControlledRoot(config.workspaceRoot, true);
}

async function main(): Promise<void> {
	const kind = process.argv[2];
	if (kind !== "startup" && kind !== "readiness" && kind !== "liveness") throw new Error("probe kind must be startup, readiness, or liveness");
	const component = process.argv[3];
	if (component !== undefined && component !== "shell") throw new Error("probe component must be shell");
	await probeSessionRuntime(kind, runtimeReadinessConfigFromEnv(process.env), runtimeReadinessDependencies, component ?? "composite");
}

if (import.meta.main) {
	try { await main(); }
	catch (error) {
		process.stderr.write(`${JSON.stringify({ component: "session-runtime-readiness", result: "not-ready", message: error instanceof Error ? error.message : "probe failed" })}\n`);
		process.exitCode = 1;
	}
}
