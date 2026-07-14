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
import { OmpClient, type Clock, type OmpTransport, type TimerScheduler } from "../src/index.ts";

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
  onSend?: (frame: ClientFrame, transport: FakeTransport) => void;
}
class FakeTransport implements OmpTransport {
  readonly sent: string[] = [];
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private closed = false;
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
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.closes]) listener(1000, "closed");
  }
  emit(frame: unknown): void {
    const data = JSON.stringify(frame);
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.messages]) listener(data);
  }
  drop(): void {
    if (this.closed) return;
    this.closed = true;
    // eslint-disable-next-line unicorn/no-useless-spread -- callbacks may unsubscribe while the fixture dispatches.
    for (const listener of [...this.closes]) listener(1006, "dropped");
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
      reconnect: { attemptCap: 0 },
    });
    await client.connect();

    clock.advanceBy(10);
    expect(client.state).toBe("ready");
    clock.advanceBy(5);
    expect(client.state).toBe("ready");
    await client.close();
  });

  it("caps reconnects when every post-welcome attach loses its replay", async () => {
    const clock = new FakeClock();
    const transports: FakeTransport[] = [];
    let attaches = 0;
    const client = new OmpClient({
      transport: () => {
        const transport = new FakeTransport({
          welcome: welcome({ resumed: transports.length > 0 }),
          onSend: (frame, current) => {
            if (frame.type !== "command" || frame.command !== "session.attach") return;
            attaches += 1;
            current.emit(responseFor(frame, { attached: true }));
            queueMicrotask(() => current.drop());
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
      reconnect: { baseMs: 0, maxMs: 0, attemptCap: 2 },
    });
    const errors: string[] = [];
    client.onError((error) => errors.push(error.message));

    await client.connect();
    await client.command({ hostId: HOST, sessionId: SESSION, command: "session.attach", args: {} });
    for (let turn = 0; turn < 12 && client.state !== "fatal"; turn++) await flushReconnect(clock);

    expect(client.state).toBe("fatal");
    expect(client.snapshot().attempt).toBe(2);
    expect(transports).toHaveLength(3);
    expect(attaches).toBe(3);
    expect(errors).toContain("reconnect attempt limit reached");
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
      reconnect: { baseMs: 0, maxMs: 0, attemptCap: 2 },
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
      reconnect: { baseMs: 0, maxMs: 0, attemptCap: 3 },
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
      reconnect: { baseMs: 0, maxMs: 0, attemptCap: 2 },
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
    const frames: ServerFrame[] = [];
    client.onFrame((frame) => frames.push(frame));

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
    expect(frames.some((frame) => frame.type === "event" && String(frame.sessionId) === SESSION_TWO)).toBe(true);
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
      reconnect: { baseMs: 0, maxMs: 0, attemptCap: 1 },
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
