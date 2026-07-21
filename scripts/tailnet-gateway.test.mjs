import assert from "node:assert/strict";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import WebSocket, { WebSocketServer } from "ws";

import {
  CAPACITOR_NATIVE_ORIGINS,
  cacheControlForStaticPath,
  injectBackendConfig,
  normalizeClusterWebSocketUrl,
  normalizeAllowedOrigin,
  normalizeDeploymentIdentity,
  normalizeNativeAllowedOrigins,
  normalizeProfileRoutes,
  supervisorCommandForRoute,
  optionsFromEnvironment,
  resolveAppSocket,
  safeStaticPath,
  startTailnetGateway,
} from "./tailnet-gateway.mjs";
import { makeCanonicalTemporaryDirectory } from "./test-temporary-directory.mjs";

const ALLOWED_ORIGIN = "https://host.example-tailnet.ts.net:8445";
const DEPLOYMENT_IDENTITY = `sha256:${"b".repeat(64)}`;

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
  const directory = await makeCanonicalTemporaryDirectory("t4-gateway-");
  await chmod(directory, 0o700);
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

  const resolvedGatewayOptions = {
    ...gatewayOptions,
    ...(gatewayOptions.profileRoutes === undefined
      ? {}
      : {
          profileRoutes: gatewayOptions.profileRoutes.map((route) => ({
            ...route,
            ...(route.appSocket === "$fixture-default-socket" ? { appSocket: socketPath } : {}),
          })),
        }),
  };
  const gateway = await startTailnetGateway({
    webRoot,
    appSocket: socketPath,
    allowedOrigin: ALLOWED_ORIGIN,
    listenPort: 0,
    label: "Test host </script>",
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    ...resolvedGatewayOptions,
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

test("deployment identity accepts only an exact immutable SHA-256 token", () => {
  assert.equal(normalizeDeploymentIdentity(DEPLOYMENT_IDENTITY), DEPLOYMENT_IDENTITY);
  for (const value of ["latest", `sha256:${"B".repeat(64)}`, `sha256:${"b".repeat(63)}`]) {
    assert.throws(() => normalizeDeploymentIdentity(value), /exactly 64 lowercase hexadecimal/u);
  }
});

test("gateway environment parses the explicit comma-separated native origin set", () => {
  const options = optionsFromEnvironment({
    T4_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    T4_NATIVE_ALLOWED_ORIGINS: "https://localhost,capacitor://localhost",
    T4_DEPLOYMENT_IDENTITY: DEPLOYMENT_IDENTITY,
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.deepEqual(normalizeNativeAllowedOrigins(options.nativeAllowedOrigins), [
    "https://localhost",
    "capacitor://localhost",
  ]);
  assert.equal(options.deploymentIdentity, DEPLOYMENT_IDENTITY);
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

test("cluster gateway configuration is default-off and adds no implicit target", () => {
  const options = optionsFromEnvironment({
    T4_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    T4_DEPLOYMENT_IDENTITY: DEPLOYMENT_IDENTITY,
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.equal(options.clusterOperatorEnabled, false);
  assert.equal(options.clusterWsUrl, undefined);

  const injected = injectBackendConfig("<html><head></head><body></body></html>", {
    allowedOrigin: ALLOWED_ORIGIN,
    label: "Ordinary host",
  });
  const payload = JSON.parse(/<script id="t4-backend" type="application\/json">([^<]+)<\/script>/u.exec(injected)?.[1] ?? "null");
  assert.deepEqual(Object.keys(payload).sort(), ["label", "wsUrl"]);
});

test("cluster gateway opts into exactly one credential-free secure WSS target", () => {
  const clusterWsUrl = "wss://operator.example-tailnet.ts.net/v1/ws";
  assert.equal(normalizeClusterWebSocketUrl(clusterWsUrl), clusterWsUrl);
  for (const value of [
    "ws://operator.example-tailnet.ts.net/v1/ws",
    "wss://operator.example-tailnet.ts.net:30000/v1/ws",
    "wss://operator.example-tailnet.ts.net/v1/ws?token=secret",
    "wss://user:secret@operator.example-tailnet.ts.net/v1/ws",
    "wss://operator.example.com/v1/ws",
  ]) {
    assert.throws(() => normalizeClusterWebSocketUrl(value), /secure WSS cluster target/u);
  }

  const options = optionsFromEnvironment({
    T4_ALLOWED_ORIGIN: ALLOWED_ORIGIN,
    T4_DEPLOYMENT_IDENTITY: DEPLOYMENT_IDENTITY,
    T4_CLUSTER_OPERATOR_ENABLED: "true",
    T4_CLUSTER_WS_URL: clusterWsUrl,
    XDG_RUNTIME_DIR: "/run/user/1000",
  });
  assert.equal(options.clusterOperatorEnabled, true);
  assert.equal(options.clusterWsUrl, clusterWsUrl);
  const injected = injectBackendConfig("<html><head></head><body></body></html>", {
    allowedOrigin: ALLOWED_ORIGIN,
    label: "Operator",
    clusterOperatorEnabled: options.clusterOperatorEnabled,
    clusterWsUrl: options.clusterWsUrl,
  });
  const payload = JSON.parse(/<script id="t4-backend" type="application\/json">([^<]+)<\/script>/u.exec(injected)?.[1] ?? "null");
  assert.deepEqual(payload, {
    wsUrl: clusterWsUrl,
    label: "Operator",
    clusterOperatorEnabled: true,
  });
  assert.doesNotMatch(injected, /token|secret|credential/iu);
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
    assert.match(contentSecurityPolicy ?? "", /img-src 'self' data: blob:/u);
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
      deploymentIdentity: DEPLOYMENT_IDENTITY,
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

test("gateway survives peer resets while rejecting websocket upgrades", async () => {
  const running = await fixture();
  try {
    const request = [
      "GET /v1/ws HTTP/1.1",
      `Host: ${running.gateway.host}:${running.gateway.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "Origin: https://attacker.example-tailnet.ts.net",
      "",
      "",
    ].join("\r\n");
    await Promise.all(
      Array.from({ length: 32 }, () =>
        new Promise((resolvePromise, reject) => {
          const socket = connectSocket({
            host: running.gateway.host,
            port: running.gateway.port,
          });
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.write(request, () => {
              socket.off("error", reject);
              socket.on("error", () => {});
              socket.resetAndDestroy();
              resolvePromise();
            });
          });
        }),
      ),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    const healthResponse = await fetch(`${running.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).ok, true);
  } finally {
    await running.close();
  }
});

test("gateway survives an allowed browser reset while appserver socket resolution is pending", async () => {
  let releaseResolution;
  let markResolutionStarted;
  const resolutionStarted = new Promise((resolvePromise) => {
    markResolutionStarted = resolvePromise;
  });
  const resolutionReleased = new Promise((resolvePromise) => {
    releaseResolution = resolvePromise;
  });
  const running = await fixture("symlink", {
    resolveAppSocket: async (path) => {
      markResolutionStarted();
      await resolutionReleased;
      return resolveAppSocket(path);
    },
  });
  try {
    const request = [
      "GET /v1/ws HTTP/1.1",
      `Host: ${running.gateway.host}:${running.gateway.port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      `Origin: ${ALLOWED_ORIGIN}`,
      "",
      "",
    ].join("\r\n");
    const socket = connectSocket({
      host: running.gateway.host,
      port: running.gateway.port,
    });
    socket.on("error", () => {});
    await new Promise((resolvePromise, reject) => {
      socket.once("connect", resolvePromise);
      socket.once("error", reject);
    });
    await new Promise((resolvePromise, reject) => {
      socket.write(request, (error) => (error ? reject(error) : resolvePromise()));
    });
    await resolutionStarted;
    socket.resetAndDestroy();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    releaseResolution();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const healthResponse = await fetch(`${running.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal((await healthResponse.json()).ok, true);
  } finally {
    releaseResolution();
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
test("profile routes are static, bounded, and reject unsafe units", () => {
  assert.deepEqual(
    normalizeProfileRoutes([
      { id: "fable-swarm", appSocket: "/run/user/1000/omp/fable.sock", serviceUnit: "t4-fable.service" },
    ]),
    [
      {
        id: "fable-swarm",
        appSocket: "/run/user/1000/omp/fable.sock",
        serviceUnit: "t4-fable.service",
        startEnabled: false,
      },
    ],
  );
  for (const route of [
    { id: "../escape", appSocket: "/tmp/socket" },
    { id: "fable/swarm", appSocket: "/tmp/socket" },
    { id: "fable", appSocket: "/tmp/socket", serviceUnit: "systemctl;touch" },
  ]) {
    assert.throws(() => normalizeProfileRoutes([route]), /profile/u);
  }
  assert.throws(
    () =>
      normalizeProfileRoutes(
        Array.from({ length: 65 }, (_, index) => ({
          id: `profile-${index}`,
          appSocket: `/run/user/1000/omp/profile-${index}.sock`,
        })),
      ),
    /profile routes must be an array/u,
  );
});
test("relative profile socket is rejected before resolver or supervisor work", async () => {
  let resolutions = 0;
  let starts = 0;
  await assert.rejects(
    startTailnetGateway({
      webRoot: join(tmpdir(), "missing-web-root"),
      appSocket: join(tmpdir(), "default.sock"),
      allowedOrigin: ALLOWED_ORIGIN,
      listenPort: 0,
      label: "test",
      deploymentIdentity: DEPLOYMENT_IDENTITY,
      profileRoutes: [{ id: "fable", appSocket: "../relative.sock", startEnabled: true, serviceUnit: "t4-fable.service" }],
      resolveAppSocket: async () => {
        resolutions += 1;
        return undefined;
      },
      startSupervisor: async () => {
        starts += 1;
      },
    }),
    /absolute path/u,
  );
  assert.equal(resolutions, 0);
  assert.equal(starts, 0);
});


test("unknown profile route is rejected before socket resolution or supervisor work", async () => {
  let resolutions = 0;
  let starts = 0;
  const missingSocket = join(tmpdir(), "t4-unknown-profile.sock");
  const running = await fixture("symlink", {
    profileRoutes: [{ id: "fable", appSocket: missingSocket, startEnabled: true, serviceUnit: "t4-fable.service" }],
    resolveAppSocket: async (path) => {
      resolutions += 1;
      return resolveAppSocket(path);
    },
    startProfiles: true,
    startSupervisor: async () => {
      starts += 1;
    },
  });
  try {
    const denied = new WebSocket(`${running.url.replace("http", "ws")}/v1/profiles/unknown/ws`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const status = await new Promise((resolvePromise, reject) => {
      denied.once("unexpected-response", (_request, response) => resolvePromise(response.statusCode));
      denied.once("open", () => reject(new Error("unknown route opened")));
      denied.once("error", () => {});
    });
    assert.equal(status, 404);
    assert.equal(resolutions, 0);
    assert.equal(starts, 0);
  } finally {
    await running.close();
  }
});
test("named route bridges through the same opaque upstream auth channel", async () => {
  const running = await fixture("symlink", {
    profileRoutes: [{ id: "fable", appSocket: "$fixture-default-socket" }],
  });
  try {
    const socket = new WebSocket(`${running.url.replace("http", "ws")}/v1/profiles/fable/ws`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    await websocketOpen(socket);
    socket.send("named");
    assert.equal(await websocketMessage(socket), "upstream:named");
    socket.close();
  } finally {
    await running.close();
  }
});

test("profile start is disabled by default and concurrent requests coalesce with cooldown", async () => {
  const missingSocket = join(tmpdir(), `t4-profile-missing-${Date.now()}.sock`);
  let starts = 0;
  let routeReady = false;
  let resolvedPath = "";
  const running = await fixture("symlink", {
    profileRoutes: [{ id: "fable", appSocket: missingSocket, serviceUnit: "t4-fable.service", startEnabled: true }],
    resolveAppSocket: async (path) => {
      if (path === missingSocket) return routeReady ? resolveAppSocket(resolvedPath) : undefined;
      return resolveAppSocket(path);
    },
    startProfiles: true,
    startSupervisor: async () => {
      starts += 1;
    },
    profileStartWaitMs: 30,
    profileStartPollMs: 5,
    profileStartCooldownMs: 1_000,
  });
  resolvedPath = running.resolvedSocketPath;
  try {
    const first = new WebSocket(`${running.url.replace("http", "ws")}/v1/profiles/fable/ws`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    const second = new WebSocket(`${running.url.replace("http", "ws")}/v1/profiles/fable/ws`, {
      headers: { Origin: ALLOWED_ORIGIN },
    });
    await Promise.all(
      [first, second].map(
        (socket) =>
          new Promise((resolvePromise) => {
            socket.once("unexpected-response", (_request, response) => resolvePromise(response.statusCode));
            socket.once("error", () => {});
          }),
      ),
    );
    assert.equal(starts, 1);
    const disabled = await fixture("symlink", {
      profileRoutes: [{ id: "off", appSocket: missingSocket, serviceUnit: "t4-off.service", startEnabled: true }],
      startSupervisor: async () => {
        throw new Error("must not start");
      },
    });
    try {
      const socket = new WebSocket(`${disabled.url.replace("http", "ws")}/v1/profiles/off/ws`, {
        headers: { Origin: ALLOWED_ORIGIN },
      });
      const status = await new Promise((resolvePromise) => {
        socket.once("unexpected-response", (_request, response) => resolvePromise(response.statusCode));
        socket.once("error", () => {});
      });
      assert.equal(status, 503);
    } finally {
      await disabled.close();
    }
  } finally {
    await running.close();
  }
});
test("profile supervisor argv is fixed and shell-free", () => {
  const route = normalizeProfileRoutes([
    { id: "fable", appSocket: "/run/user/1000/omp/fable.sock", serviceUnit: "t4-fable.service" },
  ])[0];
  assert.deepEqual(supervisorCommandForRoute(route), {
    executable: process.platform === "darwin" ? "launchctl" : "systemctl",
    argv:
      process.platform === "darwin"
        ? ["kickstart", `gui/${process.getuid?.() ?? ""}/t4-fable.service`]
        : ["--user", "start", "t4-fable.service"],
  });
  assert.doesNotMatch(supervisorCommandForRoute(route).argv.join(" "), /[;&|$()`]/u);
});
