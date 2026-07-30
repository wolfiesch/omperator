export const MAX_CMUX_FRAME_BYTES = 67_108_864;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export interface CmuxWebSocketRoute {
	readonly principal: string;
	readonly runtimeId: string;
	readonly generation: string;
	readonly routeGeneration: string;
}

export interface CmuxJsonlByteStream {
	readonly readable: AsyncIterable<Uint8Array>;
	write(chunk: Uint8Array): Promise<void>;
	end(): Promise<void>;
	close(cause?: unknown): Promise<void>;
}

export interface CmuxWebSocketRouteOpener {
	open(route: CmuxWebSocketRoute, signal: AbortSignal): Promise<CmuxJsonlByteStream>;
}

export interface CmuxWebSocketPeer {
	sendText(value: string): number;
	close(code: number, reason: string): void;
}

export function isValidCmuxWebSocketTemplate(value: string | undefined): value is string {
	if (value === undefined || value.split("{runtimeId}").length !== 2) return false;
	try {
		const url = new URL(value.replace("{runtimeId}", "runtime-template"));
		const localPlaintext = url.protocol === "ws:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		return (url.protocol === "wss:" || localPlaintext) && !url.username && !url.password && !url.search && !url.hash
			&& url.pathname === "/v1/cmux/runtime-template";
	} catch {
		return false;
	}
}

export function sameCmuxWebSocketRoute(left: CmuxWebSocketRoute | undefined, right: CmuxWebSocketRoute): boolean {
	return left?.principal === right.principal
		&& left.runtimeId === right.runtimeId
		&& left.generation === right.generation
		&& left.routeGeneration === right.routeGeneration;
}

function jsonWhitespace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09;
}

/** Validates one JSON object without constructing or re-serializing its semantic value. */
export function isSingleJsonObject(bytes: Uint8Array): boolean {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_CMUX_FRAME_BYTES) return false;
	for (const byte of bytes) if (byte === 0x0a || byte === 0x0d) return false;
	try { decoder.decode(bytes); } catch { return false; }
	let offset = 0;
	const skip = (): void => { while (offset < bytes.byteLength && jsonWhitespace(bytes[offset]!)) offset++; };
	const string = (): boolean => {
		if (bytes[offset++] !== 0x22) return false;
		while (offset < bytes.byteLength) {
			const byte = bytes[offset++]!;
			if (byte === 0x22) return true;
			if (byte < 0x20) return false;
			if (byte !== 0x5c) continue;
			if (offset >= bytes.byteLength) return false;
			const escape = bytes[offset++]!;
			if (escape === 0x22 || escape === 0x5c || escape === 0x2f || escape === 0x62 || escape === 0x66 || escape === 0x6e || escape === 0x72 || escape === 0x74) continue;
			if (escape !== 0x75 || offset + 4 > bytes.byteLength) return false;
			for (let index = 0; index < 4; index++) {
				const hex = bytes[offset++]!;
				if (!(hex >= 0x30 && hex <= 0x39 || hex >= 0x41 && hex <= 0x46 || hex >= 0x61 && hex <= 0x66)) return false;
			}
		}
		return false;
	};
	const literal = (value: readonly number[]): boolean => {
		for (const byte of value) if (bytes[offset++] !== byte) return false;
		return true;
	};
	const number = (): boolean => {
		if (bytes[offset] === 0x2d) offset++;
		if (bytes[offset] === 0x30) offset++;
		else {
			if (bytes[offset] === undefined || bytes[offset]! < 0x31 || bytes[offset]! > 0x39) return false;
			while (bytes[offset] !== undefined && bytes[offset]! >= 0x30 && bytes[offset]! <= 0x39) offset++;
		}
		if (bytes[offset] === 0x2e) {
			offset++;
			if (bytes[offset] === undefined || bytes[offset]! < 0x30 || bytes[offset]! > 0x39) return false;
			while (bytes[offset] !== undefined && bytes[offset]! >= 0x30 && bytes[offset]! <= 0x39) offset++;
		}
		if (bytes[offset] === 0x65 || bytes[offset] === 0x45) {
			offset++;
			if (bytes[offset] === 0x2b || bytes[offset] === 0x2d) offset++;
			if (bytes[offset] === undefined || bytes[offset]! < 0x30 || bytes[offset]! > 0x39) return false;
			while (bytes[offset] !== undefined && bytes[offset]! >= 0x30 && bytes[offset]! <= 0x39) offset++;
		}
		return true;
	};
	const value = (depth: number): boolean => {
		if (depth > 512) return false;
		skip();
		switch (bytes[offset]) {
			case 0x22: return string();
			case 0x7b: return object(depth + 1);
			case 0x5b: return array(depth + 1);
			case 0x74: return literal([0x74, 0x72, 0x75, 0x65]);
			case 0x66: return literal([0x66, 0x61, 0x6c, 0x73, 0x65]);
			case 0x6e: return literal([0x6e, 0x75, 0x6c, 0x6c]);
			default: return number();
		}
	};
	const array = (depth: number): boolean => {
		if (bytes[offset++] !== 0x5b) return false;
		skip();
		if (bytes[offset] === 0x5d) { offset++; return true; }
		for (;;) {
			if (!value(depth)) return false;
			skip();
			if (bytes[offset] === 0x5d) { offset++; return true; }
			if (bytes[offset++] !== 0x2c) return false;
		}
	};
	const object = (depth: number): boolean => {
		if (bytes[offset++] !== 0x7b) return false;
		skip();
		if (bytes[offset] === 0x7d) { offset++; return true; }
		for (;;) {
			skip();
			if (!string()) return false;
			skip();
			if (bytes[offset++] !== 0x3a || !value(depth)) return false;
			skip();
			if (bytes[offset] === 0x7d) { offset++; return true; }
			if (bytes[offset++] !== 0x2c) return false;
		}
	};
	skip();
	if (bytes[offset] !== 0x7b || !object(1)) return false;
	skip();
	return offset === bytes.byteLength;
}

export class CmuxWebSocketBridge {
	readonly #stream: CmuxJsonlByteStream;
	readonly #peer: CmuxWebSocketPeer;
	readonly #abort: AbortController;
	readonly #onClosed?: () => void;
	readonly #maxFrameBytes: number;
	readonly #maxQueuedBytes: number;
	readonly #onProtocolMismatch?: () => void;
	#closed = false;
	#queuedClientBytes = 0;
	#clientWrites = Promise.resolve();

	constructor(
		stream: CmuxJsonlByteStream,
		peer: CmuxWebSocketPeer,
		abort: AbortController,
		onClosed?: () => void,
		limits: { readonly maxFrameBytes?: number; readonly maxQueuedBytes?: number; readonly onProtocolMismatch?: () => void } = {},
	) {
		this.#stream = stream;
		this.#peer = peer;
		this.#abort = abort;
		this.#onClosed = onClosed;
		this.#maxFrameBytes = Math.min(MAX_CMUX_FRAME_BYTES, limits.maxFrameBytes ?? MAX_CMUX_FRAME_BYTES);
		this.#maxQueuedBytes = Math.min(this.#maxFrameBytes + 1, limits.maxQueuedBytes ?? this.#maxFrameBytes + 1);
		this.#onProtocolMismatch = limits.onProtocolMismatch;
		if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 1
			|| !Number.isSafeInteger(this.#maxQueuedBytes) || this.#maxQueuedBytes < 1)
			throw new TypeError("cmux websocket byte limits are invalid");
	}

	get closed(): boolean { return this.#closed; }

	start(): void {
		void this.#pumpUpstream();
	}

	receiveText(message: string | Uint8Array): void {
		if (this.#closed) return;
		const bytes = typeof message === "string" ? encoder.encode(message) : message;
		if (bytes.byteLength > this.#maxFrameBytes) { void this.close(1009, "cmux message too large"); return; }
		if (!isSingleJsonObject(bytes)) { this.#onProtocolMismatch?.(); void this.close(1008, "invalid cmux JSON object"); return; }
		const recordBytes = bytes.byteLength + 1;
		if (recordBytes > this.#maxQueuedBytes || this.#queuedClientBytes > this.#maxQueuedBytes - recordBytes) {
			void this.close(1013, "cmux input backpressure");
			return;
		}
		const record = new Uint8Array(recordBytes);
		record.set(bytes);
		record[recordBytes - 1] = 0x0a;
		this.#queuedClientBytes += recordBytes;
		this.#clientWrites = this.#clientWrites.then(async () => {
			if (this.#closed || this.#abort.signal.aborted) return;
			await this.#stream.write(record);
		}).catch(error => this.close(1011, "cmux backend failure", error)).finally(() => {
			this.#queuedClientBytes -= recordBytes;
		});
	}

	receiveBinary(): void {
		if (this.#closed) return;
		this.#onProtocolMismatch?.();
		void this.close(1003, "binary cmux frames are unsupported");
	}

	async clientClosed(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort(new Error("cmux websocket closed"));
		try { await this.#stream.close(); } catch {}
		this.#onClosed?.();
	}

	async close(code: number, reason: string, cause?: unknown): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#abort.abort(cause ?? new Error(reason));
		try { await this.#stream.close(cause); } catch {}
		this.#peer.close(code, reason);
		this.#onClosed?.();
	}

	async #pumpUpstream(): Promise<void> {
		let parts: Uint8Array[] = [];
		let length = 0;
		try {
			for await (const chunk of this.#stream.readable) {
				if (this.#closed) return;
				let start = 0;
				for (let index = 0; index < chunk.byteLength; index++) {
					const byte = chunk[index]!;
					if (byte === 0x0d) { await this.close(1008, "invalid cmux JSONL line"); return; }
					if (byte !== 0x0a) continue;
					const segment = chunk.subarray(start, index);
					if (length + segment.byteLength > this.#maxFrameBytes) { await this.close(1009, "cmux line too large"); return; }
					const line = parts.length === 0 ? segment : this.#join(parts, segment, length + segment.byteLength);
					if (!isSingleJsonObject(line)) { await this.close(1008, "invalid cmux JSONL object"); return; }
					const accepted = this.#peer.sendText(decoder.decode(line));
					if (accepted <= 0) { await this.close(1013, "cmux output backpressure"); return; }
					parts = [];
					length = 0;
					start = index + 1;
				}
				const tail = chunk.subarray(start);
				if (length + tail.byteLength > this.#maxFrameBytes) { await this.close(1009, "cmux line too large"); return; }
				if (tail.byteLength > 0) { parts.push(tail); length += tail.byteLength; }
			}
			if (this.#closed) return;
			if (length !== 0) { await this.close(1008, "partial cmux JSONL line"); return; }
			try { await this.#stream.end(); } catch {}
			await this.close(1000, "cmux backend closed");
		} catch (error) {
			await this.close(1011, "cmux backend failure", error);
		}
	}

	#join(parts: readonly Uint8Array[], tail: Uint8Array, total: number): Uint8Array {
		const output = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
		output.set(tail, offset);
		return output;
	}
}
