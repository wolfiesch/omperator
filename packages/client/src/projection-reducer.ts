import { decodeWorkspaceInfrastructureProjection } from "@t4-code/protocol";
import type {
  Cursor,
  DurableEntry,
  SessionEvent,
  SessionRef,
  WorkspaceInfrastructureProjection,
} from "@t4-code/protocol";
import { ImmutableSet } from "./immutable-set.ts";
import { ImmutableMap } from "./immutable-map.ts";
import {
  boundedIdentity,
  safeValue,
  sameSafeValue,
  sanitizeSessionRef,
} from "./projection-sanitize.ts";
import {
  appendRetainedDurableEntry,
  appendRetainedValue,
  retainDurableEntries,
  sanitizeRetainedRecord,
} from "./transcript-retention.ts";
import type { PublicOmpServerEvent } from "./omp-protocol-provider.ts";
import { reduceResourceProjection } from "./projection-resource-reducers.ts";
import {
  type AgentTranscriptProjection,
  type ProjectionAgentTranscriptFrame,
  type ProjectionFrame,
  type ProjectionEventFrame,
  type ProjectionFreshness,
  type ProjectionInput,
  type ProjectionInputFrame,
  type ProjectionOptions,
  type ProjectionSnapshot,
  type SessionIndexMetadata,
  type SessionProjection,
} from "./projection-contract.ts";
import { resolveProjectionOptions } from "./projection-options.ts";

export * from "./projection-contract.ts";

const EMPTY_MAP: ReadonlyMap<string, never> = new ImmutableMap<string, never>();

export function key(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}
function freezeArray<T>(value: T[]): readonly T[] {
  return Object.freeze(value);
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
export function immutableMap<K, V>(entries?: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}
function mapWith<K, V>(map: ReadonlyMap<K, V>, itemKey: K, value: V, max = 256): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(itemKey, value);
  while (next.size > max) next.delete(next.keys().next().value!);
  return immutableMap(next);
}
export function mapWithout<K, V>(map: ReadonlyMap<K, V>, itemKey: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(itemKey);
  return immutableMap(next);
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
    previews: EMPTY_MAP,
    previewEvents: freezeArray([]),
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
    sessionInventoryCursors: immutableMap<string, Cursor>(),
    workspaces: immutableMap<string, WorkspaceInfrastructureProjection>(),
    workspaceCursors: immutableMap<string, Cursor>(),
    lru: freezeArray([]),
    freshness: "fresh" as const,
    arrivalOrdinal: 0,
  });
}

export function applyWorkspaceInventory(
  snapshot: ProjectionSnapshot,
  host: string,
  workspaces: readonly WorkspaceInfrastructureProjection[],
  cursor: Cursor | undefined,
  maxWorkspaces: number,
): ProjectionSnapshot {
  if (cursor !== undefined) {
    const previousCursor = snapshot.workspaceCursors.get(host);
    if (
      previousCursor !== undefined &&
      previousCursor.epoch === cursor.epoch &&
      cursor.seq < previousCursor.seq
    )
      return snapshot;
  }
  let nextWorkspaces = snapshot.workspaces;
  for (const [itemKey] of nextWorkspaces) {
    if (itemKey.startsWith(`${host}\u0000`)) nextWorkspaces = mapWithout(nextWorkspaces, itemKey);
  }
  for (const raw of workspaces.slice(0, maxWorkspaces)) {
    const workspace = decodeWorkspaceInfrastructureProjection(raw);
    nextWorkspaces = mapWith(
      nextWorkspaces,
      key(host, workspace.id),
      Object.freeze(workspace),
      maxWorkspaces,
    );
  }
  const workspaceCursors =
    cursor === undefined
      ? snapshot.workspaceCursors
      : mapWith(snapshot.workspaceCursors, host, Object.freeze({ ...cursor }), maxWorkspaces);
  if (nextWorkspaces === snapshot.workspaces && workspaceCursors === snapshot.workspaceCursors) {
    return snapshot;
  }
  return Object.freeze({ ...snapshot, workspaces: nextWorkspaces, workspaceCursors });
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

export function touch(
  snapshot: ProjectionSnapshot,
  sessionKey: string,
  options: Required<ProjectionOptions>,
): ProjectionSnapshot {
  const existing = snapshot.sessions.get(sessionKey);
  if (
    existing !== undefined &&
    snapshot.lru.at(-1) === sessionKey &&
    snapshot.lru.length <= options.maxWarmSessions &&
    snapshot.activeSessionKey !== undefined &&
    snapshot.lru.includes(snapshot.activeSessionKey)
  ) {
    return snapshot;
  }
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
  arrivalOrdinal?: number,
): ProjectionSnapshot {
  const warmed = touch(snapshot, sessionKey, options);
  const current = warmed.sessions.get(sessionKey)!;
  const updated = update(current);
  if (updated === current) {
    if (arrivalOrdinal === undefined || warmed.arrivalOrdinal === arrivalOrdinal) return warmed;
    return Object.freeze({ ...warmed, arrivalOrdinal });
  }
  const sessions = mapWith(warmed.sessions, sessionKey, Object.freeze(updated));
  return arrivalOrdinal === undefined
    ? Object.freeze({ ...warmed, sessions })
    : Object.freeze({ ...warmed, sessions, arrivalOrdinal });
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
export function withoutHostRefOrdinals(
  ordinals: ReadonlyMap<string, number>,
  hostId: string,
): ReadonlyMap<string, number> {
  const prefix = `${hostId}\u0000`;
  let next: Map<string, number> | undefined;
  for (const sessionKey of ordinals.keys()) {
    if (!sessionKey.startsWith(prefix)) continue;
    next ??= new Map(ordinals);
    next.delete(sessionKey);
  }
  return next === undefined ? ordinals : immutableMap(next);
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

function applyProjectionInput(
  snapshot: ProjectionSnapshot,
  frame: ProjectionInputFrame,
  options: ProjectionOptions = {},
): ProjectionSnapshot {
  const config = resolveProjectionOptions(options);
  const resourceReduction = reduceResourceProjection(snapshot, frame, config, {
    immutableMap,
    key,
    mapWith,
    withSession: (resourceSnapshot, sessionKey, update) =>
      withSession(resourceSnapshot, sessionKey, update, config),
  });
  if (resourceReduction !== undefined) return resourceReduction;
  switch (frame.type) {
    case "workspace.state": {
      const host = boundedIdentity(frame.hostId);
      const workspaceId = boundedIdentity(frame.workspaceId);
      if (host === undefined || workspaceId === undefined) return snapshot;
      const previousCursor = snapshot.workspaceCursors.get(host);
      if (
        previousCursor !== undefined &&
        previousCursor.epoch === frame.cursor.epoch &&
        frame.cursor.seq <= previousCursor.seq
      )
        return snapshot;
      let workspaces = snapshot.workspaces;
      if (frame.upsert !== undefined) {
        const workspace = decodeWorkspaceInfrastructureProjection(frame.upsert);
        if (workspace.id !== workspaceId) return snapshot;
        workspaces = mapWith(
          workspaces,
          key(host, workspaceId),
          Object.freeze(workspace),
          config.maxWorkspaces,
        );
      } else if (frame.remove !== undefined) {
        if (String(frame.remove) !== workspaceId) return snapshot;
        workspaces = mapWithout(workspaces, key(host, workspaceId));
      } else {
        return snapshot;
      }
      return Object.freeze({
        ...snapshot,
        workspaces,
        workspaceCursors: mapWith(
          snapshot.workspaceCursors,
          host,
          Object.freeze({ ...frame.cursor }),
          config.maxWorkspaces,
        ),
      });
    }
    case "sessions": {
      const arrivalOrdinal = nextArrivalOrdinal(snapshot);
      const refs = frame.sessions
        .slice(0, config.maxIndexedSessions)
        .map((ref) => sanitizeSessionRef(ref))
        .filter((ref): ref is SessionRef => ref !== undefined);
      const authoritativeHosts = authoritativeSessionHosts(frame, refs);
      for (const host of authoritativeHosts) {
        const previousCursor = snapshot.sessionInventoryCursors.get(host);
        if (
          previousCursor !== undefined &&
          previousCursor.epoch === frame.cursor.epoch &&
          frame.cursor.seq < previousCursor.seq
        )
          return snapshot;
      }
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
      // A bounded inventory page is authoritative for every row it returned.
      // Repeated mapWith calls against a full, differently ordered cached page
      // can evict an upcoming returned row, reinsert it later, and cascade that
      // eviction through the page. Build the two capped maps atomically so all
      // returned refs survive and their current-arrival markers stay aligned.
      const retainedCapacity = Math.max(0, config.maxIndexedSessions - refs.length);
      const retainedCandidates = [...sessionIndex.entries()]
        .filter(([existingKey]) => !incomingKeys.has(existingKey))
        .sort(
          ([leftKey, left], [rightKey, right]) =>
            String(left.updatedAt).localeCompare(String(right.updatedAt)) ||
            leftKey.localeCompare(rightKey),
        );
      const retainedEntries =
        retainedCapacity === 0 ? [] : retainedCandidates.slice(-retainedCapacity);
      const incomingEntries = refs.map(
        (ref) => [key(String(ref.hostId), String(ref.sessionId)), ref] as const,
      );
      sessionIndex = immutableMap([...retainedEntries, ...incomingEntries]);
      const retainedKeys = new Set(retainedEntries.map(([existingKey]) => existingKey));
      const retainedOrdinalEntries = [...snapshot.sessionRefArrivalOrdinals.entries()].filter(
        ([existingKey]) => {
          if (!retainedKeys.has(existingKey)) return false;
          const existingRef = snapshot.sessionIndex.get(existingKey);
          return existingRef !== undefined && !authoritativeHosts.has(String(existingRef.hostId));
        },
      );
      sessionRefArrivalOrdinals = immutableMap([
        ...retainedOrdinalEntries,
        ...incomingEntries.map(([sessionKey]) => [sessionKey, arrivalOrdinal] as const),
      ]);
      const lru = freezeArray(snapshot.lru.filter((sessionKey) => sessions.has(sessionKey)));
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
      let sessionInventoryCursors = snapshot.sessionInventoryCursors;
      for (const hostId of authoritativeHosts) {
        sessionInventoryCursors = mapWith(
          sessionInventoryCursors,
          hostId,
          Object.freeze({ ...frame.cursor }),
          config.maxIndexedSessions,
        );
      }
      let next = Object.freeze({
        ...snapshot,
        sessionIndex,
        sessionIndexMetadata,
        sessionRefArrivalOrdinals,
        sessionDeltaCursors,
        sessionInventoryCursors,
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
      const current = snapshot.sessions.get(sessionKey);
      if (
        current?.cursor !== undefined &&
        current.cursor.epoch === frame.cursor.epoch &&
        (frame.cursor.seq < current.cursor.seq ||
          (frame.cursor.seq === current.cursor.seq && current.freshness !== "cached"))
      )
        return snapshot;
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
        frame.type === "event" ? eventArrivalOrdinal : undefined,
      );
      return next;
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
    case "welcome": {
      // A welcome starts a new inventory bootstrap even when the durable
      // session epoch is unchanged. Retain cached/indexed rows for continuity,
      // but do not let their old completeness metadata prove that a route is
      // gone until the host sends the next authoritative sessions frame.
      const sessionIndexMetadata = mapWithout(snapshot.sessionIndexMetadata, String(frame.hostId));
      const sessionInventoryCursors = mapWithout(
        snapshot.sessionInventoryCursors,
        String(frame.hostId),
      );
      const sessionRefArrivalOrdinals = withoutHostRefOrdinals(
        snapshot.sessionRefArrivalOrdinals,
        String(frame.hostId),
      );
      const epochChanged = snapshot.epoch !== undefined && snapshot.epoch !== frame.epoch;
      const sessions = immutableMap(
        [...snapshot.sessions.entries()].map(([sessionKey, session]) => {
          if (String(session.hostId) !== String(frame.hostId))
            return [sessionKey, session] as const;
          return [
            sessionKey,
            Object.freeze({
              ...session,
              ...(epochChanged
                ? {
                    freshness: "catching-up" as const,
                    transcriptEventArrivalOrdinal: 0,
                    contextMaintenanceEventArrivalOrdinal: 0,
                  }
                : {}),
              // Preview cursors describe one live browser connection rather
              // than durable transcript history. They always need a fresh
              // baseline after the host reconnects, even in the same epoch.
              previews: immutableMap(
                [...session.previews.entries()].map(
                  ([previewMapKey, preview]) =>
                    [
                      previewMapKey,
                      Object.freeze({ ...preview, freshness: "catching-up" as const }),
                    ] as const,
                ),
              ),
            }),
          ] as const;
        }),
      );
      if (snapshot.epoch === undefined || snapshot.epoch === frame.epoch) {
        return updateRoot(
          Object.freeze({
            ...snapshot,
            sessionIndexMetadata,
            sessionInventoryCursors,
            sessionRefArrivalOrdinals,
            sessions,
          }),
          {
            epoch: frame.epoch,
            freshness: "fresh",
          },
        );
      }
      return Object.freeze({
        ...snapshot,
        sessionIndexMetadata,
        sessionInventoryCursors,
        sessionRefArrivalOrdinals,
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
