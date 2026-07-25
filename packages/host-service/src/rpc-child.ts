import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
	boundedMap,
	MAX_TRANSCRIPT_LINE_BYTES,
	parseBounded,
	parseBoundedTranscriptLine,
	type OperationCapability,
} from "@t4-code/host-wire";
import type { RpcResponse, RpcSessionEntryFrame } from "./omp-rpc-contract.ts";
import type { ManagedRpcImageRef } from "./image-upload-store.ts";
import { OfficialOmpCapabilityAdapter } from "./official-omp-capabilities.ts";
import type { ChildHandle, RpcChildFactory, SessionRecord } from "./types.ts";

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;
const STDERR_BYTES = 64 * 1024;
const FAILURE_STOP_GRACE_MS = 2_000;
const PROTOCOL_NEGOTIATION_TIMEOUT_MS = 10_000;
const TRANSCRIPT_READ_BYTES = 64 * 1024;
const MAX_PENDING_DURABLE_CORRELATIONS = 64;

interface PendingDurableCorrelation {
	readonly internalId: string;
	readonly message: string;
}

interface PendingRpcChunks {
	readonly chunkId: string;
	readonly count: number;
	readonly byteLength: number;
	readonly chunks: Buffer[];
	nextIndex: number;
	receivedBytes: number;
}

class RpcChunkDecoder {
	#pending?: PendingRpcChunks;

	push(frame: Record<string, unknown>): Record<string, unknown> | undefined {
		if (frame.type !== "rpc_chunk") {
			if (this.#pending) throw new Error("rpc chunk sequence interrupted");
			return frame;
		}
		const { chunkId, index, count, byteLength, data } = frame;
		if (
			typeof chunkId !== "string" ||
			chunkId.length === 0 ||
			chunkId.length > 128 ||
			typeof index !== "number" ||
			typeof count !== "number" ||
			typeof byteLength !== "number" ||
			typeof data !== "string"
		)
			throw new Error("malformed rpc chunk");
		if (
			!Number.isSafeInteger(index) ||
			!Number.isSafeInteger(count) ||
			!Number.isSafeInteger(byteLength) ||
			index < 0 ||
			count < 2 ||
			count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
			index >= count ||
			byteLength < MAX_LINE_BYTES ||
			byteLength > MAX_RPC_REASSEMBLED_BYTES ||
			data.length === 0 ||
			!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
		)
			throw new Error("malformed rpc chunk");
		const bytes = Buffer.from(data, "base64");
		if (bytes.toString("base64") !== data || bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES)
			throw new Error("malformed rpc chunk");

		if (!this.#pending) {
			if (index !== 0) throw new Error("rpc chunk sequence must start at index 0");
			this.#pending = { chunkId, count, byteLength, chunks: [], nextIndex: 0, receivedBytes: 0 };
		}
		const pending = this.#pending;
		if (
			pending.chunkId !== chunkId ||
			pending.count !== count ||
			pending.byteLength !== byteLength ||
			pending.nextIndex !== index
		)
			throw new Error("rpc chunk sequence mismatch");
		pending.chunks.push(bytes);
		pending.receivedBytes += bytes.byteLength;
		pending.nextIndex++;
		if (pending.receivedBytes > pending.byteLength) throw new Error("rpc chunk sequence exceeds declared length");
		if (pending.nextIndex < pending.count) return undefined;
		if (pending.receivedBytes !== pending.byteLength) throw new Error("rpc chunk sequence length mismatch");

		this.#pending = undefined;
		let decoded: string;
		try {
			decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
		} catch {
			throw new Error("invalid UTF-8 rpc frame");
		}
		let value: unknown;
		try {
			value = JSON.parse(decoded);
		} catch {
			throw new Error("malformed reassembled rpc frame");
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rpc frame must be an object");
		return value as Record<string, unknown>;
	}
}

function rawEntryId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const id = (value as Record<string, unknown>).id;
	return typeof id === "string" && id.length > 0 && id.length <= 256 ? id : undefined;
}

function durableEntryId(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (entry.type === "title" || entry.type === "session") return undefined;
	return rawEntryId(entry);
}

function rawUserMessage(
	value: unknown,
): { readonly text: string; readonly entry: Record<string, unknown> } | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entry = value as Record<string, unknown>;
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message))
		return undefined;
	const message = entry.message as Record<string, unknown>;
	if (message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return { text: content, entry };
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap(part => {
			if (typeof part === "string") return [part];
			if (!part || typeof part !== "object" || Array.isArray(part)) return [];
			const item = part as Record<string, unknown>;
			return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("");
	return { text, entry };
}

/**
 * Reconciles the authoritative OMP JSONL after every RPC frame. Official OMP
 * does not publish the fork-only ready watermark or live `session_entry`
 * projection, while the released fallback publishes both. Tracking raw entry
 * IDs lets one implementation support either runtime without double emission.
 */
class DurableJsonlReconciler {
	#offset = 0;
	#entryCount = 0;
	#lastEntryId: string | null = null;
	#skippingOversizedLine = false;
	#oversizedLineStart = 0;
	readonly #projectedEntryIds = new Set<string>();
	readonly #pendingCorrelations: PendingDurableCorrelation[] = [];
	#reconcileTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly path: string,
		private readonly emit: (frame: RpcSessionEntryFrame) => void,
		private readonly transcriptRecordOmitted?: (offset: number) => void,
	) {}

	watermark(): RpcLoadedTranscriptWatermark {
		return { lastEntryId: this.#lastEntryId, entryCount: this.#entryCount };
	}

	recordCorrelation(internalId: string, command: Record<string, unknown>): void {
		if (
			(command.type === "prompt" || command.type === "steer" || command.type === "follow_up") &&
			typeof command.message === "string"
		) {
			if (this.#pendingCorrelations.length >= MAX_PENDING_DURABLE_CORRELATIONS)
				throw new Error("too many pending durable prompt correlations");
			this.#pendingCorrelations.push({ internalId, message: command.message });
		}
	}

	discardCorrelation(internalId: string): void {
		const index = this.#pendingCorrelations.findIndex(item => item.internalId === internalId);
		if (index >= 0) this.#pendingCorrelations.splice(index, 1);
	}

	observeLiveEntry(value: unknown): Record<string, unknown> | undefined {
		const id = durableEntryId(value);
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		if (!id) return value as Record<string, unknown>;
		if (this.#projectedEntryIds.has(id)) return undefined;
		this.#projectedEntryIds.add(id);
		return this.#correlate(value as Record<string, unknown>);
	}

	async initialize(): Promise<void> {
		let size: number;
		try {
			const info = await stat(this.path);
			if (!info.isFile()) throw new Error("session transcript is not a file");
			size = info.size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.#scan(size, false);
	}

	async reconcile(): Promise<void> {
		const next = this.#reconcileTail.then(() => this.#reconcile());
		this.#reconcileTail = next.catch(() => undefined);
		await next;
	}

	async #reconcile(): Promise<void> {
		let info;
		try {
			info = await stat(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!info.isFile()) throw new Error("session transcript is not a file");
		if (info.size < this.#offset) {
			this.#offset = 0;
			this.#entryCount = 0;
			this.#lastEntryId = null;
			this.#skippingOversizedLine = false;
			this.#oversizedLineStart = 0;
			this.#projectedEntryIds.clear();
			await this.initialize();
			return;
		}
		if (info.size === this.#offset) return;
		await this.#scan(info.size, true);
	}

	async #scan(size: number, publish: boolean): Promise<void> {
		const handle = await open(this.path, "r");
		let position = this.#offset;
		const pendingChunks: Buffer[] = [];
		let pendingBytes = 0;
		let pendingStart = position;

		const clearPending = (): void => {
			pendingChunks.length = 0;
			pendingBytes = 0;
		};

		const buildPendingLine = (extra?: Uint8Array): Buffer => {
			if (!extra || extra.byteLength === 0) {
				if (pendingChunks.length === 0) return Buffer.alloc(0);
				if (pendingChunks.length === 1) return pendingChunks[0]!;
				return Buffer.concat(pendingChunks, pendingBytes);
			}
			if (pendingChunks.length === 0) return Buffer.from(extra);
			const total = pendingBytes + extra.byteLength;
			return Buffer.concat([...pendingChunks, Buffer.from(extra)], total);
		};

		try {
			while (position < size) {
				const length = Math.min(TRANSCRIPT_READ_BYTES, size - position);
				const bytes = Buffer.allocUnsafe(length);
				const chunkStart = position;
				const result = await handle.read(bytes, 0, length, chunkStart);
				if (result.bytesRead === 0) throw new Error("session transcript changed during reconciliation");
				position += result.bytesRead;
				const chunk = bytes.subarray(0, result.bytesRead);
				let cursor = 0;
				while (cursor < chunk.byteLength) {
					const newline = chunk.indexOf(0x0a, cursor);
					const end = newline < 0 ? chunk.byteLength : newline;
					const segment = chunk.subarray(cursor, end);
					if (this.#skippingOversizedLine) {
						if (newline < 0) break;
						this.#skippingOversizedLine = false;
						this.#omitOversizedRecord(publish);
						pendingStart = chunkStart + newline + 1;
					} else if (pendingBytes + segment.byteLength > MAX_TRANSCRIPT_LINE_BYTES) {
						this.#oversizedLineStart = pendingStart;
						clearPending();
						if (newline < 0) {
							this.#skippingOversizedLine = true;
							break;
						}
						this.#omitOversizedRecord(publish);
						pendingStart = chunkStart + newline + 1;
					} else if (newline < 0) {
						if (segment.byteLength > 0) {
							pendingChunks.push(Buffer.from(segment));
							pendingBytes += segment.byteLength;
						}
						break;
					} else {
						const line = buildPendingLine(segment);
						if (line.byteLength > 0)
							this.#observeLine(new TextDecoder("utf-8", { fatal: true }).decode(line), publish);
						clearPending();
						pendingStart = chunkStart + newline + 1;
					}
					cursor = end + 1;
				}
			}
		} finally {
			await handle.close();
		}
		this.#offset = this.#skippingOversizedLine ? position : position - pendingBytes;
	}

	#omitOversizedRecord(publish: boolean): void {
		// The skipped record could be the durable user entry at the head of the
		// correlation queue. Its identity is unknowable without parsing it, so
		// retain no correlation across this gap.
		this.#pendingCorrelations.length = 0;
		if (publish) this.transcriptRecordOmitted?.(this.#oversizedLineStart);
	}

	#observeLine(line: string, publish: boolean): void {
		let value: unknown;
		try {
			value = parseBoundedTranscriptLine(line);
		} catch (error) {
			throw new Error("malformed session transcript", { cause: error });
		}
		const id = durableEntryId(value);
		if (!id) return;
		this.#entryCount += 1;
		this.#lastEntryId = id;
		if (!publish || !value || typeof value !== "object" || Array.isArray(value)) return;
		if (this.#projectedEntryIds.has(id)) return;
		this.#projectedEntryIds.add(id);
		this.emit({ type: "session_entry", entry: this.#correlate(value as Record<string, unknown>) as never });
	}

	#correlate(entry: Record<string, unknown>): Record<string, unknown> {
		const user = rawUserMessage(entry);
		const correlation = this.#pendingCorrelations[0];
		if (user && correlation && user.text === correlation.message) {
			this.#pendingCorrelations.shift();
			return {
				...entry,
				message: {
					...(entry.message as Record<string, unknown>),
					...((entry.message as Record<string, unknown>).clientCorrelationId === undefined
						? { clientCorrelationId: correlation.internalId }
						: {}),
				},
			};
		}
		return entry;
	}
}

export interface ChildCallbacks {
	entry(frame: RpcSessionEntryFrame): void;
	event(frame: Record<string, unknown>): void;
	capabilities?(operations: readonly OperationCapability[]): void;
	transcriptRecordOmitted?(offset: number): void;
	crashed(error: Error): void;
}

export interface RpcLoadedTranscriptWatermark {
	readonly lastEntryId: string | null;
	readonly entryCount: number;
}

export interface RpcChildInvocation {
	executable: string;
	prefixArgv: readonly string[];
}

export interface RpcChildInvocationOverrides {
	compiled?: boolean;
	executable?: string;
	main?: string;
}

export function resolveRpcChildInvocation(overrides: RpcChildInvocationOverrides = {}): RpcChildInvocation {
	const executable = overrides.executable ?? process.execPath;
	if (typeof executable !== "string" || executable.trim().length === 0)
		throw new Error("rpc child executable is empty");
	const compiled = overrides.compiled ?? process.env.PI_COMPILED === "true";
	const runningMain = overrides.main ?? Bun.main;
	const runningCodingAgentDaemon = typeof runningMain === "string" && runningMain.endsWith("/cli/ompd.ts");
	const main = runningCodingAgentDaemon ? resolve(dirname(runningMain), "../cli.ts") : runningMain;
	if (!compiled && (typeof main !== "string" || main.trim().length === 0))
		throw new Error("rpc child CLI entry is empty");
	return { executable, prefixArgv: Object.freeze(compiled ? [] : [main]) };
}

export class BunRpcChildFactory implements RpcChildFactory {
	#executable: string;
	#prefixArgv: readonly string[];
	#imageRoot: string | undefined;
	#environment: Readonly<Record<string, string>>;

	constructor(
		invocation: string | RpcChildInvocation = resolveRpcChildInvocation(),
		imageRoot?: string,
		environment: Readonly<Record<string, string>> = {},
	) {
		const resolved = typeof invocation === "string" ? { executable: invocation, prefixArgv: [] } : invocation;
		if (typeof resolved.executable !== "string" || resolved.executable.trim().length === 0) {
			throw new Error("rpc child executable is empty");
		}
		if (
			!Array.isArray(resolved.prefixArgv) ||
			resolved.prefixArgv.some(arg => typeof arg !== "string" || arg.length === 0)
		) {
			throw new Error("rpc child prefix argv is invalid");
		}
		this.#executable = resolved.executable;
		this.#prefixArgv = Object.freeze([...resolved.prefixArgv]);
		this.#imageRoot = imageRoot;
		this.#environment = Object.freeze({ ...environment });
	}

	spawn(spec: { session: SessionRecord; argv: string[]; cwd: string }): ChildHandle {
		const child = Bun.spawn(spec.argv, {
			cwd: spec.cwd,
			env: {
				...process.env,
				...this.#environment,
				OMP_APP_RPC_INLINE_IMAGE_DATA: "omit",
				OMP_APP_RPC_SESSION_ENTRIES: "1",
				OMP_APP_SUBAGENT_SUBSCRIPTION: "progress",
				...(this.#imageRoot ? { OMP_APP_RPC_IMAGE_ROOT: this.#imageRoot } : {}),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			stdin: { write: data => Promise.resolve(child.stdin.write(data)).then(() => undefined) },
			stdout: child.stdout as unknown as AsyncIterable<Uint8Array>,
			stderr: child.stderr as unknown as AsyncIterable<Uint8Array>,
			exited: child.exited,
			kill: signal => child.kill(signal as never),
		};
	}

	argv(sessionPath: string): string[] {
		return [this.#executable, ...this.#prefixArgv, "--mode", "rpc", "--session", sessionPath];
	}
}

function stringBytes(value: string): number {
	let bytes = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) throw new Error("invalid UTF-8 stdout");
			bytes += 4;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("invalid UTF-8 stdout");
		else bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return bytes;
}

async function* lines(stream: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pending = "";
	for await (const chunk of stream) {
		let text: string;
		try {
			text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		} catch {
			throw new Error("invalid UTF-8 stdout");
		}
		pending += text;
		let index = pending.indexOf("\n");
		while (index >= 0) {
			if (stringBytes(pending.slice(0, index + 1)) > MAX_LINE_BYTES)
				throw new Error("rpc line exceeds 1MiB");
			const line = pending.slice(0, index).replace(/\r$/, "");
			pending = pending.slice(index + 1);
			yield line;
			index = pending.indexOf("\n");
		}
		if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
	}
	try {
		pending += decoder.decode();
	} catch {
		throw new Error("invalid UTF-8 stdout");
	}
	if (pending) {
		if (stringBytes(pending) > MAX_LINE_BYTES) throw new Error("rpc line exceeds 1MiB");
		yield pending;
	}
}

export class RpcChildSupervisor {
	#child?: ChildHandle;
	#pending = new Map<string, { resolve: (value: RpcResponse) => void; reject: (error: Error) => void }>();
	#ignoredResponses = new Set<string>();
	#closed = false;
	#readyReject?: (error: Error) => void;
	#loadedWatermark?: RpcLoadedTranscriptWatermark;
	#counter = 0;
	#stderr = "";
	#ready = false;
	#supportsProtocolV2 = false;
	#protocolV2 = false;
	readonly #frameDecoder = new RpcChunkDecoder();
	#termination?: Promise<void>;
	#operationCapabilities: OfficialOmpCapabilityAdapter;
	#transcript: DurableJsonlReconciler;
	constructor(
		private readonly factory: RpcChildFactory,
		private readonly session: SessionRecord,
		private readonly callbacks: ChildCallbacks,
		private readonly argv = ["omp", "--mode", "rpc"],
		private readonly failureStopGraceMs = FAILURE_STOP_GRACE_MS,
		private readonly runtimeVersion?: string,
		private readonly protocolNegotiationTimeoutMs = PROTOCOL_NEGOTIATION_TIMEOUT_MS,
	) {
		this.#operationCapabilities = new OfficialOmpCapabilityAdapter(runtimeVersion);
		this.#transcript = new DurableJsonlReconciler(
			session.path,
			frame => this.callbacks.entry(frame),
			offset => this.callbacks.transcriptRecordOmitted?.(offset),
		);
		if (!Number.isSafeInteger(failureStopGraceMs) || failureStopGraceMs <= 0 || failureStopGraceMs > 60_000)
			throw new Error("failureStopGraceMs must be between 1 and 60000");
		if (
			!Number.isSafeInteger(protocolNegotiationTimeoutMs) ||
			protocolNegotiationTimeoutMs <= 0 ||
			protocolNegotiationTimeoutMs > 60_000
		)
			throw new Error("protocolNegotiationTimeoutMs must be between 1 and 60000");
	}
	hasPendingCalls(): boolean {
		return this.#pending.size > 0;
	}
	async start(): Promise<void> {
		if (this.#child) throw new Error("child already started");
		this.#child = this.factory.spawn({ session: this.session, argv: this.argv, cwd: this.session.cwd });
		const ready = Promise.withResolvers<void>();
		this.#readyReject = ready.reject;
		void this.readStdout(ready);
		void this.readStderr();
		void this.#child.exited.then(code => {
			if (!this.#closed && code !== 0) this.fail(new Error(`rpc child exited (${code}): ${this.#stderr}`));
		});
		const timer = setTimeout(() => ready.reject(new Error("rpc child ready timeout")), 10_000);
		try {
			await ready.promise;
			if (this.#supportsProtocolV2) {
				this.#protocolV2 = true;
				const abort = new AbortController();
				const negotiationTimer = setTimeout(() => abort.abort(), this.protocolNegotiationTimeoutMs);
				let negotiated: RpcResponse;
				try {
					negotiated = await this.call(
						{ type: "negotiate_protocol", protocolVersion: 2 },
						"rpc-protocol",
						abort.signal,
						undefined,
						false,
					);
				} catch (error) {
					if (abort.signal.aborted)
						throw new Error("rpc protocol v2 negotiation timed out", { cause: error });
					throw error;
				} finally {
					clearTimeout(negotiationTimer);
				}
				if (
					!negotiated.success ||
					!negotiated.data ||
					typeof negotiated.data !== "object" ||
					Array.isArray(negotiated.data) ||
					(negotiated.data as Record<string, unknown>).protocolVersion !== 2
				)
					throw new Error("rpc protocol v2 negotiation failed");
			}
		} catch (error) {
			this.stop();
			throw error;
		} finally {
			clearTimeout(timer);
			this.#readyReject = undefined;
		}
	}
	async call(
		command: Record<string, unknown>,
		requestId: string,
		signal?: AbortSignal,
		onDispatched?: (internalId: string) => void,
		abortChild = true,
	): Promise<RpcResponse> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		// A caller can disconnect while the supervisor is still starting. Do not
		// enqueue a cancel followed by the original command once that wait ends.
		if (signal?.aborted) throw new Error("rpc call aborted");
		const internalId = `${requestId}:${++this.#counter}`;
		const promise = Promise.withResolvers<RpcResponse>();
		this.#pending.set(internalId, promise);
		this.#transcript.recordCorrelation(internalId, command);
		const onAbort = () => {
			const pending = this.#pending.get(internalId);
			if (!pending) return;
			this.#pending.delete(internalId);
			this.#ignoredResponses.add(internalId);
			this.#transcript.discardCorrelation(internalId);
			pending.reject(new Error("rpc call aborted"));
			if (abortChild) void this.cancel(`${requestId}:cancel`).catch(() => undefined);
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const line = `${JSON.stringify({ ...command, id: internalId })}\n`;
			if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
			onDispatched?.(internalId);
			// onDispatched is synchronous, so this also closes the only gap before
			// the write where user code could abort the signal.
			if (signal?.aborted) return await promise.promise;
			await this.#child.stdin.write(line);
			const response = await promise.promise;
			if (response.type !== "response" || response.command !== command.type || typeof response.success !== "boolean")
				throw new Error("rpc response command mismatch");
			return response;
		} catch (error) {
			this.#pending.delete(internalId);
			this.#transcript.discardCorrelation(internalId);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}
	/** Refresh the normalized operation catalog from stock OMP's RPC capability endpoint. */
	async refreshOperationCapabilities(requestId: string, signal?: AbortSignal): Promise<readonly OperationCapability[]> {
		const result = await this.call({ type: "get_available_commands" }, requestId, signal, undefined, false);
		if (!result.success) throw new Error(result.error);
		const data = boundedMap(result.data, "get_available_commands.data", 4);
		const operations = this.#operationCapabilities.update(data.commands);
		this.callbacks.capabilities?.(operations);
		return operations;
	}
	async prompt(
		id: string,
		message: string,
		signal?: AbortSignal,
		onDispatched?: (internalId: string) => void,
		appImageRefs?: readonly ManagedRpcImageRef[],
	): Promise<RpcResponse> {
		this.#operationCapabilities.assertPromptSupported(message);
		return this.call(
			{ type: "prompt", message, ...(appImageRefs ? { appImageRefs } : {}) },
			id,
			signal,
			onDispatched,
		);
	}
	async cancel(id: string): Promise<RpcResponse> {
		// Appserver owns accepted queued messages separately from the running root.
		// Resume those messages after aborting the root instead of applying the
		// interactive UI's "stop until the next explicit prompt" latch.
		return this.call({ type: "abort", resumeQueuedMessages: true }, id);
	}
	async cancelSubagent(agentId: unknown, id: string): Promise<RpcResponse> {
		// This is accepted work after confirmation, so it deliberately has no
		// caller abort signal. A disconnect cannot revoke it after dispatch.
		return this.call({ type: "cancel_subagent", agentId }, id, undefined, undefined, false);
	}
	async respondUi(
		requestId: string,
		payload: { value?: string; confirmed?: boolean; cancelled?: true },
	): Promise<void> {
		if (!this.#child || this.#closed || !this.#ready) throw new Error("rpc child unavailable");
		const line = `${JSON.stringify({ type: "extension_ui_response", id: requestId, ...payload })}\n`;
		if (stringBytes(line) > MAX_LINE_BYTES) throw new Error("rpc command exceeds 1MiB");
		await this.#child.stdin.write(line);
	}
	stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
		const child = this.#child;
		this.#closed = true;
		try {
			child?.kill(signal);
		} catch {}
		this.fail(new Error("rpc child stopped"));
		// The owner must retain this handle until `exited` settles. Clearing it
		// here would let lifecycle retries lose track of a signal-resistant child.
	}
	loadedWatermark(): RpcLoadedTranscriptWatermark | undefined {
		return this.#ready ? this.#transcript.watermark() : undefined;
	}
	async reconcileTranscript(): Promise<RpcLoadedTranscriptWatermark | undefined> {
		if (!this.#ready || this.#closed) return undefined;
		await this.#transcript.reconcile();
		return this.#transcript.watermark();
	}
	child(): ChildHandle | undefined {
		return this.#child;
	}
	operationCapabilities(): readonly OperationCapability[] {
		return this.#operationCapabilities.operations();
	}
	assertOperationSupported(operationId: string): OperationCapability {
		return this.#operationCapabilities.assertOperationSupported(operationId);
	}
	private async readStdout(ready: { resolve: () => void; reject: (error: Error) => void }): Promise<void> {
		try {
			for await (const line of lines(this.#child!.stdout)) {
				if (!line) continue;
				let value: unknown;
				try {
					value = parseBounded(line);
				} catch {
					throw new Error("malformed rpc stdout");
				}
				if (!value || typeof value !== "object" || Array.isArray(value))
					throw new Error("rpc frame must be an object");
				const parsed = value as Record<string, unknown>;
				if (parsed.type === "rpc_chunk" && !this.#protocolV2) throw new Error("rpc chunk received before negotiation");
				const decoded = this.#frameDecoder.push(parsed);
				if (!decoded) continue;
				const frame = decoded;
				if (frame.type === "ready") {
					const versions = frame.supportedProtocolVersions;
					const maxFrameBytes = frame.maxFrameBytes;
					const maxReassembledFrameBytes = frame.maxReassembledFrameBytes;
					this.#supportsProtocolV2 =
						Array.isArray(versions) &&
						versions.includes(2) &&
						maxFrameBytes === MAX_LINE_BYTES &&
						maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES;
					const watermark = frame.transcriptWatermark;
					if (watermark && typeof watermark === "object" && !Array.isArray(watermark)) {
						const candidate = watermark as Record<string, unknown>;
						const lastEntryId = candidate.lastEntryId;
						const entryCount = candidate.entryCount;
						if (
							((typeof lastEntryId === "string" && lastEntryId.length <= 256) || lastEntryId === null) &&
							typeof entryCount === "number" &&
							Number.isSafeInteger(entryCount) &&
							entryCount >= 0
						)
							this.#loadedWatermark = { lastEntryId, entryCount };
					}
					if (this.#ready) throw new Error("duplicate rpc ready");
					await this.#transcript.initialize();
					const reconciled = this.#transcript.watermark();
					if (
						this.#loadedWatermark &&
						(this.#loadedWatermark.entryCount !== reconciled.entryCount ||
							this.#loadedWatermark.lastEntryId !== reconciled.lastEntryId)
					)
						throw new Error("rpc ready watermark does not match durable transcript");
					this.#loadedWatermark = reconciled;
					this.#ready = true;
					ready.resolve();
					continue;
				}
				this.dispatch(frame);
				await this.#transcript.reconcile();
			}
			if (!this.#closed) this.fail(new Error("rpc child stdout EOF"), true);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			ready.reject(failure);
			this.fail(failure, true);
		}
	}
	private async readStderr(): Promise<void> {
		if (!this.#child?.stderr) return;
		try {
			for await (const chunk of this.#child.stderr) {
				const text =
					typeof chunk === "string"
						? chunk.slice(-STDERR_BYTES)
						: new TextDecoder("utf-8", { fatal: false }).decode(
								chunk.byteLength > STDERR_BYTES ? chunk.slice(-STDERR_BYTES) : chunk,
							);
				this.#stderr = `${this.#stderr}${text}`.slice(-STDERR_BYTES);
			}
		} catch {}
	}
	private dispatch(value: Record<string, unknown>): void {
		// stop() deliberately keeps draining the process handle until exit, but
		// buffered stdout from that stopped child no longer owns session state.
		if (this.#closed) return;
		if (this.#operationCapabilities.consume(value)) {
			this.callbacks.capabilities?.(this.#operationCapabilities.operations());
			return;
		}
		if (value.type === "response") {
			if (typeof value.id !== "string" || typeof value.command !== "string" || typeof value.success !== "boolean")
				throw new Error("malformed rpc response");
			const pending = this.#pending.get(value.id);
			if (!pending) {
				if (this.#ignoredResponses.delete(value.id)) return;
				throw new Error("rpc response has unknown id");
			}
			this.#pending.delete(value.id);
			const responseData = value.data;
			const localOnlyPrompt =
				value.command === "prompt" &&
				value.success &&
				responseData !== null &&
				typeof responseData === "object" &&
				!Array.isArray(responseData) &&
				(responseData as Record<string, unknown>).agentInvoked === false;
			if (!value.success || localOnlyPrompt) this.#transcript.discardCorrelation(value.id);
			if (!value.success && typeof value.error !== "string") pending.reject(new Error("rpc response missing error"));
			else pending.resolve(value as unknown as RpcResponse);
			return;
		}
		if (value.type === "session_entry") {
			if (!value.entry || typeof value.entry !== "object" || Array.isArray(value.entry))
				throw new Error("malformed rpc session entry");
			const entry = this.#transcript.observeLiveEntry(value.entry);
			if (entry) this.callbacks.entry({ ...value, entry } as unknown as RpcSessionEntryFrame);
			return;
		}
		if (typeof value.type !== "string") throw new Error("rpc frame type is missing");
		this.callbacks.event(value);
	}
	private terminateAfterReaderFailure(): void {
		if (this.#termination || !this.#child) return;
		const child = this.#child;
		this.#termination = (async () => {
			try {
				child.kill("SIGTERM");
			} catch {}
			const exited = await Promise.race([
				child.exited.then(
					() => true,
					() => true,
				),
				Bun.sleep(this.failureStopGraceMs).then(() => false),
			]);
			if (exited) return;
			try {
				child.kill("SIGKILL");
			} catch {}
			await child.exited.catch(() => undefined);
		})();
	}
	private fail(error: Error, terminateChild = false): void {
		this.#readyReject?.(error);
		this.#readyReject = undefined;
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
		if (!this.#closed) {
			this.#closed = true;
			if (terminateChild) this.terminateAfterReaderFailure();
			this.callbacks.crashed(error);
		}
	}
}
