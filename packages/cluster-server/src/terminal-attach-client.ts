#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline";
import WebSocket from "ws";
import {
	OmpClient,
	type OmpResponse,
	type OmpTransport,
	type PublicOmpServerEvent,
	type Unsubscribe,
} from "@t4-code/client";
import { type DurableEntry } from "@t4-code/host-wire";
import { terminalAttachConfigFromEnv, type TerminalAttachConfig } from "./terminal-attach-identity.ts";
export {
	removeTerminalAttachIdentity,
	terminalAttachConfigFromEnv,
	writeTerminalAttachIdentity,
	type TerminalAttachConfig,
	type TerminalAttachIdentity,
} from "./terminal-attach-identity.ts";

const MAX_INPUT_BYTES = 64 * 1_024;
const MAX_OUTPUT_BYTES = 2 * 1_024 * 1_024;
const MAX_OUTPUT_CHUNK_BYTES = 64 * 1_024;
const MAX_SNAPSHOT_ENTRIES = 256;
const MAX_LIVE_MESSAGES = 64;
const MAX_SOCKET_BUFFERED_BYTES = 1 * 1_024 * 1_024;


export interface TerminalAttachStreams {
	readonly stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean };
	readonly stdout: NodeJS.WritableStream & { readonly isTTY?: boolean };
	readonly stderr: NodeJS.WritableStream;
}

export interface TerminalAttachDependencies {
	readonly createClient?: (config: TerminalAttachConfig) => OmpClient;
	readonly registerSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => () => void;
}


class UnixWebSocketTransport implements OmpTransport {
	readonly #socket: WebSocket;
	readonly #messages = new Set<(data: string | Uint8Array) => void>();
	readonly #closes = new Set<(code?: number, reason?: string) => void>();
	readonly #errors = new Set<(error: unknown) => void>();
	constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.on("message", data => {
			const value = typeof data === "string" ? data : new Uint8Array(data as Buffer);
			for (const listener of this.#messages) listener(value);
		});
		socket.on("close", (code, reason) => { for (const listener of this.#closes) listener(code, reason.toString("utf8")); });
		socket.on("error", error => { for (const listener of this.#errors) listener(error); });
	}
	static async open(socketPath: string, thisGeneration: string): Promise<UnixWebSocketTransport> {
		const socket = new WebSocket(`ws+unix://${socketPath}:/ws`, {
			followRedirects: false,
			maxPayload: 1_048_576,
			perMessageDeflate: false,
			headers: { "x-t4-runtime-generation": thisGeneration },
		});
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const opened = (): void => { socket.off("error", failed); resolve(); };
		const failed = (error: Error): void => { socket.off("open", opened); reject(error); };
		socket.once("open", opened);
		socket.once("error", failed);
		await promise;
		return new UnixWebSocketTransport(socket);
	}
	send(data: string): void {
		if (this.#socket.readyState !== WebSocket.OPEN) throw new Error("terminal attach socket is not open");
		if (this.#socket.bufferedAmount + Buffer.byteLength(data) > MAX_SOCKET_BUFFERED_BYTES) throw new Error("terminal attach socket backpressure limit exceeded");
		this.#socket.send(data);
	}
	close(): void { this.#socket.close(1000, "terminal attach closed"); }
	onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe { this.#messages.add(listener); return () => this.#messages.delete(listener); }
	onClose(listener: (code?: number, reason?: string) => void): Unsubscribe { this.#closes.add(listener); return () => this.#closes.delete(listener); }
	onError(listener: (error: unknown) => void): Unsubscribe { this.#errors.add(listener); return () => this.#errors.delete(listener); }
}

export function createTerminalAttachClient(config: TerminalAttachConfig): OmpClient {
	return new OmpClient({
		transport: () => UnixWebSocketTransport.open(config.socketPath, config.generation),
		hostId: config.hostId,
		expectedHostId: config.hostId,
		client: { name: "t4-terminal-attach", version: "0.1.33", build: "cluster-session", platform: process.platform },
		requestedFeatures: ["resume", "session.state"],
		capabilities: ["sessions.read", "sessions.prompt", "sessions.control"],
		reconnect: { baseMs: 100, maxMs: 2_000 },
	});
}

class BoundedOutput {
	readonly #stream: NodeJS.WritableStream;
	#tail = Promise.resolve();
	#acceptedBytes = 0;
	#truncated = false;
	constructor(stream: NodeJS.WritableStream) { this.#stream = stream; }
	write(value: string): void {
		if (this.#truncated) return;
		let body = value;
		if (Buffer.byteLength(body) > MAX_OUTPUT_CHUNK_BYTES) body = `${Buffer.from(body).subarray(0, MAX_OUTPUT_CHUNK_BYTES).toString("utf8")}\n[output chunk truncated]\n`;
		const bytes = Buffer.byteLength(body);
		if (this.#acceptedBytes + bytes > MAX_OUTPUT_BYTES) {
			this.#truncated = true;
			body = "\n[terminal attach output limit reached; live session remains attached]\n";
		}
		this.#acceptedBytes += Buffer.byteLength(body);
		this.#tail = this.#tail.then(() => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (this.#stream.write(body)) resolve();
			else this.#stream.once("drain", resolve);
			return promise;
		});
	}
	flush(): Promise<void> { return this.#tail; }
}

function safeTerminalText(value: string): string {
	let output: string | undefined;
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code > 8 && (code < 11 || code > 31) && (code < 127 || code > 159)) continue;
		output = (output ?? "") + value.slice(start, index);
		start = index + 1;
	}
	return output === undefined ? value : output + value.slice(start);
}

function entryText(entry: DurableEntry): string | undefined {
	const text = entry.data.text;
	if (typeof text !== "string" || text.length === 0) return undefined;
	const role = typeof entry.data.role === "string" ? entry.data.role : entry.kind;
	return `${safeTerminalText(role)}> ${safeTerminalText(text)}\n`;
}

export interface TerminalRenderState {
	readonly liveMessages: Map<string, string>;
	readonly settledEntries: Set<string>;
}

export function renderTerminalEvent(
	event: PublicOmpServerEvent,
	state: TerminalRenderState = { liveMessages: new Map<string, string>(), settledEntries: new Set<string>() },
): string[] {
	if (event.kind === "snapshot") {
		const entries = event.payload.entries.slice(-MAX_SNAPSHOT_ENTRIES);
		const output = entries.map(entryText).filter((value): value is string => value !== undefined);
		if (event.payload.entries.length > entries.length) output.unshift(`[showing last ${entries.length} transcript entries]\n`);
		return output;
	}
	if (event.kind === "entry") {
		if (state.settledEntries.delete(String(event.payload.entry.id))) return [];
		const text = entryText(event.payload.entry);
		return text === undefined ? [] : [text];
	}
	if (event.kind === "event") {
		const live = event.payload.event;
		if (live.type === "message.update" && typeof live.entryId === "string" && typeof live.text === "string") {
			const text = safeTerminalText(live.text);
			const previous = state.liveMessages.get(live.entryId);
			if (previous === undefined && state.liveMessages.size >= MAX_LIVE_MESSAGES) state.liveMessages.delete(state.liveMessages.keys().next().value!);
			state.liveMessages.set(live.entryId, text);
			if (previous === undefined) return text.length === 0 ? [] : [`assistant> ${text}`];
			if (text.startsWith(previous)) return text.length === previous.length ? [] : [text.slice(previous.length)];
			return [`\nassistant> ${text}`];
		}
		if (live.type === "message.settled" && typeof live.transientEntryId === "string" && typeof live.entryId === "string") {
			const existed = state.liveMessages.delete(live.transientEntryId);
			if (existed) state.settledEntries.add(live.entryId);
			return existed ? ["\n"] : [];
		}
		if ((live.type === "message.delta" || live.type === "assistant.delta") && typeof live.text === "string") return [safeTerminalText(live.text)];
	}
	return [];
}

export type TerminalInputCommand =
	| { readonly kind: "prompt" | "steer" | "follow-up"; readonly message: string }
	| { readonly kind: "cancel" | "quit" }
	| { readonly kind: "empty" };

export function parseTerminalInput(line: string): TerminalInputCommand {
	if (Buffer.byteLength(line) > MAX_INPUT_BYTES) throw new Error("terminal input exceeds 64 KiB");
	if (line.trim().length === 0) return { kind: "empty" };
	if (line === "/quit" || line === "/exit") return { kind: "quit" };
	if (line === "/cancel") return { kind: "cancel" };
	for (const [prefix, kind] of [["/steer ", "steer"], ["/follow-up ", "follow-up"]] as const) {
		if (line.startsWith(prefix)) {
			const message = line.slice(prefix.length);
			if (message.length === 0) throw new Error(`${prefix.trim()} requires a message`);
			return { kind, message };
		}
	}
	if (line.startsWith("/")) throw new Error("unknown terminal attach command");
	return { kind: "prompt", message: line };
}

function commandFailure(response: OmpResponse): Error | undefined {
	if (response.ok) return undefined;
	return new Error(response.error?.message ?? "session command failed");
}

export async function runTerminalAttach(
	config: TerminalAttachConfig,
	streams: TerminalAttachStreams,
	dependencies: TerminalAttachDependencies = {},
): Promise<number> {
	const client = dependencies.createClient?.(config) ?? createTerminalAttachClient(config);
	const output = new BoundedOutput(streams.stdout);
	const renderState: TerminalRenderState = { liveMessages: new Map(), settledEntries: new Set() };
	let closing = false;
	let cancelState: "command" | "confirming" | undefined;
	let input: Interface | undefined;
	const eventUnsubscribe = client.onEvent(event => {
		for (const body of renderTerminalEvent(event, renderState)) output.write(body);
		if (cancelState === "command" && event.kind === "confirmation" && event.payload.hostId === config.hostId && event.payload.sessionId === config.sessionId && event.payload.summary === "session.cancel") {
			cancelState = "confirming";
			void client.confirm({ confirmationId: event.payload.confirmationId, commandId: event.payload.commandId, hostId: config.hostId, sessionId: config.sessionId, decision: "approve" }).then(response => {
				const failure = commandFailure(response);
				if (failure) streams.stderr.write(`omp attach: ${failure.message}\n`);
			}, error => streams.stderr.write(`omp attach: ${error instanceof Error ? error.message : "cancel failed"}\n`)).finally(() => { cancelState = undefined; });
		}
	});
	const errorUnsubscribe = client.onError(error => streams.stderr.write(`omp attach: ${error.message}\n`));
	const cancel = (): void => {
		if (closing || cancelState !== undefined) return;
		cancelState = "command";
		void client.command({ hostId: config.hostId, sessionId: config.sessionId, command: "session.cancel", args: {} }).then(response => {
			const failure = commandFailure(response);
			if (failure) {
				cancelState = undefined;
				streams.stderr.write(`omp attach: ${failure.message}\n`);
			}
		}, error => {
			cancelState = undefined;
			streams.stderr.write(`omp attach: ${error instanceof Error ? error.message : "cancel failed"}\n`);
		});
	};
	const registerSignal = dependencies.registerSignal ?? ((signal, listener) => { process.on(signal, listener); return () => process.off(signal, listener); });
	const removeInt = registerSignal("SIGINT", cancel);
	const removeTerm = registerSignal("SIGTERM", () => {
		closing = true;
		input?.close();
		void client.close();
	});
	try {
		await client.connect();
		const attached = await client.attach(config.hostId, config.sessionId);
		const failure = commandFailure(attached);
		if (failure) throw failure;
		if (streams.stdin.isTTY) streams.stdout.write("Connected to the hosted OMP session. /cancel, /steer, /follow-up, /quit\n");
		input = createInterface({ input: streams.stdin, crlfDelay: Infinity, terminal: Boolean(streams.stdin.isTTY), output: streams.stdin.isTTY ? streams.stdout : undefined });
		if (streams.stdin.isTTY) input.setPrompt("omp> ");
		for await (const line of input) {
			if (streams.stdin.isTTY) input.pause();
			try {
				const command = parseTerminalInput(line);
				if (command.kind === "quit") { closing = true; break; }
				if (command.kind === "cancel") cancel();
				else if (command.kind === "prompt" || command.kind === "steer" || command.kind === "follow-up") {
					const wireCommand = command.kind === "prompt" ? "session.prompt" : command.kind === "steer" ? "session.steer" : "session.followUp";
					const response = await client.command({ hostId: config.hostId, sessionId: config.sessionId, command: wireCommand, args: { message: command.message } });
					const commandError = commandFailure(response);
					if (commandError) throw commandError;
				}
			} catch (error) {
				streams.stderr.write(`omp attach: ${error instanceof Error ? error.message : "input failed"}\n`);
			} finally {
				if (streams.stdin.isTTY && !closing) { input.resume(); input.prompt(); }
			}
		}
		closing = true;
		input.close();
		return 0;
	} finally {
		closing = true;
		removeInt();
		removeTerm();
		eventUnsubscribe();
		errorUnsubscribe();
		await client.close().catch(() => undefined);
		await output.flush();
	}
}

export async function terminalAttachMain(argv = process.argv.slice(2), env = process.env): Promise<number> {
	if (argv.length !== 0) {
		process.stderr.write("omp is the hosted-session attach client and accepts no process flags; use interactive /commands\n");
		return 64;
	}
	try {
		const config = await terminalAttachConfigFromEnv(env);
		return await runTerminalAttach(config, { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
	} catch (error) {
		process.stderr.write(`omp attach: ${error instanceof Error ? error.message : "startup failed"}\n`);
		return 1;
	}
}

if (import.meta.main) process.exitCode = await terminalAttachMain();
