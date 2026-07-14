import { describe, expect, it } from "vitest";
import { DESKTOP_IPC_CHANNELS, decodeDesktopInvokeRequest } from "@t4-code/protocol/desktop-ipc";
import type { CursorStore, OmpTransport, PublicServerFrame } from "@t4-code/client";
import {
  commandId,
  confirmationId,
  DEVICE_CAPABILITIES,
  hostId,
  sessionId,
  type WelcomeFrame,
} from "@t4-code/protocol";
import { validEvent } from "../src/ipc.ts";
import { DesktopTargetManager } from "../src/target-manager.ts";
import type { RemoteTargetRecord, RemoteTargetRegistry } from "../src/remote-runtime/registry.ts";

const V = "omp-app/1" as const;
function welcome(host = "host-fixture"): WelcomeFrame {
  return {
    v: V,
    type: "welcome",
    selectedProtocol: V,
    hostId: hostId(host),
    ompVersion: "fixture",
    ompBuild: "test",
    appserverVersion: "fixture",
    appserverBuild: "test",
    epoch: "epoch-a",
    grantedCapabilities: [
      "sessions.read",
      "sessions.prompt",
      "sessions.control",
      "sessions.manage",
    ],
    grantedFeatures: ["resume"],
    negotiatedLimits: { maxInputBytes: 1_048_576 },
    authentication: "local",
    resumed: false,
  };
}
function pairingWelcome(host = "host-fixture"): WelcomeFrame {
  return { ...welcome(host), authentication: "pairing-required", grantedCapabilities: [] };
}
class Transport implements OmpTransport {
  private readonly helloFrame: WelcomeFrame;
  private readonly helloRejection: { readonly code: number; readonly reason: string } | undefined;
  constructor(
    helloFrame: WelcomeFrame = welcome(),
    helloRejection?: { readonly code: number; readonly reason: string },
  ) {
    this.helloFrame = helloFrame;
    this.helloRejection = helloRejection;
  }
  readonly sent: string[] = [];
  closed = false;
  private readonly messages = new Set<(data: string) => void>();
  private readonly closes = new Set<(code?: number, reason?: string) => void>();
  private readonly errors = new Set<(error: unknown) => void>();
  private readonly sentListeners = new Set<() => void>();
  async open(): Promise<void> {}
  send(data: string): void {
    this.sent.push(data);
    for (const listener of this.sentListeners) listener();
    if (JSON.parse(data).type === "hello") {
      if (this.helloRejection !== undefined) {
        for (const listener of this.closes) {
          listener(this.helloRejection.code, this.helloRejection.reason);
        }
      } else {
        for (const listener of this.messages) listener(JSON.stringify(this.helloFrame));
      }
    }
  }
  waitForSent(index: number): Promise<Record<string, unknown>> {
    const existing = this.sent[index];
    if (existing !== undefined)
      return Promise.resolve(JSON.parse(existing) as Record<string, unknown>);
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    const listener = () => {
      const data = this.sent[index];
      if (data === undefined) return;
      this.sentListeners.delete(listener);
      resolve(JSON.parse(data) as Record<string, unknown>);
    };
    this.sentListeners.add(listener);
    return promise;
  }
  receive(frame: Record<string, unknown>): void {
    for (const listener of this.messages) listener(JSON.stringify(frame));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(1000, "closed");
    this.messages.clear();
    this.closes.clear();
    this.errors.clear();
    this.sentListeners.clear();
  }
  onMessage(listener: (data: string | Uint8Array) => void): () => void {
    const wrapped = (data: string) => listener(data);
    this.messages.add(wrapped);
    return () => this.messages.delete(wrapped);
  }
  onClose(listener: (code?: number, reason?: string) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }
  onError(listener: (error: unknown) => void): () => void {
    this.errors.add(listener);
    return () => this.errors.delete(listener);
  }
}
class Store implements CursorStore {
  load(): readonly never[] {
    return [];
  }
  save(): void {}
}
class Registry implements RemoteTargetRegistry {
  private readonly values = new Map<string, RemoteTargetRecord>();
  async list(): Promise<readonly RemoteTargetRecord[]> {
    return [...this.values.values()];
  }
  async get(id: string): Promise<RemoteTargetRecord | null> {
    return this.values.get(id) ?? null;
  }
  async put(value: RemoteTargetRecord): Promise<void> {
    this.values.set(value.targetId, value);
  }
  async remove(id: string): Promise<void> {
    this.values.delete(id);
  }
}
const target = (targetId: string): RemoteTargetRecord => ({
  targetId,
  label: targetId,
  mode: "direct",
  address: "100.64.0.1",
  port: 4210,
  requestedCapabilities: ["sessions.read"],
  grantedCapabilities: [],
  status: "unknown",
});
function manager(
  transports: Transport[],
  registry = new Registry(),
  onFrame: (frame: PublicServerFrame) => void = () => undefined,
): DesktopTargetManager {
  return new DesktopTargetManager({
    cursorStore: new Store(),
    registry,
    transportFactory: () => {
      const next = new Transport();
      transports.push(next);
      return next as never;
    },
    remoteTransportFactory: () => {
      const next = new Transport();
      transports.push(next);
      return next as never;
    },
    capabilities: ["sessions.read"],
    events: { onFrame: (_targetId, frame) => onFrame(frame), onState: () => {}, onError: () => {} },
  });
}

describe("desktop target manager boundaries", () => {
  it("falls back from both image features for a pre-image appserver", async () => {
    const transports: Transport[] = [];
    const runtime = new DesktopTargetManager({
      cursorStore: new Store(),
      transportFactory: () => {
        const next = new Transport(
          welcome(),
          transports.length === 0 ? { code: 1008, reason: "invalid frame" } : undefined,
        );
        transports.push(next);
        return next as never;
      },
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
    });

    await runtime.connect();

    expect(transports).toHaveLength(2);
    const firstHello = JSON.parse(transports[0]?.sent[0] ?? "{}") as {
      requestedFeatures?: string[];
    };
    const fallbackHello = JSON.parse(transports[1]?.sent[0] ?? "{}") as {
      requestedFeatures?: string[];
    };
    expect(firstHello.requestedFeatures).toContain("prompt.images");
    expect(firstHello.requestedFeatures).toContain("transcript.images");
    expect(fallbackHello.requestedFeatures).not.toContain("prompt.images");
    expect(fallbackHello.requestedFeatures).not.toContain("transcript.images");
    await runtime.close();
  });

  it("serializes concurrent target lifecycle and closes each generation", async () => {
    const transports: Transport[] = [];
    const registry = new Registry();
    await registry.put(target("one"));
    await registry.put(target("two"));
    const runtime = manager(transports, registry);
    await Promise.all([runtime.connect("one"), runtime.connect("two")]);
    expect(runtime.isConnected("one")).toBe(true);
    expect(runtime.isConnected("two")).toBe(true);
    await Promise.all([runtime.disconnect("one"), runtime.disconnect("two")]);
    expect(transports.length).toBe(2);
    expect(transports.every((item) => item.closed)).toBe(true);
    await runtime.close();
  });
  it("keeps local full scope and isolates each remote scope across reconnects", async () => {
    const localTransports: Transport[] = [];
    const local = new DesktopTargetManager({
      cursorStore: new Store(),
      transportFactory: () => {
        const next = new Transport();
        localTransports.push(next);
        return next as never;
      },
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
    });
    await local.connect();
    const localHello = JSON.parse(localTransports[0]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(localHello).toMatchObject({
      type: "hello",
      capabilities: { client: [...DEVICE_CAPABILITIES] },
    });
    await local.close();

    const transports: Transport[] = [];
    const registry = new Registry();
    const observe = {
      ...target("observe"),
      requestedCapabilities: ["sessions.read", "catalog.read"],
    };
    const settingsControl = {
      ...target("settings-control"),
      requestedCapabilities: [
        "sessions.read",
        "config.read",
        "config.write",
        "sessions.prompt",
        "sessions.control",
      ],
    };
    await registry.put(observe);
    await registry.put(settingsControl);
    const runtime = manager(transports, registry);
    await Promise.all([runtime.connect("observe"), runtime.connect("settings-control")]);
    const observeHello = JSON.parse(transports[0]?.sent[0] ?? "{}") as Record<string, unknown>;
    const settingsHello = JSON.parse(transports[1]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(observeHello).toMatchObject({
      type: "hello",
      capabilities: { client: observe.requestedCapabilities },
    });
    expect(settingsHello).toMatchObject({
      type: "hello",
      capabilities: { client: settingsControl.requestedCapabilities },
    });

    const firstObserveTransport = transports[0];
    await runtime.disconnect("observe");
    await runtime.connect("observe");
    const reconnectHello = JSON.parse(transports[2]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(firstObserveTransport?.closed).toBe(true);
    expect(reconnectHello).toMatchObject({
      type: "hello",
      capabilities: { client: observe.requestedCapabilities },
    });

    const changedSettings = {
      ...settingsControl,
      requestedCapabilities: ["sessions.read", "config.read"],
    };
    await registry.put(changedSettings);
    const firstSettingsTransport = transports[1];
    await runtime.connect("settings-control");
    const changedHello = JSON.parse(transports[3]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(firstSettingsTransport?.closed).toBe(true);
    expect(changedHello).toMatchObject({
      type: "hello",
      capabilities: { client: changedSettings.requestedCapabilities },
    });
    await runtime.close();
  });
  it("uses the remote scope for pairing and never asks for a broad grant", async () => {
    const transports: Transport[] = [];
    const registry = new Registry();
    const remote = {
      ...target("observe-pair"),
      requestedCapabilities: ["sessions.read", "catalog.read"],
    };
    await registry.put(remote);
    const credentials = {
      withCredential<T>(): T {
        throw new Error("credential unavailable");
      },
      set: async () => {},
      revoke: async () => {},
    };
    const runtime = new DesktopTargetManager({
      cursorStore: new Store(),
      registry,
      credentials,
      remoteTransportFactory: () => {
        const next = new Transport(pairingWelcome());
        transports.push(next);
        return next as never;
      },
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
    });
    await runtime.connect("observe-pair");
    const hello = JSON.parse(transports[0]?.sent[0] ?? "{}") as Record<string, unknown>;
    expect(hello).toMatchObject({ capabilities: { client: remote.requestedCapabilities } });
    const pairTransport = transports[0];
    if (pairTransport === undefined) throw new Error("pairing transport was not created");
    const pairRequestPromise = pairTransport.waitForSent(1);
    const pairing = runtime.pairStart("observe-pair", "123456");
    const pairRequest = await pairRequestPromise;
    expect(pairRequest).toMatchObject({
      type: "pair.start",
      requestedCapabilities: remote.requestedCapabilities,
    });
    expect(pairRequest).not.toMatchObject({ requestedCapabilities: [...DEVICE_CAPABILITIES] });
    pairTransport.receive({
      v: V,
      type: "pair.ok",
      requestId: pairRequest.requestId,
      pairingId: "pair-1",
      deviceId: "desktop",
      deviceName: "T4 Code Desktop",
      platform: process.platform,
      requestedCapabilities: remote.requestedCapabilities,
      grantedCapabilities: remote.requestedCapabilities,
      deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    const result = await pairing;
    expect(result).toEqual({ targetId: "observe-pair", paired: true });
    await runtime.close();
  });
  it("keeps same-target commands correlated while disconnect settles both unknown", async () => {
    const transports: Transport[] = [];
    const registry = new Registry();
    await registry.put(target("commands"));
    const runtime = manager(transports, registry);
    await runtime.connect("commands");
    const first = runtime.command("commands", {
      hostId: "host-fixture",
      command: "host.list",
      args: {},
    });
    const second = runtime.command("commands", {
      hostId: "host-fixture",
      command: "host.list",
      args: {},
    });
    await runtime.disconnect("commands");
    const outcomes = await Promise.all([
      first.then(
        () => "resolved",
        (error: { code?: string }) => error.code,
      ),
      second.then(
        () => "resolved",
        (error: { code?: string }) => error.code,
      ),
    ]);
    expect(outcomes).toEqual(["outcome_unknown", "outcome_unknown"]);
    await runtime.close();
  });
  it("forwards decoded command payloads needed by lease consumers", async () => {
    const transports: Transport[] = [];
    const frames: PublicServerFrame[] = [];
    const runtime = manager(transports, new Registry(), (frame) => frames.push(frame));
    await runtime.connect();
    const pending = runtime.command({
      hostId: "host-fixture",
      sessionId: "session-a",
      command: "controller.lease.acquire",
      expectedRevision: "revision-a",
      args: { ownerId: "desktop" },
    });
    const command = JSON.parse(transports[0]?.sent.at(-1) ?? "{}") as Record<string, unknown>;
    transports[0]?.receive({
      v: V,
      type: "response",
      requestId: command.requestId,
      commandId: command.commandId,
      hostId: "host-fixture",
      sessionId: "session-a",
      ok: true,
      command: "controller.lease.acquire",
      result: { accepted: true, leaseId: "lease-live", expiresAt: "2030-01-01T00:00:00.000Z" },
    });
    const result = await pending;
    expect(result).toMatchObject({
      targetId: "local",
      accepted: true,
      result: { accepted: true, leaseId: "lease-live", expiresAt: "2030-01-01T00:00:00.000Z" },
    });
    const rejected = runtime.command({ hostId: "host-fixture", command: "host.list", args: {} });
    const rejectedCommand = JSON.parse(transports[0]?.sent.at(-1) ?? "{}") as Record<
      string,
      unknown
    >;
    transports[0]?.receive({
      v: V,
      type: "response",
      requestId: rejectedCommand.requestId,
      commandId: rejectedCommand.commandId,
      hostId: "host-fixture",
      ok: false,
      command: "host.list",
      error: {
        code: "outcome_unknown",
        message: "command failed; Bearer live-message-token",
        details: {
          recovery: "inspect transcript",
          diagnostic: "token=live-detail-token",
          accessToken: "must-not-cross-renderer-ipc",
        },
      },
    });
    expect(await rejected).toMatchObject({
      accepted: false,
      error: {
        code: "outcome_unknown",
        message: "command failed; [redacted]",
        details: { recovery: "inspect transcript", diagnostic: "token=[redacted]" },
      },
    });
    const responseFrame = frames.find((frame) => frame.type === "response" && !frame.ok);
    expect(responseFrame).toMatchObject({
      error: {
        code: "outcome_unknown",
        message: "command failed; [redacted]",
        details: { recovery: "inspect transcript", diagnostic: "token=[redacted]" },
      },
    });
    expect(JSON.stringify(responseFrame)).not.toContain("live-message-token");
    expect(JSON.stringify(responseFrame)).not.toContain("live-detail-token");
    expect(JSON.stringify(responseFrame)).not.toContain("must-not-cross-renderer-ipc");
    await runtime.close();
  });
  it("treats a host-acknowledged denial as a consumed confirmation decision", async () => {
    const transports: Transport[] = [];
    const runtime = new DesktopTargetManager({
      cursorStore: new Store(),
      transportFactory: () => {
        const next = new Transport();
        transports.push(next);
        return next as never;
      },
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
    });
    await runtime.connect();
    const transport = transports[0];
    if (transport === undefined) throw new Error("transport was not created");

    const heldCommand = runtime.command({
      hostId: "host-fixture",
      sessionId: "session-a",
      command: "session.cancel",
      args: {},
    });
    const command = await transport.waitForSent(1);
    transport.receive({
      v: V,
      type: "confirmation",
      confirmationId: "confirm-deny",
      commandId: command.commandId,
      hostId: "host-fixture",
      sessionId: "session-a",
      commandHash: "sha256:fixture",
      revision: "revision-a",
      expiresAt: "2999-01-01T00:00:00.000Z",
      summary: "session.cancel",
    });
    const confirmed = runtime.confirm({
      targetId: "local",
      confirmationId: confirmationId("confirm-deny"),
      commandId: commandId(String(command.commandId)),
      hostId: hostId("host-fixture"),
      sessionId: sessionId("session-a"),
      decision: "deny",
    });
    await transport.waitForSent(2);
    transport.receive({
      v: V,
      type: "response",
      requestId: command.requestId,
      commandId: command.commandId,
      hostId: "host-fixture",
      sessionId: "session-a",
      command: "session.cancel",
      ok: false,
      error: { code: "confirmation_denied", message: "command was denied" },
    });
    const [commandResult, confirmationResult] = await Promise.all([heldCommand, confirmed]);
    expect(commandResult.accepted).toBe(false);
    expect(confirmationResult.accepted).toBe(true);
    expect(confirmationResult.requestId).toBe(command.requestId);
    await runtime.close();
  });
  it("reads remote auth on each Hello without retaining credential material", async () => {
    const transports: Transport[] = [];
    const registry = new Registry();
    await registry.put(target("auth"));
    let reads = 0;
    const token = "A".repeat(43);
    const credentials = {
      withCredential<T>(
        _targetId: string,
        provider: (value: { token: string; deviceId: string }) => T,
      ): T {
        reads += 1;
        return provider({ token, deviceId: "device-auth" });
      },
      set: async () => {},
      revoke: async () => {},
    };
    const runtime = new DesktopTargetManager({
      cursorStore: new Store(),
      registry,
      credentials,
      remoteTransportFactory: () => {
        const next = new Transport();
        transports.push(next);
        return next as never;
      },
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
      capabilities: ["sessions.read"],
    });
    await runtime.connect("auth");
    const internals = runtime as unknown as {
      runtimes: Map<string, { client: { options: { authentication?: () => unknown } } }>;
    };
    expect(reads).toBe(2);
    expect(JSON.stringify(internals)).toContain("runtimes");
    expect(JSON.stringify(internals).includes(token)).toBe(false);
    await runtime.close();
  });
  it("rejects malformed invoke channels, targets, and pairing credentials at the IPC schema boundary", () => {
    expect(() =>
      decodeDesktopInvokeRequest({ channel: "omp:targets:list", payload: { extra: true } }),
    ).toThrow();
    expect(() =>
      decodeDesktopInvokeRequest({ channel: "omp:connect", payload: { targetId: "../secret" } }),
    ).toThrow();
    expect(() =>
      decodeDesktopInvokeRequest({
        channel: "omp:pair",
        payload: { targetId: "local", code: "token!" },
      }),
    ).toThrow();
    expect(JSON.stringify({ targetId: "remote", paired: true }).includes("deviceToken")).toBe(
      false,
    );
  });
  it("uses canonical frozen pairing capabilities and ignores caller mutation", () => {
    const supplied = ["sessions.read"] as const;
    const custom = new DesktopTargetManager({
      cursorStore: new Store(),
      capabilities: supplied,
      events: { onFrame: () => {}, onState: () => {}, onError: () => {} },
    });
    const values = custom as unknown as { capabilities: readonly string[] };
    expect(values.capabilities).toEqual(["sessions.read"]);
    expect(Object.isFrozen(values.capabilities)).toBe(true);
    expect(supplied).toEqual(["sessions.read"]);
  });
  it("rejects untrusted invoke senders for every desktop channel", () => {
    const sender = {};
    const frame = { url: "file:///trusted/index.html" };
    const runtime = {
      manager: {} as never,
      window: { webContents: { mainFrame: frame } },
      trustedRenderer: { origin: "file://", url: "file:///trusted/index.html" },
    } as never;
    for (const channel of DESKTOP_IPC_CHANNELS) {
      void channel;
      expect(validEvent({ sender, senderFrame: frame } as never, runtime)).toBe(false);
    }
  });
});
