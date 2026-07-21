// Live PTY bridge contract: honest feature/capability/catalog gates, the
// lease-injected session-scoped term.open with a relative cwd, requestId
// correlation against the session projection (including the landed-before-
// subscribe race), cursor-ordered utf8/base64 output with stderr and exit
// intact, strictly serialized input, coalesced resize, exactly-one close,
// no replay after a dropped connection, cross-session isolation, bounded
// pre-ownership buffering, and an untouched fixture bridge.
import {
  hostId,
  PROTOCOL_VERSION,
  requestId as brandRequestId,
  revision as brandRevision,
  sessionId,
  terminalId as brandTerminalId,
  type ResultFrame,
  type SessionSnapshotFrame,
  type TerminalExitFrame,
  type TerminalOutputFrame,
  type WelcomeFrame,
} from "@t4-code/protocol";
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
  RendererServerEventEnvelope,
  RendererServerFrame,
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
import { rendererServerEventFromFrame } from "@t4-code/protocol/desktop-ipc";
import {
  createDesktopRuntimeController,
  type DesktopRuntimeController,
  type DesktopShellPort,
} from "@t4-code/client";
import { describe, expect, it, vi } from "vite-plus/test";

import type { LiveSessionAddress } from "../src/platform/live-workspace.ts";
import { resolveLiveSession, sessionViewId } from "../src/platform/live-workspace.ts";
import { presentSessionControl } from "../src/features/session-runtime/session-observer.ts";
import {
  createLivePtySessionFactory,
  resolveLiveTerminalAvailability,
  type LivePtyBridge,
  type LivePtyBridgeOptions,
} from "../src/features/terminal/live-pty.ts";
import { createFixturePtyBridge, FixturePtySession } from "../src/features/terminal/pty.ts";
import type {
  PtyError,
  PtyExit,
  PtyNotice,
  PtyOpenRequest,
  PtySession,
} from "../src/features/terminal/pty.ts";

const HOST = "host-a";
const SESSION = "session-a";
const TARGET = "local";
const SERVER_TERMINAL = "term-live-1";
const ADDRESS: LiveSessionAddress = { targetId: TARGET, hostId: HOST, sessionId: SESSION };

const DEFAULT_FEATURES = ["terminal.io", "controller.lease"] as const;
const DEFAULT_CAPABILITIES = ["term.open"] as const;

/** Everything here settles on microtasks — no wall-clock waits. */
async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index++) await Promise.resolve();
}

function welcomeFrame(
  capabilities: readonly string[],
  features: readonly string[],
): WelcomeFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "welcome",
    selectedProtocol: PROTOCOL_VERSION,
    hostId: hostId(HOST),
    ompVersion: "omp",
    ompBuild: "test",
    appserverVersion: "app",
    appserverBuild: "test",
    epoch: "epoch-1",
    grantedCapabilities: [...capabilities],
    grantedFeatures: [...features],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

interface CatalogItemSpec {
  readonly name: string;
  readonly capabilities?: readonly string[];
  readonly supported?: boolean;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

function catalogFrame(items: readonly CatalogItemSpec[]): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "catalog",
    hostId: HOST,
    revision: "rev-catalog",
    items: items.map((item) => ({
      id: item.name,
      kind: "command",
      name: item.name,
      ...(item.capabilities === undefined ? {} : { capabilities: [...item.capabilities] }),
      ...(item.supported === undefined ? {} : { supported: item.supported }),
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    })),
  };
}

function sessionSnapshotFrame(revisionValue = "rev-1", seq = 1): SessionSnapshotFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "snapshot",
    cursor: { epoch: "session-epoch", seq },
    revision: brandRevision(revisionValue),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    entries: [],
  };
}

/** Full sessions inventory frame carrying ownership truth for SESSION. */
function sessionsFrame(seq: number, liveState: Record<string, unknown>): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "sessions",
    cursor: { epoch: "epoch-1", seq },
    sessions: [
      {
        hostId: HOST,
        sessionId: SESSION,
        project: { projectId: "project-1" },
        revision: "rev-1",
        title: "Session",
        status: "active",
        updatedAt: "2026-07-11T10:00:00Z",
        liveState,
      },
    ],
  };
}

const OBSERVER_CONTROL = { mode: "observer", lockStatus: "live", transcript: "live" } as const;

function openResponseFrame(
  requestIdValue: string,
  outcome:
    | { readonly ok: true; readonly terminalId: string }
    | { readonly ok: false; readonly code: string; readonly message: string },
  sessionIdValue = SESSION,
): ResultFrame {
  const base = {
    v: PROTOCOL_VERSION,
    type: "response" as const,
    requestId: brandRequestId(requestIdValue),
    hostId: hostId(HOST),
    sessionId: sessionId(sessionIdValue),
  };
  if (outcome.ok) {
    return {
      ...base,
      ok: true,
      command: "term.open",
      result: { terminalId: outcome.terminalId },
    };
  }
  return { ...base, ok: false, error: { code: outcome.code, message: outcome.message } };
}

function outputFrame(
  seq: number,
  data: string,
  overrides: Partial<TerminalOutputFrame> = {},
): TerminalOutputFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.output",
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    terminalId: brandTerminalId(SERVER_TERMINAL),
    cursor: { epoch: "term-epoch", seq },
    stream: "stdout",
    data,
    ...overrides,
  };
}

function exitFrame(seq: number, exitCode: number, signal?: string): TerminalExitFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.exit",
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    terminalId: brandTerminalId(SERVER_TERMINAL),
    cursor: { epoch: "term-epoch", seq },
    exitCode,
    ...(signal === undefined ? {} : { signal }),
  };
}

interface HeldCall<Request> {
  readonly request: Request;
  readonly release: () => void;
}

class FakeShell implements DesktopShellPort {
  readonly kind = "desktop" as const;
  readonly platform = "linux" as const;
  private readonly serverEvents = new Set<(event: RendererServerEventEnvelope) => void>();
  private readonly states = new Set<(event: ConnectionStateEvent) => void>();
  private readonly errors = new Set<(event: RuntimeErrorEvent) => void>();
  readonly commands: CommandRequest[] = [];
  readonly inputs: TerminalInputRequest[] = [];
  readonly resizes: TerminalResizeRequest[] = [];
  readonly closes: TerminalCloseRequest[] = [];
  readonly heldInputs: HeldCall<TerminalInputRequest>[] = [];
  readonly heldResizes: HeldCall<TerminalResizeRequest>[] = [];
  holdInput = false;
  holdResize = false;
  rejectOpen = false;
  leaseRefused = false;
  /** Emit the term.open response before the command promise resolves. */
  respondOpenSynchronously = false;
  openCount = 0;
  lastOpenRequestId = "";

  async bootstrap(): Promise<BootstrapResult> {
    return { platform: "linux", version: PROTOCOL_VERSION, connected: false };
  }
  async listTargets(): Promise<TargetListResult> {
    const local: DesktopTarget = {
      targetId: TARGET,
      label: "This machine",
      kind: "local",
      state: "disconnected",
      paired: true,
    };
    return { targets: Object.freeze([local]) };
  }
  async connectTarget(request: TargetRequest): Promise<ConnectResult> {
    this.emitState({ targetId: request.targetId, state: "connected" });
    return { targetId: request.targetId, state: "connected" };
  }
  async connect(request: TargetRequest): Promise<ConnectResult> {
    return this.connectTarget(request);
  }
  async disconnectTarget(request: TargetRequest): Promise<DisconnectResult> {
    this.emitState({ targetId: request.targetId, state: "disconnected" });
    return { targetId: request.targetId, state: "disconnected" };
  }
  async disconnect(request: TargetRequest): Promise<DisconnectResult> {
    return this.disconnectTarget(request);
  }
  async command(request: CommandRequest): Promise<CommandResult & Record<string, unknown>> {
    this.commands.push(request);
    const { intent } = request;
    const ordinal = this.commands.length;
    if (intent.command.startsWith("controller.lease")) {
      const base = {
        targetId: request.targetId,
        requestId: `lease-req-${ordinal}`,
        commandId: `lease-cmd-${ordinal}`,
        accepted: !this.leaseRefused,
      };
      if (intent.command === "controller.lease.release") return base;
      return this.leaseRefused
        ? base
        : { ...base, leaseId: "lease-fixture", expiresAt: "2030-01-01T00:00:00.000Z" };
    }
    if (intent.command === "term.open") {
      this.openCount += 1;
      const requestIdValue = `open-req-${this.openCount}`;
      this.lastOpenRequestId = requestIdValue;
      if (this.rejectOpen) {
        return {
          targetId: request.targetId,
          requestId: requestIdValue,
          commandId: `open-cmd-${this.openCount}`,
          accepted: false,
        };
      }
      if (this.respondOpenSynchronously) {
        this.emitFrame({
          targetId: request.targetId,
          frame: openResponseFrame(requestIdValue, { ok: true, terminalId: SERVER_TERMINAL }),
        });
      }
      return {
        targetId: request.targetId,
        requestId: requestIdValue,
        commandId: `open-cmd-${this.openCount}`,
        accepted: true,
      };
    }
    return {
      targetId: request.targetId,
      requestId: `req-${ordinal}`,
      commandId: `cmd-${ordinal}`,
      accepted: true,
    };
  }
  async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    return {
      targetId: request.targetId,
      requestId: "confirm-req",
      confirmationId: request.confirmationId,
      commandId: request.commandId,
      accepted: true,
    };
  }
  async terminalInput(request: TerminalInputRequest): Promise<TerminalResult> {
    if (this.holdInput) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.heldInputs.push({ request, release: resolve });
      await promise;
    }
    this.inputs.push(request);
    return { targetId: request.targetId, accepted: true };
  }
  async terminalResize(request: TerminalResizeRequest): Promise<TerminalResult> {
    if (this.holdResize) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.heldResizes.push({ request, release: resolve });
      await promise;
    }
    this.resizes.push(request);
    return { targetId: request.targetId, accepted: true };
  }
  async terminalClose(request: TerminalCloseRequest): Promise<TerminalResult> {
    this.closes.push(request);
    return { targetId: request.targetId, accepted: true };
  }
  async pair(request: PairRequest): Promise<PairResult> {
    return { targetId: request.targetId, paired: true };
  }
  async addTarget(request: TargetAddRequest): Promise<TargetAddResult> {
    const added: DesktopTarget = {
      targetId: request.target.targetId,
      label: request.target.targetId,
      kind: "remote",
      state: "disconnected",
      paired: false,
    };
    return { target: added };
  }
  async removeTarget(request: TargetRequest): Promise<TargetRemoveResult> {
    return { targetId: request.targetId, removed: true };
  }
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
  emitFrame(event: { targetId: string; frame: unknown }): void {
    // decodeDesktopEvent revalidates every frame field on delivery; this
    // cast only satisfies the listener signature at the fake IPC seam.
    const typed = event as { targetId: string; frame: RendererServerFrame };
    const envelope = {
      targetId: typed.targetId,
      event: rendererServerEventFromFrame(typed.frame),
    };
    for (const listener of this.serverEvents) listener(envelope);
  }
  emitState(event: ConnectionStateEvent): void {
    for (const listener of this.states) listener(event);
  }

  termOpenRequests(): CommandRequest[] {
    return this.commands.filter((entry) => entry.intent.command === "term.open");
  }
}

interface Harness {
  readonly shell: FakeShell;
  readonly controller: DesktopRuntimeController;
  readonly bridge: LivePtyBridge;
}

interface HarnessOptions {
  readonly capabilities?: readonly string[];
  readonly features?: readonly string[];
  readonly catalogItems?: readonly CatalogItemSpec[] | null;
  readonly bridgeOptions?: LivePtyBridgeOptions;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const shell = new FakeShell();
  const controller = createDesktopRuntimeController({ shell });
  await controller.start();
  shell.emitFrame({
    targetId: TARGET,
    frame: welcomeFrame(
      options.capabilities ?? DEFAULT_CAPABILITIES,
      options.features ?? DEFAULT_FEATURES,
    ),
  });
  if (options.catalogItems !== null) {
    shell.emitFrame({
      targetId: TARGET,
      frame: catalogFrame(options.catalogItems ?? [{ name: "term.open", capabilities: ["term.open"] }]),
    });
  }
  shell.emitFrame({ targetId: TARGET, frame: sessionSnapshotFrame() });
  // A complete host inventory containing this session: dispatch-time write
  // freshness requires the indexed ref, not just a bound target.
  shell.emitFrame({ targetId: TARGET, frame: sessionsFrame(1, { isStreaming: false }) });
  await settle();
  const bridge = createLivePtySessionFactory(
    controller,
    () => controller.getSnapshot(),
    ADDRESS,
    options.bridgeOptions,
  );
  return { shell, controller, bridge };
}

interface SessionEvents {
  readonly data: string[];
  readonly exits: PtyExit[];
  readonly errors: PtyError[];
  readonly notices: PtyNotice[];
  readonly drains: number[];
}

function watch(session: PtySession): SessionEvents {
  const events: SessionEvents = { data: [], exits: [], errors: [], notices: [], drains: [] };
  session.onData((chunk) => events.data.push(chunk));
  session.onExit((exit) => events.exits.push(exit));
  session.onError((error) => events.errors.push(error));
  session.onNotice((notice) => events.notices.push(notice));
  session.onDrain(() => events.drains.push(events.drains.length));
  return events;
}

function openRequest(overrides: Partial<PtyOpenRequest> = {}): PtyOpenRequest {
  return {
    sessionId: SESSION,
    terminalId: "tab-1",
    shell: "bash",
    cwd: null,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

async function openLive(
  harnessValue: Harness,
): Promise<{ session: PtySession; events: SessionEvents }> {
  const session = harnessValue.bridge.open(openRequest());
  const events = watch(session);
  await settle();
  harnessValue.shell.emitFrame({
    targetId: TARGET,
    frame: openResponseFrame(harnessValue.shell.lastOpenRequestId, {
      ok: true,
      terminalId: SERVER_TERMINAL,
    }),
  });
  await settle();

  return { session, events };
}
describe("live view identity", () => {
  it("resolves an exact encoded view id to target, host, and session", async () => {
    const h = await harness();
    expect(resolveLiveSession(h.controller.getSnapshot(), sessionViewId(HOST, SESSION))).toEqual(ADDRESS);
    expect(sessionViewId(HOST, SESSION)).toBe(`${HOST}/${SESSION}`);
    expect(resolveLiveSession(h.controller.getSnapshot(), "wrong-host/session-a")).toBeNull();
  });
});


describe("availability gates", () => {
  it("fails honest when the terminal.io feature is not granted", async () => {
    const h = await harness({ features: ["controller.lease"] });
    expect(h.bridge.availability()).toEqual({
      available: false,
      kind: "permission",
      reason: "Needs terminal access on this host",
    });
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    expect(events.errors).toEqual([
      { kind: "permission-denied", message: "Needs terminal access on this host" },
    ]);
    expect(h.shell.termOpenRequests()).toHaveLength(0);
  });

  it("fails honest when a required capability is missing", async () => {
    const h = await harness({ capabilities: [] });
    expect(h.bridge.availability()).toEqual({
      available: false,
      kind: "permission",
      reason: "Needs terminal access on this host",
    });
  });

  it("surfaces the catalog's own unsupported reason", async () => {
    const h = await harness({
      catalogItems: [
        { name: "term.open", supported: false, reason: "Shells are turned off on this host" },
      ],
    });
    expect(h.bridge.availability()).toEqual({
      available: false,
      kind: "permission",
      reason: "Shells are turned off on this host",
    });
  });

  it("waits for the catalog instead of pretending shells work", async () => {
    const h = await harness({ catalogItems: null });
    expect(h.bridge.availability()).toEqual({
      available: false,
      kind: "transport",
      reason: "Waiting for this host's command list",
    });
  });

  it("is available when feature, catalog, and capabilities line up", async () => {
    const h = await harness();
    expect(h.bridge.availability()).toEqual({ available: true });
    expect(resolveLiveTerminalAvailability(h.controller.getSnapshot(), ADDRESS)).toEqual({
      available: true,
    });
  });
});

describe("term.open through the controller lease", () => {
  it("sends the exact session-scoped command with a relative cwd and the injected lease", async () => {
    const h = await harness();
    await openLive(h);
    const leaseCommands = h.shell.commands.filter((entry) =>
      entry.intent.command.startsWith("controller.lease"),
    );
    expect(leaseCommands[0]?.intent.command).toBe("controller.lease.acquire");
    const open = h.shell.termOpenRequests()[0];
    expect(open).toBeDefined();
    expect(open?.targetId).toBe(TARGET);
    expect(String(open?.intent.hostId)).toBe(HOST);
    expect(String(open?.intent.sessionId)).toBe(SESSION);
    expect(String(open?.intent.expectedRevision)).toBe("rev-1");
    expect(open?.intent.args).toEqual({
      cwd: ".",
      cols: 80,
      rows: 24,
      leaseId: "lease-fixture",
    });
  });

  it("omits the optional shell field unless the catalog advertises it", async () => {
    const advertised = await harness({
      catalogItems: [
        {
          name: "term.open",
          capabilities: ["term.open"],
          metadata: { optionalArgs: ["shell"] },
        },
      ],
    });
    await openLive(advertised);
    expect(advertised.shell.termOpenRequests()[0]?.intent.args).toEqual({
      cwd: ".",
      cols: 80,
      rows: 24,
      shell: "bash",
      leaseId: "lease-fixture",
    });
  });

  it("refuses an absolute working directory outright", async () => {
    const h = await harness();
    expect(() => h.bridge.open(openRequest({ cwd: "/etc" }))).toThrow(/project root/);
    expect(() => h.bridge.open(openRequest({ cwd: "~/secrets" }))).toThrow(/project root/);
    expect(h.shell.termOpenRequests()).toHaveLength(0);
  });

  it("clamps requested dimensions to the wire bounds", async () => {
    const h = await harness();
    const session = h.bridge.open(openRequest({ cols: 9_999, rows: 0 }));
    watch(session);
    await settle();
    expect(h.shell.termOpenRequests()[0]?.intent.args).toMatchObject({ cols: 1_000, rows: 1 });
  });
});

describe("result correlation", () => {
  it("settles when the result landed before the subscription (race)", async () => {
    const h = await harness();
    h.shell.respondOpenSynchronously = true;
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    expect(events.errors).toHaveLength(0);
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "ready") });
    expect(events.data).toEqual(["ready"]);
  });

  it("a rejected command produces a clean retryable failure, no terminal", async () => {
    const h = await harness();
    h.shell.rejectOpen = true;
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    expect(events.errors).toEqual([
      { kind: "shell-error", message: "The host didn't accept the shell request. Try again." },
    ]);
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "ghost") });
    expect(events.data).toEqual([]);
  });

  it("a failed result maps to an honest error and no terminal", async () => {
    const h = await harness();
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    h.shell.emitFrame({
      targetId: TARGET,
      frame: openResponseFrame(h.shell.lastOpenRequestId, {
        ok: false,
        code: "capability_denied",
        message: "no",
      }),
    });
    await settle();
    expect(events.errors).toEqual([
      { kind: "permission-denied", message: "The host didn't allow this shell." },
    ]);
  });

  it("times out to outcome-unknown without inventing a terminal, and stays retry-safe", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness({ bridgeOptions: { openTimeoutMs: 5_000 } });
      const session = h.bridge.open(openRequest());
      const events = watch(session);
      await settle();
      expect(h.shell.termOpenRequests()).toHaveLength(1);
      vi.advanceTimersByTime(5_001);
      await settle();
      expect(events.errors).toEqual([
        { kind: "shell-error", message: "The host didn't answer in time. Try again." },
      ]);
      // The late result must not resurrect the dead attempt.
      h.shell.emitFrame({
        targetId: TARGET,
        frame: openResponseFrame(h.shell.lastOpenRequestId, {
          ok: true,
          terminalId: SERVER_TERMINAL,
        }),
      });
      await settle();
      h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "late") });
      expect(events.data).toEqual([]);
      // A fresh open is a fresh command — nothing replayed from the first.
      const retry = await openLive(h);
      expect(h.shell.termOpenRequests()).toHaveLength(2);
      h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(2, "fresh") });
      expect(retry.events.data).toEqual(["fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disconnect during open resolves to outcome-unknown", async () => {
    const h = await harness();
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    h.shell.emitState({ targetId: TARGET, state: "disconnected" });
    await settle();
    expect(events.errors).toEqual([
      {
        kind: "shell-error",
        message: "The connection dropped before the host answered. Try again once you're back.",
      },
    ]);
  });
});

describe("output stream", () => {
  it("orders chunks, decodes utf8 and base64 exactly, keeps stderr, drops duplicates", async () => {
    const h = await harness();
    const { events } = await openLive(h);
    const base64 = Buffer.from("wörld ✓", "utf8").toString("base64");
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "héllo ") });
    h.shell.emitFrame({
      targetId: TARGET,
      frame: outputFrame(2, base64, { stream: "stderr", encoding: "base64" }),
    });
    // Exact duplicate cursor: dropped, not re-rendered.
    h.shell.emitFrame({
      targetId: TARGET,
      frame: outputFrame(2, base64, { stream: "stderr", encoding: "base64" }),
    });
    expect(events.data).toEqual(["héllo ", "wörld ✓"]);
    expect(events.notices).toEqual([]);
  });

  it("marks sequence gaps and epoch resumes without dropping the exit", async () => {
    const h = await harness();
    const { events } = await openLive(h);
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "a") });
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(4, "b") });
    h.shell.emitFrame({
      targetId: TARGET,
      frame: outputFrame(1, "c", { cursor: { epoch: "term-epoch-2", seq: 1 } }),
    });
    h.shell.emitFrame({
      targetId: TARGET,
      frame: exitFrame(9, 143, "TERM"),
    });
    expect(events.data).toEqual(["a", "b", "c"]);
    expect(events.notices).toEqual(["output-skipped", "resumed", "resumed"]);
    expect(events.exits).toEqual([{ code: 143, signal: "TERM" }]);
  });

  it("propagates the real exit code and closes the stream", async () => {
    const h = await harness();
    const { session, events } = await openLive(h);
    h.shell.emitFrame({ targetId: TARGET, frame: exitFrame(1, 3) });
    expect(events.exits).toEqual([{ code: 3, signal: null }]);
    // Closed: later frames and writes are inert.
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(2, "after") });
    expect(events.data).toEqual([]);
    expect(session.write("x")).toBe(true);
    await settle();
    expect(h.shell.inputs).toHaveLength(0);
  });

  it("ignores frames for another session and unowned terminals", async () => {
    const h = await harness();
    const { events } = await openLive(h);
    h.shell.emitFrame({
      targetId: TARGET,
      frame: {
        ...outputFrame(1, "foreign"),
        sessionId: sessionId("session-b"),
      },
    });
    h.shell.emitFrame({
      targetId: TARGET,
      frame: outputFrame(1, "stranger", { terminalId: brandTerminalId("term-other") }),
    });
    expect(events.data).toEqual([]);
  });

  it("buffers early output within the bound and flags what fell off", async () => {
    const h = await harness({ bridgeOptions: { maxBufferedFrameChars: 100 } });
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    // Output beats the result: first frame overflows the bound and drops.
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "x".repeat(80)) });
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(2, "y".repeat(20)) });
    h.shell.emitFrame({
      targetId: TARGET,
      frame: openResponseFrame(h.shell.lastOpenRequestId, {
        ok: true,
        terminalId: SERVER_TERMINAL,
      }),
    });
    await settle();
    expect(events.notices).toEqual(["output-skipped"]);
    expect(events.data).toEqual(["y".repeat(20)]);
    // Live frames continue in cursor order after the replay.
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(3, "z") });
    expect(events.data).toEqual(["y".repeat(20), "z"]);
  });
});
describe("input, resize, close", () => {

  it("uses the cached controller lease for each terminal mutation", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    session.write("x");
    await settle();
    session.resize(120, 30);
    await settle();
    session.kill();
    await settle();
    expect(h.shell.inputs).toHaveLength(1);
    expect(h.shell.resizes).toHaveLength(1);
    expect(h.shell.closes).toHaveLength(1);
    expect(h.shell.commands.filter((entry) => entry.intent.command === "controller.lease.acquire").length).toBe(1);
  });

  it("refused mutation leases send nothing and do not replay after updates", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    h.shell.emitFrame({ targetId: TARGET, frame: sessionSnapshotFrame("rev-2", 2) });
    await settle();
    h.shell.leaseRefused = true;
    session.write("blocked");
    session.resize(90, 20);
    session.kill();
    await settle();
    expect(h.shell.inputs).toHaveLength(0);
    expect(h.shell.resizes).toHaveLength(0);
    expect(h.shell.closes).toHaveLength(0);
    h.shell.emitFrame({ targetId: TARGET, frame: sessionSnapshotFrame("rev-3", 3) });
    await settle();
    expect(h.shell.inputs).toHaveLength(0);
    expect(h.shell.resizes).toHaveLength(0);
    expect(h.shell.closes).toHaveLength(0);
  });

  it("serializes input writes strictly in order", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    h.shell.holdInput = true;
    expect(session.write("first")).toBe(true);
    expect(session.write("second")).toBe(true);
    await settle();
    expect(h.shell.heldInputs.map((held) => held.request.data)).toEqual(["first"]);
    h.shell.heldInputs[0]?.release();
    await settle();
    expect(h.shell.heldInputs.map((held) => held.request.data)).toEqual(["first", "second"]);
    h.shell.heldInputs[1]?.release();
    await settle();
    expect(h.shell.inputs.map((request) => request.data)).toEqual(["first", "second"]);
    const scoped = h.shell.inputs[0];
    expect(scoped?.targetId).toBe(TARGET);
    expect(String(scoped?.hostId)).toBe(HOST);
    expect(String(scoped?.sessionId)).toBe(SESSION);
    expect(String(scoped?.terminalId)).toBe(SERVER_TERMINAL);
  });

  it("reports saturation and drains once the queue empties", async () => {
    const h = await harness({ bridgeOptions: { maxPendingInputChars: 4 } });
    const { session, events } = await openLive(h);
    h.shell.holdInput = true;
    expect(session.write("abc")).toBe(true);
    expect(session.write("xyz")).toBe(false);
    await settle();
    const drainsBefore = events.drains.length;
    h.shell.heldInputs[0]?.release();
    await settle();
    expect(events.drains.length).toBe(drainsBefore + 1);
    expect(h.shell.inputs.map((request) => request.data)).toEqual(["abc"]);
  });

  it("coalesces resize to the latest while one is in flight", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    h.shell.holdResize = true;
    session.resize(100, 30);
    session.resize(101, 31);
    session.resize(102, 32);
    await settle();
    expect(h.shell.heldResizes).toHaveLength(1);
    h.shell.heldResizes[0]?.release();
    await settle();
    expect(h.shell.heldResizes).toHaveLength(2);
    h.shell.heldResizes[1]?.release();
    await settle();
    expect(
      h.shell.resizes.map((request) => [request.cols, request.rows]),
    ).toEqual([
      [100, 30],
      [102, 32],
    ]);
  });

  it("closes exactly once", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    session.kill();
    session.kill();
    await settle();
    expect(h.shell.closes).toHaveLength(1);
    const close = h.shell.closes[0];
    expect(String(close?.terminalId)).toBe(SERVER_TERMINAL);
    expect(close?.reason).toBe("closed by user");
  });

  it("kill during open closes the settled terminal once and registers nothing", async () => {
    const h = await harness();
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    session.kill();
    h.shell.emitFrame({
      targetId: TARGET,
      frame: openResponseFrame(h.shell.lastOpenRequestId, {
        ok: true,
        terminalId: SERVER_TERMINAL,
      }),
    });
    await settle();
    expect(h.shell.closes).toHaveLength(1);
    expect(h.shell.closes[0]?.reason).toBe("closed before ready");
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "ghost") });
    expect(events.data).toEqual([]);
  });
});

describe("disconnect and reconnect", () => {
  it("marks live shells unknown on disconnect and never replays on reconnect", async () => {
    const h = await harness();
    const { session, events } = await openLive(h);
    expect(session.write("typed-before")).toBe(true);
    await settle();
    h.shell.emitState({ targetId: TARGET, state: "disconnected" });
    await settle();
    expect(events.errors).toEqual([
      {
        kind: "shell-error",
        message: "The connection dropped. The shell may still be running on the host.",
      },
    ]);
    const opensBefore = h.shell.termOpenRequests().length;
    const inputsBefore = h.shell.inputs.length;
    h.shell.emitState({ targetId: TARGET, state: "connected" });
    await settle();
    // No second terminal, no replayed open or input — reopening is explicit.
    expect(h.shell.termOpenRequests()).toHaveLength(opensBefore);
    expect(h.shell.inputs).toHaveLength(inputsBefore);
    expect(session.write("typed-after")).toBe(true);
    await settle();
    expect(h.shell.inputs).toHaveLength(inputsBefore);
  });

  it("dispose detaches everything and quiets live sessions", async () => {
    const h = await harness();
    const { events } = await openLive(h);
    h.bridge.dispose();
    h.shell.emitFrame({ targetId: TARGET, frame: outputFrame(1, "after-dispose") });
    expect(events.data).toEqual([]);
    expect(() => h.bridge.open(openRequest())).toThrow(/disposed/);
  });
});

describe("fixture bridge stays untouched", () => {
  it("browser mode still gets the deterministic sample shell", () => {
    const bridge = createFixturePtyBridge({ agentOwnedTerminalIds: ["agent-1"] });
    expect(bridge.kind).toBe("fixture");
    const session = bridge.open(openRequest({ terminalId: "tab-fixture" }));
    expect(session).toBeInstanceOf(FixturePtySession);
    expect(() => bridge.open(openRequest({ terminalId: "agent-1" }))).toThrow(/read-only/);
  });
});

describe("session ownership gating", () => {
  const observedReason = presentSessionControl(OBSERVER_CONTROL).controlReason;

  it("refuses to open a shell while another app owns the session", async () => {
    const h = await harness();
    h.shell.emitFrame({
      targetId: TARGET,
      frame: sessionsFrame(2, { sessionControl: OBSERVER_CONTROL }),
    });
    await settle();
    expect(h.bridge.availability()).toEqual({
      available: false,
      kind: "permission",
      reason: observedReason,
    });
    const session = h.bridge.open(openRequest());
    const events = watch(session);
    await settle();
    expect(events.errors).toEqual([{ kind: "permission-denied", message: observedReason }]);
    expect(h.shell.termOpenRequests()).toHaveLength(0);
  });

  it("keeps an unrecognized future control shape read-only for shells", async () => {
    const h = await harness();
    h.shell.emitFrame({
      targetId: TARGET,
      frame: sessionsFrame(2, { sessionControl: { mode: "someday-mode" } }),
    });
    await settle();
    const availability = h.bridge.availability();
    expect(availability.available).toBe(false);
    expect(h.bridge.open(openRequest())).toBeDefined();
    await settle();
    expect(h.shell.termOpenRequests()).toHaveLength(0);
  });

  it("gates input dispatch the moment ownership moves mid-session", async () => {
    const h = await harness();
    const { session, events } = await openLive(h);
    h.shell.emitFrame({
      targetId: TARGET,
      frame: sessionsFrame(2, { sessionControl: OBSERVER_CONTROL }),
    });
    await settle();
    expect(session.write("echo hi\n")).toBe(true);
    await settle();
    expect(h.shell.inputs).toHaveLength(0);
    expect(events.errors).toEqual([{ kind: "shell-error", message: observedReason }]);
  });

  it("drops resize and close dispatch while another app owns the session", async () => {
    const h = await harness();
    const { session, events } = await openLive(h);
    h.shell.emitFrame({
      targetId: TARGET,
      frame: sessionsFrame(2, { sessionControl: OBSERVER_CONTROL }),
    });
    await settle();
    session.resize(120, 40);
    await settle();
    expect(h.shell.resizes).toHaveLength(0);
    session.kill();
    await settle();
    expect(h.shell.closes).toHaveLength(0);
    expect(events.errors).toEqual([]);
  });

  it("keeps input, resize, and close flowing once the field clears", async () => {
    const h = await harness();
    const { session } = await openLive(h);
    h.shell.emitFrame({
      targetId: TARGET,
      frame: sessionsFrame(2, { sessionControl: OBSERVER_CONTROL }),
    });
    await settle();
    h.shell.emitFrame({ targetId: TARGET, frame: sessionsFrame(3, { isStreaming: false }) });
    await settle();
    expect(session.write("echo back\n")).toBe(true);
    await settle();
    expect(h.shell.inputs).toHaveLength(1);
    session.kill();
    await settle();
    expect(h.shell.closes).toHaveLength(1);
  });
});
