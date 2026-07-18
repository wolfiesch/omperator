import { describe, expect, it, vi } from "vite-plus/test";
import {
  decodeClientFrame,
  hostId,
  projectId,
  revision,
  sessionId,
  type ClientFrame,
  type CommandFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "@t4-code/protocol";
import { FixtureWebSocketServer } from "@t4-code/fixture-server";
import WebSocket from "ws";
import {
  DefaultIds,
  isConfirmationDecisionConsumed,
  OmpClient,
  type Clock,
  type CursorRecord,
  type CursorStore,
  type OmpTransport,
  type PublicOmpServerEvent,
  type TimerScheduler,
} from "../src/index.ts";

const HOST = "host-fixture";
const SESSION = "session-fixture";
const V = "omp-app/1" as const;

function welcome(overrides: Partial<WelcomeFrame> = {}): WelcomeFrame {
  return {
    v: V,
    type: "welcome",
    selectedProtocol: V,
    hostId: hostId(HOST),
    ompVersion: "fixture",
    ompBuild: "test",
    appserverVersion: "fixture",
    appserverBuild: "test",
    epoch: "epoch-a",
    grantedCapabilities: ["sessions.read", "sessions.prompt", "sessions.control", "sessions.manage"],
    grantedFeatures: ["resume"],
    negotiatedLimits: { maxInputBytes: 1_048_576 },
    authentication: "local",
    resumed: false,
    ...overrides,
  };
}

class FakeClock implements Clock, TimerScheduler {
  private nowValue = 0;
  private nextHandle = 1;
  private readonly tasks = new Map<number, { at: number; order: number; callback: () => void }>();
  now(): number { return this.nowValue; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.tasks.set(handle, { at: this.nowValue + delayMs, order: handle, callback });
    return handle;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }
  advanceBy(ms: number): void { this.advanceTo(this.nowValue + ms); }
  advanceTo(target: number): void {
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[1].order - b[1].order)[0];
      if (due === undefined) break;
      this.tasks.delete(due[0]);
      this.nowValue = due[1].at;
      due[1].callback();
    }
    this.nowValue = target;
  }
  pending(): number { return this.tasks.size; }
}

interface FakeTransportOptions {
  welcome?: WelcomeFrame | string | Uint8Array;
  onSend?: (frame: ClientFrame, transport: FakeTransport) => void;
}
class FakeTransport implements OmpTransport {
  readonly sent: string[] = [];
  closed = false;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  constructor(private readonly options: FakeTransportOptions = {}) {}
  onMessage(listener: (data: string | Uint8Array) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  send(data: string): void {
    this.sent.push(data);
    const frame = decodeClientFrame(data);
    if (frame.type === "hello" && this.options.welcome !== undefined) this.emit(this.options.welcome);
    this.options.onSend?.(frame, this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.closes]) listener(1000, "closed");
  }
  // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
  fail(error: unknown): void { for (const listener of [...this.errors]) listener(error); }
  emit(frame: unknown): void {
    const data = typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame);
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.messages]) listener(data);
  }
  drop(code = 1006, reason = "dropped"): void {
    if (this.closed) return;
    this.closed = true;
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.closes]) listener(code, reason);
  }
  lastClientFrame(): ClientFrame { return decodeClientFrame(this.sent[this.sent.length - 1]!); }
}

class FakeStore implements CursorStore {
  readonly saved: CursorRecord[] = [];
  constructor(private readonly records: readonly CursorRecord[] = [], private readonly loadError = false, private readonly saveError = false) {}
  load(): readonly CursorRecord[] { if (this.loadError) throw new Error("load failed"); return this.records; }
  save(record: CursorRecord): void { if (this.saveError) throw new Error("save failed"); this.saved.push(record); }
}
class DeferredStore implements CursorStore {
  readonly requests: CursorRecord[] = [];
  readonly resolves: Array<() => void> = [];
  readonly rejects: Array<() => void> = [];
  failNext = false;
  load(): readonly CursorRecord[] { return []; }
  save(record: CursorRecord): Promise<void> {
    this.requests.push(record);
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("save failed"));
    }
    return new Promise<void>((resolve, reject) => {
      this.resolves.push(resolve);
      this.rejects.push(() => reject(new Error("save failed")));
    });
  }
}

function defaultResultFor(command: CommandFrame): Record<string, unknown> {
  if (command.command === "host.list" || command.command === "session.list") {
    return {
      cursor: { epoch: "epoch-a", seq: 0 },
      sessions: [],
      totalCount: 0,
      truncated: false,
    };
  }
  if (command.command === "session.attach") {
    return { attached: true, cursor: { epoch: "epoch-a", seq: 0 } };
  }
  if (command.command === "session.cancel") return { cancelled: true };
  return {};
}
function responseFor(command: CommandFrame, result: Record<string, unknown> = {}): ServerFrame {
  return {
    v: V,
    type: "response",
    requestId: command.requestId,
    commandId: command.commandId,
    hostId: command.hostId,
    ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
    command: command.command,
    ok: true,
    result: { ...defaultResultFor(command), ...result },
  };
}

async function flushMicrotasks(turns = 12): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}
function confirmationFor(command: CommandFrame): ServerFrame {
  return {
    v: V,
    type: "confirmation",
    confirmationId: "confirmation-fixture" as never,
    commandId: command.commandId,
    hostId: command.hostId,
    ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
    commandHash: "sha256:fixture",
    revision: revision("rev-a"),
    expiresAt: "2999-01-01T00:00:00.000Z",
    summary: command.command,
  };
}
async function readyClient(transport: FakeTransport, options: Partial<ConstructorParameters<typeof OmpClient>[0]> = {}): Promise<OmpClient> {
  const client = new OmpClient({ transport: () => transport, hostId: HOST, reconnect: { baseMs: 5, maxMs: 20 }, ...options });
  await client.connect();
  return client;
}
function snapshot(seq = 0, epoch = "epoch-a"): ServerFrame {
  return { v: V, type: "snapshot", cursor: { epoch, seq }, revision: revision("rev-a"), hostId: hostId(HOST), sessionId: sessionId(SESSION), entries: [] };
}
function event(seq: number, epoch = "epoch-a"): ServerFrame {
  return { v: V, type: "event", cursor: { epoch, seq }, hostId: hostId(HOST), sessionId: sessionId(SESSION), event: { type: "message.delta", text: String(seq) } };
}
function sessionDelta(seq: number, epoch = "epoch-a"): ServerFrame {
  return {
    v: V,
    type: "session.delta",
    cursor: { epoch, seq },
    revision: revision("rev-a"),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    upsert: {
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      project: { projectId: projectId("project-fixture"), name: "fixture" },
      revision: revision("rev-a"),
      title: "Fixture",
      status: "active",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("OmpClient protocol state machine", () => {
  it("sends hello first and correlates concurrent responses out of order", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    expect(decodeClientFrame(transport.sent[0]!).type).toBe("hello");
    const first = client.command({ hostId: HOST, command: "host.list" });
    const second = client.command({ hostId: HOST, command: "session.list" });
    const commands = transport.sent.slice(-2).map((raw) => decodeClientFrame(raw)).filter((frame): frame is CommandFrame => frame.type === "command");
    transport.emit(responseFor(commands[1]!, { n: 2 }));
    transport.emit(responseFor(commands[0]!, { n: 1 }));
    expect((await first).result).toMatchObject({ n: 1 });
    expect((await second).result).toMatchObject({ n: 2 });
    await client.close();
  });
  it.each(["approve", "deny"] as const)(
    "correlates a valid %s confirmation response to both the original command and confirm request",
    async (decision) => {
      const transport = new FakeTransport({ welcome: welcome() });
      const client = await readyClient(transport);
      const commandResult = client.command({
        hostId: HOST,
        sessionId: SESSION,
        command: "session.cancel",
        args: {},
      });
      const command = transport.lastClientFrame();
      if (command.type !== "command") throw new Error("expected command");

      // OMP issues the challenge without settling the original command.
      transport.emit(confirmationFor(command));
      const confirmResult = client.confirm({
        confirmationId: "confirmation-fixture",
        commandId: String(command.commandId),
        hostId: HOST,
        sessionId: SESSION,
        decision,
      });
      const confirm = transport.lastClientFrame();
      if (confirm.type !== "confirm") throw new Error("expected confirm");
      expect(confirm.requestId).not.toBe(command.requestId);
      expect(client.resources().pending).toBe(2);

      const response: ServerFrame = decision === "approve"
        ? responseFor(command, { cancelled: true })
        : {
            v: V,
            type: "response",
            requestId: command.requestId,
            commandId: command.commandId,
            hostId: command.hostId,
            ...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
            command: command.command,
            ok: false,
            error: { code: "confirmation_denied", message: "command was denied" },
          };
      // Valid approve and deny responses both carry the ORIGINAL requestId.
      transport.emit(response);
      const [settledCommand, settledConfirm] = await Promise.all([commandResult, confirmResult]);
      expect(settledCommand.requestId).toBe(command.requestId);
      expect(settledConfirm.requestId).toBe(command.requestId);
      expect(settledConfirm.ok).toBe(decision === "approve");
      expect(isConfirmationDecisionConsumed(settledConfirm)).toBe(true);
      expect(client.resources().pending).toBe(0);
      await client.close();
    },
  );
  it("settles an invalid confirmation by its own requestId without consuming the original command", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const commandResult = client.command({
      hostId: HOST,
      sessionId: SESSION,
      command: "session.cancel",
      args: {},
    });
    const commandOutcome = commandResult.then(
      () => ({ code: "resolved" }),
      (error: { code?: string }) => ({ code: error.code }),
    );
    const command = transport.lastClientFrame();
    if (command.type !== "command") throw new Error("expected command");
    transport.emit(confirmationFor(command));

    const confirmResult = client.confirm({
      confirmationId: "confirmation-fixture",
      commandId: String(command.commandId),
      hostId: HOST,
      sessionId: SESSION,
      decision: "approve",
    });
    const confirm = transport.lastClientFrame();
    if (confirm.type !== "confirm") throw new Error("expected confirm");
    transport.emit({
      v: V,
      type: "response",
      requestId: confirm.requestId,
      commandId: confirm.commandId,
      hostId: confirm.hostId,
      sessionId: confirm.sessionId,
      ok: false,
      error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
    });
    const invalid = await confirmResult;
    expect(invalid.requestId).toBe(confirm.requestId);
    expect(isConfirmationDecisionConsumed(invalid)).toBe(false);
    expect(client.resources().pending).toBe(1);

    await client.close();
    expect(await commandOutcome).toEqual({ code: "closed" });
  });
  it("settles the confirm alias when the original command timed out before the host response", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { clock, timers: clock });
    const commandResult = client.command(
      { hostId: HOST, sessionId: SESSION, command: "session.cancel", args: {} },
      { timeoutMs: 5 },
    );
    const commandOutcome = commandResult.then(
      () => ({ code: "resolved" }),
      (error: { code?: string }) => ({ code: error.code }),
    );
    const command = transport.lastClientFrame();
    if (command.type !== "command") throw new Error("expected command");
    transport.emit(confirmationFor(command));
    const confirmResult = client.confirm(
      {
        confirmationId: "confirmation-fixture",
        commandId: String(command.commandId),
        hostId: HOST,
        sessionId: SESSION,
        decision: "approve",
      },
      { timeoutMs: 20 },
    );

    clock.advanceBy(5);
    expect(await commandOutcome).toEqual({ code: "timeout" });
    expect(client.resources().pending).toBe(1);
    transport.emit(responseFor(command, { cancelled: true }));
    const confirmed = await confirmResult;
    expect(confirmed.requestId).toBe(command.requestId);
    expect(confirmed).not.toHaveProperty("v");
    expect(confirmed).not.toHaveProperty("type");
    expect(client.resources().pending).toBe(0);
    await client.close();
  });
  it("namespaces command and request IDs across client lifetimes", async () => {
    const firstTransport = new FakeTransport({ welcome: welcome() });
    const firstClient = await readyClient(firstTransport);
    const firstPending = firstClient.command({ hostId: HOST, command: "host.list" });
    const firstFrame = firstTransport.lastClientFrame();
    if (firstFrame.type !== "command") throw new Error("expected command");
    firstTransport.emit(responseFor(firstFrame));
    await firstPending;
    await firstClient.close();

    const secondTransport = new FakeTransport({ welcome: welcome() });
    const secondClient = await readyClient(secondTransport);
    const secondPending = secondClient.command({ hostId: HOST, command: "host.list" });
    const secondFrame = secondTransport.lastClientFrame();
    if (secondFrame.type !== "command") throw new Error("expected command");
    expect(secondFrame.requestId).not.toBe(firstFrame.requestId);
    expect(secondFrame.commandId).not.toBe(firstFrame.commandId);
    secondTransport.emit(responseFor(secondFrame));
    await secondPending;
    await secondClient.close();
  });
  it("creates distinct IDs without a Web Crypto runtime", () => {
    vi.stubGlobal("crypto", undefined);
    try {
      const first = new DefaultIds().next("command");
      const second = new DefaultIds().next("command");
      expect(first).not.toBe(second);
      expect(first).toMatch(/^client-fallback-/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("sends one-way terminal frames only while ready without pending correlation", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    client.terminalInput({ hostId: HOST, sessionId: SESSION, terminalId: "terminal-a", data: "hi" });
    client.terminalResize({ hostId: HOST, sessionId: SESSION, terminalId: "terminal-a", cols: 80, rows: 24 });
    client.terminalClose({ hostId: HOST, sessionId: SESSION, terminalId: "terminal-a" });
    expect(transport.sent.slice(-3).map((raw) => decodeClientFrame(raw).type)).toEqual(["terminal.input", "terminal.resize", "terminal.close"]);
    expect(client.resources().pending).toBe(0);
    await client.close();
    expect(() => client.terminalInput({ hostId: HOST, sessionId: SESSION, terminalId: "terminal-a", data: "late" })).toThrow("client is not ready");
  });

  it("uses configurable welcome host, protocol, feature, and capability checks", async () => {
    const wrongHost = new FakeTransport({ welcome: welcome({ hostId: hostId("other-host") }) });
    const hostClient = new OmpClient({ transport: () => wrongHost, hostId: HOST });
    await expect(hostClient.connect()).rejects.toMatchObject({ code: "protocol" });
    expect(hostClient.state).toBe("fatal");
    const denied = new FakeTransport({ welcome: welcome({ grantedFeatures: [] }) });
    const featureClient = new OmpClient({ transport: () => denied, hostId: HOST, requiredFeatures: ["resume"] });
    await expect(featureClient.connect()).rejects.toMatchObject({ code: "capability" });
    const noCapability = new FakeTransport({ welcome: welcome({ grantedCapabilities: ["sessions.read"] }) });
    const capabilityClient = await readyClient(noCapability);
    await expect(capabilityClient.command({ hostId: HOST, sessionId: SESSION, command: "session.prompt", args: {} })).rejects.toMatchObject({ code: "capability" });
    await capabilityClient.close();
  });

  it("retries one rejected hello with the configured compatibility feature set", async () => {
    const clock = new FakeClock();
    const hellos: string[][] = [];
    const first = new FakeTransport({
      onSend: (frame, transport) => {
        if (frame.type !== "hello") return;
        hellos.push([...frame.requestedFeatures]);
        transport.drop(1008, "invalid frame");
      },
    });
    const second = new FakeTransport({
      welcome: welcome(),
      onSend: (frame) => {
        if (frame.type === "hello") hellos.push([...frame.requestedFeatures]);
      },
    });
    const transports = [first, second];
    const errors: string[] = [];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      reconnect: { baseMs: 2, maxMs: 2 },
      requestedFeatures: ["resume", "prompt.images", "transcript.images"],
      compatibilityRequestedFeatures: ["resume"],
    });
    client.onError((error) => errors.push(error.message));

    const connecting = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.state).toBe("reconnect-wait");
    clock.advanceBy(1);
    await connecting;

    expect(hellos).toEqual([
      ["resume", "prompt.images", "transcript.images"],
      ["resume"],
    ]);
    expect(errors).toContain(
      "Host uses an earlier feature set; reconnecting in compatibility mode.",
    );
    expect(client.state).toBe("ready");
    await client.close();
  });

  it("fails promptly when a host also rejects the compatibility hello", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const client = new OmpClient({
      transport: () => {
        attempts += 1;
        return new FakeTransport({
          onSend: (frame, transport) => {
            if (frame.type === "hello") transport.drop(1008, "invalid frame");
          },
        });
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      reconnect: { baseMs: 2, maxMs: 2 },
      requestedFeatures: ["resume", "prompt.images", "transcript.images"],
      compatibilityRequestedFeatures: ["resume"],
    });

    const connecting = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    clock.advanceBy(1);

    await expect(connecting).rejects.toMatchObject({ code: "protocol" });
    expect(attempts).toBe(2);
    expect(client.state).toBe("fatal");
    expect(client.resources().timers).toBe(0);
  });

  it("reports bounded decoder diagnostics without echoing frame values", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const errors: string[] = [];
    client.onError((error) => errors.push(error.message));
    transport.emit({ v: "secret-token-value", type: "welcome" });
    expect(errors).toEqual(["invalid server frame (MISSING_VERSION at v)"]);
    expect(errors[0]).not.toContain("secret-token-value");
    expect(client.state).toBe("fatal");
  });

  it("bounds hello cursors and reports cursor store load errors", async () => {
    const records = Array.from({ length: 140 }, (_, index) => ({ hostId: HOST, sessionId: `session-${index}`, cursor: { epoch: "epoch-a", seq: index } }));
    const store = new FakeStore(records);
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { cursorStore: store });
    const hello = decodeClientFrame(transport.sent[0]!);
    expect(hello.type === "hello" ? hello.savedCursors : []).toHaveLength(128);
    await client.close();
    const loadErrors: string[] = [];
    const failing = new OmpClient({ transport: () => new FakeTransport({ welcome: welcome() }), hostId: HOST, cursorStore: new FakeStore([], true) });
    failing.onError((error) => loadErrors.push(error.code));
    await failing.connect();
    expect(loadErrors).toContain("storage");
    await failing.close();
  });
  it("serializes deferred cursor saves, coalesces latest, and continues after failure", async () => {
    const store = new DeferredStore();
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { cursorStore: store });
    transport.emit(snapshot(1));
    transport.emit(snapshot(2));
    expect(store.requests.map((record) => record.cursor.seq)).toEqual([1]);
    store.failNext = true;
    store.resolves.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.requests.map((record) => record.cursor.seq)).toEqual([1, 2]);
    transport.emit(snapshot(3));
    expect(store.requests.map((record) => record.cursor.seq)).toEqual([1, 2, 3]);
    store.resolves.shift()?.();
    await client.close();
    expect(client.resources().cursorSaves).toBe(0);
  });

  it("never invokes privileged pairing sink for unsolicited, replayed, or wrong-kind pair.ok", async () => {
    let callbacks = 0;
    const unsolicitedTransport = new FakeTransport({ welcome: welcome() });
    const unsolicited = await readyClient(unsolicitedTransport, { privilegedPairResult: () => { callbacks += 1; } });
    unsolicitedTransport.emit({ v: V, type: "pair.ok", requestId: "unknown", pairingId: "pair", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    expect(callbacks).toBe(0);
    expect(unsolicited.state).toBe("fatal");
    await unsolicited.close();
    const wrongTransport = new FakeTransport({ welcome: welcome() });
    const wrong = await readyClient(wrongTransport, { privilegedPairResult: () => { callbacks += 1; } });
    const command = wrong.command({ hostId: HOST, command: "host.list" });
    const request = wrongTransport.lastClientFrame();
    if (request.type !== "command") throw new Error("expected command");
    wrongTransport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "pair", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    await expect(command).rejects.toMatchObject({ code: "protocol" });
    expect(callbacks).toBe(0);
    await wrong.close();
  });

  it("rejects unsent requests, marks handed-off drops unknown, and never replays", async () => {
    const transport = new FakeTransport({ welcome: welcome(), onSend: (frame) => { if (frame.type === "command") throw new Error("send rejected"); } });
    const client = await readyClient(transport);
    const unsent = client.command({ hostId: HOST, command: "host.list" });
    await expect(unsent).rejects.toMatchObject({ code: "transport" });
    const droppedTransport = new FakeTransport({ welcome: welcome() });
    const droppedClient = await readyClient(droppedTransport);
    const command = droppedClient.command({ hostId: HOST, command: "host.list" });
    const count = droppedTransport.sent.length;
    droppedTransport.drop();
    await expect(command).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(droppedTransport.sent.length).toBe(count);
    await client.close();
    await droppedClient.close();
  });

  it("protects response correlation from spoofed host and command IDs", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const command = client.command({ hostId: HOST, command: "host.list" });
    const frame = transport.lastClientFrame();
    if (frame.type !== "command") throw new Error("expected command");
    transport.emit({ ...responseFor(frame), hostId: hostId("spoofed") });
    await expect(command).rejects.toMatchObject({ code: "protocol" });
    expect(client.state).toBe("fatal");
  });

  it("rejects a response replayed for another command name", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const pending = client.command({ hostId: HOST, command: "host.list" });
    const frame = transport.lastClientFrame();
    if (frame.type !== "command") throw new Error("expected command");
    transport.emit({
      v: V,
      type: "response",
      requestId: frame.requestId,
      commandId: frame.commandId,
      hostId: frame.hostId,
      ok: false,
      command: "settings.read",
      error: { code: "idempotency_conflict", message: "command ID conflict" },
    });
    await expect(pending).rejects.toMatchObject({ code: "protocol" });
    expect(client.state).toBe("fatal");
  });

  it("settles abort, timeout, and explicit close exactly once", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { clock, timers: clock });
    const controller = new AbortController();
    const aborted = client.command({ hostId: HOST, command: "host.list" }, { signal: controller.signal, timeoutMs: 20 });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    const timed = client.command({ hostId: HOST, command: "host.list" }, { timeoutMs: 20 });
    clock.advanceBy(20);
    await expect(timed).rejects.toMatchObject({ code: "timeout" });
    const closed = client.command({ hostId: HOST, command: "host.list" });
    await client.close();
    await expect(closed).rejects.toMatchObject({ code: "closed" });
    expect(client.resources()).toEqual({ timers: 0, socket: false, socketHandlers: 0, pending: 0, cursorSaves: 0, listeners: 0 });
  });

  it("ignores stale generation callbacks and closes stale transports", async () => {
    let resolveTransport: ((transport: FakeTransport) => void) | undefined;
    const stale = new FakeTransport();
    const client = new OmpClient({ transport: () => new Promise<FakeTransport>((resolve) => { resolveTransport = resolve; }), hostId: HOST });
    const connecting = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    await client.close();
    resolveTransport?.(stale);
    await expect(connecting).rejects.toMatchObject({ code: "closed" });
    await Promise.resolve();
    expect(stale.closed).toBe(true);
    expect(client.resources()).toEqual({ timers: 0, socket: false, socketHandlers: 0, pending: 0, cursorSaves: 0, listeners: 0 });
  });

  it("keeps session-index cursors independent from transcript contiguity", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const events: PublicOmpServerEvent[] = [];
    const errors: string[] = [];
    client.onEvent((event) => events.push(event));
    client.onError((error) => errors.push(error.code));
    transport.emit(snapshot());
    transport.emit(sessionDelta(1));
    // A host-wide index subscriber can miss transcript traffic and still
    // receive a later metadata delta. Neither delta advances the attached
    // transcript cursor, so its next seq=1 event remains contiguous.
    transport.emit(sessionDelta(9));
    transport.emit(event(1));
    expect(events.map((event) => event.kind)).toEqual([
      "snapshot",
      "session.delta",
      "session.delta",
      "event",
    ]);
    expect(errors).not.toContain("desync");
    expect(client.snapshot().cursor?.seq).toBe(1);
    await client.close();
  });

  it("deduplicates, detects skips and epochs, then recovers from snapshot", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    const events: PublicOmpServerEvent[] = [];
    const errors: string[] = [];
    client.onEvent((event) => events.push(event));
    client.onError((error) => errors.push(error.code));
    transport.emit(snapshot());
    transport.emit(event(1));
    transport.emit(event(1));
    transport.emit(event(3));
    transport.emit(event(4, "epoch-b"));
    transport.emit(snapshot(4, "epoch-b"));
    transport.emit(event(5, "epoch-b"));
    expect(events.filter((event) => event.kind === "event")).toHaveLength(2);
    expect(errors).toContain("desync");
    expect(client.snapshot().desynced).toBe(false);
    await client.close();
  });

  it.each([
    ["duplicate keys", '{"v":"omp-app/1","v":"omp-app/1","type":"pong","nonce":"n","timestamp":"t"}'],
    ["unknown frame", '{"v":"omp-app/1","type":"unknown"}'],
    ["invalid utf8", new Uint8Array([0xff, 0xfe])],
    ["oversize", `{"v":"omp-app/1","type":"pong","nonce":"${"x".repeat(1_048_577)}","timestamp":"t"}`],
  ] as const)("faults on %s with bounded teardown", async (_name, raw) => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport);
    transport.emit(raw);
    expect(client.state).toBe("fatal");
    expect(client.resources()).toMatchObject({ timers: 0, socket: false, socketHandlers: 0, pending: 0 });
    await client.close();
  });

  it("handles heartbeat pong and timeout", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { clock, timers: clock, heartbeat: { intervalMs: 10, timeoutMs: 5 }, reconnect: { baseMs: 0, maxMs: 0 } });
    clock.advanceBy(10);
    const ping = transport.lastClientFrame();
    expect(ping.type).toBe("ping");
    if (ping.type === "ping") transport.emit({ v: V, type: "pong", nonce: ping.nonce, timestamp: ping.timestamp });
    expect(client.state).toBe("ready");
    clock.advanceBy(10);
    clock.advanceBy(5);
    expect(client.state).toBe("connecting");
    await client.close();
  });

  it("uses lower-bounded jitter and retryable/nonretryable bye policy", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second];
    const client = new OmpClient({ transport: () => transports.shift() ?? new FakeTransport(), hostId: HOST, timers: clock, clock, random: () => 0, reconnect: { baseMs: 10, maxMs: 15 } });
    await client.connect();
    first.emit({ v: V, type: "bye", code: "retryable", reason: "try again", retryable: true });
    expect(clock.pending()).toBeGreaterThan(0);
    clock.advanceBy(4);
    expect(transports).toHaveLength(1);
    clock.advanceBy(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    second.emit({ v: V, type: "bye", code: "auth_failed", reason: "stop", retryable: false });
    expect(client.state).toBe("fatal");
    await client.close();
  });

  it("keeps pair.ok privileged and isolates listener throws/unsubscribe", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    let token = "";
    const publicEvents: PublicOmpServerEvent[] = [];
    const client = await readyClient(transport, { privilegedPairResult: (frame) => { token = frame.deviceToken; } });
    const unsubscribeEvent = client.onEvent(() => { throw new Error("listener"); });
    client.onEvent((event) => publicEvents.push(event));
    const pairing = client.pairStart({ code: "123456", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [] });
    const request = transport.lastClientFrame();
    if (request.type !== "pair.start") throw new Error("expected pair start");
    transport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "pair-1", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    const paired = await pairing;
    unsubscribeEvent();
    expect(token).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(paired).not.toHaveProperty("v");
    expect(paired).not.toHaveProperty("type");
    expect(publicEvents).toHaveLength(0);
    expect(JSON.stringify(publicEvents)).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    await client.close();
  });

  it("awaits pairing sink before reconnect and invalidates queued frames on close or overflow", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    let release!: () => void;
    const sink = new Promise<void>((resolve) => { release = resolve; });
    const client = await readyClient(transport, { privilegedPairResult: () => sink });
    const pairing = client.pairStart({ code: "123456", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [] });
    const request = transport.lastClientFrame();
    if (request.type !== "pair.start") throw new Error("expected pair start");
    transport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "pair-1", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    expect(client.state).toBe("pairing");
    release();
    await pairing;
    expect(transport.closed).toBe(true);
    await client.close();

    const failingTransport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    const failing = await readyClient(failingTransport, { privilegedPairResult: async () => { throw new Error("sink failed"); } });
    const failedPairing = failing.pairStart({ code: "123456", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [] });
    const failedRequest = failingTransport.lastClientFrame();
    if (failedRequest.type !== "pair.start") throw new Error("expected pair start");
    failingTransport.emit({ v: V, type: "pair.ok", requestId: failedRequest.requestId, pairingId: "pair-1", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    await expect(failedPairing).rejects.toMatchObject({ code: "auth" });
    expect(failing.state).toBe("fatal");
    await failing.close();
  });

  it("closes during a slow pairing sink without reconnecting", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    let release!: () => void;
    const sink = new Promise<void>((resolve) => { release = resolve; });
    const client = await readyClient(transport, { privilegedPairResult: () => sink });
    const pairing = client.pairStart({ code: "123456", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [] });
    const request = transport.lastClientFrame();
    if (request.type !== "pair.start") throw new Error("expected pair start");
    transport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "pair-1", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    const closing = client.close();
    release();
    await closing;
    await expect(pairing).rejects.toMatchObject({ code: "closed" });
    expect(transport.closed).toBe(true);
  });
  it("ignores stale pair.ok after close generation changes", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    let sinks = 0;
    const client = await readyClient(transport, { privilegedPairResult: () => { sinks += 1; } });
    const pairing = client.pairStart({ code: "123456", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [] });
    const request = transport.lastClientFrame();
    if (request.type !== "pair.start") throw new Error("expected pair start");
    await client.close();
    transport.emit({ v: V, type: "pair.ok", requestId: request.requestId, pairingId: "stale", deviceId: "device", deviceName: "test", platform: "linux", requestedCapabilities: [], grantedCapabilities: [], deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", expiresAt: "2030-01-01T00:00:00Z" });
    await expect(pairing).rejects.toMatchObject({ code: "closed" });
    expect(sinks).toBe(0);
  });

  it("bounds pending requests and reports startup failures without resources", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    const client = await readyClient(transport, { maxPending: 1 });
    const first = client.command({ hostId: HOST, command: "host.list" });
    await expect(client.command({ hostId: HOST, command: "host.list" })).rejects.toMatchObject({ code: "invalid_state" });
    await client.close();
    await expect(first).rejects.toMatchObject({ code: "closed" });
    const startup = new OmpClient({ transport: async () => { throw new Error("startup"); }, hostId: HOST, reconnect: { baseMs: 0, maxMs: 0 } });
    const startupErrors: string[] = [];
    const stopStartupErrors = startup.onError((error) => startupErrors.push(error.message));
    const startupConnect = startup.connect();
    await flushMicrotasks();
    expect(startup.state).toBe("reconnect-wait");
    await startup.close();
    await expect(startupConnect).rejects.toMatchObject({ code: "closed" });
    stopStartupErrors();
    expect(startup.resources()).toEqual({ timers: 0, socket: false, socketHandlers: 0, pending: 0, cursorSaves: 0, listeners: 0 });
  });

  it("shares a pending transport open and recovers when the next factory succeeds", async () => {
    const clock = new FakeClock();
    let releaseFirst!: () => void;
    const first = new Promise<OmpTransport>((_resolve, reject) => {
      releaseFirst = () => reject(new Error("open timed out"));
    });
    const second = new FakeTransport({ welcome: welcome() });
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        factoryCalls += 1;
        return factoryCalls === 1 ? first : second;
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      reconnect: { baseMs: 2, maxMs: 2 },
    });

    const firstConnect = client.connect();
    const secondConnect = client.connect();
    await flushMicrotasks();
    expect(client.state).toBe("connecting");
    expect(factoryCalls).toBe(1);

    releaseFirst();
    await flushMicrotasks();
    expect(client.state).toBe("reconnect-wait");
    clock.advanceBy(1);
    await Promise.all([firstConnect, secondConnect]);
    expect(factoryCalls).toBe(2);
    expect(client.state).toBe("ready");
    await client.close();
  });
});

describe("OmpClient live fixture websocket", () => {
  class WsTransport implements OmpTransport {
    private readonly messages = new Set<(data: string | Uint8Array) => void>();
    private readonly closes = new Set<(code?: number, reason?: string) => void>();
    private readonly errors = new Set<(error: unknown) => void>();
    constructor(private readonly socket: WebSocket) {
      socket.on("message", (data, isBinary) => {
        // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
        for (const listener of [...this.messages]) listener(isBinary ? new Uint8Array(data as Buffer) : String(data));
      });
      // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
      socket.on("close", (code, reason) => { for (const listener of [...this.closes]) listener(code, reason.toString()); });
      // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
      socket.on("error", (error) => { for (const listener of [...this.errors]) listener(error); });
    }
    static async open(address: string): Promise<WsTransport> {
      const socket = new WebSocket(address);
      await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
      return new WsTransport(socket);
    }
    send(data: string): void { this.socket.send(data); }
    close(): void { this.socket.close(); }
    onMessage(listener: (data: string | Uint8Array) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
    onClose(listener: (code?: number, reason?: string) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
    onError(listener: (error: unknown) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
    drop(): void { this.socket.terminate(); }
  }

  it("connects, attaches, prompts, persists ordered frames, resumes, and cleans up", async () => {
    const server = new FixtureWebSocketServer({ scenario: "stream-v1" });
    const address = await server.start();
    const transports: WsTransport[] = [];
    const store = new FakeStore();
    const client = new OmpClient({
      transport: async () => { const transport = await WsTransport.open(address); transports.push(transport); return transport; },
      hostId: "host-stream",
      cursorStore: store,
      heartbeat: { intervalMs: 100_000, timeoutMs: 100 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });
    const events: PublicOmpServerEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();
    await client.attach("host-stream", "session-stream");
    const prompt = client.command({ hostId: "host-stream", sessionId: "session-stream", command: "session.prompt", args: { message: "hello" } });
    await prompt;
    const entry = new Promise<void>((resolve) => {
      const unsubscribe = client.onEvent((event) => {
        if (event.kind === "entry") {
          unsubscribe();
          resolve();
        }
      });
    });
    server.advanceBy(30);
    await entry;
    expect(events.some((event) => event.kind === "snapshot")).toBe(true);
    expect(events.some((event) => event.kind === "entry")).toBe(true);
    expect(store.saved.length).toBeGreaterThan(0);
    const reconnected = new Promise<void>((resolve) => {
      const unsubscribe = client.onState((state) => {
        if (state.state === "ready" && transports.length > 1) {
          unsubscribe();
          resolve();
        }
      });
    });
    transports[0]!.drop();
    await reconnected;
    await server.stop();
    await client.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.resources()).toMatchObject({ timers: 0, socket: false, socketHandlers: 0, pending: 0, listeners: 0 });
    expect(server.clientCount).toBe(0);
  });
  it("restarts only one heartbeat loop on duplicate welcome", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({ welcome: welcome() });
    const client = new OmpClient({ transport: () => transport, hostId: HOST, timers: clock, clock, heartbeat: { intervalMs: 10, timeoutMs: 50 } });
    await client.connect();
    transport.emit(welcome());
    clock.advanceBy(10);
    const pings = transport.sent.filter((raw) => decodeClientFrame(raw).type === "ping").length;
    expect(pings).toBe(1);
    await client.close();
  });
  it("starts heartbeat after normal and pairing welcomes", async () => {
    const clock = new FakeClock();
    const readyTransport = new FakeTransport({ welcome: welcome(), onSend: (frame) => { if (frame.type === "ping") return; } });
    const readyClientInstance = new OmpClient({ transport: () => readyTransport, hostId: HOST, timers: clock, clock, heartbeat: { intervalMs: 10, timeoutMs: 5 } });
    await readyClientInstance.connect();
    clock.advanceBy(10);
    expect(readyTransport.sent.some((raw) => decodeClientFrame(raw).type === "ping")).toBe(true);
    await readyClientInstance.close();
    const pairingTransport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    const pairingClient = new OmpClient({ transport: () => pairingTransport, hostId: HOST, timers: clock, clock, heartbeat: { intervalMs: 10, timeoutMs: 5 } });
    await pairingClient.connect();
    clock.advanceBy(10);
    expect(pairingTransport.sent.some((raw) => decodeClientFrame(raw).type === "ping")).toBe(true);
    await pairingClient.close();
  });
  it("injects authenticated hello without exposing credentials", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "paired" }) });
    const client = new OmpClient({ transport: () => transport, hostId: HOST, authentication: () => ({ deviceId: "device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }) });
    const publicEvents: PublicOmpServerEvent[] = [];
    client.onEvent((event) => publicEvents.push(event));
    await client.connect();
    const hello = decodeClientFrame(transport.sent[0]!);
    expect(hello.type === "hello" ? hello.authentication?.deviceId : undefined).toBe("device");
    expect(JSON.stringify(client.snapshot())).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(publicEvents)).not.toContain("SECRET_TOKEN");
    await client.close();
  });
  it("enters pairing and denies commands until pairing completes", async () => {
    const transport = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    const client = new OmpClient({ transport: () => transport, hostId: HOST });
    await client.connect();
    expect(client.state).toBe("pairing");
    await expect(client.command({ hostId: HOST, command: "host.list" })).rejects.toMatchObject({ code: "invalid_state" });
    await expect(client.attach(HOST, SESSION)).rejects.toMatchObject({ code: "invalid_state" });
    await client.close();
  });
  it("fails closed when authentication provider throws or returns invalid data", async () => {
    const throwing = new OmpClient({ transport: () => new FakeTransport({ welcome: welcome() }), hostId: HOST, authentication: () => { throw new Error("secret"); } });
    await expect(throwing.connect()).rejects.toMatchObject({ code: "auth" });
    const invalid = new OmpClient({ transport: () => new FakeTransport({ welcome: welcome() }), hostId: HOST, authentication: () => ({ deviceId: "", deviceToken: "x" }) });
    await expect(invalid.connect()).rejects.toMatchObject({ code: "auth" });
  });
});
