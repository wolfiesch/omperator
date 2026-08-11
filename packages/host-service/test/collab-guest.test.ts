import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { parseCollabLink, readCollabLinkFromGateway } from "../src/collab/link.ts";
import { createCollabCipher, packEnvelope } from "../src/collab/crypto.ts";
import { COLLAB_PROTO, type CollabGuestFrame } from "../src/collab/frames.ts";
import { CollabGuestClient, type CollabGuestSnapshot } from "../src/collab/client.ts";
import { CollabSessionBridge, readCollabLink } from "../src/collab/bridge.ts";

const ROOM = "0123456789abcdefghijklmnopqrstuvwxyzAB";
const KEY = new Uint8Array(32).fill(7);
const TOKEN = new Uint8Array(16).fill(9);

function toB64(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return btoa(out).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const SECRET = toB64(new Uint8Array([...KEY, ...TOKEN]));
// The locked /enclave host publishes this in collab.json and requires the
// guest's hello to carry it as enclaveToken.
const ENCLAVE_TOKEN = toB64(TOKEN);

/** Parse a link and attach the collab.json token, mirroring readCollabLinkForTranscript. */
function linkWithToken(url: string, token: string): ReturnType<typeof parseCollabLink> & { token: string } {
	return { ...parseCollabLink(url), token };
}

describe("collab link parsing", () => {
	test("bare link resolves to default relay", () => {
		const link = parseCollabLink(`${ROOM}.${SECRET}`);
		expect(link.wsUrl).toBe(`wss://my.omp.sh/r/${ROOM}`);
		expect(link.roomId).toBe(ROOM);
		expect([...link.key]).toEqual([...KEY]);
		expect(link.writeToken && [...link.writeToken]).toEqual([...TOKEN]);
	});
	test("scheme-less host link prefixes wss", () => {
		const link = parseCollabLink(`relay.example.com:8443/r/${ROOM}.${SECRET}`);
		expect(link.wsUrl).toBe(`wss://relay.example.com:8443/r/${ROOM}`);
	});
	test("view link (bare key) has no write token", () => {
		const view = parseCollabLink(`${ROOM}.${toB64(KEY)}`);
		expect(view.writeToken).toBeUndefined();
	});
	test("web deep link recurses into fragment", () => {
		const link = parseCollabLink(`https://my.omp.sh/#${ROOM}.${SECRET}`);
		expect(link.wsUrl).toBe(`wss://my.omp.sh/r/${ROOM}`);
	});
	test("plain ws rejected for non-loopback", () => {
		expect(() => parseCollabLink(`ws://relay.example.com/r/${ROOM}.${SECRET}`)).toThrow();
	});
});

describe("collab crypto", () => {
	test("seal/open round trip", async () => {
		const cipher = createCollabCipher(KEY);
		const plain = new TextEncoder().encode(JSON.stringify({ t: "hello", proto: 3 }));
		const sealed = await cipher.seal(plain);
		const opened = await cipher.open(sealed);
		expect(new TextDecoder().decode(opened)).toBe('{"t":"hello","proto":3}');
	});
	test("wrong key fails to open", async () => {
		const cipher = createCollabCipher(KEY);
		const wrong = createCollabCipher(new Uint8Array(32).fill(1));
		const sealed = await cipher.seal(new Uint8Array(8));
		await expect(wrong.open(sealed)).rejects.toThrow();
	});
	test("envelope pack/unpack", () => {
		const env = packEnvelope(0, new Uint8Array([1, 2, 3]));
		expect(env.byteLength).toBe(7);
	});
});

describe("collab guest client flow", () => {
	test("joins, receives snapshot, sends prompt, streams frames", async () => {
		const cipher = createCollabCipher(KEY);
		const frames: CollabGuestFrame[] = [];
		let entryFrameCount = 0;

		const server = new WebSocketServer({ port: 0 });
		await new Promise<void>(resolve => server.once("listening", resolve));
		const port = (server.address() as { port: number }).port;

		server.on("connection", async (socket: any) => {
			// Relay hands the socket to the host, which reads the guest's hello
			// (sealed), replies welcome + snapshot, then streams an entry.
			socket.binaryType = "arraybuffer";
			socket.on("message", async (data: any) => {
				const bytes = new Uint8Array(data as ArrayBuffer);
				const plain = await cipher.open(bytes.subarray(4));
				const frame = JSON.parse(new TextDecoder().decode(plain)) as CollabGuestFrame;
				frames.push(frame);
				if (frame.t === "hello") {
					// Locked host: require the enclaveToken before serving the room.
					if (frame.enclaveToken !== ENCLAVE_TOKEN) {
						socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify({ t: "error", message: "missing or invalid enclaveToken" })))));
						socket.close();
						return;
					}
					const welcome = {
						t: "welcome",
						proto: COLLAB_PROTO,
						header: { id: "h", parentId: null, type: "session", timestamp: new Date().toISOString() },
						state: { isStreaming: false },
						agents: [],
						entryCount: 1,
					};
					const chunk = {
						t: "snapshot-chunk",
						entries: [{ id: "e1", parentId: null, type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } }],
						final: true,
					};
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(welcome)))));
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(chunk)))));
				} else if (frame.t === "prompt") {
					entryFrameCount += 1;
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify({
						t: "entry",
						entry: { id: "e2", parentId: null, type: "message", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: `echo: ${frame.text}` }] } },
					})))));
				}
			});
		});

		const link = linkWithToken(`ws://localhost:${port}/r/${ROOM}.${SECRET}`, ENCLAVE_TOKEN);
		const snapshots: CollabGuestSnapshot[] = [];
		const live: string[] = [];
		const client = new CollabGuestClient(link, {
			onSnapshot(snapshot) {
				snapshots.push(snapshot);
			},
			onFrame(frame) {
				if (frame.t === "entry") live.push((frame.entry.message as { role?: string })?.role ?? "");
			},
			onFatal() {
				expect.unreachable("should not go fatal");
			},
		});
		client.start();
		// Wait for snapshot.
		await Bun.sleep(500);
		expect(frames[0]).toMatchObject({ t: "hello", proto: 3, enclaveToken: ENCLAVE_TOKEN });
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].entries).toHaveLength(1);
		expect(snapshots[0].readOnly).toBe(false);

		client.prompt("hello there");
		await Bun.sleep(500);
		expect(frames.some(frame => frame.t === "prompt")).toBe(true);
		expect(live).toContain("assistant");

		client.close();
		server.close();
	});

	test("guest without token is rejected by a locked host", async () => {
		const cipher = createCollabCipher(KEY);
		const hellos: CollabGuestFrame[] = [];

		const server = new WebSocketServer({ port: 0 });
		await new Promise<void>(resolve => server.once("listening", resolve));
		const port = (server.address() as { port: number }).port;

		server.on("connection", async (socket: any) => {
			socket.binaryType = "arraybuffer";
			socket.on("message", async (data: any) => {
				const bytes = new Uint8Array(data as ArrayBuffer);
				const plain = await cipher.open(bytes.subarray(4));
				const frame = JSON.parse(new TextDecoder().decode(plain)) as CollabGuestFrame;
				hellos.push(frame);
				if (frame.t === "hello") {
					// Locked host: no enclaveToken → error frame + close.
					if (frame.enclaveToken !== ENCLAVE_TOKEN) {
						socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify({ t: "error", message: "missing or invalid enclaveToken" })))));
						socket.close();
						return;
					}
					expect.unreachable("token-less guest must not be served");
				}
			});
		});

		// parseCollabLink path yields no token (it comes from collab.json);
		// the guest therefore joins without enclaveToken.
		const link = parseCollabLink(`ws://localhost:${port}/r/${ROOM}.${SECRET}`);
		const frames: { t: string }[] = [];
		const client = new CollabGuestClient(link, {
			onSnapshot() {
				expect.unreachable("locked host must not admit the guest");
			},
			onFrame(frame) {
				frames.push({ t: frame.t });
			},
			onFatal() {},
		});
		client.start();
		await Bun.sleep(500);

		expect(hellos).toHaveLength(1);
		expect(hellos[0]).toMatchObject({ t: "hello" });
		expect(hellos[0]).not.toHaveProperty("enclaveToken");
		expect(frames.some(frame => frame.t === "error")).toBe(true);

		client.close();
		server.close();
	});
});

describe("collab bridge /enclave extension", () => {
	test("surfaces caps + plan ui-request, routes control and ui responses", async () => {
		const cipher = createCollabCipher(KEY);
		const received: { t: string }[] = [];

		const server = new WebSocketServer({ port: 0 });
		await new Promise<void>(resolve => server.once("listening", resolve));
		const port = (server.address() as { port: number }).port;

		server.on("connection", async (socket: any) => {
			socket.binaryType = "arraybuffer";
			socket.on("message", async (data: any) => {
				const bytes = new Uint8Array(data as ArrayBuffer);
				const plain = await cipher.open(bytes.subarray(4));
				const frame = JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
				received.push(frame as { t: string });
				if (frame.t === "hello") {
					// Locked host: require the enclaveToken before serving the room.
					if (frame.enclaveToken !== ENCLAVE_TOKEN) {
						socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify({ t: "error", message: "missing or invalid enclaveToken" })))));
						socket.close();
						return;
					}
					const welcome = { t: "welcome", proto: COLLAB_PROTO, header: { id: "h", parentId: null, type: "session", timestamp: new Date().toISOString() }, state: {}, agents: [], entryCount: 0 };
					const chunk = { t: "snapshot-chunk", entries: [], final: true };
					const caps = { t: "enclave-caps", version: 1, models: [{ id: "m1", name: "Model One" }], current: { model: "m1", thinking: "high" } };
					const plan = { t: "ui-request", request: { reqId: 7, kind: "plan", title: "Approve plan", helpText: "plan body" } };
					for (const frame of [welcome, chunk, caps, plan]) {
						socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(frame)))));
					}
				} else if (frame.t === "enclave-cmd") {
					const result = { t: "enclave-result", ok: true, message: `ran ${frame.method}`, reqId: frame.reqId };
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(result)))));
				} else if (frame.t === "ui-response") {
					const end = { t: "ui-request-end", reqId: frame.reqId };
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(end)))));
				}
			});
		});

		const link = linkWithToken(`ws://localhost:${port}/r/${ROOM}.${SECRET}`, ENCLAVE_TOKEN);
		const capsSeen: unknown[] = [];
		const uiSeen: unknown[] = [];
		const bridge = new (await import("../src/collab/bridge.ts")).CollabSessionBridge(
			"sid-1" as never, "/tmp/fake.jsonl", link, "host-test" as never,
			{
				rebase: () => {},
				appendEntry: () => {},
				appendEvent: () => {},
				setStreaming: () => {},
				onCaps: caps => capsSeen.push(caps),
				onUiRequest: request => uiSeen.push(request),
				fatal: () => {},
			},
			() => {},
		);
		bridge.start();
		await Bun.sleep(600);

		expect(capsSeen).toHaveLength(1);
		expect((capsSeen[0] as { current?: { model?: string } }).current?.model).toBe("m1");
		expect(uiSeen).toHaveLength(1);
		expect((uiSeen[0] as { kind?: string }).kind).toBe("plan");

		const result = await bridge.control("set-model", { model: "m2" });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("ran set-model");
		expect(received.some(f => f.t === "enclave-cmd")).toBe(true);

		bridge.uiResponse(7, "approve");
		await Bun.sleep(300);
		expect(received.some(f => f.t === "ui-response")).toBe(true);

		bridge.dispose();
		server.close();
	});
});

describe("collab gateway room discovery", () => {
	test("bridges a room from the gateway registry when collab.json is absent", async () => {
		const cipher = createCollabCipher(KEY);
		// Real socket round trips: resolve on the actual frames instead of
		// sleeping a fixed duration.
		let resolveHello!: (frame: CollabGuestFrame) => void;
		const helloSeen = new Promise<CollabGuestFrame>(resolve => {
			resolveHello = resolve;
		});

		// Relay/host serving the room the gateway entry points at (locked:
		// requires the room token, which the gateway entry carries).
		const relay = new WebSocketServer({ port: 0 });
		await new Promise<void>(resolve => relay.once("listening", resolve));
		const relayPort = (relay.address() as { port: number }).port;
		relay.on("connection", async (socket: any) => {
			socket.binaryType = "arraybuffer";
			socket.on("message", async (data: any) => {
				const bytes = new Uint8Array(data as ArrayBuffer);
				const plain = await cipher.open(bytes.subarray(4));
				const frame = JSON.parse(new TextDecoder().decode(plain)) as CollabGuestFrame;
				if (frame.t === "hello") {
					resolveHello(frame);
					if (frame.enclaveToken !== ENCLAVE_TOKEN) {
						socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify({ t: "error", message: "missing or invalid enclaveToken" })))));
						socket.close();
						return;
					}
					const welcome = {
						t: "welcome",
						proto: COLLAB_PROTO,
						header: { id: "h", parentId: null, type: "session", timestamp: new Date().toISOString() },
						state: { isStreaming: false },
						agents: [],
						entryCount: 1,
					};
					const chunk = {
						t: "snapshot-chunk",
						entries: [{ id: "e1", parentId: null, type: "message", timestamp: new Date().toISOString(), message: { role: "user", content: "hi" } }],
						final: true,
					};
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(welcome)))));
					socket.send(packEnvelope(0, await cipher.seal(new TextEncoder().encode(JSON.stringify(chunk)))));
				}
			});
		});

		// Mock gateway: serves the /v1/rooms envelope from its push registry.
		const roomLink = `ws://localhost:${relayPort}/r/${ROOM}.${SECRET}`;
		const gateway = createServer((req, res) => {
			res.setHeader("content-type", "application/json");
			if (req.url === "/v1/rooms") {
				res.end(JSON.stringify({
					rooms: [{ sessionId: "sid-gw", title: "Gateway room", roomId: ROOM, link: roomLink, token: ENCLAVE_TOKEN }],
				}));
				return;
			}
			res.statusCode = 404;
			res.end("{}");
		});
		await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
		const gatewayPort = (gateway.address() as { port: number }).port;
		const previous = process.env.ENCLAVE_GATEWAY_URL;
		process.env.ENCLAVE_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;

		try {
			// No collab.json: the transcript file does not exist, so the room
			// link must come from the gateway registry.
			const link = await readCollabLink("sid-gw" as never, "/tmp/no-such-session.jsonl");
			expect(link).toBeDefined();
			expect(link!.wsUrl).toBe(`ws://localhost:${relayPort}/r/${ROOM}`);
			expect(link!.token).toBe(ENCLAVE_TOKEN);

			let resolveRebase!: (entries: readonly unknown[]) => void;
			const rebased = new Promise<readonly unknown[]>(resolve => {
				resolveRebase = resolve;
			});
			const bridge = new CollabSessionBridge(
				"sid-gw" as never,
				"/tmp/no-such-session.jsonl",
				link!,
				"host-test" as never,
				{
					rebase: entries => resolveRebase(entries),
					appendEntry: () => {},
					appendEvent: () => {},
					setStreaming: () => {},
					fatal: () => {},
				},
				() => {},
			);
			bridge.start();

			const [hello, entries] = await Promise.all([helloSeen, rebased]);
			expect(hello).toMatchObject({ t: "hello", proto: 3, enclaveToken: ENCLAVE_TOKEN });
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({ data: { role: "user", text: "hi" } });

			bridge.dispose();
		} finally {
			if (previous === undefined) delete process.env.ENCLAVE_GATEWAY_URL;
			else process.env.ENCLAVE_GATEWAY_URL = previous;
			relay.close();
			gateway.close();
		}
	});

	test("returns undefined when the gateway has no matching room", async () => {
		const gateway = createServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({
				rooms: [{ sessionId: "other", roomId: ROOM, link: `ws://localhost:1/r/${ROOM}.${SECRET}` }],
			}));
		});
		await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
		const gatewayPort = (gateway.address() as { port: number }).port;
		const previous = process.env.ENCLAVE_GATEWAY_URL;
		process.env.ENCLAVE_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`;
		try {
			await expect(readCollabLinkFromGateway("sid-gw")).resolves.toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.ENCLAVE_GATEWAY_URL;
			else process.env.ENCLAVE_GATEWAY_URL = previous;
			gateway.close();
		}
	});
});
