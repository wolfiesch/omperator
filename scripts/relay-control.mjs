#!/usr/bin/env node
//
// relay-control.mjs — E2E control-plane adapter for the public (relay) model.
//
// The host's gateway runs this when T4_RELAY_URL is configured. It hosts one
// outbound "control room" per phone on the public relay (the same room
// machinery the /enclave plugin uses for collab, so the relay is a dumb
// sealed-envelope pipe — it never sees plaintext):
//
//   phone ──wss──▶ wickrunner relay ◀──wss── gateway (this adapter)
//                 (dumb fan-out)                │
//                                              ▼
//                                        appserver socket
//
// Flow:
//  1. The desktop calls GET /v1/pair-code on the gateway (loopback). The
//     adapter mints a 6-digit one-time code + a control room (random E2E key)
//     and registers {hostId, code, pairLink} with the rendezvous.
//  2. The phone redeems the code at the rendezvous (POST /v1/pair) and gets
//     the pairLink (the room key). Only the code holder can do this, and only
//     once.
//  3. The phone joins the room. Its first sealed frame must be
//     { t: "pair", code } — the adapter validates the code (independent of the
//     rendezvous), binds the peer, and opens a host-wire WebSocket to the
//     appserver socket. All subsequent frames flow phone↔appserver, encrypted
//     end to end; the appserver sees one local (open) host-wire client per
//     phone, so ALL auth for this path lives in the code + room key.
//  4. A phone that disconnects and rejoins with the SAME link is rebinding
//     (the link is the credential) — no code needed; persisted links give
//     silent reconnect.
//
// Inside the seal, host-wire frames carry a 1-byte type prefix so text
// (JSON frames) and binary (captures/uploads) survive the pipe:
//   [0x00] UTF-8 text  |  [0x01] binary
//
// Pairing codes: 6 digits, single-use, 10-minute TTL, per-room attempt cap.
// Rooms are in-memory: a gateway restart invalidates codes and control links,
// and the phone falls back to a fresh code from the desktop.

import { randomBytes } from "node:crypto";
import { connect as connectSocket } from "node:net";
import WebSocket from "ws";

export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ROOMS = 16;
export const MAX_PAIR_ATTEMPTS = 5;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

// ── sealed-envelope codec (mirror of the collab codec) ───────────────────────

const subtle = globalThis.crypto?.subtle;

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function importRoomKey(raw) {
  return subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(key, payload) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
  const out = new Uint8Array(12 + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ciphertext), 12);
  return out;
}

async function open(key, data) {
  if (data.byteLength < 12) return undefined;
  try {
    const plaintext = await subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12));
    return new Uint8Array(plaintext);
  } catch {
    return undefined;
  }
}

function packEnvelope(peerId, sealed) {
  const out = new Uint8Array(4 + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, 4);
  return out;
}

function unpackEnvelope(data) {
  if (data.byteLength < 4) return undefined;
  return {
    peerId: new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false),
    payload: data.subarray(4),
  };
}

// ── validation ────────────────────────────────────────────────────────────────

export function normalizeRelayUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error("T4_RELAY_URL is invalid");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("T4_RELAY_URL must be a valid ws(s) URL");
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.host === "") {
    throw new Error("T4_RELAY_URL must be a valid ws(s) URL");
  }
  return url.toString().replace(/\/+$/u, "");
}

function randomSixDigitCode() {
  // Rejection sampling for a uniform 0..999999 draw from 32 bits.
  for (;;) {
    const value = new DataView(randomBytes(4).buffer).getUint32(0, false);
    if (value < 4_294_967_000) return String(value % 1_000_000).padStart(6, "0");
  }
}

function jsonText(data) {
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return undefined;
  }
}

// ── the adapter ───────────────────────────────────────────────────────────────

/**
 * Start the E2E control-plane adapter. `options`:
 *   relayUrl        ws(s) URL of the public relay (required)
 *   rendezvousUrl   https URL of the rendezvous (optional; registration best-effort)
 *   hostId          stable host identity for the rendezvous (deployment identity)
 *   appSocketPath   appserver Unix socket the upstream host-wire connects to
 *   log             logger with .error/.warn/.info (defaults to console)
 * Returns { mintPairCode, status, stop }.
 */
export function startRelayControl(options) {
  const { relayUrl, rendezvousUrl, hostId, appSocketPath } = options;
  const log = options.log ?? console;
  const rooms = new Map(); // roomId -> room
  let stopped = false;

  // ── per-room lifecycle ──────────────────────────────────────────────────────

  function dropRoom(room, reason) {
    if (rooms.get(room.roomId) !== room) return;
    rooms.delete(room.roomId);
    closeUpstream(room);
    try {
      room.ws?.close(4001, reason);
    } catch {}
    log.info("relay.room.close", { roomId: room.roomId, reason });
  }

  function closeUpstream(room) {
    if (room.upstream) {
      try {
        room.upstream.close(1000, "peer gone");
      } catch {}
      room.upstream = undefined;
    }
  }

  function roomExpired(room) {
    return room.expiresAt <= Date.now();
  }

  function sendToPeer(room, payload) {
    if (!room.ws || room.ws.readyState !== WebSocket.OPEN || room.boundPeer === undefined) return;
    try {
      void seal(room.key, payload).then((sealed) => {
        if (room.ws.readyState === WebSocket.OPEN) {
          room.ws.send(packEnvelope(room.boundPeer, sealed), { binary: true });
        }
      });
    } catch {
      // socket closed
    }
  }

  function createUpstream(room) {
    const upstream = new WebSocket("ws://omp.local/ws", {
      perMessageDeflate: false,
      maxPayload: MAX_FRAME_BYTES,
      createConnection: () => connectSocket({ path: appSocketPath }),
    });
    room.upstream = upstream;
    // The appserver socket may still be connecting when the first host-wire
    // frames arrive (the phone sends right after pairing); buffer until open.
    const pending = [];
    let pendingBytes = 0;
    upstream.on("open", () => {
      for (const item of pending) upstream.send(item.payload, { binary: item.isBinary });
      pending.length = 0;
      pendingBytes = 0;
    });
    upstream.on("message", (data, isBinary) => {
      const payload = Buffer.from(data);
      const framed = new Uint8Array(1 + payload.length);
      framed[0] = isBinary ? 1 : 0;
      framed.set(payload, 1);
      sendToPeer(room, framed);
    });
    upstream.on("close", () => {
      if (room.upstream === upstream) room.upstream = undefined;
    });
    upstream.on("error", () => {
      if (room.upstream === upstream) room.upstream = undefined;
    });
    // Host-wire frames from the bound phone go through here (buffered while
    // the upstream is still connecting).
    room.forward = (payload, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(payload, { binary: isBinary });
        return;
      }
      if (upstream.readyState === WebSocket.CONNECTING && pendingBytes + payload.length <= MAX_FRAME_BYTES) {
        pending.push({ payload, isBinary });
        pendingBytes += payload.length;
      }
    };
    return upstream;
  }

  function handleGuestFrame(room, peerId, payload) {
    room.lastSeen = Date.now();
    if (room.boundPeer === undefined) {
      if (room.everBound) {
        // Rejoin with the same link: the link is the credential, so bind
        // directly and forward the frame (the phone sends host-wire frames
        // immediately on reconnect, no code round-trip).
        room.boundPeer = peerId;
        createUpstream(room);
        log.info("relay.room.rebound", { roomId: room.roomId, peerId });
      } else {
        // First join: await the one-time pairing code (independent of the
        // rendezvous).
        if (roomExpired(room)) {
          dropRoom(room, "pairing code expired");
          return;
        }
        const frame = jsonText(payload);
        if (frame?.t !== "pair" || frame.code !== room.code) {
          room.attempts += 1;
          if (room.attempts >= MAX_PAIR_ATTEMPTS) {
            dropRoom(room, "too many invalid pairing attempts");
          }
          return;
        }
        room.everBound = true;
        room.boundPeer = peerId;
        createUpstream(room);
        log.info("relay.room.bound", { roomId: room.roomId, peerId });
        return;
      }
    }
    // Bound: this peer is the phone (rejoins rebind — the link is the
    // credential). Type-prefixed host-wire frame → appserver socket.
    if (peerId !== room.boundPeer) {
      room.boundPeer = peerId;
      closeUpstream(room);
      createUpstream(room);
    }
    if (!room.upstream) return;
    const type = payload[0];
    const body = payload.subarray(1);
    room.forward(body, type === 1);
  }

  function openRoomSocket(room) {
    return new Promise((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(`${relayUrl}/r/${room.roomId}?role=host`, {
        maxPayload: MAX_FRAME_BYTES,
      });
      room.ws = ws;
      let settled = false;
      const settle = (fn, value) => {
        if (!settled) {
          settled = true;
          fn(value);
        }
      };
      let reconnectAttempt = 0;
      ws.once("open", () => settle(resolvePromise));
      ws.once("error", (error) => settle(rejectPromise, error));
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          // Relay control frame (peer-left). A bound peer leaving closes its
          // upstream; the room survives so the phone can rebind on reconnect.
          try {
            const control = JSON.parse(data.toString());
            if (control?.t === "peer-left" && control.peer === room.boundPeer) {
              closeUpstream(room);
              room.boundPeer = undefined;
            }
          } catch {
            // unparseable control frame — ignore
          }
          return;
        }
        const envelope = unpackEnvelope(new Uint8Array(data));
        if (!envelope) return;
        void open(room.key, envelope.payload).then((plaintext) => {
          if (plaintext) handleGuestFrame(room, envelope.peerId, plaintext);
        });
      });
      ws.on("close", () => {
        room.ws = undefined;
        closeUpstream(room);
        if (stopped || roomExpired(room)) {
          if (rooms.get(room.roomId) === room) rooms.delete(room.roomId);
          return;
        }
        // Transient relay drop: rejoin the room until the code TTL expires.
        const delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000) * (0.75 + Math.random() * 0.5);
        reconnectAttempt += 1;
        setTimeout(() => {
          if (stopped || roomExpired(room)) {
            if (rooms.get(room.roomId) === room) rooms.delete(room.roomId);
            return;
          }
          if (room.ws) return;
          void openRoomSocket(room).catch(() => {});
        }, delay);
      });
    });
  }

  // ── public surface ──────────────────────────────────────────────────────────

  /** Mint a fresh 6-digit one-time code + control room; registers the link
   * with the rendezvous. Returns { code, hostId }. */
  async function mintPairCode() {
    // Expire stale rooms and cap the total.
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (roomExpired(room)) dropRoom(room, "pairing code expired");
    }
    if (rooms.size >= MAX_ROOMS) {
      const oldest = [...rooms.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      dropRoom(oldest, "room limit reached");
    }
    const code = randomSixDigitCode();
    const roomId = b64url(randomBytes(16));
    const rawKey = randomBytes(32);
    const key = await importRoomKey(rawKey);
    const pairLink = `${relayUrl}/r/${roomId}.${b64url(rawKey)}`;
    const room = {
      code,
      roomId,
      key,
      pairLink,
      expiresAt: now + PAIR_CODE_TTL_MS,
      lastSeen: now,
      ws: undefined,
      upstream: undefined,
      boundPeer: undefined,
      everBound: false,
      attempts: 0,
    };
    rooms.set(roomId, room);
    try {
      await openRoomSocket(room);
    } catch (error) {
      rooms.delete(roomId);
      log.warn("relay.room.connect.failed", { roomId, error: String(error) });
      throw new Error("relay unavailable");
    }
    if (rendezvousUrl !== undefined) {
      try {
        await fetch(`${rendezvousUrl}/v1/pair-links`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId, code, pairLink }),
          signal: AbortSignal.timeout(5_000),
        });
      } catch (err) {
        log.warn("relay.pair-link.register.failed", { error: String(err) });
      }
    }
    log.info("relay.code.minted", { roomId });
    return { code, hostId, pairLink };
  }

  function status() {
    return {
      ok: true,
      relayUrl,
      hostId,
      rooms: [...rooms.values()].map((room) => ({
        roomId: room.roomId,
        bound: room.boundPeer !== undefined,
        expiresAt: new Date(room.expiresAt).toISOString(),
      })),
    };
  }

  async function stop() {
    stopped = true;
    for (const room of [...rooms.values()]) {
      closeUpstream(room);
      try {
        room.ws?.close(1000, "gateway stopping");
      } catch {}
    }
    rooms.clear();
  }

  return { mintPairCode, status, stop };
}
