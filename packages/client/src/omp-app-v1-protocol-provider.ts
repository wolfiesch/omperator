import {
  COMMAND_DESCRIPTORS,
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  ompServerEventFromFrame,
  requiredCapability,
} from "@t4-code/protocol";

import type {
  OmpClientMessage,
  OmpProtocolProvider,
} from "./omp-protocol-provider.ts";

function commandArgs(message: Extract<OmpClientMessage, { kind: "command" }>): Readonly<Record<string, unknown>> {
  const args = message.args;
  if (message.command !== "session.prompt" || args === undefined) return args ?? {};
  if (args.message !== undefined) return args;
  const { text, prompt, ...rest } = args;
  if (typeof text === "string") return { ...rest, message: text };
  if (typeof prompt === "string") return { ...rest, message: prompt };
  return Object.keys(args).length === 0 ? { message: "" } : args;
}

function appV1Input(message: OmpClientMessage): Record<string, unknown> {
  switch (message.kind) {
    case "hello":
      return {
        v: PROTOCOL_VERSION,
        type: "hello",
        protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
        client: message.client,
        requestedFeatures: [...message.requestedFeatures],
        savedCursors: message.savedCursors.map((record) => ({ ...record })),
        ...(message.capabilities === undefined ? {} : { capabilities: { client: [...message.capabilities] } }),
        ...(message.authentication === undefined ? {} : { authentication: message.authentication }),
      };
    case "command":
      return {
        v: PROTOCOL_VERSION,
        type: "command",
        requestId: message.requestId,
        commandId: message.commandId,
        hostId: message.hostId,
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        command: message.command,
        ...(message.expectedRevision === undefined ? {} : { expectedRevision: message.expectedRevision }),
        ...(message.confirmationId === undefined ? {} : { confirmationId: message.confirmationId }),
        args: commandArgs(message),
      };
    case "confirm":
      return {
        v: PROTOCOL_VERSION,
        type: "confirm",
        requestId: message.requestId,
        confirmationId: message.confirmationId,
        commandId: message.commandId,
        hostId: message.hostId,
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        decision: message.decision,
      };
    case "pair-start":
      return {
        v: PROTOCOL_VERSION,
        type: "pair.start",
        requestId: message.requestId,
        code: message.code,
        deviceId: message.deviceId,
        deviceName: message.deviceName,
        platform: message.platform,
        requestedCapabilities: [...message.requestedCapabilities],
      };
    case "terminal-input":
      return {
        v: PROTOCOL_VERSION,
        type: "terminal.input",
        hostId: message.hostId,
        sessionId: message.sessionId,
        terminalId: message.terminalId,
        data: message.data,
        ...(message.encoding === undefined ? {} : { encoding: message.encoding }),
      };
    case "terminal-resize":
      return {
        v: PROTOCOL_VERSION,
        type: "terminal.resize",
        hostId: message.hostId,
        sessionId: message.sessionId,
        terminalId: message.terminalId,
        cols: message.cols,
        rows: message.rows,
      };
    case "terminal-close":
      return {
        v: PROTOCOL_VERSION,
        type: "terminal.close",
        hostId: message.hostId,
        sessionId: message.sessionId,
        terminalId: message.terminalId,
        ...(message.reason === undefined ? {} : { reason: message.reason }),
      };
    case "ping":
      return { v: PROTOCOL_VERSION, type: "ping", nonce: message.nonce, timestamp: message.timestamp };
  }
}

function encodeAppV1ClientMessage(message: OmpClientMessage): string {
  const frame = decodeClientFrame(appV1Input(message));
  const encoded = JSON.stringify(frame);
  decodeClientFrame(encoded);
  return encoded;
}

/** Current canonical provider backed by the pinned @oh-my-pi/app-wire v1 artifact. */
export const ompAppV1ProtocolProvider: OmpProtocolProvider = Object.freeze({
  id: "omp-app-v1",
  protocolVersion: PROTOCOL_VERSION,
  encodeClientMessage: encodeAppV1ClientMessage,
  decodeServerEvent: (input: unknown) => ompServerEventFromFrame(decodeServerFrame(input)),
  commandDescriptor: (command: string) => COMMAND_DESCRIPTORS[command],
  requiredCapability,
});
