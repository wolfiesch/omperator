#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { lstat, readFile, readlink, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { homedir } from "node:os";
import { dirname, extname, join, parse, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import WebSocket, { WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const DEFAULT_PORT = 4_194;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
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

export function websocketUrlForOrigin(origin) {
  const url = new URL("/v1/ws", normalizeAllowedOrigin(origin));
  url.protocol = "wss:";
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
  const payload = safeJson({
    wsUrl: websocketUrlForOrigin(options.allowedOrigin),
    label: requiredText(options.label, "gateway label", 128),
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

function gatewayCsp(allowedOrigin) {
  const websocketOrigin = new URL(websocketUrlForOrigin(allowedOrigin)).origin;
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src 'self' ${websocketOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

function applySecurityHeaders(response, allowedOrigin) {
  response.setHeader("Content-Security-Policy", gatewayCsp(allowedOrigin));
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

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
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
    createConnection: () => connectSocket({ path: options.resolvedAppSocket }),
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
  const options = {
    webRoot: resolve(requiredText(input.webRoot, "web root", 4_096)),
    appSocket: resolve(requiredText(input.appSocket, "appserver socket", 4_096)),
    listenHost: input.listenHost ?? "127.0.0.1",
    listenPort: input.listenPort ?? DEFAULT_PORT,
    allowedOrigin: normalizeAllowedOrigin(input.allowedOrigin),
    nativeAllowedOrigins: normalizeNativeAllowedOrigins(input.nativeAllowedOrigins),
    label: input.label ?? "OMP on this Tailnet host",
    heartbeatIntervalMs: input.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  };
  if (!LOOPBACK_HOSTS.has(options.listenHost)) throw new Error("Tailnet gateway must listen on loopback");
  if (!Number.isSafeInteger(options.listenPort) || options.listenPort < 0 || options.listenPort > 65_535) {
    throw new Error("Tailnet gateway port is invalid");
  }
  if (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 10) {
    throw new Error("Tailnet gateway heartbeat interval is invalid");
  }
  const allowedSocketOrigins = new Set([options.allowedOrigin, ...options.nativeAllowedOrigins]);

  const activeBrowsers = new Map();
  const webSockets = new WebSocketServer({
    clientTracking: false,
    maxPayload: MAX_FRAME_BYTES,
    noServer: true,
    perMessageDeflate: false,
  });
  const server = createServer((request, response) => {
    void (async () => {
      applySecurityHeaders(response, options.allowedOrigin);
      const pathname = requestPath(request.url);
      if (pathname === "/healthz") {
        const [web, resolvedAppSocket] = await Promise.all([
          webRootReady(options.webRoot),
          resolveAppSocket(options.appSocket),
        ]);
        const upstream = resolvedAppSocket !== undefined;
        const healthy = web && upstream;
        const body = JSON.stringify({
          ok: healthy,
          web,
          upstream,
          activeSessions: activeBrowsers.size,
          transport: "local-unix",
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
    if (requestPath(request.url) !== "/v1/ws") {
      rejectUpgrade(socket, "404 Not Found", "Not found");
      return;
    }
    if (!allowedSocketOrigins.has(request.headers.origin)) {
      rejectUpgrade(socket, "403 Forbidden", "Origin not allowed");
      return;
    }
    void resolveAppSocket(options.appSocket).then((resolvedAppSocket) => {
      if (resolvedAppSocket === undefined) {
        rejectUpgrade(socket, "503 Service Unavailable", "Local appserver unavailable");
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (browser) => {
        bridgeBrowser(browser, { ...options, resolvedAppSocket }, activeBrowsers);
      });
    });
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
