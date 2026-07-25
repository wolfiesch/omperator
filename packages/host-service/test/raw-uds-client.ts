import { createConnection, type Socket } from "node:net";
import { decodeServerFrame, type ServerFrame } from "@t4-code/host-wire";

export interface RawWsFrame {
	opcode: number;
	fin: boolean;
	payload: Uint8Array;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}

function maskedFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const length = payload.byteLength;
	const header = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
	const frame = new Uint8Array(header + 4 + length);
	frame[0] = 0x80 | opcode;
	if (length < 126) frame[1] = 0x80 | length;
	else if (length <= 0xffff) {
		frame[1] = 0x80 | 126;
		new DataView(frame.buffer).setUint16(2, length);
	} else {
		frame[1] = 0x80 | 127;
		new DataView(frame.buffer).setBigUint64(2, BigInt(length));
	}
	const maskOffset = header;
	frame.set([0x13, 0x57, 0x9b, 0xdf], maskOffset);
	for (let index = 0; index < length; index++)
		frame[maskOffset + 4 + index] = payload[index]! ^ frame[maskOffset + (index % 4)]!;
	return frame;
}

function parseFrames(state: { bytes: Uint8Array; frames: RawWsFrame[] }): void {
	while (state.bytes.byteLength >= 2) {
		const first = state.bytes[0]!;
		const second = state.bytes[1]!;
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		let length = second & 0x7f;
		let header = 2;
		if (length === 126) {
			if (state.bytes.byteLength < 4) return;
			length = new DataView(state.bytes.buffer, state.bytes.byteOffset).getUint16(2);
			header = 4;
		} else if (length === 127) {
			if (state.bytes.byteLength < 10) return;
			const long = new DataView(state.bytes.buffer, state.bytes.byteOffset).getBigUint64(2);
			if (long > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("websocket frame is too large");
			length = Number(long);
			header = 10;
		}
		const maskBytes = masked ? 4 : 0;
		if (state.bytes.byteLength < header + maskBytes + length) return;
		const payloadStart = header + maskBytes;
		const payload = state.bytes.slice(payloadStart, payloadStart + length);
		if (masked) {
			const mask = state.bytes.slice(header, payloadStart);
			for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ mask[index % 4]!;
		}
		state.frames.push({ opcode, fin, payload });
		state.bytes = state.bytes.slice(payloadStart + length);
	}
}

export class RawUdsWebSocket {
	readonly #socket: Socket;
	#bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
	#frames: RawWsFrame[] = [];
	#waiters: Array<{ resolve: (frame: RawWsFrame) => void; reject: (error: Error) => void }> = [];
	#handshake = Promise.withResolvers<void>();
	#closed = Promise.withResolvers<void>();
	#handshakeDone = false;
	#closedObserved = false;
	#header = "";
	#headerEnd = -1;

	constructor(socket: Socket) {
		this.#socket = socket;
		socket.on("data", chunk => this.#onData(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk));
		socket.once("error", error => {
			const failure = error instanceof Error ? error : new Error(String(error));
			if (!this.#handshakeDone) this.#handshake.reject(failure);
			this.#rejectWaiters(failure);
			this.#closed.resolve();
		});
		socket.once("close", () => {
			this.#closedObserved = true;
			if (!this.#handshakeDone) this.#handshake.reject(new Error("websocket closed during handshake"));
			this.#rejectWaiters(new Error("websocket closed"));
			this.#closed.resolve();
		});
	}

	static async connect(socketPath: string): Promise<RawUdsWebSocket> {
		const connected = Promise.withResolvers<void>();
		const socket = createConnection(socketPath);
		socket.once("connect", connected.resolve);
		socket.once("error", connected.reject);
		await connected.promise;
		const client = new RawUdsWebSocket(socket);
		const websocketKey = Buffer.from("0123456789abcdef", "utf8").toString("base64");
		socket.write(
			`GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		await client.#handshake.promise;
		return client;
	}
	#onData(chunk: Uint8Array<ArrayBufferLike>): void {
		this.#bytes = concat(this.#bytes, chunk);
		if (!this.#handshakeDone) {
			this.#headerEnd = this.#bytes.findIndex(
				(_, index, bytes) =>
					index + 3 < bytes.length &&
					bytes[index] === 13 &&
					bytes[index + 1] === 10 &&
					bytes[index + 2] === 13 &&
					bytes[index + 3] === 10,
			);
			if (this.#headerEnd < 0) return;
			this.#header = new TextDecoder().decode(this.#bytes.slice(0, this.#headerEnd));
			if (!/^HTTP\/1\.1 101\b/m.test(this.#header)) {
				this.#handshake.reject(new Error(`websocket handshake failed: ${this.#header}`));
				return;
			}
			this.#bytes = this.#bytes.slice(this.#headerEnd + 4);
			this.#handshakeDone = true;
			this.#handshake.resolve();
		}
		const state = { bytes: this.#bytes, frames: this.#frames };
		parseFrames(state);
		this.#bytes = state.bytes;
		while (this.#frames.length && this.#waiters.length) this.#waiters.shift()!.resolve(this.#frames.shift()!);
	}

	#rejectWaiters(error: Error): void {
		while (this.#waiters.length) this.#waiters.shift()!.reject(error);
	}

	sendRaw(frame: Uint8Array): void {
		this.#socket.write(frame);
	}
	sendText(value: string): void {
		this.sendRaw(maskedFrame(0x1, new TextEncoder().encode(value)));
	}
	sendBinary(value: Uint8Array): void {
		this.sendRaw(maskedFrame(0x2, value));
	}
	sendJson(value: unknown): void {
		this.sendText(JSON.stringify(value));
	}
	sendClose(code = 1000): void {
		const payload = new Uint8Array(2);
		new DataView(payload.buffer).setUint16(0, code);
		this.sendRaw(maskedFrame(0x8, payload));
	}
	async next(): Promise<RawWsFrame> {
		if (this.#frames.length) return this.#frames.shift()!;
		const waiter = Promise.withResolvers<RawWsFrame>();
		this.#waiters.push(waiter);
		return waiter.promise;
	}
	async nextServer(): Promise<ServerFrame> {
		const frame = await this.next();
		if (frame.opcode === 0x8) {
			const hasCode = frame.payload.byteLength >= 2;
			const code = hasCode
				? String(new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint16(0))
				: "no-code";
			// The reason text is the diagnostic that says WHICH frame the host rejected.
			const reason = hasCode ? new TextDecoder().decode(frame.payload.subarray(2)) : "";
			throw new Error(`server closed (${code})${reason ? `: ${reason}` : ""}`);
		}
		if (frame.opcode !== 0x1) throw new Error(`expected text server frame, got opcode ${frame.opcode}`);
		return decodeServerFrame(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
	}
	async nextOrClose(): Promise<RawWsFrame | undefined> {
		try {
			return await this.next();
		} catch {
			return undefined;
		}
	}
	async closed(): Promise<void> {
		await this.#closed.promise;
	}
	destroy(): void {
		this.#socket.destroy();
	}
	async close(): Promise<void> {
		if (this.#closedObserved) return;
		this.sendClose();
		this.#socket.end();
		await this.closed();
	}
}

export function frameBytes(opcode: number, payload: Uint8Array): Uint8Array {
	return maskedFrame(opcode, payload);
}
