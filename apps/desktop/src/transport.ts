import { chmodSync, lstatSync, mkdirSync, readlinkSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { dirname, join, parse } from "node:path";
import WebSocket from "ws";
import type { OmpTransport } from "@t4-code/client";
import { localSocketPath } from "./socket-path.ts";

const OMP_SOCKET_NAME = /^\.appserver-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.sock$/;

function secureStat(path: string, kind: "directory" | "socket"): void {
  const stat = lstatSync(path);
  if (kind === "directory" && !stat.isDirectory()) throw new Error("runtime parent is not a directory");
  if (kind === "socket" && !stat.isSocket()) throw new Error("appserver path is not a Unix socket");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("appserver path is not owned by this user");
  if ((stat.mode & 0o022) !== 0) throw new Error("appserver path is writable by group or other users");
  if (kind === "socket" && (stat.mode & 0o777) !== 0o600) throw new Error("appserver socket must have mode 0600");
}

function rejectSymlinkedParent(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw new Error("socket path contains a symlinked directory");
  }
}

function secureParent(path: string): string {
  const parent = dirname(path);
  rejectSymlinkedParent(parent);
  secureStat(parent, "directory");
  return parent;
}

export function resolveUnixSocketPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\0")) throw new Error("socket path must be absolute");
  const parent = secureParent(path);
  const publicStat = lstatSync(path);

  if (!publicStat.isSymbolicLink()) {
    secureStat(path, "socket");
    return path;
  }

  if (typeof process.getuid === "function" && publicStat.uid !== process.getuid()) {
    throw new Error("appserver symlink is not owned by this user");
  }
  const target = readlinkSync(path);
  if (!OMP_SOCKET_NAME.test(target) || target.includes("/") || target.includes("\\")) {
    throw new Error("appserver symlink target is not an OMP socket basename");
  }
  const backingPath = join(parent, target);
  secureStat(backingPath, "socket");
  return backingPath;
}

export function validateUnixSocketPath(path: string): void {
  resolveUnixSocketPath(path);
}

export function ensureMacRuntimeDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  secureStat(path, "directory");
}

export interface UnixWebSocketTransportOptions {
  readonly socketPath: string;
  readonly validatePath?: boolean;
  readonly handshakeTimeoutMs?: number;
}

export class UnixWebSocketTransport implements OmpTransport {
  private readonly socketPath: string;
  private readonly shouldValidate: boolean;
  private readonly handshakeTimeoutMs: number;
  private socket: WebSocket | undefined;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private closed = false;
  private openReject: (() => void) | undefined;
  private openTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: UnixWebSocketTransportOptions) {
    if (!options.socketPath.startsWith("/")) throw new Error("Unix socket path must be absolute");
    if (
      options.handshakeTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.handshakeTimeoutMs) || options.handshakeTimeoutMs <= 0)
    ) {
      throw new Error("handshake timeout must be a positive safe integer");
    }
    this.socketPath = options.socketPath;
    this.shouldValidate = options.validatePath ?? true;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  }

  open(): Promise<void> {
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.socket !== undefined || this.closed) return Promise.reject(new Error("local transport is closed"));
    const socketPath = this.shouldValidate ? resolveUnixSocketPath(this.socketPath) : this.socketPath;
    const socket = new WebSocket("ws://omp.local/ws", {
      perMessageDeflate: false,
      maxPayload: 1_048_576,
      handshakeTimeout: this.handshakeTimeoutMs + 100,
      createConnection: () => netConnect({ path: socketPath }),
    });
    this.socket = socket;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    const clearOpenTimer = (): void => {
      if (this.openTimer === undefined) return;
      clearTimeout(this.openTimer);
      this.openTimer = undefined;
    };
    const fail = (message = "local transport unavailable"): void => {
      if (settled) return;
      settled = true;
      clearOpenTimer();
      this.openReject = undefined;
      reject(new Error(message));
    };
    this.openReject = () => fail("local transport closed");
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      clearOpenTimer();
      this.openReject = undefined;
      resolve();
    };
    this.openTimer = setTimeout(() => {
      fail("local websocket handshake timed out");
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    }, this.handshakeTimeoutMs);
    socket.on("open", succeed);
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      for (const listener of this.messages) listener(typeof data === "string" ? data : data.toString());
    });
    socket.on("close", (code, reason) => {
      this.socket = undefined;
      fail();
      const text = reason.toString("utf8").slice(0, 256);
      for (const listener of this.closes) listener(code, text);
    });
    socket.on("error", (error) => {
      fail();
      for (const listener of this.errors) listener(error instanceof Error ? new Error("local transport error") : new Error("local transport error"));
    });
    return promise;
  }

  send(data: string): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) throw new Error("local transport is not connected");
    socket.send(data);
  }

  close(): void {
    this.closed = true;
    this.openReject?.();
    this.openReject = undefined;
    if (this.openTimer !== undefined) clearTimeout(this.openTimer);
    this.openTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      socket.close(1000, "client closed");
      socket.terminate();
    }
    this.messages.clear();
    this.closes.clear();
    this.errors.clear();
  }

  onMessage(listener: (data: string | Uint8Array) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: (code?: number, reason?: string) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  onError(listener: (error: unknown) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }
}

export function createLocalTransport(): UnixWebSocketTransport {
  const socketPath = localSocketPath();
  if (process.platform === "darwin") ensureMacRuntimeDirectory(dirname(socketPath));
  return new UnixWebSocketTransport({ socketPath });
}
