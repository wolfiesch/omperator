export interface PairLinkEvent {
  readonly hostHint: string;
  readonly endpoint: string;
  readonly tlsFingerprint?: string;
  readonly code: string;
  readonly issuedAt: number;
}

export type PendingPair = PairLinkEvent;

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CODE = /^\d{6}$/u;
const FINGERPRINT = /^[0-9a-f]{64}$/u;

function decodeText(value: unknown, name: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new Error(`invalid ${name}`);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) throw new Error(`invalid ${name}`);
  }
  return value;
}

export function decodePairLinkEvent(value: unknown): PairLinkEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid pair link");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid pair link");
  const item = value as Record<string, unknown>;
  const allowed = new Set(["hostHint", "endpoint", "tlsFingerprint", "code", "issuedAt"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("unknown key");
  const hostHint = decodeText(item.hostHint, "hostHint", 128);
  const code = decodeText(item.code, "code", 6);
  const endpoint = decodeText(item.endpoint, "endpoint", 2048);
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("invalid pair link endpoint");
  }
  const tlsFingerprint =
    item.tlsFingerprint === undefined
      ? undefined
      : decodeText(item.tlsFingerprint, "tlsFingerprint", 64);
  if (
    !HOST.test(hostHint) ||
    !CODE.test(code) ||
    (parsedEndpoint.protocol !== "ws:" && parsedEndpoint.protocol !== "wss:") ||
    parsedEndpoint.hostname !== hostHint ||
    parsedEndpoint.pathname !== "/v1/ws" ||
    parsedEndpoint.username ||
    parsedEndpoint.password ||
    parsedEndpoint.search ||
    parsedEndpoint.hash ||
    (tlsFingerprint !== undefined && !FINGERPRINT.test(tlsFingerprint)) ||
    (parsedEndpoint.protocol === "ws:" && tlsFingerprint !== undefined)
  ) throw new Error("invalid pair link");
  if (typeof item.issuedAt !== "number" || !Number.isFinite(item.issuedAt) || item.issuedAt < 0) {
    throw new Error("invalid pair link issuedAt");
  }
  return Object.freeze({
    hostHint,
    endpoint,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    code,
    issuedAt: item.issuedAt,
  });
}

function decodePayload(value: string): unknown {
  if (!/^[A-Za-z0-9_-]{1,4096}$/u.test(value)) throw new Error("invalid pair payload");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export function parsePairDeepLink(value: string, issuedAt = Date.now()): PendingPair | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "t4-code:" ||
    url.hostname !== "pair" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 1) return null;
  try {
    const payload = decodePayload(segments[0]!) as Record<string, unknown>;
    if (payload.version !== 1 || Object.keys(payload).some((key) => !["version", "hostHint", "endpoint", "tlsFingerprint", "code"].includes(key)))
      return null;
    const { version: _version, ...event } = payload;
    return decodePairLinkEvent({ ...event, issuedAt });
  } catch {
    return null;
  }
}

export class PendingPairQueue {
  private readonly values: PendingPair[] = [];
  private readonly capacity: number;

  constructor(capacity = 8) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("invalid pending pair capacity");
    }
    this.capacity = capacity;
  }

  push(value: PendingPair): void {
    const decoded = decodePairLinkEvent(value);
    const index = this.values.findIndex((item) => item.endpoint === decoded.endpoint);
    if (index >= 0) this.values.splice(index, 1);
    this.values.push(decoded);
    while (this.values.length > this.capacity) this.values.shift();
  }

  drain(): readonly PendingPair[] {
    return Object.freeze(this.values.splice(0));
  }

  size(): number {
    return this.values.length;
  }
}
