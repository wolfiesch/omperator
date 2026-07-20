import { decodeWorkspaceInfrastructureProjection, type Cursor, type DurableEntry, type SessionRef, type WorkspaceInfrastructureProjection } from "@t4-code/protocol";
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
  PreviewProjection,
  PreviewAuthorityProjection,
  PreviewEventProjection,
} from "./projection.ts";
import { ImmutableSet } from "./immutable-set.ts";
import { ImmutableMap } from "./immutable-map.ts";
import { retainedJsonBytes } from "./transcript-retention.ts";
import { previewKey, type PreviewCaptureMetadata } from "./preview.ts";

export const PROJECTION_CACHE_VERSION = 2 as const;
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
  readonly version: 1 | typeof PROJECTION_CACHE_VERSION;
  readonly savedAt: number;
  readonly data: ProjectionCacheData;
}
interface ProjectionCacheData {
  readonly sessions: Array<{ key: string; value: SessionProjectionData }>;
  readonly sessionIndex: Array<[string, SessionRef]>;
  readonly sessionIndexMetadata?: Array<[string, SessionIndexMetadata]>;
  readonly sessionDeltaCursors?: Array<[string, Cursor]>;
  readonly sessionInventoryCursors?: Array<[string, Cursor]>;
  readonly workspaces?: Array<[string, WorkspaceInfrastructureProjection]>;
  readonly workspaceCursors?: Array<[string, Cursor]>;
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
  readonly previews?: Array<[string, PreviewProjectionData]>;
  readonly previewEvents?: readonly PreviewEventProjection[];
}
interface PreviewProjectionData {
  readonly hostId: string;
  readonly sessionId: string;
  readonly previewId: string;
  readonly state?: PreviewProjection["state"];
  readonly url?: string;
  readonly revision: string;
  readonly cursor: Cursor;
  readonly title?: string;
  readonly canGoBack?: boolean;
  readonly canGoForward?: boolean;
  readonly viewport?: { width: number; height: number; deviceScaleFactor?: number };
  readonly capture?: PreviewCaptureMetadata;
  readonly authority?: PreviewAuthorityProjection;
  readonly availableActions?: PreviewProjection["availableActions"];
  readonly error?: { code: string; message: string };
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

function cachedPreviewUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}
function cachedPreviews(
  previews: ReadonlyMap<string, PreviewProjection>,
): Array<[string, PreviewProjectionData]> {
  return [...previews.values()].slice(-32).map((preview) => {
    const url = cachedPreviewUrl(preview.url);
    return [
      previewKey(preview),
      {
        hostId: preview.hostId,
        sessionId: preview.sessionId,
        previewId: preview.previewId,
        ...(preview.state === undefined ? {} : { state: preview.state }),
        ...(url === undefined ? {} : { url }),
        revision: preview.revision,
        cursor: { ...preview.cursor },
        ...(preview.title === undefined ? {} : { title: preview.title }),
        ...(preview.canGoBack === undefined ? {} : { canGoBack: preview.canGoBack }),
        ...(preview.canGoForward === undefined ? {} : { canGoForward: preview.canGoForward }),
        ...(preview.viewport === undefined ? {} : { viewport: { ...preview.viewport } }),
        ...(preview.capture === undefined ? {} : { capture: { ...preview.capture } }),
        ...(preview.authority === undefined ? {} : { authority: { ...preview.authority } }),
        ...(preview.availableActions === undefined
          ? {}
          : { availableActions: [...preview.availableActions] }),
        ...(preview.error === undefined ? {} : { error: { ...preview.error } }),
      } satisfies PreviewProjectionData,
    ];
  });
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
          previews: cachedPreviews(value.previews),
          previewEvents: value.previewEvents
            .slice(-128)
            .map((event) => safeJson(event) as PreviewEventProjection),
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
    sessionInventoryCursors: [...snapshot.sessionInventoryCursors.entries()]
      .slice(0, MAX_INDEXED_SESSION_REFS)
      .map(([key, value]) => [key, safeJson(value) as Cursor]),
    workspaces: [...snapshot.workspaces.entries()]
      .slice(0, MAX_INDEXED_SESSION_REFS)
      .map(([key, value]) => [key, safeJson(value) as WorkspaceInfrastructureProjection]),
    workspaceCursors: [...snapshot.workspaceCursors.entries()]
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

const PREVIEW_ACTIONS = [
  "activate",
  "navigate",
  "back",
  "forward",
  "reload",
  "close",
  "capture",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "select",
  "upload",
  "handoff",
] as const;

function restoredPreviewAuthority(value: unknown): PreviewAuthorityProjection | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    typeof value.label !== "string" ||
    value.label.length > 256 ||
    (value.kind !== "isolated-session" && value.kind !== "authenticated-profile") ||
    typeof value.requiresExplicitOptIn !== "boolean"
  )
    throw new Error("invalid preview authority cache");
  return Object.freeze({
    id: value.id,
    label: value.label,
    kind: value.kind,
    requiresExplicitOptIn: value.requiresExplicitOptIn,
  });
}

function restoredPreviewActions(value: unknown): PreviewProjection["availableActions"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > PREVIEW_ACTIONS.length)
    throw new Error("invalid preview actions cache");
  if (
    value.some((action) => typeof action !== "string" || !PREVIEW_ACTIONS.includes(action as never)) ||
    new Set(value).size !== value.length
  )
    throw new Error("invalid preview actions cache");
  return Object.freeze([...value]) as PreviewProjection["availableActions"];
}

function restoredPreviewEvents(value: unknown): readonly PreviewEventProjection[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error("invalid preview event cache");
  const events: PreviewEventProjection[] = [];
  for (const raw of value.slice(-128)) {
    if (
      !isRecord(raw) ||
      !["launch", "navigation", "capture", "error"].includes(String(raw.type)) ||
      typeof raw.previewId !== "string" ||
      raw.previewId.length === 0
    )
      throw new Error("invalid preview event cache");
    const cursor = raw.cursor;
    const url = raw.url;
    const timestamp = raw.timestamp;
    const captureId = raw.captureId;
    const errorCode = raw.errorCode;
    if (!isRecord(cursor)) throw new Error("invalid preview event cache");
    const cursorEpoch = cursor.epoch;
    const cursorSeq = cursor.seq;
    if (
      typeof cursorEpoch !== "string" ||
      typeof cursorSeq !== "number" ||
      !Number.isSafeInteger(cursorSeq) ||
      cursorSeq < 0
    )
      throw new Error("invalid preview event cache");
    let savedUrl: PreviewEventProjection["url"];
    if (url !== undefined) {
      if (!isRecord(url)) throw new Error("invalid preview event URL");
      const origin = url.origin;
      const pathname = url.pathname;
      const hasQuery = url.hasQuery;
      if (
        typeof origin !== "string" ||
        typeof pathname !== "string" ||
        typeof hasQuery !== "boolean" ||
        origin.length > 512 ||
        pathname.length > 1024
      )
        throw new Error("invalid preview event URL");
      savedUrl = Object.freeze({ origin, pathname, hasQuery });
    }
    if (
      (timestamp !== undefined &&
        (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp < 0)) ||
      (captureId !== undefined && (typeof captureId !== "string" || captureId.length > 256)) ||
      (errorCode !== undefined && (typeof errorCode !== "string" || errorCode.length > 256))
    )
      throw new Error("invalid preview event cache");
    events.push(
      Object.freeze({
        type: raw.type as PreviewEventProjection["type"],
        previewId: raw.previewId,
        cursor: Object.freeze({ epoch: cursorEpoch, seq: cursorSeq }),
        ...(savedUrl === undefined ? {} : { url: savedUrl }),
        ...(timestamp === undefined ? {} : { timestamp }),
        ...(captureId === undefined ? {} : { captureId }),
        ...(errorCode === undefined ? {} : { errorCode }),
      }),
    );
  }
  return Object.freeze(events);
}
function identity<T extends Record<string, unknown>>(value: T): T {
  return Object.freeze(safeJson(value) as T);
}
function restoredPreviews(
  value: unknown,
  hostId: string,
  sessionId: string,
): ReadonlyMap<string, PreviewProjection> {
  if (value === undefined) return new ImmutableMap<string, PreviewProjection>();
  if (!Array.isArray(value)) throw new Error("invalid preview cache");
  const previews = new Map<string, PreviewProjection>();
  for (const pair of value.slice(-32)) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      !isRecord(pair[1])
    )
      throw new Error("invalid preview cache entry");
    const raw = pair[1];
    const previewId = raw.previewId;
    const revision = raw.revision;
    const cursor = raw.cursor;
    if (
      raw.hostId !== hostId ||
      raw.sessionId !== sessionId ||
      typeof previewId !== "string" ||
      typeof revision !== "string" ||
      !isRecord(cursor)
    )
      throw new Error("invalid preview cache identity");
    const cursorEpoch = cursor.epoch;
    const cursorSeq = cursor.seq;
    if (
      typeof cursorEpoch !== "string" ||
      typeof cursorSeq !== "number" ||
      !Number.isSafeInteger(cursorSeq) ||
      cursorSeq < 0
    )
      throw new Error("invalid preview cache identity");
    const state = raw.state;
    if (
      state !== undefined &&
      !["launching", "ready", "running", "stopped", "failed"].includes(String(state))
    )
      throw new Error("invalid preview cache state");
    const url = raw.url;
    if (url !== undefined && typeof url !== "string") throw new Error("invalid preview cache url");
    const title = raw.title;
    if (title !== undefined && typeof title !== "string") throw new Error("invalid preview cache title");
    const canGoBack = raw.canGoBack;
    const canGoForward = raw.canGoForward;
    if (canGoBack !== undefined && typeof canGoBack !== "boolean")
      throw new Error("invalid preview cache navigation");
    if (canGoForward !== undefined && typeof canGoForward !== "boolean")
      throw new Error("invalid preview cache navigation");
    const viewport = raw.viewport;
    if (
      viewport !== undefined &&
      (!isRecord(viewport) ||
        typeof viewport.width !== "number" ||
        !Number.isSafeInteger(viewport.width) ||
        typeof viewport.height !== "number" ||
        !Number.isSafeInteger(viewport.height) ||
        viewport.width <= 0 ||
        viewport.height <= 0 ||
        viewport.width * viewport.height > 16 * 1024 * 1024 ||
        (viewport.deviceScaleFactor !== undefined &&
          (typeof viewport.deviceScaleFactor !== "number" ||
            !Number.isFinite(viewport.deviceScaleFactor) ||
            viewport.deviceScaleFactor <= 0 ||
            viewport.deviceScaleFactor > 8)))
    )
      throw new Error("invalid preview cache viewport");
    const capture = raw.capture;
    if (
      capture !== undefined &&
      (!isRecord(capture) ||
        typeof capture.captureId !== "string" ||
        !["image/png", "image/jpeg", "image/webp"].includes(String(capture.mimeType)) ||
        typeof capture.size !== "number" ||
        !Number.isSafeInteger(capture.size) ||
        capture.size <= 0 ||
        capture.size > 8 * 1024 * 1024 ||
        typeof capture.width !== "number" ||
        !Number.isSafeInteger(capture.width) ||
        typeof capture.height !== "number" ||
        !Number.isSafeInteger(capture.height) ||
        capture.width <= 0 ||
        capture.height <= 0 ||
        capture.width * capture.height > 16 * 1024 * 1024 ||
        typeof capture.capturedAt !== "number" ||
        !Number.isSafeInteger(capture.capturedAt) ||
        capture.capturedAt < 0 ||
        !/^[a-f0-9]{64}$/u.test(String(capture.sha256)))
    )
      throw new Error("invalid preview capture cache");
    const error = raw.error;
    if (
      error !== undefined &&
      (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string")
    )
      throw new Error("invalid preview cache error");
    const authority = restoredPreviewAuthority(raw.authority);
    const availableActions = restoredPreviewActions(raw.availableActions);
    const identity = { hostId, sessionId, previewId };
    if (pair[0] !== previewKey(identity)) throw new Error("invalid preview cache key");
    const cachedUrl = cachedPreviewUrl(url);
    const restored = Object.freeze({
      ...identity,
      ...(state === undefined ? {} : { state }),
      ...(cachedUrl === undefined ? {} : { url: cachedUrl }),
      revision,
      cursor: Object.freeze({ epoch: cursorEpoch, seq: cursorSeq }),
      ...(title === undefined ? {} : { title }),
      ...(canGoBack === undefined ? {} : { canGoBack }),
      ...(canGoForward === undefined ? {} : { canGoForward }),
      ...(viewport === undefined ? {} : { viewport: Object.freeze({ ...viewport }) }),
      ...(capture === undefined ? {} : { capture: Object.freeze({ ...capture }) }),
      ...(authority === undefined ? {} : { authority }),
      ...(availableActions === undefined ? {} : { availableActions }),
      ...(error === undefined ? {} : { error: Object.freeze({ ...error }) }),
      freshness: "cached" as const,
    }) as unknown as PreviewProjection;
    previews.set(pair[0], restored);
  }
  return new ImmutableMap(previews);
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
    previews: restoredPreviews(value.previews, value.hostId, value.sessionId),
    previewEvents: restoredPreviewEvents(value.previewEvents),
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
    (parsed.version !== 1 && parsed.version !== PROJECTION_CACHE_VERSION) ||
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
  const sessionInventoryCursors = new Map<string, Cursor>();
  if (Array.isArray(data.sessionInventoryCursors)) {
    for (const item of data.sessionInventoryCursors.slice(0, MAX_INDEXED_SESSION_REFS)) {
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
      sessionInventoryCursors.set(
        item[0],
        Object.freeze({ epoch: item[1].epoch, seq: item[1].seq }),
      );
    }
  }
  const workspaces = new Map<string, WorkspaceInfrastructureProjection>();
  if (Array.isArray(data.workspaces)) {
    for (const item of data.workspaces.slice(0, MAX_INDEXED_SESSION_REFS)) {
      if (!Array.isArray(item) || typeof item[0] !== "string") continue;
      try {
        workspaces.set(item[0], decodeWorkspaceInfrastructureProjection(item[1]));
      } catch {
        // One malformed cached projection cannot revive operator state.
      }
    }
  }
  const workspaceCursors = new Map<string, Cursor>();
  if (Array.isArray(data.workspaceCursors)) {
    for (const item of data.workspaceCursors.slice(0, MAX_INDEXED_SESSION_REFS)) {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        !isRecord(item[1]) ||
        typeof item[1].epoch !== "string" ||
        typeof item[1].seq !== "number" ||
        !Number.isSafeInteger(item[1].seq) ||
        item[1].seq < 0
      ) continue;
      workspaceCursors.set(item[0], Object.freeze({ epoch: item[1].epoch, seq: item[1].seq }));
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
    sessionInventoryCursors: new ImmutableMap(sessionInventoryCursors),
    workspaces: new ImmutableMap(workspaces),
    workspaceCursors: new ImmutableMap(workspaceCursors),
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
