import { describe, expect, it } from "vite-plus/test";
import { hostId, revision, sessionId, type SessionRef } from "@t4-code/protocol";
import { MAX_INDEXED_SESSION_REFS } from "../src/projection.ts";
import {
  MAX_PROJECTION_CACHE_BYTES,
  ProjectionStore,
  applyPublicFrame,
  createProjectionSnapshot,
  decodeProjectionCacheValue,
  encodeProjectionCache,
  type ProjectionCacheStore,
  type ProjectionFrame,
} from "../src/index.ts";
const V = "omp-app/1" as const;
const HOST = hostId("projection-host");
function sessionKey(session: string): string { return `${String(HOST)}\u0000${session}`; }
function frame(type: "snapshot", session?: string): Extract<ProjectionFrame, { type: "snapshot" }>;
function frame(type: "event", session?: string): Extract<ProjectionFrame, { type: "event" }>;
function frame(type: "welcome", session?: string): Extract<ProjectionFrame, { type: "welcome" }>;
function frame(type: "snapshot" | "event" | "welcome", session = "session-a"): ProjectionFrame {
  if (type === "snapshot") return { v: V, type, cursor: { epoch: "e1", seq: 1 }, revision: revision("r1"), hostId: HOST, sessionId: sessionId(session), entries: [] };
  if (type === "event") return { v: V, type, cursor: { epoch: "e1", seq: 2 }, hostId: HOST, sessionId: sessionId(session), event: { type: "message.delta", text: "x" } };
  return { v: V, type: "welcome", selectedProtocol: V, hostId: HOST, ompVersion: "x", ompBuild: "x", appserverVersion: "x", appserverBuild: "x", epoch: "e1", grantedCapabilities: [], grantedFeatures: [], negotiatedLimits: {}, authentication: "local", resumed: false };
}
function ref(host: string, session: string, overrides: Partial<SessionRef> = {}): SessionRef {
  return {
    hostId: hostId(host),
    project: { projectId: `project-${host}` as never, name: "Project" },
    sessionId: sessionId(session),
    revision: revision("r1"),
    title: "Title",
    status: "active",
    updatedAt: "2026-07-11T00:00:00Z",
    liveState: { phase: "idle" },
    model: "model-a",
    ...overrides,
  };
}
function delta(host: string, session: string, cursorSeq: number, upsert?: SessionRef, remove?: string): Extract<ProjectionFrame, { type: "session.delta" }> {
  return {
    v: V,
    type: "session.delta",
    hostId: hostId(host),
    sessionId: sessionId(session),
    cursor: { epoch: "e1", seq: cursorSeq },
    revision: revision(`delta-${cursorSeq}`),
    ...(upsert === undefined ? {} : { upsert }),
    ...(remove === undefined ? {} : { remove: sessionId(remove) }),
  };
}

describe("client projections", () => {
  it("records bounded inventory metadata from explicit and legacy session lists", () => {
    const refs = Array.from({ length: 1000 }, (_, index) => ref(String(HOST), `listed-${index}`));
    const explicit = { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: refs, totalCount: 5000, truncated: true } as ProjectionFrame;
    const state = applyPublicFrame(createProjectionSnapshot(), explicit);
    expect(state.sessionIndex.size).toBe(1000);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({ totalCount: 5000, truncated: true });
    const legacy = applyPublicFrame(createProjectionSnapshot(), { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "legacy")] });
    expect(legacy.sessionIndexMetadata.get(String(HOST))).toEqual({ totalCount: 1, truncated: false });
  });

  it("invalidates inventory completeness on welcome until the next sessions frame", () => {
    const listed = ref(String(HOST), "cached");
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e1", seq: 1 },
      sessions: [listed],
      totalCount: 1,
      truncated: false,
    } as unknown as ProjectionFrame);
    expect(state.sessionIndexMetadata.has(String(HOST))).toBe(true);

    state = applyPublicFrame(state, frame("welcome"));
    expect(state.sessionIndex.has(sessionKey("cached"))).toBe(true);
    expect(state.sessionIndexMetadata.has(String(HOST))).toBe(false);

    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e1", seq: 2 },
      sessions: [listed],
      totalCount: 1,
      truncated: false,
    } as unknown as ProjectionFrame);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 1,
      truncated: false,
    });
  });

  it("reconciles authoritative session lists per host without retaining stale subagent rows", () => {
    const hostB = "projection-host-b";
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "keep"), ref(String(HOST), "stale"), ref(hostB, "other-host")],
    });
    state = applyPublicFrame(state, frame("snapshot", "stale"));
    state = applyPublicFrame(state, delta(String(HOST), "stale", 2, ref(String(HOST), "stale")));
    const replacement = {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e2", seq: 0 },
      sessions: [ref(String(HOST), "keep")],
      totalCount: 1,
      truncated: false,
    } as unknown as ProjectionFrame;
    state = applyPublicFrame(state, replacement);
    expect(state.sessionIndex.has(sessionKey("stale"))).toBe(false);
    expect(state.sessions.has(sessionKey("stale"))).toBe(false);
    expect(state.sessionDeltaCursors.has(sessionKey("stale"))).toBe(false);
    expect(state.lru).not.toContain(sessionKey("stale"));
    expect(state.sessionIndex.has(sessionKey("keep"))).toBe(true);
    expect(state.sessionIndex.has(`${hostB}\u0000other-host`)).toBe(true);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({ totalCount: 1, truncated: false });
    const empty = {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e2", seq: 1 },
      sessions: [],
      totalCount: 0,
      truncated: false,
    } as unknown as ProjectionFrame;
    state = applyPublicFrame(state, empty);
    expect([...state.sessionIndex.values()].some((session) => session.hostId === HOST)).toBe(false);
    expect(state.sessionIndex.has(`${hostB}\u0000other-host`)).toBe(true);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({ totalCount: 0, truncated: false });
  });

  it("retains absent indexed and warm sessions when the inventory is truncated", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "present"), ref(String(HOST), "not-in-page")],
    });
    state = applyPublicFrame(state, frame("snapshot", "not-in-page"));
    state = applyPublicFrame(
      state,
      delta(String(HOST), "not-in-page", 4, ref(String(HOST), "not-in-page")),
    );
    const truncated = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e1", seq: 2 },
      sessions: [ref(String(HOST), "present")],
      totalCount: 2,
      truncated: true,
    } as unknown as ProjectionFrame);
    expect(truncated.sessionIndex.has(sessionKey("not-in-page"))).toBe(true);
    expect(truncated.sessions.has(sessionKey("not-in-page"))).toBe(true);
    expect(truncated.sessionDeltaCursors.get(sessionKey("not-in-page"))?.seq).toBe(4);
    expect(truncated.lru).toContain(sessionKey("not-in-page"));
    expect(truncated.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 2,
      truncated: true,
    });
  });

  it("does not inflate an authoritative truncated total for omitted-session deltas", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "visible")],
      totalCount: 5000,
      truncated: true,
    } as unknown as ProjectionFrame);

    state = applyPublicFrame(
      state,
      delta(String(HOST), "omitted", 2, ref(String(HOST), "omitted")),
      { maxIndexedSessions: 1 },
    );
    state = applyPublicFrame(
      state,
      delta(String(HOST), "omitted", 3, ref(String(HOST), "omitted")),
      { maxIndexedSessions: 1 },
    );
    state = applyPublicFrame(
      state,
      delta(String(HOST), "absent-remove", 4, undefined, "absent-remove"),
      { maxIndexedSessions: 1 },
    );

    expect(state.sessionIndex.size).toBe(1);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 5000,
      truncated: true,
    });
  });

  it("orders index deltas independently without advancing warm transcript cursors", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 2 },
    });
    const listed = ref(String(HOST), "session-a");
    state = applyPublicFrame(state, { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [listed] });
    const changed = ref(String(HOST), "session-a", {
      revision: revision("r2"),
      title: "Changed",
      model: "model-b",
      liveState: { phase: "running", queue: 2 },
      contextUsage: { used: 20, limit: 100 },
    });
    const next = applyPublicFrame(state, delta(String(HOST), "session-a", 9, changed));
    expect(next.sessionIndex.get(sessionKey("session-a"))).toMatchObject({ title: "Changed", model: "model-b", contextUsage: { used: 20 }, liveState: { phase: "running", queue: 2 } });
    expect(next.sessions.get(sessionKey("session-a"))?.ref).toBe(next.sessionIndex.get(sessionKey("session-a")));
    expect(next.sessions.get(sessionKey("session-a"))?.cursor?.seq).toBe(2);
    expect(next.sessions.get(sessionKey("session-a"))?.revision).toBe("r2");
    expect(next.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(next.sessionDeltaCursors.get(sessionKey("session-a"))?.seq).toBe(9);
    const streamed = applyPublicFrame(next, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
    });
    expect(streamed.sessions.get(sessionKey("session-a"))?.events).toHaveLength(1);
    expect(streamed.sessions.get(sessionKey("session-a"))?.cursor?.seq).toBe(3);
    expect(streamed.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(applyPublicFrame(streamed, delta(String(HOST), "session-a", 9, changed))).toBe(streamed);
    expect(applyPublicFrame(streamed, delta(String(HOST), "session-a", 8, changed))).toBe(streamed);
  });

  it("retires transient message frames through an authoritative settlement id", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: { type: "message.update", entryId: "assistant:stream-1", text: "hello" },
    });
    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
      event: {
        type: "message.settled",
        transientEntryId: "assistant:stream-1",
        entryId: "durable-1",
      },
    });
    const afterSettlement = state.sessions.get(sessionKey("session-a"))!;
    expect(afterSettlement.events.map((event) => event.event.type)).toEqual([
      "message.settled",
    ]);
    state = applyPublicFrame(state, {
      v: V,
      type: "entry",
      cursor: { epoch: "e1", seq: 4 },
      revision: revision("r2"),
      hostId: HOST,
      sessionId: sessionId("session-a"),
      entry: {
        id: "durable-1" as never,
        parentId: null,
        hostId: HOST,
        sessionId: sessionId("session-a"),
        kind: "message",
        timestamp: "2026-07-11T00:00:00Z",
        data: { role: "assistant", text: "hello" },
      },
    });
    const settled = state.sessions.get(sessionKey("session-a"))!;
    expect(settled.revision).toBe("r2");
    expect(settled.events).toHaveLength(0);
    expect(settled.entries.map((entry) => entry.id)).toEqual(["durable-1"]);
  });
  it("uses the emitting owner cursor for remove-other deltas without touching transcript state", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "session-a"), ref(String(HOST), "session-b")] });
    const before = state.sessions.get(sessionKey("session-a"))!;
    state = applyPublicFrame(state, delta(String(HOST), "session-a", 2, undefined, "session-b"));
    const afterRemove = state.sessions.get(sessionKey("session-a"))!;
    expect(state.sessionIndex.has(sessionKey("session-b"))).toBe(false);
    expect(afterRemove.entries).toBe(before.entries);
    expect(afterRemove.events).toBe(before.events);
    expect(afterRemove.cursor?.seq).toBe(1);
    expect(afterRemove.freshness).toBe("fresh");
    expect(state.sessionDeltaCursors.get(sessionKey("session-a"))?.seq).toBe(2);
    state = applyPublicFrame(state, { ...frame("event"), cursor: { epoch: "e1", seq: 2 } });
    expect(state.sessions.get(sessionKey("session-a"))?.events).toHaveLength(1);
    expect(state.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
  });

  it("ignores stale owner removes even when they name another target", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "session-a"), ref(String(HOST), "session-b")] });
    state = applyPublicFrame(state, delta(String(HOST), "session-a", 2, ref(String(HOST), "session-a", { title: "Updated" })));
    expect(applyPublicFrame(state, delta(String(HOST), "session-a", 1, undefined, "session-b"))).toBe(state);
    expect(state.sessionIndex.has(sessionKey("session-b"))).toBe(true);
  });
  it("accepts the first index upsert independently of a newer warm transcript cursor", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "session-a")] });
    state = applyPublicFrame(state, { ...frame("snapshot"), cursor: { epoch: "e1", seq: 10 } });
    const warm = state.sessions.get(sessionKey("session-a"))!;
    const next = applyPublicFrame(state, delta(String(HOST), "session-a", 5, ref(String(HOST), "session-a", { title: "Indexed" })));
    expect(next).not.toBe(state);
    expect(next.sessionIndex.get(sessionKey("session-a"))?.title).toBe("Indexed");
    expect(next.sessions.get(sessionKey("session-a"))?.ref?.title).toBe("Indexed");
    expect(next.sessions.get(sessionKey("session-a"))?.cursor).toBe(warm.cursor);
    expect(next.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(next.sessionDeltaCursors.get(sessionKey("session-a"))?.seq).toBe(5);
  });


  it("never changes warm transcript freshness on skipped or epoch-changing index deltas", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const gap: ProjectionFrame = { v: V, type: "gap", hostId: HOST, sessionId: sessionId("session-a"), from: { epoch: "e1", seq: 2 }, to: { epoch: "e1", seq: 4 }, reason: "test" };
    state = applyPublicFrame(state, gap);
    const before = state.sessions.get(sessionKey("session-a"))!;
    state = applyPublicFrame(state, { ...delta(String(HOST), "session-a", 3, ref(String(HOST), "session-a", { title: "Skipped" })) });
    const afterSkipped = state.sessions.get(sessionKey("session-a"))!;
    expect(afterSkipped.freshness).toBe("catching-up");
    expect(afterSkipped.cursor).toEqual(before.cursor);
    expect(afterSkipped.gap).toBe(before.gap);
    let epochChanged = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    epochChanged = applyPublicFrame(epochChanged, { ...delta(String(HOST), "session-a", 1, ref(String(HOST), "session-a", { title: "New epoch" })), cursor: { epoch: "e2", seq: 1 } });
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.cursor?.epoch).toBe("e1");
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.cursor?.seq).toBe(1);
  });


  it("removes exact host/session refs, warm state, lru, and active pointer", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "remove-me")] });
    state = applyPublicFrame(state, frame("snapshot", "remove-me"));
    expect(state.activeSessionKey).toBe(sessionKey("remove-me"));
    state = applyPublicFrame(state, delta(String(HOST), "remove-me", 2, undefined, "remove-me"));
    expect(state.sessionIndex.has(sessionKey("remove-me"))).toBe(false);
    expect(state.sessions.has(sessionKey("remove-me"))).toBe(false);
    expect(state.lru).not.toContain(sessionKey("remove-me"));
    expect(state.activeSessionKey).toBeUndefined();
  });

  it("keeps delta updates isolated between hosts and sanitizes untrusted metadata", () => {
    const hostB = "projection-host-b";
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "shared"), ref(hostB, "shared")],
    });
    const unsafe = ref(String(HOST), "shared", { liveState: { phase: "running", token: "SECRET_TOKEN", endpoint: "https://secret.invalid", path: "../../outside" } });
    state = applyPublicFrame(state, delta(String(HOST), "shared", 2, unsafe));
    expect(state.sessionIndex.get(sessionKey("shared"))?.liveState).toEqual({ phase: "running", path: "../../outside" });
    expect(JSON.stringify(state.sessionIndex.get(sessionKey("shared")))).not.toContain("SECRET_TOKEN");
    expect(state.sessionIndex.has(`${hostB}\u0000shared`)).toBe(true);
    state = applyPublicFrame(state, delta(String(HOST), "shared", 3, undefined, "shared"));
    expect(state.sessionIndex.has(sessionKey("shared"))).toBe(false);
    expect(state.sessionIndex.has(`${hostB}\u0000shared`)).toBe(true);
  });

  it("round-trips inventory metadata and delta cursors through bounded cache", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: [ref(String(HOST), "cached")], totalCount: 5000, truncated: true } as ProjectionFrame);
    state = applyPublicFrame(state, delta(String(HOST), "cached", 2, ref(String(HOST), "cached", { title: "Cached update" })));
    const restored = decodeProjectionCacheValue(encodeProjectionCache(state));
    expect(restored?.sessionIndexMetadata.get(String(HOST))).toEqual({ totalCount: 5000, truncated: true });
    expect(restored?.sessionDeltaCursors.get(sessionKey("cached"))?.seq).toBe(2);
    expect(restored?.sessionIndex.get(sessionKey("cached"))?.title).toBe("Cached update");
  });

  it("restores the current warm session and revision without reviving a stale confirmation", () => {
    const store = new ProjectionStore();
    store.applyPublicFrame({
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [
        ref(String(HOST), "current", { updatedAt: "2026-07-11T00:00:00Z" }),
        ref(String(HOST), "newer", { updatedAt: "2026-07-12T00:00:00Z" }),
      ],
    });
    store.applyPublicFrame({
      ...frame("snapshot", "current"),
      revision: revision("current-warm-revision"),
    });
    store.applyPublicFrame({
      v: V,
      type: "confirmation",
      confirmationId: "stale-after-restart" as never,
      commandId: "stale-command" as never,
      hostId: HOST,
      sessionId: sessionId("current"),
      commandHash: "stale-hash",
      revision: revision("current-warm-revision"),
      expiresAt: "2999-01-01T00:00:00.000Z",
      summary: "must not survive restart",
    });
    store.activateSession(String(HOST), "current");

    const encoded = encodeProjectionCache(store.snapshot);
    const restored = decodeProjectionCacheValue(encoded);

    expect(encoded).not.toContain("stale-after-restart");
    expect(restored?.activeSessionKey).toBe(sessionKey("current"));
    expect(restored?.sessions.get(sessionKey("current"))?.revision).toBe("current-warm-revision");
    expect(restored?.sessions.get(sessionKey("current"))?.confirmations.size).toBe(0);
  });

  it("drops a stale cached selection, chooses the latest authoritative session, and clears an empty host", () => {
    const store = new ProjectionStore();
    store.applyPublicFrame({
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [
        ref(String(HOST), "a-old", { updatedAt: "2026-07-10T00:00:00Z" }),
        ref(String(HOST), "m-stale", { updatedAt: "2026-07-11T00:00:00Z" }),
        ref(String(HOST), "z-latest", { updatedAt: "2026-07-12T00:00:00Z" }),
      ],
    });
    store.applyPublicFrame(frame("snapshot", "m-stale"));
    store.activateSession(String(HOST), "m-stale");
    const cached = decodeProjectionCacheValue(encodeProjectionCache(store.snapshot))!;
    expect(cached.activeSessionKey).toBe(sessionKey("m-stale"));

    const reconciled = applyPublicFrame(cached, {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e2", seq: 0 },
      sessions: [
        ref(String(HOST), "a-old", { updatedAt: "2026-07-10T00:00:00Z" }),
        ref(String(HOST), "z-latest", { updatedAt: "2026-07-12T00:00:00Z" }),
      ],
      totalCount: 2,
      truncated: false,
    } as ProjectionFrame);
    expect(reconciled.sessionIndex.has(sessionKey("m-stale"))).toBe(false);
    expect(reconciled.sessions.has(sessionKey("m-stale"))).toBe(false);
    expect(reconciled.activeSessionKey).toBe(sessionKey("z-latest"));

    const empty = applyPublicFrame(reconciled, {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "e2", seq: 1 },
      sessions: [],
      totalCount: 0,
      truncated: false,
    } as ProjectionFrame);
    expect([...empty.sessionIndex.values()].some((item) => item.hostId === HOST)).toBe(false);
    expect(empty.sessions.size).toBe(0);
    expect(empty.activeSessionKey).toBeUndefined();
  });

  it("deduplicates cursors and durable IDs while preserving untouched identity", () => {
    let state = createProjectionSnapshot();
    state = applyPublicFrame(state, frame("snapshot"));
    const first = state.sessions.get("projection-host\u0000session-a")!;
    state = applyPublicFrame(state, frame("event"));
    const second = state.sessions.get("projection-host\u0000session-a")!;
    expect(second.events).toHaveLength(1);
    expect(applyPublicFrame(state, frame("event"))).toBe(state);
    expect(first.entries).toBe(second.entries);
    const other = applyPublicFrame(state, { ...frame("snapshot", "session-b"), cursor: { epoch: "e1", seq: 1 } });
    expect(other.sessions.get("projection-host\u0000session-a")).toBe(second);
  });
  it("indexes and caches all session refs through the 1000-ref contract", () => {
    const refs = Array.from({ length: 334 }, (_, index) => ({
      hostId: HOST,
      project: { projectId: `project-${index}` as never, name: `Project ${index}` },
      sessionId: sessionId(`session-${index}`),
      revision: revision(`revision-${index}`),
      title: `Session ${index}`,
      status: "active" as const,
      updatedAt: `2026-07-11T00:00:${String(index % 60).padStart(2, "0")}Z`,
      liveState: { phase: "idle" as const },
      model: `model-${index}`,
    }));
    const frameWithSessions: ProjectionFrame = { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: refs };
    const state = applyPublicFrame(createProjectionSnapshot(), frameWithSessions);
    expect(MAX_INDEXED_SESSION_REFS).toBe(1000);
    expect(state.sessionIndex.size).toBe(334);
    expect(state.sessionIndex.get(sessionKey("session-333"))?.title).toBe("Session 333");
    expect(state.sessionIndex.get(sessionKey("session-333"))?.model).toBe("model-333");
    const restored = decodeProjectionCacheValue(encodeProjectionCache(state));
    expect(restored?.sessionIndex.size).toBe(334);
    expect(restored?.sessionIndex.get(sessionKey("session-333"))?.title).toBe("Session 333");
    expect(restored?.sessionIndex.get(sessionKey("session-333"))?.model).toBe("model-333");
  });

  it("caps internal indexed refs deterministically at 1000", () => {
    const refs = Array.from({ length: 1001 }, (_, index) => ({
      hostId: HOST,
      project: { projectId: `project-${index}` as never, name: `Project ${index}` },
      sessionId: sessionId(`over-${index}`),
      revision: revision(`revision-${index}`),
      title: `Session ${index} ${"title ".repeat(12)}`,
      status: "active" as const,
      updatedAt: "2026-07-11T00:00:00Z",
      liveState: { phase: "idle" as const },
      model: `model-${index}-${"reasoning ".repeat(8)}`,
    }));
    const state = applyPublicFrame(createProjectionSnapshot(), { v: V, type: "sessions", cursor: { epoch: "e1", seq: 1 }, sessions: refs });
    expect(state.sessionIndex.size).toBe(1000);
    expect(state.sessionIndex.has(sessionKey("over-1000"))).toBe(false);
    const restored = decodeProjectionCacheValue(encodeProjectionCache(state));
    expect(restored?.sessionIndex.size).toBe(1000);
    expect(restored?.sessionIndex.get(sessionKey("over-999"))?.title).toContain("title");
    expect(restored?.sessionIndex.get(sessionKey("over-999"))?.model).toContain("reasoning");
  });

  it("pauses on gaps and replaces through a recovery snapshot", () => {
    let state = createProjectionSnapshot();
    state = applyPublicFrame(state, frame("snapshot"));
    const gap: ProjectionFrame = { v: V, type: "gap", hostId: HOST, sessionId: sessionId("session-a"), from: { epoch: "e1", seq: 2 }, to: { epoch: "e1", seq: 4 }, reason: "test" };
    state = applyPublicFrame(state, gap);
    expect(state.sessions.get("projection-host\u0000session-a")!.freshness).toBe("catching-up");
    state = applyPublicFrame(state, { ...frame("snapshot"), cursor: { epoch: "e2", seq: 4 }, entries: [] });
    expect(state.sessions.get("projection-host\u0000session-a")!.freshness).toBe("fresh");
    state = applyPublicFrame(state, { ...frame("event"), cursor: { epoch: "e1", seq: 3 } });
    expect(state.sessions.get(sessionKey("session-a"))!.events).toHaveLength(0);
    expect(state.sessions.get("projection-host\u0000session-a")!.epoch).toBe("e2");
  });

  it("keeps deterministic eight-session LRU and A-B-A continuity", () => {
    const store = new ProjectionStore();
    for (let i = 0; i < 7; i += 1) store.applyPublicFrame({ ...frame("snapshot", `session-${i}`), cursor: { epoch: "e1", seq: 1 } });
    store.activateSession(String(HOST), "session-0");
    store.applyPublicFrame({ ...frame("event", "session-0"), cursor: { epoch: "e1", seq: 2 } });
    store.activateSession(String(HOST), "session-1");
    store.activateSession(String(HOST), "session-0");
    expect(store.snapshot.sessions.get(sessionKey("session-0"))!.events).toHaveLength(1);
    store.applyPublicFrame({ ...frame("snapshot", "session-7"), cursor: { epoch: "e1", seq: 1 } });
    store.applyPublicFrame({ ...frame("snapshot", "session-8"), cursor: { epoch: "e1", seq: 1 } });
    expect(store.snapshot.sessions.size).toBe(8);
    expect(store.snapshot.sessions.has(sessionKey("session-2"))).toBe(false);
  });

  it("projects agents, terminal output, files, reviews, confirmations, audit, and results", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, { v: V, type: "agent", hostId: HOST, sessionId: sessionId("session-a"), agentId: "agent-a" as never, state: "running", progress: 0.5 });
    state = applyPublicFrame(state, { v: V, type: "terminal", hostId: HOST, sessionId: sessionId("session-a"), terminalId: "term-a" as never, stream: "stdout", data: "hello" });
    state = applyPublicFrame(state, { v: V, type: "terminal", hostId: HOST, sessionId: sessionId("session-a"), terminalId: "term-a" as never, stream: "exit", exitCode: 0 });
    state = applyPublicFrame(state, { v: V, type: "files", hostId: HOST, sessionId: sessionId("session-a"), path: "src/main.ts", content: "ok" });
    state = applyPublicFrame(state, { v: V, type: "review", hostId: HOST, sessionId: sessionId("session-a"), reviewId: "review-a", status: "open", findings: [] });
    state = applyPublicFrame(state, { v: V, type: "confirmation", confirmationId: "confirm-a" as never, commandId: "command-a" as never, hostId: HOST, sessionId: sessionId("session-a"), commandHash: "hash", revision: revision("r1"), expiresAt: "2030", summary: "approve" });
    state = applyPublicFrame(state, { v: V, type: "audit", hostId: HOST, sessionId: sessionId("session-a"), action: "test", actor: "test", timestamp: "2030" });
    state = applyPublicFrame(state, { v: V, type: "response", requestId: "request-a" as never, commandId: "command-a" as never, hostId: HOST, sessionId: sessionId("session-a"), ok: true, result: { answer: 42, token: "removed" } });
    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.agents.get("agent-a")?.state).toBe("running");
    expect(session.terminals.get("term-a")).toMatchObject({ stdout: "hello", exitCode: 0, closed: true });
    expect(session.files.get("src/main.ts")?.content).toBe("ok");
    expect(session.reviews.get("review-a")?.status).toBe("open");
    expect(session.confirmations.size).toBe(0);
    expect(session.audit).toHaveLength(1);
    expect(session.results.get("request-a")?.result).toEqual({ answer: 42 });
  });

  it("keeps the challenge after confirmation_invalid", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "confirmation",
      confirmationId: "confirm-live" as never,
      commandId: "command-live" as never,
      hostId: HOST,
      sessionId: sessionId("session-a"),
      commandHash: "hash-live",
      revision: revision("r1"),
      expiresAt: "2999-01-01T00:00:00.000Z",
      summary: "live challenge",
    });
    const invalidResponse = (request: string, command: string) => ({
      v: V,
      type: "response" as const,
      requestId: request as never,
      commandId: command as never,
      hostId: HOST,
      sessionId: sessionId("session-a"),
      ok: false,
      error: { code: "confirmation_invalid", message: "confirmation is invalid or expired" },
    });
    state = applyPublicFrame(state, invalidResponse("request-live", "command-live"));
    const confirmations = state.sessions.get(sessionKey("session-a"))!.confirmations;
    expect([...confirmations.keys()]).toEqual(["confirm-live"]);
  });

  it("retains a 10k snapshot and bounds 100k event throughput with structural sharing", () => {
    let state = createProjectionSnapshot();
    const entries = Array.from({ length: 10_000 }, (_, index) => ({ id: `entry-${index}` as never, parentId: null, hostId: HOST, sessionId: sessionId("session-a"), kind: "message", timestamp: String(index), data: { index } }));
    state = applyPublicFrame(state, { v: V, type: "snapshot", cursor: { epoch: "e1", seq: 1 }, revision: revision("r1"), hostId: HOST, sessionId: sessionId("session-a"), entries });
    state = applyPublicFrame(state, { ...frame("snapshot", "session-b"), cursor: { epoch: "e1", seq: 1 } });
    const untouched = state.sessions.get(sessionKey("session-b"));
    const started = performance.now();
    for (let index = 0; index < 100_000; index += 1) {
      state = applyPublicFrame(state, { v: V, type: "event", cursor: { epoch: "e1", seq: index + 2 }, hostId: HOST, sessionId: sessionId("session-a"), event: { type: "delta", index } });
    }
    const elapsedMs = performance.now() - started;
    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.entries).toHaveLength(10_000);
    expect(session.events).toHaveLength(512);
    expect(state.sessions.get(sessionKey("session-b"))).toBe(untouched);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(process.memoryUsage().heapUsed).toBeLessThan(512 * 1024 * 1024);
    const cached = decodeProjectionCacheValue(encodeProjectionCache(state));
    expect(cached?.sessions.get(sessionKey("session-a"))?.entries).toHaveLength(10_000);
  });

  it("codec bounds and rejects corrupt/old/oversized cache", () => {
    const state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const encoded = encodeProjectionCache(state, 1);
    expect(encoded.length).toBeLessThan(MAX_PROJECTION_CACHE_BYTES);
    expect(decodeProjectionCacheValue(encoded)?.freshness).toBe("cached");
    expect(decodeProjectionCacheValue("not-json")).toBeUndefined();
    expect(decodeProjectionCacheValue(JSON.stringify({ kind: "t4-code-projection", version: 0, data: {} }))).toBeUndefined();
    expect(decodeProjectionCacheValue("x".repeat(MAX_PROJECTION_CACHE_BYTES + 1))).toBeUndefined();
  });

  it("preserves an existing truncated-history marker across cache re-encoding", () => {
    const base = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const key = sessionKey("session-a");
    const warm = base.sessions.get(key)!;
    const truncated = Object.freeze({
      ...base,
      sessions: new Map([
        [key, Object.freeze({ ...warm, historyTruncated: true })],
      ]),
    });

    const restored = decodeProjectionCacheValue(encodeProjectionCache(truncated));
    expect(restored?.sessions.get(key)?.historyTruncated).toBe(true);
    const restoredAgain = decodeProjectionCacheValue(encodeProjectionCache(restored!));
    expect(restoredAgain?.sessions.get(key)?.historyTruncated).toBe(true);
  });

  it("serializes cache saves and disposes listeners", async () => {
    const saves: string[] = [];
    let release: (() => void) | undefined;
    const cacheStore: ProjectionCacheStore = {
      load: () => undefined,
      save: (serialized) => new Promise<void>((resolve) => { saves.push(serialized); release = resolve; }),
    };
    const store = new ProjectionStore({ cacheStore });
    let calls = 0;
    const dispose = store.subscribe(() => { calls += 1; });
    store.applyPublicFrame(frame("snapshot"));
    store.applyPublicFrame(frame("event"));
    expect(saves).toHaveLength(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(saves).toHaveLength(2);
    dispose();
    store.applyPublicFrame({ ...frame("event"), cursor: { epoch: "e1", seq: 3 } });
    expect(calls).toBe(2);
  });
});
