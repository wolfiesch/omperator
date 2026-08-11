import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import {
	CmuxWebSocketBridge,
	isSingleJsonObject,
	type CmuxJsonlByteStream,
	type CmuxWebSocketPeer,
} from "../src/cmux-websocket.ts";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (value: Uint8Array): string => new TextDecoder().decode(value);

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
	readonly #values: Uint8Array[] = [];
	readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
	#ended = false;
	push(value: Uint8Array): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}
	end(): void {
		this.#ended = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: async () => {
				const value = this.#values.shift();
				if (value) return { done: false, value };
				if (this.#ended) return { done: true, value: undefined };
				const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
				this.#waiters.push(pending.resolve);
				return await pending.promise;
			},
		};
	}
}

class MemoryStream implements CmuxJsonlByteStream {
	readonly source = new AsyncByteQueue();
	readonly writes: Uint8Array[] = [];
	readonly readable = this.source;
	readonly writeGate?: Promise<void>;
	readonly #writeWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	readonly #writeStartWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	closed = 0;
	writeStarts = 0;
	ended = 0;
	failWrites = false;
	constructor(writeGate?: Promise<void>) { this.writeGate = writeGate; }
	async write(chunk: Uint8Array): Promise<void> {
		this.writeStarts++;
		for (const waiter of this.#writeStartWaiters.splice(0)) {
			if (this.writeStarts >= waiter.count) waiter.resolve();
			else this.#writeStartWaiters.push(waiter);
		}
		await this.writeGate;
		if (this.failWrites) throw new Error("write failed");
		this.writes.push(chunk.slice());
		for (const waiter of this.#writeWaiters.splice(0)) {
			if (this.writes.length >= waiter.count) waiter.resolve();
			else this.#writeWaiters.push(waiter);
		}
	}
	async waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return;
		const pending = Promise.withResolvers<void>();
		this.#writeWaiters.push({ count, resolve: pending.resolve });
		await pending.promise;
	}
	async waitForWriteStarts(count: number): Promise<void> {
		if (this.writeStarts >= count) return;
		const pending = Promise.withResolvers<void>();
		this.#writeStartWaiters.push({ count, resolve: pending.resolve });
		await pending.promise;
	}
	async end(): Promise<void> { this.ended++; }
	async close(): Promise<void> { this.closed++; this.source.end(); }
}

class MemoryPeer implements CmuxWebSocketPeer {
	readonly frames: string[] = [];
	readonly closes: Array<[number, string]> = [];
	readonly #frameWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	readonly #closeWaiters: Array<() => void> = [];
	accept = 1;
	sendText(value: string): number {
		this.frames.push(value);
		for (const waiter of this.#frameWaiters.splice(0)) {
			if (this.frames.length >= waiter.count) waiter.resolve();
			else this.#frameWaiters.push(waiter);
		}
		return this.accept;
	}
	close(code: number, reason: string): void {
		this.closes.push([code, reason]);
		for (const resolve of this.#closeWaiters.splice(0)) resolve();
	}
	async waitForFrames(count: number): Promise<void> {
		if (this.frames.length >= count) return;
		const pending = Promise.withResolvers<void>();
		this.#frameWaiters.push({ count, resolve: pending.resolve });
		await pending.promise;
	}
	async waitForClose(): Promise<void> {
		if (this.closes.length > 0) return;
		const pending = Promise.withResolvers<void>();
		this.#closeWaiters.push(pending.resolve);
		await pending.promise;
	}
}

function fixture(writeGate?: Promise<void>, limits?: { readonly maxFrameBytes?: number; readonly maxQueuedBytes?: number; readonly onProtocolMismatch?: () => void }) {
	const stream = new MemoryStream(writeGate);
	const peer = new MemoryPeer();
	const abort = new AbortController();
	const bridge = new CmuxWebSocketBridge(stream, peer, abort, undefined, limits);
	return { stream, peer, abort, bridge };
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
	let offset = 0;
	for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
	return output;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("direct cmux WebSocket framing bridge", () => {
	it("preserves client and upstream object bytes, ordering, whitespace, numbers, and base64 spelling", async () => {
		const { stream, peer, bridge } = fixture();
		bridge.start();
		const identify = '{ "cmd" : "identify", "n": 1e+03, "blob": "AQID==" }';
		bridge.receiveText(identify);
		stream.source.push(encode('{"event":"one","n":1e+03}\n {"event" : "two", "blob":"AQID=="} \n'));
		await Promise.all([stream.waitForWrites(1), peer.waitForFrames(2)]);
		expect(decode(joined(stream.writes))).toBe(`${identify}\n`);
		expect(stream.writes).toHaveLength(1);
		expect(sha256(joined(stream.writes))).toBe("139de96a2b5b983402face3340620a8f2443de8dcf3ca4dcb48c0ac12cd730ca");
		expect(peer.frames).toEqual(['{"event":"one","n":1e+03}', ' {"event" : "two", "blob":"AQID=="} ']);
		expect(sha256(peer.frames.join(""))).toBe("0da97f6bee15da8d6c379b130239596896c7bf84981934d885df73ef44a4ee06");
	});

	it("assembles chunked lines and emits every complete line in source order", async () => {
		const { stream, peer, bridge } = fixture();
		bridge.start();
		stream.source.push(encode('{"seq":'));
		stream.source.push(encode('1}\n{"seq":2}\n{"seq"'));
		stream.source.push(encode(':3}\n'));
		await peer.waitForFrames(3);
		expect(peer.frames).toEqual(['{"seq":1}', '{"seq":2}', '{"seq":3}']);
	});

	it("rejects binary, malformed UTF-8, empty, newline-bearing, non-object, multiple-object, and oversized frames", async () => {
		const cases: Array<(bridge: CmuxWebSocketBridge) => void> = [
			bridge => bridge.receiveBinary(),
			bridge => bridge.receiveText(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc3, 0x7d])),
			bridge => bridge.receiveText(""),
			bridge => bridge.receiveText('{"a":1}\n'),
			bridge => bridge.receiveText("[]"),
			bridge => bridge.receiveText('{"a":1}{"b":2}'),
			bridge => bridge.receiveText('{"long":"1234567890"}'),
		];
		for (const reject of cases) {
			const { peer, bridge } = fixture(undefined, { maxFrameBytes: 20 });
			reject(bridge);
			await peer.waitForClose();
			expect(peer.closes).toHaveLength(1);
			expect([1003, 1008, 1009]).toContain(peer.closes[0]![0]);
		}
	});

	it("reports rejected protocol shapes without counting size limits", async () => {
		let mismatches = 0;
		const malformed = fixture(undefined, { onProtocolMismatch: () => { mismatches++; } });
		malformed.bridge.receiveText("[]");
		await malformed.peer.waitForClose();
		const binary = fixture(undefined, { onProtocolMismatch: () => { mismatches++; } });
		binary.bridge.receiveBinary();
		await binary.peer.waitForClose();
		const oversized = fixture(undefined, { maxFrameBytes: 2, onProtocolMismatch: () => { mismatches++; } });
		oversized.bridge.receiveText('{"oversized":true}');
		await oversized.peer.waitForClose();
		expect(mismatches).toBe(2);
	});

	it("validates complete JSON syntax without restricting unknown cmux fields", () => {
		expect(isSingleJsonObject(encode(' {"unknown":[true,false,null,{"escaped":"\\u0041"}],"n":-0.5E-2} '))).toBe(true);
		for (const invalid of ['{"a":}', '{"a":01}', '{"a":"\\x"}', '{"a":1,}', 'true', '{} trailing'])
			expect(isSingleJsonObject(encode(invalid))).toBe(false);
	});

	it("rejects partial, invalid, multiple-object, and backpressured upstream lines", async () => {
		for (const input of ['{"partial":true}', '{"a":1}{"b":2}\n', '\n']) {
			const { stream, peer, bridge } = fixture();
			bridge.start();
			stream.source.push(encode(input));
			stream.source.end();
			await peer.waitForClose();
			expect(peer.closes[0]?.[0]).toBe(1008);
		}
		const outputBackpressure = fixture();
		outputBackpressure.peer.accept = 0;
		outputBackpressure.bridge.start();
		outputBackpressure.stream.source.push(encode('{"event":1}\n'));
		await outputBackpressure.peer.waitForClose();
		expect(outputBackpressure.peer.closes[0]?.[0]).toBe(1013);
	});

	it("bounds queued client input while the JSONL writer is backpressured", async () => {
		const gate = Promise.withResolvers<void>();
		const { peer, bridge } = fixture(gate.promise, { maxFrameBytes: 32, maxQueuedBytes: 20 });
		bridge.receiveText('{"value":1}');
		bridge.receiveText('{"value":2}');
		await peer.waitForClose();
		expect(peer.closes[0]?.[0]).toBe(1013);
		gate.resolve();
	});

	it("accounts for the JSONL delimiter and never starts a queued record after close", async () => {
		const delimiterOverflow = fixture(undefined, { maxFrameBytes: 32, maxQueuedBytes: 2 });
		delimiterOverflow.bridge.receiveText("{}");
		await delimiterOverflow.peer.waitForClose();
		expect(delimiterOverflow.peer.closes[0]?.[0]).toBe(1013);
		expect(delimiterOverflow.stream.writes).toEqual([]);

		const gate = Promise.withResolvers<void>();
		const cancelled = fixture(gate.promise, { maxFrameBytes: 32, maxQueuedBytes: 32 });
		cancelled.bridge.receiveText('{"first":1}');
		cancelled.bridge.receiveText('{"second":2}');
		await cancelled.stream.waitForWriteStarts(1);
		await cancelled.bridge.close(1008, "route revoked");
		gate.resolve();
		await cancelled.stream.waitForWrites(1);
		expect(cancelled.stream.writes.map(decode)).toEqual(['{"first":1}\n']);
	});

	it("closes both directions on backend failure, client close, and explicit drain", async () => {
		const failed = fixture();
		failed.stream.failWrites = true;
		failed.bridge.receiveText('{"cmd":"identify"}');
		await failed.peer.waitForClose();
		expect(failed.peer.closes[0]?.[0]).toBe(1011);
		expect(failed.abort.signal.aborted).toBe(true);
		expect(failed.stream.closed).toBe(1);

		const clientClosed = fixture();
		await clientClosed.bridge.clientClosed();
		expect(clientClosed.abort.signal.aborted).toBe(true);
		expect(clientClosed.stream.closed).toBe(1);

		const drained = fixture();
		await drained.bridge.close(1001, "cluster server draining");
		expect(drained.peer.closes).toEqual([[1001, "cluster server draining"]]);
		expect(drained.abort.signal.aborted).toBe(true);
		expect(drained.stream.closed).toBe(1);
	});
});
