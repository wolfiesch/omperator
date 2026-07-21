import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { hostId, revision, sessionId, type DurableEntry, type SessionRef } from "@t4-code/protocol";
import { MAX_INDEXED_SESSION_REFS } from "../src/projection.ts";
import { PreviewCaptureResource, previewKey } from "../src/preview.ts";
import {
  MAX_PROJECTION_CACHE_BYTES,
  ProjectionStore,
  applyPublicEvent,
  applyPublicFrame,
  createProjectionSnapshot,
  decodeProjectionCacheValue,
  encodeProjectionCache,
  ompAppV1ProtocolProvider,
  type ProjectionCacheStore,
  type ProjectionFrame,
  type PublicOmpServerEvent,
} from "../src/index.ts";
const APP_WIRE_ROOT = dirname(dirname(fileURLToPath(import.meta.resolve("@t4-code/host-wire"))));
const AGENT_VIEW_CORPUS = JSON.parse(
  readFileSync(
    join(APP_WIRE_ROOT, "fixtures", "v1", "scenarios", "agent-view-lifecycle.json"),
    "utf8",
  ),
) as { schema: string; frames: ProjectionFrame[] };
const V = "omp-app/1" as const;
const HOST = hostId("projection-host");
function sessionKey(session: string): string {
  return `${String(HOST)}\u0000${session}`;
}
function publicEvent(input: ProjectionFrame): PublicOmpServerEvent {
  const event = ompAppV1ProtocolProvider.decodeServerEvent(input);
  if (event.kind === "pair.ok") throw new Error("pair.ok is not a public projection event");
  return event;
}
function frame(type: "snapshot", session?: string): Extract<ProjectionFrame, { type: "snapshot" }>;
function frame(type: "event", session?: string): Extract<ProjectionFrame, { type: "event" }>;
function frame(type: "welcome", session?: string): Extract<ProjectionFrame, { type: "welcome" }>;
function frame(type: "snapshot" | "event" | "welcome", session = "session-a"): ProjectionFrame {
  if (type === "snapshot")
    return {
      v: V,
      type,
      cursor: { epoch: "e1", seq: 1 },
      revision: revision("r1"),
      hostId: HOST,
      sessionId: sessionId(session),
      entries: [],
    };
  if (type === "event")
    return {
      v: V,
      type,
      cursor: { epoch: "e1", seq: 2 },
      hostId: HOST,
      sessionId: sessionId(session),
      event: { type: "message.delta", text: "x" },
    };
  return {
    v: V,
    type: "welcome",
    selectedProtocol: V,
    hostId: HOST,
    ompVersion: "x",
    ompBuild: "x",
    appserverVersion: "x",
    appserverBuild: "x",
    epoch: "e1",
    grantedCapabilities: [],
    grantedFeatures: [],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
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
function delta(
  host: string,
  session: string,
  cursorSeq: number,
  upsert?: SessionRef,
  remove?: string,
): Extract<ProjectionFrame, { type: "session.delta" }> {
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
function childEntry(id: string, text: string): DurableEntry {
  return {
    id: id as never,
    parentId: null,
    hostId: HOST,
    sessionId: sessionId("session-a"),
    kind: "message",
    timestamp: `2026-07-15T00:00:0${id.length}.000Z`,
    data: { role: "assistant", text },
  };
}
function childTranscript(
  seq: number,
  entries: readonly DurableEntry[],
  epoch = "child-e1",
): Extract<ProjectionFrame, { type: "agent.transcript" }> {
  return {
    v: V,
    type: "agent.transcript",
    hostId: HOST,
    sessionId: sessionId("session-a"),
    agentId: "agent-a" as never,
    cursor: { epoch, seq },
    entries: [...entries],
    revision: revision(`child-r${seq}`),
  };
}

const UTF8 = new TextEncoder();
function projectionTerminalBytes(session: {
  readonly terminals: ReadonlyMap<
    string,
    { readonly terminalId: string; readonly stdout: string; readonly stderr: string }
  >;
}): number {
  let bytes = 0;
  for (const terminal of session.terminals.values()) {
    bytes += UTF8.encode(terminal.terminalId).byteLength;
    bytes += UTF8.encode(terminal.stdout).byteLength;
    bytes += UTF8.encode(terminal.stderr).byteLength;
  }
  return bytes;
}
function projectionFileBytes(session: {
  readonly files: ReadonlyMap<string, { readonly path: string; readonly content?: string }>;
}): number {
  let bytes = 0;
  for (const file of session.files.values()) {
    bytes += UTF8.encode(file.path).byteLength;
    if (file.content !== undefined) bytes += UTF8.encode(file.content).byteLength;
  }
  return bytes;
}

describe("client projections", () => {
  it("projects normalized provider events with the same state changes as raw frames", () => {
    const inputs = [frame("welcome"), frame("snapshot"), frame("event")];
    let rawState = createProjectionSnapshot();
    let eventState = createProjectionSnapshot();

    for (const input of inputs) {
      rawState = applyPublicFrame(rawState, input);
      eventState = applyPublicEvent(eventState, publicEvent(input));
    }

    const rawSession = rawState.sessions.get(sessionKey("session-a"))!;
    const eventSession = eventState.sessions.get(sessionKey("session-a"))!;
    expect(eventState.cursor).toEqual(rawState.cursor);
    expect(eventState.epoch).toBe(rawState.epoch);
    expect(eventState.activeSessionKey).toBe(rawState.activeSessionKey);
    expect(eventSession).toEqual({ ...rawSession, events: eventSession.events });
    expect(eventSession.events).toEqual([
      {
        type: "event",
        cursor: { epoch: "e1", seq: 2 },
        hostId: HOST,
        sessionId: sessionId("session-a"),
        event: { type: "message.delta", text: "x" },
      },
    ]);
    expect(eventSession.events[0]).not.toHaveProperty("v");
    const restored = decodeProjectionCacheValue(encodeProjectionCache(eventState));
    expect(restored?.sessions.get(sessionKey("session-a"))?.events).toEqual(eventSession.events);
  });

  it("lets ProjectionStore subscribers receive normalized events", () => {
    const store = new ProjectionStore();
    const event = publicEvent(frame("snapshot"));
    let observed: unknown;
    store.subscribe((_snapshot, input) => {
      observed = input;
    });

    store.applyPublicEvent(event);

    expect(observed).toBe(event);
    expect(store.snapshot.sessions.has(sessionKey("session-a"))).toBe(true);
  });

  it("records bounded inventory metadata from explicit and legacy session lists", () => {
    const refs = Array.from({ length: 1000 }, (_, index) => ref(String(HOST), `listed-${index}`));
    const explicit = {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: refs,
      totalCount: 5000,
      truncated: true,
    } as ProjectionFrame;
    const state = applyPublicFrame(createProjectionSnapshot(), explicit);
    expect(state.sessionIndex.size).toBe(1000);
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 5000,
      truncated: true,
    });
    const legacy = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "legacy")],
    });
    expect(legacy.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 1,
      truncated: false,
    });
  });

  it("rejects a delayed lower same-epoch session inventory without regressing the index", () => {
    const currentRef = ref(String(HOST), "ordered", { title: "Current" });
    const staleRef = ref(String(HOST), "ordered", { title: "Stale" });
    const current = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "ordered-inventory", seq: 5 },
      sessions: [currentRef],
      totalCount: 1,
      truncated: false,
    } as ProjectionFrame);
    const staleFrame = {
      v: V,
      type: "sessions",
      hostId: HOST,
      cursor: { epoch: "ordered-inventory", seq: 4 },
      sessions: [staleRef],
      totalCount: 1,
      truncated: false,
    } as ProjectionFrame;

    expect(applyPublicFrame(current, staleFrame)).toBe(current);
    expect(current.sessionIndex.get(sessionKey("ordered"))?.title).toBe("Current");
    expect(current.sessionInventoryCursors.get(String(HOST))?.seq).toBe(5);

    const restored = decodeProjectionCacheValue(encodeProjectionCache(current))!;
    expect(applyPublicFrame(restored, staleFrame)).toBe(restored);
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

    expect(state.sessionInventoryCursors.has(String(HOST))).toBe(false);
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
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 1,
      truncated: false,
    });
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
    expect(state.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 0,
      truncated: false,
    });
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
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [listed],
    });
    const changed = ref(String(HOST), "session-a", {
      revision: revision("r2"),
      title: "Changed",
      model: "model-b",
      liveState: { phase: "running", queue: 2 },
      contextUsage: { used: 20, limit: 100 },
    });
    const next = applyPublicFrame(state, delta(String(HOST), "session-a", 9, changed));
    expect(next.sessionIndex.get(sessionKey("session-a"))).toMatchObject({
      title: "Changed",
      model: "model-b",
      contextUsage: { used: 20 },
      liveState: { phase: "running", queue: 2 },
    });
    expect(next.sessions.get(sessionKey("session-a"))?.ref).toBe(
      next.sessionIndex.get(sessionKey("session-a")),
    );
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

  it("retires transient message frames and retains authoritative settlement correlation", () => {
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
    expect(afterSettlement.events.map((event) => event.event.type)).toEqual(["message.settled"]);
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
    expect(settled.events.map((event) => event.event.type)).toEqual(["message.settled"]);
    expect(settled.entries.map((entry) => entry.id)).toEqual(["durable-1"]);
  });

  it("retires a transient message update when the prompt is discarded", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: { type: "message.update", entryId: "prompt:request-1", role: "user", text: "hello" },
    });
    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
      event: {
        type: "message.discarded",
        transientEntryId: "prompt:request-1",
        reason: "prompt_failed",
      },
    });
    expect(
      state.sessions.get(sessionKey("session-a"))?.events.map((event) => event.event.type),
    ).toEqual(["message.discarded"]);
  });
  it("retires a transient message update for the legacy discarded entryId shape", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: {
        type: "message.update",
        entryId: "prompt:request-legacy",
        role: "user",
        text: "hello",
      },
    });
    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
      event: {
        type: "message.discarded",
        entryId: "prompt:request-legacy",
        reason: "prompt_failed",
      },
    });
    expect(
      state.sessions.get(sessionKey("session-a"))?.events.map((event) => event.event.type),
    ).toEqual(["message.discarded"]);
  });
  it("preserves same-epoch retirement markers through a recovery snapshot", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: {
        type: "message.settled",
        transientEntryId: "prompt:settled",
        entryId: "durable:settled",
      },
    });
    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
      event: {
        type: "message.discarded",
        transientEntryId: "prompt:discarded",
        reason: "prompt_failed",
      },
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "gap",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      from: { epoch: "e1", seq: 3 },
      to: { epoch: "e1", seq: 4 },
      reason: "replay_budget_exceeded",
    });
    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 4 },
    });
    expect(
      state.sessions.get(sessionKey("session-a"))?.events.map((event) => event.event.type),
    ).toEqual(["message.settled", "message.discarded"]);

    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e2", seq: 1 },
    });
    expect(state.sessions.get(sessionKey("session-a"))?.events).toEqual([]);
  });
  it("rejects a stale same-epoch snapshot without replacing newer projection state", () => {
    const freshEntry = childEntry("fresh-entry", "fresh");
    const staleEntry = childEntry("stale-entry", "stale");
    const state = applyPublicFrame(createProjectionSnapshot(), {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 10 },
      revision: revision("fresh-revision"),
      entries: [freshEntry],
    });
    const stale = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 9 },
      revision: revision("stale-revision"),
      entries: [staleEntry],
    });

    expect(stale).toBe(state);
    expect(stale.sessions.get(sessionKey("session-a"))?.cursor).toEqual({ epoch: "e1", seq: 10 });
    expect(stale.sessions.get(sessionKey("session-a"))?.entries).toEqual([freshEntry]);
  });

  it("accepts an equal-cursor live snapshot to refresh a cached baseline", () => {
    const cached = decodeProjectionCacheValue(
      encodeProjectionCache(
        applyPublicFrame(createProjectionSnapshot(), {
          ...frame("snapshot"),
          cursor: { epoch: "e1", seq: 10 },
          entries: [childEntry("cached-entry", "cached")],
        }),
      ),
    )!;
    const refreshed = applyPublicFrame(cached, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 10 },
      revision: revision("live-revision"),
      entries: [childEntry("live-entry", "live")],
    });

    expect(refreshed.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(refreshed.sessions.get(sessionKey("session-a"))?.revision).toBe("live-revision");
    expect(refreshed.sessions.get(sessionKey("session-a"))?.entries[0]?.id).toBe("live-entry");
  });
  it("uses the emitting owner cursor for remove-other deltas without touching transcript state", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "session-a"), ref(String(HOST), "session-b")],
    });
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
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "session-a"), ref(String(HOST), "session-b")],
    });
    state = applyPublicFrame(
      state,
      delta(String(HOST), "session-a", 2, ref(String(HOST), "session-a", { title: "Updated" })),
    );
    expect(
      applyPublicFrame(state, delta(String(HOST), "session-a", 1, undefined, "session-b")),
    ).toBe(state);
    expect(state.sessionIndex.has(sessionKey("session-b"))).toBe(true);
  });
  it("accepts the first index upsert independently of a newer warm transcript cursor", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "session-a")],
    });
    state = applyPublicFrame(state, { ...frame("snapshot"), cursor: { epoch: "e1", seq: 10 } });
    const warm = state.sessions.get(sessionKey("session-a"))!;
    const next = applyPublicFrame(
      state,
      delta(String(HOST), "session-a", 5, ref(String(HOST), "session-a", { title: "Indexed" })),
    );
    expect(next).not.toBe(state);
    expect(next.sessionIndex.get(sessionKey("session-a"))?.title).toBe("Indexed");
    expect(next.sessions.get(sessionKey("session-a"))?.ref?.title).toBe("Indexed");
    expect(next.sessions.get(sessionKey("session-a"))?.cursor).toBe(warm.cursor);
    expect(next.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(next.sessionDeltaCursors.get(sessionKey("session-a"))?.seq).toBe(5);
  });

  it("never changes warm transcript freshness on skipped or epoch-changing index deltas", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const gap: ProjectionFrame = {
      v: V,
      type: "gap",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      from: { epoch: "e1", seq: 2 },
      to: { epoch: "e1", seq: 4 },
      reason: "test",
    };
    state = applyPublicFrame(state, gap);
    const before = state.sessions.get(sessionKey("session-a"))!;
    state = applyPublicFrame(state, {
      ...delta(String(HOST), "session-a", 3, ref(String(HOST), "session-a", { title: "Skipped" })),
    });
    const afterSkipped = state.sessions.get(sessionKey("session-a"))!;
    expect(afterSkipped.freshness).toBe("catching-up");
    expect(afterSkipped.cursor).toEqual(before.cursor);
    expect(afterSkipped.gap).toBe(before.gap);
    let epochChanged = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    epochChanged = applyPublicFrame(epochChanged, {
      ...delta(
        String(HOST),
        "session-a",
        1,
        ref(String(HOST), "session-a", { title: "New epoch" }),
      ),
      cursor: { epoch: "e2", seq: 1 },
    });
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.cursor?.epoch).toBe("e1");
    expect(epochChanged.sessions.get(sessionKey("session-a"))?.cursor?.seq).toBe(1);
  });

  it("removes exact host/session refs, warm state, lru, and active pointer", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "remove-me")],
    });
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
    const unsafe = ref(String(HOST), "shared", {
      liveState: {
        phase: "running",
        token: "SECRET_TOKEN",
        endpoint: "https://secret.invalid",
        path: "../../outside",
      },
    });
    state = applyPublicFrame(state, delta(String(HOST), "shared", 2, unsafe));
    expect(state.sessionIndex.get(sessionKey("shared"))?.liveState).toEqual({
      phase: "running",
      path: "../../outside",
    });
    expect(JSON.stringify(state.sessionIndex.get(sessionKey("shared")))).not.toContain(
      "SECRET_TOKEN",
    );
    expect(state.sessionIndex.has(`${hostB}\u0000shared`)).toBe(true);
    state = applyPublicFrame(state, delta(String(HOST), "shared", 3, undefined, "shared"));
    expect(state.sessionIndex.has(sessionKey("shared"))).toBe(false);
    expect(state.sessionIndex.has(`${hostB}\u0000shared`)).toBe(true);
  });

  it("round-trips inventory metadata and delta cursors through bounded cache", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: [ref(String(HOST), "cached")],
      totalCount: 5000,
      truncated: true,
    } as ProjectionFrame);
    state = applyPublicFrame(
      state,
      delta(String(HOST), "cached", 2, ref(String(HOST), "cached", { title: "Cached update" })),
    );
    const restored = decodeProjectionCacheValue(encodeProjectionCache(state));
    expect(restored?.sessionIndexMetadata.get(String(HOST))).toEqual({
      totalCount: 5000,
      truncated: true,
    });
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
    const other = applyPublicFrame(state, {
      ...frame("snapshot", "session-b"),
      cursor: { epoch: "e1", seq: 1 },
    });
    expect(other.sessions.get("projection-host\u0000session-a")).toBe(second);
  });

  it("orders session refs and accepted transcript events across independent cursors", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 1 },
      sessions: [ref(String(HOST), "session-a")],
      totalCount: 1,
      truncated: false,
    });
    const refBeforeEvent = state.sessionRefArrivalOrdinals.get(sessionKey("session-a"))!;

    state = applyPublicFrame(state, frame("event"));
    const eventOrdinal = state.sessions.get(sessionKey("session-a"))!.transcriptEventArrivalOrdinal;
    expect(refBeforeEvent).toBeLessThan(eventOrdinal);
    expect(state.arrivalOrdinal).toBe(eventOrdinal);

    const duplicate = applyPublicFrame(state, frame("event"));
    expect(duplicate).toBe(state);
    expect(duplicate.arrivalOrdinal).toBe(eventOrdinal);

    const gapped = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 4 },
    });
    expect(gapped.arrivalOrdinal).toBe(eventOrdinal);
    expect(gapped.sessions.get(sessionKey("session-a"))?.transcriptEventArrivalOrdinal).toBe(
      eventOrdinal,
    );
  });

  it("records a later session delta after the newest transcript event", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, frame("event"));
    const eventOrdinal = state.sessions.get(sessionKey("session-a"))!.transcriptEventArrivalOrdinal;

    state = applyPublicFrame(
      state,
      delta(String(HOST), "session-a", 1, ref(String(HOST), "session-a")),
    );
    expect(state.sessionRefArrivalOrdinals.get(sessionKey("session-a"))).toBeGreaterThan(
      eventOrdinal,
    );
  });

  it("orders only unconditional context lifecycle events against authoritative refs", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 0 },
      sessions: [
        ref(String(HOST), "session-a", {
          liveState: { isCompacting: true },
        }),
      ],
      totalCount: 1,
      truncated: false,
    });
    const compactingRefOrdinal = state.sessionRefArrivalOrdinals.get(sessionKey("session-a"))!;

    state = applyPublicFrame(state, {
      ...frame("event"),
      event: { type: "agent.event", detail: "inspection only" },
    });
    const afterInspect = state.sessions.get(sessionKey("session-a"))!;
    expect(afterInspect.transcriptEventArrivalOrdinal).toBeGreaterThan(compactingRefOrdinal);
    expect(afterInspect.contextMaintenanceEventArrivalOrdinal).toBe(0);

    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 3 },
      event: { type: "compaction.end", at: "2026-07-15T00:00:03Z" },
    });
    const compactionEndOrdinal = state.sessions.get(
      sessionKey("session-a"),
    )!.contextMaintenanceEventArrivalOrdinal;
    expect(compactionEndOrdinal).toBeGreaterThan(compactingRefOrdinal);

    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 0 },
      sessions: [
        ref(String(HOST), "session-a", {
          revision: revision("r2"),
          liveState: { isCompacting: true },
        }),
      ],
      totalCount: 1,
      truncated: false,
    });
    const newerCompactingRefOrdinal = state.sessionRefArrivalOrdinals.get(sessionKey("session-a"))!;
    expect(newerCompactingRefOrdinal).toBeGreaterThan(compactionEndOrdinal);

    state = applyPublicFrame(state, {
      ...frame("event"),
      cursor: { epoch: "e1", seq: 4 },
      event: { type: "turn.start", at: "2026-07-15T00:00:04Z" },
    });
    const turnStartOrdinal = state.sessions.get(
      sessionKey("session-a"),
    )!.contextMaintenanceEventArrivalOrdinal;
    expect(turnStartOrdinal).toBeGreaterThan(newerCompactingRefOrdinal);

    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 4 },
    });
    expect(state.sessions.get(sessionKey("session-a"))!.contextMaintenanceEventArrivalOrdinal).toBe(
      turnStartOrdinal,
    );

    state = applyPublicFrame(state, {
      v: V,
      type: "gap",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      from: { epoch: "e1", seq: 5 },
      to: { epoch: "e1", seq: 6 },
      reason: "replay_budget_exceeded",
    });
    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 6 },
    });
    expect(state.sessions.get(sessionKey("session-a"))!.contextMaintenanceEventArrivalOrdinal).toBe(
      0,
    );
  });

  it("does not persist process-local arrival ordering in projection caches", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 1 },
      sessions: [ref(String(HOST), "session-a")],
      totalCount: 1,
      truncated: false,
    });
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: { type: "compaction.start", reason: "manual" },
    });
    expect(state.arrivalOrdinal).toBeGreaterThan(0);
    expect(
      state.sessions.get(sessionKey("session-a"))?.contextMaintenanceEventArrivalOrdinal,
    ).toBeGreaterThan(0);

    const encoded = encodeProjectionCache(state);
    const restored = decodeProjectionCacheValue(encoded)!;
    expect(encoded).not.toContain("arrivalOrdinal");
    expect(restored.arrivalOrdinal).toBe(0);
    expect(restored.sessionRefArrivalOrdinals.size).toBe(0);
    expect(restored.sessions.get(sessionKey("session-a"))?.transcriptEventArrivalOrdinal).toBe(0);
    expect(
      restored.sessions.get(sessionKey("session-a"))?.contextMaintenanceEventArrivalOrdinal,
    ).toBe(0);
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
    const frameWithSessions: ProjectionFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: refs,
    };
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
    const state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "sessions",
      cursor: { epoch: "e1", seq: 1 },
      sessions: refs,
    });
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
    const gap: ProjectionFrame = {
      v: V,
      type: "gap",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      from: { epoch: "e1", seq: 2 },
      to: { epoch: "e1", seq: 4 },
      reason: "test",
    };
    state = applyPublicFrame(state, gap);
    expect(state.sessions.get("projection-host\u0000session-a")!.freshness).toBe("catching-up");
    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e2", seq: 4 },
      entries: [],
    });
    expect(state.sessions.get("projection-host\u0000session-a")!.freshness).toBe("fresh");
    state = applyPublicFrame(state, { ...frame("event"), cursor: { epoch: "e1", seq: 3 } });
    expect(state.sessions.get(sessionKey("session-a"))!.events).toHaveLength(0);
    expect(state.sessions.get("projection-host\u0000session-a")!.epoch).toBe("e2");
  });

  it("preserves same-epoch warm events on a fresh snapshot but clears them during recovery", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      ...frame("event"),
      event: {
        type: "ask.request",
        askId: "pending-ask",
        question: "Choose",
        options: [],
      },
    });
    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 2 },
    });
    expect(
      state.sessions.get(sessionKey("session-a"))?.events.map((event) => event.event.type),
    ).toEqual(["ask.request"]);
    expect(
      state.sessions.get(sessionKey("session-a"))?.transcriptEventArrivalOrdinal,
    ).toBeGreaterThan(0);

    state = applyPublicFrame(state, {
      v: V,
      type: "gap",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      from: { epoch: "e1", seq: 3 },
      to: { epoch: "e1", seq: 4 },
      reason: "replay_budget_exceeded",
    });
    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 4 },
    });
    expect(state.sessions.get(sessionKey("session-a"))?.events).toEqual([]);
    expect(state.sessions.get(sessionKey("session-a"))?.transcriptEventArrivalOrdinal).toBe(0);
  });

  it("promotes a cached session only when an accepted attach acknowledges its exact cursor", () => {
    const live = applyPublicFrame(createProjectionSnapshot(), {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 7 },
    });
    const cached = decodeProjectionCacheValue(encodeProjectionCache(live))!;
    expect(cached.sessions.get(sessionKey("session-a"))?.freshness).toBe("cached");

    const acknowledged = applyPublicFrame(cached, {
      v: V,
      type: "response",
      requestId: "attach-exact" as never,
      commandId: "attach-command-exact" as never,
      command: "session.attach",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      ok: true,
      result: { attached: true, cursor: { epoch: "e1", seq: 7 } },
    });
    expect(acknowledged.sessions.get(sessionKey("session-a"))?.freshness).toBe("fresh");
  });

  it("keeps cached session state gated when an attach baseline is ahead or different", () => {
    const live = applyPublicFrame(createProjectionSnapshot(), {
      ...frame("snapshot"),
      cursor: { epoch: "e1", seq: 7 },
    });
    const response = (
      request: string,
      cursor: { epoch: string; seq: number },
    ): ProjectionFrame => ({
      v: V,
      type: "response",
      requestId: request as never,
      commandId: `${request}-command` as never,
      command: "session.attach",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      ok: true,
      result: { attached: true, cursor },
    });

    const ahead = applyPublicFrame(
      decodeProjectionCacheValue(encodeProjectionCache(live))!,
      response("attach-ahead", { epoch: "e1", seq: 8 }),
    );
    expect(ahead.sessions.get(sessionKey("session-a"))?.freshness).toBe("cached");

    const different = applyPublicFrame(
      decodeProjectionCacheValue(encodeProjectionCache(live))!,
      response("attach-different", { epoch: "e2", seq: 7 }),
    );
    expect(different.sessions.get(sessionKey("session-a"))?.freshness).toBe("cached");
  });

  it("keeps deterministic eight-session LRU and A-B-A continuity", () => {
    const store = new ProjectionStore();
    for (let i = 0; i < 7; i += 1)
      store.applyPublicFrame({
        ...frame("snapshot", `session-${i}`),
        cursor: { epoch: "e1", seq: 1 },
      });
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

  it("projects the frozen runtime Agent View lifecycle corpus through normalized events", () => {
    const agentHost = hostId("agent-view-host");
    const agentSession = sessionId("agent-view-session");
    const key = `${String(agentHost)}\u0000${String(agentSession)}`;
    let state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "snapshot",
      cursor: { epoch: "agent-view-e1", seq: 1 },
      revision: revision("agent-view-r1"),
      hostId: agentHost,
      sessionId: agentSession,
      entries: [],
    });
    const observedStates: string[] = [];

    expect(AGENT_VIEW_CORPUS.schema).toBe("agent-view/1");
    for (const wireFrame of AGENT_VIEW_CORPUS.frames) {
      const event = ompAppV1ProtocolProvider.decodeServerEvent(wireFrame);
      if (event.kind === "pair.ok") throw new Error("Agent View corpus cannot contain pair.ok");
      state = applyPublicEvent(state, event);
      observedStates.push(state.sessions.get(key)?.agents.get("WorkerA")?.state ?? "missing");
    }

    expect(observedStates).toEqual([
      "started",
      "running",
      "completed",
      "parked",
      "started",
      "cancelled",
    ]);
    expect(state.sessions.get(key)?.agents.get("WorkerA")).toMatchObject({
      agentId: "WorkerA",
      state: "cancelled",
      detail: {
        title: "Verify parity",
        index: 0,
        resumable: false,
        contextUsage: { used: 2_000, limit: 8_000 },
      },
    });
  });

  it("projects agents, terminal output, files, reviews, confirmations, audit, and results", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    state = applyPublicFrame(state, {
      v: V,
      type: "agent",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      agentId: "agent-a" as never,
      state: "running",
      progress: 0.5,
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "terminal",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      terminalId: "term-a" as never,
      stream: "stdout",
      data: "hello",
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "terminal",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      terminalId: "term-a" as never,
      stream: "exit",
      exitCode: 0,
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "files",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      path: "src/main.ts",
      content: "ok",
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "review",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      reviewId: "review-a",
      status: "open",
      findings: [],
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "confirmation",
      confirmationId: "confirm-a" as never,
      commandId: "command-a" as never,
      hostId: HOST,
      sessionId: sessionId("session-a"),
      commandHash: "hash",
      revision: revision("r1"),
      expiresAt: "2030",
      summary: "approve",
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "audit",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      action: "test",
      actor: "test",
      timestamp: "2030",
    });
    state = applyPublicFrame(state, {
      v: V,
      type: "response",
      requestId: "request-a" as never,
      commandId: "command-a" as never,
      hostId: HOST,
      sessionId: sessionId("session-a"),
      ok: true,
      result: { answer: 42, token: "removed" },
    });
    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.agents.get("agent-a")?.state).toBe("running");
    expect(session.terminals.get("term-a")).toMatchObject({
      stdout: "hello",
      exitCode: 0,
      closed: true,
    });
    expect(session.files.get("src/main.ts")?.content).toBe("ok");
    expect(session.reviews.get("review-a")?.status).toBe("open");
    expect(session.confirmations.size).toBe(0);
    expect(session.audit).toHaveLength(1);
    expect(session.results.get("request-a")?.result).toEqual({ answer: 42 });
  });

  it("bounds terminal projections by UTF-8 bytes and evicts completed terminals first", () => {
    const options = {
      maxTerminals: 3,
      maxTerminalBytes: 42,
      maxTerminalBytesPerTerminal: 24,
    };
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"), options);
    const output = (terminalId: string, data: string): ProjectionFrame => ({
      v: V,
      type: "terminal",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      terminalId: terminalId as never,
      stream: "stdout",
      data,
    });
    const exit = (terminalId: string): ProjectionFrame => ({
      v: V,
      type: "terminal",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      terminalId: terminalId as never,
      stream: "exit",
      exitCode: 0,
    });

    // `open` is older than `done`; completed-first eviction must still remove
    // `done` when the Unicode-heavy current terminal crosses the total budget.
    state = applyPublicFrame(state, output("open", "α".repeat(6)), options);
    state = applyPublicFrame(state, output("done", "x".repeat(12)), options);
    state = applyPublicFrame(state, exit("done"), options);
    state = applyPublicFrame(state, output("current", "😀".repeat(20)), options);
    let session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.terminals.has("done")).toBe(false);
    expect(session.terminals.has("open")).toBe(true);
    expect(session.terminals.get("current")?.stdout).toBe("😀".repeat(4));
    expect(session.terminals.get("current")?.stdout).not.toContain("�");
    expect(projectionTerminalBytes(session)).toBeLessThanOrEqual(options.maxTerminalBytes);

    // Existing ids move to MRU on output, so count eviction is deterministic.
    state = applyPublicFrame(state, output("third", "3"), options);
    state = applyPublicFrame(state, output("open", "!"), options);
    state = applyPublicFrame(state, output("fourth", "4"), options);
    session = state.sessions.get(sessionKey("session-a"))!;
    expect([...session.terminals.keys()]).toEqual(["third", "open", "fourth"]);
  });

  it("bounds file projections while retaining old paths as metadata", () => {
    const options = { maxFiles: 3, maxFilesBytes: 30, maxFileBytes: 20 };
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"), options);
    const file = (path: string, content?: string): ProjectionFrame => ({
      v: V,
      type: "files",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      path,
      ...(content === undefined ? {} : { content }),
    });
    state = applyPublicFrame(state, file("old.txt", "界".repeat(20)), options);
    state = applyPublicFrame(state, file("new.txt", "界".repeat(20)), options);
    let session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.files.get("old.txt")).toMatchObject({ path: "old.txt", truncated: true });
    expect(session.files.get("old.txt")?.content).toBeUndefined();
    expect(session.files.get("new.txt")?.content).toBe("界".repeat(4));
    expect(session.files.get("new.txt")?.content).not.toContain("�");
    expect(projectionFileBytes(session)).toBeLessThanOrEqual(options.maxFilesBytes);

    state = applyPublicFrame(state, file("third", undefined), options);
    state = applyPublicFrame(state, file("fourth", undefined), options);
    session = state.sessions.get(sessionKey("session-a"))!;
    expect([...session.files.keys()]).toEqual(["new.txt", "third", "fourth"]);
  });

  it("treats per-item resource byte limits as absolute for Unicode identifiers", () => {
    const options = {
      maxTerminalBytes: 128,
      maxTerminalBytesPerTerminal: 3,
      maxFilesBytes: 128,
      maxFileBytes: 5,
    };
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"), options);
    state = applyPublicFrame(
      state,
      {
        v: V,
        type: "terminal",
        hostId: HOST,
        sessionId: sessionId("session-a"),
        terminalId: "😀" as never,
        stream: "stdout",
        data: "x",
      },
      options,
    );
    state = applyPublicFrame(
      state,
      {
        v: V,
        type: "files",
        hostId: HOST,
        sessionId: sessionId("session-a"),
        path: "界.ts",
        content: "x",
      },
      options,
    );
    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(UTF8.encode("😀").byteLength).toBeGreaterThan(options.maxTerminalBytesPerTerminal);
    expect(UTF8.encode("界.ts").byteLength).toBeGreaterThan(options.maxFileBytes);
    expect(session.terminals.size).toBe(0);
    expect(session.files.size).toBe(0);
  });

  it("keeps adversarial terminal and file aggregates bounded across eight warm sessions", () => {
    const options = {
      maxWarmSessions: 8,
      maxTerminals: 4,
      maxTerminalBytes: 96,
      maxTerminalBytesPerTerminal: 48,
      maxFiles: 4,
      maxFilesBytes: 128,
      maxFileBytes: 64,
    };
    let state = createProjectionSnapshot();
    for (let sessionIndex = 0; sessionIndex < 8; sessionIndex += 1) {
      const currentSession = `aggregate-${sessionIndex}`;
      state = applyPublicFrame(state, frame("snapshot", currentSession), options);
      for (let item = 0; item < 10; item += 1) {
        state = applyPublicFrame(
          state,
          {
            v: V,
            type: "terminal",
            hostId: HOST,
            sessionId: sessionId(currentSession),
            terminalId: `terminal-${item}` as never,
            stream: "stdout",
            data: "😀".repeat(30),
          },
          options,
        );
        state = applyPublicFrame(
          state,
          {
            v: V,
            type: "files",
            hostId: HOST,
            sessionId: sessionId(currentSession),
            path: `src/世界-${item}.ts`,
            content: "界".repeat(30),
          },
          options,
        );
      }
    }
    expect(state.sessions.size).toBe(8);
    let terminalBytes = 0;
    let fileBytes = 0;
    for (const session of state.sessions.values()) {
      expect(session.terminals.size).toBeLessThanOrEqual(options.maxTerminals);
      expect(session.files.size).toBeLessThanOrEqual(options.maxFiles);
      expect(projectionTerminalBytes(session)).toBeLessThanOrEqual(options.maxTerminalBytes);
      expect(projectionFileBytes(session)).toBeLessThanOrEqual(options.maxFilesBytes);
      terminalBytes += projectionTerminalBytes(session);
      fileBytes += projectionFileBytes(session);
    }
    expect(terminalBytes).toBeLessThanOrEqual(8 * options.maxTerminalBytes);
    expect(fileBytes).toBeLessThanOrEqual(8 * options.maxFilesBytes);
  });

  it("reapplies configured resource budgets when restoring projection cache", async () => {
    const generous = {
      maxTerminalBytes: 4096,
      maxTerminalBytesPerTerminal: 4096,
      maxFilesBytes: 4096,
      maxFileBytes: 4096,
    };
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"), generous);
    state = applyPublicFrame(
      state,
      {
        v: V,
        type: "terminal",
        hostId: HOST,
        sessionId: sessionId("session-a"),
        terminalId: "cached-terminal" as never,
        stream: "stdout",
        data: "😀".repeat(100),
      },
      generous,
    );
    state = applyPublicFrame(
      state,
      {
        v: V,
        type: "files",
        hostId: HOST,
        sessionId: sessionId("session-a"),
        path: "cached.txt",
        content: "界".repeat(100),
      },
      generous,
    );
    const cached = encodeProjectionCache(state);
    const restored = new ProjectionStore({
      maxTerminalBytes: 64,
      maxTerminalBytesPerTerminal: 64,
      maxFilesBytes: 64,
      maxFileBytes: 64,
      cacheStore: { load: () => cached, save: () => undefined },
    });
    await restored.ready();
    const session = restored.snapshot.sessions.get(sessionKey("session-a"))!;
    expect(projectionTerminalBytes(session)).toBeLessThanOrEqual(64);
    expect(projectionFileBytes(session)).toBeLessThanOrEqual(64);
    expect(session.terminals.get("cached-terminal")?.stdout).not.toContain("�");
    expect(session.files.get("cached.txt")?.content).not.toContain("�");
  });

  it("projects each subagent transcript on its own bounded replay cursor", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const first = childEntry("child-1", "First child message");
    const second = childEntry("child-2", "Second child message");
    state = applyPublicFrame(state, childTranscript(7, [first]));
    let transcript = state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(transcript.entries.map((entry) => entry.id)).toEqual(["child-1"]);
    expect(transcript.cursor).toEqual({ epoch: "child-e1", seq: 7 });
    expect(state.sessions.get(sessionKey("session-a"))!.cursor?.seq).toBe(1);

    state = applyPublicFrame(state, childTranscript(8, [first, second]));
    transcript = state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(transcript.entries.map((entry) => entry.id)).toEqual(["child-1", "child-2"]);

    const duplicate = state;
    state = applyPublicFrame(state, childTranscript(8, [second]));
    expect(state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")).toBe(
      duplicate.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a"),
    );

    const recovered = childEntry("child-recovered", "Authoritative retained baseline");
    state = applyPublicFrame(state, childTranscript(12, [recovered]));
    transcript = state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(transcript.entries.map((entry) => entry.id)).toEqual(["child-recovered"]);
    expect(transcript.freshness).toBe("fresh");

    state = applyPublicFrame(state, {
      ...frame("snapshot"),
      cursor: { epoch: "parent-e2", seq: 1 },
    });
    expect(
      state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!.entries[0]?.id,
    ).toBe("child-recovered");

    state = applyPublicFrame(state, childTranscript(1, [], "child-e2"));
    transcript = state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(transcript.entries).toEqual([]);
    expect(transcript.cursor).toEqual({ epoch: "child-e2", seq: 1 });
  });

  it("bounds and cache-restores subagent transcripts before an attach baseline refreshes them", () => {
    let state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const entries = Array.from({ length: 600 }, (_, index) =>
      childEntry(`child-${index}`, `Child message ${index}`),
    );
    state = applyPublicFrame(state, childTranscript(44, entries));
    const live = state.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(live.entries).toHaveLength(512);
    expect(live.historyTruncated).toBe(true);

    const restored = decodeProjectionCacheValue(encodeProjectionCache(state))!;
    const cached = restored.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(cached.entries).toHaveLength(64);
    expect(cached.freshness).toBe("cached");
    expect(cached.historyTruncated).toBe(true);

    const baseline = childEntry("child-baseline", "Fresh attach baseline");
    const refreshed = applyPublicFrame(restored, childTranscript(44, [baseline]));
    const fresh = refreshed.sessions.get(sessionKey("session-a"))!.agentTranscripts.get("agent-a")!;
    expect(fresh.entries.map((entry) => entry.id)).toEqual(["child-baseline"]);
    expect(fresh.freshness).toBe("fresh");
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
    const entries = Array.from({ length: 10_000 }, (_, index) => ({
      id: `entry-${index}` as never,
      parentId: null,
      hostId: HOST,
      sessionId: sessionId("session-a"),
      kind: "message",
      timestamp: String(index),
      data: { index },
    }));
    state = applyPublicFrame(state, {
      v: V,
      type: "snapshot",
      cursor: { epoch: "e1", seq: 1 },
      revision: revision("r1"),
      hostId: HOST,
      sessionId: sessionId("session-a"),
      entries,
    });
    state = applyPublicFrame(state, {
      ...frame("snapshot", "session-b"),
      cursor: { epoch: "e1", seq: 1 },
    });
    const untouched = state.sessions.get(sessionKey("session-b"));
    const started = performance.now();
    for (let index = 0; index < 100_000; index += 1) {
      state = applyPublicFrame(state, {
        v: V,
        type: "event",
        cursor: { epoch: "e1", seq: index + 2 },
        hostId: HOST,
        sessionId: sessionId("session-a"),
        event: { type: "delta", index },
      });
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
  }, 20_000);

  it("codec bounds and rejects corrupt/old/oversized cache", () => {
    const state = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const encoded = encodeProjectionCache(state, 1);
    expect(encoded.length).toBeLessThan(MAX_PROJECTION_CACHE_BYTES);
    expect(decodeProjectionCacheValue(encoded)?.freshness).toBe("cached");
    expect(decodeProjectionCacheValue("not-json")).toBeUndefined();
    expect(
      decodeProjectionCacheValue(
        JSON.stringify({ kind: "t4-code-projection", version: 0, data: {} }),
      ),
    ).toBeUndefined();
    expect(decodeProjectionCacheValue("x".repeat(MAX_PROJECTION_CACHE_BYTES + 1))).toBeUndefined();
  });

  it("preserves an existing truncated-history marker across cache re-encoding", () => {
    const base = applyPublicFrame(createProjectionSnapshot(), frame("snapshot"));
    const key = sessionKey("session-a");
    const warm = base.sessions.get(key)!;
    const truncated = Object.freeze({
      ...base,
      sessions: new Map([[key, Object.freeze({ ...warm, historyTruncated: true })]]),
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
      save: (serialized) =>
        new Promise<void>((resolve) => {
          saves.push(serialized);
          release = resolve;
        }),
    };
    const store = new ProjectionStore({ cacheStore });
    let calls = 0;
    const dispose = store.subscribe(() => {
      calls += 1;
    });
    store.applyPublicFrame(frame("snapshot"));
    store.applyPublicFrame(frame("event"));
    expect(saves).toHaveLength(1);
    const shutdown = store.dispose();
    expect(saves).toHaveLength(1);
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(saves).toHaveLength(2);
    expect(saves[1]).not.toBe(saves[0]);
    release?.();
    await shutdown;
    dispose();
    store.applyPublicFrame({ ...frame("event"), cursor: { epoch: "e1", seq: 3 } });
    expect(calls).toBe(2);
  });

  it("orders preview metadata by full identity and requires a fresh baseline after reconnect", () => {
    const identity = { hostId: String(HOST), sessionId: "session-a", previewId: "preview-a" };
    const launch = {
      v: V,
      type: "preview.launch",
      ...identity,
      state: "ready",
      url: "https://example.test/one",
      revision: revision("preview-1"),
      cursor: { epoch: "preview-e1", seq: 1 },
    } as ProjectionFrame;
    const skippedNavigation = {
      ...launch,
      type: "preview.navigation",
      url: "https://example.test/stale",
      revision: revision("preview-3"),
      cursor: { epoch: "preview-e1", seq: 3 },
    } as ProjectionFrame;
    const baseline = {
      ...launch,
      type: "preview.state",
      url: "https://example.test/current",
      revision: revision("preview-4"),
      cursor: { epoch: "preview-e1", seq: 4 },
    } as ProjectionFrame;
    let state = applyPublicFrame(createProjectionSnapshot(), launch);
    state = applyPublicFrame(state, skippedNavigation);
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.freshness,
    ).toBe("stale");
    state = applyPublicFrame(state, baseline);
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity)),
    ).toMatchObject({
      url: "https://example.test/current",
      freshness: "fresh",
    });
    state = applyPublicFrame(state, {
      ...baseline,
      type: "preview.navigation",
      url: "https://example.test/old",
      cursor: { epoch: "preview-e1", seq: 3 },
    } as ProjectionFrame);
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.url,
    ).toBe("https://example.test/current");
    state = applyPublicFrame(state, frame("welcome"));
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.freshness,
    ).toBe("catching-up");
    state = applyPublicFrame(state, {
      ...baseline,
      url: "https://example.test/recovered",
      cursor: { epoch: "preview-e1", seq: 1 },
      revision: revision("preview-5"),
    } as ProjectionFrame);
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.freshness,
    ).toBe("fresh");
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.url,
    ).toBe("https://example.test/recovered");

    const otherIdentity = {
      hostId: "preview-other",
      sessionId: "session-a",
      previewId: "preview-a",
    };
    state = applyPublicFrame(state, {
      ...launch,
      ...otherIdentity,
      hostId: hostId(otherIdentity.hostId),
      sessionId: sessionId(otherIdentity.sessionId),
      cursor: { epoch: "preview-other-e1", seq: 1 },
    } as ProjectionFrame);
    expect(
      state.sessions
        .get(`${otherIdentity.hostId}\u0000${otherIdentity.sessionId}`)
        ?.previews.get(previewKey(otherIdentity))?.hostId,
    ).toBe(otherIdentity.hostId);
    expect(
      state.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity))?.hostId,
    ).toBe(String(HOST));
  });

  it("persists preview metadata without capture bytes or object URLs and migrates version-one caches", () => {
    const identity = { hostId: String(HOST), sessionId: "session-a", previewId: "preview-cache" };
    const state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "preview.capture",
      ...identity,
      state: "ready",
      url: "https://example.test/cache",
      revision: revision("preview-cache-1"),
      cursor: { epoch: "preview-cache-e1", seq: 1 },
      capture: {
        captureId: "capture-cache",
        mimeType: "image/png",
        size: 24,
        width: 1,
        height: 1,
        capturedAt: 1,
        sha256: "a".repeat(64),
      },
    } as ProjectionFrame);
    const serialized = encodeProjectionCache(state);
    expect(serialized).not.toContain("objectUrl");
    expect(serialized).not.toContain("base64");
    const restored = decodeProjectionCacheValue(serialized);
    expect(
      restored?.sessions.get(sessionKey("session-a"))?.previews.get(previewKey(identity)),
    ).toMatchObject({
      capture: { captureId: "capture-cache" },
      freshness: "cached",
    });
    const versionOne = JSON.parse(serialized) as {
      version: number;
      data: { sessions: Array<{ value: Record<string, unknown> }> };
    };
    versionOne.version = 1;
    for (const item of versionOne.data.sessions) delete item.value.previews;
    expect(
      decodeProjectionCacheValue(JSON.stringify(versionOne))?.sessions.get(sessionKey("session-a"))
        ?.previews.size,
    ).toBe(0);
  });

  it("assembles bounded preview capture chunks and revokes replaced object URLs", async () => {
    const identity = {
      hostId: "capture-host",
      sessionId: "capture-session",
      previewId: "capture-preview",
    };
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    png[19] = 1;
    png[23] = 1;
    const content = Buffer.from(png).toString("base64");
    const revoked: string[] = [];
    let created = 0;
    const resource = new PreviewCaptureResource({
      read: async (_identity, captureId, offset) => ({
        previewId: identity.previewId,
        captureId,
        size: png.byteLength,
        offset,
        nextOffset: png.byteLength,
        complete: true,
        content,
      }),
      sha256: async () => "a".repeat(64),
      createObjectURL: () => `blob:test-${++created}`,
      revokeObjectURL: (url) => revoked.push(url),
    });
    const capture = {
      captureId: "capture-one",
      mimeType: "image/png" as const,
      size: png.byteLength,
      width: 1,
      height: 1,
      capturedAt: 1,
      sha256: "a".repeat(64),
    };
    expect(await resource.objectUrl(identity, capture)).toBe("blob:test-1");
    expect(await resource.objectUrl(identity, { ...capture, captureId: "capture-two" })).toBe(
      "blob:test-2",
    );
    expect(revoked).toEqual(["blob:test-1"]);
    resource.dispose();
    expect(revoked).toEqual(["blob:test-1", "blob:test-2"]);
  });

  it("rejects malformed preview chunks and hash mismatches", async () => {
    const identity = {
      hostId: "capture-host",
      sessionId: "capture-session",
      previewId: "capture-preview",
    };
    const capture = {
      captureId: "capture-invalid",
      mimeType: "image/png" as const,
      size: 24,
      width: 1,
      height: 1,
      capturedAt: 1,
      sha256: "a".repeat(64),
    };
    const malformed = new PreviewCaptureResource({
      read: async () => ({
        previewId: identity.previewId,
        captureId: capture.captureId,
        size: capture.size,
        offset: 1,
        nextOffset: capture.size,
        complete: true,
        content: Buffer.alloc(capture.size).toString("base64"),
      }),
      sha256: async () => capture.sha256,
      createObjectURL: () => "blob:unused",
      revokeObjectURL: () => undefined,
    });
    await expect(malformed.objectUrl(identity, capture)).rejects.toThrow(
      "identity or offset mismatch",
    );
    const hashMismatch = new PreviewCaptureResource({
      read: async () => ({
        previewId: identity.previewId,
        captureId: capture.captureId,
        size: capture.size,
        offset: 0,
        nextOffset: capture.size,
        complete: true,
        content: Buffer.from([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
        ]).toString("base64"),
      }),
      sha256: async () => "b".repeat(64),
      createObjectURL: () => "blob:unused",
      revokeObjectURL: () => undefined,
    });
    await expect(hashMismatch.objectUrl(identity, capture)).rejects.toThrow("hash mismatch");
  });
  it("rejects oversized chunks and raster magic or dimension mismatches", async () => {
    const identity = {
      hostId: "capture-host",
      sessionId: "capture-session",
      previewId: "capture-preview",
    };
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    png[19] = 1;
    png[23] = 1;
    const capture = {
      captureId: "capture-raster",
      mimeType: "image/png" as const,
      size: png.byteLength,
      width: 1,
      height: 1,
      capturedAt: 1,
      sha256: "a".repeat(64),
    };
    await expect(
      new PreviewCaptureResource({
        read: async () => ({
          previewId: identity.previewId,
          captureId: "capture-large",
          size: 256 * 1024 + 1,
          offset: 0,
          nextOffset: 256 * 1024 + 1,
          complete: true,
          content: "",
        }),
        sha256: async () => "a".repeat(64),
      }).objectUrl(identity, {
        ...capture,
        captureId: "capture-large",
        size: 256 * 1024 + 1,
      }),
    ).rejects.toThrow("chunk bounds mismatch");
    await expect(
      new PreviewCaptureResource({
        read: async () => ({
          previewId: identity.previewId,
          captureId: capture.captureId,
          size: capture.size,
          offset: 0,
          nextOffset: capture.size,
          complete: true,
          content: Buffer.alloc(capture.size).toString("base64"),
        }),
        sha256: async () => capture.sha256,
        createObjectURL: () => "blob:unused",
        revokeObjectURL: () => undefined,
      }).objectUrl(identity, capture),
    ).rejects.toThrow("not PNG");
    await expect(
      new PreviewCaptureResource({
        read: async () => ({
          previewId: identity.previewId,
          captureId: capture.captureId,
          size: capture.size,
          offset: 0,
          nextOffset: capture.size,
          complete: true,
          content: Buffer.from(png).toString("base64"),
        }),
        sha256: async () => capture.sha256,
        createObjectURL: () => "blob:unused",
        revokeObjectURL: () => undefined,
      }).objectUrl(identity, { ...capture, width: 2 }),
    ).rejects.toThrow("dimensions mismatch");
  });

  it("deduplicates in-flight loads and drops replaced pending capture ownership", async () => {
    const identity = {
      hostId: "capture-host",
      sessionId: "capture-session",
      previewId: "capture-preview",
    };
    const png = new Uint8Array(24);
    png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    png[19] = 1;
    png[23] = 1;
    const capture = {
      captureId: "capture-race",
      mimeType: "image/png" as const,
      size: png.byteLength,
      width: 1,
      height: 1,
      capturedAt: 1,
      sha256: "a".repeat(64),
    };
    const deferred = Promise.withResolvers<{
      previewId: string;
      captureId: string;
      size: number;
      offset: number;
      nextOffset: number;
      complete: boolean;
      content: string;
    }>();
    let reads = 0;
    let created = 0;
    const resource = new PreviewCaptureResource({
      read: async () => {
        reads += 1;
        return deferred.promise;
      },
      sha256: async () => capture.sha256,
      createObjectURL: () => `blob:race-${++created}`,
      revokeObjectURL: () => undefined,
    });
    const first = resource.objectUrl(identity, capture);
    const second = resource.objectUrl(identity, capture);
    expect(reads).toBe(1);
    deferred.resolve({
      previewId: identity.previewId,
      captureId: capture.captureId,
      size: capture.size,
      offset: 0,
      nextOffset: capture.size,
      complete: true,
      content: Buffer.from(png).toString("base64"),
    });
    expect(await first).toBe("blob:race-1");
    expect(await second).toBe("blob:race-1");
    expect(created).toBe(1);

    const delayed = Promise.withResolvers<{
      previewId: string;
      captureId: string;
      size: number;
      offset: number;
      nextOffset: number;
      complete: boolean;
      content: string;
    }>();
    const replacement = { ...capture, captureId: "capture-replacement" };
    const racing = new PreviewCaptureResource({
      read: async (_identity, captureId) =>
        captureId === capture.captureId
          ? delayed.promise
          : {
              previewId: identity.previewId,
              captureId,
              size: replacement.size,
              offset: 0,
              nextOffset: replacement.size,
              complete: true,
              content: Buffer.from(png).toString("base64"),
            },
      sha256: async () => capture.sha256,
      createObjectURL: () => "blob:replacement",
      revokeObjectURL: () => undefined,
    });
    const pending = racing.objectUrl(identity, capture);
    racing.replace(identity, replacement);
    delayed.resolve({
      previewId: identity.previewId,
      captureId: capture.captureId,
      size: capture.size,
      offset: 0,
      nextOffset: capture.size,
      complete: true,
      content: Buffer.from(png).toString("base64"),
    });
    await expect(pending).rejects.toThrow("replaced while loading");
    expect(await racing.objectUrl(identity, replacement)).toBe("blob:replacement");
  });

  it("persists authority labels and sanitized preview activity without URL query or hash", () => {
    const identity = { hostId: String(HOST), sessionId: "session-a", previewId: "preview-authority" };
    const state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "preview.launch",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      previewId: "preview-authority" as never,
      state: "ready",
      url: "https://preview.test/workspace?token=never-cache#secret",
      revision: revision("preview-authority-1"),
      cursor: { epoch: "preview-authority", seq: 1 },
      authority: {
        id: "omp-session",
        label: "OMP session",
        kind: "isolated-session",
        requiresExplicitOptIn: false,
      },
      availableActions: ["activate", "fill", "select", "upload"],
    } as ProjectionFrame);
    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.previews.get(previewKey(identity))).toMatchObject({
      authority: { id: "omp-session", kind: "isolated-session" },
      availableActions: ["activate", "fill", "select", "upload"],
    });
    expect(session.previewEvents).toEqual([
      {
        type: "launch",
        previewId: "preview-authority",
        cursor: { epoch: "preview-authority", seq: 1 },
        url: { origin: "https://preview.test", pathname: "/workspace", hasQuery: true },
      },
    ]);
    const cache = encodeProjectionCache(state);
    expect(cache).not.toContain("token=never-cache");
    expect(cache).not.toContain("#secret");
    expect(decodeProjectionCacheValue(cache)?.sessions.get(sessionKey("session-a"))?.previews
      .get(previewKey(identity))?.url).toBe("https://preview.test/workspace");
  });

  it("does not classify preview state reconciliation as an error activity", () => {
    const identity = { hostId: String(HOST), sessionId: "session-a", previewId: "preview-state" };
    const state = applyPublicFrame(createProjectionSnapshot(), {
      v: V,
      type: "preview.state",
      hostId: HOST,
      sessionId: sessionId("session-a"),
      previewId: "preview-state" as never,
      state: "ready",
      url: "https://preview.test/current",
      revision: revision("preview-state-1"),
      cursor: { epoch: "preview-state", seq: 1 },
    } as ProjectionFrame);

    const session = state.sessions.get(sessionKey("session-a"))!;
    expect(session.previews.get(previewKey(identity))).toMatchObject({
      state: "ready",
      url: "https://preview.test/current",
    });
    expect(session.previewEvents).toEqual([]);
  });
});
