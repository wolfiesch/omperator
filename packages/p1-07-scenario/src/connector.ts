import { createHash, type Hash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import type {
  ByteSink,
  ByteSource,
  ProviderByteStream,
  ProviderCommand,
  ProviderConnector,
} from "../../provider-adapter/src/index.js";
import { createProviderRelaySshCommandHandler } from "@t4-code/ssh-gateway";

interface DigestRecord {
  readonly boundary: "adapter";
  readonly connection: number;
  readonly mode: ProviderCommand["mode"];
  readonly direction: "client-to-provider" | "provider-to-client";
  readonly bytes: number;
  readonly sha256: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function connectSocket(path: string, mode: ProviderCommand["mode"], signal: AbortSignal): Promise<{ socket: Socket; connection: number }> {
  const socket = createConnection({ path, signal });
  const { promise, resolve, reject } = Promise.withResolvers<{ socket: Socket; connection: number }>();
  let prefix = Buffer.alloc(0);
  const cleanup = (): void => {
    socket.off("data", received);
    socket.off("error", failed);
  };
  const failed = (error: Error): void => {
    cleanup();
    socket.destroy();
    reject(error);
  };
  const received = (chunk: Buffer): void => {
    prefix = Buffer.concat([prefix, chunk]);
    if (prefix.byteLength > 128) return failed(new Error("provider evidence connection prefix is too large"));
    const delimiter = prefix.indexOf(10);
    if (delimiter < 0) return;
    const match = /^P107-CONNECTION (control|stream) ([1-9][0-9]*)$/u.exec(prefix.subarray(0, delimiter).toString("utf8"));
    if (!match || match[1] !== mode) return failed(new Error("provider evidence connection prefix is invalid"));
    cleanup();
    socket.pause();
    const remainder = prefix.subarray(delimiter + 1);
    if (remainder.byteLength > 0) socket.unshift(remainder);
    resolve({ socket, connection: Number(match[2]) });
  };
  socket.on("data", received);
  socket.once("error", failed);
  return promise;
}

function observe(
  hash: Hash,
  chunk: Uint8Array,
  state: { skipFirstLine: boolean; skipped: boolean; bytes: number },
): void {
  let bytes = chunk;
  if (state.skipFirstLine && !state.skipped) {
    const delimiter = bytes.indexOf(10);
    if (delimiter < 0) return;
    state.skipped = true;
    bytes = bytes.subarray(delimiter + 1);
  }
  hash.update(bytes);
  state.bytes += bytes.byteLength;
}

export function createOmperatorctlConnector(): ProviderConnector {
  const expectedEndpoint = required("P107_ENDPOINT");
  const expectedProfile = required("P107_PROFILE");
  const expectedPrincipal = required("P107_PRINCIPAL");
  const evidencePath = required("P107_EVIDENCE_LOG");
  const handler = createProviderRelaySshCommandHandler({
    async resolveProviderRequest(_mode, context) {
      if (context.identity.principalId !== expectedPrincipal) return undefined;
      const scopeId = context.authorizedScopeIds[0];
      return scopeId ? { scopeId } : undefined;
    },
    async resolveRuntime(_runtimeId, context) {
      if (context.identity.principalId !== expectedPrincipal) return undefined;
      const scopeId = context.authorizedScopeIds[0];
      return scopeId ? { scopeId } : undefined;
    },
    async openProvider(mode, context, signal): Promise<ProviderByteStream> {
      if (context.identity.principalId !== expectedPrincipal)
        throw new Error("SSH principal does not match injected provider identity");
      const path = required(mode === "control" ? "P107_CONTROL_SOCKET" : "P107_STREAM_SOCKET");
      const { socket, connection } = await connectSocket(path, mode, signal);
      const inbound = createHash("sha256");
      const outbound = createHash("sha256");
      const inboundState = { skipFirstLine: mode === "stream", skipped: false, bytes: 0 };
      const outboundState = { skipFirstLine: mode === "stream", skipped: false, bytes: 0 };
      let inboundRecorded = false;
      let outboundRecorded = false;
      const record = (direction: DigestRecord["direction"]): void => {
        if (direction === "client-to-provider") {
          if (outboundRecorded) return;
          outboundRecorded = true;
          appendFileSync(evidencePath, `${JSON.stringify({ boundary: "adapter", connection, mode, direction, bytes: outboundState.bytes, sha256: outbound.digest("hex") } satisfies DigestRecord)}\n`);
        } else {
          if (inboundRecorded) return;
          inboundRecorded = true;
          appendFileSync(evidencePath, `${JSON.stringify({ boundary: "adapter", connection, mode, direction, bytes: inboundState.bytes, sha256: inbound.digest("hex") } satisfies DigestRecord)}\n`);
        }
      };
      const readable: ByteSource = {
        async *[Symbol.asyncIterator]() {
          try {
            for await (const chunk of socket) {
              const bytes = chunk as Uint8Array;
              observe(inbound, bytes, inboundState);
              yield bytes;
            }
          } finally {
            record("provider-to-client");
          }
        },
        cancel(reason) {
          socket.destroy(reason instanceof Error ? reason : undefined);
          record("provider-to-client");
        },
      };
      const writable: ByteSink = {
        write(chunk) {
          observe(outbound, chunk, outboundState);
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          socket.write(chunk, error => error ? reject(error) : resolve());
          return promise;
        },
        end() {
          record("client-to-provider");
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const failed = (error: Error) => { socket.off("finish", finished); reject(error); };
          const finished = () => { socket.off("error", failed); resolve(); };
          socket.once("error", failed);
          socket.once("finish", finished);
          socket.end();
          return promise;
        },
        abort(reason) {
          record("client-to-provider");
          socket.destroy(reason instanceof Error ? reason : undefined);
        },
      };
      return {
        readable,
        write: chunk => writable.write(chunk),
        end: () => writable.end(),
        close: async reason => {
          record("client-to-provider");
          record("provider-to-client");
          socket.destroy(reason instanceof Error ? reason : undefined);
        },
      };
    },
  });
  return {
    async connect(command, signal) {
      if (command.endpoint !== expectedEndpoint || command.profile !== expectedProfile)
        throw new Error("connector command does not match injected local identity");
      const identity = Object.freeze({
        principalId: expectedPrincipal,
        authorizedScopes: Object.freeze([]),
        adapter: Object.freeze({ id: "openssh-expose-auth-info" as const, type: "ssh" as const }),
        policyRevision: "ssh-expose-auth-info-v1" as const,
      });
      const scopeId = `scope_${createHash("sha256").update(expectedPrincipal).digest("base64url").slice(0, 24)}`;
      const authorization = {
        identity,
        requestId: "p107-provider-connector",
        action: "runtime.connect.cmux" as const,
        pty: false,
        authorizedScopeIds: Object.freeze([scopeId]),
      };
      const selected = await handler.resolve({ kind: "provider", mode: command.mode }, authorization, signal);
      if (!selected || selected.scopeId !== scopeId) throw new Error("connector scope is unavailable");
      const channel = await handler.open(
        { kind: "provider", mode: command.mode },
        { ...authorization, scopeId },
        signal,
      );
      return {
        readable: channel.readable,
        write: chunk => channel.write(chunk),
        end: () => channel.end(),
        close: async reason => { await channel.close(reason); },
      };
    },
  };
}
