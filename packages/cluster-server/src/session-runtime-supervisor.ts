#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server as NetServer } from "node:net";
import { chmod, lstat, unlink } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { isAbsolute, join } from "node:path";
import { CMUX_PROTOCOL_VERSION, verifyCmuxBinary } from "../../cmux-runtime/src/index.ts";

const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 5_000;
const FAILURE_EXIT_CODE = 70;

export interface ComponentCommand {
	readonly executable: string;
	readonly argv: readonly string[];
}

export interface SessionRuntimeSupervisorConfig {
	readonly display: string;
	readonly displaySocketPath: string;
	readonly runtimeId: string;
	readonly generation: string;
	readonly sessionName: string;
	readonly stateRoot: string;
	readonly workspaceRoot: string;
	readonly sessionHostReadyPath: string;
	readonly cmuxStateDirectory: string;
	readonly cmuxSocketPath: string;
	readonly controlSocketPath: string;
	readonly browserStateDirectory: string;
	readonly browserEnabled: boolean;
	readonly startupTimeoutMs: number;
	readonly shutdownGraceMs: number;
	readonly xvfb: ComponentCommand;
	readonly fluxbox: ComponentCommand;
	readonly cmux: ComponentCommand;
	readonly cmuxManifestPath: string;
	readonly chromium: ComponentCommand;
}

export interface SupervisorDependencies {
	readonly verifyCmuxBinary: typeof verifyCmuxBinary;
}

interface ChildExit {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly error?: Error;
}

interface SupervisedChild {
	readonly name: "xvfb" | "fluxbox" | "cmux" | "chromium";
	readonly process: ChildProcess;
	readonly exited: Promise<ChildExit>;
	settled: boolean;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function exactBoolean(value: string | undefined, name: string): boolean {
	if (value === undefined || value === "false") return false;
	if (value === "true") return true;
	throw new Error(`${name} must be true or false`);
}

function boundedMilliseconds(value: string | undefined, fallback: number, name: string): number {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 30_000)
		throw new Error(`${name} must be an integer from 100 through 30000`);
	return parsed;
}

function absolute(value: string, name: string): string {
	if (!isAbsolute(value)) throw new Error(`${name} must be absolute`);
	return value;
}

export function sessionRuntimeSupervisorConfigFromEnv(env: NodeJS.ProcessEnv): SessionRuntimeSupervisorConfig {
	const runtimeId = required(env, "T4_RUNTIME_ID");
	const sessionStateId = required(env, "T4_SESSION_STATE_ID");
	const generation = required(env, "T4_RUNTIME_GENERATION");
	const sessionName = required(env, "T4_SESSION_NAME");
	const stateRoot = absolute(required(env, "T4_SESSION_STATE_ROOT"), "T4_SESSION_STATE_ROOT");
	const hostRuntimeDirectory = absolute(required(env, "T4_HOST_RUNTIME_DIR"), "T4_HOST_RUNTIME_DIR");
	const cmuxStateDirectory = absolute(required(env, "T4_CMUX_STATE_DIR"), "T4_CMUX_STATE_DIR");
	const cmuxSocketPath = absolute(required(env, "T4_CMUX_SOCKET_PATH"), "T4_CMUX_SOCKET_PATH");
	const controlSocketPath = join(hostRuntimeDirectory, "supervisor.sock");
	const browserStateDirectory = absolute(required(env, "T4_BROWSER_STATE_DIR"), "T4_BROWSER_STATE_DIR");
	const workspaceRoot = absolute(required(env, "T4_WORKSPACE_ROOT"), "T4_WORKSPACE_ROOT");
	const sessionHostReadyPath = absolute(required(env, "T4_SESSION_HOST_READY_PATH"), "T4_SESSION_HOST_READY_PATH");
	if (!/^runtime-[a-z0-9](?:[-a-z0-9]{0,53}[a-z0-9])?$/u.test(runtimeId)) throw new Error("T4_RUNTIME_ID is invalid");
	if (!/^gen_[A-Za-z0-9_-]{24}$/u.test(generation)) throw new Error("T4_RUNTIME_GENERATION is invalid");
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/u.test(sessionName)) throw new Error("T4_SESSION_NAME is invalid");
	if (sessionStateId !== runtimeId) throw new Error("T4_SESSION_STATE_ID does not match T4_RUNTIME_ID");
	if (stateRoot !== `/runtime-state/${runtimeId}`) throw new Error("T4_SESSION_STATE_ROOT does not match T4_RUNTIME_ID");
	if (hostRuntimeDirectory !== `/run/t4/${runtimeId}`) throw new Error("T4_HOST_RUNTIME_DIR does not match T4_RUNTIME_ID");
	if (workspaceRoot !== "/workspace") throw new Error("T4_WORKSPACE_ROOT must be the projected workspace root");
	if (env.T4_CMUX_SOCKET_MODE !== "0660") throw new Error("T4_CMUX_SOCKET_MODE must be 0660");
	if (cmuxStateDirectory !== join(stateRoot, "cmux")) throw new Error("T4_CMUX_STATE_DIR does not match the projected state root");
	if (browserStateDirectory !== join(stateRoot, "browser")) throw new Error("T4_BROWSER_STATE_DIR does not match the projected state root");
	if (cmuxSocketPath !== join(hostRuntimeDirectory, "cmux", "c.sock")) throw new Error("T4_CMUX_SOCKET_PATH does not match the projected runtime root");
	if (controlSocketPath.length > 100) throw new Error("supervisor control socket path is too long");
	if (sessionHostReadyPath !== join(hostRuntimeDirectory, "host.ready")) throw new Error("T4_SESSION_HOST_READY_PATH does not match the projected runtime root");
	if (env.T4_GENERATION_AUTH_PATH !== undefined) throw new Error("shell supervisor must not receive generation authentication credentials");
	if (env.CMUX_STATE_DIR !== cmuxStateDirectory || env.CMUX_SOCKET_PATH !== cmuxSocketPath || env.CMUX_SESSION !== sessionName)
		throw new Error("cmux projected environment identity is inconsistent");
	const display = env.DISPLAY ?? ":99";
	const displayMatch = /^:([0-9]{1,3})$/u.exec(display);
	if (!displayMatch) throw new Error("DISPLAY is invalid");
	return {
		display,
		displaySocketPath: `/tmp/.X11-unix/X${displayMatch[1]}`,
		runtimeId,
		generation,
		sessionName,
		stateRoot,
		workspaceRoot,
		sessionHostReadyPath,
		cmuxStateDirectory,
		cmuxSocketPath,
		browserStateDirectory,
		controlSocketPath,
		browserEnabled: exactBoolean(env.T4_GUI_ENABLED, "T4_GUI_ENABLED"),
		startupTimeoutMs: boundedMilliseconds(env.T4_SUPERVISOR_STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS, "T4_SUPERVISOR_STARTUP_TIMEOUT_MS"),
		shutdownGraceMs: boundedMilliseconds(env.T4_SUPERVISOR_SHUTDOWN_GRACE_MS, SHUTDOWN_GRACE_MS, "T4_SUPERVISOR_SHUTDOWN_GRACE_MS"),
		xvfb: { executable: "/usr/bin/Xvfb", argv: [display, "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-ac"] },
		fluxbox: { executable: "/usr/bin/fluxbox", argv: ["-display", display] },
		cmux: {
			executable: "/usr/local/bin/cmux-tui",
			argv: ["--headless", "--session", sessionName, "--socket", cmuxSocketPath, "--state", cmuxStateDirectory],
		},
		cmuxManifestPath: "/usr/share/t4/provenance/cmux-tui.manifest.json",
		chromium: {
			executable: "/usr/bin/chromium",
			argv: [
				"--disable-setuid-sandbox", "--disable-background-networking", "--disable-breakpad",
				"--disable-component-update", "--disable-default-apps", "--disable-sync", "--metrics-recording-only",
				"--no-first-run", "--password-store=basic", "--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=9222", `--user-data-dir=${browserStateDirectory}`, "about:blank",
			],
		},
	};
}

function exitStatus(exit: ChildExit): number {
	if (exit.error) return FAILURE_EXIT_CODE;
	if (exit.code !== null) return exit.code === 0 ? FAILURE_EXIT_CODE : exit.code;
	const signalNumber = exit.signal === null ? undefined : osConstants.signals[exit.signal];
	return 128 + (signalNumber ?? 15);
}


function processGroupSignal(child: SupervisedChild, signal: NodeJS.Signals): void {
	if (child.process.pid === undefined) return;
	try { process.kill(-child.process.pid, signal); }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

function processGroupExists(child: SupervisedChild): boolean {
	if (child.process.pid === undefined) return false;
	try {
		process.kill(-child.process.pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

async function waitForProcessGroups(children: readonly SupervisedChild[], timeoutMs?: number): Promise<boolean> {
	const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
	while (children.some(processGroupExists)) {
		if (deadline !== undefined && Date.now() >= deadline) return false;
		await delay(25);
	}
	return true;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}


async function pathIsSocket(path: string): Promise<boolean> {
	return lstat(path).then(stat => stat.isSocket(), error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	});
}

async function pathExists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	});
}

async function waitForSocket(path: string, child: SupervisedChild, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		if (child.settled) throw new Error(`${child.name} exited during startup`);
		if (await pathIsSocket(path)) return;
		await delay(25);
	}
	throw new Error(`${child.name} did not create its socket before the startup timeout`);
}

async function identifyCmux(
	config: SessionRuntimeSupervisorConfig,
	child: SupervisedChild,
	deadline: number,
	shutdownRequested: Promise<void>,
	isShuttingDown: () => boolean,
): Promise<void> {
	while (Date.now() < deadline) {
		if (isShuttingDown() || child.settled) throw new Error("cmux exited during identity verification");
		const probe = spawn(config.cmux.executable, ["identify", "--socket", config.cmuxSocketPath, "--json"], {
			cwd: config.workspaceRoot,
			env: {
				PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
				HOME: process.env.HOME ?? "/run/t4",
				CMUX_STATE_DIR: config.cmuxStateDirectory,
				CMUX_SOCKET_PATH: config.cmuxSocketPath,
				CMUX_SOCKET_MODE: "0660",
				CMUX_SESSION: config.sessionName,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		const capture = (target: Buffer[], value: Buffer): void => {
			outputBytes += value.length;
			if (outputBytes > 16 * 1024) probe.kill("SIGKILL");
			else target.push(value);
		};
		probe.stdout!.on("data", (value: Buffer) => capture(stdout, value));
		probe.stderr!.on("data", (value: Buffer) => capture(stderr, value));
		const killProbe = (): void => { if (probe.exitCode === null && probe.signalCode === null) probe.kill("SIGKILL"); };
		const timeout = setTimeout(killProbe, Math.min(1_000, Math.max(1, deadline - Date.now())));
		void child.exited.then(killProbe);
		void shutdownRequested.then(killProbe);
		const result = await new Promise<ChildExit>(resolve => {
			let settled = false;
			const finish = (value: ChildExit): void => { if (!settled) { settled = true; resolve(value); } };
			probe.once("error", error => finish({ code: null, signal: null, error }));
			probe.once("close", (code, signal) => finish({ code, signal }));
		}).finally(() => clearTimeout(timeout));
		if (isShuttingDown() || child.settled) throw new Error("cmux exited during identity verification");
		if (outputBytes > 16 * 1024) throw new Error("cmux identity probe exceeded its output bound");
		const text = Buffer.concat(stdout).toString("utf8").trim();
		if (!result.error && result.code === 0 && text.length > 0) {
			let identity: Record<string, unknown> | undefined;
			try { identity = JSON.parse(text) as Record<string, unknown>; }
			catch { /* transient partial response; retry until the shared deadline */ }
			if (identity) {
				if (identity.protocol !== CMUX_PROTOCOL_VERSION) throw new Error("cmux identity protocol does not match version 10");
				if (identity.pid !== child.process.pid) throw new Error("cmux identity PID does not match the supervised process");
				return;
			}
		}
		await delay(25);
	}
	throw new Error("cmux identity did not become available before the startup timeout");
}


export async function runSessionRuntimeSupervisor(
	config: SessionRuntimeSupervisorConfig,
	dependencies: SupervisorDependencies = { verifyCmuxBinary },
): Promise<number> {
	const children: SupervisedChild[] = [];
	let shuttingDown = false;
	let firstStatus: number | undefined;
	let shutdownPromise: Promise<void> | undefined;
	let controlServer: NetServer | undefined;
	let expectedCmuxExit = false;
	const shutdownRequested = Promise.withResolvers<void>();
	const setFirstStatus = (status: number): void => { firstStatus ??= status; };
	const stopAll = (): Promise<void> => {
		shutdownPromise ??= (async () => {
			shuttingDown = true;
			shutdownRequested.resolve();
			for (const child of children) processGroupSignal(child, "SIGTERM");
			const directChildren = Promise.all(children.map(child => child.exited));
			if (!await waitForProcessGroups(children, config.shutdownGraceMs)) {
				for (const child of children) processGroupSignal(child, "SIGKILL");
				await waitForProcessGroups(children);
			}
			await directChildren;
		})();
		return shutdownPromise;
	};
	const fail = (status: number): void => { setFirstStatus(status); void stopAll(); };
	const start = (name: SupervisedChild["name"], command: ComponentCommand): SupervisedChild => {
		if (shuttingDown) throw new Error(`cannot start ${name} after shutdown began`);
		if (!isAbsolute(command.executable)) throw new Error(`${name} executable must be absolute`);
		const childEnvironment: NodeJS.ProcessEnv = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: process.env.HOME ?? "/run/t4",
			XDG_RUNTIME_DIR: `/run/t4/${config.runtimeId}`,
			DISPLAY: config.display,
			CMUX_STATE_DIR: config.cmuxStateDirectory,
			CMUX_SOCKET_PATH: config.cmuxSocketPath,
			CMUX_SOCKET_MODE: "0660",
			CMUX_SESSION: config.sessionName,
			T4_RUNTIME_ID: config.runtimeId,
			T4_RUNTIME_GENERATION: config.generation,
			T4_SESSION_NAME: config.sessionName,
			T4_HOST_RUNTIME_DIR: `/run/t4/${config.runtimeId}`,
			T4_WORKSPACE_ROOT: config.workspaceRoot,
			...(name === "cmux" && config.browserEnabled ? { CMUX_MUX_CDP_URL: "http://127.0.0.1:9222" } : {}),
		};
		const processHandle = spawn(command.executable, [...command.argv], {
			cwd: config.workspaceRoot,
			detached: true,
			env: childEnvironment,
			stdio: ["ignore", "inherit", "inherit"],
		});
		let child!: SupervisedChild;
		const exited = new Promise<ChildExit>(resolve => {
			let resolved = false;
			const finish = (value: ChildExit): void => {
				if (resolved) return;
				resolved = true;
				child.settled = true;
				resolve(value);
				if (!shuttingDown && !(name === "cmux" && expectedCmuxExit)) fail(exitStatus(value));
			};
			processHandle.once("error", error => finish({ code: null, signal: null, error }));
			processHandle.once("close", (code, signal) => finish({ code, signal }));
		});
		child = { name, process: processHandle, exited, settled: false };
		children.push(child);
		return child;
	};
	const onTerm = (): void => { setFirstStatus(143); void stopAll(); };
	const onInt = (): void => { setFirstStatus(130); void stopAll(); };
	process.on("SIGTERM", onTerm);
	process.on("SIGINT", onInt);
	try {
		if (await pathExists(config.displaySocketPath)) throw new Error("X display socket already exists");
		await dependencies.verifyCmuxBinary(config.cmux.executable, config.cmuxManifestPath);
		if (await pathExists(config.cmuxSocketPath)) throw new Error("cmux socket already exists");
		const startupDeadline = Date.now() + config.startupTimeoutMs;
		const xvfb = start("xvfb", config.xvfb);
		await waitForSocket(config.displaySocketPath, xvfb, startupDeadline);
		start("fluxbox", config.fluxbox);
		const cmux = start("cmux", config.cmux);
		await waitForSocket(config.cmuxSocketPath, cmux, startupDeadline);
		if (shuttingDown) throw new Error("cmux exited during startup");
		await identifyCmux(config, cmux, startupDeadline, shutdownRequested.promise, () => shuttingDown);
		if (shuttingDown) throw new Error("cmux exited during identity verification");
		if (!await pathExists(config.sessionHostReadyPath)) throw new Error("session-host readiness is unavailable");
		await unlink(config.controlSocketPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
		let quiescePromise: Promise<void> | undefined;
		const quiesceCmux = (): Promise<void> => {
			quiescePromise ??= (async () => {
				expectedCmuxExit = true;
				processGroupSignal(cmux, "SIGTERM");
				const exited = await cmux.exited;
				if (exited.error || exited.code !== 0 && exited.signal !== "SIGTERM")
					throw new Error("cmux did not acknowledge orderly quiesce");
				if (!await waitForProcessGroups([cmux], config.shutdownGraceMs))
					throw new Error("cmux process group did not quiesce before the deadline");
			})();
			return quiescePromise;
		};
		controlServer = createServer(socket => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			let handled = false;
			socket.on("data", (chunk: Buffer) => {
				if (handled) return;
				bytes += chunk.length;
				if (bytes > 1_024) {
					socket.destroy(new Error("supervisor request exceeds size bound"));
					return;
				}
				chunks.push(chunk);
				const input = Buffer.concat(chunks).toString("utf8");
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				handled = true;
				void (async () => {
					if (input.slice(newline + 1).trim() !== "") throw new Error("supervisor request contains trailing data");
					let request: Record<string, unknown>;
					try { request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>; }
					catch { throw new Error("supervisor request is invalid"); }
					if (Object.keys(request).sort().join(",") !== "command,generation,v" || request.v !== 1 ||
						request.command !== "quiesce" || request.generation !== config.generation)
						throw new Error("supervisor request identity mismatch");
					await quiesceCmux();
					socket.end(`${JSON.stringify({ v: 1, ok: true, generation: config.generation })}\n`);
				})().catch(error => {
					socket.end(`${JSON.stringify({ v: 1, ok: false, error: error instanceof Error ? error.message : "quiesce failed" })}\n`);
				});
			});
		});
		await new Promise<void>((resolve, reject) => {
			controlServer!.once("error", reject);
			controlServer!.listen(config.controlSocketPath, () => {
				controlServer!.off("error", reject);
				resolve();
			});
		});
		await chmod(config.controlSocketPath, 0o660);
		if (config.browserEnabled) start("chromium", config.chromium);
		if (shuttingDown) throw new Error("a component exited during startup");
		await shutdownRequested.promise;
	} catch (error) {
		setFirstStatus(FAILURE_EXIT_CODE);
		process.stderr.write(`${JSON.stringify({ component: "session-runtime-supervisor", result: "failed", message: error instanceof Error ? error.message : "startup failed" })}\n`);
	} finally {
		const controlClosed = controlServer
			? new Promise<void>(resolve => controlServer!.close(() => resolve()))
			: Promise.resolve();
		await stopAll();
		await controlClosed;
		await unlink(config.controlSocketPath).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		});
		process.off("SIGTERM", onTerm);
		process.off("SIGINT", onInt);
	}
	return firstStatus ?? FAILURE_EXIT_CODE;
}

async function main(): Promise<void> {
	try { process.exitCode = await runSessionRuntimeSupervisor(sessionRuntimeSupervisorConfigFromEnv(process.env)); }
	catch (error) {
		process.stderr.write(`${JSON.stringify({ component: "session-runtime-supervisor", result: "invalid_configuration", message: error instanceof Error ? error.message : "invalid configuration" })}\n`);
		process.exitCode = 64;
	}
}

if (import.meta.main) await main();
