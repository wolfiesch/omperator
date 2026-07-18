import {
  decodeDesktopEvent,
  rendererServerEventFromFrame,
  type BootstrapResult,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConnectionStateEvent,
  type ConnectResult,
  type DisconnectResult,
  type DesktopTarget,
  type PairResult,
  type RendererServerEvent,
  type RendererServerEventEnvelope,
  type RuntimeErrorEvent,
  type TargetAddRequest,
  type TargetListResult,
  type TargetRemoveResult,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
import { decodeCatalog, decodeSessions, hostId, revision, sessionId, type CatalogFrame, type Cursor, type SettingsFrame } from "@t4-code/protocol";
import type { Unsubscribe } from "./index.ts";
import { ProjectionStore } from "./projection.ts";
import {
  DesktopRuntimeError,
  asRecord,
  freezeClone,
  mapValue,
  redactedMessage,
  targetCopy,
  type DesktopControllerLease,
  type DesktopControllerLeaseAcquireResult,
  type DesktopControllerLeaseOperationResult,
  type DesktopHostMetadata,
  type DesktopRuntimeErrorEntry,
  type DesktopRuntimeOptions,
  type DesktopRuntimeSnapshot,
  type DesktopRuntimeSnapshotListener,
  type DesktopRuntimeTimerScheduler,
  type DesktopServerEventFilter,
  type DesktopServerEventSubscription,
  type DesktopShellPort,
  type DesktopWelcomePayload,
} from "./desktop-runtime-contracts.ts";
import { DesktopRuntimeHostState } from "./desktop-runtime-hosts.ts";
import { boundedText, commandFailure, DEFAULT_MAX_RUNTIME_ERRORS, leasePayload, type DesktopControllerLeaseEntry } from "./desktop-runtime-policy.ts";
import { bootstrapDesktopHost } from "./desktop-runtime-bootstrap.ts";
import { PromptLeaseStore } from "./prompt-lease.ts";
import {
  sanitizeRetainedTranscriptEvent,
  type RetainedTranscriptEvent,
} from "./transcript-retention.ts";
export { DesktopRuntimeError } from "./desktop-runtime-contracts.ts";
export type {
  DesktopControllerLease,
  DesktopControllerLeaseAcquireResult,
  DesktopControllerLeaseOperationResult,
  DesktopControllerLeaseOptions,
  DesktopControllerLeaseResult,
  DesktopHostMetadata,
  DesktopRuntimeErrorEntry,
  DesktopRuntimeOptions,
  DesktopRuntimeSnapshot,
  DesktopRuntimeSnapshotListener,
  DesktopRuntimeStartState,
  DesktopRuntimeTimerScheduler,
  DesktopServerEventFilter,
  DesktopServerEventSubscription,
  DesktopShellPort,
} from "./desktop-runtime-contracts.ts";
export const DEFAULT_SESSION_INVENTORY_REFRESH_MS = 20_000;
const defaultTimerScheduler: DesktopRuntimeTimerScheduler = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
    return timer;
  },
  clearTimeout: (handle) => {
    if (typeof handle === "number") clearTimeout(handle);
    else clearTimeout(handle as NodeJS.Timeout);
  },
};
const noop = (): void => undefined;
interface DesktopTargetIdentity {
  readonly targetId: string;
  readonly hostId: string;
  readonly epoch: string;
  readonly generation: number;
}
export class DesktopRuntimeController {
  private readonly shell: DesktopShellPort;
  private readonly projection: ProjectionStore;
  private readonly ownsProjection: boolean;
  private readonly clock: { now(): number };
  private readonly timers: DesktopRuntimeTimerScheduler;
  private readonly sessionRefreshTimers = new Map<string, unknown>();
  private readonly sessionRefreshInFlight = new Map<string, DesktopTargetIdentity>();
  private readonly sessionInventoryEpochByTarget = new Map<string, string>();
  private readonly catalogReadyByTarget = new Set<string>();
  private readonly settingsReadyByTarget = new Set<string>();
  private readonly maxRuntimeErrors: number;
  private readonly listeners = new Set<DesktopRuntimeSnapshotListener>();
  private readonly serverEventListeners = new Set<{
    readonly listener: DesktopServerEventSubscription;
    readonly filter?: DesktopServerEventFilter;
  }>();
  private unsubscribes: Unsubscribe[] = [];
  private current: DesktopRuntimeSnapshot;
  private startPromise: Promise<DesktopRuntimeSnapshot> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopped = false;
  private readonly controllerLeases = new Map<string, DesktopControllerLeaseEntry>();
  private readonly promptLeases: PromptLeaseStore;
  private readonly connectionGenerations = new Map<string, number>();
  /** Welcome can arrive before the shell's final connected notification. */
  private readonly welcomedBeforeConnected = new Set<string>();
  private readonly removedTargetIds = new Set<string>();
  private readonly hostState = new DesktopRuntimeHostState();
  private readonly controllerLeaseFallbackTtlMs = 20_000;
  constructor(options: DesktopRuntimeOptions) {
    this.shell = options.shell;
    this.projection = options.projection ?? new ProjectionStore(options.projectionOptions);
    this.ownsProjection = options.projection === undefined;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.timers = options.timers ?? defaultTimerScheduler;
    this.promptLeases = new PromptLeaseStore({ clock: this.clock, issue: (request) => this.shell.command(request), invalidateTarget: async (targetId) => { try { await this.disconnect(targetId); } catch { /* uncertain acquire cleanup is best effort */ } } });
    this.maxRuntimeErrors = Math.max(1, Math.min(options.maxRuntimeErrors ?? DEFAULT_MAX_RUNTIME_ERRORS, 128));
    this.current = Object.freeze({
      version: 1 as const,
      platform: this.shell.platform,
      desktopVersion: "unknown",
      startState: "idle" as const,
      targets: mapValue<string, DesktopTarget>([]),
      connections: mapValue<string, DesktopTarget["state"]>([]),
      targetHosts: mapValue<string, string>([]),
      hosts: mapValue<string, DesktopHostMetadata>([]),
      catalogs: mapValue<string, CatalogFrame>([]),
      settings: mapValue<string, SettingsFrame>([]),
      projection: this.projection.getSnapshot(),
      runtimeErrors: Object.freeze([]),
    });
    this.projection.subscribe((snapshot) => {
      if (this.stopped) return;
      this.replace({ projection: snapshot });
    });
  }
  getSnapshot(): DesktopRuntimeSnapshot { return this.current; }
  snapshot(): DesktopRuntimeSnapshot { return this.current; }
  subscribe(listener: DesktopRuntimeSnapshotListener): Unsubscribe {
    if (this.stopped) return noop;
    this.listeners.add(listener);
    let active = true;
    return () => { if (active) { active = false; this.listeners.delete(listener); } };
  }
  subscribeEvents(listener: DesktopServerEventSubscription, filter?: DesktopServerEventFilter): Unsubscribe;
  subscribeEvents(filter: DesktopServerEventFilter, listener: DesktopServerEventSubscription): Unsubscribe;
  subscribeEvents(
    first: DesktopServerEventSubscription | DesktopServerEventFilter,
    second?: DesktopServerEventSubscription | DesktopServerEventFilter,
  ): Unsubscribe {
    const listener = typeof first === "function" ? first : second as DesktopServerEventSubscription;
    const filter = typeof first === "function"
      ? second as DesktopServerEventFilter | undefined
      : first;
    if (this.stopped || typeof listener !== "function") return noop;
    const item = { listener, ...(filter === undefined ? {} : { filter }) };
    this.serverEventListeners.add(item);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.serverEventListeners.delete(item);
    };
  }
  async start(): Promise<DesktopRuntimeSnapshot> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.stopped) return Promise.reject(new DesktopRuntimeError("stopped", "desktop runtime is stopped"));
    this.startPromise = this.startNow();
    return this.startPromise;
  }
  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopPromise = this.stopNow();
    return this.stopPromise;
  }
  private async stopNow(): Promise<void> {
    const speechStop = this.shell.stopSpeaking === undefined
      ? Promise.resolve()
      : Promise.resolve().then(() => this.shell.stopSpeaking?.()).then(() => undefined, () => undefined);
    const entries: DesktopControllerLease[] = [];
    for (const entry of this.controllerLeases.values()) {
      if (entry.lease !== undefined) entries.push(entry.lease);
    }
    this.controllerLeases.clear();
    const promptClose = this.promptLeases.close();
    this.clearAllSessionRefreshTimers();
    this.sessionRefreshInFlight.clear();
    this.sessionInventoryEpochByTarget.clear();
    this.catalogReadyByTarget.clear();
    this.settingsReadyByTarget.clear();
    this.removedTargetIds.clear();
    const unsubscribes = this.unsubscribes.splice(0);
    this.stopped = true;
    this.listeners.clear();
    this.serverEventListeners.clear();
    for (const unsubscribe of unsubscribes) {
      try { unsubscribe(); } catch { /* listener disposal is best effort */ }
    }
    await Promise.race([
      Promise.all([...entries.map((lease) => this.releaseLeaseBestEffort(lease)), promptClose]),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
    await speechStop;
    this.replace({ startState: "stopped" });
    await this.projection.dispose();
  }
  async listTargets(): Promise<readonly DesktopTarget[]> {
    const result = await this.shell.listTargets();
    this.applyTargets(result.targets);
    return Object.freeze([...this.current.targets.values()]);
  }
  async addTarget(request: TargetAddRequest): Promise<DesktopTarget> {
    const result = await this.shell.addTarget(freezeClone(request));
    this.upsertTarget(result.target);
    return this.current.targets.get(result.target.targetId) ?? result.target;
  }
  async removeTarget(targetId: string): Promise<TargetRemoveResult> {
    const result = await this.shell.removeTarget(freezeClone({ targetId }));
    if (result.removed) {
      this.applyTargets([...this.current.targets.values()].filter((target) => target.targetId !== targetId));
    }
    return freezeClone(result);
  }
  async connect(targetId: string): Promise<ConnectResult> {
    const result = await this.shell.connectTarget(freezeClone({ targetId }));
    this.updateConnection(targetId, result.state);
    return freezeClone(result);
  }
  async disconnect(targetId: string): Promise<DisconnectResult> {
    const result = await this.shell.disconnectTarget(freezeClone({ targetId }));
    this.updateConnection(targetId, result.state);
    return freezeClone(result);
  }
  async pair(targetId: string, code: string): Promise<PairResult> {
    return freezeClone(await this.shell.pair(freezeClone({ targetId, code })));
  }
  activateSession(hostIdValue: string, sessionIdValue: string): DesktopRuntimeSnapshot {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    const projection = this.projection.activateSession(hostId(hostIdValue), sessionId(sessionIdValue));
    this.replace({ projection });
    return this.current;
  }
  async attachSession(targetId: string, hostIdValue: string, sessionIdValue: string, cursor?: Cursor): Promise<CommandResult> {
    const result = await this.command(targetId, { hostId: hostId(hostIdValue), sessionId: sessionId(sessionIdValue), command: "session.attach", args: cursor === undefined ? {} : { cursor } });
    this.activateSession(hostIdValue, sessionIdValue);
    return result;
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    try { return freezeClone(await this.shell.confirm(freezeClone(request))); }
    catch (error) { throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "confirmation failed"); }
  }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    try { return freezeClone(await this.shell.terminalInput(freezeClone(request))); }
    catch (error) { throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "terminal input failed"); }
  }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    try { return freezeClone(await this.shell.terminalResize(freezeClone(request))); }
    catch (error) { throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "terminal resize failed"); }
  }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    try { return freezeClone(await this.shell.terminalClose(freezeClone(request))); }
    catch (error) { throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "terminal close failed"); }
  }
  async command(targetId: string, intent: CommandRequest["intent"]): Promise<CommandResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    try {
      return await this.issueCommand(targetId, intent);
    } catch (error) {
      if (error instanceof DesktopRuntimeError) throw error;
      throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "command failed");
    }
  }
  private async issueCommand(targetId: string, intent: CommandRequest["intent"], capturedIdentity?: DesktopTargetIdentity): Promise<CommandResult> {
    const identity = capturedIdentity ?? this.captureTargetIdentity(targetId);
    const result = freezeClone(await this.shell.command(freezeClone({ targetId, intent })));
    const isHostProductCommand = intent.command === "session.list" || intent.command === "host.list" || intent.command === "catalog.get" || intent.command === "settings.read";
    if (result.accepted === true && isHostProductCommand) {
      if (identity === undefined || !this.isCurrentTargetIdentity(identity) || !this.isCurrentHostProjection(identity) || identity.hostId !== String(intent.hostId)) {
        throw new DesktopRuntimeError("stale", "host product command completed for a stale target binding");
      }
      this.applyHostCommandResult(targetId, String(intent.hostId), intent.command, result, identity);
      this.notifyValidatedHostCommand(targetId, String(intent.hostId), intent.command, result);
      if (intent.command === "catalog.get") this.catalogReadyByTarget.add(targetId);
      if (intent.command === "settings.read") this.settingsReadyByTarget.add(targetId);
    }
    return result;
  }
  async acquireControllerLease(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    ownerId = "t4-code-client",
  ): Promise<DesktopControllerLeaseAcquireResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    const identity = this.captureTargetIdentity(targetId);
    if (identity === undefined || identity.hostId !== hostIdValue || !this.hasControllerLeaseFeature(targetId, hostIdValue)) return { required: false };
    const generation = identity.generation;
    const key = this.leaseKey(targetId, hostIdValue, sessionIdValue, expectedRevision, generation);
    const existing = this.controllerLeases.get(key);
    if (existing?.lease !== undefined && existing.lease.generation === generation && existing.lease.expiresAt > this.clock.now()) return { required: true, ...existing.lease };
    if (existing?.pending !== undefined) return existing.pending;
    const pending = this.acquireControllerLeaseNow(targetId, hostIdValue, sessionIdValue, expectedRevision, ownerId, generation, key);
    this.controllerLeases.set(key, { key, pending });
    void pending.then((result) => {
      const currentEntry = this.controllerLeases.get(key);
      const isCurrentPending = currentEntry?.pending === pending;
      const isCurrentIdentity = this.isCurrentTargetIdentity(identity);
      if (result.required && (!isCurrentPending || !isCurrentIdentity)) void this.releaseLeaseBestEffort(result);
      if (!isCurrentPending) return;
      if (result.required && isCurrentIdentity) this.controllerLeases.set(key, { key, lease: result });
      else this.controllerLeases.delete(key);
    }, () => {
      if (this.controllerLeases.get(key)?.pending === pending) this.controllerLeases.delete(key);
    });
    return pending;
  }
  async renewControllerLease(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    leaseId?: string,
  ): Promise<DesktopControllerLeaseOperationResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    if (!this.hasControllerLeaseFeature(targetId, hostIdValue)) return { required: false, accepted: true };
    const identity = this.captureTargetIdentity(targetId);
    if (identity === undefined || identity.hostId !== hostIdValue) throw new DesktopRuntimeError("stale", "controller lease binding is not current");
    const generation = identity.generation;
    const keyPrefix = `${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${expectedRevision}\u0000`;
    let activeLease: DesktopControllerLease | undefined;
    for (const candidate of this.controllerLeases.values()) {
      if (candidate.lease !== undefined && candidate.key.startsWith(keyPrefix) && candidate.lease.generation === generation) {
        activeLease = candidate.lease;
        break;
      }
    }
    const id = leaseId ?? activeLease?.leaseId;
    if (id === undefined) throw new DesktopRuntimeError("stale", "controller lease is not available");
    const key = this.leaseKey(targetId, hostIdValue, sessionIdValue, expectedRevision, generation);
    try {
      const raw = await this.issueControllerLeaseCommand({ targetId, hostIdValue, sessionIdValue, expectedRevision, command: "controller.lease.renew", args: { leaseId: id } });
      const payload = leasePayload(raw);
      if (payload?.accepted === false) throw new DesktopRuntimeError("stale", "controller lease renewal was rejected");
      const renewed = this.makeLease(targetId, hostIdValue, sessionIdValue, expectedRevision, activeLease?.ownerId ?? "t4-code-client", id, generation, payload);
      if (!this.isCurrentTargetIdentity(identity)) {
        await this.releaseLeaseBestEffort(renewed);
        throw new DesktopRuntimeError("stale", "controller lease renewal completed for a stale target binding");
      }
      this.controllerLeases.set(key, { key, lease: renewed });
      return this.operationResult(raw, id, true);
    } catch (error) {
      if (this.isCurrentTargetIdentity(identity) && activeLease !== undefined) {
        const currentEntry = this.controllerLeases.get(key);
        if (currentEntry?.lease === activeLease) this.controllerLeases.delete(key);
      }
      throw error;
    }
  }
  async releaseControllerLease(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    leaseId?: string,
  ): Promise<DesktopControllerLeaseOperationResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    if (!this.hasControllerLeaseFeature(targetId, hostIdValue)) return { required: false, accepted: true };
    const generation = this.generationFor(targetId);
    const keyPrefix = `${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${expectedRevision}\u0000`;
    let activeLease: DesktopControllerLease | undefined;
    for (const candidate of this.controllerLeases.values()) {
      if (candidate.lease !== undefined && candidate.key.startsWith(keyPrefix) && candidate.lease.generation === generation) {
        activeLease = candidate.lease;
        break;
      }
    }
    const id = leaseId ?? activeLease?.leaseId;
    if (id === undefined) return { required: true, accepted: true, released: false };
    try {
      const raw = await this.issueControllerLeaseCommand({ targetId, hostIdValue, sessionIdValue, expectedRevision, command: "controller.lease.release", args: { leaseId: id } });
      return this.operationResult(raw, id, true, true);
    } finally {
      for (const [key, candidate] of this.controllerLeases) if (candidate.lease?.leaseId === id) this.controllerLeases.delete(key);
    }
  }
  controllerLeaseFor(targetId: string, hostIdValue: string, sessionIdValue: string, expectedRevision: string): DesktopControllerLease | undefined {
    const generation = this.generationFor(targetId);
    const keyPrefix = `${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${expectedRevision}\u0000`;
    for (const candidate of this.controllerLeases.values()) {
      if (candidate.lease !== undefined && candidate.key.startsWith(keyPrefix) && candidate.lease.generation === generation && candidate.lease.expiresAt > this.clock.now()) return candidate.lease;
    }
    return undefined;
  }
  /**
   * Callers currently inside one session's acquire→dispatch window. Two
   * concurrent calls can coalesce onto the same pending acquisition with no
   * prior cached lease; a gate rejection may only tear the lease down when
   * no coalesced peer is still about to dispatch with it. Cleanup fails
   * open — an unreleased lease simply expires.
   */
  private readonly leaseWindowHolds = new Map<string, number>();
  private holdLeaseWindow(key: string): () => void {
    this.leaseWindowHolds.set(key, (this.leaseWindowHolds.get(key) ?? 0) + 1);
    return () => {
      const next = (this.leaseWindowHolds.get(key) ?? 1) - 1;
      if (next <= 0) this.leaseWindowHolds.delete(key);
      else this.leaseWindowHolds.set(key, next);
    };
  }
  async commandWithControllerLease(targetId: string, intent: CommandRequest["intent"], leaseRevision?: string, beforeDispatch?: () => void): Promise<CommandResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    const hostIdValue = String(intent.hostId);
    const identity = this.captureTargetIdentity(targetId);
    if (identity === undefined || identity.hostId !== hostIdValue) throw new DesktopRuntimeError("stale", "controller lease binding is not current");
    const revisionValue = intent.expectedRevision ?? leaseRevision;
    if (intent.sessionId === undefined || revisionValue === undefined || !this.hasControllerLeaseFeature(targetId, hostIdValue)) {
      if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed before controller command dispatch");
      beforeDispatch?.();
      if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed before controller command dispatch");
      return this.command(targetId, intent);
    }
    const sessionIdValue = String(intent.sessionId);
    const priorLease = this.controllerLeaseFor(targetId, hostIdValue, sessionIdValue, String(revisionValue));
    const holdKey = `c\u0000${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${String(revisionValue)}`;
    const releaseHold = this.holdLeaseWindow(holdKey);
    try {
      const acquired = await this.acquireControllerLease(targetId, hostIdValue, sessionIdValue, String(revisionValue));
      if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed during controller lease acquisition");
      try {
        beforeDispatch?.();
        if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed before controller command dispatch");
      } catch (error) {
        if (acquired.required && acquired.leaseId !== priorLease?.leaseId && (this.leaseWindowHolds.get(holdKey) ?? 0) <= 1) {
          const key = this.leaseKey(
            targetId,
            hostIdValue,
            sessionIdValue,
            String(revisionValue),
            identity.generation,
          );
          if (this.controllerLeases.get(key)?.lease?.leaseId === acquired.leaseId) {
            this.controllerLeases.delete(key);
          }
          void this.releaseLeaseBestEffort(acquired).catch(() => undefined);
        }
        throw error;
      }
      if (!acquired.required) return this.command(targetId, intent);
      const args = intent.args === undefined ? { leaseId: acquired.leaseId } : { ...intent.args, leaseId: acquired.leaseId };
      return this.command(targetId, { ...intent, args });
    } finally {
      releaseHold();
    }
  }
  async commandWithPromptLease(targetId: string, intent: CommandRequest["intent"], leaseRevision?: string, beforeDispatch?: () => void): Promise<CommandResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    const identity = this.captureTargetIdentity(targetId);
    const hostIdValue = String(intent.hostId);
    if (identity === undefined || identity.hostId !== hostIdValue) throw new DesktopRuntimeError("stale", "prompt lease binding is not current");
    const generation = identity.generation;
    const sessionIdValue = intent.sessionId === undefined ? undefined : String(intent.sessionId);
    const priorPromptLeaseId = sessionIdValue === undefined ? undefined : this.promptLeases.leaseIdFor(targetId, hostIdValue, sessionIdValue, generation);
    const holdKey = `p\u0000${targetId}\u0000${hostIdValue}\u0000${sessionIdValue ?? ""}\u0000${generation}`;
    const releaseHold = sessionIdValue === undefined ? null : this.holdLeaseWindow(holdKey);
    const featureEnabled = this.hostState.metadataForTarget(targetId)?.grantedFeatures.includes("prompt.lease") === true;
    try {
      return await this.promptLeases.command(targetId, intent, generation, featureEnabled, (nextTargetId, nextIntent) => {
        if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed during prompt lease acquisition");
        try {
          beforeDispatch?.();
          if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed before prompt command dispatch");
        } catch (error) {
          if (sessionIdValue !== undefined && (this.leaseWindowHolds.get(holdKey) ?? 0) <= 1) {
            this.promptLeases.invalidateSession(nextTargetId, hostIdValue, sessionIdValue, this.generationFor(nextTargetId), priorPromptLeaseId);
          }
          throw error;
        }
        if (!this.isCurrentTargetIdentity(identity)) throw new DesktopRuntimeError("stale", "target identity changed before prompt command dispatch");
        return this.command(nextTargetId, nextIntent);
      }, leaseRevision);
    } finally {
      releaseHold?.();
    }
  }
  private generationFor(targetId: string): number {
    return this.connectionGenerations.get(targetId) ?? 0;
  }
  private captureTargetIdentity(targetId: string, generation = this.generationFor(targetId)): DesktopTargetIdentity | undefined {
    const hostIdValue = this.current.targetHosts.get(targetId);
    const metadata = this.hostState.metadataForTarget(targetId);
    if (hostIdValue === undefined || metadata === undefined || metadata.hostId !== hostIdValue) return undefined;
    return { targetId, hostId: hostIdValue, epoch: metadata.epoch, generation };
  }
  private isCurrentTargetIdentity(identity: DesktopTargetIdentity): boolean {
    if (this.stopped) return false;
    const current = this.captureTargetIdentity(identity.targetId);
    if (current === undefined || current.hostId !== identity.hostId || current.epoch !== identity.epoch) return false;
    return (
      (current.generation === identity.generation && this.current.connections.get(identity.targetId) === "connected") ||
      (identity.generation === current.generation + 1 && this.welcomedBeforeConnected.has(identity.targetId))
    );
  }
  private isCurrentHostProjection(identity: DesktopTargetIdentity): boolean {
    const host = this.current.hosts.get(identity.hostId);
    return host?.targetId === identity.targetId && host.epoch === identity.epoch;
  }
  private leaseKey(targetId: string, hostIdValue: string, sessionIdValue: string, expectedRevision: string, generation: number): string {
    return `${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${expectedRevision}\u0000${generation}`;
  }
  private hasControllerLeaseFeature(targetId: string, hostIdValue: string): boolean {
    const metadata = this.hostState.metadataForTarget(targetId);
    return metadata?.hostId === hostIdValue && metadata.grantedFeatures.includes("controller.lease");
  }
  private async acquireControllerLeaseNow(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    ownerId: string,
    generation: number,
    key: string,
  ): Promise<DesktopControllerLeaseAcquireResult> {
    try {
      const raw = await this.issueControllerLeaseCommand({ targetId, hostIdValue, sessionIdValue, expectedRevision, command: "controller.lease.acquire", args: { ownerId } });
      const payload = leasePayload(raw);
      if (payload?.accepted === false) throw new DesktopRuntimeError("stale", "controller lease acquisition was rejected");
      const leaseId = boundedText(payload?.leaseId);
      if (leaseId === undefined) throw new DesktopRuntimeError("protocol", "controller lease acquisition did not return a bounded lease id");
      const lease = this.makeLease(targetId, hostIdValue, sessionIdValue, expectedRevision, ownerId, leaseId, generation, payload);
      return { required: true, ...lease };
    } catch (error) {
      if (this.controllerLeases.get(key)?.pending !== undefined) this.controllerLeases.delete(key);
      throw error;
    }
  }
  private makeLease(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    ownerId: string,
    leaseId: string,
    generation: number,
    payload: Record<string, unknown> | undefined,
  ): DesktopControllerLease {
    const now = this.clock.now();
    const expiresAtIso = boundedText(payload?.expiresAt, 128);
    const parsedExpiry = expiresAtIso === undefined ? Number.NaN : Date.parse(expiresAtIso);
    const expiresAt = Number.isFinite(parsedExpiry) && parsedExpiry > now ? parsedExpiry : now + this.controllerLeaseFallbackTtlMs;
    const renewBefore = Math.max(1_000, Math.min(5_000, Math.floor((expiresAt - now) / 4)));
    return Object.freeze({
      targetId,
      hostId: hostIdValue,
      sessionId: sessionIdValue,
      expectedRevision,
      ownerId,
      leaseId,
      generation,
      acquiredAt: now,
      expiresAt,
      ...(expiresAtIso === undefined ? {} : { expiresAtIso }),
      needsRenewal: (at = this.clock.now()): boolean => at >= expiresAt - renewBefore,
    });
  }
  private async issueControllerLeaseCommand(request: {
    readonly targetId: string;
    readonly hostIdValue: string;
    readonly sessionIdValue: string;
    readonly expectedRevision: string;
    readonly command: string;
    readonly args: Record<string, unknown>;
  }): Promise<unknown> {
    try {
      return await this.shell.command(freezeClone({
        targetId: request.targetId,
        intent: {
          hostId: hostId(request.hostIdValue),
          sessionId: sessionId(request.sessionIdValue),
          command: request.command,
          expectedRevision: revision(request.expectedRevision),
          args: request.args,
        },
      }));
    } catch (error) {
      throw commandFailure(error, `controller lease ${request.command.split(".").at(-1) ?? "operation"} failed`);
    }
  }
  private operationResult(raw: unknown, leaseId: string, required: boolean, released = false): DesktopControllerLeaseOperationResult {
    const payload = leasePayload(raw);
    const root = asRecord(raw);
    const expiresAt = boundedText(payload?.expiresAt, 128);
    const cursor = boundedText(payload?.cursor, 256);
    return {
      required,
      accepted: root?.accepted !== false && payload?.accepted !== false,
      leaseId,
      ...(released ? { released: true } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(cursor === undefined ? {} : { cursor }),
    };
  }
  private async releaseLeaseBestEffort(lease: DesktopControllerLease): Promise<void> {
    try {
      await this.issueControllerLeaseCommand({
        targetId: lease.targetId,
        hostIdValue: lease.hostId,
        sessionIdValue: lease.sessionId,
        expectedRevision: lease.expectedRevision,
        command: "controller.lease.release",
        args: { leaseId: lease.leaseId },
      });
    } catch {
      // Connection teardown must not block on release.
    }
  }
  private async startNow(): Promise<DesktopRuntimeSnapshot> {
    this.replace({ startState: "starting" });
    this.installListeners();
    let bootstrap: BootstrapResult;
    let listed: TargetListResult;
    try {
      await this.projection.ready();
      if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
      bootstrap = await this.shell.bootstrap();
      if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
      this.replace({ platform: bootstrap.platform, desktopVersion: bootstrap.version });
      listed = await this.shell.listTargets();
      this.applyTargets(listed.targets);
    } catch (error) {
      this.removeListeners();
      const message = error instanceof DesktopRuntimeError ? error.message : "desktop bootstrap failed; retry after checking the desktop connection";
      this.recordError({ code: "internal", message });
      this.replace({ startState: "error" });
      throw new DesktopRuntimeError("bootstrap", message);
    }
    try {
      const connected = await this.shell.connectTarget({ targetId: "local" });
      this.updateConnection(connected.targetId, connected.state);
    } catch (error) {
      this.updateConnection("local", "error");
      this.recordError({ targetId: "local", code: "transport", message: error instanceof Error ? error.message : "local target connection failed" });
    }
    if (!this.stopped) this.replace({ startState: "started" });
    return this.current;
  }
  private installListeners(): void {
    this.unsubscribes = [
      this.shell.onServerEvent((event) => this.handleEvent({ channel: "omp:server-event", payload: event })),
      this.shell.onConnectionState((event) => this.handleEvent({ channel: "omp:connection-state", payload: event })),
      this.shell.onRuntimeError((event) => this.handleEvent({ channel: "omp:runtime-error", payload: event })),
      ...(this.shell.onWake === undefined
        ? []
        : [this.shell.onWake(() => this.requestSessionRefreshes())]),
    ];
  }
  private removeListeners(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) { try { unsubscribe(); } catch { /* best effort */ } }
  }
  private handleEvent(input: unknown): void {
    if (this.stopped) return;
    try {
      const event = decodeDesktopEvent(input);
      if (event.channel === "omp:server-event") {
        this.handleServerEvent(event.payload as RendererServerEventEnvelope);
      } else if (event.channel === "omp:connection-state") {
        const payload = event.payload as ConnectionStateEvent;
        this.updateConnection(payload.targetId, payload.state);
      } else {
        this.recordError(event.payload as RuntimeErrorEvent);
      }
    } catch (error) {
      this.recordError({ code: "protocol", message: error instanceof Error ? error.message : "invalid desktop event" });
    }
  }
  private handleServerEvent(event: RendererServerEventEnvelope): void {
    const incomingEvent = event.event;
    const transcriptEvent = this.isRetainedTranscriptEvent(incomingEvent);
    // Do not deep-clone a potentially large transcript payload before applying
    // retention. The shared projection consumes the decoded event directly;
    // renderer subscribers receive only the bounded immutable copy.
    const rendererEvent: RendererServerEventEnvelope = {
      targetId: event.targetId,
      event: transcriptEvent
        ? sanitizeRetainedTranscriptEvent(incomingEvent)
        : freezeClone(incomingEvent),
    };
    if (incomingEvent.kind === "welcome") {
      if (!this.handleWelcome(event.targetId, incomingEvent.payload)) return;
      this.applyProjectionEvent(event.targetId, incomingEvent);
      this.notifyServerEvents(rendererEvent);
    } else {
      const payload = asRecord(incomingEvent.payload) ?? {};
      const hostIdValue = typeof payload.hostId === "string" ? payload.hostId : undefined;
      const boundHost = this.current.targetHosts.get(event.targetId);
      if (hostIdValue !== undefined && boundHost !== hostIdValue) {
        this.recordError({ targetId: event.targetId, code: "protocol", message: "event host does not match target binding" });
        return;
      }
      const targetMetadata = this.hostState.metadataForTarget(event.targetId);
      const hostMetadata = hostIdValue === undefined ? undefined : this.current.hosts.get(hostIdValue);
      const hostProjectionCurrent = targetMetadata !== undefined && hostMetadata !== undefined && hostMetadata.targetId === event.targetId && targetMetadata.epoch === hostMetadata.epoch;
      const hostProductResponse = incomingEvent.kind === "response" && incomingEvent.payload.ok && (incomingEvent.payload.command === "session.list" || incomingEvent.payload.command === "host.list" || incomingEvent.payload.command === "catalog.get" || incomingEvent.payload.command === "settings.read");
      const modernInventory = targetMetadata?.grantedCapabilities.includes("sessions.read") === true;
      if (hostIdValue !== undefined && !hostProjectionCurrent) return;
      if (incomingEvent.kind === "sessions" && modernInventory && (this.sessionInventoryEpochByTarget.get(event.targetId) !== incomingEvent.payload.cursor.epoch)) return;
      const modernCatalog = targetMetadata?.grantedCapabilities.includes("catalog.read") === true && targetMetadata.grantedFeatures.includes("catalog.metadata");
      const modernSettings = targetMetadata?.grantedCapabilities.includes("config.read") === true && targetMetadata.grantedFeatures.includes("settings.metadata");
      if (incomingEvent.kind === "catalog" && modernCatalog && !this.catalogReadyByTarget.has(event.targetId)) return;
      if (incomingEvent.kind === "settings" && modernSettings && !this.settingsReadyByTarget.has(event.targetId)) return;
      if (hostIdValue !== undefined && (incomingEvent.kind === "catalog" || incomingEvent.kind === "settings") && hostProjectionCurrent) {
        if (incomingEvent.kind === "catalog") {
          const catalog = decodeCatalog({ v: "omp-app/1", type: "catalog", ...incomingEvent.payload });
          if (catalog.type !== "catalog") throw new DesktopRuntimeError("protocol", "catalog event decoded as settings");
          this.replace({ catalogs: mapValue(new Map(this.current.catalogs).set(hostIdValue, catalog)) });
        } else {
          const settings = decodeCatalog({ v: "omp-app/1", type: "settings", ...incomingEvent.payload });
          if (settings.type !== "settings") throw new DesktopRuntimeError("protocol", "settings event decoded as catalog");
          this.replace({ settings: mapValue(new Map(this.current.settings).set(hostIdValue, settings)) });
        }
      }
      if (hostIdValue === undefined || hostProjectionCurrent || incomingEvent.kind === "response") {
        this.applyProjectionEvent(event.targetId, incomingEvent);
      }
      if (!hostProductResponse) this.notifyServerEvents(rendererEvent);
      return;
    }
  }
  private isRetainedTranscriptEvent(event: RendererServerEvent): event is RetainedTranscriptEvent {
    return event.kind === "snapshot" || event.kind === "entry" || event.kind === "event" || event.kind === "gap" || event.kind === "agent.transcript";
  }
  private applySessionListResult(targetId: string, hostValue: string, result: Record<string, unknown>, expectedIdentity?: DesktopTargetIdentity): void {
    try {
      const sessions = decodeSessions({
        v: "omp-app/1",
        type: "sessions",
        hostId: hostValue,
        cursor: result.cursor,
        sessions: result.sessions,
        totalCount: result.totalCount,
        truncated: result.truncated,
      });
      if (expectedIdentity !== undefined) this.sessionInventoryEpochByTarget.set(targetId, sessions.cursor.epoch);
      this.applyProjectionEvent(targetId, rendererServerEventFromFrame(sessions));
    } catch (error) {
      if (error instanceof DesktopRuntimeError) throw error;
      throw new DesktopRuntimeError("protocol", error instanceof Error ? error.message : "invalid session inventory result");
    }
  }
  private applyHostCommandResult(targetId: string, hostValue: string, command: string, response: CommandResult, expectedIdentity?: DesktopTargetIdentity): void {
    const result = asRecord(response.result);
    if (result === undefined) throw new DesktopRuntimeError("protocol", "host response result is not an object");
    if (command === "session.list" || command === "host.list") {
      this.applySessionListResult(targetId, hostValue, result, expectedIdentity);
    } else if (command === "catalog.get") {
      const catalog = decodeCatalog({ v: "omp-app/1", type: "catalog", hostId: hostValue, revision: result.revision, items: result.items });
      if (catalog.type !== "catalog") throw new DesktopRuntimeError("protocol", "catalog response decoded as settings");
      this.replace({ catalogs: mapValue(new Map(this.current.catalogs).set(hostValue, catalog)) });
    } else if (command === "settings.read") {
      const settings = decodeCatalog({ v: "omp-app/1", type: "settings", hostId: hostValue, revision: result.revision, settings: result.settings });
      if (settings.type !== "settings") throw new DesktopRuntimeError("protocol", "settings response decoded as catalog");
      this.replace({ settings: mapValue(new Map(this.current.settings).set(hostValue, settings)) });
    }
  }
  private notifyValidatedHostCommand(targetId: string, hostValue: string, command: string, response: CommandResult): void {
    const event = Object.freeze({
      kind: "response" as const,
      payload: Object.freeze({
        requestId: response.requestId,
        commandId: response.commandId,
        hostId: hostId(hostValue),
        ok: true as const,
        command,
        result: response.result,
      }),
    }) as RendererServerEvent;
    this.notifyServerEvents({ targetId, event });
  }
  private handleWelcome(targetId: string, frame: DesktopWelcomePayload): boolean {
    if (this.removedTargetIds.has(targetId)) return false;
    const reconciled = this.hostState.acceptWelcome(
      targetId,
      frame,
      this.current.targetHosts,
      this.current.hosts,
      this.current.connections,
    );
    if (!reconciled.accepted) {
      this.recordError({ targetId, code: "protocol", message: "target host binding changed" });
      return false;
    }
    // Do not expose a newly accepted host binding alongside completeness from
    // the previous transport generation, even for the brief notification
    // before the welcome frame itself reaches the shared projection.
    this.projection.invalidateSessionInventory(String(frame.hostId));
    if (this.current.connections.get(targetId) !== "connected") {
      this.welcomedBeforeConnected.add(targetId);
    }
    if (reconciled.epochChanged) {
      this.invalidateTargetLeases(targetId);
      this.invalidateSessionRefresh(targetId);
    }
    this.replace({ targetHosts: reconciled.targetHosts, hosts: reconciled.hosts });
    void this.bootstrapHost(targetId, frame);
    return true;
  }
  private bootstrapHost(targetId: string, frame: DesktopWelcomePayload): void {
    const generationAtDispatch =
      this.generationFor(targetId) + (this.current.connections.get(targetId) === "connected" ? 0 : 1);
    // Welcome may precede the shell's connected event, which advances this generation once.
    const identity = this.captureTargetIdentity(targetId, generationAtDispatch);
    if (identity === undefined) return;
    void bootstrapDesktopHost({
      targetId,
      frame,
      issue: (intent) => this.stopped ? Promise.resolve(undefined) : this.issueCommand(targetId, intent, identity),
      onError: (error, code) => {
        if (this.stopped || !this.isCurrentTargetIdentity(identity)) return;
        this.recordError({
          targetId,
          code,
          message: error instanceof Error ? error.message : code === "transport" ? "host bootstrap command failed" : "invalid host bootstrap result",
        });
      },
    }).then(() => {
      if (!this.stopped && this.current.connections.get(targetId) === "connected" && this.isCurrentTargetIdentity(identity)) {
        this.scheduleSessionRefresh(targetId);
      }
    });
  }
  private applyProjectionEvent(
    targetId: string,
    event: RendererServerEventEnvelope["event"],
  ): void {
    if (this.stopped) return;
    this.projection.applyPublicEvent(event);
    if (this.current.targets.has(targetId)) {
      this.replace({ projection: this.projection.getSnapshot() });
    }
  }
  private notifyServerEvents(event: RendererServerEventEnvelope): void {
    const payload = asRecord(event.event.payload) ?? {};
    const hostIdValue = typeof payload.hostId === "string" ? payload.hostId : undefined;
    const sessionIdValue = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const { listener, filter } of [...this.serverEventListeners]) {
      if (
        filter !== undefined &&
        (filter.targetId !== event.targetId ||
          (filter.hostId !== undefined && filter.hostId !== hostIdValue) ||
          (filter.sessionId !== undefined && filter.sessionId !== sessionIdValue) ||
          (filter.kinds !== undefined && !filter.kinds.includes(event.event.kind)))
      ) continue;
      try { listener(event); } catch { /* subscriber isolation */ }
    }
  }
  private requestSessionRefreshes(): void {
    for (const [targetId, state] of this.current.connections) {
      if (state === "connected") this.requestSessionRefresh(targetId);
    }
  }
  private requestSessionRefresh(targetId: string): void {
    if (this.stopped || this.current.connections.get(targetId) !== "connected") return;
    const identity = this.captureTargetIdentity(targetId);
    if (identity === undefined) return;
    const metadata = this.hostState.metadataForTarget(targetId);
    if (metadata === undefined || metadata.hostId !== identity.hostId || !metadata.grantedCapabilities.includes("sessions.read")) return;
    this.clearSessionRefreshTimer(targetId);
    if (this.sessionRefreshInFlight.has(targetId)) return;
    this.sessionRefreshInFlight.set(targetId, identity);
    void this.command(targetId, { hostId: hostId(identity.hostId), command: "session.list", args: {} })
      .then((response) => {
        if (response.accepted !== true) throw new DesktopRuntimeError("command", "session inventory refresh was rejected");
      })
      .catch((error) => {
        if (this.stopped || !this.isCurrentTargetIdentity(identity)) return;
        this.recordError({
          targetId,
          code: error instanceof DesktopRuntimeError && error.code === "protocol" ? "protocol" : "transport",
          message: error instanceof Error ? error.message : "session inventory refresh failed",
        });
      })
      .finally(() => {
        if (this.sessionRefreshInFlight.get(targetId) !== identity) return;
        this.sessionRefreshInFlight.delete(targetId);
        if (!this.stopped && this.current.connections.get(targetId) === "connected" && this.isCurrentTargetIdentity(identity)) {
          this.scheduleSessionRefresh(targetId);
        }
      });
  }
  private scheduleSessionRefresh(targetId: string): void {
    this.clearSessionRefreshTimer(targetId);
    if (this.stopped || this.current.connections.get(targetId) !== "connected") return;
    const handle = this.timers.setTimeout(() => {
      this.sessionRefreshTimers.delete(targetId);
      this.requestSessionRefresh(targetId);
    }, DEFAULT_SESSION_INVENTORY_REFRESH_MS);
    this.sessionRefreshTimers.set(targetId, handle);
  }
  private clearSessionRefreshTimer(targetId: string): void {
    const handle = this.sessionRefreshTimers.get(targetId);
    if (handle === undefined) return;
    this.sessionRefreshTimers.delete(targetId);
    this.timers.clearTimeout(handle);
  }
  private clearAllSessionRefreshTimers(): void {
    for (const targetId of this.sessionRefreshTimers.keys()) this.clearSessionRefreshTimer(targetId);
  }
  private invalidateSessionRefresh(targetId: string): void {
    this.clearSessionRefreshTimer(targetId);
    this.sessionRefreshInFlight.delete(targetId);
    this.sessionInventoryEpochByTarget.delete(targetId);
    this.catalogReadyByTarget.delete(targetId);
    this.settingsReadyByTarget.delete(targetId);
  }
  private applyTargets(targets: readonly DesktopTarget[]): void {
    const refreshAfterReconcile: string[] = [];
    for (const target of targets) {
      this.removedTargetIds.delete(target.targetId);
      if (
        this.current.connections.has(target.targetId) &&
        this.prepareConnectionTransition(target.targetId, target.state)
      ) {
        refreshAfterReconcile.push(target.targetId);
      }
    }
    const reconciled = this.hostState.reconcileTargets(
      this.current,
      targets,
      this.connectionGenerations.keys(),
    );
    for (const targetId of reconciled.removedTargetIds) {
      this.invalidateSessionRefresh(targetId);
      this.invalidateTargetLeases(targetId);
      this.connectionGenerations.delete(targetId);
      this.welcomedBeforeConnected.delete(targetId);
      this.removedTargetIds.add(targetId);
    }
    this.replace({
      targets: reconciled.targets,
      connections: reconciled.connections,
      targetHosts: reconciled.targetHosts,
      hosts: reconciled.hosts,
    });
    for (const targetId of refreshAfterReconcile) this.requestSessionRefresh(targetId);
  }
  private upsertTarget(target: DesktopTarget): void {
    this.removedTargetIds.delete(target.targetId);
    const targets = new Map(this.current.targets).set(target.targetId, targetCopy(target));
    const connections = new Map(this.current.connections).set(target.targetId, target.state);
    this.replace({ targets: mapValue(targets), connections: mapValue(connections) });
  }
  private prepareConnectionTransition(
    targetId: string,
    state: DesktopTarget["state"],
  ): boolean {
    const previous = this.current.connections.get(targetId);
    if (state !== "connected") this.welcomedBeforeConnected.delete(targetId);
    if (previous === state) return false;
    this.connectionGenerations.set(targetId, this.generationFor(targetId) + 1);
    this.invalidateSessionRefresh(targetId);
    this.invalidateTargetLeases(targetId);
    const welcomeAlreadyStartedThisGeneration =
      state === "connected" && this.welcomedBeforeConnected.delete(targetId);
    const refreshOnConnect = state === "connected" && !welcomeAlreadyStartedThisGeneration;
    if (!welcomeAlreadyStartedThisGeneration) {
      this.welcomedBeforeConnected.delete(targetId);
      const boundHost = this.current.targetHosts.get(targetId);
      // A cold process has no target-to-host binding yet, so every
      // completeness record came from cache. Once any live binding exists,
      // an unrelated new target cannot invalidate already connected hosts.
      if (boundHost !== undefined) this.projection.invalidateSessionInventory(boundHost);
      else if (this.current.targetHosts.size === 0) this.projection.invalidateSessionInventory();
    }
    return refreshOnConnect;
  }
  private updateConnection(targetId: string, state: DesktopTarget["state"]): void {
    const refreshOnConnect = this.prepareConnectionTransition(targetId, state);
    const connections = new Map(this.current.connections).set(targetId, state);
    const existing = this.current.targets.get(targetId);
    const targets = new Map(this.current.targets);
    if (existing !== undefined) targets.set(targetId, targetCopy({ ...existing, state }));
    const reconciled = this.hostState.reconcileTargets(
      { ...this.current, connections: mapValue(connections), targets: mapValue(targets) },
      [...targets.values()],
      this.connectionGenerations.keys(),
    );
    this.replace({ connections: mapValue(connections), targets: mapValue(targets), hosts: reconciled.hosts });
    if (refreshOnConnect) this.requestSessionRefresh(targetId);
    else if (state !== "connected") this.clearSessionRefreshTimer(targetId);
  }
  private invalidateTargetLeases(targetId: string): void {
    const entries: DesktopControllerLease[] = [];
    for (const entry of this.controllerLeases.values()) if (entry.lease?.targetId === targetId) entries.push(entry.lease);
    for (const [key, entry] of this.controllerLeases) if (entry.lease?.targetId === targetId || key.startsWith(`${targetId}\u0000`)) this.controllerLeases.delete(key);
    for (const lease of entries) void this.releaseLeaseBestEffort(lease);
    this.promptLeases.invalidateTarget(targetId);
  }
  private recordError(event: Partial<RuntimeErrorEvent> & { readonly message: string }): void {
    if (this.stopped) return;
    const entry: DesktopRuntimeErrorEntry = freezeClone({
      ...(event.targetId === undefined ? {} : { targetId: event.targetId }),
      code: event.code ?? "internal",
      message: redactedMessage(event.message),
      at: this.clock.now(),
    });
    const errors = [...this.current.runtimeErrors, entry];
    this.replace({ runtimeErrors: Object.freeze(errors.slice(-this.maxRuntimeErrors)) });
  }
  private replace(update: Partial<Omit<DesktopRuntimeSnapshot, "version">>): void {
    if (this.stopped && update.startState !== "stopped") return;
    this.current = Object.freeze({ ...this.current, ...update });
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) { try { listener(this.current); } catch { /* subscriber isolation */ } }
  }
}
export function createDesktopRuntimeController(options: DesktopRuntimeOptions): DesktopRuntimeController { return new DesktopRuntimeController(options); }
