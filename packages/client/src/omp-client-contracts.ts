import type { PairOkFrame, RequestId, Cursor, ServerFrame } from "@t4-code/protocol";
import type { ProjectionStore } from "./projection.ts";
import type { OmpClientMessage, OmpPairOk, OmpProtocolProvider, OmpResponse } from "./omp-protocol-provider.ts";
import type { OmpProtocolProviderRegistry } from "./omp-protocol-provider-registry.ts";


export type OmpClientState =
  | "idle"
  | "connecting"
  | "handshaking"
  | "pairing"
  | "ready"
  | "reconnect-wait"
  | "closing"
  | "closed"
  | "fatal";

export type ClientErrorCode =
  | "transport" | "protocol" | "auth" | "capability" | "invalid_state"
  | "timeout" | "aborted" | "closed" | "outcome_unknown" | "desync" | "storage";

export interface OmpClientErrorOptions {
  code: ClientErrorCode;
  message: string;
  retryable?: boolean;
  metadata?: Readonly<Record<string, string | number | boolean>>;
}

/** Public errors never contain endpoint, token, or stack data. */
export class OmpClientError extends Error {
  readonly code: ClientErrorCode;
  readonly retryable: boolean;
  readonly metadata: Readonly<Record<string, string | number | boolean>> | undefined;
  constructor(options: OmpClientErrorOptions) {
    super(options.message);
    this.name = "OmpClientError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.metadata = options.metadata;
    Object.defineProperty(this, "stack", { configurable: true, enumerable: false, value: undefined, writable: false });
  }
  toJSON(): Record<string, unknown> {
    return { code: this.code, message: this.message, retryable: this.retryable, ...(this.metadata === undefined ? {} : { metadata: this.metadata }) };
  }
}

export type Unsubscribe = () => void;
export interface OmpTransport {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string | Uint8Array) => void): Unsubscribe;
  onClose(listener: (code?: number, reason?: string) => void): Unsubscribe;
  onError(listener: (error: unknown) => void): Unsubscribe;
}
export type OmpTransportFactory = () => OmpTransport | Promise<OmpTransport>;
export interface CursorRecord { hostId: string; sessionId: string; cursor: Cursor; }
export interface CursorStore {
  load(): CursorRecord[] | readonly CursorRecord[] | Promise<CursorRecord[] | readonly CursorRecord[]>;
  save(record: CursorRecord): void | Promise<void>;
}
export interface Clock { now(): number; }
export interface TimerScheduler { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
export interface IdFactory { next(kind: "request" | "command" | "ping"): string; }
export interface OmpClientOptions {
  transport: OmpTransportFactory;
  /** Concrete wire implementation. Defaults to the pinned omp-app/1 provider. */
  protocolProvider?: OmpProtocolProvider;
  /** Select a provider from a registry without exposing its wire implementation. */
  protocolProviderId?: string;
  protocolProviderRegistry?: OmpProtocolProviderRegistry;
  hostId?: string; expectedHostId?: string;
  client?: { name: string; version: string; build: string; platform: string };
  requestedFeatures?: readonly string[];
  /** One-shot fallback for hosts that reject a hello containing newer additive features. */
  compatibilityRequestedFeatures?: readonly string[];
  requiredFeatures?: readonly string[]; capabilities?: readonly string[];
  authentication?: () => { deviceId: string; deviceToken: string } | undefined;
  cursorStore?: CursorStore; projection?: ProjectionStore; clock?: Clock; timers?: TimerScheduler; ids?: IdFactory;
  random?: () => number; reconnect?: { baseMs?: number; maxMs?: number };
  heartbeat?: { intervalMs?: number; timeoutMs?: number }; handshakeTimeoutMs?: number; commandTimeoutMs?: number;
  /** Maximum inbound-idle time before a foreground wake replaces a possibly stale socket. */
  wakeStaleAfterMs?: number;
  maxPending?: number; privilegedPairResult?: (result: OmpPairOk) => void | Promise<void>;
}
export interface OmpStateSnapshot {
  state: OmpClientState; generation: number; attempt: number; hostId?: string; epoch?: string; cursor?: Cursor;
  authentication?: "local" | "pairing-required" | "paired"; desynced: boolean;
}
export interface OmpResourceSnapshot { timers: number; socket: boolean; socketHandlers: number; pending: number; cursorSaves: number; listeners: number; }
export interface CommandIntent { hostId: string; sessionId?: string; command: string; expectedRevision?: string; confirmationId?: string; args?: Record<string, unknown>; }
export interface CommandOptions { signal?: AbortSignal; timeoutMs?: number; }
export interface ConfirmIntent { confirmationId: string; commandId: string; hostId: string; sessionId?: string; decision: "approve" | "deny"; }
export interface PairStartIntent { code: string; deviceId: string; deviceName: string; platform: string; requestedCapabilities: readonly string[]; }
export interface TerminalInputIntent { hostId: string; sessionId: string; terminalId: string; data: string; encoding?: "utf8" | "base64"; }
export interface TerminalResizeIntent { hostId: string; sessionId: string; terminalId: string; cols: number; rows: number; }
export interface TerminalCloseIntent { hostId: string; sessionId: string; terminalId: string; reason?: string; }
/** Pair credentials never cross this public subscription boundary. */
export type PublicServerFrame = Exclude<ServerFrame, PairOkFrame>;

export const MAX_SAVED = 128;
export const MAX_PENDING = 256;
export const MAX_INBOUND_FRAMES = 128;
export const MAX_INBOUND_BYTES = 4 * 1024 * 1024;
export const noop = (): void => undefined;
export function isTerminalState(state: OmpClientState): boolean { return state === "closed" || state === "closing" || state === "fatal"; }
export function freeze<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
export function sessionKey(host: string, session: string): string { return `${host}\u0000${session}`; }
export function boundedMetadata(value: Record<string, string | number | boolean>): Readonly<Record<string, string | number | boolean>> {
  const output: Record<string, string | number | boolean> = {};
  for (const [name, item] of Object.entries(value).slice(0, 8)) output[name.slice(0, 64)] = typeof item === "string" ? item.slice(0, 256) : item;
  return freeze(output);
}
export class DefaultTimers implements TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown { return globalThis.setTimeout(callback, delayMs); }
  clearTimeout(handle: unknown): void { if (typeof handle === "number") globalThis.clearTimeout(handle); else globalThis.clearTimeout(handle as NodeJS.Timeout); }
}
export class DefaultClock implements Clock { now(): number { return Date.now(); } }
let fallbackIdNamespace = 0;
function createIdNamespace(): string {
  try {
    const cryptography = globalThis.crypto;
    if (typeof cryptography?.randomUUID === "function") return cryptography.randomUUID();
    if (typeof cryptography?.getRandomValues === "function") {
      const words = cryptography.getRandomValues(new Uint32Array(4));
      return Array.from(words, (word) => word.toString(36)).join("-");
    }
  } catch {
    // Best-effort fallback below keeps unsupported runtimes usable.
  }
  fallbackIdNamespace += 1;
  return `fallback-${Date.now().toString(36)}-${fallbackIdNamespace.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
export class DefaultIds implements IdFactory {
  private readonly namespace = createIdNamespace();
  private value = 0;
  next(kind: "request" | "command" | "ping"): string {
    this.value += 1;
    return `client-${this.namespace}-${kind}-${this.value.toString(36)}`;
  }
}

export type PendingResult = OmpResponse | OmpPairOk;
export type PendingMessage = Extract<OmpClientMessage, { kind: "command" | "confirm" | "pair-start" }>;
export interface Pending {
  requestId: RequestId;
  commandId?: string;
  message: PendingMessage;
  resolve: (frame: PendingResult) => void;
  reject: (error: OmpClientError) => void;
  timer?: { active: boolean; handle: unknown };
  abort?: Unsubscribe;
  handedToTransport: boolean;
  kind: "command" | "confirm" | "pair" | "attach";
  intent?: CommandIntent;
}
export interface ConnectWaiter { resolve: () => void; reject: (error: OmpClientError) => void; }
