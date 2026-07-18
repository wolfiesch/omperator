import { hostId } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import {
  OmpClient,
  OmpProtocolProviderRegistry,
  ompAppV1ProtocolProvider,
  type OmpClientMessage,
  type OmpProtocolProvider,
  type OmpServerEvent,
  type OmpServerEventOf,
  type OmpTransport,
} from "../src/index.ts";
import { protocolProviderConformance } from "./protocol-provider-conformance.ts";

const FUTURE_ID = "fixture-v2";
const FUTURE_PROTOCOL = "omp-app/2";

function futureWelcome(): OmpServerEventOf<"welcome"> {
  return Object.freeze({
    kind: "welcome",
    payload: Object.freeze({
      selectedProtocol: FUTURE_PROTOCOL,
      hostId: hostId("future-host"),
      ompVersion: "future",
      ompBuild: "future",
      appserverVersion: "future",
      appserverBuild: "future",
      epoch: "future-epoch",
      grantedCapabilities: ["sessions.read"],
      grantedFeatures: ["resume"],
      negotiatedLimits: Object.freeze({}),
      authentication: "local",
      resumed: false,
    }),
  });
}

function futureWireWelcome(): Readonly<Record<string, unknown>> {
  return Object.freeze({ protocol: FUTURE_PROTOCOL, event: futureWelcome() });
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("future protocol object required");
  }
  return value as Record<string, unknown>;
}

const futureProvider: OmpProtocolProvider = Object.freeze({
  id: FUTURE_ID,
  protocolVersion: FUTURE_PROTOCOL,
  encodeClientMessage(message: OmpClientMessage): string {
    return JSON.stringify({ protocol: FUTURE_PROTOCOL, message });
  },
  decodeServerEvent(input: unknown): OmpServerEvent {
    const envelope = record(typeof input === "string" ? JSON.parse(input) : input);
    if (envelope.protocol !== FUTURE_PROTOCOL) throw new Error("future protocol mismatch");
    const event = record(envelope.event);
    if (event.kind !== "welcome") throw new Error("future welcome required");
    const payload = record(event.payload);
    if (payload.selectedProtocol !== FUTURE_PROTOCOL || payload.hostId !== "future-host") {
      throw new Error("invalid future welcome");
    }
    return futureWelcome();
  },
  commandDescriptor: (command: string) => ompAppV1ProtocolProvider.commandDescriptor(command),
  requiredCapability: (command: string) => ompAppV1ProtocolProvider.requiredCapability(command),
});

function outboundMessages(): OmpClientMessage[] {
  return [
    { kind: "hello", client: { name: "test", version: "1", build: "1", platform: "test" }, requestedFeatures: [], savedCursors: [] },
    { kind: "command", requestId: "request", commandId: "command", hostId: "future-host", command: "session.list", args: {} },
    { kind: "confirm", requestId: "confirm-request", confirmationId: "confirmation", commandId: "command", hostId: "future-host", decision: "approve" },
    { kind: "pair-start", requestId: "pair-request", code: "123456", deviceId: "device", deviceName: "test", platform: "test", requestedCapabilities: [] },
    { kind: "terminal-input", hostId: "future-host", sessionId: "session", terminalId: "terminal", data: "input" },
    { kind: "terminal-resize", hostId: "future-host", sessionId: "session", terminalId: "terminal", cols: 80, rows: 24 },
    { kind: "terminal-close", hostId: "future-host", sessionId: "session", terminalId: "terminal" },
    { kind: "ping", nonce: "nonce", timestamp: "2030-01-01T00:00:00.000Z" },
  ];
}

class FutureTransport implements OmpTransport {
  readonly sent: string[] = [];
  private readonly messages = new Set<(data: string | Uint8Array) => void>();
  send(data: string): void {
    this.sent.push(data);
    const envelope = record(JSON.parse(data));
    if (envelope.protocol !== FUTURE_PROTOCOL) throw new Error("wrong outbound protocol");
    const message = record(envelope.message);
    if (message.kind !== "hello") return;
    for (const listener of this.messages) listener(JSON.stringify(futureWireWelcome()));
  }
  close(): void {}
  onMessage(listener: (data: string | Uint8Array) => void): () => void { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(): () => void { return () => undefined; }
  onError(): () => void { return () => undefined; }
}

protocolProviderConformance({
  name: FUTURE_PROTOCOL,
  provider: futureProvider,
  outboundMessages: outboundMessages(),
  inboundFrames: [futureWireWelcome()],
  invalidInbound: [{ protocol: "omp-app/1", event: futureWelcome() }, null],
  knownCommand: { name: "session.list", capability: "sessions.read" },
});

describe("OmpProtocolProviderRegistry", () => {
  it("indexes immutable providers by id and protocol version", () => {
    const registry = new OmpProtocolProviderRegistry(
      [ompAppV1ProtocolProvider, futureProvider],
      FUTURE_ID,
    );

    expect(registry.providers).toEqual([ompAppV1ProtocolProvider, futureProvider]);
    expect(Object.isFrozen(registry.providers)).toBe(true);
    expect(registry.requireById()).toBe(futureProvider);
    expect(registry.getById("omp-app-v1")).toBe(ompAppV1ProtocolProvider);
    expect(registry.getByProtocolVersion(FUTURE_PROTOCOL)).toBe(futureProvider);
  });

  it("rejects empty, duplicate, and unknown-default registries", () => {
    expect(() => new OmpProtocolProviderRegistry([])).toThrow("at least one");
    expect(
      () => new OmpProtocolProviderRegistry([{ ...futureProvider, id: "" }]),
    ).toThrow("invalid protocol provider id");
    expect(
      () =>
        new OmpProtocolProviderRegistry([
          { ...futureProvider, protocolVersion: `${FUTURE_PROTOCOL}\n` },
        ]),
    ).toThrow("invalid protocol provider version");
    expect(() => new OmpProtocolProviderRegistry([futureProvider, { ...futureProvider }])).toThrow("duplicate protocol provider id");
    expect(() => new OmpProtocolProviderRegistry([futureProvider, { ...futureProvider, id: "other" }])).toThrow("duplicate protocol version");
    expect(() => new OmpProtocolProviderRegistry([futureProvider], "missing")).toThrow("unknown default");
  });

  it("connects through a selected provider with a different wire shape", async () => {
    const registry = new OmpProtocolProviderRegistry([ompAppV1ProtocolProvider, futureProvider]);
    const transport = new FutureTransport();
    const client = new OmpClient({
      transport: () => transport,
      hostId: "future-host",
      protocolProviderId: FUTURE_ID,
      protocolProviderRegistry: registry,
    });
    const events: OmpServerEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.connect();

    expect(client.state).toBe("ready");
    expect(JSON.parse(transport.sent[0]!)).toMatchObject({
      protocol: FUTURE_PROTOCOL,
      message: { kind: "hello" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "welcome",
      payload: { selectedProtocol: FUTURE_PROTOCOL, hostId: "future-host" },
    });
    await client.close();
  });

  it("rejects ambiguous and unknown client provider selections", () => {
    const registry = new OmpProtocolProviderRegistry([
      ompAppV1ProtocolProvider,
      futureProvider,
    ]);
    const transport = () => new FutureTransport();

    expect(
      () =>
        new OmpClient({
          transport,
          protocolProvider: futureProvider,
          protocolProviderId: FUTURE_ID,
        }),
    ).toThrow("cannot be combined");
    expect(
      () =>
        new OmpClient({
          transport,
          protocolProviderId: "missing",
          protocolProviderRegistry: registry,
        }),
    ).toThrow("unknown protocol provider");
  });
});
