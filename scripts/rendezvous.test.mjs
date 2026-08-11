import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TTL_MS,
  liveHosts,
  normalizeHostId,
  normalizeHostname,
  normalizeLabel,
  normalizeOrigin,
  optionsFromEnvironment,
  pairSweep,
  parseHostRegistration,
  startRendezvous,
} from "./rendezvous.mjs";

const ORIGIN = "https://workstation.example-tailnet.ts.net:8445";

test("registration fields are bounded and validated", () => {
  assert.equal(normalizeHostId("sha256:abcd"), "sha256:abcd");
  assert.throws(() => normalizeHostId(""), /hostId/u);
  assert.throws(() => normalizeHostId("a".repeat(129)), /hostId/u);
  assert.throws(() => normalizeHostId("bad\nid"), /hostId/u);
  assert.throws(() => normalizeHostname(""), /hostname/u);
  assert.throws(() => normalizeLabel(""), /label/u);
  assert.throws(() => normalizeOrigin("http://host.ts.net"), /HTTPS/u);
  assert.throws(() => normalizeOrigin("https://host.ts.net:8445/path"), /path/u);
  assert.throws(() => normalizeOrigin("https://user:pw@host.ts.net"), /credentials/u);
  assert.equal(normalizeOrigin("https://host.example-tailnet.ts.net:8445"), "https://host.example-tailnet.ts.net:8445");
});

test("parseHostRegistration rejects malformed bodies", () => {
  assert.throws(() => parseHostRegistration(null), /registration is invalid/u);
  assert.throws(() => parseHostRegistration([]), /registration is invalid/u);
  assert.throws(() => parseHostRegistration({ hostname: "h", label: "l", origin: ORIGIN }), /hostId/u);
  assert.deepEqual(
    parseHostRegistration({ hostId: "h1", hostname: "workstation", label: "Work", origin: ORIGIN }),
    { hostId: "h1", hostname: "workstation", label: "Work", origin: ORIGIN },
  );
});

test("ttl override must be a positive integer", () => {
  assert.equal(DEFAULT_TTL_MS, 90_000);
  assert.equal(
    optionsFromEnvironment({ RDV_TTL_MS: "120000" }).ttlMs,
    120_000,
  );
  assert.throws(() => optionsFromEnvironment({ RDV_TTL_MS: "0" }), /positive integer/u);
  assert.throws(() => optionsFromEnvironment({ RDV_TTL_MS: "bogus" }), /positive integer/u);
});

test("registrations are served, expire, and can be deleted", async () => {
  const rendezvous = await startRendezvous({ listenPort: 0 });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  try {
    const empty = await fetch(`${base}/v1/hosts`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).hosts, []);

    const register = await fetch(`${base}/v1/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", hostname: "workstation", label: "Work", origin: ORIGIN }),
    });
    assert.equal(register.status, 200);
    assert.deepEqual(await register.json(), { ok: true });

    const listed = await fetch(`${base}/v1/hosts`);
    const hosts = (await listed.json()).hosts;
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].hostId, "h1");
    assert.equal(hosts[0].hostname, "workstation");
    assert.equal(hosts[0].origin, ORIGIN);
    assert.equal(typeof hosts[0].updatedAt, "string");

    const bad = await fetch(`${base}/v1/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h2", hostname: "x", label: "y", origin: "http://nope" }),
    });
    assert.equal(bad.status, 400);

    const deleted = await fetch(`${base}/v1/hosts/h1`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    const afterDelete = await fetch(`${base}/v1/hosts`);
    assert.deepEqual((await afterDelete.json()).hosts, []);

    // TTL expiry
    await fetch(`${base}/v1/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "expiring", hostname: "gone", label: "G", origin: ORIGIN }),
    });
    const expired = liveHosts(Date.now() + DEFAULT_TTL_MS + 1, DEFAULT_TTL_MS);
    assert.equal(expired.length, 0);

    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    await rendezvous.close();
  }
});

test("environment options parse ports and ttl", () => {
  const options = optionsFromEnvironment({ RDV_HOST: "0.0.0.0", RDV_PORT: "8446", RDV_TTL_MS: "60000" });
  assert.equal(options.listenHost, "0.0.0.0");
  assert.equal(options.listenPort, 8446);
  assert.equal(options.ttlMs, 60_000);
});

test("pairing codes are minted, redeemed once, and expire", async () => {
  const rendezvous = await startRendezvous({ listenPort: 0 });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  const pairLink = "wss://relay.example.com/r/abcdefghijklmnopqrstuvwxyzABCDEF.0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  try {
    // Mint: adapter registers a code + control-room link for a host.
    const mint = await fetch(`${base}/v1/pair-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "123456", pairLink }),
    });
    assert.equal(mint.status, 200);

    // Invalid registrations are rejected.
    for (const bad of [
      { hostId: "h1", code: "12345", pairLink },
      { hostId: "h1", code: "abcdef", pairLink },
      { hostId: "h1", code: "123456", pairLink: "https://example.com/nope" },
      { hostId: "h1", code: "123456", pairLink: "wss://relay.example.com/other" },
    ]) {
      const rejected = await fetch(`${base}/v1/pair-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bad),
      });
      assert.equal(rejected.status, 400);
    }

    // Redeem: correct code + host returns the link (single use).
    const redeem = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "123456" }),
    });
    assert.equal(redeem.status, 200);
    assert.deepEqual(await redeem.json(), { ok: true, pairLink });

    // Second redeem of the same code fails.
    const reuse = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "123456" }),
    });
    assert.equal(reuse.status, 404);

    // Wrong host or wrong code fails.
    const wrongHost = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "other", code: "123456" }),
    });
    assert.equal(wrongHost.status, 404);
    const wrongCode = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "000000" }),
    });
    assert.equal(wrongCode.status, 404);

    // Malformed bodies are rejected outright.
    const malformed = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "nope" }),
    });
    assert.equal(malformed.status, 400);
  } finally {
    await rendezvous.close();
  }
});

test("pairing codes expire after the pair TTL", async () => {
  const rendezvous = await startRendezvous({ listenPort: 0, pairTtlMs: 5_000 });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  const pairLink = "wss://relay.example.com/r/abcdefghijklmnopqrstuvwxyzABCDEF.0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  try {
    await fetch(`${base}/v1/pair-links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "654321", pairLink }),
    });
    // Force expiry by sweeping with a clock past the TTL.
    const swept = pairSweep(Date.now() + 10_000, 5_000);
    assert.equal(swept, undefined);
    const redeem = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostId: "h1", code: "654321" }),
    });
    assert.equal(redeem.status, 404);
  } finally {
    await rendezvous.close();
  }
});
