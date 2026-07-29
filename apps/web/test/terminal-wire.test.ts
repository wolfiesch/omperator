// App-wire 0.3 terminal adapter contract: outbound frames are typed and
// decodable, inbound frames route by ownership (host + session + device +
// connection + terminal), duplicates are dropped by cursor, epoch changes
// mark reconnect boundaries, sequence gaps mark transient drops without
// ever losing an exit, and unknown/malformed frames degrade to ignores
// instead of crashes. Legacy `terminal` frames (agent shell evidence) never
// reach a user viewport.
import {
  decodeClientFrame,
  PROTOCOL_VERSION,
  type TerminalClientFrame,
} from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import type { PtyError, PtyExit, PtyNotice } from "../src/features/terminal/pty.ts";
import {
  buildTerminalClose,
  buildTerminalInput,
  buildTerminalResize,
  createTerminalFrameRouter,
  createWirePtyBridge,
  WIRE_MAX_COLS,
  WIRE_MAX_ROWS,
  type TerminalWireIdentity,
  type TerminalWireTransport,
  type WireTerminalOpenRequest,
} from "../src/features/terminal/wire.ts";

const IDENTITY: TerminalWireIdentity = {
  hostId: "host-1",
  sessionId: "session-1",
  deviceId: "device-1",
  connectionId: "conn-1",
};

function outputFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.output",
    hostId: "host-1",
    sessionId: "session-1",
    terminalId: "term-1",
    cursor: { epoch: "epoch-1", seq: 1 },
    stream: "stdout",
    data: "hello",
    ...overrides,
  };
}

function exitFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: PROTOCOL_VERSION,
    type: "terminal.exit",
    hostId: "host-1",
    sessionId: "session-1",
    terminalId: "term-1",
    cursor: { epoch: "epoch-1", seq: 9 },
    exitCode: 0,
    ...overrides,
  };
}

describe("outbound client frames", () => {
  it("input, resize, and close frames pass the wire decoder", () => {
    const input = buildTerminalInput(IDENTITY, "term-1", "echo hi\r");
    const resize = buildTerminalResize(IDENTITY, "term-1", 120, 32);
    const close = buildTerminalClose(IDENTITY, "term-1", "closed by user");
    for (const frame of [input, resize, close]) {
      const decoded = decodeClientFrame(frame);
      expect(decoded.type).toBe(frame.type);
    }
    expect(input.data).toBe("echo hi\r");
    expect(resize.cols).toBe(120);
    expect(resize.rows).toBe(32);
  });

  it("resize clamps to the wire dimension bounds", () => {
    const tiny = buildTerminalResize(IDENTITY, "term-1", 0, -3);
    expect(tiny.cols).toBe(1);
    expect(tiny.rows).toBe(1);
    const huge = buildTerminalResize(IDENTITY, "term-1", 9_999, 9_999);
    expect(huge.cols).toBe(WIRE_MAX_COLS);
    expect(huge.rows).toBe(WIRE_MAX_ROWS);
    expect(() => decodeClientFrame(huge)).not.toThrow();
  });

  it("outbound frames carry the ownership tuple's host and session", () => {
    const frame = buildTerminalInput(IDENTITY, "term-1", "x");
    expect(frame.hostId).toBe(IDENTITY.hostId);
    expect(frame.sessionId).toBe(IDENTITY.sessionId);
    expect(frame.terminalId).toBe("term-1");
  });
});

describe("frame router: direction and ownership", () => {
  it("routes owned terminal.output in order", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    const first = router.route(outputFrame({ cursor: { epoch: "e", seq: 1 }, data: "a" }));
    const second = router.route(outputFrame({ cursor: { epoch: "e", seq: 2 }, data: "b" }));
    expect(first).toMatchObject({ kind: "output", data: "a", resumed: false, gap: false });
    expect(second).toMatchObject({ kind: "output", data: "b", resumed: false, gap: false });
  });

  it("a client-direction frame is never routed as output", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    const event = router.route({
      v: PROTOCOL_VERSION,
      type: "terminal.input",
      hostId: "host-1",
      sessionId: "session-1",
      terminalId: "term-1",
      data: "injected",
    });
    expect(event.kind).toBe("ignored");
  });

  it("legacy agent terminal frames are refused — Activity owns them", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    const event = router.route({
      v: PROTOCOL_VERSION,
      type: "terminal",
      hostId: "host-1",
      sessionId: "session-1",
      terminalId: "term-1",
      stream: "stdout",
      data: "agent output",
    });
    expect(event).toEqual({ kind: "ignored", reason: "agent-terminal" });
  });

  it("frames for a foreign host, session, or unowned terminal are dropped", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    expect(router.route(outputFrame({ hostId: "host-2" }))).toEqual({
      kind: "ignored",
      reason: "foreign-host",
    });
    expect(router.route(outputFrame({ sessionId: "session-2" }))).toEqual({
      kind: "ignored",
      reason: "foreign-session",
    });
    expect(router.route(outputFrame({ terminalId: "term-agent" }))).toEqual({
      kind: "ignored",
      reason: "unowned-terminal",
    });
    // Released terminals stop receiving too.
    router.release("term-1");
    expect(router.route(outputFrame())).toEqual({
      kind: "ignored",
      reason: "unowned-terminal",
    });
  });

  it("unknown and malformed frames degrade to ignores, never throws", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    const cases: unknown[] = [
      null,
      42,
      "not a frame",
      {},
      { type: "terminal.output" },
      { v: "omp-app/999", type: "terminal.output" },
      { v: PROTOCOL_VERSION, type: "mystery.frame" },
      outputFrame({ cursor: { epoch: "e", seq: -1 } }),
      outputFrame({ stream: "weird" }),
      outputFrame({ data: 42 }),
      exitFrame({ exitCode: "zero" }),
    ];
    for (const frame of cases) {
      const event = router.route(frame);
      expect(event.kind, JSON.stringify(frame)).toBe("ignored");
    }
    // Valid non-terminal server frames are ignored as unrelated.
    const pong = router.route({ v: PROTOCOL_VERSION, type: "pong" });
    expect(pong.kind).toBe("ignored");
  });
});

describe("frame router: cursor dedup, order, gaps, epochs", () => {
  it("drops same-epoch replays at or below the last sequence", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    router.route(outputFrame({ cursor: { epoch: "e", seq: 5 } }));
    expect(router.route(outputFrame({ cursor: { epoch: "e", seq: 5 } }))).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });
    expect(router.route(outputFrame({ cursor: { epoch: "e", seq: 3 } }))).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });
    expect(router.route(outputFrame({ cursor: { epoch: "e", seq: 6 } }))).toMatchObject({
      kind: "output",
      gap: false,
    });
  });

  it("a sequence jump marks a transient gap but still delivers", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    router.route(outputFrame({ cursor: { epoch: "e", seq: 1 } }));
    const event = router.route(outputFrame({ cursor: { epoch: "e", seq: 7 }, data: "late" }));
    expect(event).toMatchObject({ kind: "output", data: "late", gap: true });
  });

  it("an epoch change marks a reconnect boundary and resets dedup", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    router.route(outputFrame({ cursor: { epoch: "e1", seq: 40 } }));
    const event = router.route(outputFrame({ cursor: { epoch: "e2", seq: 1 }, data: "fresh" }));
    expect(event).toMatchObject({ kind: "output", data: "fresh", resumed: true });
    // Dedup now runs against the new epoch.
    expect(router.route(outputFrame({ cursor: { epoch: "e2", seq: 1 } }))).toEqual({
      kind: "ignored",
      reason: "duplicate",
    });
  });

  it("exit survives a gap: transient output may drop, the result never does", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    router.route(outputFrame({ cursor: { epoch: "e", seq: 1 } }));
    const event = router.route(
      exitFrame({ cursor: { epoch: "e", seq: 9 }, exitCode: 143, signal: "TERM" }),
    );
    expect(event).toMatchObject({
      kind: "exit",
      exitCode: 143,
      signal: "TERM",
      gap: true,
    });
  });

  it("base64 output decodes to text; utf8 passes through", () => {
    const router = createTerminalFrameRouter(IDENTITY);
    router.own("term-1");
    const event = router.route(
      outputFrame({ data: btoa("binary-ish"), encoding: "base64" }),
    );
    expect(event).toMatchObject({ kind: "output", data: "binary-ish" });
  });
});

describe("wire PTY bridge", () => {
  interface FakeTransport extends TerminalWireTransport {
    readonly sent: TerminalClientFrame[];
    readonly openRequests: WireTerminalOpenRequest[];
    accepting: boolean;
    push(frame: unknown): void;
    drain(): void;
    resolveOpen(terminalId: string): void;
    rejectOpen(message: string): void;
  }

  function fakeTransport(): FakeTransport {
    const sent: TerminalClientFrame[] = [];
    const openRequests: WireTerminalOpenRequest[] = [];
    const frameListeners = new Set<(frame: unknown) => void>();
    const drainListeners = new Set<() => void>();
    const pendingOpens: Array<{
      resolve: (result: { terminalId: string }) => void;
      reject: (error: Error) => void;
    }> = [];
    const transport: FakeTransport = {
      identity: IDENTITY,
      sent,
      openRequests,
      accepting: true,
      openTerminal(request) {
        openRequests.push(request);
        const { promise, resolve, reject } = Promise.withResolvers<{ terminalId: string }>();
        pendingOpens.push({ resolve, reject });
        return promise;
      },
      sendFrame(frame) {
        if (!transport.accepting) return false;
        sent.push(frame);
        return true;
      },
      onFrame(listener) {
        frameListeners.add(listener);
        return () => frameListeners.delete(listener);
      },
      onDrain(listener) {
        drainListeners.add(listener);
        return () => drainListeners.delete(listener);
      },
      push(frame) {
        for (const listener of frameListeners) listener(frame);
      },
      drain() {
        for (const listener of drainListeners) listener();
      },
      resolveOpen(terminalId) {
        pendingOpens.shift()?.resolve({ terminalId });
      },
      rejectOpen(message) {
        pendingOpens.shift()?.reject(new Error(message));
      },
    };
    return transport;
  }

  const OPEN_REQUEST = {
    sessionId: "session-1",
    terminalId: "local-1",
    shell: "bash",
    cwd: ".",
    cols: 80,
    rows: 24,
  };

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it("holds input while opening, then flushes typed frames after open", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    let drains = 0;
    pty.onDrain(() => {
      drains += 1;
    });
    // Not open yet: writes are refused so the store queues them in order.
    expect(pty.write("early")).toBe(false);
    transport.resolveOpen("term-srv-1");
    await settle();
    expect(drains).toBe(1);
    expect(pty.write("after-open")).toBe(true);
    const input = transport.sent.find((frame) => frame.type === "terminal.input");
    expect(input).toMatchObject({
      type: "terminal.input",
      terminalId: "term-srv-1",
      data: "after-open",
      hostId: "host-1",
      sessionId: "session-1",
    });
  });

  it("routes owned output and exit to the session; exit is never lost", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    const chunks: string[] = [];
    const exits: PtyExit[] = [];
    const notices: PtyNotice[] = [];
    pty.onData((chunk) => chunks.push(chunk));
    pty.onExit((exit) => exits.push(exit));
    pty.onNotice((notice) => notices.push(notice));
    transport.resolveOpen("term-srv-1");
    await settle();
    transport.push(outputFrame({ terminalId: "term-srv-1", cursor: { epoch: "e", seq: 1 }, data: "one" }));
    // Duplicate replay is suppressed.
    transport.push(outputFrame({ terminalId: "term-srv-1", cursor: { epoch: "e", seq: 1 }, data: "one" }));
    // A frame for someone else's terminal never lands here.
    transport.push(outputFrame({ terminalId: "term-other", data: "foreign" }));
    // Gapped exit still lands, with the drop marked as a notice.
    transport.push(
      exitFrame({ terminalId: "term-srv-1", cursor: { epoch: "e", seq: 5 }, exitCode: 2 }),
    );
    expect(chunks).toEqual(["one"]);
    expect(exits).toEqual([{ code: 2, signal: null }]);
    expect(notices).toContain("output-skipped");
  });

  it("a refused open surfaces permission-denied without leaking detail", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    const errors: PtyError[] = [];
    pty.onError((error) => errors.push(error));
    transport.rejectOpen("capability terminals.write denied for device-1");
    await settle();
    expect(errors).toEqual([
      { kind: "permission-denied", message: "The host didn't allow this shell." },
    ]);
    // The failed session refuses further writes quietly.
    expect(pty.write("anything")).toBe(true);
    expect(transport.sent.filter((frame) => frame.type === "terminal.input")).toEqual([]);
  });

  it("kill closes the server PTY with a typed close frame", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    transport.resolveOpen("term-srv-1");
    await settle();
    pty.kill();
    const close = transport.sent.find((frame) => frame.type === "terminal.close");
    expect(close).toMatchObject({ type: "terminal.close", terminalId: "term-srv-1" });
    // Output after close no longer reaches the dead session.
    const chunks: string[] = [];
    pty.onData((chunk) => chunks.push(chunk));
    transport.push(outputFrame({ terminalId: "term-srv-1" }));
    expect(chunks).toEqual([]);
  });

  it("saturated transport refuses writes and drain releases them", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    transport.resolveOpen("term-srv-1");
    await settle();
    transport.accepting = false;
    expect(pty.write("held")).toBe(false);
    let drained = false;
    pty.onDrain(() => {
      drained = true;
    });
    transport.accepting = true;
    transport.drain();
    expect(drained).toBe(true);
    expect(pty.write("held")).toBe(true);
  });

  it("resize before open is remembered and sent once, clamped", async () => {
    const transport = fakeTransport();
    const bridge = createWirePtyBridge(transport);
    const pty = bridge.open(OPEN_REQUEST);
    pty.resize(5_000, 0);
    transport.resolveOpen("term-srv-1");
    await settle();
    const resize = transport.sent.find((frame) => frame.type === "terminal.resize");
    expect(resize).toMatchObject({
      type: "terminal.resize",
      terminalId: "term-srv-1",
      cols: WIRE_MAX_COLS,
      rows: 1,
    });
  });
});
