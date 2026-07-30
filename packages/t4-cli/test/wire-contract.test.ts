import { describe, expect, test } from "bun:test";
import { decodeClientFrame, decodeServerFrame } from "@t4-code/protocol";
import { T4Client, type Frame, type HostEvents } from "../src/client.ts";
import {
  MAX_CREDENTIAL_FILE_BYTES,
  normalizeRemoteEndpoint,
  parseRemoteCredentials,
} from "../src/remote-config.ts";
import { terminalSafeText } from "../src/render.ts";
import { TermScreen } from "../src/tui.ts";
import {
  negotiatedFeature,
  savedCursorFromFrame,
  serverRelativeFilePath,
  sessionCreateArgs,
} from "../src/wire-helpers.ts";

const events: HostEvents = {
  sessions: () => undefined,
  snapshot: () => undefined,
  entry: () => undefined,
  status: () => undefined,
  confirm: () => undefined,
  termOutput: () => undefined,
  termExit: () => undefined,
  error: () => undefined,
  open: () => undefined,
  close: () => undefined,
};

describe("t4 shared wire conformance", () => {
  test("reconnect cursors retain the host identity required by hello", () => {
    const frame = decodeServerFrame({
      v: "omp-app/1",
      type: "entry",
      hostId: "host-a",
      sessionId: "session-a",
      cursor: { epoch: "epoch-a", seq: 7 },
      revision: "revision-a",
      entry: {
        id: "entry-a",
        parentId: "entry-root",
        hostId: "host-a",
        sessionId: "session-a",
        kind: "message",
        timestamp: new Date(0).toISOString(),
        data: { text: "hello" },
      },
    });
    expect(savedCursorFromFrame(frame)).toEqual({
      hostId: "host-a",
      sessionId: "session-a",
      cursor: { epoch: "epoch-a", seq: 7 },
    });
    expect(() =>
      decodeClientFrame({
        v: "omp-app/1",
        type: "hello",
        protocol: { min: "omp-app/1", max: "omp-app/1" },
        client: { name: "t4", version: "1", build: "test", platform: "linux" },
        requestedFeatures: ["resume"],
        savedCursors: [{ sessionId: "session-a", cursor: { epoch: "epoch-a", seq: 7 } }],
      }),
    ).toThrow();
  });

  test("decodes both upsert and remove session.delta fixtures", () => {
    const upsert = decodeServerFrame({
      v: "omp-app/1",
      type: "session.delta",
      hostId: "host-a",
      sessionId: "session-a",
      cursor: { epoch: "epoch-a", seq: 1 },
      revision: "revision-a",
      upsert: {
        hostId: "host-a",
        sessionId: "session-a",
        title: "Live",
        status: "idle",
        revision: "revision-a",
        project: { projectId: "project-a" },
        updatedAt: new Date(0).toISOString(),
      },
    });
    const remove = decodeServerFrame({
      v: "omp-app/1",
      type: "session.delta",
      hostId: "host-a",
      sessionId: "session-a",
      cursor: { epoch: "epoch-a", seq: 2 },
      revision: "revision-b",
      remove: "session-a",
    });
    expect(upsert.type).toBe("session.delta");
    expect("upsert" in upsert && upsert.upsert.status).toBe("idle");
    expect("remove" in remove && remove.remove).toBe("session-a");
    const inventories: Array<Array<{ title: string }>> = [];
    const client = new T4Client(
      "ws://localhost/v1/ws",
      undefined,
      {
        ...events,
        sessions: (sessions) => inventories.push(sessions),
      },
      true,
    );
    const route = (
      client as unknown as { route(frame: typeof upsert | typeof remove): void }
    ).route.bind(client);
    route(upsert);
    expect(inventories.at(-1)?.[0]?.title).toBe("Live");
    route(remove);
    expect(inventories.at(-1)).toEqual([]);
  });

  test("uses projectId session creation and approve/deny confirmation values", () => {
    expect(sessionCreateArgs("project-a")).toEqual({ projectId: "project-a" });
    const client = new T4Client("ws://localhost/v1/ws", undefined, events, true);
    let sent: Frame | undefined;
    client.sendRaw = (frame) => {
      sent = frame;
    };
    client.confirmAnswer({ confirmationId: "confirmation-a", commandId: "command-a" }, "approve");
    expect(sent?.decision).toBe("approve");
    client.confirmAnswer({ confirmationId: "confirmation-a", commandId: "command-a" }, "deny");
    expect(sent?.decision).toBe("deny");
  });

  test("keeps server-relative nested paths and honors negotiated features", () => {
    expect(serverRelativeFilePath({ path: "src/foo.ts" })).toBe("src/foo.ts");
    expect(negotiatedFeature(false, new Set(["files.list"]), "terminal.io")).toBe(false);
    expect(negotiatedFeature(false, new Set(["terminal.io"]), "terminal.io")).toBe(true);
    expect(negotiatedFeature(true, new Set(), "terminal.io")).toBe(true);
  });

  test("normalizes only credential-free secure remote endpoints", () => {
    expect(normalizeRemoteEndpoint("wss://host.example")).toBe("wss://host.example/v1/ws");
    expect(normalizeRemoteEndpoint("wss://host.example/base/")).toBe(
      "wss://host.example/base/v1/ws",
    );
    expect(normalizeRemoteEndpoint("wss://host.example/v1/ws")).toBe("wss://host.example/v1/ws");
    for (const invalid of [
      "ws://host.example",
      "https://host.example",
      "wss://user:token@host.example",
      "wss://host.example?token=secret",
      "wss://host.example/#fragment",
    ])
      expect(() => normalizeRemoteEndpoint(invalid)).toThrow();
  });

  test("accepts only bounded canonical credential files", () => {
    const deviceToken = `${"a".repeat(42)}A`;
    expect(
      parseRemoteCredentials(
        JSON.stringify({
          deviceId: "device-a",
          deviceToken,
          tlsFingerprint: "b".repeat(64),
        }),
      ),
    ).toEqual({
      deviceId: "device-a",
      deviceToken,
      tlsFingerprint: "b".repeat(64),
    });
    for (const invalid of [
      "{}",
      JSON.stringify({ deviceId: "device-a", deviceToken: "not-a-token" }),
      JSON.stringify({ deviceId: "device-a", deviceToken, typo: true }),
      JSON.stringify({ deviceId: "device-a", deviceToken, tlsFingerprint: "A".repeat(64) }),
      "x".repeat(MAX_CREDENTIAL_FILE_BYTES + 1),
    ])
      expect(() => parseRemoteCredentials(invalid)).toThrow();
  });

  test("strips host control bytes and bounds terminal cursor state", () => {
    expect(terminalSafeText("safe\u001b[2J title\u009b31m")).toBe("safe[2J title31m");
    const terminal = new TermScreen();
    terminal.feed("\u001b[999999999B\u001b[999999999Cbounded");
    expect(terminal.lines.length).toBeLessThanOrEqual(2000);
    expect(terminal.lines.at(-1)?.length).toBeLessThanOrEqual(4097);
    terminal.feed(`${"\n".repeat(2100)}tail`);
    expect(terminal.lines.length).toBe(2000);
    expect(terminal.lines.at(-1)).toBe("tail");
  });
});
