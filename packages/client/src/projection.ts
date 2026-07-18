import { isCursor } from "@t4-code/protocol";
import type {
  Cursor,
  DurableEntry,
  SessionEvent,
  SessionRef,
  ServerFrame,
} from "@t4-code/protocol";
import { ImmutableSet } from "./immutable-set.ts";
import { ImmutableMap } from "./immutable-map.ts";
import {
  decodeProjectionCacheValue,
  encodeProjectionCache,
  type ProjectionCacheStore,
} from "./projection-cache.ts";
import {
  boundedIdentity,
  safeValue,
  sameSafeValue,
  sanitizeSessionRef,
} from "./projection-sanitize.ts";
import {
  MAX_RETAINED_AGENT_TRANSCRIPTS,
  MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
  MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_SESSION_EVENT_BYTES,
  MAX_RETAINED_SESSION_EVENTS,
  MAX_RETAINED_SESSION_EVENTS_BYTES,
  MAX_RETAINED_TRANSCRIPT_BYTES,
  MAX_RETAINED_TRANSCRIPT_ENTRIES,
  MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  appendRetainedDurableEntry,
  appendRetainedValue,
  retainDurableEntries,
  sanitizeRetainedRecord,
} from "./transcript-retention.ts";
import type { PublicOmpServerEvent } from "./omp-protocol-provider.ts";

export type ProjectionFrame = Exclude<ServerFrame, Extract<ServerFrame, { type: "pair.ok" }>>;
type ProjectionEventFrameFromEvent<Event extends PublicOmpServerEvent> = Event extends PublicOmpServerEvent
  ? Readonly<{ type: Event["kind"] } & Event["payload"]>
  : never;
export type ProjectionEventFrame = ProjectionEventFrameFromEvent<PublicOmpServerEvent>;
type ProjectionInputFrame = ProjectionFrame | ProjectionEventFrame;
type ProjectionInput<Kind extends ProjectionInputFrame["type"]> = Extract<ProjectionInputFrame, { type: Kind }>;
type ProjectionAgentFrame = ProjectionInput<"agent">;
type ProjectionAgentTranscriptFrame = ProjectionInput<"agent.transcript">;
type ProjectionAuditFrame = ProjectionInput<"audit">;
type ProjectionConfirmationFrame = ProjectionInput<"confirmation">;
type ProjectionFileFrame = ProjectionInput<"files">;
type ProjectionGapFrame = ProjectionInput<"gap">;
type ProjectionLiveEventFrame = ProjectionInput<"event">;
type ProjectionResultFrame = ProjectionInput<"response">;
type ProjectionReviewFrame = ProjectionInput<"review">;
export type ProjectionFreshness = "fresh" | "catching-up" | "cached";

export interface TerminalProjection {
  readonly terminalId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly closed: boolean;
}

export interface ResultProjection {
  readonly requestId: string;
  readonly commandId?: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface AgentTranscriptProjection {
  readonly entries: readonly DurableEntry[];
  readonly entryIds: ReadonlySet<string>;
  readonly cursor: Cursor;
  readonly revision: string;
  readonly freshness: ProjectionFreshness;
  readonly historyTruncated?: boolean;
}

export interface SessionProjection {
  readonly hostId: string;
  readonly sessionId: string;
  readonly ref?: SessionRef;
  readonly entries: readonly DurableEntry[];
  readonly events: readonly ProjectionLiveEventFrame[];
  readonly agents: ReadonlyMap<string, ProjectionAgentFrame>;
  readonly agentTranscripts: ReadonlyMap<string, AgentTranscriptProjection>;
  readonly terminals: ReadonlyMap<string, TerminalProjection>;
  readonly files: ReadonlyMap<string, ProjectionFileFrame>;
  readonly reviews: ReadonlyMap<string, ProjectionReviewFrame>;
  readonly audit: readonly ProjectionAuditFrame[];
  readonly confirmations: ReadonlyMap<string, ProjectionConfirmationFrame>;
  readonly results: ReadonlyMap<string, ResultProjection>;
  readonly revision?: string;
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  /**
   * Local receive order of the newest accepted session event. This is an
   * in-memory ordering fence only; cache restore intentionally resets it.
   */
  readonly transcriptEventArrivalOrdinal: number;
  /**
   * Local receive order of the newest accepted event that unconditionally
   * changes turn/context-maintenance lifecycle. Inspector-only events do not
   * advance this fence, and cache/recovery deliberately resets it.
   */
  readonly contextMaintenanceEventArrivalOrdinal: number;
  readonly gap?: ProjectionGapFrame | undefined;
  readonly historyTruncated?: boolean;
  readonly entryIds: ReadonlySet<string>;
}

export interface SessionIndexMetadata {
  readonly totalCount: number;
  readonly truncated: boolean;
}

export interface ProjectionSnapshot {
  readonly version: 1;
  /** Warm session projections. This map is bounded to eight entries. */
  readonly sessions: ReadonlyMap<string, SessionProjection>;
  readonly activeSessionKey?: string | undefined;
  readonly sessionIndex: ReadonlyMap<string, SessionRef>;
  /** Inventory counts are keyed by host and remain bounded with the session index. */
  readonly sessionIndexMetadata: ReadonlyMap<string, SessionIndexMetadata>;
  /** Local receive order of the newest authoritative ref for each session. */
  readonly sessionRefArrivalOrdinals: ReadonlyMap<string, number>;
  /** Session-list delta cursors are independent from transcript cursors. */
  readonly sessionDeltaCursors: ReadonlyMap<string, Cursor>;
  readonly lru: readonly string[];
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  /** Monotonic local receive order for cross-domain session/ref comparison. */
  readonly arrivalOrdinal: number;
}

export interface ProjectionOptions {
  readonly maxWarmSessions?: number;
  readonly maxIndexedSessions?: number;
  readonly maxEntries?: number;
  readonly maxTranscriptBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxEvents?: number;
  readonly maxEventsBytes?: number;
  readonly maxEventBytes?: number;
  readonly maxAudit?: number;
  readonly maxAgentTranscripts?: number;
  readonly maxAgentTranscriptEntries?: number;
  readonly maxAgentTranscriptBytes?: number;
  /** Maximum retained terminal projections per warm session. */
  readonly maxTerminals?: number;
  /** Aggregate UTF-8 bytes retained by terminal ids and output in one warm session. */
  readonly maxTerminalBytes?: number;
  /** UTF-8 bytes retained by one terminal id and its stdout/stderr. */
  readonly maxTerminalBytesPerTerminal?: number;
  /** Maximum retained file projections per warm session. */
  readonly maxFiles?: number;
  /** Aggregate UTF-8 bytes retained by file paths and content in one warm session. */
  readonly maxFilesBytes?: number;
  /** UTF-8 bytes retained by one file path and its content. */
  readonly maxFileBytes?: number;
}

export interface ProjectionSubscription {
  (snapshot: ProjectionSnapshot, input?: ProjectionFrame | PublicOmpServerEvent): void;
}

export const MAX_INDEXED_SESSION_REFS = 1000;
export const MAX_RETAINED_TERMINALS = 64;
export const MAX_RETAINED_TERMINAL_BYTES = 1024 * 1024;
export const MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL = 256 * 1024;
export const MAX_RETAINED_FILES = 256;
export const MAX_RETAINED_FILES_BYTES = 4 * 1024 * 1024;
export const MAX_RETAINED_FILE_BYTES = 768 * 1024;
const DEFAULT_OPTIONS: Required<ProjectionOptions> = {
  maxWarmSessions: 8,
  maxIndexedSessions: MAX_INDEXED_SESSION_REFS,
  maxEntries: MAX_RETAINED_TRANSCRIPT_ENTRIES,
  maxTranscriptBytes: MAX_RETAINED_TRANSCRIPT_BYTES,
  maxEntryBytes: MAX_RETAINED_TRANSCRIPT_ENTRY_BYTES,
  maxEvents: MAX_RETAINED_SESSION_EVENTS,
  maxEventsBytes: MAX_RETAINED_SESSION_EVENTS_BYTES,
  maxEventBytes: MAX_RETAINED_SESSION_EVENT_BYTES,
  maxAudit: 256,
  maxAgentTranscripts: MAX_RETAINED_AGENT_TRANSCRIPTS,
  maxAgentTranscriptEntries: MAX_RETAINED_AGENT_TRANSCRIPT_ENTRIES,
  maxAgentTranscriptBytes: MAX_RETAINED_AGENT_TRANSCRIPT_BYTES,
  maxTerminals: MAX_RETAINED_TERMINALS,
  maxTerminalBytes: MAX_RETAINED_TERMINAL_BYTES,
  maxTerminalBytesPerTerminal: MAX_RETAINED_TERMINAL_BYTES_PER_TERMINAL,
  maxFiles: MAX_RETAINED_FILES,
  maxFilesBytes: MAX_RETAINED_FILES_BYTES,
  maxFileBytes: MAX_RETAINED_FILE_BYTES,
};
const EMPTY_MAP: ReadonlyMap<string, never> = new ImmutableMap<string, never>();
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
/** Immutable projection values make exact byte totals safe to memoize by identity. */
const TERMINAL_PROJECTION_BYTES = new WeakMap<TerminalProjection, number>();
const FILE_PROJECTION_BYTES = new WeakMap<ProjectionFileFrame, number>();

function positiveOption(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveProjectionOptions(options: ProjectionOptions): Required<ProjectionOptions> {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  return {
    ...merged,
    maxTerminals: positiveOption(options.maxTerminals, DEFAULT_OPTIONS.maxTerminals),
    maxTerminalBytes: positiveOption(
      options.maxTerminalBytes,
      DEFAULT_OPTIONS.maxTerminalBytes,
    ),
    maxTerminalBytesPerTerminal: positiveOption(
      options.maxTerminalBytesPerTerminal,
      DEFAULT_OPTIONS.maxTerminalBytesPerTerminal,
    ),
    maxFiles: positiveOption(options.maxFiles, DEFAULT_OPTIONS.maxFiles),
    maxFilesBytes: positiveOption(options.maxFilesBytes, DEFAULT_OPTIONS.maxFilesBytes),
    maxFileBytes: positiveOption(options.maxFileBytes, DEFAULT_OPTIONS.maxFileBytes),
  };
}

function key(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}
function freezeArray<T>(value: T[]): readonly T[] {
  return Object.freeze(value);
}
function appendBounded<T>(items: readonly T[], item: T, max: number): readonly T[] {
  const next =
    items.length >= max ? [...items.slice(items.length - max + 1), item] : [...items, item];
  return freezeArray(next);
}
function boundedUniqueEntries(
  entries: readonly DurableEntry[],
  max: number,
  maxBytes: number,
  maxEntryBytes: number,
): {
  readonly entries: readonly DurableEntry[];
  readonly entryIds: ReadonlySet<string>;
  readonly truncated: boolean;
} {
  const bounded = retainDurableEntries(entries, {
    maxEntries: max,
    maxBytes,
    maxEntryBytes,
  });
  return {
    entries: bounded.entries,
    entryIds: new ImmutableSet(bounded.entries.map((entry) => String(entry.id))),
    truncated: bounded.truncated,
  };
}
function agentTranscriptProjection(
  previous: AgentTranscriptProjection | undefined,
  frame: ProjectionAgentTranscriptFrame,
  maxEntries: number,
  maxBytes: number,
  maxEntryBytes: number,
): AgentTranscriptProjection | undefined {
  const cursor = Object.freeze({ ...frame.cursor });
  const epochChanged = previous !== undefined && previous.cursor.epoch !== cursor.epoch;
  const recoveringCachedBaseline = previous?.freshness === "cached";
  if (
    previous !== undefined &&
    !epochChanged &&
    !recoveringCachedBaseline &&
    cursor.seq <= previous.cursor.seq
  ) {
    return undefined;
  }

  const contiguous =
    previous !== undefined &&
    !epochChanged &&
    !recoveringCachedBaseline &&
    cursor.seq === previous.cursor.seq + 1;
  const source = contiguous ? [...previous.entries, ...frame.entries] : frame.entries;
  const bounded = boundedUniqueEntries(source, maxEntries, maxBytes, maxEntryBytes);
  return Object.freeze({
    entries: bounded.entries,
    entryIds: bounded.entryIds,
    cursor,
    revision: String(frame.revision),
    freshness: "fresh",
    ...(bounded.truncated || (contiguous && previous.historyTruncated === true)
      ? { historyTruncated: true }
      : {}),
  });
}
function immutableMap<K, V>(entries?: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}
function mapWith<K, V>(map: ReadonlyMap<K, V>, itemKey: K, value: V, max = 256): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(itemKey, value);
  while (next.size > max) next.delete(next.keys().next().value!);
  return immutableMap(next);
}
function mapWithout<K, V>(map: ReadonlyMap<K, V>, itemKey: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(itemKey);
  return immutableMap(next);
}

function utf8Bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

/** Keep a valid UTF-8 suffix without splitting a multi-byte code point. */
function retainedUtf8Tail(value: string, maxBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let offset = Math.max(0, encoded.byteLength - Math.max(0, Math.floor(maxBytes)));
  while (offset < encoded.byteLength && (encoded[offset]! & 0xc0) === 0x80) offset += 1;
  return UTF8_DECODER.decode(encoded.subarray(offset));
}

/** Keep a valid UTF-8 prefix without splitting a multi-byte code point. */
function retainedUtf8Head(value: string, maxBytes: number): string {
  const encoded = UTF8_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = Math.min(encoded.byteLength, Math.max(0, Math.floor(maxBytes)));
  while (end > 0 && end < encoded.byteLength && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return UTF8_DECODER.decode(encoded.subarray(0, end));
}

function terminalProjectionBytes(terminal: TerminalProjection): number {
  const cached = TERMINAL_PROJECTION_BYTES.get(terminal);
  if (cached !== undefined) return cached;
  const bytes =
    utf8Bytes(terminal.terminalId) + utf8Bytes(terminal.stdout) + utf8Bytes(terminal.stderr);
  TERMINAL_PROJECTION_BYTES.set(terminal, bytes);
  return bytes;
}

function trimTerminalProjection(
  terminal: TerminalProjection,
  maxBytes: number,
  preferredStream: "stdout" | "stderr" = "stdout",
): TerminalProjection {
  if (terminalProjectionBytes(terminal) <= maxBytes) return terminal;
  const outputBudget = Math.max(0, maxBytes - utf8Bytes(terminal.terminalId));
  const secondaryStream = preferredStream === "stdout" ? "stderr" : "stdout";
  const preferred = retainedUtf8Tail(terminal[preferredStream], outputBudget);
  const secondary = retainedUtf8Tail(
    terminal[secondaryStream],
    Math.max(0, outputBudget - utf8Bytes(preferred)),
  );
  return Object.freeze({
    ...terminal,
    [preferredStream]: preferred,
    [secondaryStream]: secondary,
  });
}

/**
 * Terminal map iteration order is receive-recency order. Protect the current
 * terminal, shed completed terminals first, then the least-recent open ones.
 */
function retainTerminalProjection(
  terminals: ReadonlyMap<string, TerminalProjection>,
  terminalId: string,
  terminal: TerminalProjection,
  options: Required<ProjectionOptions>,
  preferredStream: "stdout" | "stderr" = "stdout",
): ReadonlyMap<string, TerminalProjection> {
  const next = new Map(terminals);
  let totalBytes = 0;
  for (const value of next.values()) totalBytes += terminalProjectionBytes(value);
  const replaced = next.get(terminalId);
  if (replaced !== undefined) totalBytes -= terminalProjectionBytes(replaced);
  next.delete(terminalId);
  const perTerminalLimit = Math.min(
    options.maxTerminalBytesPerTerminal,
    options.maxTerminalBytes,
  );
  const retained = trimTerminalProjection(
    terminal,
    perTerminalLimit,
    preferredStream,
  );
  const retainedBytes = terminalProjectionBytes(retained);
  // The id is required to address a terminal. If it cannot fit by itself,
  // dropping the projection is the only way to honor an absolute item budget.
  if (retainedBytes <= perTerminalLimit) {
    next.set(terminalId, retained);
    totalBytes += retainedBytes;
  }
  while (next.size > options.maxTerminals) {
    const completed = [...next].find(([id, value]) => id !== terminalId && value.closed)?.[0];
    const oldestOther = [...next.keys()].find((id) => id !== terminalId);
    const evicted = completed ?? oldestOther ?? next.keys().next().value;
    if (evicted === undefined) break;
    totalBytes -= terminalProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  while (totalBytes > options.maxTerminalBytes) {
    const completed = [...next].find(([id, value]) => id !== terminalId && value.closed)?.[0];
    const oldestOther = [...next.keys()].find((id) => id !== terminalId);
    const evicted = completed ?? oldestOther;
    if (evicted === undefined) break;
    totalBytes -= terminalProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  const current = next.get(terminalId);
  if (current !== undefined && totalBytes > options.maxTerminalBytes) {
    const trimmed = trimTerminalProjection(current, options.maxTerminalBytes, preferredStream);
    totalBytes += terminalProjectionBytes(trimmed) - terminalProjectionBytes(current);
    next.set(terminalId, trimmed);
  }
  if (totalBytes > options.maxTerminalBytes) next.delete(terminalId);
  return immutableMap(next);
}

function fileProjectionBytes(file: ProjectionFileFrame): number {
  const cached = FILE_PROJECTION_BYTES.get(file);
  if (cached !== undefined) return cached;
  const bytes = utf8Bytes(file.path) + (file.content === undefined ? 0 : utf8Bytes(file.content));
  FILE_PROJECTION_BYTES.set(file, bytes);
  return bytes;
}

function fileWithoutContent(file: ProjectionFileFrame): ProjectionFileFrame {
  const { content: _content, ...metadata } = file;
  return Object.freeze({ ...metadata, truncated: true });
}

function trimFileProjection(file: ProjectionFileFrame, maxBytes: number): ProjectionFileFrame {
  if (fileProjectionBytes(file) <= maxBytes || file.content === undefined) return file;
  const content = retainedUtf8Head(file.content, Math.max(0, maxBytes - utf8Bytes(file.path)));
  return Object.freeze({ ...file, content, truncated: true });
}

/** Keep recent content first while retaining older paths as useful tree metadata. */
function retainFileProjection(
  files: ReadonlyMap<string, ProjectionFileFrame>,
  path: string,
  file: ProjectionFileFrame,
  options: Required<ProjectionOptions>,
): ReadonlyMap<string, ProjectionFileFrame> {
  const next = new Map(files);
  let totalBytes = 0;
  for (const value of next.values()) totalBytes += fileProjectionBytes(value);
  const replaced = next.get(path);
  if (replaced !== undefined) totalBytes -= fileProjectionBytes(replaced);
  next.delete(path);
  const perFileLimit = Math.min(options.maxFileBytes, options.maxFilesBytes);
  const retained = trimFileProjection(file, perFileLimit);
  const retainedBytes = fileProjectionBytes(retained);
  // A path is required file metadata. If the path alone exceeds the item
  // budget, omit the projection instead of silently violating the contract.
  if (retainedBytes <= perFileLimit) {
    next.set(path, retained);
    totalBytes += retainedBytes;
  }
  while (next.size > options.maxFiles) {
    const evicted = next.keys().next().value;
    if (evicted === undefined) break;
    totalBytes -= fileProjectionBytes(next.get(evicted)!);
    next.delete(evicted);
  }
  while (totalBytes > options.maxFilesBytes) {
    const oldestWithContent = [...next].find(
      ([candidatePath, candidate]) =>
        candidatePath !== path && candidate.content !== undefined,
    );
    if (oldestWithContent === undefined) break;
    const metadata = fileWithoutContent(oldestWithContent[1]);
    totalBytes += fileProjectionBytes(metadata) - fileProjectionBytes(oldestWithContent[1]);
    next.set(oldestWithContent[0], metadata);
  }
  const current = next.get(path);
  if (current !== undefined && totalBytes > options.maxFilesBytes) {
    const otherBytes = totalBytes - fileProjectionBytes(current);
    const trimmed = trimFileProjection(
      current,
      Math.max(0, options.maxFilesBytes - otherBytes),
    );
    totalBytes += fileProjectionBytes(trimmed) - fileProjectionBytes(current);
    next.set(path, trimmed);
  }
  while (totalBytes > options.maxFilesBytes) {
    const oldestOther = [...next.keys()].find((candidatePath) => candidatePath !== path);
    if (oldestOther === undefined) break;
    totalBytes -= fileProjectionBytes(next.get(oldestOther)!);
    next.delete(oldestOther);
  }
  if (totalBytes > options.maxFilesBytes) next.delete(path);
  return immutableMap(next);
}

function retainRestoredSessionResources(
  session: SessionProjection,
  options: Required<ProjectionOptions>,
): SessionProjection {
  let terminals = immutableMap<string, TerminalProjection>();
  for (const [terminalId, terminal] of session.terminals) {
    terminals = retainTerminalProjection(terminals, terminalId, terminal, options);
  }
  let files = immutableMap<string, ProjectionFileFrame>();
  for (const [path, file] of session.files) {
    files = retainFileProjection(files, path, file, options);
  }
  return Object.freeze({ ...session, terminals, files });
}
function confirmationsAfterResponse(
  confirmations: ReadonlyMap<string, ProjectionConfirmationFrame>,
  frame: ProjectionResultFrame,
): ReadonlyMap<string, ProjectionConfirmationFrame> {
  const invalid = frame.error?.code === "confirmation_invalid";
  let changed = false;
  const next = new Map<string, ProjectionConfirmationFrame>();
  for (const [confirmationKey, challenge] of confirmations) {
    if (String(challenge.commandId) !== String(frame.commandId)) {
      next.set(confirmationKey, challenge);
      continue;
    }
    if (invalid) {
      next.set(confirmationKey, challenge);
      continue;
    }
    changed = true;
  }
  return changed ? immutableMap(next) : confirmations;
}
function initialSession(
  hostId: string,
  sessionId: string,
  freshness: ProjectionFreshness = "fresh",
): SessionProjection {
  return Object.freeze({
    hostId,
    sessionId,
    entries: freezeArray([]),
    events: freezeArray([]),
    agents: EMPTY_MAP,
    agentTranscripts: EMPTY_MAP,
    terminals: EMPTY_MAP,
    files: EMPTY_MAP,
    reviews: EMPTY_MAP,
    audit: freezeArray([]),
    entryIds: new ImmutableSet<string>(),
    confirmations: EMPTY_MAP,
    results: EMPTY_MAP,
    freshness,
    transcriptEventArrivalOrdinal: 0,
    contextMaintenanceEventArrivalOrdinal: 0,
  });
}

export function createProjectionSnapshot(): ProjectionSnapshot {
  return Object.freeze({
    version: 1 as const,
    sessions: immutableMap<string, SessionProjection>(),
    sessionIndex: immutableMap<string, SessionRef>(),
    sessionIndexMetadata: immutableMap<string, SessionIndexMetadata>(),
    sessionRefArrivalOrdinals: immutableMap<string, number>(),
    sessionDeltaCursors: immutableMap<string, Cursor>(),
    lru: freezeArray([]),
    freshness: "fresh" as const,
    arrivalOrdinal: 0,
  });
}

function nextArrivalOrdinal(snapshot: ProjectionSnapshot): number {
  return snapshot.arrivalOrdinal < Number.MAX_SAFE_INTEGER
    ? snapshot.arrivalOrdinal + 1
    : Number.MAX_SAFE_INTEGER;
}

function eventChangesContextMaintenance(event: SessionEvent): boolean {
  return (
    event.type === "compaction.start" ||
    event.type === "compaction.end" ||
    event.type === "turn.start" ||
    event.type === "turn.end"
  );
}

function touch(
  snapshot: ProjectionSnapshot,
  sessionKey: string,
  options: Required<ProjectionOptions>,
): ProjectionSnapshot {
  const existing = snapshot.sessions.get(sessionKey);
  const lru = [...snapshot.lru.filter((item) => item !== sessionKey), sessionKey];
  let sessions = snapshot.sessions;
  if (existing === undefined)
    sessions = mapWith(
      sessions,
      sessionKey,
      initialSession(...(sessionKey.split("\u0000") as [string, string])),
    );
  while (lru.length > options.maxWarmSessions) {
    const evicted = lru.shift();
    if (evicted !== undefined) sessions = mapWithout(sessions, evicted);
  }
  const activeSessionKey =
    snapshot.activeSessionKey !== undefined && lru.includes(snapshot.activeSessionKey)
      ? snapshot.activeSessionKey
      : lru[lru.length - 1];
  return Object.freeze({
    ...snapshot,
    sessions,
    lru: freezeArray(lru),
    ...(activeSessionKey === undefined ? { activeSessionKey: undefined } : { activeSessionKey }),
  });
}
function withSession(
  snapshot: ProjectionSnapshot,
  sessionKey: string,
  update: (session: SessionProjection) => SessionProjection,
  options: Required<ProjectionOptions>,
): ProjectionSnapshot {
  const warmed = touch(snapshot, sessionKey, options);
  const current = warmed.sessions.get(sessionKey)!;
  const updated = update(current);
  if (updated === current) return warmed;
  return Object.freeze({
    ...warmed,
    sessions: mapWith(warmed.sessions, sessionKey, Object.freeze(updated)),
  });
}
function updateRoot(
  snapshot: ProjectionSnapshot,
  frame: { cursor?: Cursor; epoch?: string; freshness?: ProjectionFreshness },
): ProjectionSnapshot {
  return Object.freeze({
    ...snapshot,
    ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
    ...(frame.epoch === undefined ? {} : { epoch: frame.epoch }),
    ...(frame.freshness === undefined ? {} : { freshness: frame.freshness }),
  });
}
function cursorState(session: SessionProjection, cursor: Cursor): "accept" | "duplicate" | "gap" {
  if (session.freshness === "catching-up") return "gap";
  if (session.cursor === undefined) return "accept";
  if (cursor.epoch !== session.cursor.epoch) return "gap";
  if (cursor.seq <= session.cursor.seq) return "duplicate";
  return cursor.seq === session.cursor.seq + 1 ? "accept" : "gap";
}
function sessionDeltaCursorIsStale(previous: Cursor | undefined, cursor: Cursor): boolean {
  return previous !== undefined && previous.epoch === cursor.epoch && cursor.seq <= previous.seq;
}
function mostRecentSessionKey(sessionIndex: ReadonlyMap<string, SessionRef>): string | undefined {
  let selected: { readonly key: string; readonly updatedAt: string } | undefined;
  for (const [sessionKey, ref] of sessionIndex) {
    const updatedAt = String(ref.updatedAt);
    if (
      selected === undefined ||
      updatedAt > selected.updatedAt ||
      (updatedAt === selected.updatedAt && sessionKey < selected.key)
    ) {
      selected = { key: sessionKey, updatedAt };
    }
  }
  return selected?.key;
}
function authoritativeSessionHosts(
  frame: ProjectionInput<"sessions">,
  refs: readonly SessionRef[],
): ReadonlySet<string> {
  const hosts = new Set(refs.map((ref) => String(ref.hostId)));
  const raw = frame as unknown as Record<string, unknown>;
  const frameHost = boundedIdentity(raw.hostId);
  if (frameHost !== undefined) hosts.add(frameHost);
  return hosts;
}
function sessionFrameMetadata(
  frame: ProjectionInput<"sessions">,
  refs: readonly SessionRef[],
  maxIndexedSessions: number,
  hosts: ReadonlySet<string>,
): ReadonlyMap<string, SessionIndexMetadata> {
  const raw = frame as unknown as Record<string, unknown>;
  const totalCount =
    typeof raw.totalCount === "number" &&
    Number.isSafeInteger(raw.totalCount) &&
    raw.totalCount >= 0
      ? raw.totalCount
      : undefined;
  const truncated =
    typeof raw.truncated === "boolean"
      ? raw.truncated
      : totalCount === undefined
        ? refs.length >= maxIndexedSessions
        : totalCount > refs.length;
  return immutableMap(
    [...hosts].map(
      (hostId) =>
        [
          hostId,
          Object.freeze({
            totalCount: totalCount ?? refs.filter((ref) => String(ref.hostId) === hostId).length,
            truncated,
          }),
        ] as const,
    ),
  );
}

function sessionFrameIsComplete(
  frame: ProjectionInput<"sessions">,
  refs: readonly SessionRef[],
  maxIndexedSessions: number,
): boolean {
  const raw = frame as unknown as Record<string, unknown>;
  if (raw.truncated === true) return false;
  if (
    typeof raw.totalCount === "number" &&
    Number.isSafeInteger(raw.totalCount) &&
    raw.totalCount > refs.length
  ) {
    return false;
  }
  return raw.truncated === false || refs.length < maxIndexedSessions;
}

function resultProjection(frame: ProjectionResultFrame): ResultProjection {
  const output: ResultProjection = {
    requestId: String(frame.requestId),
    ...(frame.commandId === undefined ? {} : { commandId: String(frame.commandId) }),
    ok: frame.ok,
    ...(frame.result === undefined ? {} : { result: safeValue(frame.result) }),
    ...(frame.error === undefined
      ? {}
      : { error: Object.freeze({ code: frame.error.code, message: frame.error.message }) }),
  };
  return Object.freeze(output);
}

function attachAcknowledgesCurrentCursor(session: SessionProjection, frame: ProjectionResultFrame): boolean {
  if (
    !frame.ok ||
    frame.command !== "session.attach" ||
    session.cursor === undefined ||
    frame.result === null ||
    typeof frame.result !== "object" ||
    Array.isArray(frame.result)
  ) {
    return false;
  }
  const result = frame.result as Record<string, unknown>;
  if (result.attached !== true || !isCursor(result.cursor)) return false;
  return result.cursor.epoch === session.cursor.epoch && result.cursor.seq === session.cursor.seq;
}

function applyProjectionInput(
  snapshot: ProjectionSnapshot,
  frame: ProjectionInputFrame,
  options: ProjectionOptions = {},
): ProjectionSnapshot {
  const config = resolveProjectionOptions(options);
  switch (frame.type) {
    case "sessions": {
      const arrivalOrdinal = nextArrivalOrdinal(snapshot);
      const refs = frame.sessions
        .slice(0, config.maxIndexedSessions)
        .map((ref) => sanitizeSessionRef(ref))
        .filter((ref): ref is SessionRef => ref !== undefined);
      const authoritativeHosts = authoritativeSessionHosts(frame, refs);
      const incomingKeys = new Set(
        refs.map((ref) => key(String(ref.hostId), String(ref.sessionId))),
      );
      const complete = sessionFrameIsComplete(frame, refs, config.maxIndexedSessions);
      let sessionIndex = snapshot.sessionIndex;
      let sessionRefArrivalOrdinals = snapshot.sessionRefArrivalOrdinals;
      let sessions = snapshot.sessions;
      let sessionDeltaCursors = snapshot.sessionDeltaCursors;
      let activeSessionKey = snapshot.activeSessionKey;
      if (complete) {
        for (const [existingKey, existingRef] of snapshot.sessionIndex) {
          if (!authoritativeHosts.has(String(existingRef.hostId)) || incomingKeys.has(existingKey))
            continue;
          sessionIndex = mapWithout(sessionIndex, existingKey);
          sessionRefArrivalOrdinals = mapWithout(sessionRefArrivalOrdinals, existingKey);
          sessions = mapWithout(sessions, existingKey);
          sessionDeltaCursors = mapWithout(sessionDeltaCursors, existingKey);
          if (activeSessionKey === existingKey) activeSessionKey = undefined;
        }
        for (const [warmKey, warm] of sessions) {
          if (!authoritativeHosts.has(warm.hostId) || incomingKeys.has(warmKey)) continue;
          sessions = mapWithout(sessions, warmKey);
          sessionDeltaCursors = mapWithout(sessionDeltaCursors, warmKey);
          if (activeSessionKey === warmKey) activeSessionKey = undefined;
        }
      }
      const lru = freezeArray(snapshot.lru.filter((sessionKey) => sessions.has(sessionKey)));
      for (const ref of refs) {
        const sessionKey = key(String(ref.hostId), String(ref.sessionId));
        sessionIndex = mapWith(sessionIndex, sessionKey, ref, config.maxIndexedSessions);
        sessionRefArrivalOrdinals = mapWith(
          sessionRefArrivalOrdinals,
          sessionKey,
          arrivalOrdinal,
          config.maxIndexedSessions,
        );
      }
      while (sessionIndex.size > config.maxIndexedSessions) {
        const oldest = sessionIndex.keys().next().value;
        if (oldest === undefined) break;
        sessionIndex = mapWithout(sessionIndex, oldest);
        sessionRefArrivalOrdinals = mapWithout(sessionRefArrivalOrdinals, oldest);
      }
      let sessionIndexMetadata = snapshot.sessionIndexMetadata;
      for (const [hostId, metadata] of sessionFrameMetadata(
        frame,
        refs,
        config.maxIndexedSessions,
        authoritativeHosts,
      )) {
        sessionIndexMetadata = mapWith(
          sessionIndexMetadata,
          hostId,
          metadata,
          config.maxIndexedSessions,
        );
      }
      let next = Object.freeze({
        ...snapshot,
        sessionIndex,
        sessionIndexMetadata,
        sessionRefArrivalOrdinals,
        sessionDeltaCursors,
        sessions,
        lru,
        activeSessionKey,
        arrivalOrdinal,
      });
      const active = activeSessionKey ?? mostRecentSessionKey(sessionIndex);
      if (active !== undefined)
        next = Object.freeze({ ...touch(next, active, config), activeSessionKey: active });
      for (const ref of refs) {
        const refKey = key(String(ref.hostId), String(ref.sessionId));
        if (!next.sessions.has(refKey)) continue;
        const existing = next.sessions.get(refKey)!;
        if (existing.ref !== ref || existing.revision !== String(ref.revision)) {
          next = Object.freeze({
            ...next,
            sessions: mapWith(
              next.sessions,
              refKey,
              Object.freeze({ ...existing, ref, revision: String(ref.revision) }),
            ),
          });
        }
      }
      return updateRoot(Object.freeze({ ...next, cursor: frame.cursor }), {
        cursor: frame.cursor,
        freshness: "fresh",
      });
    }
    case "session.delta": {
      const hostId = boundedIdentity(frame.hostId);
      const frameSessionId = boundedIdentity(frame.sessionId);
      if (hostId === undefined || frameSessionId === undefined) return snapshot;
      const upsert = frame.upsert === undefined ? undefined : sanitizeSessionRef(frame.upsert);
      const remove = frame.remove === undefined ? undefined : boundedIdentity(frame.remove);
      if (frame.upsert !== undefined && upsert === undefined) return snapshot;
      if (
        upsert !== undefined &&
        (String(upsert.hostId) !== hostId || String(upsert.sessionId) !== frameSessionId)
      )
        return snapshot;
      if (upsert === undefined && remove === undefined) return snapshot;
      const ownerKey = key(hostId, frameSessionId);
      const targetKey = key(hostId, upsert === undefined ? remove! : frameSessionId);
      const previousCursor = snapshot.sessionDeltaCursors.get(ownerKey);
      if (sessionDeltaCursorIsStale(previousCursor, frame.cursor)) return snapshot;
      const arrivalOrdinal = nextArrivalOrdinal(snapshot);
      const ownerWarm = snapshot.sessions.get(ownerKey);
      let sessionDeltaCursors = mapWith(
        snapshot.sessionDeltaCursors,
        ownerKey,
        Object.freeze({ ...frame.cursor }),
        config.maxIndexedSessions,
      );
      let sessionIndex = snapshot.sessionIndex;
      let sessionRefArrivalOrdinals = snapshot.sessionRefArrivalOrdinals;
      let sessionIndexMetadata = snapshot.sessionIndexMetadata;
      let sessions = snapshot.sessions;
      let lru = snapshot.lru;
      let activeSessionKey = snapshot.activeSessionKey;
      const existingRef = sessionIndex.get(targetKey);
      if (upsert !== undefined) {
        const canStoreRef =
          existingRef !== undefined || sessionIndex.size < config.maxIndexedSessions;
        if (canStoreRef) {
          sessionRefArrivalOrdinals = mapWith(
            sessionRefArrivalOrdinals,
            targetKey,
            arrivalOrdinal,
            config.maxIndexedSessions,
          );
        }
        if (existingRef === undefined && canStoreRef)
          sessionIndex = mapWith(sessionIndex, targetKey, upsert, config.maxIndexedSessions);
        else if (existingRef !== undefined && !sameSafeValue(existingRef, upsert))
          sessionIndex = mapWith(sessionIndex, targetKey, upsert, config.maxIndexedSessions);
        const metadata = sessionIndexMetadata.get(hostId);
        if (metadata !== undefined && existingRef === undefined && !metadata.truncated)
          sessionIndexMetadata = mapWith(
            sessionIndexMetadata,
            hostId,
            Object.freeze({ ...metadata, totalCount: metadata.totalCount + 1 }),
            config.maxIndexedSessions,
          );
        if (ownerWarm !== undefined) {
          const nextWarm: SessionProjection = Object.freeze({
            ...ownerWarm,
            ref: upsert,
            revision: String(upsert.revision),
          });
          sessions = mapWith(sessions, ownerKey, nextWarm, config.maxWarmSessions);
        }
      } else {
        sessionIndex = mapWithout(sessionIndex, targetKey);
        sessionRefArrivalOrdinals = mapWithout(sessionRefArrivalOrdinals, targetKey);
        sessions = mapWithout(sessions, targetKey);
        lru = freezeArray(lru.filter((item) => item !== targetKey));
        if (activeSessionKey === targetKey) activeSessionKey = lru.at(-1);
        const metadata = sessionIndexMetadata.get(hostId);
        if (metadata !== undefined && existingRef !== undefined)
          sessionIndexMetadata = mapWith(
            sessionIndexMetadata,
            hostId,
            Object.freeze({ ...metadata, totalCount: Math.max(0, metadata.totalCount - 1) }),
            config.maxIndexedSessions,
          );
      }
      return Object.freeze({
        ...snapshot,
        sessionIndex,
        sessionIndexMetadata,
        sessionRefArrivalOrdinals,
        sessionDeltaCursors,
        sessions,
        lru,
        activeSessionKey,
        arrivalOrdinal,
      });
    }
    case "snapshot": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      const retained = retainDurableEntries(frame.entries, {
        maxEntries: config.maxEntries,
        maxBytes: config.maxTranscriptBytes,
        maxEntryBytes: config.maxEntryBytes,
      });
      const entryIds = new ImmutableSet(retained.entries.map((entry) => String(entry.id)));
      const next = withSession(
        snapshot,
        sessionKey,
        (session) => {
          const preservesEventSuffix =
            session.epoch === frame.cursor.epoch &&
            session.freshness === "fresh" &&
            session.gap === undefined;
          return Object.freeze({
            ...session,
            entries: retained.entries,
            entryIds,
            historyTruncated: retained.truncated,
            events: preservesEventSuffix
              ? session.events
              : session.epoch === frame.cursor.epoch
                ? freezeArray(
                    session.events.filter(
                      (event) =>
                        event.event.type === "message.settled" ||
                        event.event.type === "message.discarded",
                    ),
                  )
                : freezeArray([]),
            // Recovery snapshots invalidate the volatile event suffix. Any
            // retained settlement markers remain useful for prompt retirement,
            // but cannot participate in cross-domain activity ordering.
            transcriptEventArrivalOrdinal: preservesEventSuffix
              ? session.transcriptEventArrivalOrdinal
              : 0,
            contextMaintenanceEventArrivalOrdinal: preservesEventSuffix
              ? session.contextMaintenanceEventArrivalOrdinal
              : 0,
            revision: String(frame.revision),
            cursor: frame.cursor,
            epoch: frame.cursor.epoch,
            freshness: "fresh",
            gap: undefined,
          });
        },
        config,
      );
      return Object.freeze({
        ...updateRoot(next, {
          cursor: frame.cursor,
          epoch: frame.cursor.epoch,
          freshness: "fresh",
        }),
        activeSessionKey: next.activeSessionKey ?? sessionKey,
      });
    }
    case "entry":
    case "event": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      const current = snapshot.sessions.get(sessionKey);
      const cursorResult = current === undefined ? "accept" : cursorState(current, frame.cursor);
      if (cursorResult === "duplicate") return snapshot;
      if (cursorResult === "gap")
        return withSession(
          snapshot,
          sessionKey,
          (session) => Object.freeze({ ...session, freshness: "catching-up" }),
          config,
        );
      const eventArrivalOrdinal =
        frame.type === "event" ? nextArrivalOrdinal(snapshot) : snapshot.arrivalOrdinal;
      const next = withSession(
        snapshot,
        sessionKey,
        (session) => {
          if (frame.type === "entry") {
            const entryId = String(frame.entry.id);
            const retiredEvents = freezeArray(
              session.events.filter(
                (event) =>
                  event.event.type === "message.settled" ||
                  String(event.event.entryId ?? "") !== entryId,
              ),
            );
            if (session.entryIds.has(entryId)) {
              return Object.freeze({
                ...session,
                events: retiredEvents,
                revision: String(frame.revision),
                cursor: frame.cursor,
                epoch: frame.cursor.epoch,
              });
            }
            const retained = appendRetainedDurableEntry(session.entries, frame.entry, {
              maxEntries: config.maxEntries,
              maxBytes: config.maxTranscriptBytes,
              maxEntryBytes: config.maxEntryBytes,
            });
            const entryIds = new ImmutableSet(retained.entries.map((entry) => String(entry.id)));
            return Object.freeze({
              ...session,
              entries: retained.entries,
              entryIds,
              events: retiredEvents,
              historyTruncated: session.historyTruncated === true || retained.truncated,
              revision: String(frame.revision),
              cursor: frame.cursor,
              epoch: frame.cursor.epoch,
              freshness: "fresh",
              gap: undefined,
            });
          }
          const transientEntryId =
            (frame.event.type === "message.settled" || frame.event.type === "message.discarded") &&
            typeof frame.event.transientEntryId === "string"
              ? frame.event.transientEntryId
              : frame.event.type === "message.discarded" && typeof frame.event.entryId === "string"
                ? frame.event.entryId
                : undefined;
          const retiredEvents =
            transientEntryId === undefined
              ? session.events
              : freezeArray(
                  session.events.filter(
                    (event) => String(event.event.entryId ?? "") !== transientEntryId,
                  ),
                );
          const sanitizedEvent = Object.freeze({
            ...frame,
            event: Object.freeze(
              sanitizeRetainedRecord(frame.event, config.maxEventBytes) as SessionEvent,
            ),
          });
          return Object.freeze({
            ...session,
            events: appendRetainedValue(
              retiredEvents,
              sanitizedEvent,
              config.maxEvents,
              config.maxEventsBytes,
            ),
            cursor: frame.cursor,
            epoch: frame.cursor.epoch,
            freshness: "fresh",
            transcriptEventArrivalOrdinal: eventArrivalOrdinal,
            contextMaintenanceEventArrivalOrdinal: eventChangesContextMaintenance(frame.event)
              ? eventArrivalOrdinal
              : session.contextMaintenanceEventArrivalOrdinal,
            gap: undefined,
          });
        },
        config,
      );
      return frame.type === "event"
        ? Object.freeze({ ...next, arrivalOrdinal: eventArrivalOrdinal })
        : next;
    }
    case "gap": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) => Object.freeze({ ...session, freshness: "catching-up", gap: frame }),
        config,
      );
    }
    case "agent": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) =>
          Object.freeze({
            ...session,
            agents: mapWith(
              session.agents,
              String(frame.agentId),
              Object.freeze({
                ...frame,
                ...(frame.detail === undefined
                  ? {}
                  : { detail: safeValue(frame.detail) as Record<string, unknown> }),
              }),
            ),
          }),
        config,
      );
    }
    case "agent.transcript": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) => {
          const agentId = String(frame.agentId);
          const transcript = agentTranscriptProjection(
            session.agentTranscripts.get(agentId),
            frame,
            config.maxAgentTranscriptEntries,
            config.maxAgentTranscriptBytes,
            config.maxEntryBytes,
          );
          if (transcript === undefined) return session;
          return Object.freeze({
            ...session,
            agentTranscripts: mapWith(
              session.agentTranscripts,
              agentId,
              transcript,
              config.maxAgentTranscripts,
            ),
          });
        },
        config,
      );
    }
    case "terminal": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) => {
          const existing =
            session.terminals.get(String(frame.terminalId)) ??
            Object.freeze({
              terminalId: String(frame.terminalId),
              stdout: "",
              stderr: "",
              closed: false,
            });
          const data = frame.data ?? "";
          const stream =
            frame.stream === "stderr" ? "stderr" : frame.stream === "stdout" ? "stdout" : undefined;
          const text = stream === undefined ? existing.stdout : `${existing[stream]}${data}`;
          const terminal: TerminalProjection = Object.freeze({
            ...existing,
            ...(stream === undefined ? {} : { [stream]: text }),
            ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }),
            ...(stream === undefined || frame.stream === "exit" ? { closed: true } : {}),
          });
          return Object.freeze({
            ...session,
            terminals: retainTerminalProjection(
              session.terminals,
              String(frame.terminalId),
              terminal,
              config,
              stream ?? "stdout",
            ),
          });
        },
        config,
      );
    }
    case "files": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) =>
          Object.freeze({
            ...session,
            files: retainFileProjection(
              session.files,
              frame.path,
              Object.freeze({ ...frame }),
              config,
            ),
          }),
        config,
      );
    }
    case "review": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) =>
          Object.freeze({
            ...session,
            reviews: mapWith(
              session.reviews,
              frame.reviewId,
              Object.freeze({
                ...frame,
                findings: frame.findings.map((item) =>
                  Object.freeze(safeValue(item) as Record<string, unknown>),
                ),
              }),
            ),
          }),
        config,
      );
    }
    case "audit": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) =>
          Object.freeze({
            ...session,
            audit: appendBounded(
              session.audit,
              Object.freeze({
                ...frame,
                ...(frame.detail === undefined
                  ? {}
                  : { detail: Object.freeze(safeValue(frame.detail) as Record<string, unknown>) }),
              }),
              config.maxAudit,
            ),
          }),
        config,
      );
    }
    case "confirmation": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) =>
          Object.freeze({
            ...session,
            confirmations: mapWith(
              session.confirmations,
              String(frame.confirmationId),
              Object.freeze({ ...frame }),
            ),
          }),
        config,
      );
    }
    case "response": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(
        snapshot,
        sessionKey,
        (session) => {
          const attachedAtCurrentCursor = attachAcknowledgesCurrentCursor(session, frame);
          return Object.freeze({
            ...session,
            confirmations: confirmationsAfterResponse(session.confirmations, frame),
            results: mapWith(session.results, String(frame.requestId), resultProjection(frame)),
            ...(attachedAtCurrentCursor ? { freshness: "fresh" as const, gap: undefined } : {}),
          });
        },
        config,
      );
    }
    case "welcome": {
      // A welcome starts a new inventory bootstrap even when the durable
      // session epoch is unchanged. Retain cached/indexed rows for continuity,
      // but do not let their old completeness metadata prove that a route is
      // gone until the host sends the next authoritative sessions frame.
      const sessionIndexMetadata = mapWithout(snapshot.sessionIndexMetadata, String(frame.hostId));
      if (snapshot.epoch === undefined || snapshot.epoch === frame.epoch) {
        return updateRoot(Object.freeze({ ...snapshot, sessionIndexMetadata }), {
          epoch: frame.epoch,
          freshness: "fresh",
        });
      }
      const sessions = immutableMap(
        [...snapshot.sessions.entries()].map(
          ([sessionKey, session]) =>
            [
              sessionKey,
              Object.freeze({
                ...session,
                freshness: "catching-up",
                transcriptEventArrivalOrdinal: 0,
                contextMaintenanceEventArrivalOrdinal: 0,
              }),
            ] as const,
        ),
      );
      return Object.freeze({
        ...snapshot,
        sessionIndexMetadata,
        sessions,
        epoch: frame.epoch,
        freshness: "catching-up",
      });
    }
    default:
      return snapshot;
  }
}

export function applyPublicFrame(
  snapshot: ProjectionSnapshot,
  frame: ProjectionFrame,
  options: ProjectionOptions = {},
): ProjectionSnapshot {
  return applyProjectionInput(snapshot, frame, options);
}

export function applyPublicEvent(
  snapshot: ProjectionSnapshot,
  event: PublicOmpServerEvent,
  options: ProjectionOptions = {},
): ProjectionSnapshot {
  return applyProjectionInput(
    snapshot,
    { ...event.payload, type: event.kind } as ProjectionEventFrame,
    options,
  );
}

export class ProjectionStore {
  private current: ProjectionSnapshot;
  private mutationGeneration = 0;
  private disposed = false;
  private readonly options: Required<ProjectionOptions>;
  private readonly listeners = new Set<ProjectionSubscription>();
  private readonly cacheStore: ProjectionCacheStore | undefined;
  private cacheSave: Promise<void> | undefined;
  private pendingSnapshot: ProjectionSnapshot | undefined;
  private cacheReadyPromise: Promise<void>;
  get hydrated(): Promise<void> {
    return this.cacheReadyPromise;
  }
  constructor(options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {}) {
    this.options = resolveProjectionOptions(options);
    this.current = createProjectionSnapshot();
    this.cacheStore = options.cacheStore;
    this.cacheReadyPromise = this.restoreCache();
  }
  get snapshot(): ProjectionSnapshot {
    return this.current;
  }
  getSnapshot(): ProjectionSnapshot {
    return this.current;
  }
  async ready(): Promise<void> {
    await this.cacheReadyPromise;
  }
  applyPublicFrame(frame: ProjectionFrame): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = applyPublicFrame(this.current, frame, this.options);
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next, frame);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  applyPublicEvent(event: PublicOmpServerEvent): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = applyPublicEvent(this.current, event, this.options);
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next, event);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  activateSession(hostId: string, sessionId: string): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = Object.freeze({
      ...touch(this.current, key(hostId, sessionId), this.options),
      activeSessionKey: key(hostId, sessionId),
    });
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    return next;
  }
  /**
   * Mark one host's (or every host's) retained session list as historical.
   * Connection generations are independent from app-wire session cursors, so
   * callers must invalidate completeness rather than cursor-reject a fresh
   * list whose host-wide cursor may legitimately restart at sequence zero.
   */
  invalidateSessionInventory(hostId?: string): ProjectionSnapshot {
    if (this.disposed || this.current.sessionIndexMetadata.size === 0) return this.current;
    if (hostId !== undefined && !this.current.sessionIndexMetadata.has(hostId)) return this.current;
    const sessionIndexMetadata =
      hostId === undefined
        ? immutableMap<string, SessionIndexMetadata>()
        : mapWithout(this.current.sessionIndexMetadata, hostId);
    if (sessionIndexMetadata === this.current.sessionIndexMetadata) return this.current;
    const next = Object.freeze({ ...this.current, sessionIndexMetadata });
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch {
        /* listener isolation */
      }
    }
    return next;
  }
  subscribe(listener: ProjectionSubscription): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }
  private queueCacheSave(): void {
    if (this.cacheStore === undefined || this.disposed) return;
    this.pendingSnapshot = this.current;
    if (this.cacheSave === undefined) this.cacheSave = this.drainCacheSaves();
  }
  private async drainCacheSaves(): Promise<void> {
    try {
      // Disposal blocks new mutations, but already-coalesced snapshots must still drain.
      while (this.pendingSnapshot !== undefined) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        let serialized: string;
        try {
          serialized = encodeProjectionCache(snapshot);
        } catch {
          continue;
        }
        try {
          await Promise.resolve(this.cacheStore?.save(serialized));
        } catch {
          /* persistence cannot block live state */
        }
      }
    } finally {
      this.cacheSave = undefined;
      if (this.pendingSnapshot !== undefined && !this.disposed)
        this.cacheSave = this.drainCacheSaves();
    }
  }
  async flush(): Promise<void> {
    while (this.cacheSave !== undefined) await this.cacheSave;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    await this.flush();
  }
  private async restoreCache(): Promise<void> {
    const loadGeneration = this.mutationGeneration;
    if (this.cacheStore === undefined) return;
    try {
      const value = await this.cacheStore.load();
      const restored = decodeProjectionCacheValue(value);
      if (
        restored !== undefined &&
        this.mutationGeneration === loadGeneration &&
        loadGeneration === 0
      ) {
        const sessions = immutableMap(
          [...restored.sessions].map(
            ([sessionKey, session]) =>
              [sessionKey, retainRestoredSessionResources(session, this.options)] as const,
          ),
        );
        this.current = Object.freeze({ ...restored, sessions });
        // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
        for (const listener of [...this.listeners]) {
          try {
            listener(this.current);
          } catch {
            /* listener isolation */
          }
        }
      }
    } catch {
      /* corrupt, old, or oversized cache fails closed */
    }
  }
}

export function createProjectionStore(
  options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {},
): ProjectionStore {
  return new ProjectionStore(options);
}
