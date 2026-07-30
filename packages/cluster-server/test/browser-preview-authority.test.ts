import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it } from "vite-plus/test";
import { hostId, sessionId } from "@t4-code/host-wire";
import { operationCapabilities, operationFeatures, type OperationContext } from "@t4-code/host-service";
import {
	BrowserPreviewAuthority,
	LoopbackCdpTransport,
	createBrowserPreviewOperations,
	mergeBrowserPreviewOperations,
	projectBrowserRuntime,
	type CdpTargetTransport,
} from "../src/browser-preview-authority.ts";

class SharedChromiumFake implements CdpTargetTransport {
	readonly targets = new Map<string, { url: string; closed: boolean }>();
	readonly calls: Array<{ targetId: string; method: string; params?: Readonly<Record<string, unknown>> }> = [];
	readonly #generationLossListeners = new Set<(generation: number) => void>();
	generation = 1;
	#next = 1;

	onGenerationLoss(listener: (generation: number) => void): () => void {
		this.#generationLossListeners.add(listener);
		return () => { this.#generationLossListeners.delete(listener); };
	}
	loseGeneration(): void {
		const generation = this.generation;
		this.generation += 1;
		for (const listener of this.#generationLossListeners) listener(generation);
		for (const [id, target] of this.targets) if (id.startsWith("preview-")) target.closed = true;
	}
	createCmuxTarget(url: string): string {
		const id = `cmux-${this.#next++}`;
		this.targets.set(id, { url, closed: false });
		return id;
	}
	async createTarget(url: string): Promise<string> {
		const id = `preview-${this.#next++}`;
		this.targets.set(id, { url, closed: false });
		return id;
	}
	async closeTarget(targetId: string): Promise<void> {
		const target = this.targets.get(targetId);
		if (!target) throw new Error("missing target");
		target.closed = true;
		this.calls.push({ targetId, method: "Target.closeTarget" });
	}
	async activateTarget(targetId: string): Promise<void> { this.calls.push({ targetId, method: "Target.activateTarget" }); }
	async command<T extends Record<string, unknown> = Record<string, unknown>>(targetId: string, method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
		const target = this.targets.get(targetId);
		if (!target || target.closed) throw new Error("missing target");
		this.calls.push({ targetId, method, params });
		if (method === "Page.navigate" && typeof params?.url === "string") target.url = params.url;
		if (method === "Runtime.evaluate") {
			const expression = String(params?.expression ?? "");
			if (expression === "location.href") return { result: { value: target.url } } as unknown as T;
			if (expression === "document.title") return { result: { value: "Conformance page" } } as unknown as T;
			return { result: { value: true } } as unknown as T;
		}
		if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{ id: 1, url: target.url }] } as unknown as T;
		if (method === "Page.captureScreenshot") return { data: Buffer.from("bounded-png").toString("base64") } as unknown as T;
		if (method === "DOM.getDocument") return { root: { nodeId: 1 } } as unknown as T;
		if (method === "DOM.querySelector") return { nodeId: 2 } as unknown as T;
		return {} as T;
	}
	async close(): Promise<void> { return; }
}


interface CdpFixture {
	readonly endpoint: string;
	readonly methods: string[];
	readonly frames: Array<{ method: string; params: Record<string, unknown> }>;
	closeSockets(): void;
	close(): Promise<void>;
}

async function cdpFixture(failedMethod?: string): Promise<CdpFixture> {
	const methods: string[] = [];
	const frames: Array<{ method: string; params: Record<string, unknown> }> = [];
	const server = createServer((_request, response) => {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("CDP fixture address is unavailable");
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}` }));
	});
	const sockets = new Set<WebSocket>();
	const websocket = new WebSocketServer({ server });
	websocket.on("connection", socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("message", raw => {
			const frame = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown> };
			methods.push(frame.method);
			frames.push({ method: frame.method, params: frame.params ?? {} });
			if (frame.method === failedMethod) {
				socket.send(JSON.stringify({ id: frame.id, error: { code: -1, message: "injected failure" } }));
				return;
			}
			const result = frame.method === "Target.createBrowserContext" ? { browserContextId: "preview-context" }
				: frame.method === "Target.createTarget" ? { targetId: "preview-target" }
					: frame.method === "Target.attachToTarget" ? { sessionId: "preview-session" }
						: {};
			socket.send(JSON.stringify({ id: frame.id, result }));
		});
	});
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("CDP fixture address is unavailable");
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		methods,
		closeSockets: () => { for (const socket of sockets) socket.close(); },
		frames,
		close: async () => {
			for (const socket of sockets) socket.terminate();
			websocket.close();
			server.close();
		},
	};
}
const HOST = hostId("pod:runtime-test");
const SESSION = sessionId("session-test");
const context: OperationContext = {
	hostId: HOST,
	sessionId: SESSION,
	deviceId: "device-one",
	connectionId: "connection-one",
	capabilities: new Set(["preview.read", "preview.control", "preview.input"]),
	abortSignal: new AbortController().signal,
};

describe("cluster browser runtime projection", () => {
	it("uses only the supervised loopback CDP endpoint for both cmux v10 and preview", () => {
		const projection = projectBrowserRuntime({ mode: "durable", stateDirectory: "/runtime-state/runtime-one/browser" });
		expect(projection).toEqual({
			enabled: true,
			chromiumArguments: [
				"--remote-debugging-address=127.0.0.1",
				"--remote-debugging-port=9222",
				"--user-data-dir=/runtime-state/runtime-one/browser",
			],
			cmuxEnvironment: { CMUX_MUX_CDP_URL: "http://127.0.0.1:9222" },
			previewEnabled: true,
		});
		expect(JSON.stringify(projection)).not.toContain("webSocketDebuggerUrl");
	});

	it("projects no process, cmux endpoint, preview method, feature, or capability when disabled", () => {
		const projection = projectBrowserRuntime({ mode: "disabled" });
		const created = createBrowserPreviewOperations(
			{ mode: "disabled" },
			{ hostId: HOST, sessionId: SESSION, workspaceRoot: "/workspace", transport: new SharedChromiumFake() },
		);
		expect(projection).toEqual({ enabled: false, chromiumArguments: [], cmuxEnvironment: {}, previewEnabled: false });
		expect(created.authority).toBeUndefined();
		const operations = mergeBrowserPreviewOperations(
			{ filesRead: async () => ({ content: "kept" }), previewLaunch: async () => ({ preview: {} }) },
			created.operations,
		);
		expect(operationCapabilities(operations)).toEqual(new Set(["files.read"]));
		expect(operationFeatures(operations)).toEqual(new Set());
	});

	it("rejects public, credentialed, and routed CDP authorities before connecting", () => {
		for (const endpoint of [
			"http://0.0.0.0:9222",
			"http://10.0.0.8:9222",
			"https://127.0.0.1:9222",
			"http://user:password@127.0.0.1:9222",
			"http://127.0.0.1:9222/json/version",
		]) expect(() => new LoopbackCdpTransport(endpoint)).toThrow();
	});
});

describe("bounded CDP preview authority", () => {
	it("controls an owned preview target without taking or closing the cmux browser target", async () => {
		const transport = new SharedChromiumFake();
		const cmuxTarget = transport.createCmuxTarget("https://cmux.example/pane");
		const authority = new BrowserPreviewAuthority({ hostId: HOST, sessionId: SESSION, workspaceRoot: "/workspace", transport, epoch: "preview-epoch" });
		const operations = authority.operations();
		const launched = await operations.previewLaunch!({ url: "https://user:secret@example.test/start?token=never#secret" }, context) as Record<string, unknown>;
		const launch = launched.preview as Record<string, unknown>;
		expect(launch).toMatchObject({ state: "ready", url: "https://example.test/start", title: "Conformance page" });
		expect(JSON.stringify(launch)).not.toContain("secret");
		expect(JSON.stringify(launch)).not.toContain("token");
		expect(JSON.stringify(launch)).not.toContain("9222");
		const previewId = String(launch.previewId);

		const navigated = await operations.previewNavigate!({ previewId, url: "https://example.test/next", leaseId: undefined }, context) as Record<string, unknown>;
		expect(navigated.preview).toMatchObject({ url: "https://example.test/next" });
		await operations.previewType!({ previewId, text: "hello", selector: "input" }, context);
		const captured = await operations.previewCapture!({ previewId }, context) as Record<string, unknown>;
		const capture = (captured.preview as Record<string, unknown>).capture as Record<string, unknown>;
		const read = await operations.previewCaptureRead!({ previewId, captureId: capture.captureId, offset: 0 }, context);
		expect(read).toMatchObject({ previewId, size: 11, offset: 0, nextOffset: 11, complete: true });
		expect(Buffer.from(String((read as Record<string, unknown>).content), "base64").toString()).toBe("bounded-png");

		await operations.previewClose!({ previewId }, context);
		expect(transport.targets.get(cmuxTarget)).toEqual({ url: "https://cmux.example/pane", closed: false });
		expect([...transport.targets.entries()].filter(([id]) => id.startsWith("preview-"))).toHaveLength(1);
		expect([...transport.targets.entries()].find(([id]) => id.startsWith("preview-"))?.[1].closed).toBe(true);
		expect(transport.calls).toContainEqual(expect.objectContaining({ method: "Input.insertText" }));
		expect(transport.calls).toContainEqual(expect.objectContaining({ method: "Page.captureScreenshot" }));
	});

	it("fences runtime/session ownership and lease control", async () => {
		const transport = new SharedChromiumFake();
		const authority = new BrowserPreviewAuthority({ hostId: HOST, sessionId: SESSION, workspaceRoot: "/workspace", transport });
		const operations = authority.operations();
		const launched = await operations.previewLaunch!({ url: "https://example.test" }, context) as Record<string, unknown>;
		const previewId = String((launched.preview as Record<string, unknown>).previewId);
		expect(authority.activity()).toEqual({ browserPreviews: 1, browserLeases: 0 });
		const acquired = await operations.previewLeaseAcquire!({ previewId, ttlMs: 1_000 }, context) as Record<string, unknown>;
		expect(authority.activity()).toEqual({ browserPreviews: 1, browserLeases: 1 });
		await expect(operations.previewNavigate!({ previewId, url: "https://example.test/denied" }, { ...context, connectionId: "connection-two" })).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(operations.previewState!({}, { ...context, sessionId: sessionId("session-other") })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(operations.previewNavigate!({ previewId, url: "https://example.test/allowed", leaseId: acquired.leaseId }, context)).resolves.toMatchObject({ preview: { url: "https://example.test/allowed" } });
		await operations.previewLeaseRelease!({ previewId, leaseId: acquired.leaseId }, context);
		expect(authority.activity()).toEqual({ browserPreviews: 1, browserLeases: 0 });
		await authority.close();
	});

	it("bounds owned targets and capture memory", async () => {
		const transport = new SharedChromiumFake();
		const authority = new BrowserPreviewAuthority({ hostId: HOST, sessionId: SESSION, workspaceRoot: "/workspace", transport, maxPreviews: 1, maxCaptureMemoryBytes: 8 * 1024 * 1024 });
		const operations = authority.operations();
		await operations.previewLaunch!({ url: "https://example.test/one" }, context);
		await expect(operations.previewLaunch!({ url: "https://example.test/two" }, context)).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("canonicalizes bounded regular uploads and rejects symlinks, directories, and oversized files before CDP upload", async () => {
		const temporary = await realpath(await mkdtemp(join(tmpdir(), "t4-preview-upload-")));
		const workspace = join(temporary, "workspace");
		const outside = join(temporary, "outside.txt");
		try {
			await mkdir(workspace);
			await writeFile(outside, "private");
			await writeFile(join(workspace, "safe.txt"), "safe");
			await symlink(outside, join(workspace, "linked.txt"));
			await mkdir(join(workspace, "directory"));
			await writeFile(join(workspace, "oversized.bin"), "");
			await truncate(join(workspace, "oversized.bin"), 8 * 1024 * 1024 + 1);
			const transport = new SharedChromiumFake();
			const authority = new BrowserPreviewAuthority({ hostId: HOST, sessionId: SESSION, workspaceRoot: workspace, transport });
			const operations = authority.operations();
			const launched = await operations.previewLaunch!({ url: "https://example.test" }, context) as Record<string, unknown>;
			const previewId = String((launched.preview as Record<string, unknown>).previewId);

			for (const path of ["linked.txt", "directory", "oversized.bin"])
				await expect(operations.previewUpload!({ previewId, selector: "input[type=file]", path }, context)).rejects.toMatchObject({
					code: path === "linked.txt" ? "FORBIDDEN" : "CONFLICT",
				});
			expect(transport.calls.some(call => call.method === "DOM.setFileInputFiles")).toBe(false);

			await operations.previewUpload!({ previewId, selector: "input[type=file]", path: "safe.txt" }, context);
			const uploadCall = transport.calls.find(call =>
				call.method === "Runtime.evaluate" && String(call.params?.expression ?? "").includes("DataTransfer")
			);
			expect(uploadCall).toBeDefined();
			expect(String(uploadCall?.params?.expression)).toContain("c2FmZQ==");
			expect(String(uploadCall?.params?.expression)).not.toContain("private");
			expect(transport.calls.some(call => call.method === "DOM.setFileInputFiles")).toBe(false);
			await authority.close();
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	});

	it("atomically evicts preview records and captures on transport generation loss without touching cmux targets", async () => {
		const transport = new SharedChromiumFake();
		const cmuxTarget = transport.createCmuxTarget("https://cmux.example/kept");
		const authority = new BrowserPreviewAuthority({
			hostId: HOST,
			sessionId: SESSION,
			workspaceRoot: "/workspace",
			transport,
			maxPreviews: 1,
			maxCaptureMemoryBytes: 8 * 1024 * 1024,
		});
		const operations = authority.operations();
		const launched = await operations.previewLaunch!({ url: "https://example.test/old" }, context) as Record<string, unknown>;
		const previewId = String((launched.preview as Record<string, unknown>).previewId);
		const captured = await operations.previewCapture!({ previewId }, context) as Record<string, unknown>;
		const captureId = String(((captured.preview as Record<string, unknown>).capture as Record<string, unknown>).captureId);

		transport.loseGeneration();

		await expect(operations.previewState!({}, context)).resolves.toEqual({ previews: [] });
		await expect(operations.previewCaptureRead!({ previewId, captureId, offset: 0 }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(operations.previewLaunch!({ url: "https://example.test/new" }, context)).resolves.toMatchObject({ preview: { state: "ready" } });
		expect(transport.targets.get(cmuxTarget)).toEqual({ url: "https://cmux.example/kept", closed: false });
		await authority.close();
	});
	it("fails durable checkpoint when the browser owner cannot acknowledge profile flush", async () => {
		const authority = new BrowserPreviewAuthority({
			hostId: HOST,
			sessionId: SESSION,
			workspaceRoot: "/workspace",
			transport: new SharedChromiumFake(),
		});
		await expect(authority.checkpoint()).rejects.toThrow("does not support durable checkpoint");
	});

});

describe("loopback CDP transport lifecycle", () => {
	it("closes the owned target when any post-attach initialization command fails", async () => {
		for (const failedMethod of ["Page.enable", "Runtime.enable", "Emulation.setDeviceMetricsOverride"]) {
			const fixture = await cdpFixture(failedMethod);
			const transport = new LoopbackCdpTransport(fixture.endpoint, 500);
			try {
				await expect(transport.createTarget("https://example.test")).rejects.toThrow("CDP command failed");
				expect(fixture.methods).toContain("Target.closeTarget");
			} finally {
				await transport.close();
				await fixture.close();
			}
		}
	});

	it("reports socket generation loss and reconnects with a fresh isolated preview context", async () => {
		const fixture = await cdpFixture();
		const transport = new LoopbackCdpTransport(fixture.endpoint, 500);
		try {
			await transport.createTarget("https://example.test/one");
			expect(transport.generation).toBe(1);
			const lost = Promise.withResolvers<number>();
			const unsubscribe = transport.onGenerationLoss(lost.resolve);
			fixture.closeSockets();
			await expect(lost.promise).resolves.toBe(1);
			await transport.createTarget("https://example.test/two");
			expect(transport.generation).toBe(2);
			expect(fixture.methods.filter(method => method === "Target.createBrowserContext")).toHaveLength(2);
			expect(fixture.frames).toContainEqual({ method: "Target.createBrowserContext", params: { disposeOnDetach: true } });
			expect(fixture.frames).toContainEqual(expect.objectContaining({
				method: "Target.createTarget",
				params: expect.objectContaining({ browserContextId: "preview-context" }),
			}));
			unsubscribe();
		} finally {
			await transport.close();
			await fixture.close();
		}
	});
	it("acknowledges checkpoint only after Browser.close succeeds", async () => {
		const fixture = await cdpFixture();
		const transport = new LoopbackCdpTransport(fixture.endpoint, 500);
		try {
			await transport.createTarget("https://example.test/checkpoint");
			await transport.checkpoint();
			expect(fixture.methods).toContain("Browser.close");
		} finally {
			await transport.close();
			await fixture.close();
		}
	});

});
