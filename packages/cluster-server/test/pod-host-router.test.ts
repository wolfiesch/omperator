import { expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketPodHostConnector } from "../src/pod-host-router.ts";

const welcome = {
	v: "omp-app/1",
	type: "welcome",
	selectedProtocol: "omp-app/1",
	hostId: "host-a",
	ompVersion: "17.0.5",
	ompBuild: "test",
	appserverVersion: "0.1.31",
	appserverBuild: "cluster-session",
	epoch: "pod-epoch",
	grantedCapabilities: [],
	grantedFeatures: [],
	negotiatedLimits: {},
	authentication: "paired",
	resumed: false,
} as const;
class MemoryWebSocket {
	readyState: number = WebSocket.CONNECTING;
	readonly sent = Promise.withResolvers<string>();
	readonly sentValues: string[] = [];
	readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = [];
	readonly #listeners: Record<string, Array<(event: unknown) => void>> = {};
	addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
		const callback = typeof listener === "function"
			? (event: unknown) => listener(event as Event)
			: (event: unknown) => listener.handleEvent(event as Event);
		(this.#listeners[type] ??= []).push(callback);
	}
	send(value: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.sent.resolve(String(value));
		this.sentValues.push(String(value));
	}
	close(code?: number, reason?: string): void { this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); this.readyState = WebSocket.CLOSED; }
	emit(type: string, event: unknown = {}): void {
		if (type === "open") this.readyState = WebSocket.OPEN;
		for (const listener of this.#listeners[type] ?? []) listener(event);
	}
}

it("pod connector reads the current projected identity and presents it in the existing hello authentication field", async () => {
	const directory = await mkdtemp(join(tmpdir(), "t4-pod-identity-"));
	try {
		const path = join(directory, "token");
		const token = `header.payload.${"s".repeat(64)}`;
		await writeFile(path, token, { mode: 0o400 });
		const socket = new MemoryWebSocket();
		const connector = new WebSocketPodHostConnector({
			identityTokenFile: path,
			webSocketFactory: () => socket as unknown as WebSocket,
		});
		const pending = connector.connect({ clusterSessionId: "session-one", url: "ws://session-one:8787/v1/ws" }, () => undefined);
		socket.emit("open");
		const hello = JSON.parse(await socket.sent.promise);
		expect(hello.authentication).toEqual({ deviceId: "cluster-server", deviceToken: token });
	socket.emit("message", { data: JSON.stringify(welcome) });
		const connection = await pending;
		expect(connection.hostId).toBe("host-a");
		connection.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("closes and rejects a malformed frame before the authenticated welcome", async () => {
	const directory = await mkdtemp(join(tmpdir(), "t4-pod-invalid-"));
	try {
		const path = join(directory, "token");
		await writeFile(path, `header.payload.${"s".repeat(64)}`, { mode: 0o400 });
		const socket = new MemoryWebSocket();
		const connector = new WebSocketPodHostConnector({ identityTokenFile: path, webSocketFactory: () => socket as unknown as WebSocket });
		const pending = connector.connect({ clusterSessionId: "session-one", url: "ws://session-one:8787/v1/ws" }, () => undefined);
		socket.emit("open");
		await socket.sent.promise;
		socket.emit("message", { data: "{" });
		await expect(pending).rejects.toThrow();
		expect(socket.closes).toContainEqual({ code: 1002, reason: "invalid upstream frame" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("keeps idle authority sockets alive without forwarding heartbeat pongs", async () => {
	vi.useFakeTimers();
	const directory = await mkdtemp(join(tmpdir(), "t4-pod-heartbeat-"));
	try {
		const path = join(directory, "token");
		await writeFile(path, `header.payload.${"s".repeat(64)}`, { mode: 0o400 });
		const socket = new MemoryWebSocket();
		const frames: unknown[] = [];
		const connector = new WebSocketPodHostConnector({ identityTokenFile: path, keepAliveMs: 10, webSocketFactory: () => socket as unknown as WebSocket });
		const pending = connector.connect({ clusterSessionId: "session-one", url: "ws://session-one:8787/v1/ws" }, frame => frames.push(frame));
		socket.emit("open");
		await socket.sent.promise;
		socket.emit("message", { data: JSON.stringify(welcome) });
		const connection = await pending;
		await vi.advanceTimersByTimeAsync(10);
		const heartbeat = JSON.parse(socket.sentValues.at(-1) ?? "{}");
		expect(heartbeat).toMatchObject({ v: "omp-app/1", type: "ping" });
		socket.emit("message", { data: JSON.stringify({ ...heartbeat, type: "pong" }) });
		expect(frames).toEqual([]);
		connection.close();
		const sent = socket.sentValues.length;
		await vi.advanceTimersByTimeAsync(20);
		expect(socket.sentValues).toHaveLength(sent);
	} finally {
		vi.useRealTimers();
		await rm(directory, { recursive: true, force: true });
	}
});
