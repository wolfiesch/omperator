import type {
  AgentFrame,
  AuditFrame,
  ConfirmationChallenge,
  Cursor,
  DurableEntry,
  FileFrame,
  GapFrame,
  LiveEventFrame,
  ResultFrame,
  ReviewFrame,
  SessionEvent,
  SessionRef,
  ServerFrame,
} from "@t4-code/protocol";
import { ImmutableSet } from "./immutable-set.ts";
import { ImmutableMap } from "./immutable-map.ts";
import { decodeProjectionCacheValue, encodeProjectionCache, type ProjectionCacheStore } from "./projection-cache.ts";
import {
  boundedIdentity,
  safeValue,
  sameSafeValue,
  sanitizeSessionRef,
} from "./projection-sanitize.ts";

export type ProjectionFrame = Exclude<ServerFrame, Extract<ServerFrame, { type: "pair.ok" }>>;
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

export interface SessionProjection {
  readonly hostId: string;
  readonly sessionId: string;
  readonly ref?: SessionRef;
  readonly entries: readonly DurableEntry[];
  readonly events: readonly LiveEventFrame[];
  readonly agents: ReadonlyMap<string, AgentFrame>;
  readonly terminals: ReadonlyMap<string, TerminalProjection>;
  readonly files: ReadonlyMap<string, FileFrame>;
  readonly reviews: ReadonlyMap<string, ReviewFrame>;
  readonly audit: readonly AuditFrame[];
  readonly confirmations: ReadonlyMap<string, ConfirmationChallenge>;
  readonly results: ReadonlyMap<string, ResultProjection>;
  readonly revision?: string;
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
  readonly gap?: GapFrame | undefined;
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
  /** Session-list delta cursors are independent from transcript cursors. */
  readonly sessionDeltaCursors: ReadonlyMap<string, Cursor>;
  readonly lru: readonly string[];
  readonly cursor?: Cursor;
  readonly epoch?: string;
  readonly freshness: ProjectionFreshness;
}

export interface ProjectionOptions {
  readonly maxWarmSessions?: number;
  readonly maxIndexedSessions?: number;
  readonly maxEntries?: number;
  readonly maxEvents?: number;
  readonly maxAudit?: number;
}


export interface ProjectionSubscription {
  (snapshot: ProjectionSnapshot, frame?: ProjectionFrame): void;
}

export const MAX_INDEXED_SESSION_REFS = 1000;
const DEFAULT_OPTIONS: Required<ProjectionOptions> = {
  maxWarmSessions: 8,
  maxIndexedSessions: MAX_INDEXED_SESSION_REFS,
  maxEntries: 16_384,
  maxEvents: 512,
  maxAudit: 256,
};
const EMPTY_MAP: ReadonlyMap<string, never> = new ImmutableMap<string, never>();

function key(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}
function freezeArray<T>(value: T[]): readonly T[] {
  return Object.freeze(value);
}
function appendBounded<T>(items: readonly T[], item: T, max: number): readonly T[] {
  const next = items.length >= max ? [...items.slice(items.length - max + 1), item] : [...items, item];
  return freezeArray(next);
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
function confirmationsAfterResponse(
  confirmations: ReadonlyMap<string, ConfirmationChallenge>,
  frame: ResultFrame,
): ReadonlyMap<string, ConfirmationChallenge> {
  const invalid = frame.error?.code === "confirmation_invalid";
  let changed = false;
  const next = new Map<string, ConfirmationChallenge>();
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
function initialSession(hostId: string, sessionId: string, freshness: ProjectionFreshness = "fresh"): SessionProjection {
  return Object.freeze({
    hostId,
    sessionId,
    entries: freezeArray([]),
    events: freezeArray([]),
    agents: EMPTY_MAP,
    terminals: EMPTY_MAP,
    files: EMPTY_MAP,
    reviews: EMPTY_MAP,
    audit: freezeArray([]),
    entryIds: new ImmutableSet<string>(),
    confirmations: EMPTY_MAP,
    results: EMPTY_MAP,
    freshness,
  });
}

export function createProjectionSnapshot(): ProjectionSnapshot {
  return Object.freeze({
    version: 1 as const,
    sessions: immutableMap<string, SessionProjection>(),
    sessionIndex: immutableMap<string, SessionRef>(),
    sessionIndexMetadata: immutableMap<string, SessionIndexMetadata>(),
    sessionDeltaCursors: immutableMap<string, Cursor>(),
    lru: freezeArray([]),
    freshness: "fresh" as const,
  });
}

function touch(snapshot: ProjectionSnapshot, sessionKey: string, options: Required<ProjectionOptions>): ProjectionSnapshot {
  const existing = snapshot.sessions.get(sessionKey);
  const lru = [...snapshot.lru.filter((item) => item !== sessionKey), sessionKey];
  let sessions = snapshot.sessions;
  if (existing === undefined) sessions = mapWith(sessions, sessionKey, initialSession(...sessionKey.split("\u0000") as [string, string]));
  while (lru.length > options.maxWarmSessions) {
    const evicted = lru.shift();
    if (evicted !== undefined) sessions = mapWithout(sessions, evicted);
  }
  const activeSessionKey = snapshot.activeSessionKey !== undefined && lru.includes(snapshot.activeSessionKey) ? snapshot.activeSessionKey : lru[lru.length - 1];
  return Object.freeze({ ...snapshot, sessions, lru: freezeArray(lru), ...(activeSessionKey === undefined ? { activeSessionKey: undefined } : { activeSessionKey }) });
}
function withSession(snapshot: ProjectionSnapshot, sessionKey: string, update: (session: SessionProjection) => SessionProjection, options: Required<ProjectionOptions>): ProjectionSnapshot {
  const warmed = touch(snapshot, sessionKey, options);
  const current = warmed.sessions.get(sessionKey)!;
  const updated = update(current);
  if (updated === current) return warmed;
  return Object.freeze({ ...warmed, sessions: mapWith(warmed.sessions, sessionKey, Object.freeze(updated)) });
}
function updateRoot(snapshot: ProjectionSnapshot, frame: { cursor?: Cursor; epoch?: string; freshness?: ProjectionFreshness }): ProjectionSnapshot {
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
  frame: ProjectionFrame & { readonly type: "sessions" },
  refs: readonly SessionRef[],
): ReadonlySet<string> {
  const hosts = new Set(refs.map((ref) => String(ref.hostId)));
  const raw = frame as unknown as Record<string, unknown>;
  const frameHost = boundedIdentity(raw.hostId);
  if (frameHost !== undefined) hosts.add(frameHost);
  return hosts;
}
function sessionFrameMetadata(
  frame: ProjectionFrame & { readonly type: "sessions" },
  refs: readonly SessionRef[],
  maxIndexedSessions: number,
  hosts: ReadonlySet<string>,
): ReadonlyMap<string, SessionIndexMetadata> {
  const raw = frame as unknown as Record<string, unknown>;
  const totalCount = typeof raw.totalCount === "number" && Number.isSafeInteger(raw.totalCount) && raw.totalCount >= 0 ? raw.totalCount : undefined;
  const truncated = typeof raw.truncated === "boolean" ? raw.truncated : totalCount === undefined ? refs.length >= maxIndexedSessions : totalCount > refs.length;
  return immutableMap([...hosts].map((hostId) => [hostId, Object.freeze({ totalCount: totalCount ?? refs.filter((ref) => String(ref.hostId) === hostId).length, truncated })] as const));
}

function sessionFrameIsComplete(
  frame: ProjectionFrame & { readonly type: "sessions" },
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

function resultProjection(frame: ResultFrame): ResultProjection {
  const output: ResultProjection = {
    requestId: String(frame.requestId),
    ...(frame.commandId === undefined ? {} : { commandId: String(frame.commandId) }),
    ok: frame.ok,
    ...(frame.result === undefined ? {} : { result: safeValue(frame.result) }),
    ...(frame.error === undefined ? {} : { error: Object.freeze({ code: frame.error.code, message: frame.error.message }) }),
  };
  return Object.freeze(output);
}

export function applyPublicFrame(
  snapshot: ProjectionSnapshot,
  frame: ProjectionFrame,
  options: ProjectionOptions = {},
): ProjectionSnapshot {
  const config = { ...DEFAULT_OPTIONS, ...options };
  switch (frame.type) {
    case "sessions": {
      const refs = frame.sessions.slice(0, config.maxIndexedSessions).map((ref) => sanitizeSessionRef(ref)).filter((ref): ref is SessionRef => ref !== undefined);
      const authoritativeHosts = authoritativeSessionHosts(frame, refs);
      const incomingKeys = new Set(refs.map((ref) => key(String(ref.hostId), String(ref.sessionId))));
      const complete = sessionFrameIsComplete(frame, refs, config.maxIndexedSessions);
      let sessionIndex = snapshot.sessionIndex;
      let sessions = snapshot.sessions;
      let sessionDeltaCursors = snapshot.sessionDeltaCursors;
      let activeSessionKey = snapshot.activeSessionKey;
      if (complete) {
        for (const [existingKey, existingRef] of snapshot.sessionIndex) {
          if (!authoritativeHosts.has(String(existingRef.hostId)) || incomingKeys.has(existingKey)) continue;
          sessionIndex = mapWithout(sessionIndex, existingKey);
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
      }
      while (sessionIndex.size > config.maxIndexedSessions) {
        const oldest = sessionIndex.keys().next().value;
        if (oldest === undefined) break;
        sessionIndex = mapWithout(sessionIndex, oldest);
      }
      let sessionIndexMetadata = snapshot.sessionIndexMetadata;
      for (const [hostId, metadata] of sessionFrameMetadata(frame, refs, config.maxIndexedSessions, authoritativeHosts)) {
        sessionIndexMetadata = mapWith(sessionIndexMetadata, hostId, metadata, config.maxIndexedSessions);
      }
      let next = Object.freeze({ ...snapshot, sessionIndex, sessionIndexMetadata, sessionDeltaCursors, sessions, lru, activeSessionKey });
      const active = activeSessionKey ?? mostRecentSessionKey(sessionIndex);
      if (active !== undefined) next = Object.freeze({ ...touch(next, active, config), activeSessionKey: active });
      for (const ref of refs) {
        const refKey = key(String(ref.hostId), String(ref.sessionId));
        if (!next.sessions.has(refKey)) continue;
        const existing = next.sessions.get(refKey)!;
        if (existing.ref !== ref || existing.revision !== String(ref.revision)) {
          next = Object.freeze({ ...next, sessions: mapWith(next.sessions, refKey, Object.freeze({ ...existing, ref, revision: String(ref.revision) })) });
        }
      }
      return updateRoot(Object.freeze({ ...next, cursor: frame.cursor }), { cursor: frame.cursor, freshness: "fresh" });
    }
    case "session.delta": {
      const hostId = boundedIdentity(frame.hostId);
      const frameSessionId = boundedIdentity(frame.sessionId);
      if (hostId === undefined || frameSessionId === undefined) return snapshot;
      const upsert = frame.upsert === undefined ? undefined : sanitizeSessionRef(frame.upsert);
      const remove = frame.remove === undefined ? undefined : boundedIdentity(frame.remove);
      if (frame.upsert !== undefined && upsert === undefined) return snapshot;
      if (upsert !== undefined && (String(upsert.hostId) !== hostId || String(upsert.sessionId) !== frameSessionId)) return snapshot;
      if (upsert === undefined && remove === undefined) return snapshot;
      const ownerKey = key(hostId, frameSessionId);
      const targetKey = key(hostId, upsert === undefined ? remove! : frameSessionId);
      const previousCursor = snapshot.sessionDeltaCursors.get(ownerKey);
      if (sessionDeltaCursorIsStale(previousCursor, frame.cursor)) return snapshot;
      const ownerWarm = snapshot.sessions.get(ownerKey);
      let sessionDeltaCursors = mapWith(snapshot.sessionDeltaCursors, ownerKey, Object.freeze({ ...frame.cursor }), config.maxIndexedSessions);
      let sessionIndex = snapshot.sessionIndex;
      let sessionIndexMetadata = snapshot.sessionIndexMetadata;
      let sessions = snapshot.sessions;
      let lru = snapshot.lru;
      let activeSessionKey = snapshot.activeSessionKey;
      const existingRef = sessionIndex.get(targetKey);
      if (upsert !== undefined) {
        if (existingRef === undefined && sessionIndex.size < config.maxIndexedSessions) sessionIndex = mapWith(sessionIndex, targetKey, upsert, config.maxIndexedSessions);
        else if (existingRef !== undefined && !sameSafeValue(existingRef, upsert)) sessionIndex = mapWith(sessionIndex, targetKey, upsert, config.maxIndexedSessions);
        const metadata = sessionIndexMetadata.get(hostId);
        if (metadata !== undefined && existingRef === undefined && !metadata.truncated) sessionIndexMetadata = mapWith(sessionIndexMetadata, hostId, Object.freeze({ ...metadata, totalCount: metadata.totalCount + 1 }), config.maxIndexedSessions);
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
        sessions = mapWithout(sessions, targetKey);
        lru = freezeArray(lru.filter((item) => item !== targetKey));
        if (activeSessionKey === targetKey) activeSessionKey = lru.at(-1);
        const metadata = sessionIndexMetadata.get(hostId);
        if (metadata !== undefined && existingRef !== undefined) sessionIndexMetadata = mapWith(sessionIndexMetadata, hostId, Object.freeze({ ...metadata, totalCount: Math.max(0, metadata.totalCount - 1) }), config.maxIndexedSessions);
      }
      return Object.freeze({ ...snapshot, sessionIndex, sessionIndexMetadata, sessionDeltaCursors, sessions, lru, activeSessionKey });
    }
    case "snapshot": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      const entries = frame.entries.slice(-config.maxEntries).map((entry) => Object.freeze({ ...entry, data: Object.freeze(safeValue(entry.data) as Record<string, unknown>) }));
      const entryIds = new ImmutableSet(entries.map((entry) => String(entry.id)));
      const next = withSession(snapshot, sessionKey, (session) => Object.freeze({
        ...session,
        entries: freezeArray(entries),
        entryIds,
        historyTruncated: frame.entries.length > config.maxEntries,
        events: freezeArray([]),
        revision: String(frame.revision),
        cursor: frame.cursor,
        epoch: frame.cursor.epoch,
        freshness: "fresh",
        gap: undefined,
      }), config);
      return Object.freeze({ ...updateRoot(next, { cursor: frame.cursor, epoch: frame.cursor.epoch, freshness: "fresh" }), activeSessionKey: next.activeSessionKey ?? sessionKey });
    }
    case "entry":
    case "event": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      const current = snapshot.sessions.get(sessionKey);
      const cursorResult = current === undefined ? "accept" : cursorState(current, frame.cursor);
      if (cursorResult === "duplicate") return snapshot;
      if (cursorResult === "gap") return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, freshness: "catching-up" }), config);
      return withSession(snapshot, sessionKey, (session) => {
        if (frame.type === "entry") {
          const entryId = String(frame.entry.id);
          const retiredEvents = freezeArray(session.events.filter((event) => String(event.event.entryId ?? "") !== entryId));
          if (session.entryIds.has(entryId)) {
            return Object.freeze({
              ...session,
              events: retiredEvents,
              revision: String(frame.revision),
              cursor: frame.cursor,
              epoch: frame.cursor.epoch,
            });
          }
          const entryIds = new ImmutableSet([...session.entryIds, entryId].slice(-config.maxEntries));
          return Object.freeze({
            ...session,
            entries: appendBounded(session.entries, Object.freeze({ ...frame.entry, data: Object.freeze(safeValue(frame.entry.data) as Record<string, unknown>) }), config.maxEntries),
            entryIds,
            events: retiredEvents,
            historyTruncated: session.historyTruncated === true || session.entries.length >= config.maxEntries,
            revision: String(frame.revision),
            cursor: frame.cursor,
            epoch: frame.cursor.epoch,
            freshness: "fresh",
            gap: undefined,
          });
        }
        const transientEntryId =
          frame.event.type === "message.settled" &&
          typeof frame.event.transientEntryId === "string"
            ? frame.event.transientEntryId
            : undefined;
        const retiredEvents =
          transientEntryId === undefined
            ? session.events
            : freezeArray(
                session.events.filter(
                  (event) => String(event.event.entryId ?? "") !== transientEntryId,
                ),
              );
        return Object.freeze({
          ...session,
          events: appendBounded(retiredEvents, Object.freeze({ ...frame, event: Object.freeze(safeValue(frame.event) as SessionEvent) }), config.maxEvents),
          cursor: frame.cursor,
          epoch: frame.cursor.epoch,
          freshness: "fresh",
          gap: undefined,
        });
      }, config);
    }
    case "gap": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, freshness: "catching-up", gap: frame }), config);
    }
    case "agent": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, agents: mapWith(session.agents, String(frame.agentId), Object.freeze({ ...frame, ...(frame.detail === undefined ? {} : { detail: safeValue(frame.detail) as Record<string, unknown> }) })) }), config);
    }
    case "terminal": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => {
        const existing = session.terminals.get(String(frame.terminalId)) ?? Object.freeze({ terminalId: String(frame.terminalId), stdout: "", stderr: "", closed: false });
        const data = frame.data ?? "";
        const stream = frame.stream === "stderr" ? "stderr" : frame.stream === "stdout" ? "stdout" : undefined;
        const text = stream === undefined ? existing["stdout"] : `${existing[stream]}${data}`.slice(-262_144);
        const terminal: TerminalProjection = Object.freeze({ ...existing, ...(stream === undefined ? {} : { [stream]: text }), ...(frame.exitCode === undefined ? {} : { exitCode: frame.exitCode }), ...(stream === undefined || frame.stream === "exit" ? { closed: true } : {}) });
        return Object.freeze({ ...session, terminals: mapWith(session.terminals, String(frame.terminalId), terminal) });
      }, config);
    }
    case "files": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, files: mapWith(session.files, frame.path, Object.freeze({ ...frame })) }), config);
    }
    case "review": {
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, reviews: mapWith(session.reviews, frame.reviewId, Object.freeze({ ...frame, findings: frame.findings.map((item) => Object.freeze(safeValue(item) as Record<string, unknown>)) })) }), config);
    }
    case "audit": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, audit: appendBounded(session.audit, Object.freeze({ ...frame, ...(frame.detail === undefined ? {} : { detail: Object.freeze(safeValue(frame.detail) as Record<string, unknown>) }) }), config.maxAudit) }), config);
    }
    case "confirmation": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({ ...session, confirmations: mapWith(session.confirmations, String(frame.confirmationId), Object.freeze({ ...frame })) }), config);
    }
    case "response": {
      if (frame.sessionId === undefined) return snapshot;
      const sessionKey = key(String(frame.hostId), String(frame.sessionId));
      return withSession(snapshot, sessionKey, (session) => Object.freeze({
        ...session,
        confirmations: confirmationsAfterResponse(session.confirmations, frame),
        results: mapWith(session.results, String(frame.requestId), resultProjection(frame)),
      }), config);
    }
    case "welcome": {
      // A welcome starts a new inventory bootstrap even when the durable
      // session epoch is unchanged. Retain cached/indexed rows for continuity,
      // but do not let their old completeness metadata prove that a route is
      // gone until the host sends the next authoritative sessions frame.
      const sessionIndexMetadata = mapWithout(
        snapshot.sessionIndexMetadata,
        String(frame.hostId),
      );
      if (snapshot.epoch === undefined || snapshot.epoch === frame.epoch) {
        return updateRoot(
          Object.freeze({ ...snapshot, sessionIndexMetadata }),
          { epoch: frame.epoch, freshness: "fresh" },
        );
      }
      const sessions = immutableMap([...snapshot.sessions.entries()].map(([sessionKey, session]) => [sessionKey, Object.freeze({ ...session, freshness: "catching-up" })] as const));
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
  get hydrated(): Promise<void> { return this.cacheReadyPromise; }
  constructor(options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.current = createProjectionSnapshot();
    this.cacheStore = options.cacheStore;
    this.cacheReadyPromise = this.restoreCache();
  }
  get snapshot(): ProjectionSnapshot { return this.current; }
  getSnapshot(): ProjectionSnapshot { return this.current; }
  async ready(): Promise<void> { await this.cacheReadyPromise; }
  applyPublicFrame(frame: ProjectionFrame): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = applyPublicFrame(this.current, frame, this.options);
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
    for (const listener of [...this.listeners]) {
      try { listener(next, frame); } catch { /* listener isolation */ }
    }
    return next;
  }
  activateSession(hostId: string, sessionId: string): ProjectionSnapshot {
    if (this.disposed) return this.current;
    const next = Object.freeze({ ...touch(this.current, key(hostId, sessionId), this.options), activeSessionKey: key(hostId, sessionId) });
    if (next === this.current) return next;
    this.mutationGeneration += 1;
    this.current = next;
    this.queueCacheSave();
    return next;
  }
  subscribe(listener: ProjectionSubscription): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let active = true;
    return () => { if (!active) return; active = false; this.listeners.delete(listener); };
  }
  private queueCacheSave(): void {
    if (this.cacheStore === undefined || this.disposed) return;
    this.pendingSnapshot = this.current;
    if (this.cacheSave === undefined) this.cacheSave = this.drainCacheSaves();
  }
  private async drainCacheSaves(): Promise<void> {
    try {
      while (this.pendingSnapshot !== undefined && !this.disposed) {
        const snapshot = this.pendingSnapshot;
        this.pendingSnapshot = undefined;
        let serialized: string;
        try { serialized = encodeProjectionCache(snapshot); } catch { continue; }
        try { await Promise.resolve(this.cacheStore?.save(serialized)); } catch { /* persistence cannot block live state */ }
      }
    } finally {
      this.cacheSave = undefined;
      if (this.pendingSnapshot !== undefined && !this.disposed) this.cacheSave = this.drainCacheSaves();
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
      if (restored !== undefined && this.mutationGeneration === loadGeneration && loadGeneration === 0) {
        this.current = restored;
        // eslint-disable-next-line unicorn/no-useless-spread -- preserve listener snapshot when callbacks may unsubscribe during dispatch.
        for (const listener of [...this.listeners]) {
          try { listener(restored); } catch { /* listener isolation */ }
        }
      }
    } catch { /* corrupt, old, or oversized cache fails closed */ }
  }
}

export function createProjectionStore(options: ProjectionOptions & { readonly cacheStore?: ProjectionCacheStore } = {}): ProjectionStore {
  return new ProjectionStore(options);
}
