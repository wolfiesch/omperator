import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeSessionListResult,
  decodeSessions,
  decodeServerFrame,
  type AppFrame,
} from "../src/index.ts";

const appWireEntry = fileURLToPath(import.meta.resolve("@t4-code/host-wire"));
const appWireRoot = dirname(dirname(appWireEntry));

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(appWireRoot, "fixtures", "v1", name), "utf8")) as unknown;
}

function decodeServerFixture(name: string): AppFrame {
  return decodeServerFrame(fixture(name));
}

function rawSession(liveState?: unknown): Record<string, unknown> {
  return {
    hostId: "host-a",
    sessionId: "session-a",
    project: { projectId: "project-a" },
    revision: "rev-1",
    title: "Session",
    status: "active",
    updatedAt: "2026-07-16T12:00:00Z",
    ...(liveState === undefined ? {} : { liveState }),
  };
}

const providerTransport = Object.freeze({
  provider: "openai-codex",
  configuredPolicy: "auto",
  websocketPreferred: true,
  lastTransport: "websocket",
  websocketDisabled: false,
  websocketConnected: true,
  fallbackCount: 0,
  canAppend: true,
  prewarmed: true,
  hasSessionState: true,
  hasTurnState: true,
  fullContextRequests: 1,
  deltaRequests: 12,
  inputJsonBytes: 64_512,
  lastInputJsonBytes: 2_048,
});

describe("@omp/protocol app-wire facade", () => {
  it("re-exports the frozen protocol version and decoders", () => {
    expect(PROTOCOL_VERSION).toBe("omp-app/1");
    expect(decodeClientFrame(fixture("hello.json"))).toMatchObject({ type: "hello", v: "omp-app/1" });
  });

  it("decodes canonical server fixtures through the facade", () => {
    expect(decodeServerFixture("snapshot.json")).toMatchObject({ type: "snapshot", cursor: { epoch: "epoch-2", seq: 9 } });
    expect(decodeServerFixture("event.json")).toMatchObject({ type: "event", cursor: { epoch: "epoch-2", seq: 11 } });
    expect(decodeServerFixture("response.json")).toMatchObject({ type: "response", requestId: "req-1", ok: true });
    expect(decodeServerFixture("gap.json")).toMatchObject({ type: "gap", from: { epoch: "epoch-2", seq: 12 } });
    expect(decodeServerFixture("error.json")).toMatchObject({ type: "error", code: "NOT_AUTHORIZED" });
  });

  it("preserves bounded custom-message metadata in durable entry data", () => {
    const decoded = decodeServerFrame({
      v: "omp-app/1",
      type: "snapshot",
      cursor: { epoch: "epoch-2", seq: 9 },
      revision: "rev-10",
      hostId: "host-a",
      sessionId: "same-raw-id",
      entries: [
        {
          id: "entry-irc-1",
          parentId: null,
          hostId: "host-a",
          sessionId: "same-raw-id",
          kind: "message",
          timestamp: "2026-07-15T20:00:00Z",
          data: {
            role: "assistant",
            text: "machine-owned wrapper",
            customType: "irc:incoming",
            customDetails: { from: "ReviewAgent", message: "One finding" },
          },
        },
      ],
      continuity: { epoch: "epoch-2" },
    });

    expect(decoded).toMatchObject({
      type: "snapshot",
      entries: [
        {
          kind: "message",
          data: {
            customType: "irc:incoming",
            customDetails: { from: "ReviewAgent", message: "One finding" },
          },
        },
      ],
    });
  });

  it("preserves present unknown session control as a read-only marker", () => {
    const decoded = decodeServerFrame(
      JSON.stringify({
        v: "omp-app/1",
        type: "sessions",
        hostId: "host-a",
        cursor: { epoch: "epoch-1", seq: 1 },
        sessions: [
          rawSession({ sessionControl: { mode: "future-mode" } }),
          rawSession({
            sessionControl: { mode: "observer", lockStatus: "live", transcript: "snapshot" },
          }),
          rawSession(null),
          rawSession(),
        ],
      }),
    );

    if (decoded.type !== "sessions") throw new Error("expected sessions frame");
    expect(decoded.sessions[0]?.liveState?.sessionControl).toEqual({ mode: "unknown" });
    expect(decoded.sessions[1]?.liveState?.sessionControl).toEqual({
      mode: "observer",
      lockStatus: "live",
      transcript: "snapshot",
    });
    expect(decoded.sessions[2]?.liveState?.sessionControl).toEqual({ mode: "unknown" });
    expect(decoded.sessions[3]?.liveState?.sessionControl).toBeUndefined();

    expect(
      decodeSessions({
        v: "omp-app/1",
        type: "sessions",
        cursor: { epoch: "epoch-1", seq: 2 },
        sessions: [
          rawSession({
            sessionControl: { mode: "reconciling", transcript: "live", future: true },
          }),
        ],
      }),
    ).toMatchObject({
      sessions: [{ liveState: { sessionControl: { mode: "unknown" } } }],
    });

    expect(
      decodeSessionListResult({
        cursor: { epoch: "epoch-1", seq: 3 },
        sessions: [rawSession({ sessionControl: null })],
      }),
    ).toMatchObject({
      sessions: [{ liveState: { sessionControl: { mode: "unknown" } } }],
    });

    expect(
      decodeSessions({
        v: "omp-app/1",
        type: "sessions",
        cursor: { epoch: "epoch-1", seq: 4 },
        sessions: [{ ...rawSession(), liveState: undefined }],
      }),
    ).toMatchObject({
      sessions: [{ liveState: { sessionControl: { mode: "unknown" } } }],
    });
  });

  it("preserves additive provider transport evidence through list decoders", () => {
    const sessions = [
      decodeServerFrame({
        v: "omp-app/1",
        type: "sessions",
        hostId: "host-a",
        cursor: { epoch: "epoch-1", seq: 2 },
        sessions: [rawSession({ providerTransport })],
      }),
      decodeSessions({
        v: "omp-app/1",
        type: "sessions",
        cursor: { epoch: "epoch-1", seq: 3 },
        sessions: [rawSession({ providerTransport })],
      }),
      decodeSessionListResult({
        cursor: { epoch: "epoch-1", seq: 4 },
        sessions: [rawSession({ providerTransport })],
      }),
    ];

    for (const decoded of sessions) {
      expect(decoded).toMatchObject({
        sessions: [{ liveState: { providerTransport } }],
      });
    }
  });

  it("preserves additive provider transport evidence through deltas and responses", () => {
    const session = rawSession({ providerTransport });

    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "session.delta",
        hostId: "host-a",
        sessionId: "session-a",
        cursor: { epoch: "epoch-1", seq: 5 },
        revision: "rev-2",
        upsert: session,
      }),
    ).toMatchObject({
      type: "session.delta",
      upsert: { liveState: { providerTransport } },
    });

    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-list-provider-transport",
        hostId: "host-a",
        ok: true,
        command: "session.list",
        result: {
          cursor: { epoch: "epoch-1", seq: 6 },
          sessions: [session],
        },
      }),
    ).toMatchObject({
      type: "response",
      result: {
        sessions: [{ liveState: { providerTransport } }],
      },
    });

    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-create-provider-transport",
        hostId: "host-a",
        ok: true,
        command: "session.create",
        result: { session },
      }),
    ).toMatchObject({
      type: "response",
      result: {
        session: { liveState: { providerTransport } },
      },
    });
  });

  it("preserves unknown control markers in deltas and typed command results", () => {
    const future = rawSession({ sessionControl: { mode: "future-mode", version: 2 } });
    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "session.delta",
        hostId: "host-a",
        sessionId: "session-a",
        cursor: { epoch: "epoch-1", seq: 4 },
        revision: "rev-2",
        upsert: future,
      }),
    ).toMatchObject({
      type: "session.delta",
      upsert: { liveState: { sessionControl: { mode: "unknown" } } },
    });

    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-list",
        hostId: "host-a",
        ok: true,
        command: "session.list",
        result: {
          cursor: { epoch: "epoch-1", seq: 5 },
          sessions: [future],
        },
      }),
    ).toMatchObject({
      type: "response",
      result: {
        sessions: [{ liveState: { sessionControl: { mode: "unknown" } } }],
      },
    });

    expect(
      decodeServerFrame({
        v: "omp-app/1",
        type: "response",
        requestId: "request-create",
        hostId: "host-a",
        ok: true,
        command: "session.create",
        result: { session: future },
      }),
    ).toMatchObject({
      type: "response",
      result: {
        session: { liveState: { sessionControl: { mode: "unknown" } } },
      },
    });
  });
});
