import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { CMUX_SOURCE_COMMIT } from "../../cmux-runtime/src/index.ts";
import {
	probeSessionRuntime,
	runtimeReadinessConfigFromEnv,
	runtimeReadinessDependencies,
	validateControlledRoot,
	type RuntimeReadinessConfig,
	type RuntimeReadinessDependencies,
} from "../src/session-runtime-readiness.ts";

const AUTH = Buffer.alloc(32, 7);
const AUTH_SHA256 = createHash("sha256").update(AUTH).digest("hex");
const CMUX_IDENTITY = {
	app: "cmux-tui",
	build_commit: CMUX_SOURCE_COMMIT,
	capabilities: ["provider-managed-workspace-authority-v2"],
	pid: 42,
	protocol: 10,
	session: "fixture",
};
const CONFIG: RuntimeReadinessConfig = {
	runtimeId: "runtime-fixture",
	generation: "gen_abcdefghijklmnopqrstuvwx",
	sessionName: "fixture",
	stateRoot: "/runtime-state/runtime-fixture",
	workspaceRoot: "/workspace",
	hostRuntimeRoot: "/run/t4/runtime-fixture",
	cmuxStateRoot: "/runtime-state/runtime-fixture/cmux",
	browserStateRoot: "/runtime-state/runtime-fixture/browser",
	authorityStateRoot: "/runtime-state/runtime-fixture/authority",
	artifactRoot: "/runtime-state/runtime-fixture/artifacts",
	privateRuntimeRoot: "/runtime-state/runtime-fixture/private",
	ompHome: "/runtime-state/runtime-fixture/home",
	cmuxSocketPath: "/run/t4/runtime-fixture/c.sock",
	hostReadyPath: "/run/t4/runtime-fixture/host.ready",
	generationAuthPath: "/run/t4-generation-auth/key",
	browserEnabled: false,
	browserUrl: "http://127.0.0.1:9222/json/version",
	cmuxExecutable: "/usr/local/bin/cmux-tui",
};

function dependencies(overrides: Partial<RuntimeReadinessDependencies> = {}): RuntimeReadinessDependencies {
	return {
		validateControlledRoot: async () => undefined,
		identifyCmux: async () => CMUX_IDENTITY,
		readHostReady: async () => ({ generation: CONFIG.generation, generationAuthSha256: AUTH_SHA256, pid: 41, schemaVersion: 1 }),
		processAlive: pid => pid === 41 || pid === 42,
		readGenerationAuth: async () => AUTH,
		browserReady: async () => true,
		...overrides,
	};
}

describe("session runtime composite readiness", () => {
	test("is ready without any attached client or active turn", async () => {
		await expect(probeSessionRuntime("startup", CONFIG, dependencies())).resolves.toBeUndefined();
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies())).resolves.toBeUndefined();
	});
	test("shell probes never traverse authority-private roots or generation credentials", async () => {
		const validated: string[] = [];
		let generationReads = 0;
		await probeSessionRuntime("readiness", CONFIG, dependencies({
			validateControlledRoot: async path => { validated.push(path); },
			readGenerationAuth: async () => { generationReads += 1; return AUTH; },
		}), "shell");
		expect(generationReads).toBe(0);
		expect(validated).not.toContain(CONFIG.privateRuntimeRoot);
		expect(validated).not.toContain(CONFIG.authorityStateRoot);
		expect(validated).not.toContain(CONFIG.ompHome);
	});


	test("fails closed for every required component", async () => {
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ validateControlledRoot: async () => { throw new Error("not writable"); } }))).rejects.toThrow("not writable");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => ({ ...CMUX_IDENTITY, protocol: 9 }) }))).rejects.toThrow("version 10");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => ({ ...CMUX_IDENTITY, capabilities: [] }) }))).rejects.toThrow("provider-managed workspace capability");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => ({ ...CMUX_IDENTITY, session: "other" }) }))).rejects.toThrow("controlled runtime");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => ({ ...CMUX_IDENTITY, build_commit: "0".repeat(40) }) }))).rejects.toThrow("pinned runtime");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => { throw new Error("socket closed"); } }))).rejects.toThrow("socket closed");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ readHostReady: async () => { throw new Error("host closed"); } }))).rejects.toThrow("host closed");
	});
	test("requires the exact pinned cmux v10 identity schema and capability set", async () => {
		for (const identity of [
			{ ...CMUX_IDENTITY, unexpected: true },
			{ ...CMUX_IDENTITY, capabilities: [...CMUX_IDENTITY.capabilities, "unexpected"] },
			{ ...CMUX_IDENTITY, capabilities: [...CMUX_IDENTITY.capabilities, ...CMUX_IDENTITY.capabilities] },
			{ ...CMUX_IDENTITY, capabilities: [42] },
		]) {
			await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ identifyCmux: async () => identity }))).rejects.toThrow();
		}
	});


	test("rejects stale host generation, dead host and cmux PIDs, and wrong generation authentication", async () => {
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ readHostReady: async () => ({ generation: "gen_zyxwvutsrqponmlkjihgfedc", generationAuthSha256: AUTH_SHA256, pid: 41, schemaVersion: 1 }) }))).rejects.toThrow("stale runtime generation");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ processAlive: pid => pid === 42 }))).rejects.toThrow("host.ready PID");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ processAlive: pid => pid === 41 }))).rejects.toThrow("cmux identify PID");
		await expect(probeSessionRuntime("readiness", CONFIG, dependencies({ readGenerationAuth: async () => Buffer.alloc(32, 8) }))).rejects.toThrow("mounted key");
	});

	test("skips browser only for disabled profiles and requires it for enabled profiles", async () => {
		let browserChecks = 0;
		await probeSessionRuntime("readiness", CONFIG, dependencies({ browserReady: async () => { browserChecks += 1; return false; } }));
		expect(browserChecks).toBe(0);
		const enabled = { ...CONFIG, browserEnabled: true };
		await expect(probeSessionRuntime("readiness", enabled, dependencies({ browserReady: async () => false }))).rejects.toThrow("profile-required browser");
		await expect(probeSessionRuntime("readiness", enabled, dependencies())).resolves.toBeUndefined();
	});

	test("keeps liveness separate from writable-storage readiness", async () => {
		const probe = dependencies({ validateControlledRoot: async () => { throw new Error("storage unavailable"); } });
		await expect(probeSessionRuntime("liveness", CONFIG, probe)).resolves.toBeUndefined();
		await expect(probeSessionRuntime("readiness", CONFIG, probe)).rejects.toThrow("storage unavailable");
	});

	test("proves write and sync without leaving storage changes and rejects symlink components", async () => {
		const temporary = await realpath(await mkdtemp("/tmp/t4-readiness-"));
		try {
			const controlled = join(temporary, "controlled");
			await mkdir(controlled);
			const before = await readdir(controlled);
			await runtimeReadinessDependencies.validateControlledRoot(controlled, true);
			expect(await readdir(controlled)).toEqual(before);
			await expect(access(controlled, fsConstants.W_OK)).resolves.toBeNull();
			await expect(validateControlledRoot(controlled, true, async () => {
				throw Object.assign(new Error("read-only filesystem"), { code: "EROFS" });
			})).rejects.toMatchObject({ code: "EROFS" });
			expect(await readdir(controlled)).toEqual(before);
			const escaped = join(temporary, "escaped");
			await symlink(controlled, escaped);
			await expect(runtimeReadinessDependencies.validateControlledRoot(escaped, true)).rejects.toThrow("symlink");
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});
});

describe("readiness environment identity", () => {
	const env: NodeJS.ProcessEnv = {
		T4_RUNTIME_ID: CONFIG.runtimeId,
		T4_RUNTIME_GENERATION: CONFIG.generation,
		T4_SESSION_NAME: CONFIG.sessionName,
		T4_SESSION_STATE_ROOT: CONFIG.stateRoot,
		T4_WORKSPACE_ROOT: CONFIG.workspaceRoot,
		T4_HOST_RUNTIME_DIR: CONFIG.hostRuntimeRoot,
		T4_CMUX_STATE_DIR: CONFIG.cmuxStateRoot,
		T4_BROWSER_STATE_DIR: CONFIG.browserStateRoot,
		T4_AUTHORITY_STATE_DIR: CONFIG.authorityStateRoot,
		T4_ARTIFACT_ROOT: CONFIG.artifactRoot,
		T4_PRIVATE_RUNTIME_DIR: CONFIG.privateRuntimeRoot,
		T4_OMP_HOME: CONFIG.ompHome,
		T4_CMUX_SOCKET_PATH: CONFIG.cmuxSocketPath,
		T4_SESSION_HOST_READY_PATH: CONFIG.hostReadyPath,
		T4_GENERATION_AUTH_PATH: CONFIG.generationAuthPath,
		T4_GUI_ENABLED: "false",
	};

	test("accepts only the exact controlled root projection", () => {
		expect(runtimeReadinessConfigFromEnv(env)).toMatchObject(CONFIG);
		expect(() => runtimeReadinessConfigFromEnv({ ...env, T4_CMUX_STATE_DIR: "/runtime-state/runtime-fixture/../escaped" })).toThrow("canonical absolute path");
		expect(() => runtimeReadinessConfigFromEnv({ ...env, T4_SESSION_STATE_ROOT: "/runtime-state/other" })).toThrow("does not match");
		expect(() => runtimeReadinessConfigFromEnv({ ...env, T4_BROWSER_READY_URL: "http://0.0.0.0:9222/json/version" })).toThrow("loopback-only");
	});
});
