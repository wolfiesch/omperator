import { decodeClientFrame, hostId, pairingId, requestId, type PairOkFrame, type WelcomeFrame } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";
import {
  OmpClient,
  ompAppV1ProtocolProvider,
  type OmpClientMessage,
  type OmpServerEvent,
  type OmpProtocolProvider,
  type OmpTransport,
  type PublicOmpServerEvent,
} from "../src/index.ts";
import { protocolProviderConformance } from "./protocol-provider-conformance.ts";

function welcomeFrame(): WelcomeFrame {
  return {
    v: "omp-app/1",
    type: "welcome",
    selectedProtocol: "omp-app/1",
    hostId: hostId("provider-host"),
    ompVersion: "test",
    ompBuild: "test",
    appserverVersion: "test",
    appserverBuild: "test",
    epoch: "provider-epoch",
    grantedCapabilities: ["sessions.read"],
    grantedFeatures: ["resume"],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

function pairOkFrame(): PairOkFrame {
  return {
    v: "omp-app/1",
    type: "pair.ok",
    requestId: requestId("pair-request"),
    pairingId: pairingId("pairing-id"),
    deviceId: "device-id",
    deviceName: "Test device",
    platform: "linux",
    requestedCapabilities: [],
    grantedCapabilities: [],
    deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

function outboundMessages(): OmpClientMessage[] {
  return [
    {
      kind: "hello",
      client: { name: "t4-code", version: "test", build: "test", platform: "electron" },
      requestedFeatures: ["resume"],
      savedCursors: [],
      capabilities: ["sessions.read"],
      authentication: { deviceId: "device", deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    },
    {
      kind: "command",
      requestId: "request-command",
      commandId: "command-command",
      hostId: "provider-host",
      sessionId: "provider-session",
      command: "session.prompt",
      args: { text: "hello" },
    },
    {
      kind: "confirm",
      requestId: "request-confirm",
      confirmationId: "confirmation-fixture",
      commandId: "command-confirm",
      hostId: "provider-host",
      decision: "approve",
    },
    {
      kind: "pair-start",
      requestId: "request-pair",
      code: "123456",
      deviceId: "device",
      deviceName: "test",
      platform: "linux",
      requestedCapabilities: [],
    },
    {
      kind: "terminal-input",
      hostId: "provider-host",
      sessionId: "provider-session",
      terminalId: "terminal-a",
      data: "hello",
    },
    {
      kind: "terminal-resize",
      hostId: "provider-host",
      sessionId: "provider-session",
      terminalId: "terminal-a",
      cols: 80,
      rows: 24,
    },
    {
      kind: "terminal-close",
      hostId: "provider-host",
      sessionId: "provider-session",
      terminalId: "terminal-a",
    },
    { kind: "ping", nonce: "ping-1", timestamp: "2026-07-17T00:00:00.000Z" },
  ];
}

class HandshakeTransport implements OmpTransport {
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  onMessage(listener: (data: string | Uint8Array) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onClose(): () => void {
    return () => undefined;
  }
  onError(): () => void {
    return () => undefined;
  }
  close(): void {}
  send(data: string): void {
    const frame = decodeClientFrame(data);
    if (frame.type !== "hello") return;
    for (const listener of this.messages) listener(JSON.stringify(welcomeFrame()));
  }
}

protocolProviderConformance({
  name: "omp-app/1",
  provider: ompAppV1ProtocolProvider,
  outboundMessages: outboundMessages(),
  inboundFrames: [welcomeFrame(), pairOkFrame()],
  invalidInbound: [{}, { v: "omp-app/999", type: "welcome" }],
  knownCommand: { name: "session.list", capability: "sessions.read" },
});

describe("OmpProtocolProvider", () => {
  it("describes the pinned omp-app/1 implementation", () => {
    expect(ompAppV1ProtocolProvider.id).toBe("omp-app-v1");
    expect(ompAppV1ProtocolProvider.protocolVersion).toBe("omp-app/1");
    expect(ompAppV1ProtocolProvider.commandDescriptor("session.list")).toMatchObject({
      capability: "sessions.read",
      scope: "host",
    });
    expect(ompAppV1ProtocolProvider.requiredCapability("session.list")).toBe("sessions.read");
  });

  it("builds every outbound message using the pinned wire shape", () => {
    const messages = outboundMessages();

    const frames = messages.map((message) =>
      decodeClientFrame(ompAppV1ProtocolProvider.encodeClientMessage(message)),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "hello",
      "command",
      "confirm",
      "pair.start",
      "terminal.input",
      "terminal.resize",
      "terminal.close",
      "ping",
    ]);
    const promptFrame = frames[1];
    if (promptFrame?.type !== "command") throw new Error("expected command frame");
    expect(promptFrame).toMatchObject({ v: "omp-app/1", type: "command" });
    expect(promptFrame.args).toEqual({ message: "hello" });
    const normalized = decodeClientFrame(ompAppV1ProtocolProvider.encodeClientMessage({
      kind: "command",
      requestId: "request-legacy",
      commandId: "command-legacy",
      hostId: "provider-host",
      sessionId: "provider-session",
      command: "session.prompt",
      args: { prompt: "legacy" },
    }));
    if (normalized.type !== "command") throw new Error("expected command frame");
    expect(normalized.args).toEqual({ message: "legacy" });
    expect(() =>
      ompAppV1ProtocolProvider.encodeClientMessage({
        kind: "command",
        requestId: "request-empty",
        commandId: "command-empty",
        hostId: "provider-host",
        sessionId: "provider-session",
        command: "session.prompt",
        args: {},
      }),
    ).toThrow();
    for (const [index, frame] of frames.entries()) {
      expect(JSON.parse(ompAppV1ProtocolProvider.encodeClientMessage(messages[index]!))).toEqual(frame);
    }
  });

  it("normalizes a validated server frame into a version-free T4 event", () => {
    const decoded = ompAppV1ProtocolProvider.decodeServerEvent(welcomeFrame());

    expect(decoded.kind).toBe("welcome");
    expect(decoded).toEqual({ kind: "welcome", payload: decoded.payload });
    expect(decoded.payload).not.toHaveProperty("v");
    expect(decoded.payload).not.toHaveProperty("type");
    expect(decoded.payload).toMatchObject({
      hostId: "provider-host",
      selectedProtocol: "omp-app/1",
      authentication: "local",
    });
    expect(decoded).not.toHaveProperty("wireFrame");
    expect(Object.isFrozen(decoded.payload)).toBe(true);
  });

  it("routes outbound work and inbound events through an injected provider", async () => {
    let clientEncodes = 0;
    let serverEventDecodes = 0;
    const provider: OmpProtocolProvider = {
      ...ompAppV1ProtocolProvider,
      encodeClientMessage(message: OmpClientMessage): string {
        clientEncodes += 1;
        return ompAppV1ProtocolProvider.encodeClientMessage(message);
      },
      decodeServerEvent(input: unknown): OmpServerEvent {
        serverEventDecodes += 1;
        return ompAppV1ProtocolProvider.decodeServerEvent(input);
      },
    };
    const client = new OmpClient({
      hostId: "provider-host",
      protocolProvider: provider,
      transport: () => new HandshakeTransport(),
    });
    const events: PublicOmpServerEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.connect();

    expect(client.state).toBe("ready");
    expect(clientEncodes).toBeGreaterThan(0);
    expect(serverEventDecodes).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "welcome", payload: { hostId: "provider-host" } });
    await client.close();
  });

  it("fails closed when a welcome selects a different protocol than the provider", async () => {
    const provider: OmpProtocolProvider = {
      ...ompAppV1ProtocolProvider,
      id: "mismatched-provider",
      protocolVersion: "omp-app/2",
    };
    const client = new OmpClient({
      hostId: "provider-host",
      protocolProvider: provider,
      transport: () => new HandshakeTransport(),
    });

    await expect(client.connect()).rejects.toMatchObject({ code: "protocol" });
    expect(client.state).toBe("fatal");
    await client.close();
  });

  it("classifies provider-side outbound encoding failures as protocol errors", async () => {
    const provider: OmpProtocolProvider = {
      ...ompAppV1ProtocolProvider,
      encodeClientMessage(message: OmpClientMessage): string {
        if (message.kind === "command") throw new Error("unsupported logical message");
        return ompAppV1ProtocolProvider.encodeClientMessage(message);
      },
    };
    const client = new OmpClient({
      hostId: "provider-host",
      protocolProvider: provider,
      transport: () => new HandshakeTransport(),
    });

    await client.connect();
    await expect(client.command({ hostId: "provider-host", command: "session.list" }))
      .rejects.toMatchObject({ code: "protocol" });
    expect(client.state).toBe("ready");
    await client.close();
  });
});
