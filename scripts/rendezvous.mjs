#!/usr/bin/env node
//
// rendezvous.mjs — public host registry + one-time pairing-code broker.
//
// Three roles:
//
// 1. Host directory. Gateways announce themselves (POST /v1/hosts,
//    heartbeating every 30s); the native apps GET /v1/hosts to learn what
//    computers are available. In the internet (public-relay) model the app
//    resolves a host to its relay-based control room; in the private
//    (tailnet) model it connects to the host's gateway origin directly.
//    Announcements may carry an account bearer token, which scopes the
//    host to that account: authenticated GETs then see only that account's
//    hosts, while unauthenticated GETs see the unscoped (public) list.
//
// 2. Pairing broker. The host's relay adapter mints a 6-digit one-time code
//    per control room (POST /v1/pair-links) and the phone redeems it
//    (POST /v1/pair) for the room link. Codes are single-use, TTL'd, and
//    stored only as sha256 hashes; the room additionally requires the code,
//    so a compromised rendezvous cannot join rooms.
//
// 3. Accounts. POST /v1/accounts/register creates a username+password
//    account; POST /v1/accounts/login verifies credentials and issues a
//    30-day bearer token (stored only as a sha256 hash). Accounts are the
//    one persistent state, kept in a JSON file (passwords are never stored
//    plaintext — per-account random salt + sha256(salt + password)).
//
// Trust model: the directory is public; the pairing broker's codes are the
// capability. A redeemer needs the 6-digit code the desktop displays; the
// room key (inside the returned link) is end-to-end material the relay never
// sees. Deploy behind TLS on a host both the gateways and the phones can
// reach. Stateless with TTLs (accounts aside): losing it only hides
// hosts/codes until they re-register.
//
// Run standalone:  node scripts/rendezvous.mjs
// Env: RDV_HOST (default 127.0.0.1), RDV_PORT (default 4195), RDV_TTL_MS
// (default 90000), RDV_PAIR_TTL_MS (default 600000), RDV_SWEEP_MS
// (default 15000), RDV_ACCOUNTS_PATH (default <script dir>/rendezvous-accounts.json),
// RDV_TOKEN_TTL_MS (default 30 days).

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_PORT = 4_195;
export const DEFAULT_TTL_MS = 90_000;
export const DEFAULT_PAIR_TTL_MS = 600_000;
export const DEFAULT_SWEEP_MS = 15_000;
export const DEFAULT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_ACCOUNTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "rendezvous-accounts.json");
const MAX_HOSTS = 256;
const MAX_CODES = 512;
const MAX_TEXT = 512;

const registry = new Map(); // hostId -> { hostId, hostname, label, origin, account, lastSeen }
const codes = new Map(); // sha256(code) -> { hostId, pairLink, lastSeen }
const accounts = new Map(); // username -> { salt, passHash, createdAt }
const tokens = new Map(); // sha256(token) -> { username, expiresAt }
let accountsFile = DEFAULT_ACCOUNTS_PATH;

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

/** A username is 3–32 characters of [A-Za-z0-9._-]. */
export function normalizeUsername(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{3,32}$/u.test(value)) fail("username is invalid");
  return value;
}

/** A password is 8–128 characters. */
export function normalizePassword(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) fail("password is invalid");
  return value;
}

export function parseAccountRegistration(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) fail("registration is invalid");
  return {
    username: normalizeUsername(body.username),
    password: normalizePassword(body.password),
  };
}

/** Passwords are never stored plaintext: per-account random salt + sha256(salt + password). */
export function hashPassword(salt, password) {
  return createHash("sha256").update(salt, "utf8").update(password, "utf8").digest("hex");
}

function verifyPassword(entry, password) {
  const candidate = Buffer.from(hashPassword(entry.salt, password), "hex");
  const expected = Buffer.from(entry.passHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** Load the account store from disk, replacing whatever is in memory. */
export function loadAccounts(filePath = accountsFile) {
  accountsFile = filePath;
  accounts.clear();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(accountsFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("accounts file is malformed");
  for (const [username, entry] of Object.entries(parsed)) {
    if (
      typeof username !== "string" ||
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.salt !== "string" ||
      typeof entry.passHash !== "string" ||
      !Number.isSafeInteger(entry.createdAt)
    ) {
      continue;
    }
    accounts.set(username, { salt: entry.salt, passHash: entry.passHash, createdAt: entry.createdAt });
  }
  return accounts.size;
}

/** Persist the account store (atomic tmp+rename so a crash cannot tear the file). */
function saveAccounts() {
  mkdirSync(dirname(accountsFile), { recursive: true });
  const tmp = `${accountsFile}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(accounts), null, 2)}\n`);
  renameSync(tmp, accountsFile);
}

export function tokenTtlMs(input) {
  const override = input.tokenTtlMs ?? input.RDV_TOKEN_TTL_MS;
  if (override === undefined) return DEFAULT_TOKEN_TTL_MS;
  const value = typeof override === "string" ? Number.parseInt(override, 10) : override;
  if (!Number.isSafeInteger(value) || value <= 0) fail("account token TTL must be a positive integer");
  return value;
}

/** Bearer tokens are stored only as sha256 hashes (they are the capability). */
export function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Issue a fresh 32-byte base64url bearer token for an account. */
export function issueToken(username, now = Date.now(), ttlMs = DEFAULT_TOKEN_TTL_MS) {
  const token = randomBytes(32).toString("base64url");
  tokens.set(hashToken(token), { username, expiresAt: now + ttlMs });
  return token;
}

export function tokenSweep(now = Date.now()) {
  for (const [key, entry] of tokens) {
    if (now >= entry.expiresAt) tokens.delete(key);
  }
}

/** Resolve a bearer token to its account username, or undefined if invalid/expired. */
export function usernameForToken(token, now = Date.now()) {
  if (typeof token !== "string" || token === "") return undefined;
  tokenSweep(now);
  return tokens.get(hashToken(token))?.username;
}

export function registrySweep(now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  for (const [key, entry] of registry) {
    if (now - entry.lastSeen > ttlMs) registry.delete(key);
  }
}

/**
 * The live host list. `account` undefined yields the unscoped (public) hosts —
 * the ones announced without a bearer token, so legacy clients keep working.
 * Otherwise only that account's hosts are returned.
 */
export function liveHosts(now = Date.now(), ttlMs = DEFAULT_TTL_MS, account = undefined) {
  registrySweep(now, ttlMs);
  return [...registry.values()]
    .filter((entry) => (account === undefined ? entry.account === undefined : entry.account === account))
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

function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match === null ? undefined : match[1];
}

/**
 * Resolve the request's Bearer token to an account username. No token yields
 * undefined; a present-but-invalid/expired token answers 401 and yields null.
 */
function accountFromRequest(request, response) {
  const token = bearerToken(request);
  if (token === undefined) return undefined;
  const username = usernameForToken(token);
  if (username === undefined) {
    replyJson(response, 401, { ok: false, error: "invalid or expired token" });
    return null;
  }
  return username;
}

async function handleRegistryRequest(request, response, pathname, method) {
  if (pathname === "/healthz" && (method === "GET" || method === "HEAD")) {
    const body = JSON.stringify({ ok: true });
    replyText(response, 200, "application/json; charset=utf-8", body, method === "HEAD");
    return true;
  }
  if (pathname === "/v1/accounts/register" && method === "POST") {
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    let username;
    let password;
    try {
      ({ username, password } = parseAccountRegistration(body));
    } catch (error) {
      replyJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid registration" });
      return true;
    }
    if (accounts.has(username)) {
      replyJson(response, 409, { ok: false, error: "username already exists" });
      return true;
    }
    const salt = randomBytes(16).toString("hex");
    accounts.set(username, { salt, passHash: hashPassword(salt, password), createdAt: Date.now() });
    try {
      saveAccounts();
    } catch {
      // Never diverge from disk: roll the account back if persistence fails.
      accounts.delete(username);
      replyJson(response, 500, { ok: false, error: "could not persist accounts" });
      return true;
    }
    replyJson(response, 200, { ok: true });
    return true;
  }
  if (pathname === "/v1/accounts/login" && method === "POST") {
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    let username;
    let password;
    try {
      ({ username, password } = parseAccountRegistration(body));
    } catch (error) {
      replyJson(response, 400, { ok: false, error: error instanceof Error ? error.message : "invalid registration" });
      return true;
    }
    const entry = accounts.get(username);
    if (entry === undefined || !verifyPassword(entry, password)) {
      // One message for unknown user and wrong password: no username enumeration.
      replyJson(response, 401, { ok: false, error: "invalid username or password" });
      return true;
    }
    replyJson(response, 200, { ok: true, token: issueToken(username) });
    return true;
  }
  if (pathname === "/v1/hosts" && (method === "GET" || method === "HEAD")) {
    const account = accountFromRequest(request, response);
    if (account === null) return true;
    const body = JSON.stringify({ hosts: liveHosts(undefined, undefined, account) });
    replyText(response, 200, "application/json; charset=utf-8", body, method === "HEAD");
    return true;
  }
  if (pathname === "/v1/hosts" && method === "POST") {
    const account = accountFromRequest(request, response);
    if (account === null) return true;
    const body = await readJsonBody(request, response);
    if (body === undefined) return true;
    try {
      const registration = parseHostRegistration(body);
      registry.set(registration.hostId, { ...registration, account, lastSeen: Date.now() });
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
    tokenTtlMs: tokenTtlMs({ RDV_TOKEN_TTL_MS: environment.RDV_TOKEN_TTL_MS }),
    accountsPath: environment.RDV_ACCOUNTS_PATH ?? DEFAULT_ACCOUNTS_PATH,
    sweepMs: Number.parseInt(environment.RDV_SWEEP_MS ?? String(DEFAULT_SWEEP_MS), 10),
  };
}

export async function startRendezvous(input) {
  const options = {
    listenHost: input.listenHost ?? "127.0.0.1",
    listenPort: input.listenPort ?? DEFAULT_PORT,
    ttlMs: registryTtlMs(input),
    pairTtlMs: pairTtlMs(input),
    tokenTtlMs: tokenTtlMs(input),
    accountsPath: input.accountsPath ?? input.RDV_ACCOUNTS_PATH ?? DEFAULT_ACCOUNTS_PATH,
    sweepMs: input.sweepMs ?? DEFAULT_SWEEP_MS,
  };
  loadAccounts(options.accountsPath);
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
      tokenSweep();
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
