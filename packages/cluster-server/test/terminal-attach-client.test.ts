import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vite-plus/test";
import type { OmpClient, OmpResponse, PublicOmpServerEvent } from "@t4-code/client";
import { hostId, sessionId } from "@t4-code/host-wire";
import {
	parseTerminalInput,
	renderTerminalEvent,
	runTerminalAttach,
	terminalAttachMain,
	type TerminalAttachConfig,
} from "../src/terminal-attach-client.ts";

const CONFIG: TerminalAttachConfig = {
	runtimeId: "runtime-fixture",
	generation: "gen_123456789012345678901234",
	hostId: "pod:session-fixture",
	sessionId: "session-fixture",
	socketPath: "/run/t4/runtime-fixture/attach.sock",
	identityPath: "/run/t4/runtime-fixture/terminal-attach.json",
};

class FakeClient {
	readonly commands: Array<{ command: string; args: Record<string, unknown> }> = [];
	readonly events = new Set<(event: PublicOmpServerEvent) => void>();
	readonly commandOutcomes: Array<OmpResponse | Error> = [];
	readonly confirmOutcomes: Array<OmpResponse | Error> = [];
	confirmCount = 0;
	onAttach: (() => void) | undefined;
	connectCount = 0;
	attachCount = 0;
	closeCount = 0;
	async connect(): Promise<void> { this.connectCount += 1; }
	async attach(host: string, session: string): Promise<OmpResponse> {
		expect([host, session]).toEqual([CONFIG.hostId, CONFIG.sessionId]);
		this.attachCount += 1;
		this.onAttach?.();
		return { ok: true } as OmpResponse;
	}
	async command(intent: { command: string; args?: Record<string, unknown> }): Promise<OmpResponse> {
		this.commands.push({ command: intent.command, args: intent.args ?? {} });
		const outcome = this.commandOutcomes.shift();
		if (outcome instanceof Error) throw outcome;
		return outcome ?? ({ ok: true } as OmpResponse);
	}
	async confirm(): Promise<OmpResponse> {
		this.confirmCount += 1;
		const outcome = this.confirmOutcomes.shift();
		if (outcome instanceof Error) throw outcome;
		return outcome ?? ({ ok: true } as OmpResponse);
	}
	async close(): Promise<void> { this.closeCount += 1; }
	onEvent(listener: (event: PublicOmpServerEvent) => void): () => void { this.events.add(listener); return () => this.events.delete(listener); }
	emit(event: PublicOmpServerEvent): void { for (const listener of this.events) listener(event); }
	onError(): () => void { return () => undefined; }
}

function captured(stream: PassThrough): Promise<string> {
	const chunks: Buffer[] = [];
	const { promise, resolve } = Promise.withResolvers<string>();
	stream.on("data", chunk => chunks.push(Buffer.from(chunk)));
	stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	return promise;
}

describe("terminal attach client", () => {
	it("parses only the bounded typed prompt/control surface", () => {
		expect(parseTerminalInput("hello")).toEqual({ kind: "prompt", message: "hello" });
		expect(parseTerminalInput("/steer change direction")).toEqual({ kind: "steer", message: "change direction" });
		expect(parseTerminalInput("/follow-up then verify")).toEqual({ kind: "follow-up", message: "then verify" });
		expect(parseTerminalInput("/cancel")).toEqual({ kind: "cancel" });
		expect(() => parseTerminalInput("/resume session-fixture")).toThrow("unknown terminal attach command");
		expect(() => parseTerminalInput("x".repeat(65 * 1_024))).toThrow("64 KiB");
	});

	it("renders bounded snapshot/replay/live assistant text without protocol envelopes", () => {
		const snapshot = {
			kind: "snapshot",
			payload: {
				hostId: hostId(CONFIG.hostId), sessionId: sessionId(CONFIG.sessionId), revision: "revision-fixture", cursor: { epoch: "epoch-fixture", seq: 1 },
				entries: [{ id: "entry-fixture", parentId: null, hostId: hostId(CONFIG.hostId), sessionId: sessionId(CONFIG.sessionId), kind: "message", timestamp: "2026-07-29T00:00:00Z", data: { role: "assistant", text: "same transcript" } }],
			},
		} as unknown as PublicOmpServerEvent;
		expect(renderTerminalEvent(snapshot)).toEqual(["assistant> same transcript\n"]);
		const state = { liveMessages: new Map<string, string>(), settledEntries: new Set<string>() };
		const first = { kind: "event", payload: { event: { type: "message.update", entryId: "assistant-live", text: "\u001bhello", role: "assistant", reasoning: "", at: "2026-07-29T00:00:01Z" } } } as unknown as PublicOmpServerEvent;
		expect(renderTerminalEvent(first, state)).toEqual(["assistant> hello"]);
		const second = { kind: "event", payload: { event: { type: "message.update", entryId: "assistant-live", text: "hello world", role: "assistant", reasoning: "", at: "2026-07-29T00:00:02Z" } } } as unknown as PublicOmpServerEvent;
		expect(renderTerminalEvent(second, state)).toEqual([" world"]);
		const settled = { kind: "event", payload: { event: { type: "message.settled", transientEntryId: "assistant-live", entryId: "entry-final", at: "2026-07-29T00:00:03Z" } } } as unknown as PublicOmpServerEvent;
		expect(renderTerminalEvent(settled, state)).toEqual(["\n"]);
	});

	it("uses one attached client for non-TTY prompts and closes cleanly on EOF", async () => {
		const client = new FakeClient();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stdoutText = captured(stdout);
		const status = await runTerminalAttach(
			CONFIG,
			{ stdin: Readable.from(["first\n/steer second\n/follow-up third\n"]), stdout, stderr },
			{ createClient: () => client as unknown as OmpClient, registerSignal: () => () => undefined },
		);
		stdout.end();
		stderr.end();
		expect(status).toBe(0);
		expect(client.connectCount).toBe(1);
		expect(client.attachCount).toBe(1);
		expect(client.closeCount).toBe(1);
		expect(client.commands).toEqual([
			{ command: "session.prompt", args: { message: "first" } },
			{ command: "session.steer", args: { message: "second" } },
			{ command: "session.followUp", args: { message: "third" } },
		]);
		expect(await stdoutText).toBe("");
	});


	it("bounds output while honoring stream backpressure", async () => {
		const client = new FakeClient();
		const stdout = new PassThrough({ highWaterMark: 1 });
		const stderr = new PassThrough();
		const stdoutText = captured(stdout);
		client.onAttach = () => {
			for (let index = 0; index < 40; index += 1) {
				client.emit({ kind: "event", payload: { event: { type: "message.delta", text: "x".repeat(64 * 1_024) } } } as unknown as PublicOmpServerEvent);
			}
		};
		expect(await runTerminalAttach(
			CONFIG,
			{ stdin: Readable.from([]), stdout, stderr },
			{ createClient: () => client as unknown as OmpClient, registerSignal: () => () => undefined },
		)).toBe(0);
		stdout.end();
		stderr.end();
		const rendered = await stdoutText;
		expect(rendered).toContain("terminal attach output limit reached");
		expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(2 * 1_024 * 1_024 + 128);
	});

	it("maps SIGINT to typed session cancellation without replacing the authority", async () => {
		const client = new FakeClient();
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const signals: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
		client.onAttach = () => {
			signals.SIGINT?.();
			stdin.end("/quit\n");
		};
		expect(await runTerminalAttach(
			CONFIG,
			{ stdin, stdout, stderr },
			{ createClient: () => client as unknown as OmpClient, registerSignal: (signal, listener) => { signals[signal] = listener; return () => { delete signals[signal]; }; } },
		)).toBe(0);
		stdout.end();
		stderr.end();
		expect(client.commands).toContainEqual({ command: "session.cancel", args: {} });
		expect(client.connectCount).toBe(1);
	});

	it("releases failed cancel attempts for retry and reports non-ok confirmation", async () => {
		const client = new FakeClient();
		client.commandOutcomes.push(
			{ ok: false, error: { code: "capacity", message: "cancel rejected" } } as OmpResponse,
			{ ok: true } as OmpResponse,
		);
		client.confirmOutcomes.push({ ok: false, error: { code: "confirmation_invalid", message: "cancel confirmation expired" } } as OmpResponse);
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stderrText = captured(stderr);
		const signals: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
		client.onAttach = () => {
			signals.SIGINT?.();
			setTimeout(() => {
				signals.SIGINT?.();
				client.emit({
					kind: "confirmation",
					payload: { hostId: CONFIG.hostId, sessionId: CONFIG.sessionId, summary: "session.cancel", confirmationId: "confirmation-fixture", commandId: "command-fixture" },
				} as unknown as PublicOmpServerEvent);
				setTimeout(() => stdin.end("/quit\n"), 0);
			}, 0);
		};
		expect(await runTerminalAttach(
			CONFIG,
			{ stdin, stdout, stderr },
			{ createClient: () => client as unknown as OmpClient, registerSignal: (signal, listener) => { signals[signal] = listener; return () => { delete signals[signal]; }; } },
		)).toBe(0);
		stdout.end();
		stderr.end();
		expect(client.commands.filter(command => command.command === "session.cancel")).toHaveLength(2);
		expect(client.confirmCount).toBe(1);
		expect(await stderrText).toContain("cancel rejected");
		expect(await stderrText).toContain("cancel confirmation expired");
	});

	it("retries cancellation after the command promise rejects", async () => {
		const client = new FakeClient();
		client.commandOutcomes.push(new Error("attach transport reset"), { ok: true } as OmpResponse);
		const stdin = new PassThrough();
		const signals: Partial<Record<"SIGINT" | "SIGTERM", () => void>> = {};
		client.onAttach = () => {
			signals.SIGINT?.();
			setTimeout(() => { signals.SIGINT?.(); setTimeout(() => stdin.end("/quit\n"), 0); }, 0);
		};
		expect(await runTerminalAttach(
			CONFIG,
			{ stdin, stdout: new PassThrough(), stderr: new PassThrough() },
			{ createClient: () => client as unknown as OmpClient, registerSignal: (signal, listener) => { signals[signal] = listener; return () => { delete signals[signal]; }; } },
		)).toBe(0);
		expect(client.commands.filter(command => command.command === "session.cancel")).toHaveLength(2);
	});

	it("shows interactive guidance only for a TTY and exits on /quit", async () => {
		const client = new FakeClient();
		const input = Readable.from(["/quit\n"]);
		const stdin = Object.assign(input, { isTTY: true, setRawMode: () => input });
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const stdoutText = captured(stdout);
		expect(await runTerminalAttach(
			CONFIG,
			{ stdin, stdout, stderr },
			{ createClient: () => client as unknown as OmpClient, registerSignal: () => () => undefined },
		)).toBe(0);
		stdout.end();
		stderr.end();
		expect(await stdoutText).toContain("Connected to the hosted OMP session");
		expect(client.commands).toEqual([]);
	});

	it("rejects writer and resume flags before reading runtime state", async () => {
		expect(await terminalAttachMain(["--mode", "rpc"], {})).toBe(64);
		expect(await terminalAttachMain(["--resume", "session-fixture"], {})).toBe(64);
		expect(await terminalAttachMain(["--session", "/runtime-state/runtime-fixture/session.jsonl"], {})).toBe(64);
	});
});
