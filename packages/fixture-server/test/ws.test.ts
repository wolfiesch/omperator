import { describe, expect, it } from "vite-plus/test";
import WebSocket from "ws";
import { FixtureWebSocketServer } from "../src/ws.ts";

const hello = {
  v: "omp-app/1",
  type: "hello",
  protocol: { min: "omp-app/1", max: "omp-app/1" },
  client: { name: "ws-test", version: "1", build: "test", platform: "linux" },
  requestedFeatures: ["resume"],
  savedCursors: [],
};
function opened(socket: WebSocket): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.once("open", resolve);
  socket.once("error", reject);
  return promise;
}
function closed(socket: WebSocket): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  socket.once("close", (code) => resolve(code));
  socket.once("error", () => resolve(1006));
  return promise;
}
function nextMessage(socket: WebSocket): Promise<unknown> {
  const { promise, resolve } = Promise.withResolvers<unknown>();
  socket.once("message", (data) => resolve(JSON.parse(data.toString("utf8")) as unknown));
  return promise;
}
function messages(socket: WebSocket, count: number): Promise<unknown[]> {
  const values: unknown[] = [];
  const { promise, resolve } = Promise.withResolvers<unknown[]>();
  socket.on("message", (data) => {
    values.push(JSON.parse(data.toString("utf8")) as unknown);
    if (values.length === count) resolve(values);
  });
  return promise;
}

async function start(): Promise<FixtureWebSocketServer> {
  const server = new FixtureWebSocketServer({ scenario: "basic-v1" });
  await server.start();
  return server;
}

describe("loopback fixture websocket", () => {
  it("binds loopback, rejects strict paths/hosts, and cleans up", async () => {
    const server = await start();
    expect(server.address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/fixture$/u);
    const wrong = new WebSocket(server.address.replace("/fixture", "/wrong"));
    expect(await closed(wrong)).toBeGreaterThan(0);
    const wrongHost = new WebSocket(server.address.replace("127.0.0.1", "localhost"));
    expect(await closed(wrongHost)).toBeGreaterThan(0);
    const clientConnected = server.waitForClientCount(1);
    const socket = new WebSocket(server.address);
    await opened(socket);
    await clientConnected;
    const frameMessages = messages(socket, 6);
    socket.send(JSON.stringify(hello));
    expect(await frameMessages).toHaveLength(6);
    expect(server.clientCount).toBe(1);
    const socketClose = closed(socket);
    await server.stop();
    await socketClose;
    expect(server.clientCount).toBe(0);
    expect(server.port).toBe(0);
    expect(server.engine.scheduler.pending()).toBe(0);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
  it("honors a requested port and rejects binary and oversized payloads", async () => {
    const first = await start();
    const requestedPort = first.port;
    await first.stop();
    const server = new FixtureWebSocketServer({ scenario: "basic-v1", port: requestedPort });
    await server.start();
    expect(server.port).toBe(requestedPort);
    const binary = new WebSocket(server.address);
    await opened(binary);
    const binaryClosed = closed(binary);
    binary.send(Buffer.from(JSON.stringify(hello)));
    expect(await binaryClosed).toBe(1009);
    await server.waitForClientCount(0);
    const oversized = new WebSocket(server.address);
    await opened(oversized);
    const oversizedClosed = closed(oversized);
    oversized.send("x".repeat(server.maxPayload + 1));
    expect(await oversizedClosed).toBe(1009);
    await server.waitForClientCount(0);
    await server.stop();
  });
  it("passes duplicate-key text through the protocol decoder and cleans disconnected clients", async () => {
    const server = await start();
    const socket = new WebSocket(server.address);
    await opened(socket);
    const handshake = messages(socket, 6);
    socket.send(JSON.stringify(hello));
    await handshake;
    expect(server.clientCount).toBe(1);
    const malformed = nextMessage(socket);
    socket.send('{"v":"omp-app/1","v":"omp-app/1","type":"ping","nonce":"n","timestamp":"t"}');
    expect(await malformed).toMatchObject({ type: "error", code: "INVALID_JSON" });
    const done = closed(socket);
    const serverCleanup = server.waitForClientCount(0);
    socket.close();
    await done;
    await serverCleanup;
    expect(server.clientCount).toBe(0);
    expect(server.engine.clientCount).toBe(0);
    await server.stop();
  });
  it("broadcasts a session-management delta to another live websocket client", async () => {
    const server = await start();
    const manager = new WebSocket(server.address);
    const observer = new WebSocket(server.address);
    await Promise.all([opened(manager), opened(observer)]);
    const managerHello = messages(manager, 6);
    const observerHello = messages(observer, 6);
    manager.send(JSON.stringify(hello));
    observer.send(JSON.stringify(hello));
    await Promise.all([managerHello, observerHello]);

    const managerFrames = messages(manager, 2);
    const observerDelta = nextMessage(observer);
    manager.send(
      JSON.stringify({
        v: "omp-app/1",
        type: "command",
        requestId: "archive-request",
        commandId: "archive-command",
        hostId: server.engine.seed.hostId,
        sessionId: server.engine.seed.sessionId,
        command: "session.archive",
        expectedRevision: server.engine.currentRevision,
        args: {},
      }),
    );

    expect(await managerFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response", ok: true, result: { archived: true } }),
        expect.objectContaining({
          type: "session.delta",
          upsert: expect.objectContaining({ archivedAt: expect.any(String) }),
        }),
      ]),
    );
    expect(await observerDelta).toMatchObject({
      type: "session.delta",
      upsert: { archivedAt: server.engine.seed.baseTime },
    });

    manager.close();
    observer.close();
    await server.stop();
  });
  it("creates a distinct session and converges list, attach, and prompt over two sockets", async () => {
    const server = new FixtureWebSocketServer({ scenario: "stream-v1" });
    await server.start();
    const manager = new WebSocket(server.address);
    const observer = new WebSocket(server.address);
    await Promise.all([opened(manager), opened(observer)]);
    const managerHello = messages(manager, 6);
    const observerHello = messages(observer, 6);
    manager.send(JSON.stringify(hello));
    observer.send(JSON.stringify(hello));
    await Promise.all([managerHello, observerHello]);

    const managerCreate = messages(manager, 2);
    const observerCreate = nextMessage(observer);
    manager.send(
      JSON.stringify({
        v: "omp-app/1",
        type: "command",
        requestId: "create-request",
        commandId: "create-command",
        hostId: server.engine.seed.hostId,
        command: "session.create",
        args: { projectId: server.engine.seed.projectId, title: "Created over websocket" },
      }),
    );

    const createFrames = await managerCreate;
    const createResponse = createFrames.find(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        (frame as { type?: unknown }).type === "response",
    ) as { ok: true; result: { session: { sessionId: string; revision: string } } } | undefined;
    expect(createResponse).toMatchObject({
      ok: true,
      result: {
        session: {
          project: { projectId: server.engine.seed.projectId },
          title: "Created over websocket",
        },
      },
    });
    if (createResponse === undefined) throw new Error("fixture websocket did not create a session");
    const createdSessionId = createResponse.result.session.sessionId;
    expect(createdSessionId).not.toBe(server.engine.seed.sessionId);
    expect(createFrames).toContainEqual(
      expect.objectContaining({
        type: "session.delta",
        sessionId: createdSessionId,
        upsert: expect.objectContaining({ sessionId: createdSessionId }),
      }),
    );
    expect(await observerCreate).toMatchObject({
      type: "session.delta",
      sessionId: createdSessionId,
      upsert: { sessionId: createdSessionId },
    });

    const observerList = messages(observer, 2);
    observer.send(
      JSON.stringify({
        v: "omp-app/1",
        type: "command",
        requestId: "list-request",
        commandId: "list-command",
        hostId: server.engine.seed.hostId,
        command: "session.list",
        args: {},
      }),
    );
    expect(await observerList).toContainEqual(
      expect.objectContaining({
        type: "sessions",
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: server.engine.seed.sessionId }),
          expect.objectContaining({ sessionId: createdSessionId }),
        ]),
      }),
    );

    const attached = messages(observer, 2);
    observer.send(
      JSON.stringify({
        v: "omp-app/1",
        type: "command",
        requestId: "attach-created-request",
        commandId: "attach-created-command",
        hostId: server.engine.seed.hostId,
        sessionId: createdSessionId,
        command: "session.attach",
        args: {},
      }),
    );
    expect(await attached).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response",
          ok: true,
          result: expect.objectContaining({ attached: true }),
        }),
        expect.objectContaining({ type: "snapshot", sessionId: createdSessionId, entries: [] }),
      ]),
    );

    const promptResponse = nextMessage(observer);
    observer.send(
      JSON.stringify({
        v: "omp-app/1",
        type: "command",
        requestId: "prompt-created-request",
        commandId: "prompt-created-command",
        hostId: server.engine.seed.hostId,
        sessionId: createdSessionId,
        command: "session.prompt",
        expectedRevision: createResponse.result.session.revision,
        args: { message: "write through the created websocket session" },
      }),
    );
    expect(await promptResponse).toMatchObject({
      type: "response",
      ok: true,
      result: { accepted: true },
    });
    const streamed = messages(observer, 9);
    server.advanceBy(30);
    const journal = (await streamed).filter(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        ((frame as { type?: unknown }).type === "entry" ||
          (frame as { type?: unknown }).type === "event"),
    ) as Array<{ sessionId: string }>;
    expect(journal).toHaveLength(8);
    expect(journal.every((frame) => frame.sessionId === createdSessionId)).toBe(true);

    manager.close();
    observer.close();
    await server.stop();
  });
});
