// Live user-PTY bridge over the DesktopRuntimeController. This is the
// desktop counterpart of the fixture bridge in pty.ts: `open` goes out as a
// session-scoped `term.open` command through the controller-lease path,
// the server's typed result is correlated by requestId in the session
// projection (never scraped from terminal text), and `terminal.output` /
// `terminal.exit` frames drive bytes and status through the same
// cursor-deduplicating router the wire adapter uses. Input, resize, and
// close leave as the controller's typed terminal requests. A dropped
// connection never re-opens a shell or replays input — sessions mark
// themselves unusable and the user reopens explicitly.
import {
  DesktopRuntimeError,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
  type PublicOmpServerEvent,
  type ResultProjection,
} from "@t4-code/client";
import {
  hostId as brandHostId,
  revision as brandRevision,
  sessionId as brandSessionId,
  type HostId,
  type Revision,
  type SessionId,
  type TerminalId,
} from "@t4-code/protocol";

import type { LiveSessionAddress } from "../../platform/live-workspace.ts";
import type {
  PtyError,
  PtyExit,
  PtyNotice,
  PtyOpenRequest,
  PtySession,
} from "./pty.ts";
import {
  TERM_OPEN_COMMAND,
  MESSAGES,
  clampCols,
  clampRows,
  errorFromResult,
  isRelativeCwd,
  parseTerminalIdFrom,
  resolveLiveTerminalAvailability,
  sessionControlGateReason,
  shellFieldAdvertised,
  termOpenCatalogItem,
  type LiveTerminalAvailability,
  type LivePtyBridgeOptions,
  type LivePtyBridge,
  type OpenCorrelation,
} from "./live-pty-policy.ts";
export {
  type LiveTerminalAvailability,
  resolveLiveTerminalAvailability,
} from "./live-pty-policy.ts";
export { type LivePtyBridgeOptions, type LivePtyBridge, type OpenCorrelation } from "./live-pty-policy.ts";
import { sessionWriteLink } from "../session-runtime/session-inventory.ts";
import { WriteGateError } from "../session-runtime/session-observer.ts";
import {
  createTerminalFrameRouter,
  type TerminalWireIdentity,
} from "./wire.ts";

interface LiveListeners {
  readonly data: Set<(chunk: string) => void>;
  readonly exit: Set<(exit: PtyExit) => void>;
  readonly drain: Set<() => void>;
  readonly error: Set<(error: PtyError) => void>;
  readonly notice: Set<(notice: PtyNotice) => void>;
}

interface LiveBridgeContext {
  readonly controller: DesktopRuntimeController;
  readonly snapshot: () => DesktopRuntimeSnapshot;
  readonly address: LiveSessionAddress;
  readonly wireHostId: HostId;
  readonly wireSessionId: SessionId;
  readonly openTimeoutMs: number;
  readonly maxPendingInputChars: number;
  availabilityNow(): LiveTerminalAvailability;
  shellAdvertisedNow(): boolean;
  beginOpen(): void;
  /** Ends the open window; settles ownership when a terminal id landed. */
  endOpen(session: LivePtySession, serverTerminalId: TerminalId | null): void;
  forget(session: LivePtySession): void;
}

class LivePtySession implements PtySession {
  readonly terminalId: string;
  serverTerminalId: TerminalId | null = null;
  private phase: "opening" | "open" | "closed" = "opening";
  private cancelled = false;
  private closeSent = false;
  private pendingResize: { cols: number; rows: number } | null = null;
  private resizeInFlight = false;
  private pendingInputChars = 0;
  private async ensureLease(): Promise<boolean> {
    try {
      const revision = this.resolveRevision();
      if (revision === null) return false;
      const host = this.context.address.hostId;
      const session = this.context.address.sessionId;
      const target = this.context.address.targetId;
      if (this.context.controller.controllerLeaseFor(target, host, session, String(revision)) !== undefined) return true;
      const acquired = await this.context.controller.acquireControllerLease(target, host, session, String(revision));
      return !acquired.required || acquired.leaseId !== undefined;
    } catch {
      return false;
    }
  }
  private saturationSignalled = false;
  private inputChain: Promise<void> = Promise.resolve();
  private abandonWait: (() => void) | null = null;
  private readonly context: LiveBridgeContext;
  private readonly listeners: LiveListeners = {
    data: new Set(),
    exit: new Set(),
    drain: new Set(),
    error: new Set(),
    notice: new Set(),
  };

  constructor(context: LiveBridgeContext, request: PtyOpenRequest) {
    this.context = context;
    this.terminalId = request.terminalId;
    void this.openNow(request);
  }

  private sessionScope(): {
    readonly targetId: string;
    readonly hostId: HostId;
    readonly sessionId: SessionId;
  } {
    return {
      targetId: this.context.address.targetId,
      hostId: this.context.wireHostId,
      sessionId: this.context.wireSessionId,
    };
  }

  private projectionKey(): string {
    return `${this.context.address.hostId}\u0000${this.context.address.sessionId}`;
  }

  private resolveRevision(): Revision | null {
    const snapshot = this.context.snapshot();
    const warm = snapshot.projection.sessions.get(this.projectionKey());
    if (warm?.revision !== undefined) return brandRevision(warm.revision);
    return snapshot.projection.sessionIndex.get(this.projectionKey())?.revision ?? null;
  }

  private findResult(
    snapshot: DesktopRuntimeSnapshot,
    requestId: string,
  ): ResultProjection | undefined {
    return snapshot.projection.sessions.get(this.projectionKey())?.results.get(requestId);
  }

  private connected(snapshot: DesktopRuntimeSnapshot): boolean {
    return snapshot.connections.get(this.context.address.targetId) === "connected";
  }

  /**
   * Fail-closed recheck run immediately before every terminal dispatch
   * (input, resize, close): full link freshness first (offline connection,
   * unbound target, incomplete inventory, or a stale warm copy), then the
   * strict session-ownership reader. Null means this dispatch may leave.
   */
  private dispatchGate(): PtyError | null {
    const snapshot = this.context.snapshot();
    const { targetId, hostId, sessionId } = this.context.address;
    const link = sessionWriteLink(snapshot, targetId, hostId, sessionId);
    if (link === "offline") {
      return { kind: "shell-error", message: MESSAGES.connectionLost };
    }
    if (link === "cached") {
      return { kind: "shell-error", message: MESSAGES.syncing };
    }
    const reason = sessionControlGateReason(snapshot, this.context.address);
    return reason === null ? null : { kind: "shell-error", message: reason };
  }

  private async openNow(request: PtyOpenRequest): Promise<void> {
    // Let the store attach its listeners before anything can fire.
    await Promise.resolve();
    if (this.phase === "closed") return;
    const availability = this.context.availabilityNow();
    if (!availability.available) {
      this.fail({
        kind: availability.kind === "permission" ? "permission-denied" : "shell-error",
        message: availability.reason,
      });
      return;
    }
    const revisionValue = this.resolveRevision();
    if (revisionValue === null) {
      this.fail({ kind: "shell-error", message: MESSAGES.notReady });
      return;
    }
    const args: Record<string, unknown> = {
      cwd: request.cwd ?? ".",
      cols: clampCols(request.cols),
      rows: clampRows(request.rows),
    };
    if (this.context.shellAdvertisedNow() && request.shell !== "") {
      args.shell = request.shell;
    }
    this.context.beginOpen();
    let accepted: { readonly requestId: string };
    try {
      const commandResult = await this.context.controller.commandWithControllerLease(
        this.context.address.targetId,
        {
          hostId: this.context.wireHostId,
          sessionId: this.context.wireSessionId,
          command: TERM_OPEN_COMMAND,
          expectedRevision: revisionValue,
          args,
        },
        undefined,
        () => {
          // Re-read after the controller-lease acquisition wait.
          const raced = this.dispatchGate();
          if (raced !== null) throw new WriteGateError(raced.message);
        },
      );
      if (!commandResult.accepted) {
        this.context.endOpen(this, null);
        this.fail({ kind: "shell-error", message: MESSAGES.rejected });
        return;
      }
      accepted = { requestId: String(commandResult.requestId) };
    } catch (error) {
      this.context.endOpen(this, null);
      if (error instanceof WriteGateError) {
        this.fail({ kind: "shell-error", message: error.reason });
        return;
      }
      // A lease refusal happens before the command is sent — that is a
      // clean, retryable rejection, not an unknown outcome.
      const contested =
        error instanceof DesktopRuntimeError && error.code !== "command";
      this.fail({
        kind: "shell-error",
        message: contested ? MESSAGES.contested : MESSAGES.openDisconnected,
      });
      return;
    }
    const correlation = await this.awaitResult(accepted.requestId);
    if (correlation.kind !== "result") {
      this.context.endOpen(this, null);
      if (!this.cancelled) {
        this.fail({
          kind: "shell-error",
          message:
            correlation.kind === "timeout" ? MESSAGES.openTimeout : MESSAGES.openDisconnected,
        });
      } else {
        this.phase = "closed";
      }
      return;
    }
    const serverId = parseTerminalIdFrom(correlation.result);
    if (serverId === null) {
      this.context.endOpen(this, null);
      if (this.cancelled) {
        this.phase = "closed";
        return;
      }
      this.fail(
        correlation.result.ok
          ? { kind: "shell-error", message: MESSAGES.badResult }
          : errorFromResult(correlation.result),
      );
      return;
    }
    if (this.cancelled) {
      // Killed while opening: the shell exists on the host but nobody here
      // wants it. Close it exactly once and register nothing.
      this.phase = "closed";
      this.serverTerminalId = serverId;
      this.closeOnce("closed before ready");
      this.context.endOpen(this, null);
      return;
    }
    this.serverTerminalId = serverId;
    this.phase = "open";
    // Ownership before the open window ends: buffered frames replay through
    // the router (cursor-deduplicated), then live frames route directly.
    this.context.endOpen(this, serverId);
    if (this.pendingResize !== null) void this.pumpResize();
    // Input queued during open flushes through the store's drain path.
    this.emitDrain();
  }

  /**
   * Correlate the accepted command to its projected result. The current
   * snapshot is checked before AND after subscribing, so a result that
   * lands between the two never races the listener.
   */
  private awaitResult(requestId: string): Promise<OpenCorrelation> {
    const immediate = this.findResult(this.context.snapshot(), requestId);
    if (immediate !== undefined) {
      return Promise.resolve({ kind: "result", result: immediate });
    }
    const { promise, resolve } = Promise.withResolvers<OpenCorrelation>();
    let settled = false;
    let cancelTimer: () => void = () => undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (outcome: OpenCorrelation): void => {
      if (settled) return;
      settled = true;
      cancelTimer();
      unsubscribe?.();
      this.abandonWait = null;
      resolve(outcome);
    };
    const inspect = (snapshot: DesktopRuntimeSnapshot): void => {
      const result = this.findResult(snapshot, requestId);
      if (result !== undefined) {
        finish({ kind: "result", result });
        return;
      }
      if (!this.connected(snapshot)) finish({ kind: "disconnected" });
    };
    unsubscribe = this.context.controller.subscribe(inspect);
    const timer = setTimeout(() => finish({ kind: "timeout" }), this.context.openTimeoutMs);
    cancelTimer = () => clearTimeout(timer);
    this.abandonWait = () => finish({ kind: "disconnected" });
    inspect(this.context.snapshot());
    return promise;
  }

  write(data: string): boolean {
    if (this.phase === "closed") return true;
    if (this.phase === "opening" || this.serverTerminalId === null) return false;
    if (this.pendingInputChars + data.length > this.context.maxPendingInputChars) {
      this.saturationSignalled = true;
      return false;
    }
    this.pendingInputChars += data.length;
    const terminalId = this.serverTerminalId;
    // One chain per session: input frames leave strictly in write order.
    this.inputChain = this.inputChain.then(async () => {
      try {
        if (this.phase === "open") {
          const gate = this.dispatchGate();
          if (gate !== null) {
            this.fail(gate);
            return;
          }
          if (!(await this.ensureLease()) || this.phase !== "open" || this.serverTerminalId !== terminalId) {
            this.fail({ kind: "shell-error", message: MESSAGES.contested });
            return;
          }
          // Re-read after the lease acquisition wait, immediately before
          // the input frame leaves.
          const raced = this.dispatchGate();
          if (raced !== null) {
            this.fail(raced);
            return;
          }
          try {
            await this.context.controller.terminalInput({
              ...this.sessionScope(),
              terminalId,
              data,
            });
          } catch {
            // Outcome unknown; never resend.
          }
        }
      } finally {
        this.pendingInputChars = Math.max(0, this.pendingInputChars - data.length);
        if (this.saturationSignalled && this.pendingInputChars === 0) {
          this.saturationSignalled = false;
          this.emitDrain();
        }
      }
    });
    return true;
  }

  resize(cols: number, rows: number): void {
    if (this.phase === "closed") return;
    this.pendingResize = { cols: clampCols(cols), rows: clampRows(rows) };
    if (this.phase === "open" && this.serverTerminalId !== null) void this.pumpResize();
  }

  /** Coalesces: while a resize is in flight, only the latest is kept. */
  private async pumpResize(): Promise<void> {
    if (this.resizeInFlight) return;
    this.resizeInFlight = true;
    try {
      while (
        this.pendingResize !== null &&
        this.phase === "open" &&
        this.serverTerminalId !== null
      ) {
        const next = this.pendingResize;
        this.pendingResize = null;
        try {
          // Ownership can move between user resizes; a gated resize simply
          // drops — the next writable resize carries fresh truth.
          if (this.dispatchGate() !== null) return;
          if (!(await this.ensureLease()) || this.phase !== "open" || this.serverTerminalId === null) return;
          if (this.dispatchGate() !== null) return;
          await this.context.controller.terminalResize({
            ...this.sessionScope(),
            terminalId: this.serverTerminalId,
            cols: next.cols,
            rows: next.rows,
          });
        } catch {
          // Outcome unknown; the next user resize carries fresh truth.
          return;
        }
      }
    } finally {
      this.resizeInFlight = false;
    }
  }

  kill(): void {
    if (this.phase === "closed") return;
    if (this.phase === "opening") {
      // openNow settles the server side: close-on-arrival, register nothing.
      this.cancelled = true;
      return;
    }
    this.phase = "closed";
    this.closeOnce("closed by user");
    this.context.forget(this);
  }

  private closeOnce(reason: string): void {
    if (this.closeSent || this.serverTerminalId === null) return;
    this.closeSent = true;
    void this.sendClose(reason);
  }

  private async sendClose(reason: string): Promise<void> {
    const terminalId = this.serverTerminalId;
    if (terminalId === null || this.dispatchGate() !== null) return;
    if (!(await this.ensureLease()) || this.phase !== "closed" || this.serverTerminalId !== terminalId) return;
    if (this.dispatchGate() !== null) return;
    try {
      await this.context.controller.terminalClose({
        ...this.sessionScope(),
        terminalId: this.serverTerminalId!,
        reason,
      });
    } catch {
      // Best effort: the host reaps orphaned shells on its own.
    }
  }

  /** The connection generation died under this session. No replay ever. */
  markLost(): void {
    if (this.phase === "closed") return;
    if (this.phase === "opening") {
      this.abandonWait?.();
      return;
    }
    this.phase = "closed";
    this.pendingInputChars = 0;
    this.pendingResize = null;
    this.context.forget(this);
    this.emitError({ kind: "shell-error", message: MESSAGES.connectionLost });
  }

  private fail(error: PtyError): void {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.context.forget(this);
    this.emitError(error);
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

  emitData(chunk: string): void {
    for (const listener of this.listeners.data) listener(chunk);
  }
  emitExit(exit: PtyExit): void {
    this.phase = "closed";
    for (const listener of this.listeners.exit) listener(exit);
  }
  emitDrain(): void {
    for (const listener of this.listeners.drain) listener();
  }
  emitNotice(notice: PtyNotice): void {
    for (const listener of this.listeners.notice) listener(notice);
  }
  private emitError(error: PtyError): void {
    for (const listener of this.listeners.error) listener(error);
  }
}

interface BufferedTerminalEvent {
  readonly terminalId: string;
  readonly event: PublicOmpServerEvent;
  readonly chars: number;
}

/**
 * Live `UserPtyBridge` for one target + host + session. The later
 * PaneContent integrator installs this per session view — there is no
 * module-level singleton and creating two bridges never crosses streams.
 */
export function createLivePtySessionFactory(
  controller: DesktopRuntimeController,
  snapshotAccessor: () => DesktopRuntimeSnapshot,
  sessionRef: LiveSessionAddress,
  options: LivePtyBridgeOptions = {},
): LivePtyBridge {
  const openTimeoutMs = options.openTimeoutMs ?? 15_000;
  const maxPendingInputChars = options.maxPendingInputChars ?? 32_768;
  const maxBufferedFrameChars = options.maxBufferedFrameChars ?? 262_144;

  const identity: TerminalWireIdentity = {
    hostId: sessionRef.hostId,
    sessionId: sessionRef.sessionId,
    deviceId: "desktop-renderer",
    connectionId: sessionRef.targetId,
  };
  const router = createTerminalFrameRouter(identity);
  /** Sessions that own a server terminal id, keyed by that id. */
  const owned = new Map<string, LivePtySession>();
  /** Every session between open() and its terminal close/exit/error. */
  const live = new Set<LivePtySession>();
  let pendingOpens = 0;
  let bufferedChars = 0;
  const buffered: BufferedTerminalEvent[] = [];
  const bufferDropped = new Set<string>();
  let disposed = false;

  const clearBuffer = (): void => {
    buffered.length = 0;
    bufferedChars = 0;
    bufferDropped.clear();
  };

  const bufferEvent = (event: PublicOmpServerEvent): void => {
    if (event.kind !== "terminal.output" && event.kind !== "terminal.exit") return;
    const terminalIdRaw = String(event.payload.terminalId);
    let chars = 32;
    if (event.kind === "terminal.output") chars += event.payload.data.length;
    buffered.push({ terminalId: terminalIdRaw, event, chars });
    bufferedChars += chars;
    while (bufferedChars > maxBufferedFrameChars && buffered.length > 0) {
      const oldest = buffered.shift();
      if (oldest === undefined) break;
      bufferedChars -= oldest.chars;
      bufferDropped.add(oldest.terminalId);
    }
  };

  const routeServerEvent = (serverEvent: PublicOmpServerEvent): void => {
    const event = router.routeEvent(serverEvent);
    if (event.kind === "ignored") {
      // Output can beat the result correlation: hold it (bounded) until the
      // open settles, then replay through the same deduplicating router.
      if (event.reason === "unowned-terminal" && pendingOpens > 0) bufferEvent(serverEvent);
      return;
    }
    const session = owned.get(event.terminalId);
    if (session === undefined) return;
    if (event.resumed) session.emitNotice("resumed");
    if (event.gap) session.emitNotice("output-skipped");
    if (event.kind === "output") {
      session.emitData(event.data);
      return;
    }
    owned.delete(event.terminalId);
    live.delete(session);
    router.release(event.terminalId);
    session.emitExit({ code: event.exitCode, signal: event.signal });
  };

  const offEvents = controller.subscribeEvents(
    {
      targetId: sessionRef.targetId,
      hostId: sessionRef.hostId,
      sessionId: sessionRef.sessionId,
      kinds: ["terminal.output", "terminal.exit"],
    },
    (event) => routeServerEvent(event.event),
  );

  let lastConnected =
    snapshotAccessor().connections.get(sessionRef.targetId) === "connected";
  const offRuntime = controller.subscribe((snapshot) => {
    const connected = snapshot.connections.get(sessionRef.targetId) === "connected";
    if (lastConnected && !connected) {
      // Generation boundary: every live shell is unknown now. Mark, never
      // re-open, never replay — the user reopens explicitly.
      for (const session of live) session.markLost();
      owned.clear();
      clearBuffer();
    }
    lastConnected = connected;
  });

  const context: LiveBridgeContext = {
    controller,
    snapshot: snapshotAccessor,
    address: sessionRef,
    wireHostId: brandHostId(sessionRef.hostId),
    wireSessionId: brandSessionId(sessionRef.sessionId),
    openTimeoutMs,
    maxPendingInputChars,
    availabilityNow: () => resolveLiveTerminalAvailability(snapshotAccessor(), sessionRef),
    shellAdvertisedNow: () =>
      shellFieldAdvertised(termOpenCatalogItem(snapshotAccessor(), sessionRef.hostId)),
    beginOpen: () => {
      pendingOpens += 1;
    },
    endOpen: (session, serverTerminalId) => {
      if (serverTerminalId !== null) {
        const key = String(serverTerminalId);
        router.own(key);
        owned.set(key, session);
        if (bufferDropped.has(key)) session.emitNotice("output-skipped");
        const replay = buffered.filter((entry) => entry.terminalId === key);
        for (const entry of replay) routeServerEvent(entry.event);
      }
      pendingOpens = Math.max(0, pendingOpens - 1);
      if (pendingOpens === 0) clearBuffer();
    },
    forget: (session) => {
      live.delete(session);
      if (session.serverTerminalId !== null) {
        const key = String(session.serverTerminalId);
        if (owned.get(key) === session) {
          owned.delete(key);
          router.release(key);
        }
      }
    },
  };

  return {
    kind: "desktop",
    availability: () => resolveLiveTerminalAvailability(snapshotAccessor(), sessionRef),
    open(request: PtyOpenRequest): PtySession {
      if (disposed) {
        throw new Error("This terminal bridge was disposed; open a fresh session view.");
      }
      if (request.cwd !== null && !isRelativeCwd(request.cwd)) {
        throw new Error(
          `Refusing absolute working directory "${request.cwd}" — shells open relative to the project root.`,
        );
      }
      const session = new LivePtySession(context, request);
      live.add(session);
      return session;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offEvents();
      offRuntime();
      for (const session of live) session.markLost();
      live.clear();
      owned.clear();
      clearBuffer();
    },
  };
}
