import { describe, expect, it } from "vite-plus/test";
import {
  commandResultError,
  decodeDesktopEvent,
  decodeDesktopInvokeRequest,
  decodeDesktopUpdateRendererReadyResult,
  decodeDesktopUpdateState,
  decodeProjectionCacheLoadResult,
  decodeProjectionCacheSaveRequestValue,
  decodeProjectionCacheSaveResult,
  decodeSpeechText,
  MAX_PROJECTION_CACHE_BYTES,
  MAX_SPEECH_TEXT_BYTES,
  isDesktopInvokeRequest,
} from "../src/desktop-ipc.ts";

describe("desktop IPC boundary", () => {
  it("keeps bounded actionable command errors while redacting secret-shaped details", () => {
    const error = commandResultError({
      code: "stale_revision",
      message: "Session changed\nrefresh first; Bearer live-message-token",
      details: {
        expectedRevision: "revision-1",
        actualRevision: "revision-2",
        diagnostic: "token=live-detail-token",
        accessToken: "must-not-cross-ipc",
      },
    });
    expect(error).toEqual({
      code: "stale_revision",
      message: "Session changed refresh first; [redacted]",
      details: {
        expectedRevision: "revision-1",
        actualRevision: "revision-2",
        diagnostic: "token=[redacted]",
      },
    });
  });
  it("bounds oversized child-failure details without losing the failure category", () => {
    const error = commandResultError({
      code: "outcome_unknown",
      message: "rpc child emitted an oversized agent_end frame",
      details: {
        diagnostic: "x".repeat(32_000),
        nested: Array.from({ length: 100 }, (_, index) => ({ index, value: "y".repeat(2_000) })),
      },
    });
    expect(error).toBeDefined();
    if (error === undefined) throw new Error("command error was not preserved");
    expect(error.code).toBe("outcome_unknown");
    expect(error.message).toContain("oversized agent_end");
    expect(error.details).toBeDefined();
    if (error.details === undefined) throw new Error("command error details were not preserved");
    expect(JSON.stringify(error.details).length).toBeLessThan(8_192);
    const diagnostic = error.details.diagnostic;
    expect(typeof diagnostic).toBe("string");
    if (typeof diagnostic !== "string") throw new Error("bounded diagnostic was not preserved");
    expect(diagnostic.length).toBeLessThanOrEqual(1_024);
  });
  it("decodes bootstrap, target, pair and command intents", () => {
    expect(decodeDesktopInvokeRequest({ channel: "omp:bootstrap", payload: {} })).toEqual({
      channel: "omp:bootstrap",
      payload: {},
    });
    expect(
      decodeDesktopInvokeRequest({ channel: "omp:connect", payload: { targetId: "remote-1" } }),
    ).toEqual({ channel: "omp:connect", payload: { targetId: "remote-1" } });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:pair",
        payload: { targetId: "remote-1", code: "123456" },
      }),
    ).toBeTruthy();
    const command = decodeDesktopInvokeRequest({
      channel: "omp:command",
      payload: { targetId: "remote-1", intent: { hostId: "h", command: "host.list", args: {} } },
    });
    expect(command).toMatchObject({
      channel: "omp:command",
      payload: { intent: { hostId: "h", command: "host.list", args: {} } },
    });
  });
  it("strictly decodes named local targets and profile lifecycle requests", () => {
    expect(decodeDesktopInvokeRequest({
      channel: "omp:connect",
      payload: { targetId: "local:fable-swarm" },
    })).toEqual({ channel: "omp:connect", payload: { targetId: "local:fable-swarm" } });
    expect(decodeDesktopInvokeRequest({
      channel: "omp:profiles:add",
      payload: {
        profile: { profileId: "fable-swarm", label: "Fable Swarm", autoStart: true },
      },
    })).toEqual({
      channel: "omp:profiles:add",
      payload: {
        profile: { profileId: "fable-swarm", label: "Fable Swarm", autoStart: true },
      },
    });
    expect(decodeDesktopInvokeRequest({
      channel: "omp:profiles:update",
      payload: { profileId: "fable-swarm", changes: { autoStart: false } },
    })).toEqual({
      channel: "omp:profiles:update",
      payload: { profileId: "fable-swarm", changes: { autoStart: false } },
    });
    for (const channel of [
      "omp:profiles:remove",
      "omp:profiles:status",
      "omp:profiles:start",
      "omp:profiles:stop",
      "omp:profiles:restart",
    ] as const) {
      expect(decodeDesktopInvokeRequest({
        channel,
        payload: { profileId: "fable-swarm" },
      })).toEqual({ channel, payload: { profileId: "fable-swarm" } });
    }
    for (const value of [
      { channel: "omp:connect", payload: { targetId: "local:default" } },
      { channel: "omp:profiles:add", payload: { profile: { profileId: "../escape" } } },
      { channel: "omp:profiles:add", payload: { profile: { profileId: "Fable" } } },
      {
        channel: "omp:profiles:update",
        payload: { profileId: "fable-swarm", changes: {} },
      },
      {
        channel: "omp:profiles:start",
        payload: { profileId: "fable-swarm", executable: "/tmp/omp" },
      },
      {
        channel: "omp:targets:add",
        payload: {
          target: {
            targetId: "local:fable-swarm",
            label: "Collision",
            mode: "direct",
            address: "100.64.0.1",
            port: 4210,
            requestedCapabilities: [],
            grantedCapabilities: [],
            status: "unknown",
          },
        },
      },
    ]) expect(() => decodeDesktopInvokeRequest(value)).toThrow();
  });
  it("decodes confirmations and target-scoped terminal requests with app-wire bounds", () => {
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:confirm",
        payload: {
          targetId: "remote-1",
          confirmationId: "confirm-1",
          commandId: "command-1",
          hostId: "host-1",
          sessionId: "session-1",
          decision: "approve",
        },
      }),
    ).toMatchObject({
      channel: "omp:confirm",
      payload: { targetId: "remote-1", decision: "approve" },
    });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:terminal:resize",
        payload: {
          targetId: "remote-1",
          hostId: "host-1",
          sessionId: "session-1",
          terminalId: "term-1",
          cols: 80,
          rows: 24,
        },
      }),
    ).toMatchObject({ payload: { cols: 80, rows: 24 } });
    expect(
      decodeDesktopInvokeRequest({
        channel: "omp:terminal:input",
        payload: {
          targetId: "remote-1",
          hostId: "host-1",
          sessionId: "session-1",
          terminalId: "term-1",
          data: "hi",
          encoding: "utf8",
        },
      }),
    ).toBeTruthy();
    for (const value of [
      {
        channel: "omp:confirm",
        payload: {
          targetId: "remote-1",
          confirmationId: "c",
          commandId: "x",
          hostId: "h",
          decision: "approve",
          token: "secret",
        },
      },
      {
        channel: "omp:terminal:resize",
        payload: {
          targetId: "remote-1",
          hostId: "h",
          sessionId: "s",
          terminalId: "t",
          cols: 1001,
          rows: 24,
        },
      },
      {
        channel: "omp:terminal:input",
        payload: {
          targetId: "remote-1",
          hostId: "h",
          sessionId: "s",
          terminalId: "t",
          data: "%%%%",
          encoding: "base64",
        },
      },
    ])
      expect(() => decodeDesktopInvokeRequest(value)).toThrow();
  });
  it("carries planned session management commands and results across strict desktop IPC", () => {
    const request = decodeDesktopInvokeRequest({
      channel: "omp:command",
      payload: {
        targetId: "remote-1",
        intent: {
          hostId: "host-1",
          sessionId: "session-1",
          command: "session.archive",
          expectedRevision: "revision-1",
          args: {},
        },
      },
    });
    expect(request).toMatchObject({
      channel: "omp:command",
      payload: {
        targetId: "remote-1",
        intent: { command: "session.archive", expectedRevision: "revision-1" },
      },
    });
    expect(
      decodeDesktopEvent({
        channel: "omp:server-event",
        payload: {
          targetId: "remote-1",
          event: {
            kind: "response",
            payload: {
              requestId: "request-1",
              commandId: "command-1",
              command: "session.archive",
              hostId: "host-1",
              sessionId: "session-1",
              ok: true,
              result: { archived: true },
            },
          },
        },
      }),
    ).toMatchObject({
      payload: {
        event: {
          kind: "response",
          payload: { command: "session.archive", ok: true, result: { archived: true } },
        },
      },
    });
  });
  it("decodes events and rejects hostile shapes", () => {
    expect(
      decodeDesktopEvent({
        channel: "omp:connection-state",
        payload: { targetId: "x", state: "connected" },
      }),
    ).toBeTruthy();
    expect(
      decodeDesktopEvent({
        channel: "omp:runtime-error",
        payload: { code: "transport", message: "failed" },
      }),
    ).toBeTruthy();
    expect(
      decodeDesktopEvent({
        channel: "omp:server-event",
        payload: {
          targetId: "target-1",
          event: {
            kind: "welcome",
            payload: {
              selectedProtocol: "omp-app/2",
              hostId: "host-1",
              ompVersion: "16.4.3",
              ompBuild: "test",
              appserverVersion: "0.1.0",
              appserverBuild: "test",
              epoch: "epoch-1",
              grantedCapabilities: [],
              grantedFeatures: [],
              negotiatedLimits: {},
              authentication: "local",
              resumed: false,
            },
          },
        },
      }),
    ).toMatchObject({
      payload: {
        targetId: "target-1",
        event: { kind: "welcome", payload: { selectedProtocol: "omp-app/2", hostId: "host-1" } },
      },
    });
    for (const wireField of ["v", "type"] as const) {
      expect(() =>
        decodeDesktopEvent({
          channel: "omp:server-event",
          payload: {
            targetId: "target-1",
            event: {
              kind: "welcome",
              payload: { [wireField]: "welcome" },
            },
          },
        }),
      ).toThrow("wire envelope fields cannot cross renderer IPC");
    }
    expect(() =>
      decodeDesktopEvent({
        channel: "omp:server-event",
        payload: {
          targetId: "target-1",
          event: {
            kind: "pair.ok",
            payload: {
              requestId: "request-1",
              pairingId: "pairing-1",
              deviceId: "device-1",
              deviceName: "Workstation",
              platform: "linux",
              requestedCapabilities: ["sessions.read"],
              grantedCapabilities: ["sessions.read"],
              deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
              expiresAt: "2026-07-11T12:00:00.000Z",
            },
          },
        },
      }),
    ).toThrow("pair credentials cannot cross renderer IPC");
    for (const value of [
      { channel: "other", payload: {} },
      { channel: "connect", payload: { targetId: "x" } },
      { channel: "omp:connect", payload: { targetId: "bad target" } },
      { channel: "omp:bootstrap", payload: { platform: "linux" } },
      { channel: "omp:pair", payload: { targetId: "x", code: "12345" } },
      {
        channel: "omp:command",
        payload: {
          targetId: "x",
          intent: { hostId: "h", command: "host.list", args: {}, token: "x" },
        },
      },
    ])
      expect(isDesktopInvokeRequest(value)).toBe(false);
  });

  it("strictly decodes immutable desktop update requests and state", () => {
    for (const channel of [
      "app:update:get-state",
      "app:update:check",
      "app:update:download",
      "app:update:restart",
      "app:update:renderer-ready",
    ] as const) {
      expect(decodeDesktopInvokeRequest({ channel, payload: {} })).toEqual({
        channel,
        payload: {},
      });
      expect(() =>
        decodeDesktopInvokeRequest({ channel, payload: { url: "https://attacker.invalid" } }),
      ).toThrow("unknown key");
    }

    const state = decodeDesktopUpdateState({
      version: 1,
      currentVersion: "0.1.17",
      phase: "available",
      checkedAt: 123,
      availableVersion: "0.1.18",
      progressPercent: 25.5,
      message: "Update ready to download.",
    });
    expect(state).toEqual({
      version: 1,
      currentVersion: "0.1.17",
      phase: "available",
      checkedAt: 123,
      availableVersion: "0.1.18",
      progressPercent: 25.5,
      message: "Update ready to download.",
    });
    expect(Object.isFrozen(state)).toBe(true);
    const rendererReady = decodeDesktopUpdateRendererReadyResult({ openSettings: true });
    expect(rendererReady).toEqual({ openSettings: true });
    expect(Object.isFrozen(rendererReady)).toBe(true);
    expect(() =>
      decodeDesktopUpdateRendererReadyResult({
        openSettings: true,
        url: "https://attacker.invalid",
      }),
    ).toThrow("unknown key");
    expect(() => decodeDesktopUpdateRendererReadyResult({ openSettings: "yes" })).toThrow();
    expect(decodeDesktopEvent({ channel: "app:update:state", payload: state })).toEqual({
      channel: "app:update:state",
      payload: state,
    });
    expect(decodeDesktopEvent({ channel: "app:update:open", payload: { source: "menu" } })).toEqual(
      { channel: "app:update:open", payload: { source: "menu" } },
    );

    for (const value of [
      { ...state, url: "https://attacker.invalid" },
      { ...state, phase: "installing" },
      { ...state, currentVersion: "latest" },
      { ...state, availableVersion: "1.2.3\nhttps://attacker.invalid" },
      { ...state, checkedAt: -1 },
      { ...state, progressPercent: 101 },
      { ...state, message: "x".repeat(513) },
    ]) {
      expect(() => decodeDesktopUpdateState(value)).toThrow();
    }
    expect(() =>
      decodeDesktopEvent({
        channel: "app:update:open",
        payload: { source: "renderer", url: "https://attacker.invalid" },
      }),
    ).toThrow();
  });
  it("bounds and rejects unsafe read-aloud requests", () => {
    expect(decodeDesktopInvokeRequest({ channel: "omp:speech:speak", payload: { text: "hello\nworld" } })).toEqual({
      channel: "omp:speech:speak",
      payload: { text: "hello\nworld" },
    });
    expect(() => decodeSpeechText("x".repeat(MAX_SPEECH_TEXT_BYTES + 1))).toThrow();
    expect(() => decodeSpeechText("bad\0text")).toThrow();
    expect(() => decodeDesktopInvokeRequest({ channel: "omp:speech:stop", payload: {} })).not.toThrow();
  });
  it("strictly bounds and versions projection cache IPC payloads", () => {
    const value = JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: { sessions: [], sessionIndex: [], lru: [], freshness: "cached" },
    });
    expect(decodeDesktopInvokeRequest({
      channel: "app:projection-cache:load",
      payload: {},
    })).toEqual({ channel: "app:projection-cache:load", payload: {} });
    expect(decodeDesktopInvokeRequest({
      channel: "app:projection-cache:save",
      payload: { value },
    })).toEqual({ channel: "app:projection-cache:save", payload: { value } });
    expect(decodeProjectionCacheSaveRequestValue(value)).toBe(value);
    expect(decodeProjectionCacheLoadResult({ available: true, value })).toEqual({
      available: true,
      value,
    });
    expect(decodeProjectionCacheSaveResult({ saved: true })).toEqual({ saved: true });

    for (const invalid of [
      { channel: "app:projection-cache:load", payload: { storageKey: "renderer-choice" } },
      { channel: "app:projection-cache:save", payload: { value: JSON.stringify({ kind: "t4-code-projection", version: 2, data: {} }) } },
      { channel: "app:projection-cache:save", payload: { value: "not-json" } },
    ]) expect(() => decodeDesktopInvokeRequest(invalid)).toThrow();
    expect(() => decodeProjectionCacheLoadResult({ available: false, value })).toThrow();
    expect(() => decodeProjectionCacheSaveResult({ saved: "yes" })).toThrow();
    const oversized = JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: { padding: "x".repeat(MAX_PROJECTION_CACHE_BYTES) },
    });
    expect(() => decodeProjectionCacheSaveRequestValue(oversized)).toThrow();
  });
});
