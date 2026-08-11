#!/usr/bin/env node
//
// rendezvous.mjs — public host registry + one-time pairing-code broker.
//
// Two roles:
//
// 1. Host directory. Gateways announce themselves (POST /v1/hosts,
//    heartbeating every 30s); the native apps GET /v1/hosts to learn what
//    computers are available. In the internet (public-relay) model the app
//    resolves a host to its relay-based control room; in the private
//    (tailnet) model it connects to the host's gateway origin directly.
//
// 2. Pairing broker. The host's relay adapter mints a 6-digit one-time code
//    per control room (POST /v1/pair-links) and the phone redeems it
//    (POST /v1/pair) for the room link. Codes are single-use, TTL'd, and
//    stored only as sha256 hashes; the room additionally requires the code,
//    so a compromised rendezvous cannot join rooms.
//
// Trust model: the directory is public; the pairing broker's codes are the
// capability. A redeemer needs the 6-digit code the desktop displays; the
// room key (inside the returned link) is end-to-end material the relay never
// sees. Deploy behind TLS on a host both the gateways and the phones can
// reach. Stateless with TTLs: losing it only hides hosts/codes until they
// re-register.
//
// Run standalone:  node scripts/rendezvous.mjs
// Env: RDV_HOST (default 127.0.0.1), RDV_PORT (default 4195), RDV_TTL_MS
// (default 90000), RDV_PAIR_TTL_MS (default 600000), RDV_SWEEP_MS
// (default 15000).

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4_195;
export const DEFAULT_TTL_MS = 90_000;
export const DEFAULT_PAIR_TTL_MS = 600_000;
export const DEFAULT_SWEEP_MS = 15_000;
const MAX_HOSTS = 256;
const MAX_CODES = 512;
const MAX_TEXT = 512;

const registry = new Map(); // hostId -> { hostId, hostname, label, origin, lastSeen }
const codes = new Map(); // sha256(code) -> { hostId, pairLink, lastSeen }

function fail(message) {
  throw new Error(message);
}

function boundedText(value, name, maximum = MAX_TEXT) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Cc}\r\n]/u.test(value)
  ) {
    fail(`${name} is invalid`);
  }
  return value;
}

export function normalizeHostId(value) {
  return boundedText(value, "hostId", 128);
}

export function normalizeHostname(value) {
  return boundedText(value, "hostname", 253);
}

export function normalizeLabel(value) {
  return boundedText(value, "label", 512);
}

export function normalizeOrigin(value) {
  const origin = boundedText(value, "origin", 512);
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("origin must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") fail("origin must be an HTTPS URL");
  if (url.host === "") fail("origin must carry a host");
  if (url.username !== "" || url.password !== "") fail("origin must not carry credentials");
  if (url.pathname !== "/" && url.pathname !== "") {
    fail("origin must not carry a path");
  }
  return url.origin;
}

export function parseHostRegistration(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("registration is invalid");
  return {
    hostId: normalizeHostId(body.hostId),
    hostname: normalizeHostname(body.hostname),
    label: normalizeLabel(body.label),
    origin: normalizeOrigin(body.origin),
  };
}

export function registryTtlMs(input) {
  const override = input.ttlMs ?? input.RDV_TTL_MS;
  if (override === undefined) return DEFAULT_TTL_MS;
  const value = typeof override === "string" ? Number.parseInt(override, 10) : override;
  if (!Number.isSafeInteger(value) || value <= 0) fail("registry TTL must be a positive integer");
  return value;
}

/** A pairing code is exactly six decimal digits. */
export function normalizePairCode(value) {
  if (typeof value !== "string" || !/^\d{6}$/u.test(value)) fail("pairing code must be exactly six digits");
  return value;
}

/** Codes are stored only as sha256 hashes (they are the pairing capability). */
export function hashPairCode(code) {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** The room link the phone redeems a code for: ws(s)://…/r/<roomId>.<key>. */
export function normalizePairLink(value) {
  const link = boundedText(value, "pairLink", 1_024);
  let url;
  try {
    url = new URL(link);
  } catch {
    fail("pairLink must be a valid ws(s) URL");
  }
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.host === "") {
    fail("pairLink must be a valid ws(s) URL");
  }
  if (!/\/r\/[A-Za-z0-9_-]{10,64}\.[A-Za-z0-9_-]{20,}/u.test(url.pathname)) {
    fail("pairLink must be a collab-style /r/<roomId>.<key> URL");
  }
  return link;
}

export function parsePairLinkRegistration(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("registration is invalid");
  return {
    hostId: normalizeHostId(body.hostId),
    code: normalizePairCode(body.code),
    pairLink: normalizePairLink(body.pairLink),
  };
}

export function pairTtlMs(input) {
  const override = input.pairTtlMs ?? input.RDV_PAIR_TTL_MS;
  if (override === undefined) return DEFAULT_PAIR_TTL_MS;
  const value = typeof override === "string" ? Number.parseInt(override, 10) : override;
  if (!Number.isSafeInteger(value) || value <= 0) fail("pairing code TTL must be a positive integer");
  return value;
}

export function pairSweep(now = Date.now(), ttlMs = DEFAULT_PAIR_TTL_MS) {
  for (const [key, entry] of codes) {
    if (now - entry.lastSeen > ttlMs) codes.delete(key);
  }
}

export function registrySweep(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  for (const [key, entry] of registry) {
    if (now - entry.lastSeen > ttlMs) registry.delete(key);
  }
}

export function liveHosts(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  registrySweep(now, ttlMs);
  return [...registry.values()]
    .map((entry) => ({
      hostId: entry.hostId,
      hostname: entry.hostname,
      label: entry.label,
      origin: entry.origin,
      updatedAt: new Date(entry.lastSeen).toISOString(),
    }))
    .sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
}

function replyText(response, status, contentType, body) {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.writeHead(status);
  response.end(body);
}

function replyJson(response, status, body) {
  replyText(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

async function readJsonBody(request, response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) {
      replyJson(response, 413, { ok: false, error: "payload too large" });
      return undefined;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    replyJson(response, 400, { ok: false, error: "invalid JSON" });
    return undefined;
  }
}

function requestPath(url) {
  try {
    const parsed = new URL(url, "http://rendezvous.invalid");
    return parsed.pathname;
  } catch {
    return "/";
  }
}

async function handleRegistryRequest(request, response, pathname, method) {
  if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
    const body = JSON.stringify({ ok: true });
    replyText(response, 200, "application/json; charset=utf-8", body, method === "HEAD");
    return true;
  }
  if (pathname === "/v1/hosts" && (method === "GET" || method === "HEAD")) {
    const body = JSON.stringify({ hosts: liveHosts() });
    replyText(response, 200, "application/json; charset=utf-8", body, method === "HEAD");
    return true;
  }
  if (pathname === "/v1/hosts" && method === "POST") {
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    try {
      const registration = parseHostRegistration(body);
      registry.set(registration.hostId, { ...registration, lastSeen: Date.now() });
      if (registry.size > MAX_HOSTS) {
        // Drop the oldest announcement so one bot cannot crowd out the registry.
        const oldest = [...registry.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        registry.delete(oldest.hostId);
      }
      replyJson(response, 200, { ok: true });
    } catch (error) {
      replyJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid registration" });
    }
    return true;
  }
  const deleteMatch = /^\/v1\/hosts\/([^/]+)$/u.exec(pathname);
  if (deleteMatch !== null && method === "DELETE") {
    let hostId;
    try {
      hostId = decodeURIComponent(deleteMatch[1]);
    } catch {
      hostId = undefined;
    }
    if (hostId === undefined || hostId === "") {
      replyJson(response, 400, { ok: false, error: "invalid hostId" });
      return true;
    }
    registry.delete(hostId);
    replyJson(response, 200, { ok: true });
    return true;
  }
  // The relay adapter mints a code + control-room link per phone.
  if (pathname === "/v1/pair-links" && method === "POST") {
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    try {
      const registration = parsePairLinkRegistration(body);
      const key = hashPairCode(registration.code);
      codes.set(key, { hostId: registration.hostId, pairLink: registration.pairLink, lastSeen: Date.now() });
      if (codes.size > MAX_CODES) {
        const oldest = [...codes.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        for (const [codeKey, entry] of codes) {
          if (entry === oldest) {
            codes.delete(codeKey);
            break;
          }
        }
      }
      replyJson(response, 200, { ok: true });
    } catch (error) {
      replyJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid registration" });
    }
    return true;
  }
  // The phone redeems a code for the control-room link (single use).
  if (pathname === "/v1/pair" && method === "POST") {
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    let hostId;
    let code;
    try {
      hostId = normalizeHostId(body.hostId);
      code = normalizePairCode(body.code);
    } catch {
      replyJson(response, 400, { ok: false, error: "hostId and a six-digit code are required" });
      return true;
    }
    pairSweep();
    const key = hashPairCode(code);
    const entry = codes.get(key);
    if (!entry || entry.hostId !== hostId) {
      replyJson(response, 404, { ok: false, error: "no such pairing code" });
      return true;
    }
    codes.delete(key);
    replyJson(response, 200, { ok: true, pairLink: entry.pairLink });
    return true;
  }
  return false;
}

export function optionsFromEnvironment(environment = process.env) {
  const port = Number.parseInt(environment.RDV_PORT ?? String(DEFAULT_PORT), 10);
  return {
    listenHost: environment.RDV_HOST ?? "127.0.0.1",
    listenPort: Number.isSafeInteger(port) && port > 0 ? port : DEFAULT_PORT,
    ttlMs: registryTtlMs({ RDV_TTL_MS: environment.RDV_TTL_MS }),
    pairTtlMs: pairTtlMs({ RDV_PAIR_TTL_MS: environment.RDV_PAIR_TTL_MS }),
    sweepMs: Number.parseInt(environment.RDV_SWEEP_MS ?? String(DEFAULT_SWEEP_MS), 10),
  };
}

export async function startRendezvous(input) {
  const options = {
    listenHost: input.listenHost ?? "127.0.0.1",
    listenPort: input.listenPort ?? DEFAULT_PORT,
    ttlMs: registryTtlMs(input),
    pairTtlMs: pairTtlMs(input),
    sweepMs: input.sweepMs ?? DEFAULT_SWEEP_MS,
  };
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const pathname = requestPath(request.url);
      if (await handleRegistryRequest(request, response, pathname, method)) return;
      replyJson(response, 404, { ok: false, error: "not found" });
    })().catch(() => {
      if (!response.headersSent) replyJson(response, 500, { ok: false, error: "rendezvous request failed" });
      else response.destroy();
    });
  });
  let closed = false;
  const sweeper = setInterval(() => {
    try {
      registrySweep(undefined, options.ttlMs);
      pairSweep(undefined, options.pairTtlMs);
    } catch {
      // sweep failures are non-fatal
    }
  }, options.sweepMs);
  sweeper.unref?.();
  await new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(options.listenPort, options.listenHost, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("rendezvous did not bind a TCP socket");
  return {
    host: options.listenHost,
    port: address.port,
    address,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath !== undefined && (invokedPath === import.meta.url || invokedPath.endsWith("/rendezvous.mjs"))) {
  try {
    const rendezvous = await startRendezvous(optionsFromEnvironment());
    console.log(`T4 rendezvous listening on http://${rendezvous.host}:${rendezvous.port}`);
    const stop = () => {
      void rendezvous.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "T4 rendezvous failed");
    process.exitCode = 1;
  }
}
