import { decodeAuthentication } from "@t4-code/protocol";

export const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;

export interface RemoteCredentials {
  readonly deviceId: string;
  readonly deviceToken: string;
  readonly tlsFingerprint?: string;
}

export function normalizeRemoteEndpoint(input: string): string {
  const endpoint = new URL(input);
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  )
    throw new Error("remote endpoint must be credential-free wss");
  if (!endpoint.pathname.endsWith("/v1/ws"))
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, "")}/v1/ws`;
  return endpoint.href;
}

export function parseRemoteCredentials(text: string): RemoteCredentials {
  if (Buffer.byteLength(text, "utf8") > MAX_CREDENTIAL_FILE_BYTES)
    throw new Error("credential file exceeds byte limit");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("credential file must contain an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["deviceId", "deviceToken", "tlsFingerprint"]);
  if (Object.keys(input).some((key) => !allowed.has(key)))
    throw new Error("credential file contains unknown fields");
  const authentication = decodeAuthentication({
    deviceId: input.deviceId,
    deviceToken: input.deviceToken,
  });
  if (
    input.tlsFingerprint !== undefined &&
    (typeof input.tlsFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(input.tlsFingerprint))
  )
    throw new Error("TLS fingerprint must be lowercase SHA-256");
  return {
    ...authentication,
    ...(typeof input.tlsFingerprint === "string" ? { tlsFingerprint: input.tlsFingerprint } : {}),
  };
}
