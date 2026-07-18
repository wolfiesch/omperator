import type {
  Cursor,
  DurableEntry,
  SessionRef,
} from "@t4-code/protocol";
import { MAX_PROJECTION_CACHE_BYTES } from "@t4-code/protocol/desktop-ipc";
import { MAX_INDEXED_SESSION_REFS } from "./projection.ts";
import type {
  AgentTranscriptProjection,
  ProjectionFreshness,
  ProjectionSnapshot,
  ResultProjection,
  SessionIndexMetadata,
  SessionProjection,
  TerminalProjection,
} from "./projection.ts";
import { ImmutableSet } from "./immutable-set.ts";
import { ImmutableMap } from "./immutable-map.ts";
import { retainedJsonBytes } from "./transcript-retention.ts";

export const PROJECTION_CACHE_VERSION = 1 as const;
export { MAX_PROJECTION_CACHE_BYTES };
export const MAX_PROJECTION_CACHE_SESSIONS = 8;
const MAX_PROJECTION_CACHE_TRANSCRIPT_BYTES = Math.floor(MAX_PROJECTION_CACHE_BYTES * 0.75);

export interface ProjectionCacheStore {
  load():
    | string
    | Uint8Array
    | ProjectionCacheEnvelope
    | null
    | undefined
    | Promise<string | Uint8Array | ProjectionCacheEnvelope | null | undefined>;
  save(serialized: string): void | Promise<void>;
}
export interface ProjectionCacheEnvelope {
  readonly kind: "t4-code-projection";
  readonly version: 1;
  readonly savedAt: number;
  readonly data: ProjectionCacheData;
}
interface ProjectionCacheData {
  readonly sessions: Array<{ key: string; value: SessionProjectionData }>;
  readonly sessionIndex: Array<[string, SessionRef]>;
  readonly sessionIndexMetadata?: Array<[string, SessionIndexMetadata]>;
  readonly sessionDeltaCursors?: Array<[string, Cursor]>;
  readonly activeSessionKey?: string;
  readonly lru: string[];
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
}
type SessionMapValue<Key extends keyof SessionProjection> =
  SessionProjection[Key] extends ReadonlyMap<string, infer Value> ? Value : never;
type ProjectionAgentFrame = SessionMapValue<"agents">;
type ProjectionFileFrame = SessionMapValue<"files">;
type ProjectionReviewFrame = SessionMapValue<"reviews">;
type ProjectionConfirmationFrame = SessionMapValue<"confirmations">;
type ProjectionAuditFrame = SessionProjection["audit"][number];
interface SessionProjectionData {
  readonly hostId: string;
  readonly sessionId: string;
  readonly ref?: SessionRef;
  readonly entries: readonly DurableEntry[];
  readonly events: readonly unknown[];
  readonly agents: Array<[string, ProjectionAgentFrame]>;
  readonly agentTranscripts?: Array<[string, AgentTranscriptProjectionData]>;
  readonly terminals: Array<[string, TerminalProjection]>;
  readonly files: Array<[string, ProjectionFileFrame]>;
  readonly reviews: Array<[string, ProjectionReviewFrame]>;
  readonly audit: readonly ProjectionAuditFrame[];
  readonly confirmations: Array<[string, ProjectionConfirmationFrame]>;
  readonly results: Array<[string, ResultProjection]>;
  readonly revision?: string;
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  readonly gap?: unknown;
  readonly historyTruncated?: boolean;
}
interface AgentTranscriptProjectionData {
  readonly entries: readonly DurableEntry[];
  readonly cursor: Cursor;
  readonly revision: string;
  readonly freshness: ProjectionFreshness;
  readonly historyTruncated?: boolean;
}

function byteLength(text: string): number {
  return typeof TextEncoder === "undefined"
    ? text.length
    : new TextEncoder().encode(text).byteLength;
}
function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value))
    return Object.freeze(
      value
        .slice(0, 1024)
        .map((item) => safeJson(item, depth + 1))
        .filter((item) => item !== undefined),
    );
  if (typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>).slice(0, 1024)) {
    if (/token|secret|password|credential|authorization|endpoint|stack/i.test(name)) continue;
    const safe = safeJson(item, depth + 1);
    if (safe !== undefined) output[name] = safe;
  }
  return Object.freeze(output);
}
function arrayFromMap<T>(map: ReadonlyMap<string, T>): Array<[string, T]> {
  return [...map.entries()].map(([key, value]) => [key, safeJson(value) as T]);
}
function cachedAgentTranscripts(
  map: ReadonlyMap<string, AgentTranscriptProjection>,
): Array<[string, AgentTranscriptProjectionData]> {
  return [...map.entries()].slice(-16).map(([agentId, transcript]) => [
    agentId,
    {
      entries: transcript.entries.slice(-64).map((entry) => safeJson(entry) as DurableEntry),
      cursor: transcript.cursor,
      revision: transcript.revision,
      freshness: transcript.freshness,
      ...(transcript.historyTruncated === true || transcript.entries.length > 64
        ? { historyTruncated: true }
        : {}),
    },
  ]);
}

function cachedEntries(
  entries: readonly DurableEntry[],
  maxBytes: number,
): { readonly entries: readonly DurableEntry[]; readonly truncated: boolean } {
  const retained: DurableEntry[] = [];
  let bytes = 2;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const entryBytes = retainedJsonBytes(entry);
    const separator = retained.length === 0 ? 0 : 1;
    if (bytes + separator + entryBytes > maxBytes) break;
    retained.push(entry);
    bytes += separator + entryBytes;
  }
  retained.reverse();
  return { entries: Object.freeze(retained), truncated: retained.length < entries.length };
}

export function encodeProjectionCache(snapshot: ProjectionSnapshot, savedAt = Date.now()): string {
  const cacheOrder = [
    ...snapshot.lru.toReversed(),
    ...[...snapshot.sessions.keys()].filter((key) => !snapshot.lru.includes(key)),
  ];
  const cachedSessions = cacheOrder.slice(0, MAX_PROJECTION_CACHE_SESSIONS).flatMap((key) => {
    const session = snapshot.sessions.get(key);
    return session === undefined ? [] : [[key, session] as const];
  });
  let transcriptBytesRemaining = MAX_PROJECTION_CACHE_TRANSCRIPT_BYTES;
  const data: ProjectionCacheData = {
    sessions: cachedSessions.map(([key, value]) => {
      // Spend the shared transcript allowance newest-LRU first. Dividing it
      // evenly made several empty sessions evict half of one compact 10k-entry
      // history even though the final cache still had room.
      const retained = cachedEntries(value.entries, Math.max(2, transcriptBytesRemaining));
      transcriptBytesRemaining = Math.max(
        0,
        transcriptBytesRemaining - retainedJsonBytes(retained.entries),
      );
      return {
        key,
        value: {
          hostId: value.hostId,
          sessionId: value.sessionId,
          ...(value.ref === undefined ? {} : { ref: safeJson(value.ref) as SessionRef }),
          entries: retained.entries.map((entry) => safeJson(entry) as DurableEntry),
          historyTruncated: value.historyTruncated === true || retained.truncated,
          events: value.events.slice(-512).map((event) => safeJson(event)),
          agents: arrayFromMap(value.agents),
          agentTranscripts: cachedAgentTranscripts(value.agentTranscripts),
          terminals: arrayFromMap(value.terminals),
          files: arrayFromMap(value.files),
          reviews: arrayFromMap(value.reviews),
          audit: value.audit.slice(-256).map((item) => safeJson(item) as ProjectionAuditFrame),
          // Confirmation challenges are bound to one live connection on the
          // appserver. Persisting them makes a restarted client offer an approval
          // that the new connection can never consume.
          confirmations: [],
          results: arrayFromMap(value.results),
          ...(value.revision === undefined ? {} : { revision: value.revision }),
          ...(value.cursor === undefined ? {} : { cursor: value.cursor }),
          ...(value.epoch === undefined ? {} : { epoch: value.epoch }),
          freshness: value.freshness,
          ...(value.gap === undefined ? {} : { gap: safeJson(value.gap) }),
          // Local arrival ordinals intentionally are not persisted. Their only
          // meaning is relative receive order inside one live process.
        },
      };
    }),
    sessionIndex: [...snapshot.sessionIndex.entries()]
      .slice(0, MAX_INDEXED_SESSION_REFS)
      .map(([key, value]) => [key, safeJson(value) as SessionRef]),
    sessionIndexMetadata: [...snapshot.sessionIndexMetadata.entries()]
      .slice(0, MAX_INDEXED_SESSION_REFS)
      .map(([key, value]) => [key, safeJson(value) as SessionIndexMetadata]),
    sessionDeltaCursors: [...snapshot.sessionDeltaCursors.entries()]
      .slice(0, MAX_INDEXED_SESSION_REFS)
      .map(([key, value]) => [key, safeJson(value) as Cursor]),
    ...(snapshot.activeSessionKey === undefined
      ? {}
      : { activeSessionKey: snapshot.activeSessionKey }),
    lru: snapshot.lru.slice(0, MAX_PROJECTION_CACHE_SESSIONS),
    ...(snapshot.cursor === undefined ? {} : { cursor: snapshot.cursor }),
    ...(snapshot.epoch === undefined ? {} : { epoch: snapshot.epoch }),
    freshness: "cached",
  };
  const envelope: ProjectionCacheEnvelope = {
    kind: "t4-code-projection",
    version: PROJECTION_CACHE_VERSION,
    savedAt,
    data,
  };
  let serialized = JSON.stringify(envelope);
  if (byteLength(serialized) > MAX_PROJECTION_CACHE_BYTES) {
    const compact: ProjectionCacheEnvelope = {
      ...envelope,
      data: {
        ...data,
        sessions: data.sessions.map((item) => ({
          ...item,
          value: {
            ...item.value,
            entries: item.value.entries.slice(-512),
            events: item.value.events.slice(-128),
            agentTranscripts: [],
            audit: item.value.audit.slice(-64),
            historyTruncated: true,
          },
        })),
      },
    };
    serialized = JSON.stringify(compact);
  }
  if (byteLength(serialized) > MAX_PROJECTION_CACHE_BYTES)
    throw new Error("projection cache exceeds bounded size");
  return serialized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function asMap<T>(
  value: unknown,
  validate: (value: Record<string, unknown>) => T,
): ReadonlyMap<string, T> {
  if (!Array.isArray(value)) throw new Error("invalid cache map");
  const map = new Map<string, T>();
  for (const pair of value.slice(0, 1024)) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !isRecord(pair[1])
    )
      throw new Error("invalid cache map entry");
    map.set(pair[0], validate(pair[1]));
  }
  return new ImmutableMap(map);
}
function identity<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze(safeJson(value) as T);
}
function terminalValue(value: Record<string, unknown>): TerminalProjection {
  if (
    typeof value.terminalId !== "string" ||
    typeof value.stdout !== "string" ||
    typeof value.stderr !== "string" ||
    typeof value.closed !== "boolean"
  )
    throw new Error("invalid terminal cache");
  return identity(value) as unknown as TerminalProjection;
}
function resultValue(value: Record<string, unknown>): ResultProjection {
  if (typeof value.requestId !== "string" || typeof value.ok !== "boolean")
    throw new Error("invalid result cache");
  return identity(value) as unknown as ResultProjection;
}
function fileValue(value: Record<string, unknown>): ProjectionFileFrame {
  if (typeof value.path !== "string") throw new Error("invalid file cache");
  return identity(value) as unknown as ProjectionFileFrame;
}
function reviewValue(value: Record<string, unknown>): ProjectionReviewFrame {
  if (
    typeof value.reviewId !== "string" ||
    typeof value.status !== "string" ||
    !Array.isArray(value.findings)
  )
    throw new Error("invalid review cache");
  return identity(value) as unknown as ProjectionReviewFrame;
}
function agentValue(value: Record<string, unknown>): ProjectionAgentFrame {
  if (typeof value.agentId !== "string" || typeof value.state !== "string")
    throw new Error("invalid agent cache");
  return identity(value) as unknown as ProjectionAgentFrame;
}
function transcriptValue(value: Record<string, unknown>): AgentTranscriptProjection {
  if (
    !Array.isArray(value.entries) ||
    !isRecord(value.cursor) ||
    typeof value.cursor.epoch !== "string" ||
    typeof value.cursor.seq !== "number" ||
    !Number.isSafeInteger(value.cursor.seq) ||
    value.cursor.seq < 0 ||
    typeof value.revision !== "string"
  ) {
    throw new Error("invalid agent transcript cache");
  }
  const entries = value.entries.slice(-64).map((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.data)) {
      throw new Error("invalid agent transcript entry cache");
    }
    return Object.freeze({
      ...entry,
      data: Object.freeze(safeJson(entry.data) as Record<string, unknown>),
    }) as unknown as DurableEntry;
  });
  return Object.freeze({
    entries: Object.freeze(entries),
    entryIds: new ImmutableSet(entries.map((entry) => String(entry.id))),
    cursor: Object.freeze({ epoch: value.cursor.epoch, seq: value.cursor.seq }),
    revision: value.revision,
    freshness: "cached",
    ...(value.historyTruncated === true ? { historyTruncated: true } : {}),
  });
}
function restoredSessionRef(value: unknown): SessionRef | undefined {
  const safe = safeJson(value);
  if (
    !isRecord(safe) ||
    typeof safe.hostId !== "string" ||
    typeof safe.sessionId !== "string" ||
    typeof safe.revision !== "string" ||
    typeof safe.title !== "string" ||
    typeof safe.status !== "string" ||
    typeof safe.updatedAt !== "string" ||
    !isRecord(safe.project) ||
    typeof safe.project.projectId !== "string"
  )
    return undefined;
  return Object.freeze({
    ...safe,
    project: Object.freeze({ ...safe.project }),
  }) as unknown as SessionRef;
}
function restoreSession(value: unknown): SessionProjection | undefined {
  if (
    !isRecord(value) ||
    typeof value.hostId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.freshness !== "string"
  )
    return undefined;
  const rawEntries = Array.isArray(value.entries)
    ? (value.entries.slice(-10_000) as DurableEntry[])
    : [];
  const entries = rawEntries.map((entry) =>
    Object.freeze({
      ...entry,
      data: Object.freeze(safeJson(entry.data) as Record<string, unknown>),
    }),
  );
  const events = Array.isArray(value.events)
    ? value.events
        .slice(-512)
        .map((event) => safeJson(event) as SessionProjection["events"][number])
    : [];
  const audit = Array.isArray(value.audit)
    ? value.audit.slice(-256).map((item) => safeJson(item) as ProjectionAuditFrame)
    : [];
  const ref = isRecord(value.ref) ? restoredSessionRef(value.ref) : undefined;
  return Object.freeze({
    sessionId: value.sessionId,
    hostId: value.hostId,
    ...(ref === undefined ? {} : { ref }),
    entries: Object.freeze(entries),
    events: Object.freeze(events),
    agents: asMap<ProjectionAgentFrame>(value.agents, agentValue),
    agentTranscripts:
      value.agentTranscripts === undefined
        ? new ImmutableMap<string, AgentTranscriptProjection>()
        : asMap<AgentTranscriptProjection>(value.agentTranscripts, transcriptValue),
    terminals: asMap<TerminalProjection>(value.terminals, terminalValue),
    files: asMap<ProjectionFileFrame>(value.files, fileValue),
    reviews: asMap<ProjectionReviewFrame>(value.reviews, reviewValue),
    audit: Object.freeze(audit),
    // Never revive a connection-bound challenge, including from an older cache
    // written before challenges were excluded from persistence.
    confirmations: new ImmutableMap<string, ProjectionConfirmationFrame>(),
    results: asMap<ResultProjection>(value.results, resultValue),
    entryIds: new ImmutableSet(entries.map((entry) => String(entry.id))),
    ...(typeof value.revision === "string" &&
    value.revision.length > 0 &&
    value.revision.length <= 256
      ? { revision: value.revision }
      : {}),
    ...(isRecord(value.cursor) &&
    typeof value.cursor.epoch === "string" &&
    typeof value.cursor.seq === "number"
      ? { cursor: Object.freeze({ epoch: value.cursor.epoch, seq: value.cursor.seq }) }
      : {}),
    ...(typeof value.epoch === "string" ? { epoch: value.epoch } : {}),
    freshness: value.freshness === "catching-up" ? "catching-up" : "cached",
    // Cached transcript events have no order relationship with refs received
    // by this process. The first live inventory/event establishes a new fence.
    transcriptEventArrivalOrdinal: 0,
    contextMaintenanceEventArrivalOrdinal: 0,
    ...(isRecord(value.gap) ? { gap: value.gap as never } : {}),
    ...(value.historyTruncated === true ? { historyTruncated: true } : {}),
  });
}

export function decodeProjectionCache(
  serialized: string | Uint8Array | ProjectionCacheEnvelope,
): ProjectionSnapshot {
  const text =
    typeof serialized === "string"
      ? serialized
      : serialized instanceof Uint8Array
        ? new TextDecoder().decode(serialized)
        : JSON.stringify(serialized);
  if (byteLength(text) > MAX_PROJECTION_CACHE_BYTES)
    throw new Error("projection cache exceeds bounded size");
  const parsed: unknown =
    typeof serialized === "object" && !(serialized instanceof Uint8Array)
      ? serialized
      : JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.kind !== "t4-code-projection" ||
    parsed.version !== PROJECTION_CACHE_VERSION ||
    !isRecord(parsed.data)
  )
    throw new Error("unsupported projection cache");
  const data = parsed.data;
  const sessions = new Map<string, SessionProjection>();
  if (Array.isArray(data.sessions)) {
    for (const item of data.sessions.slice(0, MAX_PROJECTION_CACHE_SESSIONS)) {
      if (!isRecord(item) || typeof item.key !== "string") continue;
      const restored = restoreSession(item.value);
      if (restored !== undefined) sessions.set(item.key, restored);
    }
  }
  const sessionIndex = new Map<string, SessionRef>();
  if (Array.isArray(data.sessionIndex)) {
    for (const item of data.sessionIndex.slice(0, MAX_INDEXED_SESSION_REFS)) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      const ref = restoredSessionRef(item[1]);
      if (ref !== undefined) sessionIndex.set(item[0], ref);
    }
  }
  const sessionIndexMetadata = new Map<string, SessionIndexMetadata>();
  if (Array.isArray(data.sessionIndexMetadata)) {
    for (const item of data.sessionIndexMetadata.slice(0, MAX_INDEXED_SESSION_REFS)) {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        !isRecord(item[1]) ||
        typeof item[1].totalCount !== "number" ||
        !Number.isSafeInteger(item[1].totalCount) ||
        item[1].totalCount < 0 ||
        typeof item[1].truncated !== "boolean"
      )
        continue;
      sessionIndexMetadata.set(
        item[0],
        Object.freeze({ totalCount: item[1].totalCount, truncated: item[1].truncated }),
      );
    }
  }
  const sessionDeltaCursors = new Map<string, Cursor>();
  if (Array.isArray(data.sessionDeltaCursors)) {
    for (const item of data.sessionDeltaCursors.slice(0, MAX_INDEXED_SESSION_REFS)) {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        !isRecord(item[1]) ||
        typeof item[1].epoch !== "string" ||
        typeof item[1].seq !== "number" ||
        !Number.isSafeInteger(item[1].seq) ||
        item[1].seq < 0
      )
        continue;
      sessionDeltaCursors.set(item[0], Object.freeze({ epoch: item[1].epoch, seq: item[1].seq }));
    }
  }
  const lru = Array.isArray(data.lru)
    ? data.lru
        .filter((item): item is string => typeof item === "string" && sessions.has(item))
        .slice(0, MAX_PROJECTION_CACHE_SESSIONS)
    : [];
  const activeSessionKey =
    typeof data.activeSessionKey === "string" &&
    sessions.has(data.activeSessionKey) &&
    lru.includes(data.activeSessionKey)
      ? data.activeSessionKey
      : undefined;
  return Object.freeze({
    version: 1 as const,
    sessions: new ImmutableMap(sessions),
    sessionIndex: new ImmutableMap(sessionIndex),
    sessionIndexMetadata: new ImmutableMap(sessionIndexMetadata),
    sessionRefArrivalOrdinals: new ImmutableMap<string, number>(),
    sessionDeltaCursors: new ImmutableMap(sessionDeltaCursors),
    lru: Object.freeze(lru),
    ...(activeSessionKey === undefined ? {} : { activeSessionKey }),
    ...(isRecord(data.cursor) &&
    typeof data.cursor.epoch === "string" &&
    typeof data.cursor.seq === "number"
      ? { cursor: Object.freeze({ epoch: data.cursor.epoch, seq: data.cursor.seq }) }
      : {}),
    ...(typeof data.epoch === "string" ? { epoch: data.epoch } : {}),
    freshness: "cached" as const,
    arrivalOrdinal: 0,
  });
}

export function decodeProjectionCacheValue(
  value: string | Uint8Array | ProjectionCacheEnvelope | null | undefined,
): ProjectionSnapshot | undefined {
  if (value == null) return undefined;
  try {
    return decodeProjectionCache(value);
  } catch {
    return undefined;
  }
}
