import type { OmpClient, OmpClientOptions, PublicServerFrame } from "@t4-code/client";
import { commandId, confirmationId, hostId, requestId } from "@t4-code/protocol";
import { describe, expect, it, afterEach } from "vite-plus/test";

import { resolveRendererPlatform } from "../src/platform/bridge.ts";
import { createBrowserShellPort, detectBackend } from "../src/platform/browser-shell-port.ts";
import { BrowserWebSocketTransport } from "../src/platform/browser-transport.ts";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

function setBrowserLocation(search: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search } },
  });
}

function setBackendScript(payload: string): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { getElementById: () => ({ textContent: payload }) },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: originalWebSocket });
});

describe("browser platform boundary", () => {
  it("keeps no-config browser mode on the fixture path", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
    const platform = resolveRendererPlatform("linux");
    expect(platform.mode).toBe("browser");
    expect(platform.shell).toBeNull();
  });

  it("accepts explicit script and query config, but rejects invalid config", () => {
    setBackendScript(
      JSON.stringify({
        wsUrl: "wss://omp.example/v1/ws",
        label: "Remote OMP",
        deviceId: "browser-1",
        deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    expect(detectBackend()).toEqual({
      wsUrl: "wss://omp.example/v1/ws",
      label: "Remote OMP",
      deviceId: "browser-1",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    setBrowserLocation("?backend=ws%3A%2F%2F127.0.0.1%2Fv1%2Fws&label=Query");
    expect(detectBackend()).toEqual({ wsUrl: "ws://127.0.0.1/v1/ws", label: "Query" });
    setBrowserLocation("?backend=ws%3A%2F%2F127.0.0.1%2Fv1%2Fws&token=leaked");
    expect(() => detectBackend()).toThrow(/browser auth must not be supplied/u);

    setBackendScript(JSON.stringify({ wsUrl: "https://not-websocket" }));
    expect(() => detectBackend()).toThrow(/invalid browser backend wsUrl/u);
  });

  it("prefers a prepared native backend without putting credentials in the URL", () => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: undefined });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __t4MobileBackend: {
          wsUrl: "wss://host.tailnet.ts.net:8445/v1/ws",
          label: "T4 on host",
          deviceId: "android-device",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
        location: { search: "" },
      },
    });
    expect(detectBackend()).toEqual({
      wsUrl: "wss://host.tailnet.ts.net:8445/v1/ws",
      label: "T4 on host",
      deviceId: "android-device",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("exposes one remote target and no local service lifecycle", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws", label: "Remote OMP" }));
    const shell = createBrowserShellPort();
    expect(shell).not.toBeNull();
    if (shell === null) return;
    const result = await shell.listTargets();
    expect(result.targets).toEqual([
      expect.objectContaining({ targetId: "remote", kind: "remote", label: "Remote OMP" }),
    ]);
    expect(shell.serviceInspect).toBeUndefined();
    expect(shell.serviceStart).toBeUndefined();
    expect(shell.serviceStop).toBeUndefined();
  });

  it("bounds transport URLs and cleans listeners on close", () => {
    expect(() => new BrowserWebSocketTransport({ url: "https://not-websocket" })).toThrow(
      /invalid browser transport URL/u,
    );
    expect(
      () => new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws", openTimeoutMs: 0 }),
    ).toThrow(/invalid browser transport open timeout/u);
    const transport = new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws" });
    const unsubscribeMessage = transport.onMessage(() => undefined);
    const unsubscribeClose = transport.onClose(() => undefined);
    const unsubscribeError = transport.onError(() => undefined);
    unsubscribeMessage();
    unsubscribeClose();
    unsubscribeError();
    transport.close();
    expect(() => transport.send("{}")).toThrow(/not connected/u);
  });

  it("bounds a browser WebSocket that never opens", async () => {
    let socketClosed = false;
    class StalledWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      binaryType = "blob";
      closed = false;

      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {
        this.closed = true;
        socketClosed = true;
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: StalledWebSocket,
    });
    const transport = new BrowserWebSocketTransport({
      url: "wss://omp.example/v1/ws",
      openTimeoutMs: 1,
    });
    await expect(transport.open()).rejects.toThrow(/connection timed out/u);
    expect(socketClosed).toBe(true);
  });

  it("settles an in-flight browser open when the transport closes", async () => {
    class StalledWebSocket {
      static readonly OPEN = 1;
      readonly readyState = 0;
      binaryType = "blob";

      addEventListener(): void {}
      removeEventListener(): void {}
      send(): void {}
      close(): void {}
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: StalledWebSocket,
    });
    const transport = new BrowserWebSocketTransport({ url: "wss://omp.example/v1/ws" });
    const opening = transport.open();
    transport.close();
    await expect(opening).rejects.toThrow(/closed while opening/u);
  });

  it("maps client results, stores pairing auth, and closes client on disconnect", async () => {
    setBackendScript(JSON.stringify({ wsUrl: "wss://omp.example/v1/ws" }));
    let capturedOptions: OmpClientOptions | undefined;
    let connectCalls = 0;
    let closed = false;
    let clientFrameListener: ((frame: PublicServerFrame) => void) | undefined;
    let fakeState: "pairing" | "ready" = "pairing";
    let confirmResponse = { requestId: "confirm", ok: true, type: "response", v: "omp-app/1" };
    let commandResponse: unknown = {
      requestId: "req",
      commandId: "cmd",
      ok: true,
      result: { value: 1 },
      type: "response",
      v: "0.1",
    };
    const fakeClient = {
      get state() {
        return fakeState;
      },
      connect: async () => {
        connectCalls += 1;
      },
      close: async () => {
        closed = true;
      },
      command: async () => commandResponse,
      confirm: async () => confirmResponse,
      pairStart: async () => {
        const callback = capturedOptions?.privilegedPairResult;
        if (callback === undefined) throw new Error("pair callback missing");
        await callback({
          deviceId: "browser-1",
          deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        } as never);
        fakeState = "ready";
        return { type: "pair.ok" };
      },
      onFrame: (listener: (frame: PublicServerFrame) => void) => {
        clientFrameListener = listener;
        return () => {
          clientFrameListener = undefined;
        };
      },
      onState: () => () => undefined,
      onError: () => () => undefined,
    };
    const shell = createBrowserShellPort({
      clientFactory: (options) => {
        capturedOptions = options;
        return fakeClient as unknown as OmpClient;
      },
    });
    if (shell === null) return;
    const emittedFrames: PublicServerFrame[] = [];
    const stopFrames = shell.onServerFrame((event) => emittedFrames.push(event.frame));
    await shell.bootstrap();
    expect(connectCalls).toBe(0);
    await shell.connect({ targetId: "remote" });
    expect(connectCalls).toBe(1);
    expect(capturedOptions?.requestedFeatures).toContain("prompt.images");
    expect(capturedOptions?.requestedFeatures).toContain("transcript.images");
    expect(capturedOptions?.compatibilityRequestedFeatures).not.toContain("prompt.images");
    expect(capturedOptions?.compatibilityRequestedFeatures).not.toContain("transcript.images");
    const pair = await shell.pair({ targetId: "remote", code: "123456" });
    expect(pair.paired).toBe(true);
    expect(capturedOptions?.authentication?.()).toEqual({
      deviceId: "browser-1",
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const command = await shell.command({
      targetId: "remote",
      intent: { hostId: hostId("host"), command: "session.list", args: {} },
    });
    expect(command).toMatchObject({
      requestId: "req",
      commandId: "cmd",
      accepted: true,
      result: { value: 1 },
    });
    commandResponse = {
      requestId: "req-rejected",
      commandId: "cmd-rejected",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: {
        code: "stale_revision",
        message: "session changed",
        details: { expectedRevision: "rev-1", actualRevision: "rev-2", token: "secret" },
      },
    };
    expect(
      await shell.command({
        targetId: "remote",
        intent: { hostId: hostId("host"), command: "session.list", args: {} },
      }),
    ).toMatchObject({
      accepted: false,
      error: {
        code: "stale_revision",
        message: "session changed",
        details: { expectedRevision: "rev-1", actualRevision: "rev-2" },
      },
    });
    clientFrameListener?.({
      v: "omp-app/1",
      type: "response",
      requestId: requestId("frame-request"),
      commandId: commandId("frame-command"),
      hostId: hostId("host"),
      command: "session.list",
      ok: false,
      error: {
        code: "outcome_unknown",
        message: "reader failed; Bearer live-frame-token",
        details: {
          diagnostic: "token=live-frame-detail",
          accessToken: "must-not-cross-browser-boundary",
        },
      },
    });
    const rejectedFrame = emittedFrames.at(-1);
    expect(rejectedFrame).toMatchObject({
      type: "response",
      error: {
        code: "outcome_unknown",
        message: "reader failed; [redacted]",
        details: { diagnostic: "token=[redacted]" },
      },
    });
    expect(JSON.stringify(rejectedFrame)).not.toContain("live-frame-token");
    expect(JSON.stringify(rejectedFrame)).not.toContain("live-frame-detail");
    expect(JSON.stringify(rejectedFrame)).not.toContain("must-not-cross-browser-boundary");
    const confirmationRequest = {
      targetId: "remote",
      confirmationId: confirmationId("confirm"),
      commandId: commandId("cmd"),
      hostId: hostId("host"),
      decision: "approve",
    } as const;
    const confirmation = await shell.confirm(confirmationRequest);
    expect(confirmation.accepted).toBe(true);

    confirmResponse = {
      requestId: "original-command-request",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: { code: "confirmation_denied", message: "command was denied" },
    } as never;
    expect((await shell.confirm({ ...confirmationRequest, decision: "deny" })).accepted).toBe(true);
    confirmResponse = {
      requestId: "confirm-invalid",
      ok: false,
      type: "response",
      v: "omp-app/1",
      error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
    } as never;
    expect((await shell.confirm(confirmationRequest)).accepted).toBe(false);
    await shell.disconnect({ targetId: "remote" });
    stopFrames();
    expect(closed).toBe(true);
  });
});
