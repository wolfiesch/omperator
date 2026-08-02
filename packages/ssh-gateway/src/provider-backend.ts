import { createHmac, randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  createProviderRelaySshCommandHandler,
  SshGatewayError,
  type ProviderRelayBackend,
  type SshCommandAuthorizationContext,
  type SshCommandChannel,
  type SshCommandContext,
  type SshCommandHandler,
} from "./index.js";

const MAX_FRAME_BYTES = 1_048_576;
const MAX_BUFFERED_BYTES = 1_048_576;
const ASSERTION_TTL_SECONDS = 20;
const KEY_OVERLAP_SECONDS = 300;
const MAX_KEYRING_ROTATIONS = 256;
const KID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;

interface ProviderAssertionInput {
  readonly principalId: string;
  readonly scopeId: string;
  readonly requestId: string;
  readonly authorizedScopes?: readonly { readonly scopeId: string; readonly roles: readonly string[] }[];
  readonly policyRevision?: string;
  readonly audience: string;
  readonly purpose: "provider.control" | "provider.stream";
}

interface ProviderAssertionSigningKey { readonly kid: string; readonly secret: Uint8Array; }
async function readKeyringBytes(path: string): Promise<Buffer> {
  let file: FileHandle | undefined;
  try {
    file = await open(path, "r");
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 16_384) throw new Error();
    const buffer = Buffer.allocUnsafe(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await file.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== metadata.size) throw new Error();
    return buffer.subarray(0, bytesRead);
  } catch {
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readActiveSigningKey(path: string, nowSeconds = Math.floor(Date.now() / 1_000)): Promise<ProviderAssertionSigningKey> {
  const bytes = await readKeyringBytes(path);
  let value: Record<string, unknown>;
  try { value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new SshGatewayError("HANDLER_UNAVAILABLE"); }
  if (Object.keys(value).sort().join(",") !== "activeKid,keys,revision" || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.activeKid !== "string" || !KID.test(value.activeKid) || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 2)
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  const seen = new Set<string>();
  let active: ProviderAssertionSigningKey | undefined;
  for (const candidate of value.keys) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new SshGatewayError("HANDLER_UNAVAILABLE");
    const item = candidate as Record<string, unknown>, names = Object.keys(item).sort().join(",");
    if (typeof item.kid !== "string" || !KID.test(item.kid) || seen.has(item.kid) || typeof item.secret !== "string" || !/^[A-Za-z0-9_-]{43,5462}$/u.test(item.secret))
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    seen.add(item.kid);
    const isActive = item.kid === value.activeKid;
    if (names !== (isActive ? "kid,secret" : "kid,notAfter,secret") || !isActive && (!Number.isSafeInteger(item.notAfter) || (item.notAfter as number) > nowSeconds + KEY_OVERLAP_SECONDS))
      throw new SshGatewayError("HANDLER_UNAVAILABLE");
    const secret = Buffer.from(item.secret, "base64url");
    if (secret.byteLength < 32 || secret.byteLength > 4_096) throw new SshGatewayError("HANDLER_UNAVAILABLE");
    if (isActive) active = { kid: item.kid, secret: new Uint8Array(secret) };
  }
  if (!active) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  return active;
}

export function createProviderAssertion(input: ProviderAssertionInput, key: ProviderAssertionSigningKey, nowSeconds = Math.floor(Date.now() / 1_000), nonce = randomBytes(18).toString("base64url")): string {
  if (!KID.test(key.kid) || key.secret.byteLength < 32 || key.secret.byteLength > 4_096) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    kid: key.kid,
    aud: input.audience,
    purpose: input.purpose,
    principalId: input.principalId,
    scopeId: input.scopeId,
    requestId: input.requestId,
    exp: nowSeconds + ASSERTION_TTL_SECONDS,
    nonce,
    authorizedScopes: input.authorizedScopes ?? [],
    policyRevision: input.policyRevision ?? "ssh-expose-auth-info-v1",
  })).toString("base64url");
  const signature = createHmac("sha256", key.secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function providerAssertionAudience(base: string): string {
  const url = new URL(base);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password || url.search || url.hash || url.pathname !== "/internal/provider")
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${url.pathname}`;
}
function providerEndpoint(base: string, mode: "control" | "stream"): string {
  const url = new URL(base);
  const secure = url.protocol === "wss:";
  const clusterLocal = url.protocol === "ws:" && url.hostname.endsWith(".svc") && url.port === "8080";
  if ((!secure && !clusterLocal) || url.username || url.password || url.search || url.hash || url.pathname !== "/internal/provider")
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  url.pathname = `${url.pathname}/${mode}`;
  return url.toString();
}

function bytes(value: RawData): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Buffer.concat(value);
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

export async function openWebSocketChannel(endpoint: string, assertion: string, signal: AbortSignal, options: { readonly connectTimeoutMilliseconds?: number; readonly webSocketFactory?: (endpoint: string, options: ClientOptions) => WebSocket; readonly scheduleConnectTimeout?: (callback: () => void, milliseconds: number) => () => void } = {}): Promise<SshCommandChannel> {
  if (signal.aborted) throw new SshGatewayError("ABORTED");
  const connectTimeoutMilliseconds = options.connectTimeoutMilliseconds ?? 10_000;
  if (!Number.isSafeInteger(connectTimeoutMilliseconds) || connectTimeoutMilliseconds < 1 || connectTimeoutMilliseconds > 30_000)
    throw new SshGatewayError("HANDLER_UNAVAILABLE");
  const socket = (options.webSocketFactory ?? ((url, webSocketOptions) => new WebSocket(url, webSocketOptions)))(endpoint, {
    headers: { "x-t4-provider-assertion": assertion },
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  });
  socket.binaryType = "arraybuffer";
  const openedSocket = Promise.withResolvers<void>();
  let settled = false;
  let cancelConnectTimeout = (): void => undefined;
  const cleanup = (): void => {
    cancelConnectTimeout();
    socket.off("open", opened);
    socket.off("error", failed);
    signal.removeEventListener("abort", aborted);
  };
  const settle = (error?: SshGatewayError): void => {
    if (settled) return;
    settled = true;
    cleanup();
    if (error) {
      socket.terminate();
      openedSocket.reject(error);
    } else openedSocket.resolve();
  };
  cancelConnectTimeout = options.scheduleConnectTimeout
    ? options.scheduleConnectTimeout(() => settle(new SshGatewayError("TRANSPORT_FAILURE")), connectTimeoutMilliseconds)
    : (() => {
      const timer = setTimeout(() => settle(new SshGatewayError("TRANSPORT_FAILURE")), connectTimeoutMilliseconds);
      timer.unref?.();
      return () => clearTimeout(timer);
    })();
  const opened = (): void => settle();
  const failed = (): void => settle(new SshGatewayError("TRANSPORT_FAILURE"));
  const aborted = (): void => settle(new SshGatewayError("ABORTED"));
  socket.once("open", opened);
  socket.once("error", failed);
  signal.addEventListener("abort", aborted, { once: true });
  await openedSocket.promise;

  const queued: Uint8Array[] = [];
  let queuedBytes = 0;
  const waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
  };
  socket.on("message", value => {
    const chunk = bytes(value);
    const waiter = waiters.shift();
    if (waiter) waiter({ done: false, value: chunk });
    else if (chunk.byteLength > MAX_BUFFERED_BYTES - queuedBytes) {
      finish();
      socket.terminate();
    } else {
      queued.push(chunk);
      queuedBytes += chunk.byteLength;
    }
  });
  socket.once("close", finish);
  socket.once("error", finish);
  const abort = (): void => socket.close(1000, "SSH provider request cancelled");
  signal.addEventListener("abort", abort, { once: true });

  return {
    readable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<Uint8Array>> {
            const chunk = queued.shift();
            if (chunk) {
              queuedBytes -= chunk.byteLength;
              return Promise.resolve({ done: false, value: chunk });
            }
            if (ended) return Promise.resolve({ done: true, value: undefined });
            const pending = Promise.withResolvers<IteratorResult<Uint8Array>>();
            waiters.push(pending.resolve);
            return pending.promise;
          },
          return(): Promise<IteratorResult<Uint8Array>> {
            finish();
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    },
    write(chunk) {
      if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES - chunk.byteLength)
        return Promise.reject(new SshGatewayError("TRANSPORT_FAILURE"));
      const sent = Promise.withResolvers<void>();
      socket.send(chunk, { binary: true }, error => error ? sent.reject(new SshGatewayError("TRANSPORT_FAILURE")) : sent.resolve());
      return sent.promise;
    },
    end: async () => { if (socket.readyState === WebSocket.OPEN) socket.close(1000, "SSH input ended"); },
    close: async () => {
      signal.removeEventListener("abort", abort);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, "SSH provider channel closed");
      finish();
    },
  };
}

export function createInternalProviderRelayBackend(options: { readonly endpoint: string; readonly keyringPath: string; readonly openChannel?: (endpoint: string, assertion: string, signal: AbortSignal) => Promise<SshCommandChannel> }): ProviderRelayBackend {
  let activeKid: string | undefined;
  const retiredKids = new Set<string>();
  const resolveProviderRequest = async (_mode: "control" | "stream", context: SshCommandAuthorizationContext, signal: AbortSignal): Promise<{ readonly scopeId: string } | undefined> => {
    if (signal.aborted) throw new SshGatewayError("ABORTED");
    const scopeId = context.authorizedScopeIds[0];
    return scopeId ? { scopeId } : undefined;
  };
  const audience = providerAssertionAudience(options.endpoint);
  return {
    resolveProviderRequest,
    resolveRuntime: async () => undefined,
    async openProvider(mode: "control" | "stream", context: SshCommandContext, signal: AbortSignal) {
      const key = await readActiveSigningKey(options.keyringPath);
      if (key.kid !== activeKid) {
        if (retiredKids.has(key.kid) || activeKid !== undefined && retiredKids.size >= MAX_KEYRING_ROTATIONS) throw new SshGatewayError("HANDLER_UNAVAILABLE");
        if (activeKid !== undefined) retiredKids.add(activeKid);
        activeKid = key.kid;
      }
      const assertion = createProviderAssertion({ principalId: context.identity.principalId, scopeId: context.scopeId, requestId: context.requestId, authorizedScopes: context.identity.authorizedScopes, policyRevision: context.identity.policyRevision, audience, purpose: mode === "control" ? "provider.control" : "provider.stream" }, key);
      return (options.openChannel ?? openWebSocketChannel)(providerEndpoint(options.endpoint, mode), assertion, signal);
    },
  };
}

export async function createSshCommandHandler(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<SshCommandHandler> {
  const endpoint = environment.T4_PROVIDER_INTERNAL_WS_URL;
  const secretFile = environment.T4_PROVIDER_INTERNAL_HMAC_FILE;
  if (!endpoint || !secretFile) throw new SshGatewayError("HANDLER_UNAVAILABLE");
  return createProviderRelaySshCommandHandler(createInternalProviderRelayBackend({ endpoint, keyringPath: secretFile }));
}
