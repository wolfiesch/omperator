import { CI_TRIGGER_CAPABILITY, CLUSTER_OPERATOR_FEATURE } from "@t4-code/protocol";
import type { OmpClient, OmpClientOptions } from "@t4-code/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrowserShellPort, detectBackend } from "../src/platform/browser-shell-port.ts";
import { parseTailnetBackend } from "../src/platform/native-mobile-backend.ts";

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function backendScript(value: unknown): void {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: () => ({ textContent: JSON.stringify(value) }),
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { search: "" } },
  });
}

function captureClientOptions(): {
  readonly options: () => OmpClientOptions;
  readonly factory: (value: OmpClientOptions) => OmpClient;
} {
  let captured: OmpClientOptions | undefined;
  return {
    options: () => {
      if (captured === undefined) throw new Error("client was not built");
      return captured;
    },
    factory: (value) => {
      captured = value;
      return {
        state: "idle",
        connect: async () => undefined,
        close: async () => undefined,
        wake: () => undefined,
        onEvent: () => () => undefined,
        onState: () => () => undefined,
        onError: () => () => undefined,
      } as unknown as OmpClient;
    },
  };
}

afterEach(() => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("mobile cluster target", () => {
  it("keeps the saved Tailnet target operator-disabled by default", () => {
    expect(parseTailnetBackend("https://operator.tailnet.ts.net")).toEqual({
      version: 3,
      endpointKey: "https://operator.tailnet.ts.net#profile=default",
      origin: "https://operator.tailnet.ts.net",
      profileId: "default",
      wsUrl: "wss://operator.tailnet.ts.net/v1/ws",
      label: "T4 on operator",
    });
    expect(
      parseTailnetBackend("https://operator.tailnet.ts.net", "default", true),
    ).toMatchObject({
      clusterOperatorEnabled: true,
      wsUrl: "wss://operator.tailnet.ts.net/v1/ws",
    });
  });

  it("requests no cluster feature for an ordinary browser/mobile backend", async () => {
    backendScript({ wsUrl: "wss://operator.tailnet.ts.net/v1/ws", label: "Operator" });
    const capture = captureClientOptions();
    const shell = createBrowserShellPort({ clientFactory: capture.factory });
    if (shell === null) throw new Error("shell was not created");
    await shell.bootstrap();

    expect(capture.options().requestedFeatures).not.toContain(CLUSTER_OPERATOR_FEATURE);
    expect(capture.options().compatibilityRequestedFeatures).not.toContain(
      CLUSTER_OPERATOR_FEATURE,
    );
    expect(capture.options().capabilities).not.toContain(CI_TRIGGER_CAPABILITY);
    expect(capture.options().capabilities).toEqual(
      expect.arrayContaining(["sessions.read", "preview.read", "preview.control", "preview.input"]),
    );
  });

  it("allows one explicit secure cluster target and rejects insecure or credentialed URLs", async () => {
    backendScript({
      wsUrl: "wss://operator.tailnet.ts.net/v1/ws",
      label: "Operator",
      clusterOperatorEnabled: true,
    });
    const capture = captureClientOptions();
    const shell = createBrowserShellPort({ clientFactory: capture.factory });
    if (shell === null) throw new Error("shell was not created");
    await shell.bootstrap();

    expect(detectBackend()).toMatchObject({ clusterOperatorEnabled: true });
    expect(capture.options().requestedFeatures).toContain(CLUSTER_OPERATOR_FEATURE);
    expect(capture.options().compatibilityRequestedFeatures).toContain(CLUSTER_OPERATOR_FEATURE);
    expect(capture.options().requestedFeatures).toContain("preview.control");
    expect(capture.options().capabilities).toEqual(
      expect.arrayContaining([
        "sessions.read",
        "sessions.manage",
        CI_TRIGGER_CAPABILITY,
        "preview.read",
        "preview.control",
        "preview.input",
      ]),
    );

    backendScript({
      wsUrl: "ws://operator.tailnet.ts.net/v1/ws",
      label: "Operator",
      clusterOperatorEnabled: true,
    });
    expect(() => detectBackend()).toThrow(/secure WSS cluster target/u);
    backendScript({
      wsUrl: "wss://operator.tailnet.ts.net/v1/ws?token=secret",
      label: "Operator",
      clusterOperatorEnabled: true,
    });
    expect(() => detectBackend()).toThrow(/query|credential/u);
  });
});
