import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocketServer } from "ws";

import { startRelayControl, MAX_PAIR_ATTEMPTS, normalizeRelayUrl } from "./relay-control.mjs";
import { startRendezvous } from "./rendezvous.mjs";
import { TestGuest, dec, importKey, open, packEnvelope, unpackEnvelope, startMockRelay } from "./relay-test-helpers.mjs";

const enc = new TextEncoder();

/** Echo host-wire server on a Unix socket: text echoed as `upstream:<text>`,
 * binary echoed verbatim. */
async function startMockAppserver() {
  const directory = await mkdtemp(join(tmpdir(), "relay-control-"));
  const socketPath = join(directory, "appserver.sock");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data, isBinary) => {
      if (isBinary) socket.send(data, { binary: true });
      else socket.send(`upstream:${data.toString()}`);
    });
  });
  await new Promise((resolvePromise) => {
    server.listen(socketPath, resolvePromise);
  });
  return {
    socketPath,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolveClose) => wss.close(() => resolveClose()));
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("relay url normalization accepts ws and wss", () => {
  assert.equal(normalizeRelayUrl("wss://wickrunner.com:8443"), "wss://wickrunner.com:8443");
  assert.equal(normalizeRelayUrl("ws://127.0.0.1:9999"), "ws://127.0.0.1:9999");
  for (const bad of ["http://example.com", "not a url", "wss://", ""]) {
    assert.throws(() => normalizeRelayUrl(bad), /T4_RELAY_URL/u);
  }
});

test("pair code is six digits and codes redeem through the rendezvous", async () => {
  const relay = await startMockRelay();
  const rendezvous = await startRendezvous({ listenPort: 0 });
  const appserver = await startMockAppserver();
  const hostId = "sha256:host";
  const adapter = startRelayControl({
    relayUrl: relay.url,
    rendezvousUrl: `http://${rendezvous.host}:${rendezvous.port}`,
    hostId,
    appSocketPath: appserver.socketPath,
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    const minted = await adapter.mintPairCode();
    assert.match(minted.code, /^\d{6}$/u);
    assert.equal(minted.hostId, hostId);

    // Redeem via the rendezvous (the adapter registered the code there).
    const redeem = await fetch(`http://${rendezvous.host}:${rendezvous.port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId, code: minted.code }),
    });
    assert.equal(redeem.status, 200);
    const { pairLink } = await redeem.json();
    assert.ok(pairLink.includes(`/r/`));
    assert.ok(pairLink.startsWith(relay.url));

    // Reuse is refused.
    const reuse = await fetch(`http://${rendezvous.host}:${rendezvous.port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId, code: minted.code }),
    });
    assert.equal(reuse.status, 404);

    // A phone joins with the redeemed link, presents the code, and host-wire
    // frames round-trip through the E2E pipe to the appserver socket.
    const phone = new TestGuest(pairLink);
    await phone.connect();
    await phone.sendPair(minted.code);
    await phone.sendHostWire("hello host-wire");
    const textFrame = await phone.nextMessage();
    assert.equal(textFrame.type, 0);
    assert.equal(dec.decode(textFrame.body), "upstream:hello host-wire");

    // Binary frames survive too.
    const payload = new Uint8Array([1, 2, 3, 254, 255]);
    await phone.sendBinary(payload);
    const binaryFrame = await phone.nextMessage();
    assert.equal(binaryFrame.type, 1);
    assert.deepEqual([...binaryFrame.body], [1, 2, 3, 254, 255]);
    phone.close();
  } finally {
    await adapter.stop();
    await appserver.close();
    await rendezvous.close();
    await relay.close();
  }
});

test("wrong codes are refused and the attempt cap closes the room", async () => {
  const relay = await startMockRelay();
  const appserver = await startMockAppserver();
  const adapter = startRelayControl({
    relayUrl: relay.url,
    hostId: "h",
    appSocketPath: appserver.socketPath,
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    const minted = await adapter.mintPairCode();
    const roomId = /\/r\/([A-Za-z0-9_-]{10,64})\./u.exec(minted.pairLink)?.[1];
    // Join directly with the link (the rendezvous is not needed for the
    // in-room code gate).
    const phone = new TestGuest(minted.pairLink);
    await phone.connect();
    await phone.sendPair("000000");
    await phone.sendHostWire("should not be forwarded");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    assert.equal(phone.messages.length, 0, "unauthenticated frames must not be forwarded");
    phone.close();
    assert.ok(roomId);

    // A fresh mint; hammer the wrong code until the cap closes the socket.
    const second = await adapter.mintPairCode();
    const attacker = new TestGuest(second.pairLink);
    await attacker.connect();
    const closed = new Promise((resolvePromise) => {
      attacker.socket.once("close", (code) => resolvePromise(code));
    });
    for (let attempt = 0; attempt < MAX_PAIR_ATTEMPTS; attempt += 1) {
      await attacker.sendPair("111111");
    }
    const closeCode = await closed;
    assert.equal(closeCode, 4001);
    attacker.close();
  } finally {
    await adapter.stop();
    await appserver.close();
    await relay.close();
  }
});

test("a phone rejoining with the same link rebinds without a code", async () => {
  const relay = await startMockRelay();
  const appserver = await startMockAppserver();
  const adapter = startRelayControl({
    relayUrl: relay.url,
    hostId: "h",
    appSocketPath: appserver.socketPath,
    log: { info() {}, warn() {}, error() {} },
  });
  try {
    const minted = await adapter.mintPairCode();
    const phone = new TestGuest(minted.pairLink);
    await phone.connect();
    await phone.sendPair(minted.code);
    await phone.sendHostWire("first");
    const first = await phone.nextMessage();
    assert.equal(first.type, 0);
    assert.equal(dec.decode(first.body), "upstream:first");
    phone.close();

    // Rejoin with the same link: the link is the credential, no code needed.
    const rejoined = new TestGuest(minted.pairLink);
    await rejoined.connect();
    await rejoined.sendHostWire("second");
    const second = await rejoined.nextMessage();
    assert.equal(second.type, 0);
    assert.equal(dec.decode(second.body), "upstream:second");
    rejoined.close();
  } finally {
    await adapter.stop();
    await appserver.close();
    await relay.close();
  }
});
