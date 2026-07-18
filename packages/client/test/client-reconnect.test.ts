import { describe, expect, it } from "vite-plus/test";
import {
  decodeClientFrame,
  hostId,
  revision,
  sessionId,
  type ClientFrame,
  type CommandFrame,
  type ServerFrame,
  type WelcomeFrame,
} from "@t4-code/protocol";
import { OmpClient, type Clock, type OmpTransport, type PublicOmpServerEvent, type TimerScheduler } from "../src/index.ts";

const HOST = "host-fixture";
const SESSION = "session-fixture";
const SESSION_TWO = "session-fixture-two";
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
  advanceBy(ms: number): void {
    const target = this.nowValue + ms;
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
}

interface FakeTransportOptions {
  welcome?: WelcomeFrame;
  sendError?: unknown;
  onSend?: (frame: ClientFrame, transport: FakeTransport) => void;
}
class FakeTransport implements OmpTransport {
  readonly sent: string[] = [];
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly historicalMessages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private closed = false;
  constructor(private readonly options: FakeTransportOptions = {}) {}
  get isOpen(): boolean { return !this.closed; }
  onMessage(listener: (data: string | Uint8Array) => void): () => void {
    this.messages.add(listener);
    this.historicalMessages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(listener: (code?: number, reason?: string) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): () => void { this.errors.add(listener); return () => this.errors.delete(listener); }
  send(data: string): void {
    this.sent.push(data);
    const frame = decodeClientFrame(data);
    if (frame.type === "hello" && this.options.sendError !== undefined) throw this.options.sendError;
    if (frame.type === "hello" && this.options.welcome !== undefined) this.emit(this.options.welcome);
    this.options.onSend?.(frame, this);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.closes]) listener(1000, "closed");
  }
  emit(frame: unknown): void {
    const data = JSON.stringify(frame);
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.messages]) listener(data);
  }
  emitLate(frame: unknown): void {
    const data = JSON.stringify(frame);
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve callbacks that intentionally outlive unsubscribe.
    for (const listener of [...this.historicalMessages]) listener(data);
  }
  drop(code = 1006, reason = "dropped"): void {
    if (this.closed) return;
    this.closed = true;
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.closes]) listener(code, reason);
  }
  lastClientFrame(): ClientFrame { return decodeClientFrame(this.sent[this.sent.length - 1]!); }
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
    result: {
      ...(command.command === "session.attach"
        ? { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }
        : {}),
      ...result,
    },
  };
}
function snapshot(seq = 0, session = SESSION): ServerFrame {
  return {
    v: V,
    type: "snapshot",
    cursor: { epoch: "epoch-a", seq },
    revision: revision("rev-a"),
    hostId: hostId(HOST),
    sessionId: sessionId(session),
    entries: [],
  };
}
function event(seq: number, session = SESSION): ServerFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-a", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(session),
    event: { type: "message.delta", text: String(seq) },
  };
}
async function flushReconnect(clock: FakeClock): Promise<void> {
  clock.advanceBy(0);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("OmpClient reconnect stability", () => {
  it("does not time out a heartbeat pong delivered synchronously from send", async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "ping") current.emit({ v: V, type: "pong", nonce: frame.nonce, timestamp: frame.timestamp });
      },
    });
    const client = new OmpClient({
      transport: () => transport,
      hostId: HOST,
      clock,
      timers: clock,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });
    await client.connect();

    clock.advanceBy(10);
    expect(client.state).toBe("ready");
    clock.advanceBy(5);
    expect(client.state).toBe("ready");
    await client.close();
  });
  it("lets a re-entrant reconnect-wait wake claim and clear its timer", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        factoryCalls += 1;
        return transports.shift() ?? new FakeTransport();
      },
      hostId: HOST,
      clock,
      timers: clock,
      random: () => 0,
      reconnect: { baseMs: 2_000, maxMs: 2_000 },
    });
    client.onState((snapshot) => {
      if (snapshot.state === "reconnect-wait") client.wake();
    });

    await client.connect();
    first.drop();
    await flushReconnect(clock);

    expect(client.state).toBe("ready");
    expect(factoryCalls).toBe(2);
    clock.advanceBy(2_000);
    expect(factoryCalls).toBe(2);
    await client.close();
  });

  it("retries when the hello transport send throws", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ sendError: new Error("socket write failed") });
    const second = new FakeTransport({ welcome: welcome() });
    const transports = [first, second];
    const errors: string[] = [];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      clock,
      timers: clock,
      random: () => 0,
      reconnect: { baseMs: 2, maxMs: 2 },
    });
    client.onError((error) => errors.push(error.code));

    const connecting = client.connect();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.state).toBe("reconnect-wait");
    clock.advanceBy(1);
    await connecting;

    expect(client.state).toBe("ready");
    expect(errors).toContain("transport");
    expect(client.snapshot().attempt).toBe(1);
    await client.close();
  });

  for (const [code, expectedError] of [[1008, "auth"], [1002, "protocol"]] as const) {
    it(`treats websocket close ${code} as fatal`, async () => {
      const transport = new FakeTransport({ welcome: welcome() });
      const errors: string[] = [];
      const client = new OmpClient({
        transport: () => transport,
        hostId: HOST,
        reconnect: { baseMs: 0, maxMs: 0 },
      });
      client.onError((error) => errors.push(error.code));
      await client.connect();

      transport.drop(code, "policy/protocol rejection");

      expect(client.state).toBe("fatal");
      expect(client.snapshot().attempt).toBe(0);
      await client.close();
      expect(client.resources().timers).toBe(0);
      expect(errors).toContain(expectedError);
    });
  }

  it("preserves attempts through manual wake until heartbeat health is proven", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const third = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second, third];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      clock,
      timers: clock,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
      random: () => 0,
      reconnect: { baseMs: 0, maxMs: 0 },
      wakeStaleAfterMs: 1,
    });

    await client.connect();
    first.drop();
    await flushReconnect(clock);
    expect(client.snapshot().attempt).toBe(1);

    clock.advanceBy(1);
    client.wake();
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(2);

    clock.advanceBy(10);
    const ping = third.lastClientFrame();
    expect(ping.type).toBe("ping");
    if (ping.type === "ping") {
      third.emit({ v: V, type: "pong", nonce: ping.nonce, timestamp: ping.timestamp });
    }
    expect(client.snapshot().attempt).toBe(0);
    await client.close();
  });

  it("foreground wake skips one pending backoff without opening duplicate transports", async () => {
    const clock = new FakeClock();
    const transports = [
      new FakeTransport({ welcome: welcome() }),
      new FakeTransport({ welcome: welcome({ resumed: true }) }),
    ];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        factoryCalls += 1;
        return transports[factoryCalls - 1] ?? new FakeTransport();
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      reconnect: { baseMs: 10_000, maxMs: 10_000 },
    });

    await client.connect();
    transports[0]?.drop();
    expect(client.state).toBe("reconnect-wait");
    expect(factoryCalls).toBe(1);

    client.wake();
    client.wake();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(2);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);
    await client.close();
  });

  it("foreground wake skips pending backoff without duplicating transport generations", async () => {
    const clock = new FakeClock();
    const transports = [
      new FakeTransport({ welcome: welcome() }),
      new FakeTransport({ welcome: welcome({ resumed: true }) }),
    ];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        factoryCalls += 1;
        return transports[factoryCalls - 1] ?? new FakeTransport();
      },
      hostId: HOST,
      timers: clock,
      clock,
      reconnect: { baseMs: 250, maxMs: 10_000 },
    });

    await client.connect();
    transports[0]?.drop();
    expect(client.state).toBe("reconnect-wait");

    client.wake();
    client.wake();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(2);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);
    await client.close();
  });

  it("explicit reconnectNow replaces a fresh socket exactly once", async () => {
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        const transport = transports[factoryCalls];
        factoryCalls += 1;
        return transport ?? new FakeTransport();
      },
      hostId: HOST,
      reconnect: { baseMs: 10_000, maxMs: 10_000 },
    });

    await client.connect();
    client.reconnectNow();
    client.reconnectNow();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(2);
    expect(client.state).toBe("ready");
    await client.close();
  });

  it("does not revive a non-retryable protocol failure on wake", async () => {
    const transport = new FakeTransport({ welcome: welcome() });
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        factoryCalls += 1;
        return transport;
      },
      hostId: HOST,
    });

    await client.connect();
    transport.emit({ v: V, type: "unknown" });
    expect(client.state).toBe("fatal");
    client.wake();
    client.reconnectNow();
    await Promise.resolve();

    expect(factoryCalls).toBe(1);
    expect(client.state).toBe("fatal");
    await client.close();
  });

  it("replaces only a stale ready socket on wake and preserves replay attachments", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const second = new FakeTransport({
      welcome: welcome({ resumed: true }),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const transports = [first, second];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        const transport = transports[factoryCalls];
        factoryCalls += 1;
        return transport ?? new FakeTransport();
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 100, timeoutMs: 10 },
      reconnect: { baseMs: 1_000, maxMs: 1_000 },
      wakeStaleAfterMs: 10,
    });

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    const pending = client.command({ hostId: HOST, command: "host.list", args: {} });
    const pendingFailure = expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });

    clock.advanceBy(9);
    client.wake();
    await Promise.resolve();
    expect(factoryCalls).toBe(1);
    expect(client.state).toBe("ready");

    clock.advanceBy(1);
    client.wake();
    client.wake();
    await pendingFailure;
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(2);
    expect(client.state).toBe("ready");
    expect(second.sent.map((raw) => decodeClientFrame(raw)).some(
      (frame) => frame.type === "command" && frame.command === "session.attach",
    )).toBe(true);
    await client.close();
  });

  it("gives a stale ready foreground replacement an indefinite retry budget", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const third = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second, third];
    let factoryCalls = 0;
    const errors: string[] = [];
    const client = new OmpClient({
      transport: () => {
        const transport = transports[factoryCalls];
        factoryCalls += 1;
        return transport ?? new FakeTransport();
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 100_000, timeoutMs: 100 },
      reconnect: { baseMs: 0, maxMs: 0 },
      wakeStaleAfterMs: 10,
    });
    client.onError((error) => errors.push(error.message));

    await client.connect();
    first.drop();
    expect(client.snapshot().attempt).toBe(1);
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);

    clock.advanceBy(10);
    client.wake();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(3);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(2);

    third.drop();
    expect(client.state).toBe("reconnect-wait");
    expect(client.snapshot().attempt).toBe(3);
    expect(factoryCalls).toBe(3);
    await client.close();
  });

  it("coalesces repeated stale ready wakes into one foreground replacement", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const third = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second, third];
    let factoryCalls = 0;
    const client = new OmpClient({
      transport: () => {
        const transport = transports[factoryCalls];
        factoryCalls += 1;
        return transport ?? new FakeTransport();
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 100_000, timeoutMs: 100 },
      reconnect: { baseMs: 0, maxMs: 0 },
      wakeStaleAfterMs: 10,
    });

    await client.connect();
    first.drop();
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);

    clock.advanceBy(10);
    client.wake();
    client.wake();
    client.wake();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(factoryCalls).toBe(3);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(2);
    await client.close();
  });

  it("retries through an outage longer than twelve attempts and recovers", async () => {
    const clock = new FakeClock();
    const transports: FakeTransport[] = [];
    let attaches = 0;
    const outageAttempts = 14;
    const client = new OmpClient({
      transport: () => {
        const transport = new FakeTransport({
          welcome: welcome({ resumed: transports.length > 0 }),
          onSend: (frame, current) => {
            if (frame.type !== "command" || frame.command !== "session.attach") return;
            attaches += 1;
            current.emit(responseFor(frame, { attached: true }));
            if (transports.length <= outageAttempts) {
              queueMicrotask(() => current.drop());
            }
          },
        });
        transports.push(transport);
        return transport;
      },
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 100_000, timeoutMs: 100 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });
    const errors: string[] = [];
    client.onError((error) => errors.push(error.message));

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    for (let turn = 0; turn < 20 && client.state !== "ready"; turn++) await flushReconnect(clock);

    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(14);
    expect(transports.length).toBeGreaterThan(12);
    expect(attaches).toBeGreaterThan(12);
    await client.close();
  });

  it("resets reconnect history only after a matched heartbeat pong", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome() });
    const second = new FakeTransport({ welcome: welcome({ resumed: true }) });
    const transports = [first, second];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });

    await client.connect();
    first.drop();
    expect(client.snapshot().attempt).toBe(1);
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);


    clock.advanceBy(10);
    const ping = second.lastClientFrame();
    if (ping.type !== "ping") throw new Error("expected heartbeat ping");
    second.emit({ v: V, type: "pong", nonce: "not-the-heartbeat", timestamp: ping.timestamp });
    expect(client.snapshot().attempt).toBe(1);
    second.emit({ v: V, type: "pong", nonce: ping.nonce, timestamp: ping.timestamp });
    expect(client.snapshot().attempt).toBe(0);
    await client.close();
  });

  it("rejects a delayed old-generation frame across replay without duplicating the durable event", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const second = new FakeTransport({
      welcome: welcome({ resumed: true }),
      onSend: (frame, current) => {
        if (frame.type !== "command" || frame.command !== "session.attach") return;
        current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 2 } }));
        current.emit(event(2));
      },
    });
    const transports = [first, second];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      clock,
      timers: clock,
      random: () => 0,
      reconnect: { baseMs: 0, maxMs: 0 },
    });
    const visible: number[] = [];
    client.onEvent((event) => {
      if (event.kind === "event" && String(event.payload.sessionId) === SESSION) visible.push(event.payload.cursor.seq);
    });

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    first.emit(event(1));
    first.drop();
    await flushReconnect(clock);

    expect(client.state).toBe("ready");
    expect(first.isOpen).toBe(false);
    expect(second.isOpen).toBe(true);
    expect(client.snapshot().cursor?.seq).toBe(2);
    expect(visible).toEqual([1, 2]);

    first.emitLate(event(1));
    await flushReconnect(clock);
    expect(client.snapshot().cursor?.seq).toBe(2);
    expect(visible).toEqual([1, 2]);
    await client.close();
  });

  it("keeps retry history until every reattach replay reaches its advertised cursor", async () => {
    const clock = new FakeClock();
    let delayedAttach: CommandFrame | undefined;
    const first = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const second = new FakeTransport({
      welcome: welcome({ resumed: true }),
      onSend: (frame) => {
        if (frame.type === "command" && frame.command === "session.attach") delayedAttach = frame;
      },
    });
    const third = new FakeTransport({
      welcome: welcome({ resumed: true }),
      onSend: (frame, current) => {
        if (frame.type !== "command" || frame.command !== "session.attach") return;
        current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 2 } }));
        current.emit(event(1));
        current.emit(event(2));
      },
    });
    const transports = [first, second, third];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    first.emit(snapshot());
    first.drop();
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(delayedAttach).toBeDefined();

    clock.advanceBy(10);
    const secondPing = second.lastClientFrame();
    if (secondPing.type !== "ping") throw new Error("expected heartbeat ping");
    second.emit({ v: V, type: "pong", nonce: secondPing.nonce, timestamp: secondPing.timestamp });
    expect(client.snapshot().attempt).toBe(1);
    if (delayedAttach === undefined) throw new Error("expected delayed reattach");
    second.emit(responseFor(delayedAttach, { attached: true, cursor: { epoch: "epoch-a", seq: 2 } }));
    expect(client.snapshot().attempt).toBe(1);

    second.drop();
    expect(client.snapshot().attempt).toBe(2);
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().cursor?.seq).toBe(2);
    expect(client.snapshot().attempt).toBe(2);

    clock.advanceBy(10);
    const thirdPing = third.lastClientFrame();
    if (thirdPing.type !== "ping") throw new Error("expected heartbeat ping");
    third.emit({ v: V, type: "pong", nonce: thirdPing.nonce, timestamp: thirdPing.timestamp });
    expect(client.snapshot().attempt).toBe(0);
    await client.close();
  });

  it("resets reconnect history only after every command-attached session finishes replay", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const reattached = new Set<string>();
    const second = new FakeTransport({
      welcome: welcome({ resumed: true }),
      onSend: (frame, current) => {
        if (frame.type !== "command" || frame.command !== "session.attach") return;
        if (frame.sessionId !== undefined) reattached.add(String(frame.sessionId));
        current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 1 } }));
      },
    });
    const transports = [first, second];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      heartbeat: { intervalMs: 10, timeoutMs: 5 },
      reconnect: { baseMs: 0, maxMs: 0 },
    });

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    await client.command({ hostId: HOST, sessionId: SESSION_TWO, command: "session.attach", args: {} });
    first.emit(snapshot(0, SESSION));
    first.emit(snapshot(0, SESSION_TWO));
    first.drop();
    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(reattached).toEqual(new Set([SESSION, SESSION_TWO]));

    clock.advanceBy(10);
    const ping = second.lastClientFrame();
    if (ping.type !== "ping") throw new Error("expected heartbeat ping");
    second.emit({ v: V, type: "pong", nonce: ping.nonce, timestamp: ping.timestamp });
    expect(client.snapshot().attempt).toBe(1);
    second.emit(event(1, SESSION));
    expect(client.snapshot().attempt).toBe(1);
    second.emit(event(1, SESSION_TWO));
    expect(client.snapshot().attempt).toBe(0);
    await client.close();
  });

  it("isolates a session gap while another command-attached session advances", async () => {
    const transport = new FakeTransport({
      welcome: welcome(),
      onSend: (frame, current) => {
        if (frame.type === "command" && frame.command === "session.attach") {
          current.emit(responseFor(frame, { attached: true, cursor: { epoch: "epoch-a", seq: 0 } }));
        }
      },
    });
    const client = new OmpClient({ transport: () => transport, hostId: HOST });
    const events: PublicOmpServerEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    await client.command({ hostId: HOST, sessionId: SESSION_TWO, command: "session.attach", args: {} });
    transport.emit(snapshot(0, SESSION));
    transport.emit(snapshot(0, SESSION_TWO));
    transport.emit({
      v: V,
      type: "gap",
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      from: { epoch: "epoch-a", seq: 1 },
      to: { epoch: "epoch-a", seq: 2 },
      reason: "reconnect",
    });
    transport.emit(event(1, SESSION_TWO));
    expect(events.some((event) => event.kind === "event" && String(event.payload.sessionId) === SESSION_TWO)).toBe(true);
    expect(client.snapshot().desynced).toBe(true);
    transport.emit(snapshot(2, SESSION));
    expect(client.snapshot().desynced).toBe(false);
    await client.close();
  });

  it("gives a successful pair credential rotation a fresh reconnect budget", async () => {
    const clock = new FakeClock();
    const first = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    const second = new FakeTransport({ welcome: welcome({ authentication: "pairing-required", grantedCapabilities: [] }) });
    const third = new FakeTransport({ welcome: welcome({ authentication: "paired" }) });
    const transports = [first, second, third];
    const client = new OmpClient({
      transport: () => transports.shift() ?? new FakeTransport(),
      hostId: HOST,
      timers: clock,
      clock,
      random: () => 0,
      privilegedPairResult: () => undefined,
      reconnect: { baseMs: 0, maxMs: 0 },
    });

    await client.connect();
    first.drop();
    expect(client.snapshot().attempt).toBe(1);
    await flushReconnect(clock);
    expect(client.state).toBe("pairing");

    const pairing = client.pairStart({
      code: "123456",
      deviceId: "device",
      deviceName: "test",
      platform: "linux",
      requestedCapabilities: [],
    });
    const request = second.lastClientFrame();
    if (request.type !== "pair.start") throw new Error("expected pair start");
    second.emit({
      v: V,
      type: "pair.ok",
      requestId: request.requestId,
      pairingId: "pair-1",
      deviceId: "device",
      deviceName: "test",
      platform: "linux",
      requestedCapabilities: [],
      grantedCapabilities: [],
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    await pairing;
    expect(client.state).toBe("reconnect-wait");
    expect(client.snapshot().attempt).toBe(1);

    await flushReconnect(clock);
    expect(client.state).toBe("ready");
    expect(client.snapshot().attempt).toBe(1);
    await client.close();
  });
});
