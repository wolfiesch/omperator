// App-wire 0.3 view-model adapter for user terminals. The drawer never
// parses raw frames and never scrapes terminal text: this module owns the
// typed boundary. Outbound, it builds `terminal.input` / `terminal.resize` /
// `terminal.close` client frames. Inbound, it routes decoded
// `terminal.output` / `terminal.exit` server frames by ownership
// (host + session + device + connection + terminal), deduplicates by cursor
// (epoch + seq), marks reconnect boundaries on epoch change, marks
// transient output gaps without ever dropping an exit, and treats unknown
// or malformed frames as ignorable noise rather than a crash. Legacy
// `terminal` frames are agent-shell evidence for Activity and are refused
// here by construction.
import {
  decodeServerFrame,
  PROTOCOL_VERSION,
  type Cursor,
  type TerminalClientFrame,
  type TerminalCloseFrame,
  type TerminalInputFrame,
  type TerminalResizeFrame,
} from "@t4-code/protocol";
import type { PublicOmpServerEvent } from "@t4-code/client";

import type {
  PtyError,
  PtyExit,
  PtyNotice,
  PtyOpenRequest,
  PtySession,
  UserPtyBridge,
} from "./pty.ts";

/**
 * Who this adapter speaks for. Frames are only accepted for this exact
 * host + session, for terminals this device opened over this connection.
 */
export interface TerminalWireIdentity {
  readonly hostId: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly connectionId: string;
}

/** Wire bounds from app-wire `terminal.resize` dimension guards. */
export const WIRE_MAX_COLS = 1_000;
export const WIRE_MAX_ROWS = 500;

export function buildTerminalInput(
  identity: TerminalWireIdentity,
  terminalId: string,
  data: string,
): TerminalInputFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.input",
    hostId: identity.hostId,
    sessionId: identity.sessionId,
    terminalId,
    data,
  } as TerminalInputFrame;
}

export function buildTerminalResize(
  identity: TerminalWireIdentity,
  terminalId: string,
  cols: number,
  rows: number,
): TerminalResizeFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.resize",
    hostId: identity.hostId,
    sessionId: identity.sessionId,
    terminalId,
    cols: Math.min(Math.max(Math.round(cols), 1), WIRE_MAX_COLS),
    rows: Math.min(Math.max(Math.round(rows), 1), WIRE_MAX_ROWS),
  } as TerminalResizeFrame;
}

export function buildTerminalClose(
  identity: TerminalWireIdentity,
  terminalId: string,
  reason?: string,
): TerminalCloseFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.close",
    hostId: identity.hostId,
    sessionId: identity.sessionId,
    terminalId,
    ...(reason !== undefined && { reason }),
  } as TerminalCloseFrame;
}

export type TerminalIgnoreReason =
  | "malformed"
  | "unrelated"
  | "agent-terminal"
  | "foreign-host"
  | "foreign-session"
  | "unowned-terminal"
  | "duplicate";

export type TerminalWireEvent =
  | {
      readonly kind: "output";
      readonly terminalId: string;
      readonly stream: "stdout" | "stderr";
      readonly data: string;
      /** Cursor epoch changed: the host restarted or the stream resumed. */
      readonly resumed: boolean;
      /** Cursor sequence jumped: transient output was dropped upstream. */
      readonly gap: boolean;
    }
  | {
      readonly kind: "exit";
      readonly terminalId: string;
      readonly exitCode: number;
      readonly signal: string | null;
      readonly resumed: boolean;
      readonly gap: boolean;
    }
  | { readonly kind: "ignored"; readonly reason: TerminalIgnoreReason };

export interface TerminalFrameRouter {
  /** Claim a server terminal id for this device + connection. */
  own(terminalId: string): void;
  release(terminalId: string): void;
  route(frame: unknown): TerminalWireEvent;
  routeEvent(event: PublicOmpServerEvent): TerminalWireEvent;
}

type TerminalEvent = Extract<
  PublicOmpServerEvent,
  { kind: "terminal.output" | "terminal.exit" }
>;

function decodeFrameData(data: string, encoding: "utf8" | "base64" | undefined): string {
  if (encoding !== "base64") return data;
  try {
    const raw = atob(data);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    // The decoder already bounds base64; a late failure yields nothing
    // rather than garbage bytes in the user's scrollback.
    return "";
  }
}

export function createTerminalFrameRouter(identity: TerminalWireIdentity): TerminalFrameRouter {
  const owned = new Set<string>();
  const cursors = new Map<string, Cursor>();

  const routeTerminalEvent = (event: TerminalEvent): TerminalWireEvent => {
    const { payload } = event;
    if (String(payload.hostId) !== identity.hostId) {
      return { kind: "ignored", reason: "foreign-host" };
    }
    if (String(payload.sessionId) !== identity.sessionId) {
      return { kind: "ignored", reason: "foreign-session" };
    }
    const terminalId = String(payload.terminalId);
    if (!owned.has(terminalId)) return { kind: "ignored", reason: "unowned-terminal" };

    const cursor = payload.cursor;
    const last = cursors.get(terminalId);
    let resumed = false;
    let gap = false;
    if (last !== undefined) {
      if (cursor.epoch === last.epoch) {
        if (cursor.seq <= last.seq) return { kind: "ignored", reason: "duplicate" };
        gap = cursor.seq > last.seq + 1;
      } else {
        resumed = true;
      }
    }
    cursors.set(terminalId, { epoch: cursor.epoch, seq: cursor.seq });

    if (event.kind === "terminal.exit") {
      return {
        kind: "exit",
        terminalId,
        exitCode: event.payload.exitCode,
        signal: event.payload.signal ?? null,
        resumed,
        gap,
      };
    }
    return {
      kind: "output",
      terminalId,
      stream: event.payload.stream,
      data: decodeFrameData(event.payload.data, event.payload.encoding),
      resumed,
      gap,
    };
  };

  return {
    own(terminalId) {
      owned.add(terminalId);
    },
    release(terminalId) {
      owned.delete(terminalId);
      cursors.delete(terminalId);
    },
    route(frame) {
      let decoded;
      try {
        decoded = decodeServerFrame(frame);
      } catch {
        return { kind: "ignored", reason: "malformed" };
      }
      if (decoded.type === "terminal") {
        // Legacy agent-shell evidence stream — read-only Activity content.
        return { kind: "ignored", reason: "agent-terminal" };
      }
      if (decoded.type !== "terminal.output" && decoded.type !== "terminal.exit") {
        return { kind: "ignored", reason: "unrelated" };
      }
      return decoded.type === "terminal.exit"
        ? routeTerminalEvent({ kind: "terminal.exit", payload: decoded })
        : routeTerminalEvent({ kind: "terminal.output", payload: decoded });
    },
    routeEvent(event) {
      if (event.kind === "terminal") {
        return { kind: "ignored", reason: "agent-terminal" };
      }
      if (event.kind !== "terminal.output" && event.kind !== "terminal.exit") {
        return { kind: "ignored", reason: "unrelated" };
      }
      return routeTerminalEvent(event);
    },
  };
}

/** `term.open` request the transport forwards as a typed command. */
export interface WireTerminalOpenRequest {
  readonly sessionId: string;
  readonly shell: string;
  readonly cwd: string | null;
  readonly cols: number;
  readonly rows: number;
}

export interface WireTerminalOpenResult {
  /** Server-assigned terminal id — the ownership key for routed frames. */
  readonly terminalId: string;
}

/**
 * What the desktop shell provides: a typed frame pipe bound to one
 * host + session + device + connection. `sendFrame` returns false when the
 * transport is saturated; `onDrain` fires when it can accept input again.
 */
export interface TerminalWireTransport {
  readonly identity: TerminalWireIdentity;
  openTerminal(request: WireTerminalOpenRequest): Promise<WireTerminalOpenResult>;
  sendFrame(frame: TerminalClientFrame): boolean;
  onFrame(listener: (frame: unknown) => void): () => void;
  onDrain(listener: () => void): () => void;
}

interface WireListeners {
  readonly data: Set<(chunk: string) => void>;
  readonly exit: Set<(exit: PtyExit) => void>;
  readonly drain: Set<() => void>;
  readonly error: Set<(error: PtyError) => void>;
  readonly notice: Set<(notice: PtyNotice) => void>;
}

interface WireSessionHooks {
  readonly settled: (session: WirePtySession) => void;
  readonly closed: (serverTerminalId: string) => void;
}

class WirePtySession implements PtySession {
  readonly terminalId: string;
  serverTerminalId: string | null = null;
  private phase: "opening" | "open" | "closed" = "opening";
  private pendingResize: { cols: number; rows: number } | null = null;
  private readonly transport: TerminalWireTransport;
  private readonly router: TerminalFrameRouter;
  private readonly hooks: WireSessionHooks;
  private readonly listeners: WireListeners = {
    data: new Set(),
    exit: new Set(),
    drain: new Set(),
    error: new Set(),
    notice: new Set(),
  };

  constructor(
    localTerminalId: string,
    transport: TerminalWireTransport,
    router: TerminalFrameRouter,
    hooks: WireSessionHooks,
    request: WireTerminalOpenRequest,
  ) {
    this.terminalId = localTerminalId;
    this.transport = transport;
    this.router = router;
    this.hooks = hooks;
    transport.openTerminal(request).then(
      (result) => {
        if (this.phase === "closed") {
          // Killed while opening: close the server PTY we no longer want.
          transport.sendFrame(
            buildTerminalClose(transport.identity, result.terminalId, "closed before ready"),
          );
          return;
        }
        this.serverTerminalId = result.terminalId;
        this.phase = "open";
        this.router.own(result.terminalId);
        this.hooks.settled(this);
        if (this.pendingResize !== null) {
          const { cols, rows } = this.pendingResize;
          this.pendingResize = null;
          transport.sendFrame(buildTerminalResize(transport.identity, result.terminalId, cols, rows));
        }
        // Input queued during open flushes through the store's drain path.
        this.emitDrain();
      },
      (error: unknown) => {
        if (this.phase === "closed") return;
        this.phase = "closed";
        const message = error instanceof Error ? error.message : "The host refused the shell.";
        const kind: PtyError["kind"] = /permission|denied|capabilit|forbidden/i.test(message)
          ? "permission-denied"
          : "shell-error";
        for (const listener of this.listeners.error) {
          listener({
            kind,
            message:
              kind === "permission-denied"
                ? "The host didn't allow this shell."
                : "The shell couldn't be started.",
          });
        }
      },
    );
  }

  write(data: string): boolean {
    if (this.phase === "closed") return true;
    if (this.phase === "opening" || this.serverTerminalId === null) return false;
    return this.transport.sendFrame(
      buildTerminalInput(this.transport.identity, this.serverTerminalId, data),
    );
  }

  resize(cols: number, rows: number): void {
    if (this.phase === "closed") return;
    if (this.phase === "opening" || this.serverTerminalId === null) {
      this.pendingResize = { cols, rows };
      return;
    }
    this.transport.sendFrame(
      buildTerminalResize(this.transport.identity, this.serverTerminalId, cols, rows),
    );
  }

  kill(): void {
    if (this.phase === "closed") return;
    const serverId = this.phase === "open" ? this.serverTerminalId : null;
    this.phase = "closed";
    if (serverId !== null) {
      this.transport.sendFrame(
        buildTerminalClose(this.transport.identity, serverId, "closed by user"),
      );
      this.router.release(serverId);
      this.hooks.closed(serverId);
    }
  }

  onData(listener: (chunk: string) => void): () => void {
    this.listeners.data.add(listener);
    return () => this.listeners.data.delete(listener);
  }

  onExit(listener: (exit: PtyExit) => void): () => void {
    this.listeners.exit.add(listener);
    return () => this.listeners.exit.delete(listener);
  }

  onDrain(listener: () => void): () => void {
    this.listeners.drain.add(listener);
    return () => this.listeners.drain.delete(listener);
  }

  onError(listener: (error: PtyError) => void): () => void {
    this.listeners.error.add(listener);
    return () => this.listeners.error.delete(listener);
  }

  onNotice(listener: (notice: PtyNotice) => void): () => void {
    this.listeners.notice.add(listener);
    return () => this.listeners.notice.delete(listener);
  }

  emitDrain(): void {
    for (const listener of this.listeners.drain) listener();
  }

  emitNotice(notice: PtyNotice): void {
    for (const listener of this.listeners.notice) listener(notice);
  }

  emitData(chunk: string): void {
    for (const listener of this.listeners.data) listener(chunk);
  }

  emitExit(exit: PtyExit): void {
    this.phase = "closed";
    for (const listener of this.listeners.exit) listener(exit);
  }
}

export interface WirePtyBridge extends UserPtyBridge {
  /** Detach transport listeners; live sessions become inert. */
  dispose(): void;
}

/**
 * A `UserPtyBridge` over a typed app-wire transport. One bridge per
 * host + session + device + connection; frames that do not match that
 * ownership tuple never reach a viewport.
 */
export function createWirePtyBridge(transport: TerminalWireTransport): WirePtyBridge {
  const router = createTerminalFrameRouter(transport.identity);
  const sessions = new Map<string, WirePtySession>();

  const offFrame = transport.onFrame((frame) => {
    const event = router.route(frame);
    if (event.kind === "ignored") return;
    const session = sessions.get(event.terminalId);
    if (session === undefined) return;
    if (event.resumed) session.emitNotice("resumed");
    if (event.gap) session.emitNotice("output-skipped");
    if (event.kind === "output") {
      session.emitData(event.data);
      return;
    }
    // Exit is never dropped: gaps and backpressure only affect transient
    // output, the result of the shell always lands.
    sessions.delete(event.terminalId);
    router.release(event.terminalId);
    session.emitExit({ code: event.exitCode, signal: event.signal });
  });
  const offDrain = transport.onDrain(() => {
    for (const session of sessions.values()) session.emitDrain();
  });

  return {
    kind: "desktop",
    open(request: PtyOpenRequest): PtySession {
      const session: WirePtySession = new WirePtySession(
        request.terminalId,
        transport,
        router,
        {
          settled: (settled) => {
            if (settled.serverTerminalId !== null) sessions.set(settled.serverTerminalId, settled);
          },
          closed: (serverTerminalId) => {
            sessions.delete(serverTerminalId);
          },
        },
        {
          sessionId: transport.identity.sessionId,
          shell: request.shell,
          cwd: request.cwd,
          cols: request.cols,
          rows: request.rows,
        },
      );
      return session;
    },
    dispose() {
      offFrame();
      offDrain();
      sessions.clear();
    },
  };
}
