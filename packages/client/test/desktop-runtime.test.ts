import { describe, expect, it } from "vite-plus/test";
import { CLUSTER_OPERATOR_FEATURE, hostId, operationId, revision, sessionId, type SessionRef, type WelcomeFrame, type WorkspaceInfrastructureProjection, type WorkspaceStateFrame } from "@t4-code/protocol";
import { rendererServerEventFromFrame } from "@t4-code/protocol/desktop-ipc";
import type {
  BootstrapResult,
  CommandRequest,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  ConnectionStateEvent,
  ConnectResult,
  DesktopTarget,
  DisconnectResult,
  LocalProfileAddRequest,
  LocalProfileListResult,
  LocalProfileRemoveResult,
  LocalProfileRequest,
  LocalProfileResult,
  LocalProfileUpdateRequest,
  PairRequest,
  PairResult,
  RendererServerFrame,
  RendererServerEventEnvelope,
  RuntimeErrorEvent,
  SpeechResult,
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
import { createDesktopRuntimeController, type DesktopRuntimeController, type DesktopShellPort } from "../src/desktop-runtime.ts";
import { redactedMessage } from "../src/desktop-runtime-contracts.ts";
import { ProjectionStore } from "../src/projection.ts";
import { decodeProjectionCacheValue } from "../src/projection-cache.ts";
import {
  MAX_RETAINED_SESSION_EVENT_BYTES,
  retainedJsonBytes,
} from "../src/transcript-retention.ts";

const target = (targetId: string, state: DesktopTarget["state"] = "disconnected"): DesktopTarget => ({ targetId, label: targetId, kind: targetId === "local" ? "local" : "remote", state, paired: true });
const localProfile = (profileId: string) => ({
  profileId,
  label: profileId === "default" ? "Default" : "Fable Swarm",
  targetId: profileId === "default" ? "local" : `local:${profileId}`,
  autoStart: profileId === "default",
  isDefault: profileId === "default",
  service: { definition: "current" as const, service: "running" as const, diagnostics: "" },
});
const remoteTargetRequest = (targetId: string): TargetAddRequest => ({
  target: {
    targetId,
    label: targetId,
    mode: "direct",
    address: "100.64.0.1",
    port: 4210,
    requestedCapabilities: [],
    grantedCapabilities: [],
    status: "unknown",
  },
});
const welcome = (host: string, capabilities: readonly string[], features: readonly string[], epoch = "epoch-1"): WelcomeFrame => ({
  v: "omp-app/1", type: "welcome", selectedProtocol: "omp-app/1", hostId: hostId(host), ompVersion: "omp", ompBuild: "test", appserverVersion: "app", appserverBuild: "test", epoch, grantedCapabilities: [...capabilities], grantedFeatures: [...features], negotiatedLimits: {}, authentication: "local", resumed: false,
});
const workspaceInfrastructure = (workspaceId = "workspace-a"): WorkspaceInfrastructureProjection => ({
  id: workspaceId,
  displayName: "Operator workspace",
  phase: "Ready",
  retentionPolicy: "Retain",
  capacity: "20Gi",
  storageClass: "rwx",
  accessMode: "ReadWriteMany",
  revision: revision("workspace-r1"),
});
const workspaceState = (workspaceId = "workspace-event"): WorkspaceStateFrame => ({
  v: "omp-app/1",
  type: "workspace.state",
  hostId: hostId("host-a"),
  workspaceId,
  cursor: { epoch: "workspace-event-epoch", seq: 1 },
  revision: revision("workspace-event-r1"),
  upsert: { ...workspaceInfrastructure(workspaceId), revision: revision("workspace-event-r1") },
});
const sessionClusterState = Object.freeze({
  workspaceId: "workspace-session-a",
  phase: "Running" as const,
  gui: Object.freeze({ state: "Ready" as const, previewId: "preview-session-a" }),
});
const sessionCiState = Object.freeze({
  provider: "woodpecker" as const,
  correlation: "exact" as const,
  repositoryId: "repository-a",
  branch: "main",
  ref: "refs/heads/main",
  commit: "deadbeef",
  pipelineNumber: 42,
  status: "running" as const,
  currentStage: "test",
});
const sessionWithInfrastructure = (
  revisionValue: string,
  title: string,
  phase: string,
): SessionRef => Object.freeze({
  hostId: hostId("host-a"),
  project: Object.freeze({ projectId: "project-a" as never, name: "Project A" }),
  sessionId: sessionId("session-a"),
  revision: revision(revisionValue),
  title,
  status: "active",
  updatedAt: "2026-07-21T00:00:00Z",
  liveState: Object.freeze({
    phase,
    cluster: sessionClusterState,
    ci: sessionCiState,
  }),
  model: "model-a",
});
class FakeTimerScheduler {
  readonly timers = new Map<number, { readonly callback: () => void; readonly delayMs: number }>();
  private nextHandle = 1;
  setTimeout = (callback: () => void, delayMs: number): number => {
    const handle = this.nextHandle++;
    this.timers.set(handle, { callback, delayMs });
    return handle;
  };
  clearTimeout = (handle: unknown): void => { this.timers.delete(handle as number); };
  fireNext(): void {
    const next = this.timers.entries().next().value as [number, { readonly callback: () => void; readonly delayMs: number }] | undefined;
    if (next === undefined) return;
    this.timers.delete(next[0]);
    next[1].callback();
  }
}
class FakeShell implements DesktopShellPort {
  readonly kind = "desktop" as const;
  readonly platform = "linux" as const;
  readonly serverEvents = new Set<(event: RendererServerEventEnvelope) => void>();
  readonly states = new Set<(event: ConnectionStateEvent) => void>();
  readonly errors = new Set<(event: RuntimeErrorEvent) => void>();
  readonly wakes = new Set<() => void>();
  readonly commands: CommandRequest[] = [];
  rejectConnect = false;
  rejectLeaseCode: "outcome_unknown" | "stale" | "timeout" | undefined;
  hangRelease = false;
  promptExpiresAt: string | number = "2030-01-01T00:00:00.000Z";
  promptAcquireGate: Promise<void> | undefined;
  controllerAcquireGate: Promise<void> | undefined;
  controllerRenewGate: Promise<void> | undefined;
  stopSpeakingGate: Promise<void> | undefined;
  stopSpeakingCalls = 0;
  bootstrapCalls = 0;
  connectCalls = 0;
  emitWelcomeOnBootstrap: TestServerFrameEnvelope | undefined;
  listedTargets: DesktopTarget[] = [target("local")];
  sessionListAccepted = true;
  sessionListResult: unknown = { cursor: { epoch: "epoch-1", seq: 7 }, sessions: [], totalCount: 0, truncated: false };
  sessionListResults: unknown[] = [];
  sessionListError: Error | undefined;
  sessionListResultMissing = false;
  sessionListGate: Promise<void> | undefined;
  workspaceListGate: Promise<void> | undefined;
  catalogResult: unknown = { revision: "catalog-1", items: [] };
  settingsResult: unknown = { revision: "settings-1", settings: {} };
  workspaceListResult: unknown = {
    cursor: { epoch: "workspace-epoch", seq: 1 },
    workspaces: [workspaceInfrastructure()],
  };
  private sessionListGateResolve: (() => void) | undefined;
  private workspaceListGateResolve: (() => void) | undefined;
  deferNextSessionList(): void {
    this.sessionListGate = new Promise<void>((resolve) => { this.sessionListGateResolve = resolve; });
  }
  resolveSessionList(): void {
    const resolve = this.sessionListGateResolve;
    this.sessionListGateResolve = undefined;
    resolve?.();
  }
  deferNextWorkspaceList(): void {
    this.workspaceListGate = new Promise<void>((resolve) => { this.workspaceListGateResolve = resolve; });
  }
  resolveWorkspaceList(): void {
    const resolve = this.workspaceListGateResolve;
    this.workspaceListGateResolve = undefined;
    resolve?.();
  }
  async bootstrap(): Promise<BootstrapResult> { this.bootstrapCalls += 1; if (this.emitWelcomeOnBootstrap !== undefined) this.emitFrame(this.emitWelcomeOnBootstrap); return { platform: "linux", version: "omp-app/1", connected: false }; }
  async listTargets(): Promise<TargetListResult> { return { targets: Object.freeze([...this.listedTargets]) }; }
  async connectTarget(request: TargetRequest): Promise<ConnectResult> { this.connectCalls += 1; if (this.rejectConnect) throw new Error("appserver unavailable"); this.emitState({ targetId: request.targetId, state: "connected" }); return { targetId: request.targetId, state: "connected" }; }
  async connect(request: TargetRequest): Promise<ConnectResult> { return this.connectTarget(request); }
  async disconnect(request: TargetRequest): Promise<DisconnectResult> { return this.disconnectTarget(request); }
  async disconnectTarget(request: TargetRequest): Promise<DisconnectResult> { this.emitState({ targetId: request.targetId, state: "disconnected" }); return { targetId: request.targetId, state: "disconnected" }; }
  async command(request: CommandRequest): Promise<CommandResult & Record<string, unknown>> {
    this.commands.push(request);
    if (request.intent.command.startsWith("controller.lease")) {
      if (this.rejectLeaseCode !== undefined) {
        const error = new Error("lease rejected");
        Object.defineProperty(error, "code", { value: this.rejectLeaseCode, enumerable: true });
        throw error;
      }
      if (request.intent.command === "controller.lease.acquire" && this.controllerAcquireGate !== undefined) await this.controllerAcquireGate;
      if (request.intent.command === "controller.lease.renew" && this.controllerRenewGate !== undefined) await this.controllerRenewGate;
      if (request.intent.command === "controller.lease.release" && this.hangRelease) return new Promise<CommandResult & Record<string, unknown>>(() => undefined);
      const base = { targetId: request.targetId, requestId: `${request.targetId}-lease-request`, commandId: `${request.targetId}-lease-command`, accepted: true };
      if (request.intent.command === "controller.lease.release") return base;
      return { ...base, leaseId: "lease-fixture", expiresAt: "2030-01-01T00:00:00.000Z", cursor: "cursor-fixture" };
    }
    if (request.intent.command.startsWith("prompt.lease")) {
      if (this.rejectLeaseCode !== undefined) {
        const error = new Error("prompt lease rejected");
        Object.defineProperty(error, "code", { value: this.rejectLeaseCode, enumerable: true });
        throw error;
      }
      if (request.intent.command === "prompt.lease.release" && this.hangRelease) return new Promise<CommandResult & Record<string, unknown>>(() => undefined);
      if (request.intent.command === "prompt.lease.acquire" && this.promptAcquireGate !== undefined) await this.promptAcquireGate;
      const base = { targetId: request.targetId, requestId: `${request.targetId}-prompt-lease-request`, commandId: `${request.targetId}-prompt-lease-command`, accepted: true };
      if (request.intent.command === "prompt.lease.release") return base;
      return { ...base, leaseId: "prompt-lease-fixture", expiresAt: this.promptExpiresAt };
    }
    const base = { targetId: request.targetId, requestId: `${request.targetId}-same-request`, commandId: `${request.targetId}-same-command`, accepted: true };
    if (request.intent.command === "session.list") {
      const result = this.sessionListResults.shift() ?? this.sessionListResult;
      const sessionListError = this.sessionListError;
      const gate = this.sessionListGate;
      this.sessionListGate = undefined;
      if (gate !== undefined) await gate;
      if (sessionListError !== undefined) throw sessionListError;
      return { ...base, accepted: this.sessionListAccepted, ...(this.sessionListResultMissing ? {} : { result }) };
    }
    if (request.intent.command === "catalog.get") return { ...base, result: this.catalogResult };
    if (request.intent.command === "settings.read") return { ...base, result: this.settingsResult };
    if (request.intent.command === "workspace.list") {
      const gate = this.workspaceListGate;
      this.workspaceListGate = undefined;
      if (gate !== undefined) await gate;
      return { ...base, result: this.workspaceListResult };
    }
    return base;
  }
  async pair(request: PairRequest): Promise<PairResult> { return { targetId: request.targetId, paired: true }; }
  async addTarget(request: TargetAddRequest): Promise<TargetAddResult> { return { target: target(request.target.targetId) }; }
  async removeTarget(request: TargetRequest): Promise<TargetRemoveResult> { return { targetId: request.targetId, removed: true }; }
  async listProfiles(): Promise<LocalProfileListResult> {
    return { profiles: [localProfile("default"), localProfile("fable-swarm")] };
  }
  async addProfile(request: LocalProfileAddRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profile.profileId) };
  }
  async updateProfile(request: LocalProfileUpdateRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profileId) };
  }
  async removeProfile(request: LocalProfileRequest): Promise<LocalProfileRemoveResult> {
    return { profileId: request.profileId, removed: true };
  }
  async profileStatus(request: LocalProfileRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profileId) };
  }
  async profileStart(request: LocalProfileRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profileId) };
  }
  async profileStop(request: LocalProfileRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profileId) };
  }
  async profileRestart(request: LocalProfileRequest): Promise<LocalProfileResult> {
    return { profile: localProfile(request.profileId) };
  }
  onServerEvent(listener: (event: RendererServerEventEnvelope) => void): () => void { this.serverEvents.add(listener); return () => this.serverEvents.delete(listener); }
  onConnectionState(listener: (event: ConnectionStateEvent) => void): () => void { this.states.add(listener); return () => this.states.delete(listener); }
  onRuntimeError(listener: (event: RuntimeErrorEvent) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  onWake(listener: () => void): () => void { this.wakes.add(listener); return () => this.wakes.delete(listener); }
  emitFrame(event: TestServerFrameEnvelope): void {
    const envelope = {
      targetId: event.targetId,
      event: rendererServerEventFromFrame(event.frame),
    };
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.serverEvents]) listener(envelope);
  }
  emitState(event: ConnectionStateEvent): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.states]) listener(event);
  }
  emitWake(): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.wakes]) listener();
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> { return { targetId: request.targetId, requestId: "confirm-request", confirmationId: request.confirmationId, commandId: request.commandId, accepted: true }; }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  async stopSpeaking(): Promise<SpeechResult> {
    this.stopSpeakingCalls += 1;
    if (this.stopSpeakingGate !== undefined) await this.stopSpeakingGate;
    return { accepted: true };
  }
  emitError(event: RuntimeErrorEvent): void {
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.errors]) listener(event);
  }
}

const leaseIntent = (args: Record<string, unknown> = {}): CommandRequest["intent"] => ({
  hostId: hostId("host-remote"),
  sessionId: sessionId("session-a"),
  command: "session.prompt",
  expectedRevision: revision("revision-a"),
  args,
});
async function leaseRuntime(
  features: readonly string[],
  options: { readonly clock?: { now(): number } } = {},
): Promise<{ readonly shell: FakeShell; readonly runtime: DesktopRuntimeController }> {
  const shell = new FakeShell();
  const runtime = createDesktopRuntimeController({ shell, ...options });
  await runtime.start();
  await runtime.addTarget(remoteTargetRequest("remote"));
  shell.emitState({ targetId: "remote", state: "connected" });
  shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], features) });
  await Promise.resolve();
  return { shell, runtime };
}
const sessionInventory = (host: string, epoch: string, name: string) => ({
  cursor: { epoch, seq: 1 },
  sessions: [{
    hostId: hostId(host),
    project: { projectId: `project-${name}` as never },
    sessionId: sessionId(`session-${name}`),
    revision: revision(`revision-${name}`),
    title: name,
    status: "idle",
    updatedAt: "2026-07-16T00:00:00Z",
  }],
  totalCount: 1,
  truncated: false,
});
describe("desktop runtime projection", () => {
  it("keeps the optional profile bridge structurally typed on DesktopShellPort", async () => {
    const shell: DesktopShellPort = new FakeShell();
    expect(await shell.listProfiles?.()).toEqual({
      profiles: [localProfile("default"), localProfile("fable-swarm")],
    });
    expect(await shell.profileStart?.({ profileId: "fable-swarm" })).toEqual({
      profile: localProfile("fable-swarm"),
    });
    expect(await shell.removeProfile?.({ profileId: "fable-swarm" })).toEqual({
      profileId: "fable-swarm",
      removed: true,
    });
  });

  it("redacts auth secrets and Linux/macOS home paths at the renderer boundary", () => {
    const safe = redactedMessage(
      [
        "Authorization: Bearer BEARER_SECRET authorization=Basic BASIC_SECRET",
        "Bearer BARE_BEARER_SECRET Basic BARE_BASIC_SECRET",
        "ws://alice:WS_SECRET@tailnet.local/private/path",
        "wss://tailnet.local/socket?token=QUERY_SECRET",
        "/Users/alice/Library/Application Support/T4 Code/auth.json",
        "at (/Users/alice/private/main.js:1:2)",
        "path=/home/alice/.config/t4-code/auth.json",
        "cwd=/home/alice/My Project",
        "file:///Users/alice/private/file.ts",
        '{"token":"TOPSECRET"}',
        '{"authorization":"Bearer JSON_SECRET"}',
        'token="secret with spaces"',
        "password='two words'",
        "access_token=ACCESS_SECRET",
        "client_secret=CLIENT_SECRET",
        "api_key=API_SECRET",
      ].join("\n"),
    );
    for (const leaked of [
      "BEARER_SECRET",
      "BASIC_SECRET",
      "BARE_BEARER_SECRET",
      "BARE_BASIC_SECRET",
      "WS_SECRET",
      "QUERY_SECRET",
      "TOPSECRET",
      "JSON_SECRET",
      "secret with spaces",
      "two words",
      "ACCESS_SECRET",
      "CLIENT_SECRET",
      "API_SECRET",
      "alice",
      "auth.json",
      "main.js",
      "file.ts",
      "tailnet.local",
      "/Users/alice",
      "/home/alice",
      "Application Support/Secret",
    ]) expect(safe).not.toContain(leaked);
  });
  it("subscribes before bootstrap, connects local once, and bootstraps negotiated capabilities", async () => {
    const shell = new FakeShell();
    shell.emitWelcomeOnBootstrap = { targetId: "local", frame: welcome("host-a", ["sessions.read", "catalog.read", "config.read"], ["host.watch", "catalog.metadata", "settings.metadata"]) };
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    expect(shell.bootstrapCalls).toBe(1);
    expect(shell.connectCalls).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.map((command) => command.intent.command)).toEqual(["session.list", "host.watch", "catalog.get", "settings.read"]);
    expect(shell.commands.find((command) => command.intent.command === "host.watch")).toEqual({
      targetId: "local",
      intent: { hostId: hostId("host-a"), command: "host.watch", args: { cursor: { epoch: "epoch-1", seq: 7 } } },
    });
    expect(runtime.getSnapshot().targetHosts.get("local")).toBe("host-a");
  });
  it.each([
    { authority: "the feature is default-off and unnegotiated", enabled: false, capabilities: [], features: [], granted: false },
    { authority: "only the host claim is present", enabled: false, capabilities: ["sessions.read"], features: [CLUSTER_OPERATOR_FEATURE], granted: false },
    { authority: "cluster.operator was not negotiated", enabled: true, capabilities: ["sessions.read"], features: [], granted: false },
    { authority: "sessions.read was not negotiated", enabled: true, capabilities: [], features: [CLUSTER_OPERATOR_FEATURE], granted: false },
    { authority: "the effective cluster projection grant is present", enabled: true, capabilities: ["sessions.read"], features: [CLUSTER_OPERATOR_FEATURE], granted: true },
  ])("normalizes sessions and session.delta infrastructure metadata when $authority", async ({ enabled, capabilities, features, granted }) => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, clusterOperatorEnabled: enabled });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", capabilities, features) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const delivered: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents(
      { targetId: "local", kinds: ["sessions", "session.delta"] },
      (event) => delivered.push(event),
    );

    const listed = sessionWithInfrastructure("revision-listed", "Listed session", "idle");
    const sessionsFrame = Object.freeze({
      v: "omp-app/1" as const,
      type: "sessions" as const,
      hostId: hostId("host-a"),
      cursor: Object.freeze({ epoch: "epoch-1", seq: 8 }),
      sessions: Object.freeze([listed]),
      totalCount: 1,
      truncated: false,
    });
    shell.emitFrame({ targetId: "local", frame: sessionsFrame as unknown as RendererServerFrame });

    const listedProjection = runtime.getSnapshot().projection.sessionIndex.get("host-a\u0000session-a");
    expect(listedProjection).toMatchObject({
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      project: { projectId: "project-a", name: "Project A" },
      revision: revision("revision-listed"),
      title: "Listed session",
      status: "active",
      liveState: { phase: "idle" },
      model: "model-a",
    });
    expect(listedProjection?.liveState).toEqual(granted ? listed.liveState : { phase: "idle" });

    const changed = sessionWithInfrastructure("revision-delta", "Updated session", "running");
    const deltaFrame = Object.freeze({
      v: "omp-app/1" as const,
      type: "session.delta" as const,
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      cursor: Object.freeze({ epoch: "delta-epoch", seq: 1 }),
      revision: revision("revision-delta"),
      upsert: changed,
    });
    shell.emitFrame({ targetId: "local", frame: deltaFrame as unknown as RendererServerFrame });

    const changedProjection = runtime.getSnapshot().projection.sessionIndex.get("host-a\u0000session-a");
    expect(changedProjection).toMatchObject({
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      revision: revision("revision-delta"),
      title: "Updated session",
      status: "active",
      liveState: { phase: "running" },
      model: "model-a",
    });
    expect(changedProjection?.liveState).toEqual(granted ? changed.liveState : { phase: "running" });
    expect(delivered.map((event) => event.event.kind)).toEqual(["sessions", "session.delta"]);
    const listedEvent = delivered[0]?.event;
    const deltaEvent = delivered[1]?.event;
    if (listedEvent?.kind !== "sessions" || deltaEvent?.kind !== "session.delta") throw new Error("expected session inventory events");
    expect(listedEvent.payload.sessions[0]).toMatchObject({
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      title: "Listed session",
      liveState: { phase: "idle" },
    });
    expect(listedEvent.payload.sessions[0]?.liveState).toEqual(granted ? listed.liveState : { phase: "idle" });
    expect(deltaEvent.payload.upsert).toMatchObject({
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      title: "Updated session",
      liveState: { phase: "running" },
    });
    expect(deltaEvent.payload.upsert?.liveState).toEqual(granted ? changed.liveState : { phase: "running" });
    expect(listed.liveState).toEqual({ phase: "idle", cluster: sessionClusterState, ci: sessionCiState });
    expect(changed.liveState).toEqual({ phase: "running", cluster: sessionClusterState, ci: sessionCiState });
  });
  it.each([
    { enabled: false, capabilities: ["sessions.read"], features: [CLUSTER_OPERATOR_FEATURE] },
    { enabled: true, capabilities: ["sessions.read"], features: [] },
    { enabled: true, capabilities: [], features: [CLUSTER_OPERATOR_FEATURE] },
  ])("clears retained workspaces and rejects workspace.list projection without every authority gate", async ({ enabled, capabilities, features }) => {
    const projection = new ProjectionStore();
    projection.replaceWorkspaceInventory(
      "host-a",
      [workspaceInfrastructure()],
      { epoch: "retained-workspace", seq: 4 },
    );
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({
      shell,
      projection,
      clusterOperatorEnabled: enabled,
    });

    expect(runtime.getSnapshot().projection.workspaces.size).toBe(0);
    expect(runtime.getSnapshot().projection.workspaceCursors.size).toBe(0);
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", capabilities, features) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await expect(runtime.command("local", {
      hostId: hostId("host-a"),
      command: "workspace.list",
      args: {},
    })).rejects.toMatchObject({ code: "stale" });

    expect(runtime.getSnapshot().projection.workspaces.size).toBe(0);
    expect(runtime.getSnapshot().projection.workspaceCursors.size).toBe(0);
  });
  it.each([
    { authority: "the feature flag is off", enabled: false, capabilities: ["sessions.read"], features: [CLUSTER_OPERATOR_FEATURE], granted: false },
    { authority: "cluster.operator was not negotiated", enabled: true, capabilities: ["sessions.read"], features: [], granted: false },
    { authority: "the effective cluster projection grant is present", enabled: true, capabilities: ["sessions.read"], features: [CLUSTER_OPERATOR_FEATURE], granted: true },
  ])("gates workspace.state projection and renderer delivery when $authority", async ({ enabled, capabilities, features, granted }) => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, clusterOperatorEnabled: enabled });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", capabilities, features) });
    const deliveredKinds: string[] = [];
    runtime.subscribeEvents((event) => deliveredKinds.push(event.event.kind));

    shell.emitFrame({ targetId: "local", frame: workspaceState() });
    shell.emitFrame({ targetId: "local", frame: { v: "omp-app/1", type: "catalog", hostId: hostId("host-a"), revision: revision("catalog-event-r1"), items: [] } });

    expect(runtime.getSnapshot().projection.workspaces.has("host-a\u0000workspace-event")).toBe(granted);
    expect(deliveredKinds).toEqual(granted ? ["workspace.state", "catalog"] : ["catalog"]);
  });
  it("rejects an in-flight workspace.list result after same-epoch authority withdrawal", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, clusterOperatorEnabled: true });
    await runtime.start();
    shell.emitFrame({
      targetId: "local",
      frame: welcome("host-a", ["sessions.read"], [CLUSTER_OPERATOR_FEATURE]),
    });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    const responses: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents((event) => { if (event.event.kind === "response") responses.push(event); });
    const authorized = await runtime.command("local", {
      hostId: hostId("host-a"),
      command: "workspace.list",
      args: {},
    });
    expect(authorized.result).toEqual(shell.workspaceListResult);
    expect(responses).toHaveLength(1);

    shell.deferNextWorkspaceList();
    const pending = runtime.command("local", {
      hostId: hostId("host-a"),
      command: "workspace.list",
      args: {},
    });
    await Promise.resolve();
    shell.emitFrame({
      targetId: "local",
      frame: welcome("host-a", ["sessions.read"], [], "epoch-1"),
    });
    shell.resolveWorkspaceList();

    await expect(pending).rejects.toMatchObject({ code: "stale" });
    expect(responses).toHaveLength(1);
    expect(runtime.getSnapshot().projection.workspaces.size).toBe(0);
    const ordinary = await runtime.command("local", {
      hostId: hostId("host-a"),
      command: "session.prompt",
      args: { prompt: "hello" },
    });
    expect(ordinary.accepted).toBe(true);
  });
  it("purges retained workspace cache before any current host grant", async () => {
    const saves: string[] = [];
    const projection = new ProjectionStore({
      cacheStore: {
        load: () => undefined,
        save: (serialized) => { saves.push(serialized); },
      },
    });
    await projection.ready();
    projection.replaceWorkspaceInventory(
      "host-a",
      [workspaceInfrastructure()],
      { epoch: "retained-workspace", seq: 4 },
    );
    await projection.flush();
    expect(decodeProjectionCacheValue(saves.at(-1))?.workspaces.size).toBe(1);

    const runtime = createDesktopRuntimeController({
      shell: new FakeShell(),
      projection,
      clusterOperatorEnabled: true,
    });
    await projection.flush();

    const clearedCache = decodeProjectionCacheValue(saves.at(-1));
    expect(runtime.getSnapshot().projection.workspaces.size).toBe(0);
    expect(clearedCache?.workspaces.size).toBe(0);
    expect(clearedCache?.workspaceCursors.size).toBe(0);
  });
  it("clears retained workspaces when a host withdraws the cluster operator grant", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, clusterOperatorEnabled: true });
    await runtime.start();
    shell.emitFrame({
      targetId: "local",
      frame: welcome("host-a", ["sessions.read"], [CLUSTER_OPERATOR_FEATURE]),
    });
    for (let index = 0; index < 12; index += 1) await Promise.resolve();

    expect(runtime.getSnapshot().projection.workspaces.get("host-a\u0000workspace-a")?.phase).toBe("Ready");
    expect(runtime.getSnapshot().projection.workspaceCursors.get("host-a")).toEqual({
      epoch: "workspace-epoch",
      seq: 1,
    });

    shell.emitFrame({
      targetId: "local",
      frame: welcome("host-a", ["sessions.read"], [], "epoch-2"),
    });
    expect(runtime.getSnapshot().projection.workspaces.size).toBe(0);
    expect(runtime.getSnapshot().projection.workspaceCursors.size).toBe(0);
  });
  it("preserves operation capabilities from catalog responses and live catalog frames", async () => {
    const shell = new FakeShell();
    shell.catalogResult = {
      revision: "catalog-response",
      items: [],
      operations: [{
        operationId: "slash.compact",
        label: "/compact",
        execution: "headless",
        supported: true,
      }],
    };
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", [], []) });

    await runtime.command("local", {
      hostId: hostId("host-a"),
      command: "catalog.get",
      args: {},
    });
    expect(runtime.getSnapshot().catalogs.get("host-a")?.operations).toMatchObject([
      { operationId: "slash.compact", execution: "headless", supported: true },
    ]);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: "omp-app/1",
        type: "catalog",
        hostId: hostId("host-a"),
        revision: revision("catalog-live"),
        items: [],
        operations: [{
          operationId: operationId("slash.plan"),
          label: "/plan",
          execution: "terminal-only",
          supported: false,
          disabledReason: {
            code: "terminal_only",
            message: "This command requires the OMP terminal interface.",
          },
        }],
      },
    });
    expect(runtime.getSnapshot().catalogs.get("host-a")?.operations).toMatchObject([
      {
        operationId: "slash.plan",
        execution: "terminal-only",
        supported: false,
        disabledReason: { code: "terminal_only" },
      },
    ]);
  });
  it("refreshes inventory on cadence so a session started after bootstrap appears without reconnect", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    shell.sessionListResults = [
      { cursor: { epoch: "epoch-1", seq: 1 }, sessions: [], totalCount: 0, truncated: false },
      {
        cursor: { epoch: "epoch-1", seq: 2 },
        sessions: [{
          hostId: hostId("host-a"),
          project: { projectId: "project-a" as never },
          sessionId: sessionId("session-new"),
          revision: revision("revision-new"),
          title: "New session",
          status: "idle",
          updatedAt: "2026-07-16T00:00:00Z",
        }],
        totalCount: 1,
        truncated: false,
      },
    ];
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(timers.timers.size).toBe(1);
    timers.fireNext();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has("host-a\u0000session-new")).toBe(true);
  });
  it("discards a delayed inventory response after reconnecting to a new host generation", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    shell.sessionListResult = {
      cursor: { epoch: "epoch-1", seq: 1 },
      sessions: [],
      totalCount: 0,
      truncated: false,
    };
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const oldSessionKey = "host-a\u0000session-old";
    shell.sessionListResult = {
      cursor: { epoch: "epoch-1", seq: 2 },
      sessions: [{
        hostId: hostId("host-a"),
        project: { projectId: "project-a" as never },
        sessionId: sessionId("session-old"),
        revision: revision("revision-old"),
        title: "Old session",
        status: "idle",
        updatedAt: "2026-07-16T00:00:00Z",
      }],
      totalCount: 1,
      truncated: false,
    };

    shell.deferNextSessionList();
    timers.fireNext();
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.list")).toHaveLength(2);

    shell.sessionListResult = {
      cursor: { epoch: "epoch-2", seq: 2 },
      sessions: [{
        hostId: hostId("host-b"),
        project: { projectId: "project-b" as never },
        sessionId: sessionId("session-new"),
        revision: revision("revision-new"),
        title: "New session",
        status: "idle",
        updatedAt: "2026-07-16T00:00:01Z",
      }],
      totalCount: 1,
      truncated: false,
    };
    await runtime.removeTarget("local");
    await runtime.addTarget(remoteTargetRequest("local"));
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-b", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const newSessionKey = "host-b\u0000session-new";
    expect(runtime.getSnapshot().targetHosts.get("local")).toBe("host-b");
    expect(runtime.getSnapshot().projection.sessionIndex.has(newSessionKey)).toBe(true);
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldSessionKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-a")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-b")).toBe(true);

    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldSessionKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has(newSessionKey)).toBe(true);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-a")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-b")).toBe(true);
  });
  it("discards a delayed bootstrap inventory response after reconnecting to a new host generation", async () => {
    const shell = new FakeShell();
    shell.sessionListResult = {
      cursor: { epoch: "epoch-1", seq: 1 },
      sessions: [{
        hostId: hostId("host-a"),
        project: { projectId: "project-a" as never },
        sessionId: sessionId("session-old"),
        revision: revision("revision-old"),
        title: "Old session",
        status: "idle",
        updatedAt: "2026-07-16T00:00:00Z",
      }],
      totalCount: 1,
      truncated: false,
    };
    shell.deferNextSessionList();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.list")).toHaveLength(1);

    shell.sessionListResult = {
      cursor: { epoch: "epoch-2", seq: 2 },
      sessions: [{
        hostId: hostId("host-b"),
        project: { projectId: "project-b" as never },
        sessionId: sessionId("session-new"),
        revision: revision("revision-new"),
        title: "New session",
        status: "idle",
        updatedAt: "2026-07-16T00:00:01Z",
      }],
      totalCount: 1,
      truncated: false,
    };
    await runtime.removeTarget("local");
    await runtime.addTarget(remoteTargetRequest("local"));
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-b", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const oldSessionKey = "host-a\u0000session-old";
    const newSessionKey = "host-b\u0000session-new";
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldSessionKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has(newSessionKey)).toBe(true);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-a")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-b")).toBe(true);

    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldSessionKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has(newSessionKey)).toBe(true);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-a")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-b")).toBe(true);
  });
  it("rejects an old-epoch bootstrap success for the same host", async () => {
    const shell = new FakeShell();
    shell.sessionListResult = sessionInventory("host-a", "epoch-1", "old-bootstrap");
    shell.deferNextSessionList();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") });
    await Promise.resolve();
    shell.sessionListResult = sessionInventory("host-a", "epoch-2", "new-bootstrap");
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const oldKey = "host-a\u0000session-old-bootstrap";
    const newKey = "host-a\u0000session-new-bootstrap";
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has(newKey)).toBe(true);
    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has(oldKey)).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has(newKey)).toBe(true);
  });
  it("rejects an old-epoch bootstrap error for the same host", async () => {
    const shell = new FakeShell();
    shell.sessionListError = new Error("old bootstrap failure");
    shell.deferNextSessionList();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") });
    await Promise.resolve();
    shell.sessionListError = undefined;
    shell.sessionListResult = sessionInventory("host-a", "epoch-2", "new-bootstrap");
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().runtimeErrors.some((entry) => entry.message.includes("old bootstrap failure"))).toBe(false);
  });
  it("coalesces duplicate lifecycle wakes while one inventory refresh is in flight", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const before = shell.commands.filter((command) => command.intent.command === "session.list").length;
    shell.emitWake();
    shell.emitWake();
    expect(shell.commands.filter((command) => command.intent.command === "session.list")).toHaveLength(before + 1);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
  it("keeps truncated refreshes read-only inventory truth", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.sessionListResult = {
      cursor: { epoch: "epoch-1", seq: 8 },
      sessions: [],
      totalCount: 4,
      truncated: true,
    };
    shell.emitWake();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.get("host-a")).toEqual({ totalCount: 4, truncated: true });
  });
  it("retries an inventory refresh on the next cadence after an error", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.sessionListError = new Error("temporary inventory failure");
    timers.fireNext();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(timers.timers.size).toBe(1);
    shell.sessionListError = undefined;
    timers.fireNext();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.list").length).toBe(3);
  });
  it("rejects an old-epoch cadence success for the same host", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    shell.sessionListResult = sessionInventory("host-a", "epoch-1", "old-cadence");
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.deferNextSessionList();
    timers.fireNext();
    shell.sessionListResult = sessionInventory("host-a", "epoch-2", "new-cadence");
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has("host-a\u0000session-old-cadence")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.has("host-a\u0000session-new-cadence")).toBe(true);
  });
  it("rejects an old-epoch cadence error for the same host", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.sessionListError = new Error("old cadence failure");
    shell.deferNextSessionList();
    timers.fireNext();
    shell.sessionListError = undefined;
    shell.sessionListResult = sessionInventory("host-a", "epoch-2", "new-cadence");
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.resolveSessionList();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().runtimeErrors.some((entry) => entry.message.includes("old cadence failure"))).toBe(false);
  });
  it("clears inventory timers and wake listeners on stop and target removal", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], []) });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(timers.timers.size).toBe(1);
    expect(shell.wakes.size).toBe(1);
    await runtime.removeTarget("local");
    expect(timers.timers.size).toBe(0);
    expect(shell.wakes.size).toBe(1);
    await runtime.stop();
    expect(shell.wakes.size).toBe(0);
  });
  it("keeps post-welcome inventory when connected is reported afterward", async () => {
    const shell = new FakeShell();
    shell.emitWelcomeOnBootstrap = {
      targetId: "local",
      frame: welcome("host-a", [], []),
    };
    shell.connectTarget = async (request: TargetRequest): Promise<ConnectResult> => {
      shell.emitFrame({
        targetId: request.targetId,
        frame: {
          v: "omp-app/1",
          type: "sessions",
          hostId: hostId("host-a"),
          cursor: { epoch: "epoch-1", seq: 0 },
          sessions: [
            {
              hostId: hostId("host-a"),
              project: { projectId: "project-a" as never },
              sessionId: sessionId("session-a"),
              revision: revision("revision-a"),
              title: "Session A",
              status: "idle",
              updatedAt: "2026-07-15T00:00:00Z",
            },
          ],
          totalCount: 1,
          truncated: false,
        },
      });
      shell.emitState({ targetId: request.targetId, state: "connected" });
      return { targetId: request.targetId, state: "connected" };
    };
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();

    expect(runtime.getSnapshot().projection.sessionIndexMetadata.get("host-a")).toEqual({
      totalCount: 1,
      truncated: false,
    });
    shell.emitState({ targetId: "local", state: "disconnected" });
    expect(runtime.getSnapshot().projection.sessionIndexMetadata.has("host-a")).toBe(false);
    expect(runtime.getSnapshot().projection.sessionIndex.size).toBe(1);
  });
  it("skips host.watch when session.list is rejected and continues independent bootstrap", async () => {
    const shell = new FakeShell();
    shell.sessionListAccepted = false;
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read", "catalog.read", "config.read"], ["host.watch", "catalog.metadata", "settings.metadata"]) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.map((command) => command.intent.command)).toEqual(["session.list", "catalog.get", "settings.read"]);
  });
  it("skips host.watch when session.list is malformed and records a bounded protocol error", async () => {
    const shell = new FakeShell();
    shell.sessionListResult = { cursor: { epoch: "epoch-1", seq: "invalid" }, sessions: [] };
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read", "catalog.read", "config.read"], ["host.watch", "catalog.metadata", "settings.metadata"]) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.map((command) => command.intent.command)).toEqual(["session.list", "catalog.get", "settings.read"]);
    expect(runtime.getSnapshot().runtimeErrors.at(-1)?.code).toBe("protocol");
  });
  it("skips host.watch when session.list has no result, records protocol error, and continues independent bootstrap", async () => {
    const shell = new FakeShell();
    shell.sessionListResultMissing = true;
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read", "catalog.read", "config.read"], ["host.watch", "catalog.metadata", "settings.metadata"]) });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.map((command) => command.intent.command)).toEqual(["session.list", "catalog.get", "settings.read"]);
    expect(runtime.getSnapshot().runtimeErrors.at(-1)?.code).toBe("protocol");
  });
  it("keeps lifecycle live when initial local connect fails", async () => {
    const shell = new FakeShell();
    shell.rejectConnect = true;
    const runtime = createDesktopRuntimeController({ shell });
    const started = await runtime.start();
    expect(started.startState).toBe("started");
    expect(started.runtimeErrors.at(-1)?.targetId).toBe("local");
    shell.rejectConnect = false;
    await runtime.connect("local");
    expect(runtime.getSnapshot().connections.get("local")).toBe("connected");
  });
  it("removes a target's host binding and owned host metadata", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    await runtime.addTarget(remoteTargetRequest("removed"));
    shell.emitFrame({ targetId: "removed", frame: welcome("shared-host", [], []) });
    expect(runtime.getSnapshot().targetHosts.get("removed")).toBe("shared-host");
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("removed");

    await runtime.removeTarget("removed");

    expect(runtime.getSnapshot().targets.has("removed")).toBe(false);
    expect(runtime.getSnapshot().connections.has("removed")).toBe(false);
    expect(runtime.getSnapshot().targetHosts.has("removed")).toBe(false);
    expect(runtime.getSnapshot().hosts.has("shared-host")).toBe(false);
  });
  it("restores host metadata from a surviving binding when its duplicate owner is removed", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("shared-host", [], []) });
    await runtime.addTarget(remoteTargetRequest("remote"));
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "remote", state: "connected" });
    shell.emitFrame({ targetId: "remote", frame: welcome("shared-host", [], []) });
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("remote");

    await runtime.removeTarget("remote");

    expect(runtime.getSnapshot().targetHosts.get("local")).toBe("shared-host");
    expect(runtime.getSnapshot().targetHosts.has("remote")).toBe(false);
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("local");
  });
  it("prunes removed target bindings during authoritative list reconciliation", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    await runtime.addTarget(remoteTargetRequest("stale"));
    shell.emitFrame({ targetId: "stale", frame: welcome("stale-host", [], []) });

    await runtime.listTargets();

    expect(runtime.getSnapshot().targets.has("stale")).toBe(false);
    expect(runtime.getSnapshot().connections.has("stale")).toBe(false);
    expect(runtime.getSnapshot().targetHosts.has("stale")).toBe(false);
    expect(runtime.getSnapshot().hosts.has("stale-host")).toBe(false);
  });
  it("keeps target attribution and rejects spoofed host frames", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    const seen: string[] = [];
    runtime.subscribeEvents((event) => seen.push(event.targetId));
    shell.emitFrame({ targetId: "one", frame: welcome("host-one", [], []) });
    shell.emitFrame({ targetId: "two", frame: welcome("host-two", [], []) });
    shell.emitFrame({ targetId: "one", frame: { v: "omp-app/1", type: "catalog", hostId: hostId("host-two"), revision: revision("revision-1"), items: [] } });
    expect(seen).toEqual(["one", "two"]);
    expect(runtime.getSnapshot().runtimeErrors.at(-1)?.code).toBe("protocol");
  });
  it("delivers only a bounded immutable tool event to renderer subscribers", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", [], []) });
    const normalized: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents(
      {
        targetId: "local",
        hostId: "host-a",
        sessionId: "session-a",
        kinds: ["event"],
      },
      (event) => normalized.push(event),
    );
    const rawOutput = `command-head\n${"x".repeat(300_000)}\ncommand-tail`;
    const rawFrame = {
      v: "omp-app/1" as const,
      type: "event" as const,
      cursor: { epoch: "epoch-1", seq: 1 },
      hostId: hostId("host-a"),
      sessionId: sessionId("session-a"),
      event: {
        type: "tool.result",
        callId: "call-large",
        result: {
          images: [{ sha256: "c".repeat(64), mimeType: "image/png" }],
          output: rawOutput,
        },
      },
    };

    shell.emitFrame({ targetId: "local", frame: rawFrame });

    expect(rawFrame.event.result.output).toHaveLength(rawOutput.length);
    expect(normalized).toHaveLength(1);
    const deliveredEvent = normalized[0]?.event;
    if (deliveredEvent?.kind !== "event") throw new Error("expected a retained normalized event");
    expect(Object.isFrozen(deliveredEvent.payload)).toBe(true);
    expect(deliveredEvent.payload).not.toHaveProperty("v");
    expect(deliveredEvent.payload).not.toHaveProperty("type");
    expect(retainedJsonBytes(deliveredEvent.payload.event)).toBeLessThanOrEqual(
      MAX_RETAINED_SESSION_EVENT_BYTES,
    );
    expect(JSON.stringify(deliveredEvent.payload.event)).toContain("retained value truncated");
    expect(JSON.stringify(deliveredEvent.payload.event)).toContain("command-tail");
    expect(JSON.stringify(deliveredEvent.payload.event)).toContain("image/png");

    const projectedEvents = runtime.getSnapshot().projection.sessions.get("host-a\u0000session-a")?.events;
    expect(projectedEvents).toHaveLength(1);
    expect(retainedJsonBytes(projectedEvents)).toBeLessThanOrEqual(
      MAX_RETAINED_SESSION_EVENT_BYTES + 2,
    );
  });
  it("isolates subscriber failures and blocks late events after stop", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    let calls = 0;
    runtime.subscribe(() => { throw new Error("subscriber"); });
    runtime.subscribe(() => { calls += 1; });
    const beforeStop = calls;
    await runtime.stop();
    shell.emitError({ code: "transport", message: "https://endpoint.invalid /tmp/token token=secret" });
    expect(calls).toBe(beforeStop);
    expect(runtime.getSnapshot().startState).toBe("stopped");
  });
  it("activates sessions without exposing mutable maps", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    runtime.activateSession("host-a", String(sessionId("session-a")));
    const snapshot = runtime.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.projection.sessions.size).toBe(1);
  });
  it("passes through unchanged when controller leases are absent", async () => {
    const { shell, runtime } = await leaseRuntime([]);
    const intent = leaseIntent({ command: "caller-value" });
    const result = await runtime.commandWithControllerLease("remote", intent);
    expect(result.accepted).toBe(true);
    expect(shell.commands.at(-1)?.intent).toEqual(intent);
    expect(await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a")).toEqual({ required: false });
  });
  it("acquires the exact session-scoped lease frame and reuses/coalesces it", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    const [first, second] = await Promise.all([
      runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a", "owner-a"),
      runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a", "owner-a"),
    ]);
    expect(first.required && first.leaseId).toBe("lease-fixture");
    expect(second).toEqual(first);
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(1);
    expect(shell.commands.at(-1)?.intent).toMatchObject({ hostId: hostId("host-remote"), sessionId: sessionId("session-a"), command: "controller.lease.acquire", expectedRevision: revision("revision-a"), args: { ownerId: "owner-a" } });
  });
  it("releases a controller lease granted after disconnect and blocks stale dispatch", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    let resolveAcquire!: () => void;
    shell.controllerAcquireGate = new Promise<void>((resolve) => { resolveAcquire = resolve; });
    const pending = runtime.commandWithControllerLease("remote", leaseIntent({ message: "stale" }));
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(1);
    shell.emitState({ targetId: "remote", state: "disconnected" });
    shell.emitState({ targetId: "remote", state: "connected" });
    resolveAcquire();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
    expect(runtime.controllerLeaseFor("remote", "host-remote", "session-a", "revision-a")).toBeUndefined();
  });
  it("releases a controller lease granted after stop without caching it", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    let resolveAcquire!: () => void;
    shell.controllerAcquireGate = new Promise<void>((resolve) => { resolveAcquire = resolve; });
    const pending = runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(1);
    await runtime.stop();
    resolveAcquire();
    await pending;
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
    expect(runtime.controllerLeaseFor("remote", "host-remote", "session-a", "revision-a")).toBeUndefined();
    await expect(runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a")).rejects.toMatchObject({ code: "stopped" });
  });
  it("isolates targets, sessions, and revisions and invalidates on disconnect and epoch change", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    await runtime.acquireControllerLease("remote", "host-remote", "session-b", "revision-a");
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-b");
    shell.emitState({ targetId: "remote", state: "disconnected" });
    shell.emitState({ targetId: "remote", state: "connected" });
    shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], ["controller.lease"], "epoch-2") });
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(4);
  });
  it("renews and releases with exact lease arguments", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    await runtime.renewControllerLease("remote", "host-remote", "session-a", "revision-a");
    await runtime.releaseControllerLease("remote", "host-remote", "session-a", "revision-a");
    expect(shell.commands.map((command) => [command.intent.command, command.intent.args])).toEqual([
      ["controller.lease.acquire", { ownerId: "t4-code-client" }],
      ["controller.lease.renew", { leaseId: "lease-fixture" }],
      ["controller.lease.release", { leaseId: "lease-fixture" }],
    ]);
  });
  it("rejects a stale renewal grant, releases it once, and does not cache it", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    let resolveRenew!: () => void;
    shell.controllerRenewGate = new Promise<void>((resolve) => { resolveRenew = resolve; });
    const renewal = runtime.renewControllerLease("remote", "host-remote", "session-a", "revision-a", "lease-stale");
    await Promise.resolve();
    shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], ["controller.lease"], "epoch-2") });
    resolveRenew();
    await expect(renewal).rejects.toMatchObject({ code: "stale" });
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
    expect(runtime.controllerLeaseFor("remote", "host-remote", "session-a", "revision-a")).toBeUndefined();
  });
  it("injects a lease without mutating caller args and does not replay unknown outcomes", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    const intent = leaseIntent({ user: "value" });
    const original = JSON.stringify(intent);
    await runtime.commandWithControllerLease("remote", intent);
    expect(JSON.stringify(intent)).toBe(original);
    expect(shell.commands.at(-1)?.intent.args).toEqual({ user: "value", leaseId: "lease-fixture" });
    shell.rejectLeaseCode = "outcome_unknown";
    await expect(runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-z")).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(2);
  });
  it("can bind a controller lease without adding a revision to a revision-optional command", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    const intent = {
      hostId: hostId("host-remote"),
      sessionId: sessionId("session-a"),
      command: "session.cancel",
      args: {},
    };
    await runtime.commandWithControllerLease("remote", intent, "revision-a");
    expect(shell.commands.map((command) => command.intent)).toEqual([
      {
        hostId: hostId("host-remote"),
        sessionId: sessionId("session-a"),
        command: "controller.lease.acquire",
        expectedRevision: revision("revision-a"),
        args: { ownerId: "t4-code-client" },
      },
      {
        hostId: hostId("host-remote"),
        sessionId: sessionId("session-a"),
        command: "session.cancel",
        args: { leaseId: "lease-fixture" },
      },
    ]);
  });
  it("passes prompt commands through unchanged when prompt leases are absent", async () => {
    const { shell, runtime } = await leaseRuntime([]);
    const intent = leaseIntent({ message: "hello" });
    await runtime.commandWithPromptLease("remote", intent);
    expect(shell.commands).toHaveLength(1);
    expect(shell.commands[0]?.intent).toEqual(intent);
  });
  it("can bind a prompt lease without adding a revision to a revision-optional command", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    const intent = {
      hostId: hostId("host-remote"),
      sessionId: sessionId("session-a"),
      command: "session.steer",
      args: { message: "redirect the active turn" },
    };
    await runtime.commandWithPromptLease("remote", intent, "revision-a");
    expect(shell.commands.map((command) => command.intent)).toEqual([
      {
        hostId: hostId("host-remote"),
        sessionId: sessionId("session-a"),
        command: "prompt.lease.acquire",
        expectedRevision: revision("revision-a"),
        args: { ownerId: "t4-code-client" },
      },
      {
        hostId: hostId("host-remote"),
        sessionId: sessionId("session-a"),
        command: "session.steer",
        args: { message: "redirect the active turn", leaseId: "prompt-lease-fixture" },
      },
    ]);
  });
  it("coalesces prompt lease acquisition and injects only the lease id", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    const intent = leaseIntent({ message: "hello" });
    const original = JSON.stringify(intent);
    await Promise.all([
      runtime.commandWithPromptLease("remote", intent),
      runtime.commandWithPromptLease("remote", intent),
    ]);
    expect(JSON.stringify(intent)).toBe(original);
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.acquire")).toHaveLength(1);
    expect(shell.commands[0]?.intent.args).toEqual({ ownerId: "t4-code-client" });
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt").map((command) => command.intent.args)).toEqual([
      { message: "hello", leaseId: "prompt-lease-fixture" },
      { message: "hello", leaseId: "prompt-lease-fixture" },
    ]);
  });
  it("releases a revision-bound prompt lease before acquiring its replacement", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    await runtime.commandWithPromptLease("remote", leaseIntent({ message: "first" }));
    await runtime.commandWithPromptLease("remote", { ...leaseIntent({ message: "second" }), expectedRevision: revision("revision-b") });
    expect(shell.commands.map((command) => command.intent.command)).toEqual([
      "prompt.lease.acquire",
      "session.prompt",
      "prompt.lease.release",
      "prompt.lease.acquire",
      "session.prompt",
    ]);
    expect(shell.commands[2]?.intent.args).toEqual({ leaseId: "prompt-lease-fixture" });
    expect(shell.commands[3]?.intent).toMatchObject({ expectedRevision: revision("revision-b"), args: { ownerId: "t4-code-client" } });
  });
  it("does not reuse expired prompt leases and invalidates live leases on disconnect", async () => {
    let now = 1_000;
    const { shell, runtime } = await leaseRuntime(["prompt.lease"], { clock: { now: () => now } });
    shell.promptExpiresAt = 31_000;
    await runtime.commandWithPromptLease("remote", leaseIntent());
    now = 31_000;
    shell.promptExpiresAt = 61_000;
    await runtime.commandWithPromptLease("remote", leaseIntent());
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.acquire")).toHaveLength(2);
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.release")).toHaveLength(0);
    shell.emitState({ targetId: "remote", state: "disconnected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.release")).toHaveLength(1);
  });
  it("releases a prompt lease that finishes acquiring after disconnect", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    const gate = Promise.withResolvers<void>();
    shell.promptAcquireGate = gate.promise;
    const command = runtime.commandWithPromptLease("remote", leaseIntent());
    await Promise.resolve();
    expect(shell.commands.filter((item) => item.intent.command === "prompt.lease.acquire")).toHaveLength(1);
    shell.emitState({ targetId: "remote", state: "disconnected" });
    shell.emitState({ targetId: "remote", state: "connected" });
    gate.resolve();
    await expect(command).rejects.toMatchObject({ code: "stale" });
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.filter((item) => item.intent.command === "prompt.lease.release")).toHaveLength(1);
    expect(shell.commands.filter((item) => item.intent.command === "session.prompt")).toHaveLength(0);
  });
  it("surfaces prompt lease rejection without replaying acquisition", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    shell.rejectLeaseCode = "outcome_unknown";
    await expect(runtime.commandWithPromptLease("remote", leaseIntent())).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.acquire")).toHaveLength(1);
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
  });
  it("stops speaking exactly once across concurrent and repeated stop calls", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    const speech = Promise.withResolvers<void>();
    shell.stopSpeakingGate = speech.promise;
    const first = runtime.stop();
    const second = runtime.stop();
    await Promise.resolve();
    expect(shell.stopSpeakingCalls).toBe(1);
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    speech.resolve();
    await Promise.all([first, second]);
    await runtime.stop();
    expect(shell.stopSpeakingCalls).toBe(1);
  });
  it("disconnects the target after an uncertain prompt lease acquisition", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    shell.rejectLeaseCode = "timeout";
    await expect(runtime.commandWithPromptLease("remote", leaseIntent())).rejects.toThrow();
    expect(runtime.getSnapshot().connections.get("remote")).toBe("disconnected");
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.acquire")).toHaveLength(1);
  });
  it("releases best effort during bounded stop cleanup", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    shell.hangRelease = true;
    const started = Date.now();
    await runtime.stop();
    expect(Date.now() - started).toBeLessThan(500);
    expect(runtime.getSnapshot().startState).toBe("stopped");
  });
  it("suppresses raw host-product response frames and publishes only validated command results", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "remote", state: "connected" });
    shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", ["sessions.read"], [], "epoch-1") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const responses: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents((event) => { if (event.event.kind === "response") responses.push(event); });
    shell.emitFrame({
      targetId: "remote",
      frame: ({
        v: "omp-app/1",
        type: "response",
        requestId: "old-request",
        hostId: hostId("host-remote"),
        ok: true,
        command: "session.list",
        result: sessionInventory("host-remote", "epoch-1", "old-frame"),
      } as unknown as RendererServerFrame),
    });
    shell.emitFrame({
      targetId: "remote",
      frame: ({
        v: "omp-app/1",
        type: "response",
        requestId: "old-workspace-request",
        hostId: hostId("host-remote"),
        ok: true,
        command: "workspace.list",
        result: shell.workspaceListResult,
      } as unknown as RendererServerFrame),
    });
    expect(responses).toHaveLength(0);
    await runtime.command("remote", { hostId: hostId("host-remote"), command: "session.list", args: {} });
    expect(responses).toHaveLength(1);
    expect(responses[0]?.event).toMatchObject({
      kind: "response",
      payload: { command: "session.list" },
    });
  });
  it("keeps duplicate same-host target metadata and lease capabilities target-scoped", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("shared-host", ["sessions.read"], ["controller.lease", "prompt.lease"], "epoch-1") });
    await runtime.addTarget(remoteTargetRequest("remote"));
    shell.emitState({ targetId: "remote", state: "connected" });
    shell.emitFrame({ targetId: "remote", frame: welcome("shared-host", [], [], "epoch-2") });
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("local");
    const sharedIntent = { ...leaseIntent(), hostId: hostId("shared-host") };
    await runtime.commandWithControllerLease("remote", sharedIntent);
    await runtime.commandWithPromptLease("remote", sharedIntent);
    expect(shell.commands.some((command) => command.intent.command === "controller.lease.acquire")).toBe(false);
    expect(shell.commands.some((command) => command.intent.command === "prompt.lease.acquire")).toBe(false);
  });
  it("keeps a new refresh cadence after an old request spans an epoch welcome", async () => {
    const timers = new FakeTimerScheduler();
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell, timers });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.deferNextSessionList();
    timers.fireNext();
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-2") });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(timers.timers.size).toBe(1);
    shell.resolveSessionList();
  });
  it("does not dispatch or retain a controller lease acquired after an epoch welcome", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    const gate = Promise.withResolvers<void>();
    shell.controllerAcquireGate = gate.promise;
    const pending = runtime.commandWithControllerLease("remote", leaseIntent());
    await Promise.resolve();
    shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], ["controller.lease"], "epoch-2") });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
  });
  it("does not dispatch or retain a prompt lease acquired after an epoch welcome", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    const gate = Promise.withResolvers<void>();
    shell.promptAcquireGate = gate.promise;
    const pending = runtime.commandWithPromptLease("remote", leaseIntent());
    await Promise.resolve();
    shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], ["prompt.lease"], "epoch-2") });
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "stale" });
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.release")).toHaveLength(1);
  });
  it("promotes a connected duplicate when the host representative disconnects", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: welcome("shared-host", [], [], "epoch-1") });
    await runtime.addTarget(remoteTargetRequest("remote"));
    shell.emitState({ targetId: "remote", state: "connected" });
    shell.emitFrame({ targetId: "remote", frame: welcome("shared-host", [], [], "epoch-2") });
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("local");
    shell.emitState({ targetId: "local", state: "disconnected" });
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("remote");
  });
  it("applies deferred bootstrap inventory across welcome-before-connected", async () => {
    const shell = new FakeShell();
    shell.sessionListResult = sessionInventory("host-a", "epoch-1", "bootstrap");
    shell.deferNextSessionList();
    shell.emitWelcomeOnBootstrap = { targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") };
    const runtime = createDesktopRuntimeController({ shell });
    const started = runtime.start();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.resolveSessionList();
    await started;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has("host-a\u0000session-bootstrap")).toBe(true);
  });
  it("rejects deferred bootstrap inventory after welcome-before-connected disconnect", async () => {
    const shell = new FakeShell();
    shell.deferNextSessionList();
    shell.emitWelcomeOnBootstrap = { targetId: "local", frame: welcome("host-a", ["sessions.read"], [], "epoch-1") };
    const runtime = createDesktopRuntimeController({ shell });
    const started = runtime.start();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    shell.emitState({ targetId: "local", state: "disconnected" });
    const responses: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents((event) => { if (event.event.kind === "response") responses.push(event); });
    shell.resolveSessionList();
    await started;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().projection.sessionIndex.has("host-a\u0000session-1")).toBe(false);
    expect(responses).toHaveLength(0);
  });
  it("requires fresh catalog and settings reads after a target epoch changes", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitState({ targetId: "local", state: "connected" });
    const capabilities = ["sessions.read", "catalog.read", "config.read"];
    const features = ["catalog.metadata", "settings.metadata"];
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", capabilities, features, "epoch-1") });
    await runtime.command("local", { hostId: hostId("host-a"), command: "catalog.get", args: {} });
    await runtime.command("local", { hostId: hostId("host-a"), command: "settings.read", args: {} });
    const products: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents((event) => {
      if (event.event.kind === "catalog" || event.event.kind === "settings") products.push(event);
    });
    const emitProducts = (suffix: string) => {
      shell.emitFrame({
        targetId: "local",
        frame: { v: "omp-app/1", type: "catalog", hostId: hostId("host-a"), revision: revision(`catalog-${suffix}`), items: [] },
      });
      shell.emitFrame({
        targetId: "local",
        frame: { v: "omp-app/1", type: "settings", hostId: hostId("host-a"), revision: revision(`settings-${suffix}`), settings: {} },
      });
    };
    emitProducts("live");
    expect(products).toHaveLength(2);
    expect(runtime.getSnapshot().catalogs.get("host-a")?.revision).toBe("catalog-live");
    expect(runtime.getSnapshot().settings.get("host-a")?.revision).toBe("settings-live");
    shell.emitFrame({ targetId: "local", frame: welcome("host-a", capabilities, features, "epoch-2") });
    emitProducts("stale");
    expect(products).toHaveLength(2);
    expect(runtime.getSnapshot().catalogs.get("host-a")?.revision).toBe("catalog-live");
    expect(runtime.getSnapshot().settings.get("host-a")?.revision).toBe("settings-live");
    await runtime.command("local", { hostId: hostId("host-a"), command: "catalog.get", args: {} });
    await runtime.command("local", { hostId: hostId("host-a"), command: "settings.read", args: {} });
    emitProducts("fresh");
    expect(products).toHaveLength(4);
    expect(runtime.getSnapshot().catalogs.get("host-a")?.revision).toBe("catalog-fresh");
    expect(runtime.getSnapshot().settings.get("host-a")?.revision).toBe("settings-fresh");
  });
  it("keeps the connected representative when an offline duplicate welcomes at the same epoch", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    shell.emitFrame({ targetId: "local", frame: welcome("shared-host", [], [], "epoch-1") });
    await runtime.addTarget(remoteTargetRequest("remote"));
    shell.emitFrame({ targetId: "remote", frame: welcome("shared-host", [], [], "epoch-1") });
    expect(runtime.getSnapshot().hosts.get("shared-host")?.targetId).toBe("local");
    expect(runtime.getSnapshot().connections.get("remote")).toBe("disconnected");
  });
  it("invalidates connection identity when an authoritative target list changes state", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    shell.listedTargets = [target("local", "connected"), target("remote", "disconnected")];
    await runtime.listTargets();
    await Promise.resolve();
    expect(runtime.getSnapshot().connections.get("remote")).toBe("disconnected");
    expect(runtime.controllerLeaseFor("remote", "host-remote", "session-a", "revision-a")).toBeUndefined();
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
    shell.listedTargets = [target("local", "connected"), target("remote", "connected")];
    await runtime.listTargets();
    await runtime.acquireControllerLease("remote", "host-remote", "session-a", "revision-a");
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(2);
  });
  it("drops a delayed welcome after its target was removed", async () => {
    const shell = new FakeShell();
    const runtime = createDesktopRuntimeController({ shell });
    await runtime.start();
    await runtime.addTarget(remoteTargetRequest("remote"));
    await runtime.removeTarget("remote");
    const commandsBeforeWelcome = shell.commands.length;
    const events: RendererServerEventEnvelope[] = [];
    runtime.subscribeEvents((event) => events.push(event));
    shell.emitFrame({
      targetId: "remote",
      frame: welcome("removed-host", ["sessions.read"], [], "epoch-removed"),
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(runtime.getSnapshot().targetHosts.has("remote")).toBe(false);
    expect(runtime.getSnapshot().hosts.has("removed-host")).toBe(false);
    expect(shell.commands).toHaveLength(commandsBeforeWelcome);
    expect(events).toHaveLength(0);
  });
  it("forgets a newly acquired controller lease when the dispatch gate closes", async () => {
    const { shell, runtime } = await leaseRuntime(["controller.lease"]);
    await expect(
      runtime.commandWithControllerLease("remote", leaseIntent(), undefined, () => {
        throw new Error("dispatch gate closed");
      }),
    ).rejects.toThrow("dispatch gate closed");
    expect(runtime.controllerLeaseFor("remote", "host-remote", "session-a", "revision-a")).toBeUndefined();
    await Promise.resolve();
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(1);
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.release")).toHaveLength(1);
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
    await runtime.commandWithControllerLease("remote", leaseIntent());
    expect(shell.commands.filter((command) => command.intent.command === "controller.lease.acquire")).toHaveLength(2);
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(1);
  });
});
