#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ResultFrame, ServerFrame } from "@t4-code/protocol";
import { OfficialOmpProfileAuthority, profileSocketPath } from "@t4-code/host-service";
import { startDeterministicModel, verifyRuntime } from "../../host-service/bin/official-omp-gate0.ts";
import { RawUdsWebSocket } from "../../host-service/test/raw-uds-client.ts";

const TIMEOUT_MS = 15_000;

function stringField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object" || !(key in value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	if (!value || typeof value !== "object" || !(key in value)) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "number" ? field : undefined;
}

/** The host only merges terminal commands into the catalog when the feature and all three capabilities are live. */
function catalogAdvertises(result: unknown, command: string): boolean {
	if (!result || typeof result !== "object" || !("items" in result)) return false;
	const items = (result as { items: unknown }).items;
	return Array.isArray(items) && items.some(item => stringField(item, "name") === command);
}

async function next(client: RawUdsWebSocket): Promise<ServerFrame> {
	return Promise.race([
		client.nextServer(),
		Bun.sleep(TIMEOUT_MS).then(() => {
			throw new Error("packaged T4 host frame timeout");
		}),
	]);
}

/**
 * Resolves a command, approving any confirmation challenge on the way.
 * `term.open` is declared `confirmation: "challenge"`, so a client that only
 * waits for a response frame hangs forever. A direct authority call cannot
 * surface that: it is purely a wire contract.
 */
async function responseFor(client: RawUdsWebSocket, requestId: string): Promise<ResultFrame> {
	for (;;) {
		const frame = await next(client);
		if (frame.type === "response" && frame.requestId === requestId) return frame;
		if (frame.type === "confirmation") {
			client.sendJson({
				v: "omp-app/1",
				type: "confirm",
				requestId,
				confirmationId: frame.confirmationId,
				commandId: frame.commandId,
				hostId: frame.hostId,
				...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
				decision: "approve",
			});
			continue;
		}
		// A rejected command answers with an error frame, not a response. Without
		// this the loop would spin to a bare timeout and hide the reason.
		if (frame.type === "error")
			throw new Error(`host rejected ${requestId}: ${stringField(frame, "code")} ${stringField(frame, "message")}`);
	}
}

async function waitForSocket(path: string, child: Bun.Subprocess): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			if ((await stat(path)).isSocket()) return;
		} catch {}
		const exited = await Promise.race([child.exited.then(code => ({ code })), Bun.sleep(25).then(() => undefined)]);
		if (exited) throw new Error(`packaged T4 host exited before its socket was ready (${exited.code})`);
	}
	throw new Error("packaged T4 host socket timeout");
}

async function main(): Promise<void> {
	const repoRoot = resolve(import.meta.dirname, "../../..");
	const runtime = await verifyRuntime(repoRoot);
	const hostPath = join(repoRoot, "packages", "host-daemon", "dist", "t4-host");
	if (!(await stat(hostPath)).isFile()) throw new Error("build the packaged t4-host before running the proof");
	const root = await mkdtemp(join(tmpdir(), "t4-official-packaged-host-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const sessionsRoot = join(root, "sessions");
	const stateRoot = join(root, "state");
	const runtimeRoot = join(root, "run");
	const profile = `gate0-${Bun.randomUUIDv7().slice(-12)}`;
	const agentDir = join(home, ".omp", "profiles", profile, "agent");
	const model = startDeterministicModel();
	let child: Bun.Subprocess | undefined;
	let client: RawUdsWebSocket | undefined;
	let hostStderr: Promise<string> | undefined;
	try {
		await Promise.all([
			mkdir(project, { recursive: true }),
			mkdir(agentDir, { recursive: true, mode: 0o700 }),
		]);
		await writeFile(
			join(agentDir, "models.yml"),
			`providers:\n  gate0:\n    baseUrl: http://127.0.0.1:${model.server.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Gate 0 Deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`,
		);
		const seed = new OfficialOmpProfileAuthority({
			sessionsRoot,
			metadataPath: join(root, "seed-metadata.json"),
		});
		await seed.initialize();
		const session = await seed.create(project, "Packaged official OMP");
		await seed.close();
		const socketPath = profileSocketPath(profile, process.platform, home, runtimeRoot);
		const environment = {
			...process.env,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_RUNTIME_DIR: runtimeRoot,
			PI_NOTIFICATIONS: "off",
			OMP_PROFILE: profile,
		};
		child = Bun.spawn(
			[
				hostPath,
				"serve",
				"--omp",
				runtime.path,
				"--omp-authority",
				"official",
				"--omp-sessions-root",
				sessionsRoot,
				"--profile",
				profile,
				"--state-root",
				stateRoot,
			],
			{
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		hostStderr = stderr;
		await waitForSocket(socketPath, child);
		client = await RawUdsWebSocket.connect(socketPath);
		client.sendJson({
			v: "omp-app/1",
			type: "hello",
			protocol: { min: "omp-app/1", max: "omp-app/1" },
			client: { name: "official-packaged-proof", version: "1", build: "proof", platform: process.platform },
			requestedFeatures: ["terminal.io"],
			capabilities: {
				client: ["sessions.read", "sessions.prompt", "sessions.manage", "catalog.read", "term.open", "term.input", "term.resize"],
			},
			savedCursors: [],
		});
		const welcome = await next(client);
		if (welcome.type !== "welcome") throw new Error("packaged T4 host did not send Welcome");
		const sessions = await next(client);
		if (sessions.type !== "sessions" || !sessions.sessions.some(item => item.sessionId === session.sessionId))
			throw new Error("packaged T4 host did not discover the official OMP session");
		let command = 0;
		const send = (requestId: string, name: string, args: Record<string, unknown>): void => {
			command += 1;
			client!.sendJson({
				v: "omp-app/1",
				type: "command",
				requestId,
				commandId: `packaged-${command}`,
				hostId: welcome.hostId,
				sessionId: session.sessionId,
				command: name,
				args,
			});
		};
		send("attach", "session.attach", {});
		const attached = await responseFor(client, "attach");
		if (!attached.ok) throw new Error(`packaged session attach failed: ${attached.error.message}`);
		let stateReady = false;
		let stateFailure = "unknown";
		// The runtime claim round-trip takes seconds on a loaded machine;
		// 40 × 100ms is not enough when the gates run every package at once.
		for (let attempt = 0; attempt < 200 && !stateReady; attempt += 1) {
			const requestId = `state-${attempt}`;
			send(requestId, "session.state.get", {});
			const state = await responseFor(client, requestId);
			stateReady = state.ok;
			if (!state.ok) stateFailure = `${state.error.code}: ${state.error.message}`;
			if (!stateReady) await Bun.sleep(100);
		}
		if (!stateReady) throw new Error(`packaged session did not become writable (${stateFailure})`);
		send("prompt", "session.prompt", { message: "Packaged host prompt" });
		const prompted = await responseFor(client, "prompt");
		if (!prompted.ok) throw new Error(`packaged session prompt failed: ${prompted.error.message}`);
		let assistantProjected = false;
		const deadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < deadline && !assistantProjected) {
			const frame = await next(client);
			assistantProjected =
				frame.type === "entry" &&
				frame.sessionId === session.sessionId &&
				frame.entry.kind === "message" &&
				frame.entry.data.role === "assistant" &&
				frame.entry.data.text === "Gate 0 response 1";
		}
		if (!assistantProjected) throw new Error("official OMP assistant entry did not reach the T4 wire");
		const transcript = await readFile(session.path, "utf8");
		if (!transcript.includes("Packaged host prompt") || !transcript.includes("Gate 0 response 1"))
			throw new Error("packaged host turn was not durable in official OMP JSONL");

		// Terminal end-to-end. A direct module smoke cannot catch CLI wiring,
		// dispatcher capability gating, terminal-ownership claiming, or catalog
		// advertisement, so drive term.open over the real socket instead.
		// catalog.get is host-scoped: the wire rejects a sessionId on it.
		command += 1;
		client.sendJson({
			v: "omp-app/1",
			type: "command",
			requestId: "catalog",
			commandId: `packaged-${command}`,
			hostId: welcome.hostId,
			command: "catalog.get",
			args: {},
		});
		const catalog = await responseFor(client, "catalog");
		if (!catalog.ok) throw new Error(`packaged catalog.get failed: ${catalog.error.message}`);
		if (!catalogAdvertises(catalog.result, "term.open"))
			throw new Error("packaged host did not advertise term.open in its catalog");

		send("term", "term.open", {});
		const openedTerminal = await responseFor(client, "term");
		if (!openedTerminal.ok) throw new Error(`packaged term.open failed: ${openedTerminal.error.message}`);
		const openedId = stringField(openedTerminal.result, "terminalId");
		if (openedId === undefined) throw new Error("packaged term.open returned no terminalId");
		const terminalFrame = (type: string, extra: Record<string, unknown>): void =>
			client!.sendJson({
				v: "omp-app/1",
				type,
				hostId: welcome.hostId,
				sessionId: session.sessionId,
				terminalId: openedId,
				...extra,
			});

		terminalFrame("terminal.input", { data: "echo PACKAGED_TERMINAL_OK\n" });
		let terminalOutput = "";
		const seen: string[] = [];
		const terminalDeadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < terminalDeadline && !terminalOutput.includes("PACKAGED_TERMINAL_OK")) {
			const frame = await next(client);
			seen.push(frame.type);
			if (frame.type === "terminal.output") terminalOutput += stringField(frame, "data") ?? "";
		}
		if (!terminalOutput.includes("PACKAGED_TERMINAL_OK"))
			throw new Error(`packaged terminal did not stream output; frames seen: ${seen.join(",") || "none"}`);

		terminalFrame("terminal.input", { data: "exit 4\n" });
		let terminalExit: number | undefined;
		const exitDeadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < exitDeadline && terminalExit === undefined) {
			const frame = await next(client);
			if (frame.type === "terminal.exit") terminalExit = numberField(frame, "exitCode");
		}
		if (terminalExit !== 4) throw new Error(`packaged terminal exit was ${String(terminalExit)}, expected 4`);
		const result = {
			schemaVersion: 1,
			runtime: {
				version: runtime.version,
				tag: runtime.matrix.officialRuntime.sourceTag,
				commit: runtime.matrix.officialRuntime.sourceCommit,
				sha256: runtime.manifest.sha256,
			},
			platform: { os: process.platform, arch: process.arch },
			packagedHost: { binary: "t4-host", authority: "official", exclusiveSessionsRoot: true },
			scenarios: {
				discovery: true,
				attach: true,
				prompt: true,
				durableJsonl: true,
				t4WireProjection: true,
				terminal: true,
			},
			passed: true,
		};
		const evidenceRoot = join(repoRoot, "artifacts", "official-omp-packaged-host");
		await mkdir(evidenceRoot, { recursive: true });
		await writeFile(join(evidenceRoot, `${process.platform}-${process.arch}.json`), `${JSON.stringify(result, null, 2)}\n`);
		console.log(JSON.stringify(result, null, 2));
		await client.close();
		client = undefined;
		child.kill("SIGTERM");
		if ((await child.exited) !== 0) throw new Error(`packaged T4 host failed: ${(await stderr).trim().slice(-4_096)}`);
		child = undefined;
		await stdout;
	} catch (error) {
		// Without the host's own stderr a stalled scenario looks like a bare
		// client timeout and says nothing about why the host went quiet.
		if (child) {
			child.kill("SIGKILL");
			await child.exited.catch(() => undefined);
			console.error(`[host stderr]\n${((await hostStderr) ?? "").trim().slice(-4_096)}`);
		}
		throw error;
	} finally {
		client?.destroy();
		if (child) {
			child.kill("SIGKILL");
			await child.exited.catch(() => undefined);
		}
		await model.server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}

await main();
