#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { homedir, hostname } from "node:os";
import { dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";
import { normalizeRelayUrl, startRelayControl } from "./relay-control.mjs";
export { normalizeRelayUrl } from "./relay-control.mjs";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_PORT = 4_194;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_PROFILE_START_WAIT_MS = 4_000;
const DEFAULT_PROFILE_START_POLL_MS = 50;
const DEFAULT_PROFILE_START_COOLDOWN_MS = 10_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SERVICE_UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/u;
const OMP_SOCKET_NAME = /^\.appserver-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sock$/u;


// Capacitor v8 serves bundled assets from these origins when its documented
// default hostname and platform schemes are used. Keep this list exact: an
// Origin header identifies a browser context, not a signed mobile binary.
export const CAPACITOR_NATIVE_ORIGINS = Object.freeze([
  "https://localhost",
  "capacitor://localhost",
]);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function requiredText(value, name, maximum = 2_048) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} is required`);
  }
  if (/\p{Cc}/u.test(value)) throw new Error(`${name} contains control characters`);
  return value;
}

export function normalizeAllowedOrigin(value) {
  const text = requiredText(value, "T4_ALLOWED_ORIGIN");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("T4_ALLOWED_ORIGIN must be a valid HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("T4_ALLOWED_ORIGIN must be a plain HTTPS origin");
  }
  return url.origin;
}

export function normalizeNativeAllowedOrigins(value = CAPACITOR_NATIVE_ORIGINS) {
  if (!Array.isArray(value)) {
    throw new Error("T4_NATIVE_ALLOWED_ORIGINS must be an array");
  }
  const origins = value.map((origin) => requiredText(origin, "T4_NATIVE_ALLOWED_ORIGINS", 128));
  const unique = new Set(origins);
  if (
    unique.size !== CAPACITOR_NATIVE_ORIGINS.length ||
    !CAPACITOR_NATIVE_ORIGINS.every((origin) => unique.has(origin))
  ) {
    throw new Error(
      `T4_NATIVE_ALLOWED_ORIGINS must contain exactly ${CAPACITOR_NATIVE_ORIGINS.join(", ")}`,
    );
  }
  return [...CAPACITOR_NATIVE_ORIGINS];
}

export function normalizeRendezvousUrl(value) {
  const text = requiredText(value, "T4_RENDEZVOUS_URL");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("T4_RENDEZVOUS_URL must be a valid HTTPS URL");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLoopback = loopbackHosts.has(url.hostname) || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("T4_RENDEZVOUS_URL must be HTTPS (or HTTP on loopback for local development)");
  }
  if (
    url.host === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("T4_RENDEZVOUS_URL must be a plain URL with no credentials");
  }
  return url.origin;
}

/** How often a gateway re-announces itself to the rendezvous. */
const RENDEZVOUS_ANNOUNCE_MS = 30_000;

/**
 * Announce this gateway to the rendezvous (POST /v1/hosts) so native clients
 * can discover it without a QR code or hostname typing. Best-effort: a failed
 * or missing rendezvous is not fatal — the announce is retried every
 * RENDEZVOUS_ANNOUNCE_MS, and the rendezvous expires entries by TTL.
 * Returns a stop function that deregisters the host announcement.
 */
export function startRendezvousAnnounce(options, resolveHostName) {
  if (options.rendezvousUrl === undefined) return async () => {};
  let stopped = false;
  let resolvedHostname = "";
  const announce = async () => {
    if (stopped) return;
    if (resolvedHostname === "") {
      const name = await resolveHostName().catch(() => null);
      if (typeof name !== "string" || name === "") return; // retry next tick
      resolvedHostname = name;
    }
    try {
      await fetch(`${options.rendezvousUrl}/v1/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostId: options.deploymentIdentity,
          hostname: resolvedHostname,
          label: options.label,
          origin: options.allowedOrigin,
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      try {
        process?.stderr?.write?.(`gateway: rendezvous announce failed: ${String(err)}\n`);
      } catch {
        // stderr unavailable
      }
    }
  };
  void announce();
  const timer = setInterval(() => void announce(), RENDEZVOUS_ANNOUNCE_MS);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (resolvedHostname === "") return;
    try {
      await fetch(
        `${options.rendezvousUrl}/v1/hosts/${encodeURIComponent(options.deploymentIdentity)}`,
        { method: "DELETE", signal: AbortSignal.timeout(5_000) },
      );
    } catch {
      // deregistration is best-effort; the rendezvous TTL expires the entry anyway
    }
  };
}

export function normalizeDeploymentIdentity(value) {
  const identity = requiredText(value, "T4_DEPLOYMENT_IDENTITY", 80);
  if (!/^sha256:[0-9a-f]{64}$/u.test(identity)) {
    throw new Error(
      "T4_DEPLOYMENT_IDENTITY must be sha256 followed by exactly 64 lowercase hexadecimal characters",
    );
  }
  return identity;
}
export function normalizeProfileId(value) {
  const id = requiredText(value, "profile id", 64);
  if (!PROFILE_ID_PATTERN.test(id) || id === "default") {
    throw new Error("profile id must be a bounded ASCII identifier");
  }
  return id;
}

function normalizeServiceUnit(value) {
  const unit = requiredText(value, "profile service unit", 128);
  if (!SERVICE_UNIT_PATTERN.test(unit) || unit.includes("..")) {
    throw new Error("profile service unit is invalid");
  }
  return unit;
}

/**
 * Static route table only. User input selects an id; it never supplies a
 * socket path or supervisor argv. Unknown ids are rejected before this table
 * is consulted for filesystem or process work.
 */
export function normalizeProfileRoutes(value = []) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("profile routes must be an array");
  const ids = new Set();
  return Object.freeze(
    value.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("profile route is invalid");
      }
      const route = entry;
      const id = normalizeProfileId(route.id);
      if (ids.has(id)) throw new Error("profile route ids must be unique");
      ids.add(id);
      if (typeof route.appSocket !== "string") throw new Error(`profile route ${id} socket is required`);
      const socket = requiredText(route.appSocket, `profile route ${id} socket`, 4_096);
      if (!isAbsolute(socket)) throw new Error(`profile route ${id} socket must be an absolute path`);
      const appSocket = resolve(socket);
      const serviceUnit =
        route.serviceUnit === undefined ? undefined : normalizeServiceUnit(route.serviceUnit);
      if (route.startEnabled !== undefined && typeof route.startEnabled !== "boolean") {
        throw new Error(`profile route ${id} startEnabled is invalid`);
      }
      return Object.freeze({
        id,
        appSocket,
        ...(serviceUnit === undefined ? {} : { serviceUnit }),
        startEnabled: route.startEnabled === true,
      });
    }),
  );
}

export function websocketUrlForOrigin(origin) {
  const url = new URL("/v1/ws", normalizeAllowedOrigin(origin));
  url.protocol = "wss:";
  return url.toString();
}
export function normalizeClusterWebSocketUrl(value) {
  const text = requiredText(value, "T4_CLUSTER_WS_URL");
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("T4_CLUSTER_WS_URL must be one secure WSS cluster target");
  }
  if (
    url.protocol !== "wss:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.pathname !== "/v1/ws" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("T4_CLUSTER_WS_URL must be one credential-free secure WSS cluster target");
  }
  return url.toString();
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function injectBackendConfig(indexHtml, options) {
  if (indexHtml.includes('id="t4-backend"')) return indexHtml;
  const marker = "</head>";
  const offset = indexHtml.indexOf(marker);
  if (offset === -1) throw new Error("web index is missing </head>");
  const clusterOperatorEnabled = options.clusterOperatorEnabled === true;
  const payload = safeJson({
    wsUrl: clusterOperatorEnabled
      ? normalizeClusterWebSocketUrl(options.clusterWsUrl)
      : websocketUrlForOrigin(options.allowedOrigin),
    label: requiredText(options.label, "gateway label", 128),
    ...(clusterOperatorEnabled ? { clusterOperatorEnabled: true } : {}),
  });
  const script = `    <script id="t4-backend" type="application/json">${payload}</script>\n`;
  return `${indexHtml.slice(0, offset)}${script}${indexHtml.slice(offset)}`;
}

function requestPath(requestUrl) {
  try {
    return new URL(requestUrl ?? "/", "http://t4.invalid").pathname;
  } catch {
    return "/";
  }
}

export function safeStaticPath(webRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = resolve(webRoot);
  const candidate = resolve(join(root, relative));
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : undefined;
}

function gatewayCsp(allowedOrigin, clusterWsUrl) {
  const websocketOrigin = new URL(clusterWsUrl ?? websocketUrlForOrigin(allowedOrigin)).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src 'self' ${websocketOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

function applySecurityHeaders(response, allowedOrigin, clusterWsUrl) {
  response.setHeader("Content-Security-Policy", gatewayCsp(allowedOrigin, clusterWsUrl));
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

async function rejectSymlinkedParent(path) {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("socket path contains a symlinked directory");
  }
}

function isOwnedPrivateSocket(details) {
  return (
    details.isSocket() &&
    (typeof process.getuid !== "function" || details.uid === process.getuid()) &&
    (details.mode & 0o777) === 0o600
  );
}

/**
 * Resolve the public OMP socket without relaxing its ownership contract.
 * Linux appserver intentionally publishes a same-directory symlink whose
 * hidden, UUID-named target rotates on restart; macOS may publish directly.
 */
export async function resolveAppSocket(path) {
  try {
    const parent = dirname(path);
    await rejectSymlinkedParent(parent);
    const parentDetails = await lstat(parent);
    if (
      !parentDetails.isDirectory() ||
      (typeof process.getuid === "function" && parentDetails.uid !== process.getuid()) ||
      (parentDetails.mode & 0o022) !== 0
    ) {
      return undefined;
    }

    const publicDetails = await lstat(path);
    if (!publicDetails.isSymbolicLink()) {
      return isOwnedPrivateSocket(publicDetails) ? path : undefined;
    }
    if (typeof process.getuid === "function" && publicDetails.uid !== process.getuid()) return undefined;
    const target = await readlink(path);
    if (!OMP_SOCKET_NAME.test(target) || target.includes("/") || target.includes("\\")) return undefined;
    const backingPath = join(parent, target);
    return isOwnedPrivateSocket(await lstat(backingPath)) ? backingPath : undefined;
  } catch {
    return undefined;
  }
}

async function webRootReady(webRoot) {
  try {
    return (await stat(join(webRoot, "index.html"))).isFile();
  } catch {
    return false;
  }
}

function replyText(response, statusCode, contentType, body, headOnly = false) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(headOnly ? undefined : body);
}

async function sendIndex(request, response, options) {
  try {
    const source = await readFile(join(options.webRoot, "index.html"), "utf8");
    const body = injectBackendConfig(source, options);
    response.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    replyText(response, 200, MIME_TYPES.get(".html"), body, request.method === "HEAD");
  } catch {
    replyText(response, 503, "text/plain; charset=utf-8", "Omperator web build is unavailable");
  }
}

export function cacheControlForStaticPath(webRoot, path) {
  const root = resolve(webRoot);
  const relative = resolve(path).slice(root.length + 1).split(sep).join("/");
  return /^assets\/.+-[A-Za-z0-9_-]{8,}\.[^/]+$/u.test(relative)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

async function sendStatic(request, response, webRoot, path) {
  try {
    const details = await stat(path);
    if (!details.isFile()) return false;
    response.statusCode = 200;
    response.setHeader("Content-Type", MIME_TYPES.get(extname(path)) ?? "application/octet-stream");
    response.setHeader("Content-Length", details.size);
    response.setHeader("Cache-Control", cacheControlForStaticPath(webRoot, path));
    if (request.method === "HEAD") response.end();
    else createReadStream(path).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function guardSocketErrors(socket) {
  // Upgrade sockets can reset before ws installs its listeners or outlive
  // those listeners during close races. Keep one terminal listener attached
  // for the full connection lifetime.
  socket.on("error", () => socket.destroy());
  return socket;
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  guardSocketErrors(socket).end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function routeForUpgrade(pathname, profilesById, appSocket) {
  if (pathname === "/v1/ws") return { id: "default", appSocket };
  const match = /^\/v1\/profiles\/([^/]+)\/ws$/u.exec(pathname);
  if (match === null) return undefined;
  let id;
  try {
    id = normalizeProfileId(match[1]);
  } catch {
    return undefined;
  }
  return profilesById.get(id);
}

export function supervisorCommandForRoute(route) {
  if (route.serviceUnit === undefined) throw new Error("profile route has no start service unit");
  return process.platform === "darwin"
    ? { executable: "launchctl", argv: ["kickstart", `gui/${process.getuid?.() ?? ""}/${route.serviceUnit}`] }
    : { executable: "systemctl", argv: ["--user", "start", route.serviceUnit] };
}

function supervisorStart(route) {
  const command = supervisorCommandForRoute(route);
  const child = spawn(command.executable, command.argv, {
    shell: false,
    stdio: "ignore",
  });
  child.unref?.();
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("spawn", resolvePromise);
  });
}

function waitForRouteSocket(route, options, closed) {
  const deadline = Date.now() + options.profileStartWaitMs;
  let timer;
  return new Promise((resolvePromise) => {
    const check = async () => {
      if (closed()) {
        resolvePromise(undefined);
        return;
      }
      const resolved = await options.resolveAppSocket(route.appSocket);
      if (resolved !== undefined || Date.now() >= deadline) {
        resolvePromise(resolved);
        return;
      }
      timer = setTimeout(check, options.profileStartPollMs);
    };
    void check();
  }).finally(() => {
    clearTimeout(timer);
  });
}

function profileSocketResolver(route, options, state, closed) {
  const existing = state.starts.get(route.id);
  if (existing !== undefined) return existing;
  const now = Date.now();
  const previous = state.lastStarts.get(route.id) ?? 0;
  if (!options.startProfiles || !route.startEnabled || route.serviceUnit === undefined) {
    return Promise.resolve(undefined);
  }
  if (now - previous < options.profileStartCooldownMs) return Promise.resolve(undefined);
  state.lastStarts.set(route.id, now);
  const start = Promise.resolve()
    .then(() => options.startSupervisor(route))
    .then(() => waitForRouteSocket(route, options, closed))
    .finally(() => state.starts.delete(route.id));
  state.starts.set(route.id, start);
  return start;
}

function boundedReason(value, fallback) {
  const text = typeof value === "string" ? value.replace(/[\p{Cc}]/gu, " ").slice(0, 120) : "";
  return text || fallback;
}

/**
 * Live node + room registry (push model).
 *
 * The /enclave plugin in every runtime registers itself and its rooms with
 * this gateway directly — no session files are scanned, nothing is read from
 * disk. Each registration carries a heartbeat (the plugin re-registers every
 * 30s); entries that miss REGISTRY_TTL_MS expire on their own, so a crashed
 * runtime's rooms disappear without any file-watching. This is also the seed
 * of the spread-compute registry: /v1/discovery lists the live nodes and
 * their capabilities.
 */
const REGISTRY_TTL_MS = 90 * 1000;
const REGISTRY_SWEEP_MS = 15 * 1000;
const MAX_ROOMS_PER_NODE = 64;
const TOKEN_PATH = join(
  process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`,
  "omp",
  "enclave-token",
);

/** nodeId -> live node announcement { nodeId, hostname, arch, cpuCount, memoryBytes, version, lastSeen } */
const registryNodes = new Map();
/** `${nodeId}\u0000${sessionId}` -> { nodeId, sessionId, title, roomId, link, token, lastSeen } */
const registryRooms = new Map();
let registryToken = "";

function registryTtlMs() {
  const override = Number(process.env.T4_REGISTRY_TTL_MS);
  return Number.isSafeInteger(override) && override > 0 ? override : REGISTRY_TTL_MS;
}

function registrySweep(now = Date.now()) {
  const ttl = registryTtlMs();
  for (const [key, entry] of registryNodes) {
    if (now - entry.lastSeen > ttl) registryNodes.delete(key);
  }
  for (const [key, entry] of registryRooms) {
    if (now - entry.lastSeen > ttl) registryRooms.delete(key);
  }
}

function registryRoomForEntry(entry) {
  return {
    sessionId: entry.sessionId,
    title: entry.title,
    link: entry.link,
    token: entry.token,
    roomId: entry.roomId,
    nodeId: entry.nodeId,
    updatedAt: new Date(entry.lastSeen).toISOString(),
  };
}

function liveRegistryRooms() {
  registrySweep();
  return [...registryRooms.values()].map(registryRoomForEntry);
}

function liveRegistryNodes() {
  registrySweep();
  return [...registryNodes.values()]
    .map((entry) => ({
      nodeId: entry.nodeId,
      hostname: entry.hostname,
      arch: entry.arch,
      cpuCount: entry.cpuCount,
      memoryBytes: entry.memoryBytes,
      version: entry.version,
      roomCount: [...registryRooms.values()].filter((room) => room.nodeId === entry.nodeId).length,
      lastSeen: new Date(entry.lastSeen).toISOString(),
    }))
    .sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
}

/** The gateway owns the registration secret: env override, else a generated
 * token persisted under the user runtime dir (mode 0600). */
async function ensureRegistryToken(environment = process.env) {
  if (environment.T4_ENCLAVE_TOKEN !== undefined && environment.T4_ENCLAVE_TOKEN !== "") {
    registryToken = environment.T4_ENCLAVE_TOKEN;
    return registryToken;
  }
  try {
    const existing = await readFile(TOKEN_PATH, "utf8");
    const trimmed = existing.trim();
    if (trimmed.length >= 16) {
      registryToken = trimmed;
      return registryToken;
    }
  } catch {
    // fall through to generation
  }
  const bytes = new Uint8Array(32);
  const randomBytes = (await import("node:crypto")).randomBytes;
  registryToken = randomBytes(32).toString("base64url");
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dirname(TOKEN_PATH), { recursive: true, mode: 0o700 });
    await writeFile(TOKEN_PATH, `${registryToken}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("gateway: failed to persist registry token at", TOKEN_PATH, ":", err?.message ?? err);
  }
  return registryToken;
}

function registryAuthed(request) {
  const header = request.headers.authorization ?? "";
  const [scheme, presented] = header.split(/\s+/);
  if (scheme !== "Bearer" || typeof presented !== "string" || presented === "") return false;
  const expected = Buffer.from(registryToken);
  const actual = Buffer.from(presented);
  if (expected.byteLength !== actual.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < expected.byteLength; i += 1) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

function registryBody(request, response) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        replyText(response, 413, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "body too large" }));
        request.destroy();
        resolvePromise(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text === "" ? {} : JSON.parse(text));
      } catch {
        replyText(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "invalid JSON body" }));
        resolvePromise(undefined);
      }
    });
    request.on("error", () => resolvePromise(undefined));
  });
}

function registryText(value, name, maximum = 2_048) {
  return typeof value === "string" && value !== "" && value.length <= maximum ? value : undefined;
}

/**
 * Route one registry request. Returns true when the request was handled.
 * Handles POST /v1/nodes, POST /v1/nodes/<nodeId>/rooms,
 * DELETE /v1/nodes/<nodeId>/rooms/<sessionId>, and GET /v1/nodes.
 */
async function handleRegistryRequest(request, response, pathname, method) {
  if (pathname === "/v1/nodes" && (method === "POST" || method === "GET")) {
    if (method === "POST") {
      if (!registryAuthed(request)) {
        replyText(response, 401, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "unauthorized" }));
        return true;
      }
      const body = await registryBody(request, response);
      if (body === undefined) return true;
      const nodeId = registryText(body.nodeId, "nodeId");
      if (nodeId === undefined) {
        replyText(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "nodeId is required" }));
        return true;
      }
      registryNodes.set(nodeId, {
        nodeId,
        hostname: registryText(body.hostname, "hostname", 256) ?? nodeId,
        arch: registryText(body.arch, "arch", 64) ?? "",
        cpuCount: Number.isSafeInteger(body.cpuCount) && body.cpuCount > 0 ? body.cpuCount : undefined,
        memoryBytes: Number.isSafeInteger(body.memoryBytes) && body.memoryBytes > 0 ? body.memoryBytes : undefined,
        version: registryText(body.version, "version", 64) ?? "",
        lastSeen: Date.now(),
      });
      replyText(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      return true;
    }
    const body = JSON.stringify({ nodes: liveRegistryNodes() });
    replyText(response, 200, "application/json; charset=utf-8", body, request.method === "HEAD");
    return true;
  }

  const roomsMatch = pathname.match(/^\/v1\/nodes\/([^/]+)\/rooms(?:\/([^/]+))?$/u);
  if (roomsMatch !== null) {
    if (method !== "POST" && method !== "DELETE") {
      response.setHeader("Allow", "POST, DELETE");
      replyText(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      return true;
    }
    if (!registryAuthed(request)) {
      replyText(response, 401, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "unauthorized" }));
      return true;
    }
    let nodeId;
    try {
      nodeId = decodeURIComponent(roomsMatch[1]);
    } catch {
      nodeId = undefined;
    }
    if (nodeId === undefined || nodeId === "") {
      replyText(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "invalid nodeId" }));
      return true;
    }
    if (method === "DELETE") {
      let sessionId;
      try {
        sessionId = decodeURIComponent(roomsMatch[2] ?? "");
      } catch {
        sessionId = undefined;
      }
      registryRooms.delete(`${nodeId}\u0000${sessionId ?? ""}`);
      replyText(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      return true;
    }
    const body = await registryBody(request, response);
    if (body === undefined) return true;
    const sessionId = registryText(body.sessionId, "sessionId");
    const roomId = registryText(body.roomId, "roomId");
    const link = registryText(body.link, "link", 4_096);
    if (sessionId === undefined || roomId === undefined || link === undefined) {
      replyText(response, 400, "application/json; charset=utf-8", JSON.stringify({ ok: false, error: "sessionId, roomId, and link are required" }));
      return true;
    }
    const nodeRooms = [...registryRooms.values()].filter((room) => room.nodeId === nodeId);
    if (nodeRooms.length >= MAX_ROOMS_PER_NODE && !registryRooms.has(`${nodeId}\u0000${sessionId}`)) {
      // Drop the oldest room so one node cannot crowd out the registry.
      const oldest = nodeRooms.sort((a, b) => a.lastSeen - b.lastSeen)[0];
      registryRooms.delete(`${oldest.nodeId}\u0000${oldest.sessionId}`);
    }
    registryRooms.set(`${nodeId}\u0000${sessionId}`, {
      nodeId,
      sessionId,
      title: registryText(body.title, "title", 512) ?? "",
      roomId,
      link,
      token: registryText(body.token, "token", 2_048) ?? null,
      lastSeen: Date.now(),
    });
    replyText(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
    return true;
  }
  return false;
}

function bridgeBrowser(browser, options, activeBrowsers) {
  activeBrowsers.set(browser, true);
  const pending = [];
  let pendingBytes = 0;
  let finished = false;
  let upstreamOpen = false;
  const upstream = new WebSocket("ws://omp.local/ws", {
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
    createConnection: () => guardSocketErrors(connectSocket({ path: options.resolvedAppSocket })),
  });

  const finish = (code = 1011, reason = "gateway connection closed") => {
    if (finished) return;
    finished = true;
    activeBrowsers.delete(browser);
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) {
      try {
        browser.close(code, boundedReason(reason, "gateway connection closed"));
      } catch {
        browser.terminate();
      }
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "browser closed");
    else upstream.terminate();
  };

  browser.on("message", (data, isBinary) => {
    const payload = isBinary ? Buffer.from(data) : data.toString();
    const bytes = typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(payload, { binary: isBinary });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING || pendingBytes + bytes > MAX_PENDING_BYTES) {
      finish(1011, "local appserver unavailable");
      return;
    }
    pending.push({ payload, isBinary });
    pendingBytes += bytes;
  });
  browser.on("pong", () => {
    if (!finished) activeBrowsers.set(browser, true);
  });
  browser.on("close", () => finish(1000, "browser closed"));
  browser.on("error", () => finish());

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const item of pending) upstream.send(item.payload, { binary: item.isBinary });
    pending.length = 0;
    pendingBytes = 0;
  });
  upstream.on("message", (data, isBinary) => {
    if (!finished && browser.readyState === WebSocket.OPEN) browser.send(data, { binary: isBinary });
  });
  upstream.on("close", (_code, reason) => finish(1011, reason.toString("utf8") || "local appserver closed"));
  upstream.on("error", () => finish(1011, "local appserver unavailable"));
}

export async function startTailnetGateway(input) {
  const resolveSocket = input.resolveAppSocket ?? resolveAppSocket;
  if (typeof resolveSocket !== "function") throw new Error("appserver socket resolver is invalid");
  const options = {
    webRoot: resolve(requiredText(input.webRoot, "web root", 4_096)),
    appSocket: resolve(requiredText(input.appSocket, "appserver socket", 4_096)),
    listenHost: input.listenHost ?? "127.0.0.1",
    listenPort: input.listenPort ?? DEFAULT_PORT,
    allowedOrigin: normalizeAllowedOrigin(input.allowedOrigin),
    nativeAllowedOrigins: normalizeNativeAllowedOrigins(input.nativeAllowedOrigins),
    label: input.label ?? "OMP on this Tailnet host",
    deploymentIdentity: normalizeDeploymentIdentity(input.deploymentIdentity),
    ...(input.rendezvousUrl === undefined || input.rendezvousUrl === ""
      ? {}
      : { rendezvousUrl: normalizeRendezvousUrl(input.rendezvousUrl) }),
    ...(input.relayUrl === undefined || input.relayUrl === ""
      ? {}
      : { relayUrl: normalizeRelayUrl(input.relayUrl) }),
    clusterOperatorEnabled: input.clusterOperatorEnabled === true,
    clusterWsUrl:
      input.clusterOperatorEnabled === true
        ? normalizeClusterWebSocketUrl(input.clusterWsUrl)
        : undefined,
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    hostDnsName:
      input.hostDnsName === undefined || input.hostDnsName === ""
        ? undefined
        : requiredText(input.hostDnsName, "T4_HOST_DNS_NAME", 253).replace(/\.$/, ""),
    profiles: normalizeProfileRoutes(input.profileRoutes ?? input.profiles ?? []),
    startProfiles: input.startProfiles === true || input.enableProfileStarts === true,
    profileStartWaitMs: input.profileStartWaitMs ?? DEFAULT_PROFILE_START_WAIT_MS,
    profileStartPollMs: input.profileStartPollMs ?? DEFAULT_PROFILE_START_POLL_MS,
    profileStartCooldownMs: input.profileStartCooldownMs ?? DEFAULT_PROFILE_START_COOLDOWN_MS,
    environment: input.environment ?? process.env,

    resolveAppSocket: resolveSocket,
    startSupervisor: input.startSupervisor ?? supervisorStart,
  };
  if (!LOOPBACK_HOSTS.has(options.listenHost)) throw new Error("Tailnet gateway must listen on loopback");
  if (!Number.isSafeInteger(options.listenPort) || options.listenPort < 0 || options.listenPort > 65_535) {
    throw new Error("Tailnet gateway port is invalid");
  }
  for (const [name, value] of [
    ["heartbeat interval", options.heartbeatIntervalMs],
    ["profile start wait", options.profileStartWaitMs],
    ["profile start poll", options.profileStartPollMs],
    ["profile start cooldown", options.profileStartCooldownMs],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Tailnet gateway ${name} is invalid`);
  }
  if (typeof options.startSupervisor !== "function") throw new Error("profile supervisor starter is invalid");
  const allowedSocketOrigins = new Set([options.allowedOrigin, ...options.nativeAllowedOrigins]);
  const profilesById = new Map(options.profiles.map((profile) => [profile.id, profile]));
  const startState = { starts: new Map(), lastStarts: new Map() };
  // One-shot MagicDNS lookup for /v1/discovery: the first request spawns
  // `tailscale status --json` once and the result is cached. A failed spawn
  // is not cached so a later request can retry.
  const resolveDiscoveryHostName = () => Promise.resolve(options.hostDnsName ?? hostname());
  let closed = false;
  // E2E control-plane adapter for the public (relay) model: hosts pairing
  // rooms on the relay and mints the 6-digit codes the desktop displays.
  // Only started when T4_RELAY_URL is configured.
  let relayControl;

  // Registration secret: loaded once at startup (env or generated token).
  await ensureRegistryToken(options.environment ?? process.env);

  // TTL sweeper: expired node/room announcements leave on their own.
  const registrySweeper = setInterval(() => {
    try {
      registrySweep();
    } catch {
      // sweep failures are non-fatal
    }
  }, REGISTRY_SWEEP_MS);
  registrySweeper.unref?.();

  const activeBrowsers = new Map();
  const webSockets = new WebSocketServer({
    clientTracking: false,
    maxPayload: MAX_FRAME_BYTES,
    noServer: true,
    perMessageDeflate: false,
  });
  const server = createServer((request, response) => {
    void (async () => {
      applySecurityHeaders(response, options.allowedOrigin, options.clusterWsUrl);
      const pathname = requestPath(request.url);
      if (pathname === "/healthz") {
        const [web, resolvedAppSocket] = await Promise.all([
          webRootReady(options.webRoot),
          options.resolveAppSocket(options.appSocket),
        ]);
        const upstream = resolvedAppSocket !== undefined;
        const healthy = web && upstream;
        const body = JSON.stringify({
          ok: healthy,
          web,
          upstream,
          activeSessions: activeBrowsers.size,
          transport: "local-unix",
          deploymentIdentity: options.deploymentIdentity,
        });
        response.setHeader("Cache-Control", "no-store");
        replyText(response, healthy ? 200 : 503, "application/json; charset=utf-8", body, request.method === "HEAD");
        return;
      }
      const method = request.method ?? "GET";
      if (pathname.startsWith("/v1/nodes")) {
        if (await handleRegistryRequest(request, response, pathname, method)) return;
      }
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        replyText(response, 405, "text/plain; charset=utf-8", "Method not allowed");
        return;
      }
      if (pathname === "/v1/discovery") {
        // wsUrl prefers the request's own https origin when it is one the
        // gateway already serves (browser clients); native clients, which
        // send no Origin header, get the configured T4_ALLOWED_ORIGIN.
        const requestOrigin = request.headers.origin;
        const origin =
          requestOrigin !== undefined &&
          allowedSocketOrigins.has(requestOrigin) &&
          requestOrigin.startsWith("https://")
            ? requestOrigin
            : options.allowedOrigin;
        const body = JSON.stringify({
          hostName: await resolveDiscoveryHostName(),
          label: options.label,
          deploymentIdentity: options.deploymentIdentity,
          autoApprove: true,
          wsUrl: new URL("/v1/ws", origin).toString(),
          roomsEndpoint: "/v1/rooms",
          nodes: liveRegistryNodes(),
        });
        response.setHeader("Cache-Control", "no-store");
        replyText(response, 200, "application/json; charset=utf-8", body, request.method === "HEAD");
        return;
      }
      if (pathname === "/v1/pair-code") {
        // The desktop mints the 6-digit pairing code the phone redeems at the
        // rendezvous. Only available when the relay control-plane adapter is
        // running (T4_RELAY_URL configured).
        if (!relayControl) {
          replyText(
            response,
            404,
            "application/json; charset=utf-8",
            JSON.stringify({ ok: false, error: "relay control is not enabled" }),
            request.method === "HEAD",
          );
          return;
        }
        try {
          const minted = await relayControl.mintPairCode();
          const body = JSON.stringify({ ok: true, hostId: minted.hostId, code: minted.code });
          replyText(response, 200, "application/json; charset=utf-8", body, request.method === "HEAD");
        } catch (error) {
          replyText(
            response,
            503,
            "application/json; charset=utf-8",
            JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "pairing unavailable" }),
            request.method === "HEAD",
          );
        }
        return;
      }
      if (pathname === "/v1/rooms") {
        const body = JSON.stringify({ rooms: liveRegistryRooms() });
        response.setHeader("Cache-Control", "no-store");
        replyText(response, 200, "application/json; charset=utf-8", body, request.method === "HEAD");
        return;
      }
      const path = safeStaticPath(options.webRoot, pathname);
      if (
        path !== undefined &&
        !path.endsWith(`${sep}index.html`) &&
        (await sendStatic(request, response, options.webRoot, path))
      )
        return;
      await sendIndex(request, response, options);
    })().catch(() => {
      if (!response.headersSent) replyText(response, 500, "text/plain; charset=utf-8", "Gateway request failed");
      else response.destroy();
    });
  });

  server.on("upgrade", (request, socket, head) => {
    guardSocketErrors(socket);
    const pathname = requestPath(request.url);
    const route = routeForUpgrade(pathname, profilesById, options.appSocket);
    // Route lookup happens before any socket resolution or supervisor call.
    if (route === undefined) {
      rejectUpgrade(socket, "404 Not Found", "Not found");
      return;
    }
    // Browsers MUST send an allowed Origin (CSWSH guard). Native binaries
    // (the Swift ports, t4 CLI) send no Origin at all and cannot be
    // browser-forged, so a missing Origin is accepted — the host-wire
    // handshake below still authenticates (pairing / device token / the
    // gateway's local transport, which welcomes as .local).
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedSocketOrigins.has(origin)) {
      rejectUpgrade(socket, "403 Forbidden", "Origin not allowed");
      return;
    }
    const socketPromise =
      route.id === "default"
        ? options.resolveAppSocket(route.appSocket)
        : options.resolveAppSocket(route.appSocket).then((resolved) => {
            if (resolved !== undefined) return resolved;
            return profileSocketResolver(route, options, startState, () => closed);
          });
    void socketPromise.then(
      (resolvedAppSocket) => {
        if (resolvedAppSocket === undefined || closed) {
          rejectUpgrade(socket, "503 Service Unavailable", "Local appserver unavailable");
          return;
        }
        webSockets.handleUpgrade(request, socket, head, (browser) => {
          bridgeBrowser(browser, { ...options, resolvedAppSocket }, activeBrowsers);
        });
      },
      () => rejectUpgrade(socket, "503 Service Unavailable", "Local appserver unavailable"),
    );
  });

  await new Promise((resolvePromise, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(options.listenPort, options.listenHost, () => {
      server.off("error", onError);
      resolvePromise();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("gateway did not bind a TCP socket");
  const heartbeat = setInterval(() => {
    for (const [browser, responsive] of activeBrowsers) {
      if (!responsive) {
        browser.terminate();
        continue;
      }
      activeBrowsers.set(browser, false);
      try {
        browser.ping();
      } catch {
        browser.terminate();
      }
    }
  }, options.heartbeatIntervalMs);
  heartbeat.unref();
  const stopRendezvous = startRendezvousAnnounce(options, resolveDiscoveryHostName);
  if (options.relayUrl !== undefined) {
    relayControl = startRelayControl({
      relayUrl: options.relayUrl,
      rendezvousUrl: options.rendezvousUrl,
      hostId: options.deploymentIdentity,
      appSocketPath: options.appSocket,
    });
  }

  return {
    host: options.listenHost,
    port: address.port,
    close: async () => {
      closed = true;
      clearInterval(heartbeat);
      for (const browser of activeBrowsers.keys()) browser.terminate();
      await relayControl?.stop();
      await stopRendezvous();
      await new Promise((resolvePromise) => server.close(() => resolvePromise()));
      webSockets.close();
    },
  };
}

function defaultSocketPath(environment) {
  if (process.platform === "darwin") return join(homedir(), ".omp", "run", "appserver.sock");
  const runtime = environment.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`;
  return join(runtime, "omp", "appserver.sock");
}

export function optionsFromEnvironment(environment = process.env) {
  const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
  const port = Number.parseInt(environment.T4_GATEWAY_PORT ?? String(DEFAULT_PORT), 10);
  let profileRoutes = [];
  if (environment.T4_PROFILE_ROUTES !== undefined) {
    try {
      profileRoutes = JSON.parse(environment.T4_PROFILE_ROUTES);
    } catch {
      throw new Error("T4_PROFILE_ROUTES must be valid JSON");
    }
  }
  const clusterOperatorEnabled = environment.T4_CLUSTER_OPERATOR_ENABLED === "true";
  if (
    environment.T4_CLUSTER_OPERATOR_ENABLED !== undefined &&
    environment.T4_CLUSTER_OPERATOR_ENABLED !== "false" &&
    !clusterOperatorEnabled
  ) {
    throw new Error("T4_CLUSTER_OPERATOR_ENABLED must be true or false");
  }
  const clusterWsUrl = clusterOperatorEnabled
    ? normalizeClusterWebSocketUrl(environment.T4_CLUSTER_WS_URL)
    : undefined;
  return {
    webRoot: environment.T4_WEB_ROOT ?? resolve(scriptDirectory, "..", "apps", "web", "dist"),
    appSocket: environment.T4_APP_SERVER_SOCKET ?? defaultSocketPath(environment),
    listenHost: environment.T4_GATEWAY_HOST ?? "127.0.0.1",
    listenPort: port,
    allowedOrigin: environment.T4_ALLOWED_ORIGIN,
    nativeAllowedOrigins:
      environment.T4_NATIVE_ALLOWED_ORIGINS === undefined
        ? undefined
        : environment.T4_NATIVE_ALLOWED_ORIGINS.split(","),
    label: environment.T4_HOST_LABEL ?? "OMP on this Tailnet host",
    hostDnsName: environment.T4_HOST_DNS_NAME,
    deploymentIdentity: environment.T4_DEPLOYMENT_IDENTITY,
    rendezvousUrl: environment.T4_RENDEZVOUS_URL,
    relayUrl: environment.T4_RELAY_URL,
    clusterOperatorEnabled,
    clusterWsUrl,
    profileRoutes,
    startProfiles: environment.T4_ENABLE_PROFILE_STARTS === "1",
    environment,
  };
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const gateway = await startTailnetGateway(optionsFromEnvironment());
    console.log(`T4 Tailnet gateway listening on http://${gateway.host}:${gateway.port}`);
    const stop = () => {
      void gateway.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "T4 Tailnet gateway failed");
    process.exitCode = 1;
  }
}
