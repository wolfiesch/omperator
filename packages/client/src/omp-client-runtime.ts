import { hostId, sessionId, type Cursor, type HostId, type SessionId } from "@t4-code/protocol";
import type { PreviewProjection, ProjectionStore } from "./projection.ts";
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
  type PendingMessage,
  type PairStartIntent,
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
import {
  decodeProviderServerEvent,
  OmpClientEventDispatcher,
  safeFrameDecodeFailure,
  sendClientHello,
} from "./omp-client-frames.ts";
import { OmpClientReconnectHealth } from "./omp-client-reconnect-health.ts";
import { encodeOutgoingMessage } from "./omp-client-outbound.ts";
import { resolveOmpProtocolProvider } from "./omp-protocol-provider-registry.ts";
import {
  type OmpClientMessage,
  type OmpPairOk,
  type OmpProtocolProvider,
  type OmpResponse,
  type OmpServerEventOf,
  type PublicOmpServerEvent,
} from "./omp-protocol-provider.ts";
import { handleResponseFrame } from "./omp-client-response.ts";
import { isLegalClientTransition } from "./omp-client-state.ts";
export * from "./omp-client-contracts.ts";
import {
  PreviewCaptureResource,
  PreviewLeaseManager,
  previewKey,
  type PreviewCaptureMetadata,
  type PreviewCaptureReadResult,
  type PreviewIdentity,
  type PreviewLeaseIdentity,
} from "./preview.ts";
export * from "./preview.ts";
export * from "./projection.ts";
export * from "./projection-cache.ts";
export * from "./desktop-runtime.ts";

type PendingResult = OmpResponse | OmpPairOk;
type DurableEvent = OmpServerEventOf<"entry" | "event" | "session.delta">;
type PublicEvent<Kind extends PublicOmpServerEvent["kind"]> = Extract<
  PublicOmpServerEvent,
  { kind: Kind }
>;
export interface PreviewCommandTarget extends PreviewIdentity {
  readonly leaseId?: string;
}
export interface PreviewLaunchIntent {
  readonly hostId: string;
  readonly sessionId: string;
  readonly url: string;
  readonly authorityId?: string;
}
export interface PreviewNavigateIntent extends PreviewCommandTarget {
  readonly url: string;
}
export interface PreviewClickIntent extends PreviewCommandTarget {
  readonly x?: number;
  readonly y?: number;
  readonly selector?: string;
  readonly button?: "left" | "middle" | "right";
  readonly clickCount?: number;
}
export interface PreviewScrollIntent extends PreviewCommandTarget {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly selector?: string;
}
export interface PreviewTypeIntent extends PreviewCommandTarget {
  readonly text: string;
  readonly selector?: string;
}
export interface PreviewFillIntent extends PreviewCommandTarget {
  readonly text: string;
  readonly selector?: string;
}
export interface PreviewSelectIntent extends PreviewCommandTarget {
  readonly selector: string;
  readonly value: string;
}
export interface PreviewUploadIntent extends PreviewCommandTarget {
  readonly selector: string;
  readonly path: string;
}
export interface PreviewPressIntent extends PreviewCommandTarget {
  readonly key: string;
}
export interface PreviewPolicyCheckIntent {
  readonly hostId: string;
  readonly sessionId: string;
  readonly action:
    | "activate"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "close"
    | "capture"
    | "click"
    | "fill"
    | "type"
    | "press"
    | "scroll"
    | "select"
    | "upload"
    | "handoff";
  readonly previewId?: string;
  readonly url?: string;
  readonly authorityId?: string;
}
export interface PreviewHandoffIntent extends PreviewCommandTarget {
  readonly message: string;
  readonly mode?: "manual" | "selector" | "url" | "text";
  readonly selector?: string;
  readonly urlSubstring?: string;
  readonly text?: string;
  readonly timeoutMs?: number;
}
interface ConnectWaiter {
  resolve: () => void;
  reject: (error: OmpClientError) => void;
}
export class OmpClient {
  private readonly options: OmpClientOptions;
  private readonly protocol: OmpProtocolProvider;
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
  private readonly inboundDispatcher: OmpClientEventDispatcher;
  private readonly events = new OmpClientEvents();
  private readonly attached = new Map<string, { hostId: HostId; sessionId: SessionId }>();
  private readonly attachmentRecoveries = new Map<
    string,
    { readonly generation: number; readonly promise: Promise<OmpResponse>; readonly awaitsSnapshot: boolean }
  >();
  private readonly previewCaptures: PreviewCaptureResource;
  readonly previewLeaseManager: PreviewLeaseManager;
  private handshakeTimer: ClientTimer | undefined;
  private heartbeatNonce: string | undefined;
  private stateValue: OmpClientState = "idle";
  private epochValue: string | undefined;
  private cursorValue: Cursor | undefined;
  private readonly desyncedSessions = new Set<string>();
  private authenticationValue: "local" | "pairing-required" | "paired" | undefined;
  private granted = new Set<string>();
  private previewStateGeneration: number | undefined;
  private readonly previewStateSessions = new Set<string>();
  private sessionStateGeneration: number | undefined;
  private readonly sessionStateSessions = new Set<string>();
  private closedByUser = false;
  private compatibilityFallbackUsed = false;
  private connectWaiters: ConnectWaiter[] = [];
  private lastInboundAt: number | undefined;
  private fatalError: OmpClientError | undefined;

  constructor(options: OmpClientOptions) {
    this.options = options;
    this.protocol = resolveOmpProtocolProvider(options);
    this.timers = options.timers ?? new DefaultTimers();
    this.clock = options.clock ?? new DefaultClock();
    this.ids = options.ids ?? new DefaultIds();
    this.projection = options.projection;
    this.previewCaptures = new PreviewCaptureResource({
      read: async (identity, captureId, offset) =>
        this.readPreviewCapture(identity, captureId, offset),
    });
    this.previewLeaseManager = new PreviewLeaseManager(this, { now: () => this.clock.now() });
    this.random = options.random ?? Math.random;
    this.targetHost = options.hostId === undefined ? undefined : hostId(options.hostId);
    this.expectedHost =
      options.expectedHostId === undefined ? this.targetHost : hostId(options.expectedHostId);
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
        reconnectBegin: () => this.transition("connecting"),
        message: (raw, generation) => {
          this.lastInboundAt = this.clock.now();
          this.inboundQueue.enqueue(raw, generation);
        },
        close: (code, reason) => this.handleDisconnect(code, reason),
        error: (error) => this.handleTransportError(error),
        reconnectWait: () => this.transition("reconnect-wait"),
        heartbeatFailure: () => this.handleDisconnect(undefined, "heartbeat timeout"),
      },
    );
    this.reconnectHealth = new OmpClientReconnectHealth(() => this.connection.resetAttempts());
    this.inboundDispatcher = new OmpClientEventDispatcher({
      welcome: (message) => this.handleWelcome(message),
      pong: (nonce) => this.handlePong(nonce),
      bye: (message) => {
        if (message.payload.retryable) this.handleDisconnect(undefined, message.payload.reason);
        else
          this.fatal(
            this.error(
              message.payload.code.toLowerCase().includes("auth") ? "auth" : "protocol",
              "server closed the protocol session",
            ),
          );
      },
      response: (message) => this.handleResponse(message),
      pairOk: (message, generation) => this.handlePairOk(message, generation),
      pairError: (message) => {
        if (message.payload.requestId !== undefined) this.settlePairError(message);
        this.publish(message);
      },
      gap: (message) => {
        this.markDesynced(
          sessionKey(String(message.payload.hostId), String(message.payload.sessionId)),
          "cursor gap requires a snapshot",
        );
        this.publish(message);
      },
      snapshot: (message) => this.acceptSnapshot(message),
      durable: (message) => {
        // Host-wide session-index deltas have their own per-session ordering in
        // ProjectionStore. They must not inherit transcript cursor contiguity:
        // an unattached client can legitimately miss entry/event frames.
        if (message.kind === "session.delta") this.publish(message);
        else if (this.acceptDurable(message)) this.publish(message);
      },
      other: (message) => this.publish(message),
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
      ...(this.authenticationValue === undefined
        ? {}
        : { authentication: this.authenticationValue }),
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

  onState(listener: (snapshot: OmpStateSnapshot) => void): Unsubscribe {
    return this.events.onState(listener);
  }
  onEvent(listener: (event: PublicOmpServerEvent) => void): Unsubscribe {
    return this.events.onEvent(listener);
  }
  onError(listener: (error: OmpClientError) => void): Unsubscribe {
    return this.events.onError(listener);
  }

  async connect(): Promise<void> {
    if (isTerminalState(this.stateValue)) throw this.error("closed", "client is closed");
    await this.cursorJournal.load();
    if (this.stateValue === "ready") return;
    if (isTerminalState(this.stateValue)) throw this.error("closed", "client is closed");
    const ready = new Promise<void>((resolve, reject) =>
      this.connectWaiters.push({ resolve, reject }),
    );
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

  /**
   * Nudge a backgrounded client back to health. Fresh ready sockets and
   * in-flight connection attempts are left alone; pending backoff is skipped,
   * a stale ready socket is replaced.
   */
  wake(): void {
    if (this.stateValue === "idle") {
      void this.connect().catch(() => undefined);
      return;
    }
    if (this.stateValue === "reconnect-wait") {
      this.connection.beginReconnectNow();
      return;
    }
    if (this.stateValue === "fatal") {
      this.reviveRetryableTransportFailure();
      return;
    }
    if ((this.stateValue === "ready" || this.stateValue === "pairing") && this.inboundIsStale()) {
      this.reconnectNow();
    }
  }

  /** Force an immediate reconnect while preserving cursors and attachments. */
  reconnectNow(): void {
    if (this.stateValue === "idle") {
      void this.connect().catch(() => undefined);
      return;
    }
    if (this.stateValue === "reconnect-wait") {
      this.connection.beginReconnectNow();
      return;
    }
    if (this.stateValue === "fatal") {
      this.reviveRetryableTransportFailure();
      return;
    }
    if (
      this.stateValue === "closed" ||
      this.stateValue === "closing" ||
      this.stateValue === "connecting" ||
      this.stateValue === "handshaking"
    )
      return;

    // Replacing a socket starts a new recovery episode.
    // Attempts remain charged until heartbeat and replay recovery.
    this.handleDisconnect(undefined, "foreground reconnect");
    this.connection.beginReconnectNow();
  }

  async close(): Promise<void> {
    if (this.stateValue === "closed") return;
    if (this.stateValue === "ready") await this.previewLeaseManager.releaseAll();
    this.previewLeaseManager.invalidateAll();
    this.closedByUser = true;
    this.fatalError = undefined;
    this.clearInbound();
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.transition("closing");
    const closeError = this.error("closed", "client closed");
    for (const waiter of this.connectWaiters.splice(0)) waiter.reject(closeError);
    this.clearAllTimers();
    this.pendingRequests.rejectAll(closeError);
    this.connection.disconnect();
    this.previewCaptures.dispose();
    await this.cursorJournal.waitForSaves();
    this.transition("closed");
    this.events.clear();
  }
  async command(intent: CommandIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    const generation = this.generation;
    const attachmentKey =
      intent.command === "session.attach" && intent.hostId !== undefined && intent.sessionId !== undefined
        ? sessionKey(intent.hostId, intent.sessionId)
        : undefined;
    const recovery = attachmentKey === undefined ? undefined : this.attachmentRecoveries.get(attachmentKey);
    // The transport owns reattachment across reconnects. A renderer can observe
    // the ready state before the new welcome/snapshot reaches its projection and
    // otherwise race that recovery with an old-epoch attach of its own.
    const response =
      recovery !== undefined && recovery.generation === generation
        ? await recovery.promise
        : await this.sendCommand(intent, options);
    if (
      response.ok &&
      intent.command === "session.attach" &&
      intent.hostId !== undefined &&
      intent.sessionId !== undefined
    ) {
      const record = { hostId: hostId(intent.hostId), sessionId: sessionId(intent.sessionId) };
      this.requestSessionState(record, generation);
      this.requestPreviewState(record, generation);
    }
    return response;
  }

  attach(host: string, session: string, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.command(
      { hostId: host, sessionId: session, command: "session.attach", args: {} },
      options,
    );
  }

  preview(identity: PreviewCommandTarget): PreviewProjection | undefined {
    return this.projection?.snapshot.sessions
      .get(sessionKey(identity.hostId, identity.sessionId))
      ?.previews.get(previewKey(identity));
  }

  previewCaptureObjectUrl(
    identity: PreviewCommandTarget,
    capture: PreviewCaptureMetadata,
  ): Promise<string> {
    return this.previewCaptures.objectUrl(identity, capture);
  }

  releasePreviewCapture(identity: PreviewCommandTarget): void {
    this.previewCaptures.release(identity);
  }

  previewLaunch(intent: PreviewLaunchIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.sendCommand(
      {
        hostId: intent.hostId,
        sessionId: intent.sessionId,
        command: "preview.launch",
        args: {
          url: intent.url,
          ...(intent.authorityId === undefined ? {} : { authorityId: intent.authorityId }),
        },
      },
      options,
    );
  }

  previewState(
    hostId: string,
    sessionId: string,
    previewId?: string,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.sendCommand(
      {
        hostId,
        sessionId,
        command: "preview.state",
        args: previewId === undefined ? {} : { previewId },
      },
      options,
    );
  }

  previewActivate(
    identity: PreviewCommandTarget,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.activate", identity, {}, options);
  }

  previewNavigate(
    intent: PreviewNavigateIntent,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.sendCommand(
      {
        hostId: intent.hostId,
        sessionId: intent.sessionId,
        command: "preview.navigate",
        args: {
          previewId: intent.previewId,
          url: intent.url,
          ...(intent.leaseId === undefined ? {} : { leaseId: intent.leaseId }),
        },
      },
      options,
    );
  }

  previewBack(identity: PreviewCommandTarget, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.back", identity, {}, options);
  }

  previewForward(
    identity: PreviewCommandTarget,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.forward", identity, {}, options);
  }

  previewReload(
    identity: PreviewCommandTarget,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.reload", identity, {}, options);
  }

  previewClose(identity: PreviewCommandTarget, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.close", identity, {}, options);
  }

  previewCapture(
    identity: PreviewCommandTarget,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.capture", identity, {}, options);
  }

  previewCaptureRead(
    identity: PreviewCommandTarget,
    captureId: string,
    offset: number,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.capture.read",
      identity,
      { captureId, offset },
      options,
    );
  }

  previewClick(intent: PreviewClickIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.click",
      intent,
      {
        ...(intent.x === undefined ? {} : { x: intent.x }),
        ...(intent.y === undefined ? {} : { y: intent.y }),
        ...(intent.selector === undefined ? {} : { selector: intent.selector }),
        ...(intent.button === undefined ? {} : { button: intent.button }),
        ...(intent.clickCount === undefined ? {} : { clickCount: intent.clickCount }),
      },
      options,
    );
  }

  previewScroll(intent: PreviewScrollIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.scroll",
      intent,
      {
        deltaX: intent.deltaX,
        deltaY: intent.deltaY,
        ...(intent.selector === undefined ? {} : { selector: intent.selector }),
      },
      options,
    );
  }

  previewType(intent: PreviewTypeIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.type",
      intent,
      {
        text: intent.text,
        ...(intent.selector === undefined ? {} : { selector: intent.selector }),
      },
      options,
    );
  }

  previewPress(intent: PreviewPressIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand("preview.press", intent, { key: intent.key }, options);
  }

  previewFill(intent: PreviewFillIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.fill",
      intent,
      {
        text: intent.text,
        ...(intent.selector === undefined ? {} : { selector: intent.selector }),
      },
      options,
    );
  }

  previewSelect(intent: PreviewSelectIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.select",
      intent,
      { selector: intent.selector, value: intent.value },
      options,
    );
  }

  previewUpload(intent: PreviewUploadIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.upload",
      intent,
      { selector: intent.selector, path: intent.path },
      options,
    );
  }

  previewPolicyCheck(
    intent: PreviewPolicyCheckIntent,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.sendCommand(
      {
        hostId: intent.hostId,
        sessionId: intent.sessionId,
        command: "preview.policy.check",
        args: {
          action: intent.action,
          ...(intent.previewId === undefined ? {} : { previewId: intent.previewId }),
          ...(intent.url === undefined ? {} : { url: intent.url }),
          ...(intent.authorityId === undefined ? {} : { authorityId: intent.authorityId }),
        },
      },
      options,
    );
  }

  previewLeaseAcquire(
    identity: PreviewIdentity,
    ttlMs?: number,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.lease.acquire",
      identity,
      ttlMs === undefined ? {} : { ttlMs },
      options,
    );
  }

  previewLeaseRenew(
    identity: PreviewLeaseIdentity,
    ttlMs?: number,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    if (identity.leaseId === undefined)
      return Promise.reject(
        this.error("protocol", "preview lease renewal requires leaseId", false),
      );
    return this.previewTargetCommand(
      "preview.lease.renew",
      identity,
      { leaseId: identity.leaseId, ...(ttlMs === undefined ? {} : { ttlMs }) },
      options,
    );
  }

  previewLeaseRelease(
    identity: PreviewLeaseIdentity,
    options: CommandOptions = {},
  ): Promise<OmpResponse> {
    if (identity.leaseId === undefined)
      return Promise.reject(
        this.error("protocol", "preview lease release requires leaseId", false),
      );
    return this.previewTargetCommand(
      "preview.lease.release",
      identity,
      { leaseId: identity.leaseId },
      options,
    );
  }

  previewHandoff(intent: PreviewHandoffIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    return this.previewTargetCommand(
      "preview.handoff",
      intent,
      {
        message: intent.message,
        ...(intent.mode === undefined ? {} : { mode: intent.mode }),
        ...(intent.selector === undefined ? {} : { selector: intent.selector }),
        ...(intent.urlSubstring === undefined ? {} : { urlSubstring: intent.urlSubstring }),
        ...(intent.text === undefined ? {} : { text: intent.text }),
        ...(intent.timeoutMs === undefined ? {} : { timeoutMs: intent.timeoutMs }),
      },
      options,
    );
  }

  confirm(intent: ConfirmIntent, options: CommandOptions = {}): Promise<OmpResponse> {
    if (this.stateValue !== "ready")
      return Promise.reject(this.error("invalid_state", "client is not ready"));
    const request = this.ids.next("request");
    const message = {
      kind: "confirm",
      requestId: request,
      confirmationId: intent.confirmationId,
      commandId: intent.commandId,
      hostId: intent.hostId,
      ...(intent.sessionId === undefined ? {} : { sessionId: intent.sessionId }),
      decision: intent.decision,
    } as const satisfies PendingMessage;
    return this.sendPending(message, request, options, "confirm").then((result) => {
      if (!("ok" in result)) throw this.error("protocol", "unexpected confirmation response");
      return result;
    });
  }
  terminalInput(intent: TerminalInputIntent): void {
    this.sendTerminalFrame({ kind: "terminal-input", ...intent });
  }
  terminalResize(intent: TerminalResizeIntent): void {
    this.sendTerminalFrame({ kind: "terminal-resize", ...intent });
  }
  terminalClose(intent: TerminalCloseIntent): void {
    this.sendTerminalFrame({ kind: "terminal-close", ...intent });
  }

  pairStart(intent: PairStartIntent, options: CommandOptions = {}): Promise<OmpPairOk> {
    if (this.stateValue !== "pairing")
      return Promise.reject(this.error("invalid_state", "pairing is not required"));
    const request = this.ids.next("request");
    const message = {
      kind: "pair-start",
      requestId: request,
      code: intent.code,
      deviceId: intent.deviceId,
      deviceName: intent.deviceName,
      platform: intent.platform,
      requestedCapabilities: [...intent.requestedCapabilities],
    } as const satisfies PendingMessage;
    return this.sendPending(message, request, options, "pair").then((result) => {
      if (!("pairingId" in result)) throw this.error("protocol", "unexpected pairing response");
      return result;
    });
  }

  private previewTargetCommand(
    command: string,
    identity: PreviewCommandTarget,
    args: Record<string, unknown>,
    options: CommandOptions,
  ): Promise<OmpResponse> {
    return this.sendCommand(
      {
        hostId: identity.hostId,
        sessionId: identity.sessionId,
        command,
        args: {
          previewId: identity.previewId,
          ...(identity.leaseId === undefined ? {} : { leaseId: identity.leaseId }),
          ...args,
        },
      },
      options,
    );
  }

  private async readPreviewCapture(
    identity: PreviewCommandTarget,
    captureId: string,
    offset: number,
  ): Promise<PreviewCaptureReadResult> {
    const response = await this.previewCaptureRead(identity, captureId, offset);
    const result = response.result;
    if (!response.ok || result === null || typeof result !== "object" || Array.isArray(result))
      throw this.error("protocol", "invalid preview capture response", false, {
        command: "preview.capture.read",
      });
    const value = result as Record<string, unknown>;
    if (
      typeof value.previewId !== "string" ||
      typeof value.captureId !== "string" ||
      typeof value.size !== "number" ||
      typeof value.offset !== "number" ||
      typeof value.nextOffset !== "number" ||
      typeof value.complete !== "boolean" ||
      typeof value.content !== "string"
    ) {
      throw this.error("protocol", "invalid preview capture response", false, {
        command: "preview.capture.read",
      });
    }
    return Object.freeze({
      previewId: value.previewId,
      captureId: value.captureId,
      size: value.size,
      offset: value.offset,
      nextOffset: value.nextOffset,
      complete: value.complete,
      content: value.content,
    });
  }

  private sendCommand(intent: CommandIntent, options: CommandOptions): Promise<OmpResponse> {
    if (this.stateValue !== "ready")
      return Promise.reject(this.error("invalid_state", "client is not ready"));
    const descriptor = this.protocol.commandDescriptor(intent.command);
    if (descriptor === undefined) return Promise.reject(this.error("protocol", "unknown command"));
    const capability = this.protocol.requiredCapability(intent.command);
    if (capability !== undefined && !this.granted.has(capability)) {
      return Promise.reject(
        this.error(
          "capability",
          `${intent.command} requires negotiated capability ${capability}`,
          false,
          {
            capability,
            command: intent.command,
          },
        ),
      );
    }
    const request = this.ids.next("request");
    const command = this.ids.next("command");
    const message = {
      kind: "command",
      requestId: request,
      commandId: command,
      ...intent,
    } as const satisfies PendingMessage;
    const kind = intent.command === "session.attach" ? "attach" : "command";
    return this.sendPending(message, request, options, kind, intent).then((result) => {
      if (!("ok" in result)) throw this.error("protocol", "unexpected command response");
      return result;
    });
  }
  private sendTerminalFrame(
    message: Extract<
      OmpClientMessage,
      { kind: "terminal-input" | "terminal-resize" | "terminal-close" }
    >,
  ): void {
    if (this.stateValue !== "ready") throw this.error("invalid_state", "client is not ready");
    const encoded = encodeOutgoingMessage(this.protocol, message);
    if (encoded === undefined) throw this.error("protocol", "invalid terminal intent");
    try {
      this.connection.send(encoded);
    } catch (error) {
      if (error instanceof OmpClientError) throw error;
      throw this.error("transport", "transport send failed", true);
    }
  }

  private sendPending(
    message: PendingMessage,
    requestText: string,
    options: CommandOptions,
    kind: Pending["kind"],
    intent?: CommandIntent,
  ): Promise<PendingResult> {
    return this.pendingRequests.begin(
      message,
      requestText,
      options,
      kind,
      intent,
      (pendingMessage, pending) => {
        const encoded = encodeOutgoingMessage(this.protocol, pendingMessage);
        if (encoded === undefined)
          throw this.error("protocol", "outbound message could not be encoded");
        try {
          pending.handedToTransport = true;
          this.connection.send(encoded);
        } catch (error) {
          pending.handedToTransport = false;
          if (error instanceof OmpClientError) throw error;
          throw this.error("transport", "transport send failed", true);
        }
      },
    );
  }

  private handleConnected(_generation: number): void {
    this.reconnectHealth.clear();
    this.fatalError = undefined;
    this.transition("connecting");
    this.transition("handshaking");
    this.sendHello();
    if (this.stateValue === "handshaking") {
      this.handshakeTimer = this.schedule(
        () => this.protocolFailure("handshake timed out"),
        this.options.handshakeTimeoutMs ?? 10_000,
      );
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
      this.protocol,
      helloOptions,
      [...this.cursorJournal.records.values()],
      (encoded) => this.connection.send(encoded),
      () => this.fatal(this.error("auth", "authentication provider failed")),
      () => this.protocolFailure("hello could not be encoded"),
      (error) => this.handleTransportError(error),
    );
  }
  private clearInbound(): void {
    this.inboundQueue.clear();
  }

  private handleRaw(raw: string | Uint8Array, generation: number): void | Promise<void> {
    if (generation !== this.generation || this.closedByUser) return;
    try {
      return this.inboundDispatcher.dispatch(
        decodeProviderServerEvent(this.protocol, raw),
        generation,
      );
    } catch (error) {
      if (generation === this.generation) this.protocolFailure(safeFrameDecodeFailure(error));
    }
  }

  private handleWelcome(event: PublicEvent<"welcome">): void {
    const frame = event.payload;
    this.clearTimer("handshakeTimer");
    if (frame.selectedProtocol !== this.protocol.protocolVersion) {
      this.fatal(this.error("protocol", "welcome protocol does not match provider"));
      return;
    }
    if (this.expectedHost !== undefined && frame.hostId !== this.expectedHost) {
      this.fatal(this.error("protocol", "welcome host does not match target"));
      return;
    }
    if (this.epochValue !== undefined && this.epochValue !== frame.epoch) {
      this.cursorJournal.resetForEpoch(frame.epoch);
      this.cursorValue = undefined;
      this.desyncedSessions.clear();
    }
    this.authenticationValue = frame.authentication;
    this.epochValue = frame.epoch;
    this.granted = new Set(frame.grantedCapabilities);
    if (frame.authentication === "pairing-required") {
      this.reconnectHealth.beginWelcome(this.generation, []);
      this.transition("pairing");
      this.startHeartbeat();
      this.publish(event);
      for (const waiter of this.connectWaiters.splice(0)) waiter.resolve();
      return;
    }
    this.reconnectHealth.beginWelcome(this.generation, this.attached.keys());
    for (const feature of this.options.requiredFeatures ?? []) {
      if (!frame.grantedFeatures.includes(feature)) {
        this.fatal(
          this.error("capability", "required feature was not granted", false, { feature }),
        );
        return;
      }
    }
    this.transition("ready");
    this.startHeartbeat();
    this.publish(event);
    for (const waiter of this.connectWaiters.splice(0)) waiter.resolve();
    this.reattachSessions();
  }

  private acceptSnapshot(event: PublicEvent<"snapshot">): void {
    const frame = event.payload;
    const currentKey = sessionKey(String(frame.hostId), String(frame.sessionId));
    const recovery = this.attachmentRecoveries.get(currentKey);
    if (recovery?.generation === this.generation && recovery.awaitsSnapshot) {
      this.attachmentRecoveries.delete(currentKey);
    }
    // Inbound dispatch is generation-scoped and ordered, so a snapshot from the
    // current transport is authoritative even when its cursor is equal to or
    // below the durable journal. The journal can outlive renderer state, and a
    // host may rebuild a transient session projection within the same epoch.
    this.desyncedSessions.delete(currentKey);
    this.epochValue = frame.cursor.epoch;
    this.cursorValue = frame.cursor;
    this.cursorJournal.remember({
      hostId: String(frame.hostId),
      sessionId: String(frame.sessionId),
      cursor: frame.cursor,
    }, true);
    this.reconnectHealth.acceptReplayProgress(this.generation, currentKey, frame.cursor, true);
    this.publish(event);
  }

  private acceptDurable(event: DurableEvent): boolean {
    const frame = event.payload;
    const currentKey = `${String(frame.hostId)}\u0000${String(frame.sessionId)}`;
    const previous = this.cursorJournal.bySession.get(currentKey);
    if (previous === undefined) {
      if (this.desyncedSessions.has(currentKey)) return false;
      this.cursorValue = frame.cursor;
      this.epochValue = frame.cursor.epoch;
      this.cursorJournal.remember({
        hostId: String(frame.hostId),
        sessionId: String(frame.sessionId),
        cursor: frame.cursor,
      });
      this.reconnectHealth.acceptReplayProgress(this.generation, currentKey, frame.cursor, false);
      return true;
    }
    if (frame.cursor.epoch !== previous.epoch) {
      this.markDesynced(currentKey, "cursor epoch changed without a snapshot");
      return false;
    }
    if (frame.cursor.seq <= previous.seq) return false;
    if (frame.cursor.seq !== previous.seq + 1 || this.desyncedSessions.has(currentKey)) {
      this.markDesynced(currentKey, "durable cursor is not contiguous", {
        expectedSeq: previous.seq + 1,
        receivedSeq: frame.cursor.seq,
      });
      return false;
    }
    this.cursorValue = frame.cursor;
    this.epochValue = frame.cursor.epoch;
    this.cursorJournal.remember({
      hostId: String(frame.hostId),
      sessionId: String(frame.sessionId),
      cursor: frame.cursor,
    });
    this.reconnectHealth.acceptReplayProgress(this.generation, currentKey, frame.cursor, false);
    return true;
  }

  private handleResponse(event: PublicEvent<"response">): void {
    const frame = event.payload;
    handleResponseFrame(this.pendingRequests, frame, {
      protocolFailure: (message) => this.protocolFailure(message),
      publish: () => this.publish(event),
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

  private async handlePairOk(
    event: OmpServerEventOf<"pair.ok">,
    generation: number,
  ): Promise<void> {
    const frame = event.payload;
    if (generation !== this.generation || this.closedByUser) return;
    const pending = this.pendingRequests.entries.get(String(frame.requestId));
    if (pending === undefined || pending.kind !== "pair" || pending.message.kind !== "pair-start") {
      this.protocolFailure("unexpected pairing response");
      return;
    }
    const requested = new Set(pending.message.requestedCapabilities);
    if (
      frame.deviceId !== pending.message.deviceId ||
      frame.deviceName !== pending.message.deviceName ||
      frame.platform !== pending.message.platform ||
      frame.requestedCapabilities.some((cap) => !requested.has(cap)) ||
      frame.grantedCapabilities.some((cap) => !requested.has(cap)) ||
      !Number.isFinite(Date.parse(frame.expiresAt)) ||
      Date.parse(frame.expiresAt) <= this.clock.now()
    ) {
      this.fatal(this.error("auth", "pairing response validation failed"));
      return;
    }
    try {
      if (this.options.privilegedPairResult === undefined)
        throw new Error("pairing sink unavailable");
      await this.options.privilegedPairResult(frame);
    } catch {
      if (generation === this.generation && !this.closedByUser)
        this.fatal(this.error("auth", "pairing credential could not be stored"));
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
  private settlePairError(event: OmpServerEventOf<"pair.error">): void {
    const frame = event.payload;
    const id = String(frame.requestId);
    const pending = this.pendingRequests.entries.get(id);
    if (pending?.kind === "pair")
      this.pendingRequests.settle(
        id,
        undefined,
        this.error("auth", "pairing request failed", false, { code: frame.code }),
      );
  }

  private handleDisconnect(code?: number, reason?: string): void {
    this.previewLeaseManager.invalidateAll();
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
    } else if (code === 1008) {
      this.fatal(this.error("auth", reason?.trim() || "Host rejected the protocol session."));
      return;
    } else if (code === 1002) {
      this.fatal(this.error("protocol", reason?.trim() || "Host rejected the protocol session."));
      return;
    }
    this.clearTimer("handshakeTimer");
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.connection.disconnect();
    for (const [id, pending] of this.pendingRequests.entries) {
      if (pending.handedToTransport) {
        this.pendingRequests.settle(
          id,
          undefined,
          this.error(
            "outcome_unknown",
            "request outcome is unknown; inspect server state before retrying",
            true,
            pending.commandId === undefined ? undefined : { commandId: pending.commandId },
          ),
        );
      } else {
        this.pendingRequests.settle(
          id,
          undefined,
          this.error("transport", "transport disconnected before request was sent", true),
        );
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
    const generation = this.generation;
    for (const record of this.attached.values()) {
      const key = sessionKey(String(record.hostId), String(record.sessionId));
      const cursor = this.cursorJournal.records.get(key)?.cursor;
      const recovery = this.sendCommand(
        {
          hostId: String(record.hostId),
          sessionId: String(record.sessionId),
          command: "session.attach",
          args: cursor === undefined ? {} : { cursor },
        },
        { timeoutMs: this.options.commandTimeoutMs ?? 30_000 },
      );
      const state = { generation, promise: recovery, awaitsSnapshot: cursor === undefined };
      this.attachmentRecoveries.set(key, state);
      void recovery.then(
        (response) => {
          if (response.ok) {
            this.requestSessionState(record, generation);
            this.requestPreviewState(record, generation);
            if (!state.awaitsSnapshot && this.attachmentRecoveries.get(key) === state) {
              this.attachmentRecoveries.delete(key);
            }
          } else {
            if (this.attachmentRecoveries.get(key) === state) this.attachmentRecoveries.delete(key);
            this.emitRecoveryFailure("session.attach");
          }
        },
        (error: unknown) => {
          if (this.attachmentRecoveries.get(key) === state) this.attachmentRecoveries.delete(key);
          this.emitRecoveryError(error, "session.attach");
        },
      );
    }
  }

  private requestSessionState(
    record: { readonly hostId: HostId; readonly sessionId: SessionId },
    generation: number,
  ): void {
    if (
      generation !== this.generation ||
      this.stateValue !== "ready" ||
      !this.granted.has("sessions.read")
    )
      return;
    if (this.sessionStateGeneration !== generation) {
      this.sessionStateGeneration = generation;
      this.sessionStateSessions.clear();
    }
    const key = sessionKey(String(record.hostId), String(record.sessionId));
    if (this.sessionStateSessions.has(key)) return;
    this.sessionStateSessions.add(key);
    void this.sendCommand(
      {
        hostId: String(record.hostId),
        sessionId: String(record.sessionId),
        command: "session.state.get",
        args: {},
      },
      {},
    )
      .then((response) => {
        if (!response.ok && response.error?.code !== "unsupported")
          this.emitRecoveryFailure("session.state.get");
      })
      .catch((error: unknown) => this.emitRecoveryError(error, "session.state.get"));
  }

  private requestPreviewState(
    record: { readonly hostId: HostId; readonly sessionId: SessionId },
    generation: number,
  ): void {
    if (
      generation !== this.generation ||
      this.stateValue !== "ready" ||
      !this.granted.has("preview.read")
    )
      return;
    if (this.previewStateGeneration !== generation) {
      this.previewStateGeneration = generation;
      this.previewStateSessions.clear();
    }
    const key = sessionKey(String(record.hostId), String(record.sessionId));
    if (this.previewStateSessions.has(key)) return;
    this.previewStateSessions.add(key);
    void this.previewState(String(record.hostId), String(record.sessionId))
      .then((response) => {
        if (!response.ok) this.emitRecoveryFailure("preview.state");
      })
      .catch((error: unknown) => this.emitRecoveryError(error, "preview.state"));
  }

  private emitRecoveryFailure(command: string): void {
    this.emitError(this.error("protocol", `${command} recovery request failed`, true, { command }));
  }

  private emitRecoveryError(error: unknown, command: string): void {
    this.emitError(
      error instanceof OmpClientError
        ? error
        : this.error("transport", `${command} recovery request failed`, true, { command }),
    );
  }

  private startHeartbeat(): void {
    this.heartbeatNonce = undefined;
    this.connection.startHeartbeat(
      () => this.stateValue === "ready" || this.stateValue === "pairing",
      () => {
        const nonce = this.ids.next("ping");
        this.heartbeatNonce = nonce;
        const encoded = encodeOutgoingMessage(this.protocol, {
          kind: "ping",
          nonce,
          timestamp: new Date(this.clock.now()).toISOString(),
        });
        try {
          if (encoded === undefined) throw new Error("invalid ping");
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

  private markDesynced(
    key: string,
    message: string,
    metadata?: Record<string, string | number | boolean>,
  ): void {
    if (!this.desyncedSessions.has(key))
      this.emitError(this.error("desync", message, true, metadata));
    this.desyncedSessions.add(key);
  }

  private protocolFailure(message: string): void {
    this.fatal(this.error("protocol", message));
  }

  private fatal(error: OmpClientError): void {
    this.emitError(error);
    this.fatalError = error;
    this.closedByUser = true;
    this.clearInbound();
    this.heartbeatNonce = undefined;
    this.reconnectHealth.clear();
    this.clearAllTimers();
    this.pendingRequests.rejectAll(error);
    for (const waiter of this.connectWaiters.splice(0)) waiter.reject(error);
    this.connection.disconnect();
    this.previewCaptures.dispose();
    if (this.stateValue !== "fatal" && this.stateValue !== "closed") this.transition("fatal");
  }

  private inboundIsStale(): boolean {
    if (this.lastInboundAt === undefined) return true;
    const configured = this.options.wakeStaleAfterMs;
    const fallback =
      (this.options.heartbeat?.intervalMs ?? 15_000) + (this.options.heartbeat?.timeoutMs ?? 5_000);
    const staleAfter =
      configured !== undefined && Number.isFinite(configured) && configured > 0
        ? configured
        : fallback;
    return this.clock.now() - this.lastInboundAt >= staleAfter;
  }

  private reviveRetryableTransportFailure(): void {
    if (
      this.stateValue !== "fatal" ||
      this.fatalError?.code !== "transport" ||
      !this.fatalError.retryable
    )
      return;
    this.closedByUser = false;
    this.fatalError = undefined;
    this.transition("connecting");
    this.connection.begin();
  }

  private error(
    code: ClientErrorCode,
    message: string,
    retryable = false,
    metadata?: Record<string, string | number | boolean>,
  ): OmpClientError {
    return new OmpClientError({
      code,
      message,
      retryable,
      ...(metadata === undefined ? {} : { metadata: boundedMetadata(metadata) }),
    });
  }
  private publish(event: PublicOmpServerEvent): void {
    this.events.publish(event, this.projection);
    if (this.projection === undefined) return;
    const retained: PreviewCommandTarget[] = [];
    for (const session of this.projection.snapshot.sessions.values())
      for (const preview of session.previews.values()) {
        const identity = {
          hostId: preview.hostId,
          sessionId: preview.sessionId,
          previewId: preview.previewId,
        };
        retained.push(identity);
        this.previewCaptures.replace(identity, preview.capture);
      }
    this.previewCaptures.retain(retained);
  }

  private emitError(error: OmpClientError): void {
    this.events.emitError(error);
  }
  private emitState(): void {
    this.events.emitState(this.snapshot());
  }

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
