import { describe, expect, test } from "bun:test";
import { WebSocketServer } from "ws";
import { parseCollabLink } from "../src/collab/link.ts";
import { createCollabCipher, packEnvelope } from "../src/collab/crypto.ts";
import { COLLAB_PROTO, type CollabGuestFrame } from "../src/collab/frames.ts";
import { CollabGuestClient, type CollabGuestSnapshot } from "../src/collab/client.ts";

const ROOM = "0123456789abcdefghijklmnopqrstuvwxyzAB";
const KEY = new Uint8Array(32).fill(7);
const TOKEN = new Uint8Array(16).fill(9);

function toB64(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return btoa(out).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const SECRET = toB64(new Uint8Array([...KEY, ...TOKEN]));

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

		const link = parseCollabLink(`ws://localhost:${port}/r/${ROOM}.${SECRET}`);
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
		expect(frames[0]).toMatchObject({ t: "hello", proto: 3 });
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
});
