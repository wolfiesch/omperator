import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import {
  CAPACITOR_NATIVE_ORIGINS,
  cacheControlForStaticPath,
  injectBackendConfig,
  normalizeAllowedOrigin,
  normalizeNativeAllowedOrigins,
  optionsFromEnvironment,
  resolveAppSocket,
  safeStaticPath,
  startTailnetGateway,
} from "./tailnet-gateway.mjs";

const ALLOWED_ORIGIN = "https://host.example-tailnet.ts.net:8445";

function websocketMessage(socket) {
  return new Promise((resolvePromise, reject) => {
    socket.once("message", (data) => resolvePromise(data.toString()));
    socket.once("error", reject);
  });
}

function websocketOpen(socket) {
  return new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
}

async function fixture(socketTopology = "symlink", gatewayOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "t4-gateway-"));
  const webRoot = join(directory, "web");
  const socketPath = join(directory, "appserver.sock");
  const backingSocketPath = join(directory, ".appserver-62e2983f-8779-464e-a184-82e0e962b87d.sock");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<!doctype html><html><head></head><body>T4</body></html>");
  await writeFile(join(webRoot, "app.js"), "console.log('t4')");
  await writeFile(
    join(webRoot, "manifest.webmanifest"),
    JSON.stringify({ name: "T4 Code", display: "standalone" }),
  );
  await mkdir(join(webRoot, "assets"));
  await writeFile(join(webRoot, "assets", "app-deadbeef.js"), "console.log('hashed')");

  const upstreamServer = createServer();
  const upstreamSockets = new WebSocketServer({ server: upstreamServer });
  upstreamSockets.on("connection", (socket) => {
    socket.on("message", (data) => socket.send(`upstream:${data.toString()}`));
  });
  await new Promise((resolvePromise, reject) => {
    upstreamServer.once("error", reject);
    upstreamServer.listen(socketTopology === "symlink" ? backingSocketPath : socketPath, resolvePromise);
  });
  const listeningSocket = socketTopology === "symlink" ? backingSocketPath : socketPath;
  await chmod(listeningSocket, 0o600);
  if (socketTopology === "symlink") await symlink(".appserver-62e2983f-8779-464e-a184-82e0e962b87d.sock", socketPath);

  const gateway = await startTailnetGateway({
    webRoot,
    appSocket: socketPath,
    allowedOrigin: ALLOWED_ORIGIN,
    listenPort: 0,
    label: "Test host </script>",
    ...gatewayOptions,
  });
  return {
    gateway,
    url: `http://${gateway.host}:${gateway.port}`,
    socketPath,
    resolvedSocketPath: listeningSocket,
    close: async () => {
      await gateway.close();
      await new Promise((resolvePromise) => upstreamSockets.close(() => resolvePromise()));
      await new Promise((resolvePromise) => upstreamServer.close(() => resolvePromise()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("origin validation accepts only explicit Tailscale HTTPS origins", () => {
  assert.equal(normalizeAllowedOrigin(ALLOWED_ORIGIN), ALLOWED_ORIGIN);
  for (const value of [
    "http://host.example-tailnet.ts.net",
    "https://example.com",
    "https://host.example-tailnet.ts.net/path",
    "https://user@host.example-tailnet.ts.net",
  ]) {
    assert.throws(() => normalizeAllowedOrigin(value), /Tailscale HTTPS origin/u);
  }
});

test("native origin validation is pinned to Capacitor's Android and iOS defaults", () => {
  assert.deepEqual(normalizeNativeAllowedOrigins(), ["https://localhost", "capacitor://localhost"]);
  assert.deepEqual(normalizeNativeAllowedOrigins(["capacitor://localhost", "https://localhost"]), [
    ...CAPACITOR_NATIVE_ORIGINS,
  ]);
  for (const value of [
    ["*"],
    ["null"],
    ["http://localhost", "capacitor://localhost"],
    ["https://localhost", "capacitor://localhost", "https://mobile.example.com"],
  ]) {
    assert.throws(() => normalizeNativeAllowedOrigins(value), /must contain exactly/u);
  }
});

test("gateway environment parses the explicit comma-separated native origin set", () => {
  const options = optionsFromEnvironment({
    T4_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    T4_NATIVE_ALLOWED_ORIGINS: "https://localhost,capacitor://localhost",
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.deepEqual(normalizeNativeAllowedOrigins(options.nativeAllowedOrigins), [
    "https://localhost",
    "capacitor://localhost",
  ]);
});

test("backend injection is explicit, credential-free, and script-safe", () => {
  const source = "<html><head></head><body></body></html>";
  const injected = injectBackendConfig(source, {
    allowedOrigin: ALLOWED_ORIGIN,
    label: "Host </script><script>alert(1)</script>",
  });
  assert.match(injected, /id="t4-backend"/u);
  assert.match(injected, /wss:\/\/host\.example-tailnet\.ts\.net:8445\/v1\/ws/u);
  assert.doesNotMatch(injected, /<script>alert/u);
  assert.doesNotMatch(injected, /token|password|credential/iu);
});

test("static path resolution cannot leave the web root", () => {
  assert.equal(safeStaticPath("/srv/t4", "/assets/app.js"), "/srv/t4/assets/app.js");
  assert.equal(safeStaticPath("/srv/t4", "/../../etc/passwd"), undefined);
  assert.equal(safeStaticPath("/srv/t4", "/%00"), undefined);
});

test("only fingerprinted build assets receive immutable caching", () => {
  assert.equal(cacheControlForStaticPath("/srv/t4", "/srv/t4/t4-bootstrap.js"), "no-cache");
  assert.equal(cacheControlForStaticPath("/srv/t4", "/srv/t4/app.js"), "no-cache");
  assert.equal(
    cacheControlForStaticPath("/srv/t4", "/srv/t4/assets/index-deadbeef.js"),
    "public, max-age=31536000, immutable",
  );
});

test("socket resolution accepts both a private direct socket and OMP's rotating public symlink", async () => {
  for (const topology of ["direct", "symlink"]) {
    const running = await fixture(topology);
    try {
      assert.equal(await resolveAppSocket(running.socketPath), running.resolvedSocketPath);
    } finally {
      await running.close();
    }
  }
});

test("gateway serves configured app and reports real upstream health", async () => {
  const running = await fixture();
  try {
    const indexResponse = await fetch(`${running.url}/`);
    assert.equal(indexResponse.status, 200);
    assert.match(await indexResponse.text(), /id="t4-backend"/u);
    assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
    const contentSecurityPolicy = indexResponse.headers.get("content-security-policy");
    assert.match(
      contentSecurityPolicy ?? "",
      /connect-src 'self' wss:\/\/host\.example-tailnet\.ts\.net:8445/u,
    );
    assert.doesNotMatch(contentSecurityPolicy ?? "", /\*/u);

    const assetResponse = await fetch(`${running.url}/app.js`);
    assert.equal(assetResponse.status, 200);
    assert.equal(await assetResponse.text(), "console.log('t4')");
    assert.equal(assetResponse.headers.get("cache-control"), "no-cache");

    const manifestResponse = await fetch(`${running.url}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.equal(
      manifestResponse.headers.get("content-type"),
      "application/manifest+json; charset=utf-8",
    );
    assert.equal(manifestResponse.headers.get("cache-control"), "no-cache");
    assert.deepEqual(await manifestResponse.json(), { name: "T4 Code", display: "standalone" });

    const fingerprintedResponse = await fetch(`${running.url}/assets/app-deadbeef.js`);
    assert.equal(fingerprintedResponse.status, 200);
    assert.equal(
      fingerprintedResponse.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );

    const healthResponse = await fetch(`${running.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      web: true,
      upstream: true,
      activeSessions: 0,
      transport: "local-unix",
    });
  } finally {
    await running.close();
  }
});

test("gateway rejects cross-origin sockets and bridges only the web and native allowlist", async () => {
  const running = await fixture();
  try {
    for (const origin of ["https://attacker.example-tailnet.ts.net", "null", "*"]) {
      const denied = new WebSocket(`${running.url.replace("http", "ws")}/v1/ws`, {
        headers: { Origin: origin },
      });
      const deniedStatus = await new Promise((resolvePromise, reject) => {
        denied.once("unexpected-response", (_request, response) =>
          resolvePromise(response.statusCode),
        );
        denied.once("open", () => reject(new Error(`socket opened for denied origin ${origin}`)));
        denied.once("error", () => {});
      });
      assert.equal(deniedStatus, 403);
    }

    for (const origin of [ALLOWED_ORIGIN, ...CAPACITOR_NATIVE_ORIGINS]) {
      const allowed = new WebSocket(`${running.url.replace("http", "ws")}/v1/ws`, {
        headers: { Origin: origin },
      });
      await websocketOpen(allowed);
      allowed.send(`hello:${origin}`);
      assert.equal(await websocketMessage(allowed), `upstream:hello:${origin}`);
      allowed.close();
    }
  } finally {
    await running.close();
  }
});

test("gateway heartbeat removes a half-open browser whose proxy never forwards close", async () => {
  const running = await fixture("symlink", { heartbeatIntervalMs: 20 });
  try {
    const abandoned = new WebSocket(`${running.url.replace("http", "ws")}/v1/ws`, {
      autoPong: false,
      headers: { Origin: ALLOWED_ORIGIN },
    });
    await websocketOpen(abandoned);

    assert.equal((await (await fetch(`${running.url}/healthz`)).json()).activeSessions, 1);
    await new Promise((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("gateway did not terminate stale browser")), 500);
      abandoned.once("close", () => {
        clearTimeout(timeout);
        resolvePromise();
      });
    });
    assert.equal((await (await fetch(`${running.url}/healthz`)).json()).activeSessions, 0);
  } finally {
    await running.close();
  }
});

test("gateway heartbeat preserves responsive browsers", async () => {
  const running = await fixture("symlink", { heartbeatIntervalMs: 20 });
  try {
    const responsive = new WebSocket(`${running.url.replace("http", "ws")}/v1/ws`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    await websocketOpen(responsive);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));

    assert.equal((await (await fetch(`${running.url}/healthz`)).json()).activeSessions, 1);
    responsive.send("still here");
    assert.equal(await websocketMessage(responsive), "upstream:still here");
    responsive.close();
  } finally {
    await running.close();
  }
});
