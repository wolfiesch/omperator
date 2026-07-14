import {
  COMMAND_DESCRIPTORS,
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  hostId,
  requiredCapability,
  sessionId,
  type ClientFrame,
  type Cursor,
  type HostId,
  type PairOkFrame,
  type ResultFrame,
  type ServerFrame,
  type SessionId,
  type WelcomeFrame,
} from "@t4-code/protocol";
import type { ProjectionStore } from "./projection.ts";
import {
  boundedMetadata,
  DefaultClock,
  DefaultIds,
  DefaultTimers,
  freeze,
  isTerminalState,
  MAX_PENDING,
  OmpClientError,
  type ClientErrorCode,
  type Clock,
  type CommandIntent,
  type CommandOptions,
  type ConfirmIntent,
  type IdFactory,
  type OmpClientOptions,
  type OmpClientState,
  type OmpResourceSnapshot,
  type OmpStateSnapshot,
  type Pending,
  type PairStartIntent,
  type PublicServerFrame,
  type TerminalCloseIntent,
  type TerminalInputIntent,
  type TerminalResizeIntent,
  type TimerScheduler,
  type Unsubscribe,
  sessionKey,
} from "./omp-client-contracts.ts";
import { CursorJournal } from "./omp-client-cursor.ts";
import { InboundFrameQueue } from "./omp-client-inbound.ts";
import type { ClientTimer } from "./omp-client-timers.ts";
import { PendingRequests } from "./omp-client-pending.ts";
import { ClientTimerRegistry } from "./omp-client-timers.ts";
import { OmpClientEvents } from "./omp-client-events.ts";
import { OmpClientConnection } from "./omp-client-connection.ts";
import { OmpClientFrameDispatcher, safeFrameDecodeFailure, sendClientHello } from "./omp-client-frames.ts";
import { OmpClientReconnectHealth } from "./omp-client-reconnect-health.ts";
import {
  buildCommandFrameInput,
  decodeOutgoingFrame,
} from "./omp-client-outbound.ts";
import { handleResponseFrame } from "./omp-client-response.ts";
import { isLegalClientTransition } from "./omp-client-state.ts";
export * from "./omp-client-contracts.ts";
export * from "./projection.ts";
export * from "./projection-cache.ts";
export * from "./desktop-runtime.ts";

type PendingResult = ResultFrame | PairOkFrame;
type DurableFrame = Extract<ServerFrame, { type: "entry" | "event" | "session.delta" }>;
interface ConnectWaiter {
  resolve: () => void;
  reject: (error: OmpClientError) => void;
}
export class OmpClient {
  private readonly options: OmpClientOptions;
  private readonly projection: ProjectionStore | undefined;
  private readonly timers: TimerScheduler;
  private readonly clock: Clock;
  private readonly ids: IdFactory;
  private readonly random: () => number;
  private readonly targetHost: HostId | undefined;
  private readonly expectedHost: HostId | undefined;
  private readonly timerRegistry: ClientTimerRegistry;
  private readonly cursorJournal: CursorJournal;
  private readonly inboundQueue: InboundFrameQueue;
  private readonly pendingRequests: PendingRequests;
  private readonly connection: OmpClientConnection;
  private readonly reconnectHealth: OmpClientReconnectHealth;
  private readonly frames: OmpClientFrameDispatcher;
  private readonly events = new OmpClientEvents();
  private readonly attached = new Map<string, { hostId: HostId; sessionId: SessionId }>();
  private handshakeTimer: ClientTimer | undefined;
  private heartbeatNonce: string | undefined;
  private stateValue: OmpClientState = "idle";
  private epochValue: string | undefined;
  private cursorValue: Cursor | undefined;
  private readonly desyncedSessions = new Set<string>();
  private authenticationValue: "local" | "pairing-required" | "paired" | undefined;
  private granted = new Set<string>();
  private closedByUser = false;
  private compatibilityFallbackUsed = false;
  private connectWaiters: ConnectWaiter[] = [];

  constructor(options: OmpClientOptions) {
    this.options = options;
    this.timers = options.timers ?? new DefaultTimers();
    this.clock = options.clock ?? new DefaultClock();
    this.ids = options.ids ?? new DefaultIds();
    this.projection = options.projection;
    this.random = options.random ?? Math.random;
    this.targetHost = options.hostId === undefined ? undefined : hostId(options.hostId);
    this.expectedHost = options.expectedHostId === undefined ? this.targetHost : hostId(options.expectedHostId);
    this.timerRegistry = new ClientTimerRegistry(this.timers);
    this.cursorJournal = new CursorJournal(
      options.cursorStore,
      (error) => this.emitError(error),
      (message, retryable) => this.error("storage", message, retryable),
    );
    this.inboundQueue = new InboundFrameQueue(
      () => this.generation,
      () => this.closedByUser,
      (raw, generation) => this.handleRaw(raw, generation),
      () => this.fatal(this.error("protocol", "inbound frame queue overflow")),
    );
    this.pendingRequests = new PendingRequests(
      options.maxPending ?? MAX_PENDING,
      options.commandTimeoutMs ?? 30_000,
      (callback, delayMs) => this.timerRegistry.schedule(callback, delayMs),
      (timer) => this.timerRegistry.clear(timer),
      (code, message, retryable) => this.error(code, message, retryable),
    );
    this.connection = new OmpClientConnection(
      options.transport,
      this.timerRegistry,
      this.clock,
      this.ids,
      this.random,
      options.reconnect,
      options.heartbeat,
      () => !this.closedByUser && !isTerminalState(this.stateValue),
      {
        connected: (_transport, generation) => this.handleConnected(generation),
        message: (raw, generation) => this.inboundQueue.enqueue(raw, generation),
        close: (code, reason) => this.handleDisconnect(code, reason),
        error: (error) => this.handleTransportError(error),
        reconnectLimit: () => this.fatal(this.error("transport", "reconnect attempt limit reached")),
        reconnectWait: () => this.transition("reconnect-wait"),
        heartbeatFailure: () => this.handleDisconnect(undefined, "heartbeat timeout"),
      },
    );
    this.reconnectHealth = new OmpClientReconnectHealth(() => this.connection.resetAttempts());
    this.frames = new OmpClientFrameDispatcher({
      welcome: (frame) => this.handleWelcome(frame),
      pong: (nonce) => this.handlePong(nonce),
      bye: (frame) => { if (frame.retryable) this.handleDisconnect(undefined, frame.reason); else this.fatal(this.error(frame.code.toLowerCase().includes("auth") ? "auth" : "protocol", "server closed the protocol session")); },
      response: (frame) => this.handleResponse(frame),
      pairOk: (frame, generation) => this.handlePairOk(frame, generation),
      pairError: (frame) => { if (frame.requestId !== undefined) this.settlePairError(frame); this.publish(frame); },
      gap: (frame) => { this.markDesynced(sessionKey(String(frame.hostId), String(frame.sessionId)), "cursor gap requires a snapshot"); this.publish(frame); },
      snapshot: (frame) => this.acceptSnapshot(frame),
      durable: (frame) => {
        // Host-wide session-index deltas have their own per-session ordering in
        // ProjectionStore. They must not inherit transcript cursor contiguity:
        // an unattached client can legitimately miss entry/event frames.
        if (frame.type === "session.delta") this.publish(frame);
        else if (this.acceptDurable(frame)) this.publish(frame);
      },
      other: (frame) => this.publish(frame),
    });
  }

  get state(): OmpClientState {
    return this.stateValue;
  }
  private get generation(): number {
    return this.connection.generation;
  }

  private get attempt(): number {
    return this.connection.attempts;
  }

  snapshot(): OmpStateSnapshot {
    return freeze({
      state: this.stateValue,
      generation: this.generation,
      attempt: this.attempt,
      ...(this.targetHost === undefined ? {} : { hostId: String(this.targetHost) }),
      ...(this.epochValue === undefined ? {} : { epoch: this.epochValue }),
      ...(this.cursorValue === undefined ? {} : { cursor: freeze({ ...this.cursorValue }) }),
      ...(this.authenticationValue === undefined ? {} : { authentication: this.authenticationValue }),
      desynced: this.desyncedSessions.size > 0,
    });
  }

  resources(): OmpResourceSnapshot {
    return {
      timers: this.timerRegistry.size,
      socket: this.connection.socket !== undefined,
      socketHandlers: this.connection.socketHandlers,
      pending: this.pendingRequests.size,
      cursorSaves: this.cursorJournal.pendingSaves,
      listeners: this.events.listenerCount,
    };
  }

  onState(listener: (snapshot: OmpStateSnapshot) => void): Unsubscribe { return this.events.onState(listener); }
  onFrame(listener: (frame: PublicServerFrame) => void): Unsubscribe { return this.events.onFrame(listener); }
  onError(listener: (error: OmpClientError) => void): Unsubscribe { return this.events.onError(listener); }

  async connect(): Promise<void> {
    if (isTerminalState(this.stateValue)) throw this.error("closed", "client is closed");
    await this.cursorJournal.load();
    if (this.stateValue === "ready") return;
    if (isTerminalState(this.stateValue)) throw this.error("closed", "client is closed");
    const ready = new Promise<void>((resolve, reject) => this.connectWaiters.push({ resolve, reject }));
    this.closedByUser = false;
    if (this.stateValue === "idle") {
      // The transport factory may itself await a WebSocket/Unix-socket open.
      // Publish connecting before that await so failures can legally enter
      // reconnect-wait/fatal and concurrent connect() calls share one attempt.
      this.transition("connecting");
      this.connection.begin();
    }
    return ready;
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    this.closedByUser = true;
    this.clearInbound();
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.transition("closing");
    const closeError = this.error("closed", "client closed");
    for (const waiter of this.connectWaiters.splice(0)) waiter.reject(closeError);
    this.clearAllTimers();
    this.pendingRequests.rejectAll(closeError);
    this.connection.disconnect();
    await this.cursorJournal.waitForSaves();
    this.transition("closed");
    this.events.clear();
  }
  command(intent: CommandIntent, options: CommandOptions = {}): Promise<ResultFrame> {
    return this.sendCommand(intent, options);
  }

  attach(host: string, session: string, options: CommandOptions = {}): Promise<ResultFrame> {
    return this.sendCommand({ hostId: host, sessionId: session, command: "session.attach", args: {} }, options);
  }

  confirm(intent: ConfirmIntent, options: CommandOptions = {}): Promise<ResultFrame> {
    if (this.stateValue !== "ready") return Promise.reject(this.error("invalid_state", "client is not ready"));
    const request = this.ids.next("request");
    const frame = decodeOutgoingFrame({
      v: PROTOCOL_VERSION,
      type: "confirm",
      requestId: request,
      confirmationId: intent.confirmationId,
      commandId: intent.commandId,
      hostId: intent.hostId,
      ...(intent.sessionId === undefined ? {} : { sessionId: intent.sessionId }),
      decision: intent.decision,
    });
    if (frame === undefined || frame.type !== "confirm") return Promise.reject(this.error("protocol", "invalid confirmation intent"));
    return this.sendPending(frame, request, options, "confirm").then((result) => {
      if (result.type !== "response") throw this.error("protocol", "unexpected pairing response");
      return result;
    });
  }
  terminalInput(intent: TerminalInputIntent): void {
    this.sendTerminalFrame({ v: PROTOCOL_VERSION, type: "terminal.input", ...intent });
  }
  terminalResize(intent: TerminalResizeIntent): void {
    this.sendTerminalFrame({ v: PROTOCOL_VERSION, type: "terminal.resize", ...intent });
  }
  terminalClose(intent: TerminalCloseIntent): void {
    this.sendTerminalFrame({ v: PROTOCOL_VERSION, type: "terminal.close", ...intent });
  }

  pairStart(intent: PairStartIntent, options: CommandOptions = {}): Promise<PairOkFrame> {
    if (this.stateValue !== "pairing") return Promise.reject(this.error("invalid_state", "pairing is not required"));
    const request = this.ids.next("request");
    const frame = decodeOutgoingFrame({
      v: PROTOCOL_VERSION,
      type: "pair.start",
      requestId: request,
      code: intent.code,
      deviceId: intent.deviceId,
      deviceName: intent.deviceName,
      platform: intent.platform,
      requestedCapabilities: [...intent.requestedCapabilities],
    });
    if (frame === undefined || frame.type !== "pair.start") return Promise.reject(this.error("protocol", "invalid pairing intent"));
    return this.sendPending(frame, request, options, "pair").then((result) => {
      if (result.type !== "pair.ok") throw this.error("protocol", "unexpected pairing response");
      return result;
    });
  }

  private sendCommand(intent: CommandIntent, options: CommandOptions): Promise<ResultFrame> {
    if (this.stateValue !== "ready") return Promise.reject(this.error("invalid_state", "client is not ready"));
    const descriptor = COMMAND_DESCRIPTORS[intent.command];
    if (descriptor === undefined) return Promise.reject(this.error("protocol", "unknown command"));
    const capability = requiredCapability(intent.command);
    if (capability !== undefined && !this.granted.has(capability)) {
      return Promise.reject(this.error("capability", "command capability was not granted", false, { capability }));
    }
    const request = this.ids.next("request");
    const command = this.ids.next("command");
    const rawFrame = buildCommandFrameInput(intent, request, command);
    const frame = decodeOutgoingFrame(rawFrame);
    if (frame === undefined || frame.type !== "command") return Promise.reject(this.error("protocol", "invalid command intent"));
    const kind = intent.command === "session.attach" ? "attach" : "command";
    return this.sendPending(frame, request, options, kind, intent).then((result) => {
      if (result.type !== "response") throw this.error("protocol", "unexpected pairing response");
      return result;
    });
  }
  private sendTerminalFrame(input: Record<string, unknown>): void {
    if (this.stateValue !== "ready") throw this.error("invalid_state", "client is not ready");
    const frame = decodeOutgoingFrame(input);
    if (frame === undefined || (frame.type !== "terminal.input" && frame.type !== "terminal.resize" && frame.type !== "terminal.close"))
      throw this.error("protocol", "invalid terminal intent");
    const encoded = JSON.stringify(frame);
    try {
      decodeClientFrame(encoded);
      this.connection.send(encoded);
    } catch (error) {
      if (error instanceof OmpClientError) throw error;
      throw this.error("transport", "transport send failed", true);
    }
  }

  private sendPending(
    frame: ClientFrame,
    requestText: string,
    options: CommandOptions,
    kind: Pending["kind"],
    intent?: CommandIntent,
  ): Promise<PendingResult> {
    return this.pendingRequests.begin(frame, requestText, options, kind, intent, (encoded, pending) => {
      try {
        decodeClientFrame(encoded);
        pending.handedToTransport = true;
        this.connection.send(encoded);
      } catch (error) {
        pending.handedToTransport = false;
        if (error instanceof OmpClientError) throw error;
        throw this.error("transport", "transport send failed", true);
      }
    });
  }

  private handleConnected(_generation: number): void {
    this.reconnectHealth.clear();
    this.transition("connecting");
    this.transition("handshaking");
    this.sendHello();
    if (this.stateValue === "handshaking") {
      this.handshakeTimer = this.schedule(() => this.protocolFailure("handshake timed out"), this.options.handshakeTimeoutMs ?? 10_000);
    }
  }
  private sendHello(): void {
    const helloOptions =
      this.compatibilityFallbackUsed && this.options.compatibilityRequestedFeatures !== undefined
        ? {
            ...this.options,
            requestedFeatures: this.options.compatibilityRequestedFeatures,
          }
        : this.options;
    sendClientHello(
      helloOptions,
      [...this.cursorJournal.records.values()],
      (encoded) => this.connection.send(encoded),
      (input) => decodeOutgoingFrame(input),
      () => this.fatal(this.error("auth", "authentication provider failed")),
      () => this.protocolFailure("hello could not be sent"),
    );
  }
  private clearInbound(): void { this.inboundQueue.clear(); }

  private handleRaw(raw: string | Uint8Array, generation: number): void | Promise<void> {
    if (generation !== this.generation || this.closedByUser) return;
    try {
      return this.frames.dispatch(decodeServerFrame(raw), generation);
    } catch (error) {
      if (generation === this.generation) this.protocolFailure(safeFrameDecodeFailure(error));
    }
  }

  private handleWelcome(frame: WelcomeFrame): void {
    this.clearTimer("handshakeTimer");
    if (this.expectedHost !== undefined && frame.hostId !== this.expectedHost) {
      this.fatal(this.error("protocol", "welcome host does not match target"));
      return;
    }
    this.authenticationValue = frame.authentication;
    this.epochValue = frame.epoch;
    this.granted = new Set(frame.grantedCapabilities);
    if (frame.authentication === "pairing-required") {
      this.reconnectHealth.beginWelcome(this.generation, []);
      this.transition("pairing");
      this.startHeartbeat();
      this.publish(frame);
      for (const waiter of this.connectWaiters.splice(0)) waiter.resolve();
      return;
    }
    this.reconnectHealth.beginWelcome(this.generation, this.attached.keys());
    for (const feature of this.options.requiredFeatures ?? []) {
      if (!frame.grantedFeatures.includes(feature)) {
        this.fatal(this.error("capability", "required feature was not granted", false, { feature }));
        return;
      }
    }
    this.transition("ready");
    this.startHeartbeat();
    this.publish(frame);
    for (const waiter of this.connectWaiters.splice(0)) waiter.resolve();
    this.reattachSessions();
  }

  private acceptSnapshot(frame: Extract<ServerFrame, { type: "snapshot" }>): void {
    const currentKey = sessionKey(String(frame.hostId), String(frame.sessionId));
    this.desyncedSessions.delete(currentKey);
    this.epochValue = frame.cursor.epoch;
    this.cursorValue = frame.cursor;
    this.cursorJournal.remember({ hostId: String(frame.hostId), sessionId: String(frame.sessionId), cursor: frame.cursor });
    this.reconnectHealth.acceptReplayProgress(
      this.generation,
      currentKey,
      frame.cursor,
      true,
    );
    this.publish(frame);
  }

  private acceptDurable(frame: DurableFrame): boolean {
    const currentKey = `${String(frame.hostId)}\u0000${String(frame.sessionId)}`;
    const previous = this.cursorJournal.bySession.get(currentKey);
    if (previous === undefined) {
      if (this.desyncedSessions.has(currentKey)) return false;
      this.cursorValue = frame.cursor;
      this.epochValue = frame.cursor.epoch;
      this.cursorJournal.remember({ hostId: String(frame.hostId), sessionId: String(frame.sessionId), cursor: frame.cursor });
      this.reconnectHealth.acceptReplayProgress(this.generation, currentKey, frame.cursor, false);
      return true;
    }
    if (frame.cursor.epoch !== previous.epoch) {
      this.markDesynced(currentKey, "cursor epoch changed without a snapshot");
      return false;
    }
    if (frame.cursor.seq <= previous.seq) return false;
    if (frame.cursor.seq !== previous.seq + 1 || this.desyncedSessions.has(currentKey)) {
      this.markDesynced(currentKey, "durable cursor is not contiguous", { expectedSeq: previous.seq + 1, receivedSeq: frame.cursor.seq });
      return false;
    }
    this.cursorValue = frame.cursor;
    this.epochValue = frame.cursor.epoch;
    this.cursorJournal.remember({ hostId: String(frame.hostId), sessionId: String(frame.sessionId), cursor: frame.cursor });
    this.reconnectHealth.acceptReplayProgress(this.generation, currentKey, frame.cursor, false);
    return true;
  }

  private handleResponse(frame: ResultFrame): void {
    handleResponseFrame(this.pendingRequests, frame, {
      protocolFailure: (message) => this.protocolFailure(message),
      publish: (response) => this.publish(response),
      attached: (host, session, response) => {
        const attachedHost = hostId(host);
        const attachedSession = sessionId(session);
        const key = sessionKey(String(attachedHost), String(attachedSession));
        this.attached.set(key, {
          hostId: attachedHost,
          sessionId: attachedSession,
        });
        this.reconnectHealth.acceptAttachResponse(
          this.generation,
          key,
          response,
          this.cursorJournal.bySession.get(key),
        );
      },
    });
  }

  private async handlePairOk(frame: PairOkFrame, generation: number): Promise<void> {
    if (generation !== this.generation || this.closedByUser) return;
    const pending = this.pendingRequests.entries.get(String(frame.requestId));
    if (pending === undefined || pending.kind !== "pair" || pending.frame.type !== "pair.start") {
      this.protocolFailure("unexpected pairing response");
      return;
    }
    const requested = new Set(pending.frame.requestedCapabilities);
    if (frame.deviceId !== pending.frame.deviceId || frame.deviceName !== pending.frame.deviceName || frame.platform !== pending.frame.platform || frame.requestedCapabilities.some((cap) => !requested.has(cap)) || frame.grantedCapabilities.some((cap) => !requested.has(cap)) || !Number.isFinite(Date.parse(frame.expiresAt)) || Date.parse(frame.expiresAt) <= this.clock.now()) {
      this.fatal(this.error("auth", "pairing response validation failed"));
      return;
    }
    try {
      if (this.options.privilegedPairResult === undefined) throw new Error("pairing sink unavailable");
      await this.options.privilegedPairResult(frame);
    } catch {
      if (generation === this.generation && !this.closedByUser) this.fatal(this.error("auth", "pairing credential could not be stored"));
      return;
    }
    if (generation !== this.generation || this.closedByUser) return;
    this.pendingRequests.settle(String(frame.requestId), frame);
    this.authenticationValue = "paired";
    this.clearInbound();
    this.heartbeatNonce = undefined;
    // Pair completion rotates credentials by intentionally reconnecting. It is
    // not another failure in the preceding transport retry streak.
    this.connection.resetAttempts();
    this.connection.disconnect();
    this.scheduleReconnect();
  }
  private settlePairError(frame: Extract<ServerFrame, { type: "pair.error" }>): void {
    const id = String(frame.requestId);
    const pending = this.pendingRequests.entries.get(id);
    if (pending?.kind === "pair") this.pendingRequests.settle(id, undefined, this.error("auth", "pairing request failed", false, { code: frame.code }));
  }

  private handleDisconnect(code?: number, reason?: string): void {
    if (this.closedByUser || isTerminalState(this.stateValue)) return;
    const helloRejected =
      this.stateValue === "handshaking" && code === 1008 && reason?.trim() === "invalid frame";
    if (helloRejected) {
      if (
        !this.compatibilityFallbackUsed &&
        this.options.compatibilityRequestedFeatures !== undefined
      ) {
        this.compatibilityFallbackUsed = true;
        this.emitError(
          this.error(
            "protocol",
            "Host uses an earlier feature set; reconnecting in compatibility mode.",
            true,
          ),
        );
      } else {
        this.fatal(this.error("protocol", "Host rejected the protocol hello."));
        return;
      }
    }
    this.clearTimer("handshakeTimer");
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.connection.disconnect();
    for (const [id, pending] of this.pendingRequests.entries) {
      if (pending.handedToTransport) {
        this.pendingRequests.settle(id, undefined, this.error("outcome_unknown", "request outcome is unknown; inspect server state before retrying", true, pending.commandId === undefined ? undefined : { commandId: pending.commandId }));
      } else {
        this.pendingRequests.settle(id, undefined, this.error("transport", "transport disconnected before request was sent", true));
      }
    }
    this.scheduleReconnect();
  }

  private handleTransportError(_error: unknown): void {
    this.emitError(this.error("transport", "transport error", true));
    this.handleDisconnect(undefined, "transport error");
  }

  private scheduleReconnect(): void {
    if (!this.closedByUser) this.connection.scheduleReconnect();
  }

  private reattachSessions(): void {
    for (const record of this.attached.values()) {
      const cursor = this.cursorJournal.records.get(`${String(record.hostId)}\u0000${String(record.sessionId)}`)?.cursor;
      this.sendCommand(
        { hostId: String(record.hostId), sessionId: String(record.sessionId), command: "session.attach", args: cursor === undefined ? {} : { cursor } },
        { timeoutMs: this.options.commandTimeoutMs ?? 30_000 },
      ).catch(() => undefined);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatNonce = undefined;
    this.connection.startHeartbeat(
      () => this.stateValue === "ready" || this.stateValue === "pairing",
      () => {
        const nonce = this.ids.next("ping");
        this.heartbeatNonce = nonce;
        const frame = decodeOutgoingFrame({
          v: PROTOCOL_VERSION,
          type: "ping",
          nonce,
          timestamp: new Date(this.clock.now()).toISOString(),
        });
        try {
          if (frame === undefined) throw new Error("invalid ping");
          const encoded = JSON.stringify(frame);
          decodeClientFrame(encoded);
          this.connection.send(encoded);
          return true;
        } catch {
          return false;
        }
      },
    );
  }

  private handlePong(nonce: string): void {
    if (nonce !== this.heartbeatNonce) return;
    this.heartbeatNonce = undefined;
    this.connection.clearHeartbeatTimeout();
    this.reconnectHealth.acceptPong(this.generation);
  }


  private markDesynced(key: string, message: string, metadata?: Record<string, string | number | boolean>): void {
    if (!this.desyncedSessions.has(key)) this.emitError(this.error("desync", message, true, metadata));
    this.desyncedSessions.add(key);
  }

  private protocolFailure(message: string): void {
    this.fatal(this.error("protocol", message));
  }

  private fatal(error: OmpClientError): void {
    this.emitError(error);
    this.closedByUser = true;
    this.clearInbound();
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.clearAllTimers();
    this.pendingRequests.rejectAll(error);
    for (const waiter of this.connectWaiters.splice(0)) waiter.reject(error);
    this.connection.disconnect();
    if (this.stateValue !== "fatal" && this.stateValue !== "closed") this.transition("fatal");
  }

  private error(code: ClientErrorCode, message: string, retryable = false, metadata?: Record<string, string | number | boolean>): OmpClientError {
    return new OmpClientError({ code, message, retryable, ...(metadata === undefined ? {} : { metadata: boundedMetadata(metadata) }) });
  }
  private publish(frame: PublicServerFrame): void {
    this.events.publish(frame, this.projection);
  }

  private emitError(error: OmpClientError): void { this.events.emitError(error); }
  private emitState(): void { this.events.emitState(this.snapshot()); }

  private transition(next: OmpClientState): void {
    if (!isLegalClientTransition(this.stateValue, next)) return;
    this.stateValue = next;
    this.emitState();
  }

  private schedule(callback: () => void, delayMs: number): ClientTimer {
    return this.timerRegistry.schedule(callback, delayMs);
  }

  private clearTimer(name: "handshakeTimer"): void {
    const timer = this[name];
    if (timer === undefined) return;
    this[name] = undefined;
    this.timerRegistry.clear(timer);
  }

  private clearAllTimers(): void {
    this.clearTimer("handshakeTimer");
    this.connection.stopHeartbeat();
    this.connection.clearReconnect();
    this.timerRegistry.clearAll();
  }
}

export function createOmpClient(options: OmpClientOptions): OmpClient {
  return new OmpClient(options);
}
