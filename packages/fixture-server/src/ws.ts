import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { MAX_INPUT_BYTES, decodeClientFrame } from "@t4-code/protocol";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { FixtureEngine, VirtualScheduler } from "./engine.ts";
import { loadScenario, type ScenarioId, type ScenarioSeed } from "./seeds.ts";

const DEFAULT_PATH = "/fixture";
const MAX_BUFFERED_BYTES = 1_048_576;
type ClientCountWaiter = {
  resolve: () => void;
  reject: (reason?: unknown) => void;
};
export interface FixtureWebSocketOptions {
  scenario?: ScenarioId | ScenarioSeed;
  path?: string;
  scheduler?: VirtualScheduler;
  port?: number;
  /**
   * Advance the virtual scheduler with wall-clock time (50ms ticks). Off by
   * default so tests keep deterministic manual advanceBy() control; the
   * standalone host runner opts in so streamed scenarios play live.
   */
  realTime?: boolean;
}
export class FixtureWebSocketServer {
  readonly engine: FixtureEngine;
  readonly path: string;
  readonly maxPayload = MAX_INPUT_BYTES;
  private readonly webSocketServer: WebSocketServer;
  private readonly httpServer: HttpServer;
  private readonly sockets = new Set<WebSocket>();
  private readonly socketClients = new Map<WebSocket, string>();
  private readonly closingSockets = new Set<WebSocket>();
  private readonly requestedPort: number;
  private readonly realTime: boolean;
  private realTimeTimer: NodeJS.Timeout | undefined;
  private running = false;
  private nextClient = 1;
  private boundPort = 0;
  private readonly clientCountWaiters = new Map<number, Set<ClientCountWaiter>>();
  constructor(options: FixtureWebSocketOptions = {}) {
    const seed =
      typeof options.scenario === "object"
        ? options.scenario
        : loadScenario(options.scenario ?? "basic-v1");
    this.engine = new FixtureEngine(seed, options.scheduler);
    this.path = options.path ?? DEFAULT_PATH;
    if (!/^\/[A-Za-z0-9/_-]+$/u.test(this.path))
      throw new Error("fixture websocket path must be an absolute simple path");
    this.requestedPort = options.port ?? 0;
    this.realTime = options.realTime ?? false;
    if (
      !Number.isInteger(this.requestedPort) ||
      this.requestedPort < 0 ||
      this.requestedPort > 65535
    )
      throw new RangeError("fixture websocket port must be an integer in 0..65535");
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_INPUT_BYTES,
      perMessageDeflate: false,
    });
    this.httpServer = createServer((_request, response) => {
      response.writeHead(404);
      response.end();
    });
    this.httpServer.on("upgrade", (request, socket, head) => this.onUpgrade(request, socket, head));
    this.webSocketServer.on("connection", (socket) => this.onConnection(socket));
  }
  get port(): number {
    return this.boundPort;
  }
  get address(): string {
    return `ws://127.0.0.1:${this.boundPort}${this.path}`;
  }
  get clientCount(): number {
    return this.engine.clientCount;
  }
  /** Total WebSocket connections accepted since this fixture started. */
  get connectionCount(): number {
    return this.nextClient - 1;
  }
  /** Simulate an unclean network loss without stopping the fixture server. */
  dropConnections(): void {
    for (const socket of this.sockets) socket.terminate();
  }
  waitForClientCount(expected = 0): Promise<void> {
    if (!Number.isSafeInteger(expected) || expected < 0)
      return Promise.reject(new RangeError("expected client count must be a non-negative integer"));
    if (this.clientCount === expected) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let waiters = this.clientCountWaiters.get(expected);
    if (waiters === undefined) {
      waiters = new Set<ClientCountWaiter>();
      this.clientCountWaiters.set(expected, waiters);
    }
    waiters.add({ resolve, reject });
    return promise;
  }
  async start(): Promise<string> {
    if (this.running) return this.address;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off("error", onError);
        const address = this.httpServer.address() as AddressInfo;
        this.boundPort = address.port;
        this.running = true;
        if (this.realTime) {
          this.realTimeTimer = setInterval(() => this.advanceBy(50), 50);
          this.realTimeTimer.unref();
        }
        resolve();
      };
      this.httpServer.once("error", onError);
      this.httpServer.once("listening", onListening);
      this.httpServer.listen(this.requestedPort, "127.0.0.1");
    });
    return this.address;
  }
  async stop(): Promise<void> {
    if (this.realTimeTimer !== undefined) {
      clearInterval(this.realTimeTimer);
      this.realTimeTimer = undefined;
    }
    const sockets = [...this.sockets];
    for (const socket of sockets) this.closeSocket(socket, 1000, "fixture stopped");
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            const done = () => {
              socket.off("close", done);
              resolve();
            };
            socket.once("close", done);
            setImmediate(() => {
              if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
            });
          }),
      ),
    );
    await new Promise<void>((resolve) => {
      try {
        this.webSocketServer.close(() => resolve());
      } catch {
        resolve();
      }
    });
    if (this.running) await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    for (const clientId of this.socketClients.values()) this.engine.disconnect(clientId);
    this.sockets.clear();
    this.socketClients.clear();
    this.engine.close();
    this.settleClientCountWaiters();
    this.rejectClientCountWaiters(new Error("fixture stopped before reaching expected client count"));
    this.running = false;
    this.boundPort = 0;
  }
  advanceBy(ms: number): void {
    this.engine.advanceBy(ms);
    this.flushAll();
  }
  advanceTo(ms: number): void {
    this.engine.advanceTo(ms);
    this.flushAll();
  }
  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const host = request.headers.host;
    const expectedHost = `127.0.0.1:${this.boundPort}`;
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", `http://${expectedHost}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== this.path || host !== expectedHost) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (client) =>
      this.webSocketServer.emit("connection", client, request),
    );
  }
  private onConnection(socket: WebSocket): void {
    const clientId = `ws-client-${this.nextClient++}`;
    this.sockets.add(socket);
    this.socketClients.set(socket, clientId);
    this.engine.connect(clientId);
    this.settleClientCountWaiters();
    socket.on("message", (data, isBinary) => {
      const bytes = Buffer.isBuffer(data)
        ? data.byteLength
        : Array.isArray(data)
          ? data.reduce((total, part) => total + part.byteLength, 0)
          : data instanceof ArrayBuffer
            ? data.byteLength
            : Buffer.byteLength(String(data));
      if (isBinary || bytes > MAX_INPUT_BYTES) {
        this.closeSocket(socket, 1009, "payload too large");
        return;
      }
      try {
        if (process.env.FIXTURE_LOG_FRAMES === "1") {
          const parsed = JSON.parse(String(data)) as { type?: string; command?: string };
          console.log(`[fixture] recv ${parsed.type ?? "?"}${parsed.command ? ` ${parsed.command}` : ""}`);
        }
        const frames = this.engine.receive(clientId, data as string | Uint8Array);
        this.sendFrames(socket, frames);
        this.flushAll();
      } catch (error) {
        try {
          decodeClientFrame(data as string | Uint8Array);
        } catch {
          this.closeSocket(
            socket,
            1002,
            error instanceof Error ? error.message : "invalid payload",
          );
        }
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.closingSockets.delete(socket);
      this.releaseClient(socket);
    });
    socket.on("error", (error) => {
      const message = error instanceof Error ? error.message : "socket error";
      const code = message.includes("Max payload") ? 1009 : 1011;
      this.closeSocket(socket, code, message);
    });
  }
  private sendFrames(socket: WebSocket, frames: readonly unknown[]): void {
    for (const frame of frames) {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (
        socket.bufferedAmount + Buffer.byteLength(JSON.stringify(frame), "utf8") >
        MAX_BUFFERED_BYTES
      ) {
        this.closeSocket(socket, 1013, "backpressure");
        return;
      }
      socket.send(JSON.stringify(frame));
    }
  }
  private flushAll(): void {
    for (const socket of this.sockets) {
      const clientId = this.socketClients.get(socket);
      if (clientId !== undefined) this.sendFrames(socket, this.engine.drain(clientId));
    }
  }
  private releaseClient(socket: WebSocket): void {
    const clientId = this.socketClients.get(socket);
    if (clientId === undefined) return;
    this.socketClients.delete(socket);
    this.engine.disconnect(clientId);
    this.settleClientCountWaiters();
  }
  private settleClientCountWaiters(): void {
    for (const [expected, waiters] of this.clientCountWaiters) {
      if (this.clientCount !== expected) continue;
      this.clientCountWaiters.delete(expected);
      for (const waiter of waiters) waiter.resolve();
    }
  }
  private rejectClientCountWaiters(reason: Error): void {
    for (const waiters of this.clientCountWaiters.values()) {
      for (const waiter of waiters) waiter.reject(reason);
    }
    this.clientCountWaiters.clear();
  }
  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    if (this.closingSockets.has(socket)) return;
    this.closingSockets.add(socket);
    const clientId = this.socketClients.get(socket);
    if (socket.readyState === WebSocket.OPEN) {
      if (clientId !== undefined)
        this.sendFrames(socket, this.engine.closeClient(clientId, "fixture_shutdown", reason));
      this.releaseClient(socket);
      socket.close(code, reason);
    } else if (socket.readyState === WebSocket.CONNECTING) {
      this.releaseClient(socket);
      socket.terminate();
    } else {
      this.releaseClient(socket);
    }
  }
}
export function createFixtureWebSocketServer(
  options: FixtureWebSocketOptions = {},
): FixtureWebSocketServer {
  return new FixtureWebSocketServer(options);
}
