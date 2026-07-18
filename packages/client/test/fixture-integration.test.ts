import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { FixtureWebSocketServer } from "@t4-code/fixture-server";
import { OmpClient, ProjectionStore, type OmpTransport, type Unsubscribe } from "../src/index.ts";

class WebSocketTransport implements OmpTransport {
  private readonly socket: WebSocket;
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  private readonly historicalMessages = new Set<(data: string | Uint8Array) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  constructor(address: string) {
    this.socket = new WebSocket(address);
    this.socket.on("message", (data) => { for (const listener of this.messages) listener(data as Uint8Array); });
    this.socket.on("close", (code, reason) => { for (const listener of this.closes) listener(code, reason.toString()); });
    this.socket.on("error", (error) => { for (const listener of this.errors) listener(error); });
  }
  get isOpen(): boolean { return this.socket.readyState === WebSocket.OPEN; }
  async opened(): Promise<void> { if (this.socket.readyState === WebSocket.OPEN) return; const { promise, resolve, reject } = Promise.withResolvers<void>(); this.socket.once("open", resolve); this.socket.once("error", reject); return promise; }
  send(data: string): void { this.socket.send(data); }
  close(): void { this.socket.close(); }
  /** Exercise the generation guard after this transport has been detached. */
  emitHistorical(data: string | Uint8Array): void { for (const listener of this.historicalMessages) listener(data); }
  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe { this.messages.add(listener); this.historicalMessages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener: (error: unknown) => void): Unsubscribe { this.errors.add(listener); return () => this.errors.delete(listener); }
}


async function yieldLoop(): Promise<void> { const { promise, resolve } = Promise.withResolvers<void>(); setImmediate(resolve); return promise; }
function waitForState(client: OmpClient, expected: string): Promise<void> {
  if (client.state === expected) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  let dispose: Unsubscribe | undefined;
  dispose = client.onState((state) => {
    if (state.state === expected) {
      dispose?.();
      resolve();
    }
  });
  return promise;
}

function waitForCursor(client: OmpClient, epoch: string, minimumSeq: number): Promise<void> {
  const cursor = client.snapshot().cursor;
  if (cursor?.epoch === epoch && cursor.seq >= minimumSeq) return Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  let dispose: Unsubscribe | undefined;
  dispose = client.onEvent(() => {
    const next = client.snapshot().cursor;
    if (next?.epoch === epoch && next.seq >= minimumSeq) {
      dispose?.();
      resolve();
    }
  });
  return promise;
}
describe("OmpClient and FixtureWebSocketServer projection boundary", () => {
  it("handshakes and feeds real FixtureWebSocketServer frames into projection", async () => {
    const server = new FixtureWebSocketServer({ scenario: "stream-v1" });
    await server.start();
    const projection = new ProjectionStore();
    let currentTransport: WebSocketTransport | undefined;
    const client = new OmpClient({ hostId: "host-stream", projection, reconnect: { baseMs: 5, maxMs: 20 }, transport: async () => { currentTransport = new WebSocketTransport(server.address); await currentTransport.opened(); return currentTransport; } });
    try {
      await client.connect();
      await client.attach("host-stream", "session-stream");
      const key = "host-stream\u0000session-stream";
      expect(projection.snapshot.sessions.has(key)).toBe(true);
      expect(projection.snapshot.sessions.get(key)!.entries).toHaveLength(1);
      const { promise: streamed, resolve: resolveStreamed } = Promise.withResolvers<void>();
      const { promise: settled, resolve: resolveSettled } = Promise.withResolvers<void>();
      const disposeStream = projection.subscribe((snapshot) => {
        const session = snapshot.sessions.get(key);
        const updates = session?.events.filter((event) => event.event.type === "message.update").length;
        if ((updates ?? 0) >= 2) resolveStreamed();
        if (
          session?.entries.length === 2 &&
          session.events.some((event) => event.event.type === "agent.end")
        ) resolveSettled();
      });
      const prompt = client.command({ hostId: "host-stream", sessionId: "session-stream", command: "session.prompt", args: { message: "hello" } });
      await prompt;
      server.advanceBy(40);
      await Promise.all([streamed, settled]);
      disposeStream();
      // The subscription above proves both live events crossed the real
      // WebSocket boundary. Once the matching durable entry arrives, the
      // projection must retire those transient frames so the response cannot
      // render twice. The settlement correlation marker remains available so
      // a freshly recreated runtime can suppress a lagging pendingPrompt ref.
      expect(
        projection.snapshot.sessions.get(key)!.events.map((event) => event.event.type),
      ).toEqual([
        "agent.start",
        "turn.start",
        "message.settled",
        "turn.end",
        "agent.end",
      ]);
      expect(projection.snapshot.sessions.get(key)!.entries).toHaveLength(2);
      expect(JSON.stringify(projection.snapshot)).not.toContain("deviceToken");
      const { promise: reconnected, resolve: resolveReconnect } = Promise.withResolvers<void>();
      const disposeReconnect = client.onState((state) => { if (state.state === "ready") resolveReconnect(); });
      currentTransport?.close();
      await reconnected;
      disposeReconnect();
    } finally {
      await client.close();
      await server.stop();
    }
  });
  it("reconnects across an appserver restart and replaces the saved cursor epoch", async () => {
    const firstServer = new FixtureWebSocketServer({ scenario: "stream-v1" });
    await firstServer.start();
    const replacementServer = new FixtureWebSocketServer({ scenario: "stream-v1" });
    const projection = new ProjectionStore();
    let endpoint = firstServer.address;
    let currentTransport: WebSocketTransport | undefined;
    const client = new OmpClient({
      hostId: "host-stream",
      projection,
      reconnect: { baseMs: 5, maxMs: 20 },
      transport: async () => {
        currentTransport = new WebSocketTransport(endpoint);
        await currentTransport.opened();
        return currentTransport;
      },
    });
    let reconnectReady!: () => void;
    const reconnecting = new Promise<void>((resolve) => { reconnectReady = resolve; });
    let waitingForReconnect = false;
    let replayed!: () => void;
    const replaying = new Promise<void>((resolve) => { replayed = resolve; });
    const disposeReplay = projection.subscribe((snapshot) => {
      if (snapshot.sessions.get("host-stream\u0000session-stream")?.cursor?.epoch === "epoch-stream-restarted") replayed();
    });
    const disposeState = client.onState((state) => {
      if (waitingForReconnect && state.state === "ready") reconnectReady();
    });
    try {
      await client.connect();
      await client.attach("host-stream", "session-stream");
      const before = client.snapshot();
      expect(before.cursor?.epoch).toBe("epoch-stream-1");

      waitingForReconnect = true;
      await replacementServer.start();
      endpoint = replacementServer.address;
      replacementServer.engine.restart("epoch-stream-restarted");
      currentTransport?.close();
      await reconnecting;
      await replaying;
      disposeReplay();

      const after = client.snapshot();
      expect(after.state).toBe("ready");
      expect(after.generation).toBeGreaterThan(before.generation);
      expect(after.attempt).toBeGreaterThan(0);
      expect(after.cursor?.epoch).toBe("epoch-stream-restarted");
    } finally {
      disposeState();
      await client.close();
      await firstServer.stop();
      await replacementServer.stop();
    }
  });
  it("recovers two attached clients across a replacement host without cursor or generation loss", async () => {
    const firstServer = new FixtureWebSocketServer({ scenario: "stream-v1" });
    await firstServer.start();
    const replacementServer = new FixtureWebSocketServer({ scenario: "stream-v1" });
    const projectionA = new ProjectionStore();
    const projectionB = new ProjectionStore();
    let endpointA = firstServer.address;
    let endpointB = firstServer.address;
    const transportsA: WebSocketTransport[] = [];
    const transportsB: WebSocketTransport[] = [];
    let currentTransportA: WebSocketTransport | undefined;
    let currentTransportB: WebSocketTransport | undefined;
    let holdAFactory = false;
    const { promise: aFactoryGate, resolve: releaseAFactory } = Promise.withResolvers<void>();
    const { promise: aFactoryEntered, resolve: markAFactoryEntered } = Promise.withResolvers<void>();
    const clientA = new OmpClient({
      hostId: "host-stream",
      projection: projectionA,
      reconnect: { baseMs: 250, maxMs: 250 },
      transport: async () => {
        if (holdAFactory) {
          markAFactoryEntered();
          await aFactoryGate;
        }
        currentTransportA = new WebSocketTransport(endpointA);
        transportsA.push(currentTransportA);
        await currentTransportA.opened();
        return currentTransportA;
      },
    });
    const clientB = new OmpClient({
      hostId: "host-stream",
      projection: projectionB,
      reconnect: { baseMs: 250, maxMs: 250 },
      transport: async () => {
        currentTransportB = new WebSocketTransport(endpointB);
        transportsB.push(currentTransportB);
        await currentTransportB.opened();
        return currentTransportB;
      },
    });
    let replaySnapshotsA = 0;
    let replaySnapshotsB = 0;
    const disposeEventsA = clientA.onEvent((event) => {
      if (event.kind === "snapshot" && event.payload.cursor.epoch === "epoch-two-client-restarted") replaySnapshotsA += 1;
    });
    const disposeEventsB = clientB.onEvent((event) => {
      if (event.kind === "snapshot" && event.payload.cursor.epoch === "epoch-two-client-restarted") replaySnapshotsB += 1;
    });
    try {
      await Promise.all([clientA.connect(), clientB.connect()]);
      await Promise.all([
        clientA.attach("host-stream", "session-stream"),
        clientB.attach("host-stream", "session-stream"),
      ]);
      const initialA = clientA.snapshot();
      const initialB = clientB.snapshot();
      expect(initialA.cursor?.epoch).toBe("epoch-stream-1");
      expect(initialB.cursor?.epoch).toBe("epoch-stream-1");
      expect(initialA.cursor?.seq).toBe(0);
      expect(initialB.cursor?.seq).toBe(0);

      holdAFactory = true;
      currentTransportA?.close();
      await waitForState(clientA, "reconnect-wait");
      await aFactoryEntered;

      const advancedB = waitForCursor(clientB, "epoch-stream-1", 1);
      const prompt = clientB.command({
        hostId: "host-stream",
        sessionId: "session-stream",
        command: "session.prompt",
        args: { message: "client-b" },
      });
      await yieldLoop();
      await prompt;
      firstServer.advanceBy(40);
      await advancedB;
      const savedA = clientA.snapshot().cursor;
      const savedB = clientB.snapshot().cursor;
      expect(savedA?.epoch).toBe("epoch-stream-1");
      expect(savedB?.epoch).toBe("epoch-stream-1");
      expect(savedA?.seq).toBe(0);
      expect(savedB?.seq).toBeGreaterThan(savedA?.seq ?? -1);

      await replacementServer.start();
      endpointA = replacementServer.address;
      endpointB = replacementServer.address;
      replacementServer.engine.restart("epoch-two-client-restarted");
      currentTransportB?.close();
      await waitForState(clientB, "reconnect-wait");
      await firstServer.stop();

      const recoveryStartedAt = performance.now();
      const readyA = waitForState(clientA, "ready");
      const readyB = waitForState(clientB, "ready");
      const replayA = waitForCursor(clientA, "epoch-two-client-restarted", 0);
      const replayB = waitForCursor(clientB, "epoch-two-client-restarted", 0);
      releaseAFactory();
      clientB.wake();
      await Promise.all([readyA, readyB, replayA, replayB]);
      const recoveryMs = performance.now() - recoveryStartedAt;
      expect(recoveryMs).toBeLessThan(3_000);
      expect(clientA.snapshot().generation).toBeGreaterThan(initialA.generation);
      expect(clientB.snapshot().generation).toBeGreaterThan(initialB.generation);
      expect(clientA.snapshot().attempt).toBeGreaterThan(0);
      expect(clientB.snapshot().attempt).toBeGreaterThan(0);
      expect(replaySnapshotsA).toBeGreaterThanOrEqual(1);
      expect(replaySnapshotsB).toBeGreaterThanOrEqual(1);
      expect(clientA.resources().socket).toBe(true);
      expect(clientB.resources().socket).toBe(true);
      expect(clientA.resources().socketHandlers).toBe(3);
      expect(clientB.resources().socketHandlers).toBe(3);
      expect(transportsA.filter((transport) => transport.isOpen)).toHaveLength(1);
      expect(transportsB.filter((transport) => transport.isOpen)).toHaveLength(1);

      const cursorBeforeStaleA = clientA.snapshot().cursor;
      const cursorBeforeStaleB = clientB.snapshot().cursor;
      const staleFrame = JSON.stringify({
        v: "omp-app/1",
        type: "snapshot",
        cursor: { epoch: "epoch-stale-old-generation", seq: 999 },
        revision: "rev-stream-1",
        hostId: "host-stream",
        sessionId: "session-stream",
        entries: [],
      });
      transportsA[0]?.emitHistorical(staleFrame);
      transportsB[0]?.emitHistorical(staleFrame);
      await yieldLoop();
      expect(clientA.snapshot().cursor).toEqual(cursorBeforeStaleA);
      expect(clientB.snapshot().cursor).toEqual(cursorBeforeStaleB);

      const advancedA = waitForCursor(clientA, "epoch-two-client-restarted", 1);
      const advancedAfterRecoveryB = waitForCursor(clientB, "epoch-two-client-restarted", 1);
      const replacementPrompt = clientA.command({
        hostId: "host-stream",
        sessionId: "session-stream",
        command: "session.prompt",
        args: { message: "client-a-after-restart" },
      });
      await yieldLoop();
      await replacementPrompt;
      replacementServer.advanceBy(40);
      await Promise.all([advancedA, advancedAfterRecoveryB]);
      expect(clientA.snapshot().cursor?.epoch).toBe("epoch-two-client-restarted");
      expect(clientB.snapshot().cursor?.epoch).toBe("epoch-two-client-restarted");
      expect(clientA.snapshot().cursor?.seq).toBeGreaterThan(0);
      expect(clientB.snapshot().cursor?.seq).toBeGreaterThan(0);
    } finally {
      releaseAFactory();
      disposeEventsA();
      disposeEventsB();
      await Promise.all([clientA.close(), clientB.close()]);
      await firstServer.stop();
      await replacementServer.stop();
    }
  });
});
