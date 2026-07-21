import { clusterOperatorRequestedCapabilities, clusterOperatorRequestedFeatures, createOmpClient, isConfirmationDecisionConsumed, OmpClientError, type CommandIntent, type CursorStore, type OmpClient, type OmpPairOk, type PublicOmpServerEvent } from "@t4-code/client";
import { commandResultError, type CommandResult, type ConnectionStateEvent, type RuntimeErrorEvent } from "@t4-code/protocol/desktop-ipc";
import type { ConfirmRequest, ConfirmResult, TerminalCloseRequest, TerminalInputRequest, TerminalResizeRequest, TerminalResult } from "@t4-code/protocol/desktop-ipc";
import { ADDITIVE_FEATURES, DEVICE_CAPABILITIES, type DeviceCapability } from "@t4-code/protocol";
import { createLocalTransport, type UnixWebSocketTransport } from "./transport.ts";
import { createRemoteWebSocketTransport, type RemoteWebSocketTransport } from "./remote-runtime/transport.ts";
import { validateRemoteTarget, type CredentialStore, type PublicRemoteTarget, type RemoteTargetRecord, type RemoteTargetRegistry } from "./remote-runtime/registry.ts";
import { DEFAULT_LOCAL_PROFILE, localTargetId, type LocalProfileRecord } from "./local-profiles.ts";
const DEFAULT_CAPABILITIES: readonly DeviceCapability[] = Object.freeze([...DEVICE_CAPABILITIES]);
const REQUESTED_FEATURES: readonly string[] = ADDITIVE_FEATURES;

export type DesktopTargetState = "disconnected" | "connecting" | "connected" | "pairing-required" | "error";
export interface PublicDesktopTarget {
  readonly targetId: string;
  readonly label: string;
  readonly kind: "local" | "remote";
  readonly state: DesktopTargetState;
  readonly paired: boolean;
  readonly mode?: "direct" | "serve";
  readonly status?: "unknown" | "online" | "offline" | "revoked";
}
export interface TargetManagerEvents {
  readonly onEvent: (targetId: string, event: PublicOmpServerEvent) => void;
  readonly onState: (event: ConnectionStateEvent) => void;
  readonly onError: (event: RuntimeErrorEvent) => void;
  readonly onTargets?: (targets: readonly PublicDesktopTarget[]) => void;
}
export interface TargetManagerOptions {
  readonly cursorStore: CursorStore;
  readonly cursorStoreFactory?: (targetId: string) => CursorStore;
  readonly events: TargetManagerEvents;
  readonly localProfiles?: () => Promise<readonly LocalProfileRecord[]>;
  readonly localTransportFactory?: (profileId: string) => UnixWebSocketTransport;
  /** Legacy default-local transport hook. */
  readonly transportFactory?: () => UnixWebSocketTransport;
  readonly remoteTransportFactory?: (target: RemoteTargetRecord) => RemoteWebSocketTransport;
  readonly registry?: RemoteTargetRegistry;
  readonly credentials?: CredentialStore;
  readonly capabilities?: readonly DeviceCapability[];
  readonly deviceId?: string;
  readonly deviceName?: string;
  readonly clusterOperatorEnabled?: boolean;
}
type Transport = UnixWebSocketTransport | RemoteWebSocketTransport;
interface Runtime {
  readonly generation: number;
  readonly client: OmpClient;
  readonly requestedCapabilities: readonly string[];
  paired: boolean;
}
interface ConnectAttempt {
  readonly result: Promise<"connecting" | "connected">;
}
function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((capability, index) => capability === right[index]);
}
function enqueue<T>(queue: { tail: Promise<void> }, operation: () => Promise<T>): Promise<T> {
  const result = queue.tail.then(operation, operation);
  queue.tail = result.then(() => undefined, () => undefined);
  return result;
}
function enqueueTarget<T>(queues: Map<string, { tail: Promise<void> }>, targetId: string, operation: () => Promise<T>): Promise<T> {
  let queue = queues.get(targetId);
  if (queue === undefined) {
    queue = { tail: Promise.resolve() };
    queues.set(targetId, queue);
  }
  return enqueue(queue, operation);
}
function safeError(error: unknown): { readonly code: RuntimeErrorEvent["code"]; readonly message: string } {
  if (error instanceof OmpClientError) return { code: error.code === "protocol" ? "protocol" : "transport", message: error.message };
  return { code: "transport", message: "target operation failed" };
}

function safePublicEvent(event: PublicOmpServerEvent): PublicOmpServerEvent {
  if (event.kind !== "response" || event.payload.error === undefined) return event;
  const error = commandResultError(event.payload.error) ?? {
    code: "internal",
    message: "command failed",
  };
  return Object.freeze({
    ...event,
    payload: Object.freeze({ ...event.payload, error }),
  }) as PublicOmpServerEvent;
}

export class DesktopTargetManager {
  private readonly cursorStore: CursorStore;
  private readonly cursorStoreFactory: (targetId: string) => CursorStore;
  private readonly events: TargetManagerEvents;
  private readonly localProfiles: () => Promise<readonly LocalProfileRecord[]>;
  private readonly localTransportFactory: (profileId: string) => UnixWebSocketTransport;
  private readonly remoteTransportFactory: (target: RemoteTargetRecord) => RemoteWebSocketTransport;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly capabilities: readonly DeviceCapability[];
  private readonly clusterOperatorEnabled: boolean;
  private readonly requestedFeatures: readonly string[];
  private readonly compatibilityRequestedFeatures: readonly string[];
  private readonly connectAttempts = new Map<string, { readonly generation: number; readonly result: Promise<"connecting" | "connected"> }>();
  private readonly registryQueue = { tail: Promise.resolve() };
  private readonly targetQueues = new Map<string, { tail: Promise<void> }>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly localStates = new Map<string, DesktopTargetState>();
  private closed = false;
  private readonly generations = new Map<string, number>();
  private readonly latestWelcomes = new Map<
    string,
    Extract<PublicOmpServerEvent, { kind: "welcome" }>
  >();
  private readonly registry: RemoteTargetRegistry | undefined;
  private readonly credentials: CredentialStore | undefined;

  constructor(options: TargetManagerOptions) {
    this.cursorStore = options.cursorStore;
    this.cursorStoreFactory = options.cursorStoreFactory ?? (() => this.cursorStore);
    this.events = options.events;
    this.localProfiles = options.localProfiles ?? (() => Promise.resolve([DEFAULT_LOCAL_PROFILE]));
    this.localTransportFactory = options.localTransportFactory ?? (
      options.transportFactory === undefined
        ? (profileId) => createLocalTransport(profileId)
        : () => options.transportFactory!()
    );
    this.remoteTransportFactory = options.remoteTransportFactory ?? ((target) => createRemoteWebSocketTransport({ target }));
    this.registry = options.registry;
    this.deviceId = options.deviceId ?? "desktop";
    this.credentials = options.credentials;
    this.clusterOperatorEnabled = options.clusterOperatorEnabled === true;
    this.capabilities = this.effectiveCapabilities(
      options.capabilities ?? DEFAULT_CAPABILITIES,
    ) as readonly DeviceCapability[];
    this.requestedFeatures = clusterOperatorRequestedFeatures(
      REQUESTED_FEATURES,
      this.clusterOperatorEnabled,
    );
    this.compatibilityRequestedFeatures = Object.freeze(
      this.requestedFeatures.filter(
        (feature) => feature !== "prompt.images" && feature !== "transcript.images",
      ),
    );
    this.deviceName = options.deviceName ?? "T4 Code Desktop";
  }

  isConnected(targetId = "local"): boolean { return this.runtimes.get(targetId)?.client.state === "ready"; }
  isPaired(targetId: string): boolean { return this.runtimes.get(targetId)?.paired ?? (localProfileId(targetId) !== undefined); }
  pairingStatus(targetId: string): { readonly targetId: string; readonly state: DesktopTargetState; readonly paired: boolean } {
    const runtime = this.runtimes.get(targetId);
    if (localProfileId(targetId) !== undefined)
      return { targetId, state: this.localStates.get(targetId) ?? "disconnected", paired: true };
    const state = runtime === undefined ? "disconnected" : this.stateFor(runtime.client.state);
    return { targetId, state, paired: runtime?.paired ?? false };
  }
  async listTargets(): Promise<readonly PublicDesktopTarget[]> {
    const remote = this.registry === undefined ? [] : await this.registry.list();
    const profiles = await this.localProfiles();
    const local = profiles.map((profile): PublicDesktopTarget => {
      const targetId = localTargetId(profile.profileId);
      return {
        targetId,
        label: profile.profileId === "default" ? "Local OMP" : profile.label,
        kind: "local",
        state: this.localStates.get(targetId) ?? "disconnected",
        paired: true,
      };
    });
    const targets = [...local, ...remote.map((target) => this.publicTarget(target))];
    this.events.onTargets?.(targets);
    return targets;
  }
  async addRemoteTarget(input: RemoteTargetRecord): Promise<PublicDesktopTarget> {
    return enqueue(this.registryQueue, async () => {
      if (this.registry === undefined) throw new Error("remote targets are unavailable");
      const target = validateRemoteTarget(input);
      await this.registry.put(target);
      const result = this.publicTarget(target);
      void this.listTargets().catch(() => undefined);
      return result;
    });
  }
  async removeTarget(targetId: string): Promise<void> {
    return enqueueTarget(this.targetQueues, targetId, async () => {
      if (localProfileId(targetId) !== undefined) throw new Error("local target cannot be removed");
      await this.closeRuntime(targetId);
      if (this.credentials !== undefined) await this.credentials.revoke(targetId);
      await enqueue(this.registryQueue, async () => { if (this.registry !== undefined) await this.registry.remove(targetId); });
      this.targetQueues.delete(targetId);
    });
  }
  async connect(targetId = "local"): Promise<"connecting" | "connected"> {
    const attempt = await enqueueTarget(this.targetQueues, targetId, async () => this.connectNow(targetId));
    return attempt.result;
  }
  async disconnect(targetId = "local"): Promise<void> {
    return enqueueTarget(this.targetQueues, targetId, async () => {
      await this.closeRuntime(targetId);
      this.publishState(targetId, "disconnected");
    });
  }
  async pairStart(targetId: string, code: string): Promise<{ readonly targetId: string; readonly paired: boolean }> {
    return enqueueTarget(this.targetQueues, targetId, async () => {
      if (localProfileId(targetId) === undefined) {
        const remote = await this.remoteTarget(targetId);
        const effectiveCapabilities = this.effectiveCapabilities(remote.requestedCapabilities);
        const current = this.runtimes.get(targetId);
        if (
          current !== undefined &&
          !sameCapabilities(current.requestedCapabilities, effectiveCapabilities)
        ) {
          await this.closeRuntime(targetId);
          const attempt = await this.connectNow(targetId);
          await attempt.result;
        }
      }
      const runtime = this.runtimes.get(targetId);
      if (runtime === undefined || runtime.client.state !== "pairing") throw new Error("pairing is not required");
      if (this.credentials === undefined) throw new Error("remote pairing unavailable: encrypted credential storage is unavailable");
      runtime.paired = false;
      try {
        await runtime.client.pairStart({ code, deviceId: this.deviceId, deviceName: this.deviceName, platform: process.platform, requestedCapabilities: runtime.requestedCapabilities });
      } catch (error) {
        runtime.paired = false;
        throw error;
      }
      if (!runtime.paired) throw new Error("remote pairing unavailable: credential was not persisted");
      return { targetId, paired: true };
    });
  }
  async command(targetId: string, intent: CommandIntent): Promise<CommandResult>;
  async command(intent: CommandIntent): Promise<CommandResult>;
  async command(targetOrIntent: string | CommandIntent, maybeIntent?: CommandIntent): Promise<CommandResult> {
    const targetId = typeof targetOrIntent === "string" ? targetOrIntent : "local";
    const intent = typeof targetOrIntent === "string" ? maybeIntent : targetOrIntent;
    if (intent === undefined) throw new Error("command intent is required");
    const runtime = this.runtimes.get(targetId);
    if (runtime === undefined || runtime.client.state !== "ready") throw new Error("target is not connected");
    const generation = runtime.generation;
    try {
      const result = await runtime.client.command(intent);
      const error = commandResultError(result.error);
      return {
        targetId,
        requestId: String(result.requestId),
        commandId: String(result.commandId),
        accepted: result.ok,
        ...(result.result === undefined ? {} : { result: result.result }),
        ...(error === undefined ? {} : { error }),
      };
    } catch (error) {
      if (this.generations.get(targetId) !== generation && error instanceof OmpClientError && error.code === "closed")
        throw new OmpClientError({ code: "outcome_unknown", message: "request outcome is unknown; inspect server state before retrying", retryable: true });
      throw error;
    }
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult>;
  async confirm(targetId: string, request: Omit<ConfirmRequest, "targetId">): Promise<ConfirmResult>;
  async confirm(targetOrRequest: string | ConfirmRequest, maybeRequest?: Omit<ConfirmRequest, "targetId">): Promise<ConfirmResult> {
    const targetId = typeof targetOrRequest === "string" ? targetOrRequest : targetOrRequest.targetId;
    const request = typeof targetOrRequest === "string" ? maybeRequest : targetOrRequest;
    if (request === undefined) throw new Error("confirmation request is required");
    const runtime = this.runtimes.get(targetId);
    if (runtime === undefined || runtime.client.state !== "ready") throw new Error("target is not connected");
    const generation = runtime.generation;
    try {
      const result = await runtime.client.confirm({
        confirmationId: String(request.confirmationId),
        commandId: String(request.commandId),
        hostId: String(request.hostId),
        ...(request.sessionId === undefined ? {} : { sessionId: String(request.sessionId) }),
        decision: request.decision,
      });
      return {
        targetId,
        requestId: String(result.requestId),
        confirmationId: request.confirmationId,
        commandId: request.commandId,
        accepted: isConfirmationDecisionConsumed(result),
      };
    } catch (error) {
      if (this.generations.get(targetId) !== generation && error instanceof OmpClientError && error.code === "closed")
        throw new OmpClientError({ code: "outcome_unknown", message: "request outcome is unknown; inspect server state before retrying", retryable: true });
      throw error;
    }
  }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult>;
  async terminalInput(targetId: string, request: Omit<TerminalInputRequest, "targetId">): Promise<TerminalResult>;
  async terminalInput(targetOrRequest: string | TerminalInputRequest, maybeRequest?: Omit<TerminalInputRequest, "targetId">): Promise<TerminalResult> {
    const targetId = typeof targetOrRequest === "string" ? targetOrRequest : targetOrRequest.targetId;
    const request = typeof targetOrRequest === "string" ? maybeRequest : targetOrRequest;
    if (request === undefined) throw new Error("terminal input request is required");
    return this.sendTerminal(targetId, (client) => client.terminalInput({
      hostId: String(request.hostId),
      sessionId: String(request.sessionId),
      terminalId: String(request.terminalId),
      data: request.data,
      ...(request.encoding === undefined ? {} : { encoding: request.encoding }),
    }));
  }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult>;
  async terminalResize(targetId: string, request: Omit<TerminalResizeRequest, "targetId">): Promise<TerminalResult>;
  async terminalResize(targetOrRequest: string | TerminalResizeRequest, maybeRequest?: Omit<TerminalResizeRequest, "targetId">): Promise<TerminalResult> {
    const targetId = typeof targetOrRequest === "string" ? targetOrRequest : targetOrRequest.targetId;
    const request = typeof targetOrRequest === "string" ? maybeRequest : targetOrRequest;
    if (request === undefined) throw new Error("terminal resize request is required");
    return this.sendTerminal(targetId, (client) => client.terminalResize({
      hostId: String(request.hostId),
      sessionId: String(request.sessionId),
      terminalId: String(request.terminalId),
      cols: request.cols,
      rows: request.rows,
    }));
  }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult>;
  async terminalClose(targetId: string, request: Omit<TerminalCloseRequest, "targetId">): Promise<TerminalResult>;
  async terminalClose(targetOrRequest: string | TerminalCloseRequest, maybeRequest?: Omit<TerminalCloseRequest, "targetId">): Promise<TerminalResult> {
    const targetId = typeof targetOrRequest === "string" ? targetOrRequest : targetOrRequest.targetId;
    const request = typeof targetOrRequest === "string" ? maybeRequest : targetOrRequest;
    if (request === undefined) throw new Error("terminal close request is required");
    return this.sendTerminal(targetId, (client) => client.terminalClose({
      hostId: String(request.hostId),
      sessionId: String(request.sessionId),
      terminalId: String(request.terminalId),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    }));
  }
  private sendTerminal(targetId: string, operation: (client: OmpClient) => void): TerminalResult {
    const runtime = this.runtimes.get(targetId);
    if (runtime === undefined || runtime.client.state !== "ready") throw new Error("target is not connected");
    const generation = runtime.generation;
    operation(runtime.client);
    return { targetId, accepted: this.generations.get(targetId) === generation };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.runtimes.keys()].map((targetId) => enqueueTarget(this.targetQueues, targetId, async () => this.closeRuntime(targetId))));
    this.targetQueues.clear();
  }

  private effectiveCapabilities(capabilities: readonly string[]): readonly string[] {
    return Object.freeze([
      ...clusterOperatorRequestedCapabilities(capabilities, this.clusterOperatorEnabled),
    ]);
  }

  private async remoteTarget(targetId: string): Promise<RemoteTargetRecord> {
    if (this.registry === undefined) throw new Error("target not found");
    const target = await this.registry.get(targetId);
    if (target === null) throw new Error("target not found");
    return validateRemoteTarget(target);
  }
  private async connectNow(targetId: string): Promise<ConnectAttempt> {
    if (this.closed) throw new Error("target manager is closed");
    const local = await this.localProfile(targetId);
    const remote = local === undefined ? await this.remoteTarget(targetId) : undefined;
    const requestedCapabilities = this.effectiveCapabilities(
      local !== undefined ? this.capabilities : remote!.requestedCapabilities,
    );
    const existing = this.runtimes.get(targetId);
    if (existing !== undefined && sameCapabilities(existing.requestedCapabilities, requestedCapabilities)) {
      if (existing.client.state === "ready") {
        const welcome = this.latestWelcomes.get(targetId);
        if (welcome !== undefined) this.events.onEvent(targetId, welcome);
        return { result: Promise.resolve("connected") };
      }
      if (existing.client.state === "connecting" || existing.client.state === "handshaking" || existing.client.state === "pairing" || existing.client.state === "reconnect-wait") {
        const pending = this.connectAttempts.get(targetId);
        return { result: pending?.generation === existing.generation ? pending.result : Promise.resolve("connecting") };
      }
    }
    await this.closeRuntime(targetId);
    const generation = (this.generations.get(targetId) ?? 0) + 1;
    this.generations.set(targetId, generation);
    let hasCredential = false;
    if (remote !== undefined && remote !== null && this.credentials !== undefined) {
      try {
        hasCredential = this.credentials.withCredential(targetId, () => true);
      } catch {
        hasCredential = false;
      }
    }
    const transportFactory = async (): Promise<Transport> => {
      const transport = local === undefined
        ? this.remoteTransportFactory(remote!)
        : this.localTransportFactory(local.profileId);
      await transport.open();
      return transport;
    };
    const clientOptions = {
      transport: transportFactory,
      ...(remote?.expectedHostId === undefined ? {} : { hostId: remote.expectedHostId, expectedHostId: remote.expectedHostId }),
      ...(local !== undefined || this.credentials === undefined ? {} : {
        authentication: () => {
          try {
            return this.credentials!.withCredential(targetId, (value) => ({ deviceId: value.deviceId, deviceToken: value.token }));
          } catch {
            return undefined;
          }
        },
        privilegedPairResult: async (frame: OmpPairOk) => {
          await this.credentials!.set(targetId, { token: frame.deviceToken, deviceId: frame.deviceId });
          const active = this.runtimes.get(targetId);
          if (active !== undefined && active.generation === generation) active.paired = true;
        },
      }),
      cursorStore: this.cursorStoreFactory(targetId),
      capabilities: requestedCapabilities,
      requestedFeatures: this.requestedFeatures,
      compatibilityRequestedFeatures: this.compatibilityRequestedFeatures,
      client: { name: "T4 Code", version: "0.1.30", build: "desktop", platform: process.platform },
      reconnect: { baseMs: 250, maxMs: 10_000 },
    };
    const client = createOmpClient(clientOptions);
    const runtime: Runtime = { generation, client, requestedCapabilities, paired: local !== undefined || hasCredential };
    this.runtimes.set(targetId, runtime);
    client.onEvent((event) => {
      if (this.generations.get(targetId) !== generation) return;
      if (event.kind === "welcome") this.latestWelcomes.set(targetId, event);
      this.events.onEvent(targetId, safePublicEvent(event));
    });
    client.onState((snapshot) => {
      if (this.generations.get(targetId) !== generation) return;
      const state = this.stateFor(snapshot.state);
      if (local !== undefined) this.localStates.set(targetId, state);
      this.events.onState({ targetId, state });
    });
    client.onError((error) => {
      if (this.generations.get(targetId) !== generation) return;
      const safe = safeError(error);
      this.events.onError({ targetId, code: safe.code, message: safe.message });
    });
    this.publishState(targetId, "connecting");
    const result = client.connect()
      .then(() => client.state === "ready" ? "connected" as const : "connecting" as const)
      .catch((error: unknown) => {
        if (this.generations.get(targetId) === generation) {
          const safe = safeError(error);
          this.events.onError({ targetId, code: safe.code, message: safe.message });
        }
        throw error;
      });
    void result.catch(() => undefined);
    this.connectAttempts.set(targetId, { generation, result });
    void result.then(
      () => {
        if (this.connectAttempts.get(targetId)?.generation === generation) this.connectAttempts.delete(targetId);
      },
      () => {
        if (this.connectAttempts.get(targetId)?.generation === generation) this.connectAttempts.delete(targetId);
      },
    );
    return { result };
  }
  private async closeRuntime(targetId: string): Promise<void> {
    const generation = (this.generations.get(targetId) ?? 0) + 1;
    this.generations.set(targetId, generation);
    this.connectAttempts.delete(targetId);
    const runtime = this.runtimes.get(targetId);
    this.runtimes.delete(targetId);
    this.latestWelcomes.delete(targetId);
    if (runtime !== undefined) await runtime.client.close();
  }
  private publishState(targetId: string, state: DesktopTargetState): void {
    if (localProfileId(targetId) !== undefined) this.localStates.set(targetId, state);
    this.events.onState({ targetId, state });
  }
  private stateFor(state: OmpClient["state"]): DesktopTargetState {
    if (state === "ready") return "connected";
    if (state === "pairing") return "pairing-required";
    if (state === "connecting" || state === "handshaking" || state === "reconnect-wait") return "connecting";
    if (state === "fatal") return "error";
    return "disconnected";
  }
  private publicTarget(target: PublicRemoteTarget): PublicDesktopTarget {
    const runtime = this.runtimes.get(target.targetId);
    return {
      targetId: target.targetId,
      label: target.label,
      kind: "remote",
      state: runtime === undefined ? "disconnected" : this.stateFor(runtime.client.state),
      paired: runtime?.paired ?? false,
      mode: target.mode,
      status: target.status,
    };
  }

  private async localProfile(targetId: string): Promise<LocalProfileRecord | undefined> {
    const profileId = localProfileId(targetId);
    if (profileId === undefined) return undefined;
    const profile = (await this.localProfiles()).find((record) => record.profileId === profileId);
    if (profile === undefined) throw new Error("target not found");
    return profile;
  }
}

function localProfileId(targetId: string): string | undefined {
  if (targetId === "local") return "default";
  if (!targetId.startsWith("local:")) return undefined;
  const profileId = targetId.slice("local:".length);
  try {
    return localTargetId(profileId) === targetId ? profileId : undefined;
  } catch {
    return undefined;
  }
}
export { DesktopTargetManager as LocalTargetManager };
