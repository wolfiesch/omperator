import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";

import { OmpClient, ProjectionStore } from "../../../packages/client/src/index.ts";
import { awaitAutomaticGatewayResume, WebSocketTransport } from "../measure-slo-driver.mjs";


describe("gateway SLO scenario", () => {
  test("keeps one client alive and observes automatic reconnect and saved-cursor replay", async () => {
    const host = "gateway-host";
    const sessionId = "gateway-session";
    const cursor = { epoch: "session-epoch", seq: 8 };
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    expect(typeof address).toBe("object");
    if (typeof address !== "object" || address === null) throw new Error("WebSocket server address is unavailable");
    let connections = 0;
    let victimSocket;
    const hellos = [];
    const attaches = [];
    server.on("connection", (socket) => {
      connections += 1;
      const connection = connections;
      const replica = connection === 1 ? "victim-pod" : "survivor-pod";
      if (connection === 1) victimSocket = socket;
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "hello") {
          hellos.push(frame);
          socket.send(JSON.stringify({
            v: "omp-app/1",
            type: "welcome",
            selectedProtocol: "omp-app/1",
            hostId: host,
            ompVersion: "fixture",
            ompBuild: "test",
            appserverVersion: "fixture",
            appserverBuild: "test",
            epoch: `replica:${replica}`,
            grantedCapabilities: ["sessions.read"],
            grantedFeatures: ["resume"],
            negotiatedLimits: { maxInputBytes: 1_048_576 },
            authentication: "paired",
            resumed: connection > 1,
          }));
          return;
        }
        if (frame.type === "ping") {
          socket.send(JSON.stringify({ v: "omp-app/1", type: "pong", nonce: frame.nonce, timestamp: frame.timestamp }));
          return;
        }
        if (frame.type !== "command" || frame.command !== "session.attach") return;
        attaches.push({ connection, args: frame.args });
        socket.send(JSON.stringify({
          v: "omp-app/1",
          type: "response",
          requestId: frame.requestId,
          commandId: frame.commandId,
          hostId: host,
          sessionId,
          command: "session.attach",
          ok: true,
          result: { attached: true, cursor },
        }));
        socket.send(JSON.stringify({
          v: "omp-app/1",
          type: "snapshot",
          cursor,
          revision: "revision-gateway",
          hostId: host,
          sessionId,
          entries: [],
        }));
      });
    });
    const projection = new ProjectionStore();
    const records = new Map();
    const client = new OmpClient({
      reconnect: { baseMs: 10, maxMs: 10 },
      heartbeat: { intervalMs: 10_000, timeoutMs: 10_000 },
      handshakeTimeoutMs: 1_000,
      commandTimeoutMs: 1_000,
      authentication: () => ({ deviceId: "fixture-device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }),
      projection,
      cursorStore: {
        load: () => [...records.values()],
        save: (record) => { records.set(`${record.hostId}\0${record.sessionId}`, record); },
      },
      transport: async () => {
        const transport = new WebSocketTransport(`ws://127.0.0.1:${address.port}`, "fixture-api-token", 1_000);
        await transport.open();
        return transport;
      },
    });
    const initialSnapshot = Promise.withResolvers();
    const unsubscribeInitial = client.onEvent((event) => {
      if (event.kind === "snapshot" && String(event.payload.hostId) === host &&
          String(event.payload.sessionId) === sessionId) initialSnapshot.resolve(event.payload.cursor);
    });
    try {
      await client.connect();
      const attached = await client.attach(host, sessionId, { timeoutMs: 1_000 });
      expect(attached.ok).toBe(true);
      expect(await initialSnapshot.promise).toEqual(cursor);
      const originalClient = client;
      const resumed = awaitAutomaticGatewayResume({
        client,
        projection,
        key: `${host}\0${sessionId}`,
        host,
        sessionId,
        beforeCursor: cursor,
        survivorUids: new Set(["survivor-pod"]),
        timeoutSeconds: 2,
      });
      if (!victimSocket) throw new Error("the first connection did not identify its serving socket");
      victimSocket.terminate();
      const result = await resumed;
      expect(client).toBe(originalClient);
      expect(connections).toBe(2);
      expect(attaches.map((attach) => attach.connection)).toEqual([1, 2]);
      expect(hellos[1]?.savedCursors).toEqual([{ hostId: host, sessionId, cursor }]);
      expect(result.newReplicaUid).toBe("survivor-pod");
      expect(result.acknowledgedCursor).toEqual(cursor);
      expect(result.resumedProjection.cursor).toEqual(cursor);
    } finally {
      unsubscribeInitial();
      await client.close();
      for (const socket of server.clients) socket.terminate();
      server.close();
    }
  });
});
