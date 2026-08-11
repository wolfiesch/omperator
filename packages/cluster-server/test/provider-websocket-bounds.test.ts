import { EventEmitter } from "node:events";
import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { websocketStream } from "../src/kubernetes-cmux-route-opener.ts";
import { ProviderWebSocketTransport } from "../src/server.ts";

class FakeWebSocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	terminated = 0;
	terminate(): void { this.terminated++; this.readyState = WebSocket.CLOSED; }
	close(_code?: number, _reason?: string): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
	send(_chunk: Uint8Array, _options: object, callback: (error?: Error) => void): void { callback(); }
}

describe("provider WebSocket inbound queue bounds", () => {
	it("closes the cluster provider transport at its inbound byte high-water mark", async () => {
		const closes: Array<[number | undefined, string | undefined]> = [];
		const transport = new ProviderWebSocketTransport({ send: () => 1, getBufferedAmount: () => 0, close: (code?: number, reason?: string) => { closes.push([code, reason]); } });
		transport.receive(Buffer.alloc(700_000));
		transport.receive(Buffer.alloc(400_000));
		expect(closes).toEqual([[1009, "provider inbound queue limit exceeded"]]);
		const iterator = transport.readable[Symbol.asyncIterator]();
		expect((await iterator.next()).value?.byteLength).toBe(700_000);
		expect((await iterator.next()).done).toBeTruthy();
	});

	it("terminates the Kubernetes cmux upstream at its inbound byte high-water mark", async () => {
		const socket = new FakeWebSocket();
		const stream = websocketStream(socket, new AbortController().signal);
		socket.emit("message", Buffer.alloc(700_000));
		socket.emit("message", Buffer.alloc(400_000));
		expect(socket.terminated).toBe(1);
		const iterator = stream.readable[Symbol.asyncIterator]();
		expect((await iterator.next()).value?.byteLength).toBe(700_000);
		await expect(iterator.next()).rejects.toThrow("inbound queue limit");
	});

	it("bounds fragmented ws RawData before joining it", async () => {
		const socket = new FakeWebSocket();
		const stream = websocketStream(socket, new AbortController().signal);
		socket.emit("message", [Buffer.alloc(700_000), Buffer.alloc(400_000)]);
		expect(socket.terminated).toBe(1);
		await expect(stream.readable[Symbol.asyncIterator]().next()).rejects.toThrow("inbound queue limit");
	});
});
