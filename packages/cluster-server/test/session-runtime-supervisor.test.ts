import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	runSessionRuntimeSupervisor,
	sessionRuntimeSupervisorConfigFromEnv,
	type ComponentCommand,
	type SessionRuntimeSupervisorConfig,
} from "../src/session-runtime-supervisor.ts";

const fixtureChild = fileURLToPath(new URL("./fixtures/session-runtime-child.ts", import.meta.url));
const roots: string[] = [];

interface RuntimeFixture { readonly root: string; readonly log: string; readonly config: SessionRuntimeSupervisorConfig }

function command(kind: string, log: string, socket = "", delay = -1, code = 0): ComponentCommand {
	return { executable: fixtureChild, argv: [kind, log, socket, String(delay), String(code), "false", "valid", "", ""] };
}

async function runtimeFixture(browserEnabled = false): Promise<RuntimeFixture> {
	const root = await mkdtemp("/tmp/t4-shell-supervisor-");
	roots.push(root);
	const workspaceRoot = join(root, "workspace");
	const stateRoot = join(root, "state");
	const cmuxStateDirectory = join(stateRoot, "cmux");
	const browserStateDirectory = join(stateRoot, "browser");
	const sessionHostReadyPath = join(root, "host.ready");
	await Promise.all([workspaceRoot, cmuxStateDirectory, browserStateDirectory].map(path => mkdir(path, { recursive: true })));
	await writeFile(sessionHostReadyPath, "ready\n");
	const log = join(root, "children.log");
	const displaySocketPath = join(root, "display.sock");
	const cmuxSocketPath = join(root, "cmux.sock");
	return {
		root,
		log,
		config: {
			display: ":99", displaySocketPath, runtimeId: "runtime-supervisor-test",
			generation: "gen_abcdefghijklmnopqrstuvwx", sessionName: "supervisor-test", stateRoot, workspaceRoot,
			sessionHostReadyPath, cmuxStateDirectory, cmuxSocketPath, controlSocketPath: join(root, "supervisor.sock"), browserStateDirectory, browserEnabled,
			startupTimeoutMs: 1_000, shutdownGraceMs: 100,
			xvfb: command("xvfb", log, displaySocketPath), fluxbox: command("fluxbox", log),
			cmux: command("cmux", log, cmuxSocketPath), cmuxManifestPath: join(root, "manifest.json"), chromium: command("chromium", log),
		},
	};
}

const dependencies = { verifyCmuxBinary: async () => ({}) as never };

async function childLog(path: string): Promise<string[]> {
	return (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
}

async function waitForStarted(path: string, kind: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if ((await childLog(path)).some(line => line.startsWith(`${kind}:started:`))) return;
		await Bun.sleep(10);
	}
	throw new Error(`${kind} did not start`);
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}


afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("session shell fail-closed supervisor", () => {
	for (const failing of ["xvfb", "fluxbox", "cmux", "chromium"] as const) {
		test(`a ${failing} exit tears down every shell component`, async () => {
			const value = await runtimeFixture(failing === "chromium");
			const socket = failing === "xvfb" ? value.config.displaySocketPath : failing === "cmux" ? value.config.cmuxSocketPath : "";
			const status = await runSessionRuntimeSupervisor({ ...value.config, [failing]: command(failing, value.log, socket, 250, 23) }, dependencies);
			expect(status).toBe(23);
			const log = await childLog(value.log);
			const started = log.filter(item => item.includes(":started:")).map(line => {
				const [kind, , pid] = line.split(":");
				return { kind, pid: Number(pid) };
			});
			expect(started.some(child => child.kind === failing)).toBe(true);
			for (const child of started) {
				if (child.kind !== failing) expect(log.some(item => item.startsWith(`${child.kind}:term:`))).toBe(true);
				expect(processExists(child.pid)).toBe(false);
			}
		});
	}

	test("signal shutdown stops cmux and GUI process groups without an authority child", async () => {
		const value = await runtimeFixture(true);
		const running = runSessionRuntimeSupervisor(value.config, dependencies);
		await waitForStarted(value.log, "chromium");
		process.emit("SIGTERM", "SIGTERM");
		expect(await running).toBe(143);
		const log = await childLog(value.log);
		expect(log.some(line => line.startsWith("session-host:started:"))).toBe(false);
		for (const kind of ["xvfb", "fluxbox", "cmux", "chromium"]) expect(log.some(line => line.startsWith(`${kind}:term:`))).toBe(true);
	});

	test("publishes the loopback CDP endpoint only to enabled cmux", async () => {
		for (const browserEnabled of [false, true]) {
			const value = await runtimeFixture(browserEnabled);
			const running = runSessionRuntimeSupervisor(value.config, dependencies);
			await waitForStarted(value.log, "cmux");
			process.emit("SIGTERM", "SIGTERM");
			expect(await running).toBe(143);
			const log = await childLog(value.log);
			expect(log.some(line => line.startsWith(`cmux:cdp=${browserEnabled ? "http://127.0.0.1:9222" : "absent"}:`))).toBe(true);
		}
	});


	test("configuration rejects authority credentials in the shell environment", () => {
		const env: NodeJS.ProcessEnv = {
			T4_RUNTIME_ID: "runtime-config-test", T4_SESSION_STATE_ID: "runtime-config-test",
			T4_RUNTIME_GENERATION: "gen_abcdefghijklmnopqrstuvwx", T4_SESSION_NAME: "config-test",
			T4_SESSION_STATE_ROOT: "/runtime-state/runtime-config-test", T4_HOST_RUNTIME_DIR: "/run/t4/runtime-config-test",
			T4_CMUX_STATE_DIR: "/runtime-state/runtime-config-test/cmux", T4_CMUX_SOCKET_PATH: "/run/t4/runtime-config-test/c.sock",
			T4_BROWSER_STATE_DIR: "/runtime-state/runtime-config-test/browser", T4_WORKSPACE_ROOT: "/workspace",
			T4_CMUX_SOCKET_MODE: "0600", CMUX_STATE_DIR: "/runtime-state/runtime-config-test/cmux",
			CMUX_SOCKET_PATH: "/run/t4/runtime-config-test/c.sock", CMUX_SESSION: "config-test",
			T4_SESSION_HOST_READY_PATH: "/run/t4/runtime-config-test/host.ready",
		};
		expect(sessionRuntimeSupervisorConfigFromEnv(env).browserEnabled).toBe(false);
		expect(() => sessionRuntimeSupervisorConfigFromEnv({ ...env, T4_GENERATION_AUTH_PATH: "/run/t4-generation-auth/key" })).toThrow("must not receive");
		expect(() => sessionRuntimeSupervisorConfigFromEnv({ ...env, T4_GUI_ENABLED: "1" })).toThrow("true or false");
	});
});
