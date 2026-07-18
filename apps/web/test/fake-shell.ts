// Concrete fake DesktopShellPort for live-runtime behavior tests: a typed,
// in-memory desktop backend the real DesktopRuntimeController runs against.
// Every knob is explicit — command verdicts, deferred round-trips, service
// inspection results — so tests exercise the real controller/runtime code
// paths with no mocking framework and no invented frames.
import type { DesktopRuntimeController, DesktopShellPort } from "@t4-code/client";
import { hostId, type WelcomeFrame } from "@t4-code/protocol";
import { rendererServerEventFromFrame } from "@t4-code/protocol/desktop-ipc";
import type {
  BootstrapResult,
  CommandRequest,
  CommandResult,
  CommandResultError,
  ConfirmRequest,
  ConfirmResult,
  ConnectionStateEvent,
  ConnectResult,
  DesktopTarget,
  DisconnectResult,
  PairRequest,
  PairResult,
  RendererServerEventEnvelope,
  RendererServerFrame,
  RuntimeErrorEvent,
  ServiceActionResult,
  ServiceInspection,
  TargetAddRequest,
  TargetAddResult,
  TargetListResult,
  TargetRemoveResult,
  TargetRequest,
  TerminalCloseRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalResult,
} from "@t4-code/protocol/desktop-ipc";

interface TestServerFrameEnvelope {
  readonly targetId: string;
  readonly frame: RendererServerFrame;
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function makeTarget(targetId: string, state: DesktopTarget["state"] = "disconnected"): DesktopTarget {
  return {
    targetId,
    label: targetId === "local" ? "This machine" : targetId,
    kind: targetId === "local" ? "local" : "remote",
    state,
    paired: true,
  };
}

export function makeWelcome(
  host: string,
  capabilities: readonly string[],
  features: readonly string[] = [],
): WelcomeFrame {
  return {
    v: "omp-app/1",
    type: "welcome",
    selectedProtocol: "omp-app/1",
    hostId: hostId(host),
    ompVersion: "omp-test",
    ompBuild: "test",
    appserverVersion: "app-test",
    appserverBuild: "test",
    epoch: "epoch-1",
    grantedCapabilities: [...capabilities],
    grantedFeatures: [...features],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

/** How the fake answers the next `command` calls. */
export type CommandBehavior =
  | { readonly kind: "accept" }
  | { readonly kind: "reject"; readonly error?: CommandResultError }
  | { readonly kind: "throw" }
  | { readonly kind: "defer"; readonly gate: Deferred<boolean> };

export class FakeShell implements DesktopShellPort {
  readonly kind = "desktop" as const;
  readonly platform = "linux" as const;

  readonly commands: CommandRequest[] = [];
  readonly confirms: ConfirmRequest[] = [];
  commandBehavior: CommandBehavior = { kind: "accept" };
  commandResult: ((request: CommandRequest) => unknown) | undefined;
  confirmBehavior: CommandBehavior = { kind: "accept" };
  bootstrapError: Error | null = null;
  bootstrapCalls = 0;
  connectCalls = 0;
  inspectCalls = 0;
  installCalls = 0;
  startCalls = 0;
  inspection: ServiceInspection = { definition: "current", service: "running", diagnostics: "" };
  inspectionError: Error | null = null;
  serviceStartError: Error | null = null;

  private readonly serverEvents = new Set<(event: RendererServerEventEnvelope) => void>();
  private readonly states = new Set<(event: ConnectionStateEvent) => void>();
  private readonly errors = new Set<(event: RuntimeErrorEvent) => void>();

  async bootstrap(): Promise<BootstrapResult> {
    this.bootstrapCalls += 1;
    if (this.bootstrapError !== null) throw this.bootstrapError;
    return { platform: "linux", version: "omp-app/1", connected: false };
  }
  async listTargets(): Promise<TargetListResult> {
    return { targets: Object.freeze([makeTarget("local")]) };
  }
  async connectTarget(request: TargetRequest): Promise<ConnectResult> {
    this.connectCalls += 1;
    this.emitState({ targetId: request.targetId, state: "connected" });
    return { targetId: request.targetId, state: "connected" };
  }
  async connect(request: TargetRequest): Promise<ConnectResult> {
    return this.connectTarget(request);
  }
  async disconnectTarget(request: TargetRequest): Promise<DisconnectResult> {
    return { targetId: request.targetId, state: "disconnected" };
  }
  async disconnect(request: TargetRequest): Promise<DisconnectResult> {
    return this.disconnectTarget(request);
  }
  async command(request: CommandRequest): Promise<CommandResult> {
    this.commands.push(request);
    const behavior = this.commandBehavior;
    const accepted = await this.settle(behavior, "command unreachable");
    const result = accepted ? this.commandResult?.(request) : undefined;
    return {
      targetId: request.targetId,
      requestId: `req-${this.commands.length}`,
      commandId: `cmd-${this.commands.length}`,
      accepted,
      ...(behavior.kind === "reject" && behavior.error !== undefined
        ? { error: behavior.error }
        : {}),
      ...(result === undefined ? {} : { result }),
      ...(request.intent.command === "prompt.lease.acquire" ? { leaseId: "prompt-lease-fixture" } : {}),
      ...(request.intent.command === "controller.lease.acquire"
        ? { leaseId: "controller-lease-fixture", expiresAt: "2999-01-01T00:00:00.000Z" }
        : {}),
    } as CommandResult;
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    this.confirms.push(request);
    const accepted = await this.settle(this.confirmBehavior, "confirm unreachable");
    return {
      targetId: request.targetId,
      requestId: `confirm-req-${this.confirms.length}`,
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted,
    };
  }
  async pair(request: PairRequest): Promise<PairResult> {
    return { targetId: request.targetId, paired: true };
  }
  async addTarget(request: TargetAddRequest): Promise<TargetAddResult> {
    return { target: makeTarget(request.target.targetId) };
  }
  async removeTarget(request: TargetRequest): Promise<TargetRemoveResult> {
    return { targetId: request.targetId, removed: true };
  }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> {
    return { targetId: request.targetId, accepted: true };
  }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> {
    return { targetId: request.targetId, accepted: true };
  }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> {
    return { targetId: request.targetId, accepted: true };
  }
  serviceInspect = async (): Promise<ServiceInspection> => {
    this.inspectCalls += 1;
    if (this.inspectionError !== null) throw this.inspectionError;
    return this.inspection;
  };
  serviceInstall = async (): Promise<ServiceActionResult> => {
    this.installCalls += 1;
    return { completed: true };
  };
  serviceStart = async (): Promise<ServiceActionResult> => {
    this.startCalls += 1;
    if (this.serviceStartError !== null) throw this.serviceStartError;
    return { completed: true };
  };

  onServerEvent(listener: (event: RendererServerEventEnvelope) => void): () => void {
    this.serverEvents.add(listener);
    return () => this.serverEvents.delete(listener);
  }
  onConnectionState(listener: (event: ConnectionStateEvent) => void): () => void {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  onRuntimeError(listener: (event: RuntimeErrorEvent) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }

  emitFrame(event: TestServerFrameEnvelope): void {
    const envelope = {
      targetId: event.targetId,
      event: rendererServerEventFromFrame(event.frame),
    };
    for (const listener of this.serverEvents) listener(envelope);
  }
  emitState(event: ConnectionStateEvent): void {
    for (const listener of this.states) listener(event);
  }
  emitError(event: RuntimeErrorEvent): void {
    for (const listener of this.errors) listener(event);
  }
  /** Count of prompt-shaped commands the backend actually received. */
  commandCount(command: string): number {
    return this.commands.filter((request) => request.intent.command === command).length;
  }

  private async settle(behavior: CommandBehavior, throwMessage: string): Promise<boolean> {
    if (behavior.kind === "accept") return true;
    if (behavior.kind === "reject") return false;
    if (behavior.kind === "throw") throw new Error(throwMessage);
    return behavior.gate.promise;
  }
}

export function bindProjectionInventoryResults(
  shell: FakeShell,
  controller: DesktopRuntimeController,
): void {
  const fallback = shell.commandResult;
  let sequence = 0;
  shell.commandResult = (request) => {
    if (request.intent.command !== "session.list" && request.intent.command !== "host.list") {
      return fallback?.(request);
    }
    const requestedHost = String(request.intent.hostId);
    const sessions = [...controller.getSnapshot().projection.sessionIndex.values()].filter(
      (session) => String(session.hostId) === requestedHost,
    );
    sequence += 1;
    return {
      cursor: { epoch: "session-index-1", seq: sequence },
      sessions,
      totalCount: sessions.length,
      truncated: false,
    };
  };
}
