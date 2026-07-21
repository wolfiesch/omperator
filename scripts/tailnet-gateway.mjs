#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

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
    url.hash !== "" ||
    !url.hostname.endsWith(".ts.net")
  ) {
    throw new Error("T4_ALLOWED_ORIGIN must be a Tailscale HTTPS origin ending in .ts.net");
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
    url.hash !== "" ||
    !url.hostname.endsWith(".ts.net")
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
    replyText(response, 503, "text/plain; charset=utf-8", "T4 Code web build is unavailable");
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
    clusterOperatorEnabled: input.clusterOperatorEnabled === true,
    clusterWsUrl:
      input.clusterOperatorEnabled === true
        ? normalizeClusterWebSocketUrl(input.clusterWsUrl)
        : undefined,
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    profiles: normalizeProfileRoutes(input.profileRoutes ?? input.profiles ?? []),
    startProfiles: input.startProfiles === true || input.enableProfileStarts === true,
    profileStartWaitMs: input.profileStartWaitMs ?? DEFAULT_PROFILE_START_WAIT_MS,
    profileStartPollMs: input.profileStartPollMs ?? DEFAULT_PROFILE_START_POLL_MS,
    profileStartCooldownMs: input.profileStartCooldownMs ?? DEFAULT_PROFILE_START_COOLDOWN_MS,
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
  let closed = false;

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
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        replyText(response, 405, "text/plain; charset=utf-8", "Method not allowed");
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
    if (!allowedSocketOrigins.has(request.headers.origin)) {
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

  return {
    host: options.listenHost,
    port: address.port,
    close: async () => {
      closed = true;
      clearInterval(heartbeat);
      for (const browser of activeBrowsers.keys()) browser.terminate();
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
    deploymentIdentity: environment.T4_DEPLOYMENT_IDENTITY,
    clusterOperatorEnabled,
    clusterWsUrl,
    profileRoutes,
    startProfiles: environment.T4_ENABLE_PROFILE_STARTS === "1",
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
