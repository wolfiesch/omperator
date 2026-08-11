// Shared test helpers for the relay control-plane: a minimal collab-room
// relay (hosts connect with ?role=host, guests with /r/<roomId>.<key>; sealed
// envelopes fanned with guest peerId rewriting; guest disconnect notifies the
// host with a text peer-left frame) and a guest client speaking the sealed
// pipe protocol. Mirrors the semantics the /enclave plugin and T4CollabGuest
// rely on, and the wire behavior of scripts/relay-control.mjs.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function importKey(raw) {
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key, payload) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out;
}

export async function open(key, data) {
  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));
  return new Uint8Array(plaintext);
}

export function packEnvelope(peerId, sealed) {
  const out = new Uint8Array(4 + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, 4);
  return out;
}

export function unpackEnvelope(data) {
  return {
    peerId: new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false),
    payload: data.subarray(4),
  };
}

/** Minimal collab-room relay. */
export function startMockRelay() {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const rooms = new Map(); // roomId -> { host, guests: Map<ws, peerId>, nextPeerId }

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url, "http://relay.invalid");
    const match = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/u.exec(url.pathname);
    if (!match) {
      socket.close(4004, "no such room");
      return;
    }
    const roomId = match[1];
    const isHost = url.searchParams.get("role") === "host";
    if (isHost) {
      if (rooms.has(roomId)) {
        socket.close(4009, "host taken");
        return;
      }
      const room = { host: socket, guests: new Map(), nextPeerId: 1 };
      rooms.set(roomId, room);
      socket.on("close", () => {
        if (rooms.get(roomId) === room) {
          rooms.delete(roomId);
          for (const guest of room.guests.keys()) guest.close(4001, "room closed");
        }
      });
      socket.on("message", (data, isBinary) => {
        if (!isBinary || !rooms.has(roomId)) return;
        const envelope = unpackEnvelope(new Uint8Array(data));
        const peerId = envelope.peerId;
        if (peerId === 0) {
          for (const guest of room.guests.keys()) guest.send(data, { binary: true });
        } else {
          for (const [guest, id] of room.guests) {
            if (id === peerId) {
              guest.send(data, { binary: true });
              break;
            }
          }
        }
      });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      socket.close(4004, "no such room");
      return;
    }
    const peerId = room.nextPeerId++;
    room.guests.set(socket, peerId);
    socket.on("close", () => {
      if (room.guests.delete(socket) && room.host.readyState === WebSocket.OPEN) {
        room.host.send(JSON.stringify({ t: "peer-left", peer: peerId }));
      }
    });
    socket.on("message", (data, isBinary) => {
      if (!isBinary || room.host.readyState !== WebSocket.OPEN) return;
      // Rewrite the source prefix to this guest's assigned peerId.
      const envelope = unpackEnvelope(new Uint8Array(data));
      const rewritten = packEnvelope(peerId, envelope.payload);
      room.host.send(rewritten, { binary: true });
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({
        url: `ws://127.0.0.1:${address.port}`,
        close: async () => {
          for (const room of rooms.values()) {
            for (const guest of room.guests.keys()) guest.terminate();
            room.host.terminate();
          }
          await new Promise((resolveClose) => wss.close(() => resolveClose()));
          await new Promise((resolveClose) => server.close(() => resolveClose()));
        },
      });
    });
  });
}

/** Guest client speaking the sealed pipe protocol (the phone side). */
export class TestGuest {
  constructor(url) {
    this.url = url;
    this.messages = [];
    this.waiters = [];
  }

  async connect() {
    const match = /\/r\/([A-Za-z0-9_-]{10,64})\.([A-Za-z0-9_-]+)$/u.exec(this.url);
    assert.ok(match, "pairLink must be a /r/<roomId>.<key> URL");
    this.key = await importKey(Buffer.from(match[2], "base64url"));
    this.socket = new WebSocket(this.url);
    await new Promise((resolvePromise, reject) => {
      this.socket.once("open", resolvePromise);
      this.socket.once("error", reject);
    });
    this.socket.on("message", (data, isBinary) => {
      if (!isBinary) return;
      void (async () => {
        const envelope = unpackEnvelope(new Uint8Array(data));
        const plaintext = await open(this.key, envelope.payload);
        const frame = { type: plaintext[0], body: plaintext.subarray(1) };
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.messages.push(frame);
      })();
    });
  }

  nextMessage(timeoutMs = 2_000) {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolvePromise(frame);
      });
    });
  }

  async sendRaw(payload) {
    await this.socket.send(packEnvelope(0, await seal(this.key, payload)), { binary: true });
  }

  async sendPair(code) {
    await this.sendRaw(enc.encode(JSON.stringify({ t: "pair", code })));
  }

  async sendHostWire(text) {
    const bytes = enc.encode(text);
    const framed = new Uint8Array(1 + bytes.length);
    framed[0] = 0;
    framed.set(bytes, 1);
    await this.sendRaw(framed);
  }

  async sendBinary(bytes) {
    const framed = new Uint8Array(1 + bytes.length);
    framed[0] = 1;
    framed.set(bytes, 1);
    await this.sendRaw(framed);
  }

  close() {
    this.socket.close();
  }
}

export { dec };
