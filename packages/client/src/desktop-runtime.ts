import {
  decodeDesktopEvent,
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
  type RendererServerFrame,
  type RendererServerFrameEvent,
  type RuntimeErrorEvent,
  type TargetAddRequest,
  type TargetListResult,
  type TargetRemoveResult,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
import { decodeCatalog, decodeSessions, hostId, revision, sessionId, type CatalogFrame, type SettingsFrame, type WelcomeFrame } from "@t4-code/protocol";
import type { Unsubscribe } from "./index.ts";
import { ProjectionStore, type ProjectionFrame } from "./projection.ts";
import {
  DesktopRuntimeError,
  asRecord,
  frameId,
  freezeClone,
  mapValue,
  redactedMessage,
  targetCopy,
  type DesktopControllerLease,
  type DesktopControllerLeaseAcquireResult,
  type DesktopControllerLeaseOperationResult,
  type DesktopFrameFilter,
  type DesktopFrameSubscription,
  type DesktopHostMetadata,
  type DesktopRuntimeErrorEntry,
  type DesktopRuntimeOptions,
  type DesktopRuntimeSnapshot,
  type DesktopRuntimeSnapshotListener,
  type DesktopShellPort,
} from "./desktop-runtime-contracts.ts";
import { DesktopRuntimeHostState } from "./desktop-runtime-hosts.ts";
import { boundedText, commandFailure, DEFAULT_MAX_RUNTIME_ERRORS, leasePayload, type DesktopControllerLeaseEntry } from "./desktop-runtime-policy.ts";
import { bootstrapDesktopHost } from "./desktop-runtime-bootstrap.ts";
import { PromptLeaseStore } from "./prompt-lease.ts";
export { DesktopRuntimeError } from "./desktop-runtime-contracts.ts";
export type {
  DesktopControllerLease,
  DesktopControllerLeaseAcquireResult,
  DesktopControllerLeaseOperationResult,
  DesktopControllerLeaseOptions,
  DesktopControllerLeaseResult,
  DesktopFrameFilter,
  DesktopFrameSubscription,
  DesktopHostMetadata,
  DesktopRuntimeErrorEntry,
  DesktopRuntimeOptions,
  DesktopRuntimeSnapshot,
  DesktopRuntimeSnapshotListener,
  DesktopRuntimeStartState,
  DesktopShellPort,
} from "./desktop-runtime-contracts.ts";
const noop = (): void => undefined;
export class DesktopRuntimeController {
  private readonly shell: DesktopShellPort;
  private readonly projection: ProjectionStore;
  private readonly ownsProjection: boolean;
  private readonly clock: { now(): number };
  private readonly maxRuntimeErrors: number;
  private readonly listeners = new Set<DesktopRuntimeSnapshotListener>();
  private readonly frameListeners = new Set<{ readonly listener: DesktopFrameSubscription; readonly filter?: DesktopFrameFilter }>();
  private unsubscribes: Unsubscribe[] = [];
  private current: DesktopRuntimeSnapshot;
  private startPromise: Promise<DesktopRuntimeSnapshot> | undefined;
  private stopped = false;
  private readonly controllerLeases = new Map<string, DesktopControllerLeaseEntry>();
  private readonly promptLeases: PromptLeaseStore;
  private readonly connectionGenerations = new Map<string, number>();
  private readonly hostState = new DesktopRuntimeHostState();
  private readonly controllerLeaseFallbackTtlMs = 20_000;
  constructor(options: DesktopRuntimeOptions) {
    this.shell = options.shell;
    this.projection = options.projection ?? new ProjectionStore(options.projectionOptions);
    this.ownsProjection = options.projection === undefined;
    this.clock = options.clock ?? { now: () => Date.now() };
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
  subscribeFrames(listener: DesktopFrameSubscription, filter?: DesktopFrameFilter): Unsubscribe;
  subscribeFrames(filter: DesktopFrameFilter, listener: DesktopFrameSubscription): Unsubscribe;
  subscribeFrames(first: DesktopFrameSubscription | DesktopFrameFilter, second?: DesktopFrameSubscription | DesktopFrameFilter): Unsubscribe {
    const listener = typeof first === "function" ? first : second as DesktopFrameSubscription;
    const filter = typeof first === "function" ? second as DesktopFrameFilter | undefined : first;
    if (this.stopped || typeof listener !== "function") return noop;
    const item = { listener, ...(filter === undefined ? {} : { filter }) };
    this.frameListeners.add(item);
    let active = true;
    return () => { if (active) { active = false; this.frameListeners.delete(item); } };
  }
  onFrame(listener: DesktopFrameSubscription, filter?: DesktopFrameFilter): Unsubscribe { return this.subscribeFrames(listener, filter); }
  async start(): Promise<DesktopRuntimeSnapshot> {
    if (this.startPromise !== undefined) return this.startPromise;
    if (this.stopped) return Promise.reject(new DesktopRuntimeError("stopped", "desktop runtime is stopped"));
    this.startPromise = this.startNow();
    return this.startPromise;
  }
  async stop(): Promise<void> {
    const entries: DesktopControllerLease[] = [];
    for (const entry of this.controllerLeases.values()) {
      if (entry.lease !== undefined) entries.push(entry.lease);
    }
    this.controllerLeases.clear();
    const promptClose = this.promptLeases.close();
    const unsubscribes = this.unsubscribes.splice(0);
    this.stopped = true;
    this.listeners.clear();
    this.frameListeners.clear();
    for (const unsubscribe of unsubscribes) {
      try { unsubscribe(); } catch { /* listener disposal is best effort */ }
    }
    await Promise.race([
      Promise.all([...entries.map((lease) => this.releaseLeaseBestEffort(lease)), promptClose]),
      new Promise<void>((resolve) => setTimeout(resolve, 100)),
    ]);
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
  async attachSession(targetId: string, hostIdValue: string, sessionIdValue: string): Promise<CommandResult> {
    const result = await this.command(targetId, { hostId: hostId(hostIdValue), sessionId: sessionId(sessionIdValue), command: "session.attach", args: {} });
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
    try { return freezeClone(await this.shell.command(freezeClone({ targetId, intent }))); }
    catch (error) { throw new DesktopRuntimeError("command", error instanceof Error ? error.message : "command failed"); }
  }
  async acquireControllerLease(
    targetId: string,
    hostIdValue: string,
    sessionIdValue: string,
    expectedRevision: string,
    ownerId = "t4-code-client",
  ): Promise<DesktopControllerLeaseAcquireResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    if (!this.hasControllerLeaseFeature(targetId, hostIdValue)) return { required: false };
    const generation = this.generationFor(targetId);
    const key = this.leaseKey(targetId, hostIdValue, sessionIdValue, expectedRevision, generation);
    const existing = this.controllerLeases.get(key);
    if (existing?.lease !== undefined && existing.lease.generation === generation && existing.lease.expiresAt > this.clock.now()) return { required: true, ...existing.lease };
    if (existing?.pending !== undefined) return existing.pending;
    const pending = this.acquireControllerLeaseNow(targetId, hostIdValue, sessionIdValue, expectedRevision, ownerId, generation, key);
    this.controllerLeases.set(key, { key, pending });
    void pending.then((result) => {
      if (result.required) this.controllerLeases.set(key, { key, lease: result });
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
    if (id === undefined) throw new DesktopRuntimeError("stale", "controller lease is not available");
    try {
      const raw = await this.issueControllerLeaseCommand({ targetId, hostIdValue, sessionIdValue, expectedRevision, command: "controller.lease.renew", args: { leaseId: id } });
      const payload = leasePayload(raw);
      if (payload?.accepted === false) throw new DesktopRuntimeError("stale", "controller lease renewal was rejected");
      const renewed = this.makeLease(targetId, hostIdValue, sessionIdValue, expectedRevision, activeLease?.ownerId ?? "t4-code-client", id, generation, payload);
      const key = this.leaseKey(targetId, hostIdValue, sessionIdValue, expectedRevision, generation);
      this.controllerLeases.set(key, { key, lease: renewed });
      return this.operationResult(raw, id, true);
    } catch (error) {
      for (const [key, candidate] of this.controllerLeases) if (candidate.lease?.leaseId === id) this.controllerLeases.delete(key);
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
  async commandWithControllerLease(targetId: string, intent: CommandRequest["intent"], leaseRevision?: string): Promise<CommandResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    const revisionValue = intent.expectedRevision ?? leaseRevision;
    if (intent.sessionId === undefined || revisionValue === undefined || !this.hasControllerLeaseFeature(targetId, String(intent.hostId))) return this.command(targetId, intent);
    const acquired = await this.acquireControllerLease(targetId, String(intent.hostId), String(intent.sessionId), String(revisionValue));
    if (!acquired.required) return this.command(targetId, intent);
    const args = intent.args === undefined ? { leaseId: acquired.leaseId } : { ...intent.args, leaseId: acquired.leaseId };
    return this.command(targetId, { ...intent, args });
  }
  async commandWithPromptLease(targetId: string, intent: CommandRequest["intent"], leaseRevision?: string): Promise<CommandResult> {
    if (this.stopped) throw new DesktopRuntimeError("stopped", "desktop runtime is stopped");
    return this.promptLeases.command(targetId, intent, this.generationFor(targetId), this.current.targetHosts.get(targetId) === String(intent.hostId) && this.current.hosts.get(String(intent.hostId))?.grantedFeatures.includes("prompt.lease") === true, (nextTargetId, nextIntent) => this.command(nextTargetId, nextIntent), leaseRevision);
  }
  private generationFor(targetId: string): number {
    return this.connectionGenerations.get(targetId) ?? 0;
  }
  private leaseKey(targetId: string, hostIdValue: string, sessionIdValue: string, expectedRevision: string, generation: number): string {
    return `${targetId}\u0000${hostIdValue}\u0000${sessionIdValue}\u0000${expectedRevision}\u0000${generation}`;
  }
  private hasControllerLeaseFeature(targetId: string, hostIdValue: string): boolean {
    const boundHost = this.current.targetHosts.get(targetId);
    return boundHost === hostIdValue && this.current.hosts.get(hostIdValue)?.grantedFeatures.includes("controller.lease") === true;
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
      this.shell.onServerFrame((event) => this.handleEvent({ channel: "omp:server-frame", payload: event })),
      this.shell.onConnectionState((event) => this.handleEvent({ channel: "omp:connection-state", payload: event })),
      this.shell.onRuntimeError((event) => this.handleEvent({ channel: "omp:runtime-error", payload: event })),
    ];
  }
  private removeListeners(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) { try { unsubscribe(); } catch { /* best effort */ } }
  }
  private handleEvent(input: unknown): void {
    if (this.stopped) return;
    try {
      const event = decodeDesktopEvent(input);
      if (event.channel === "omp:server-frame") {
        this.handleFrame(event.payload as RendererServerFrameEvent);
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
  private handleFrame(event: RendererServerFrameEvent): void {
    const frame = freezeClone(event.frame);
    if (frame.type === "welcome") {
      if (!this.handleWelcome(event.targetId, frame)) return;
    } else {
      const hostIdValue = frameId(frame, "hostId");
      const boundHost = this.current.targetHosts.get(event.targetId);
      if (hostIdValue !== undefined && boundHost !== hostIdValue) {
        this.recordError({ targetId: event.targetId, code: "protocol", message: "frame host does not match target binding" });
        return;
      }
      if (frame.type === "response") this.handleHostResponse(event.targetId, frame);
      if (hostIdValue !== undefined && (frame.type === "catalog" || frame.type === "settings")) {
        if (frame.type === "catalog") this.replace({ catalogs: mapValue(new Map(this.current.catalogs).set(hostIdValue, frame as CatalogFrame)) });
        else this.replace({ settings: mapValue(new Map(this.current.settings).set(hostIdValue, frame as SettingsFrame)) });
      }
      this.applyProjection(event.targetId, frame);
    }
    this.notifyFrames({ targetId: event.targetId, frame });
  }
  private handleHostResponse(targetId: string, frame: RendererServerFrame): void {
    if (frame.type !== "response" || !frame.ok || frame.command === undefined) return;
    const boundHost = this.current.targetHosts.get(targetId);
    const hostValue = frameId(frame, "hostId");
    if (boundHost === undefined || hostValue !== boundHost) {
      this.recordError({ targetId, code: "protocol", message: "response host does not match target binding" });
      return;
    }
    const result = asRecord(frame.result);
    if (result === undefined) {
      this.recordError({ targetId, code: "protocol", message: "host response result is not an object" });
      return;
    }
    try {
      if (frame.command === "session.list" || frame.command === "host.list") {
        const sessions = decodeSessions({ v: "omp-app/1", type: "sessions", hostId: hostValue, cursor: result.cursor, sessions: result.sessions, totalCount: result.totalCount, truncated: result.truncated });
        this.applyProjection(targetId, sessions);
      } else if (frame.command === "catalog.get") {
        const catalog = decodeCatalog({ v: "omp-app/1", type: "catalog", hostId: hostValue, revision: result.revision, items: result.items });
        if (catalog.type !== "catalog") throw new Error("catalog response decoded as settings");
        this.replace({ catalogs: mapValue(new Map(this.current.catalogs).set(hostValue, catalog)) });
      } else if (frame.command === "settings.read") {
        const settings = decodeCatalog({ v: "omp-app/1", type: "settings", hostId: hostValue, revision: result.revision, settings: result.settings });
        if (settings.type !== "settings") throw new Error("settings response decoded as catalog");
        this.replace({ settings: mapValue(new Map(this.current.settings).set(hostValue, settings)) });
      }
    } catch (error) {
      this.recordError({ targetId, code: "protocol", message: error instanceof Error ? error.message : "invalid host response result" });
    }
  }
  private handleWelcome(targetId: string, frame: WelcomeFrame): boolean {
    const reconciled = this.hostState.acceptWelcome(
      targetId,
      frame,
      this.current.targetHosts,
      this.current.hosts,
    );
    if (!reconciled.accepted) {
      this.recordError({ targetId, code: "protocol", message: "target host binding changed" });
      return false;
    }
    if (reconciled.epochChanged) this.invalidateTargetLeases(targetId);
    this.replace({ targetHosts: reconciled.targetHosts, hosts: reconciled.hosts });
    this.applyProjection(targetId, frame);
    void this.bootstrapHost(targetId, frame);
    return true;
  }
  private bootstrapHost(targetId: string, frame: WelcomeFrame): void {
    void bootstrapDesktopHost({
      targetId,
      frame,
      issue: (intent) => this.stopped ? undefined : this.command(targetId, intent),
      onError: (error, code) => {
        this.recordError({
          targetId,
          code,
          message: error instanceof Error ? error.message : code === "transport" ? "host bootstrap command failed" : "invalid host bootstrap result",
        });
      },
    });
  }
  private applyProjection(targetId: string, frame: RendererServerFrame): void {
    if (this.stopped) return;
    this.projection.applyPublicFrame(frame as ProjectionFrame);
    if (this.current.targets.has(targetId)) this.replace({ projection: this.projection.getSnapshot() });
  }
  private notifyFrames(event: RendererServerFrameEvent): void {
    const hostIdValue = frameId(event.frame, "hostId");
    const sessionIdValue = frameId(event.frame, "sessionId");
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const { listener, filter } of [...this.frameListeners]) {
      if (filter !== undefined && (filter.targetId !== event.targetId || (filter.hostId !== undefined && filter.hostId !== hostIdValue) || (filter.sessionId !== undefined && filter.sessionId !== sessionIdValue) || (filter.types !== undefined && !filter.types.includes(event.frame.type)))) continue;
      try { listener(event); } catch { /* subscriber isolation */ }
    }
  }
  private applyTargets(targets: readonly DesktopTarget[]): void {
    const reconciled = this.hostState.reconcileTargets(
      this.current,
      targets,
      this.connectionGenerations.keys(),
    );
    for (const targetId of reconciled.removedTargetIds) {
      this.invalidateTargetLeases(targetId);
      this.connectionGenerations.delete(targetId);
    }
    this.replace({
      targets: reconciled.targets,
      connections: reconciled.connections,
      targetHosts: reconciled.targetHosts,
      hosts: reconciled.hosts,
    });
  }
  private upsertTarget(target: DesktopTarget): void {
    const targets = new Map(this.current.targets).set(target.targetId, targetCopy(target));
    const connections = new Map(this.current.connections).set(target.targetId, target.state);
    this.replace({ targets: mapValue(targets), connections: mapValue(connections) });
  }
  private updateConnection(targetId: string, state: DesktopTarget["state"]): void {
    const previous = this.current.connections.get(targetId);
    if (previous !== state) {
      this.connectionGenerations.set(targetId, this.generationFor(targetId) + 1);
      this.invalidateTargetLeases(targetId);
    }
    const connections = new Map(this.current.connections).set(targetId, state);
    const existing = this.current.targets.get(targetId);
    const targets = new Map(this.current.targets);
    if (existing !== undefined) targets.set(targetId, targetCopy({ ...existing, state }));
    this.replace({ connections: mapValue(connections), targets: mapValue(targets) });
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
