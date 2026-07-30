export interface PairLinkEvent {
  readonly hostHint: string;
  readonly code: string;
  readonly issuedAt: number;
}

export type PendingPair = PairLinkEvent;

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CODE = /^\d{6}$/u;

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
  const allowed = new Set(["hostHint", "code", "issuedAt"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("unknown key");
  const hostHint = decodeText(item.hostHint, "hostHint", 128);
  const code = decodeText(item.code, "code", 6);
  if (!HOST.test(hostHint) || !CODE.test(code)) throw new Error("invalid pair link");
  if (typeof item.issuedAt !== "number" || !Number.isFinite(item.issuedAt) || item.issuedAt < 0) {
    throw new Error("invalid pair link issuedAt");
  }
  return Object.freeze({ hostHint, code, issuedAt: item.issuedAt });
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
  if (segments.length !== 2) return null;
  try {
    return decodePairLinkEvent({ hostHint: segments[0], code: segments[1], issuedAt });
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
    const index = this.values.findIndex((item) => item.hostHint === decoded.hostHint);
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
