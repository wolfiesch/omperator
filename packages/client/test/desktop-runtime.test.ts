import { describe, expect, it } from "vite-plus/test";
import { hostId, revision, sessionId, type WelcomeFrame } from "@t4-code/protocol";
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
  PairRequest,
  PairResult,
  RendererServerFrameEvent,
  RuntimeErrorEvent,
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
import { createDesktopRuntimeController, type DesktopRuntimeController, type DesktopShellPort } from "../src/desktop-runtime.ts";
import { redactedMessage } from "../src/desktop-runtime-contracts.ts";

const target = (targetId: string, state: DesktopTarget["state"] = "disconnected"): DesktopTarget => ({ targetId, label: targetId, kind: targetId === "local" ? "local" : "remote", state, paired: true });
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
class FakeShell implements DesktopShellPort {
  readonly kind = "desktop" as const;
  readonly platform = "linux" as const;
  readonly frames = new Set<(event: RendererServerFrameEvent) => void>();
  readonly states = new Set<(event: ConnectionStateEvent) => void>();
  readonly errors = new Set<(event: RuntimeErrorEvent) => void>();
  readonly commands: CommandRequest[] = [];
  rejectConnect = false;
  rejectLeaseCode: "outcome_unknown" | "stale" | "timeout" | undefined;
  hangRelease = false;
  promptExpiresAt: string | number = "2030-01-01T00:00:00.000Z";
  promptAcquireGate: Promise<void> | undefined;
  bootstrapCalls = 0;
  connectCalls = 0;
  emitWelcomeOnBootstrap: RendererServerFrameEvent | undefined;
  sessionListAccepted = true;
  sessionListResult: unknown = { cursor: { epoch: "epoch-1", seq: 7 }, sessions: [], totalCount: 0, truncated: false };
  sessionListResultMissing = false;
  async bootstrap(): Promise<BootstrapResult> { this.bootstrapCalls += 1; if (this.emitWelcomeOnBootstrap !== undefined) this.emitFrame(this.emitWelcomeOnBootstrap); return { platform: "linux", version: "omp-app/1", connected: false }; }
  async listTargets(): Promise<TargetListResult> { return { targets: Object.freeze([target("local")]) }; }
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
      return { ...base, accepted: this.sessionListAccepted, ...(this.sessionListResultMissing ? {} : { result: this.sessionListResult }) };
    }
    return base;
  }
  async pair(request: PairRequest): Promise<PairResult> { return { targetId: request.targetId, paired: true }; }
  async addTarget(request: TargetAddRequest): Promise<TargetAddResult> { return { target: target(request.target.targetId) }; }
  async removeTarget(request: TargetRequest): Promise<TargetRemoveResult> { return { targetId: request.targetId, removed: true }; }
  onServerFrame(listener: (event: RendererServerFrameEvent) => void): () => void { this.frames.add(listener); return () => this.frames.delete(listener); }
  onConnectionState(listener: (event: ConnectionStateEvent) => void): () => void { this.states.add(listener); return () => this.states.delete(listener); }
  onRuntimeError(listener: (event: RuntimeErrorEvent) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
  emitFrame(event: RendererServerFrameEvent): void { for (const listener of [...this.frames]) listener(event); }
  // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
  emitState(event: ConnectionStateEvent): void { for (const listener of [...this.states]) listener(event); }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> { return { targetId: request.targetId, requestId: "confirm-request", confirmationId: request.confirmationId, commandId: request.commandId, accepted: true }; }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> { return { targetId: request.targetId, accepted: true }; }
  // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
  emitError(event: RuntimeErrorEvent): void { for (const listener of [...this.errors]) listener(event); }
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
  shell.emitState({ targetId: "remote", state: "connected" });
  shell.emitFrame({ targetId: "remote", frame: welcome("host-remote", [], features) });
  await Promise.resolve();
  return { shell, runtime };
}
describe("desktop runtime projection", () => {
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
    runtime.subscribeFrames((event) => seen.push(event.targetId));
    shell.emitFrame({ targetId: "one", frame: welcome("host-one", [], []) });
    shell.emitFrame({ targetId: "two", frame: welcome("host-two", [], []) });
    shell.emitFrame({ targetId: "one", frame: { v: "omp-app/1", type: "catalog", hostId: hostId("host-two"), revision: revision("revision-1"), items: [] } });
    expect(seen).toEqual(["one", "two"]);
    expect(runtime.getSnapshot().runtimeErrors.at(-1)?.code).toBe("protocol");
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
    gate.resolve();
    await command;
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commands.filter((item) => item.intent.command === "prompt.lease.release")).toHaveLength(1);
  });
  it("surfaces prompt lease rejection without replaying acquisition", async () => {
    const { shell, runtime } = await leaseRuntime(["prompt.lease"]);
    shell.rejectLeaseCode = "outcome_unknown";
    await expect(runtime.commandWithPromptLease("remote", leaseIntent())).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(shell.commands.filter((command) => command.intent.command === "prompt.lease.acquire")).toHaveLength(1);
    expect(shell.commands.filter((command) => command.intent.command === "session.prompt")).toHaveLength(0);
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
});
