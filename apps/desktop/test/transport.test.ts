import { createServer as createHttpServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { once } from "node:events";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { localTransportSocketPath, resolveUnixSocketPath, UnixWebSocketTransport } from "../src/transport.ts";

const describeUnix = process.platform === "linux" || process.platform === "darwin" ? describe : (_name: string, _fn: () => void): void => {};
const UUID = "123e4567-e89b-12d3-a456-426614174000";

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "t4-transport-"));
  chmodSync(directory, 0o700);
  return directory;
}

async function listenUnix(server: Server, path: string): Promise<void> {
  server.listen(path);
  await once(server, "listening");
  chmodSync(path, 0o600);
}

async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

describeUnix("Unix socket ownership and resolution", () => {
  it("accepts a direct socket and returns the same path", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "direct.sock");
    const server = createNetServer();
    try {
      await listenUnix(server, socketPath);
      expect(resolveUnixSocketPath(socketPath)).toBe(socketPath);
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts an OMP public link and returns the public path after validating its backing socket", async () => {
    const directory = fixtureDirectory();
    const backingName = `.appserver-${UUID}.sock`;
    const backingPath = join(directory, backingName);
    const publicPath = join(directory, "appserver.sock");
    const server = createNetServer();
    try {
      await listenUnix(server, backingPath);
      symlinkSync(backingName, publicPath);
      expect(resolveUnixSocketPath(publicPath)).toBe(publicPath);
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("opens a WebSocket through an OMP public link", async () => {
    const directory = fixtureDirectory();
    const backingName = `.appserver-${UUID}.sock`;
    const backingPath = join(directory, backingName);
    const publicPath = join(directory, "appserver.sock");
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServer.on("connection", (socket) => socket.close());
    const transport = new UnixWebSocketTransport({ socketPath: publicPath });
    try {
      httpServer.listen(backingPath);
      await once(httpServer, "listening");
      chmodSync(backingPath, 0o600);
      symlinkSync(backingName, publicPath);
      await transport.open();
    } finally {
      transport.close();
      await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a local WebSocket handshake that never answers", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "stalled.sock");
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const transport = new UnixWebSocketTransport({
      socketPath,
      validatePath: false,
      handshakeTimeoutMs: 25,
    });
    try {
      await listenUnix(server, socketPath);
      await expect(transport.open()).rejects.toThrow("handshake timed out");
    } finally {
      transport.close();
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports the errno code for an unreachable socket without leaking its path", async () => {
    const directory = fixtureDirectory();
    const socketPath = join(directory, "absent.sock");
    const transport = new UnixWebSocketTransport({
      socketPath,
      validatePath: false,
      handshakeTimeoutMs: 2_000,
    });
    const messages: string[] = [];
    transport.onError((error) => {
      if (error instanceof Error) messages.push(error.message);
    });
    try {
      // Nothing is listening, so `ws` fails the upgrade with an errno error.
      // Assert on the rejection, not just the listener: on the first connection
      // the client awaits open() inside the transport factory and attaches its
      // error listener only afterwards, so the rejection is the only channel
      // that reports an unreachable socket in production.
      await expect(transport.open()).rejects.toThrow("local transport error (ENOENT)");
      expect(messages).toContain("local transport error (ENOENT)");
      for (const message of messages) expect(message).not.toContain(directory);
    } finally {
      transport.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects absolute, traversal, malformed, and symlink-to-symlink targets", async () => {
    const directory = fixtureDirectory();
    const publicPath = join(directory, "appserver.sock");
    const cases = [
      "/tmp/other.sock",
      "../other.sock",
      ".appserver-not-a-uuid.sock",
      `.appserver-${UUID}.sock/../other.sock`,
    ];
    try {
      for (const target of cases) {
        symlinkSync(target, publicPath);
        expect(() => resolveUnixSocketPath(publicPath)).toThrow();
        unlinkSync(publicPath);
      }

      const actualPath = join(directory, "actual.sock");
      const backingPath = join(directory, `.appserver-${UUID}.sock`);
      writeFileSync(actualPath, "not a socket", { mode: 0o600 });
      symlinkSync(actualPath, backingPath);
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects non-sockets and group/world-writable parents or sockets", async () => {
    const directory = fixtureDirectory();
    const publicPath = join(directory, "appserver.sock");
    const backingPath = join(directory, `.appserver-${UUID}.sock`);
    try {
      writeFileSync(backingPath, "not a socket", { mode: 0o600 });
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
      unlinkSync(publicPath);
      rmSync(backingPath, { force: true });

      const server = createNetServer();
      await listenUnix(server, backingPath);
      chmodSync(backingPath, 0o620);
      symlinkSync(`.appserver-${UUID}.sock`, publicPath);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
      unlinkSync(publicPath);
      chmodSync(backingPath, 0o600);
      chmodSync(directory, 0o770);
      expect(() => resolveUnixSocketPath(backingPath)).toThrow();
      await closeServer(server);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a public symlink whose parent path contains a symlink", async () => {
    const directory = fixtureDirectory();
    const linkedDirectory = join(directory, "linked");
    const publicPath = join(linkedDirectory, "appserver.sock");
    const backingPath = join(directory, `.appserver-${UUID}.sock`);
    const server = createNetServer();
    try {
      await listenUnix(server, backingPath);
      symlinkSync(directory, linkedDirectory);
      expect(() => resolveUnixSocketPath(publicPath)).toThrow();
    } finally {
      await closeServer(server);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("localTransportSocketPath", () => {
  const SANDBOX = { T4_DEV_SANDBOX: "fixture", T4_DEV_SANDBOX_ROOT: "/private/tmp/t4-sandbox-fixture" };

  // macOS derives the socket from HOME and Linux from XDG_RUNTIME_DIR, so both
  // have to be checked: a fix that threads only one still points the other
  // platform at the developer's own host.
  for (const platform of ["darwin", "linux"] as const) {
    it(`resolves inside the sandbox instead of the developer's own host on ${platform}`, () => {
      const sandboxed = localTransportSocketPath("default", SANDBOX, platform);
      const personal = localTransportSocketPath("default", {}, platform);
      expect(sandboxed.startsWith(`${SANDBOX.T4_DEV_SANDBOX_ROOT}/`)).toBe(true);
      expect(sandboxed).not.toBe(personal);
      expect(sandboxed.startsWith(`${homedir()}/`)).toBe(false);
    });

    it(`keeps every sandbox profile inside that sandbox on ${platform}`, () => {
      const review = localTransportSocketPath("review", SANDBOX, platform);
      expect(review.startsWith(`${SANDBOX.T4_DEV_SANDBOX_ROOT}/`)).toBe(true);
      expect(review).not.toBe(localTransportSocketPath("default", SANDBOX, platform));
    });
  }

  it("ignores the developer's own runtime directory inside a sandbox on linux", () => {
    // XDG_RUNTIME_DIR is inherited by the desktop process, so an unthreaded
    // sandbox would resolve the personal runtime socket on Linux.
    const path = localTransportSocketPath(
      "default",
      { ...SANDBOX, XDG_RUNTIME_DIR: "/run/user/1000" },
      "linux",
    );
    expect(path.startsWith(`${SANDBOX.T4_DEV_SANDBOX_ROOT}/`)).toBe(true);
    expect(path.startsWith("/run/user/1000")).toBe(false);
  });

  it("fails closed on a half-configured sandbox", () => {
    // Falling back to the personal socket here is the dangerous outcome, so an
    // incomplete sandbox must refuse to resolve at all.
    for (const partial of [
      { T4_DEV_SANDBOX_ROOT: SANDBOX.T4_DEV_SANDBOX_ROOT },
      { T4_DEV_SANDBOX: "fixture" },
      { T4_DEV_SANDBOX: "fixture", T4_DEV_SANDBOX_ROOT: "relative/path" },
      { T4_DEV_SANDBOX: "Bad Name", T4_DEV_SANDBOX_ROOT: SANDBOX.T4_DEV_SANDBOX_ROOT },
    ]) {
      expect(() => localTransportSocketPath("default", partial)).toThrow(
        "invalid development sandbox configuration",
      );
    }
  });

  it("uses the personal socket when no sandbox is configured", () => {
    expect(localTransportSocketPath("default", {}, "darwin").startsWith(`${homedir()}/`)).toBe(true);
    expect(localTransportSocketPath("default", { XDG_RUNTIME_DIR: "/run/user/1000" }, "linux")).toBe(
      "/run/user/1000/omp/appserver.sock",
    );
  });
});
