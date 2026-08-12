import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_TOKEN_TTL_MS,
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
  tokenSweep,
} from "./rendezvous.mjs";

const ORIGIN = "https://workstation.example-tailnet.ts.net:8445";

function tempAccountsDir() {
  return mkdtempSync(join(tmpdir(), "rdv-accounts-"));
}

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

test("accounts register, reject duplicates and invalid credentials, and log in", async () => {
  const dir = tempAccountsDir();
  const rendezvous = await startRendezvous({ listenPort: 0, accountsPath: join(dir, "accounts.json") });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  const json = { "Content-Type": "application/json" };
  try {
    const register = (username, password) =>
      fetch(`${base}/v1/accounts/register`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, password }),
      });

    // Valid registration.
    const ok = await register("alice", "correct-horse-battery");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });

    // The account store is persisted on disk, not just in memory.
    const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "accounts.json"), "utf8"));
    assert.deepEqual(Object.keys(onDisk), ["alice"]);
    assert.equal(typeof onDisk.alice.salt, "string");
    assert.equal(typeof onDisk.alice.passHash, "string");
    assert.notEqual(onDisk.alice.passHash, "correct-horse-battery");

    // Duplicate username is rejected with 409.
    const duplicate = await register("alice", "another-password");
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).ok, false);

    // Invalid usernames are rejected (too short, too long, bad characters).
    for (const username of ["", "ab", "x".repeat(33), "al ice", "alice!", "alice\n"]) {
      const rejected = await register(username, "correct-horse-battery");
      assert.equal(rejected.status, 400);
    }
    // Invalid passwords are rejected (too short, too long).
    for (const password of ["", "short", "x".repeat(129)]) {
      const rejected = await register(`bob${password.length}`, password);
      assert.equal(rejected.status, 400);
    }

    // Login with the right credentials issues a 32-byte b64url bearer token.
    const login = (username, password) =>
      fetch(`${base}/v1/accounts/login`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, password }),
      });
    const good = await login("alice", "correct-horse-battery");
    assert.equal(good.status, 200);
    const goodBody = await good.json();
    assert.equal(goodBody.ok, true);
    assert.match(goodBody.token, /^[A-Za-z0-9_-]{43}$/u);

    // Wrong password and unknown user both answer 401 with ok: false.
    const wrongPassword = await login("alice", "wrong-password");
    assert.equal(wrongPassword.status, 401);
    assert.equal((await wrongPassword.json()).ok, false);
    const unknownUser = await login("nobody", "correct-horse-battery");
    assert.equal(unknownUser.status, 401);
    assert.equal((await unknownUser.json()).ok, false);
  } finally {
    await rendezvous.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("host directory is scoped to the bearer token account", async () => {
  const dir = tempAccountsDir();
  const rendezvous = await startRendezvous({ listenPort: 0, accountsPath: join(dir, "accounts.json") });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  const json = { "Content-Type": "application/json" };
  try {
    for (const [username, password] of [
      ["aliceA", "password-a1"],
      ["aliceB", "password-b2"],
    ]) {
      const registered = await fetch(`${base}/v1/accounts/register`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, password }),
      });
      assert.equal(registered.status, 200);
    }
    const login = async (username, password) => {
      const response = await fetch(`${base}/v1/accounts/login`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username, password }),
      });
      return (await response.json()).token;
    };
    const tokenA = await login("aliceA", "password-a1");
    const tokenB = await login("aliceB", "password-b2");
    const bearerA = { ...json, Authorization: `Bearer ${tokenA}` };
    const bearerB = { ...json, Authorization: `Bearer ${tokenB}` };

    // Account-scoped announcements land under the announcing account.
    for (const [headers, hostId] of [
      [bearerA, "ha"],
      [bearerB, "hb"],
      [json, "hpublic"], // no token: unscoped, stays public
    ]) {
      const announced = await fetch(`${base}/v1/hosts`, {
        method: "POST",
        headers,
        body: JSON.stringify({ hostId, hostname: hostId, label: hostId, origin: ORIGIN }),
      });
      assert.equal(announced.status, 200);
    }

    const hostsOf = async (headers) => {
      const response = await fetch(`${base}/v1/hosts`, { headers });
      assert.equal(response.status, 200);
      return (await response.json()).hosts.map((host) => host.hostId).sort();
    };

    // Each account sees only its own hosts; A's hosts are hidden from B.
    assert.deepEqual(await hostsOf(bearerA), ["ha"]);
    assert.deepEqual(await hostsOf(bearerB), ["hb"]);
    // Unauthenticated requests still see the unscoped (public) list.
    assert.deepEqual(await hostsOf(json), ["hpublic"]);

    // A present-but-invalid token is rejected outright.
    const bogus = await fetch(`${base}/v1/hosts`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.equal(bogus.status, 401);
  } finally {
    await rendezvous.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("account tokens expire after the token TTL", async () => {
  const dir = tempAccountsDir();
  const rendezvous = await startRendezvous({ listenPort: 0, accountsPath: join(dir, "accounts.json") });
  const base = `http://${rendezvous.host}:${rendezvous.port}`;
  const json = { "Content-Type": "application/json" };
  try {
    const registered = await fetch(`${base}/v1/accounts/register`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "carol", password: "password-c3" }),
    });
    assert.equal(registered.status, 200);

    const login = await fetch(`${base}/v1/accounts/login`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ username: "carol", password: "password-c3" }),
    });
    const token = (await login.json()).token;

    await fetch(`${base}/v1/hosts`, {
      method: "POST",
      headers: { ...json, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostId: "hc", hostname: "hc", label: "hc", origin: ORIGIN }),
    });
    const scoped = await fetch(`${base}/v1/hosts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(scoped.status, 200);
    assert.deepEqual((await scoped.json()).hosts.map((host) => host.hostId), ["hc"]);

    // Force expiry by sweeping with a clock past the 30-day TTL.
    tokenSweep(Date.now() + DEFAULT_TOKEN_TTL_MS + 1);

    const expired = await fetch(`${base}/v1/hosts`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).ok, false);
  } finally {
    await rendezvous.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
