// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import { ProjectionStore, applyPublicFrame, createDesktopRuntimeController, createProjectionSnapshot, encodeProjectionCache } from "@t4-code/client";
import { hostId, revision, sessionId, type SessionsFrame } from "@t4-code/protocol";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import { deriveAttention, deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";
import { FakeShell, makeWelcome } from "./fake-shell.ts";
import { catalogFrame, commandItem, entry, eventFrame, HOST, pendingPromptsSessionsFrame, SESSION, snapshotFrame, startedController, startedRuntime, turnError, turnStart, V } from "./live-composer-fixtures.ts";

describe("session activity and inventory", () => {
it("uses active ref and pre-turn compaction as one visible activity state", async () => {
    const { shell, runtime } = await startedRuntime();
    const indexed = (seq: number, status: "active" | "idle"): SessionsFrame => ({
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision(`rev-${status}-${seq}`),
          title: "Session",
          status,
          updatedAt: `2026-07-11T10:00:0${seq}Z`,
        },
      ],
      totalCount: 1,
      truncated: false,
    });

    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [
        commandItem("session.cancel"),
        commandItem("compact", undefined, true),
        commandItem("retry", undefined, true),
      ]),
    });
    shell.emitFrame({ targetId: "local", frame: indexed(1, "active") });

    let snapshot = runtime.getSnapshot();
    expect(snapshot.projection.turnActive).toBe(false);
    expect(snapshot.sessionActive).toBe(true);
    expect(snapshot.canCancel).toBe(true);
    expect(
      deriveTranscriptRows(snapshot.projection, {
        sessionActive: snapshot.sessionActive,
      }).find((row) => row.kind === "working"),
    ).toMatchObject({ activity: "working", startedAt: null });
    expect(
      snapshot.slashCommands?.find((command) => command.name === "/compact")?.disabledReason,
    ).toBe("Wait for the turn to finish");
    expect(
      snapshot.slashCommands?.find((command) => command.name === "/retry")?.disabledReason,
    ).toBe("A turn is already running");

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 2 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "compaction.start",
          reason: "pending_prompt_size",
          at: "2026-07-11T10:00:02Z",
        },
      },
    });
    snapshot = runtime.getSnapshot();
    expect(snapshot.sessionActive).toBe(true);
    expect(snapshot.projection.contextMaintenance?.reason).toBe("pending_prompt_size");
    expect(
      deriveTranscriptRows(snapshot.projection, {
        sessionActive: snapshot.sessionActive,
      }).find((row) => row.kind === "working"),
    ).toMatchObject({ activity: "preparing-context" });

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 3 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.update",
          entryId: "prompt:request-9",
          role: "user",
          text: "keep going",
          at: "2026-07-11T10:00:03Z",
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 4 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.settled",
          transientEntryId: "prompt:request-9",
          entryId: "durable-user-9",
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "entry",
        cursor: { epoch: "epoch-1", seq: 5 },
        revision: revision("rev-user-settled"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        entry: {
          ...entry("durable-user-9", "keep going"),
          data: { role: "user", text: "keep going" },
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 6 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: { type: "compaction.end", at: "2026-07-11T10:00:06Z" },
      },
    });

    snapshot = runtime.getSnapshot();
    expect(snapshot.projection.contextMaintenance).toBeNull();
    expect(snapshot.sessionActive).toBe(true);
    shell.emitFrame({ targetId: "local", frame: indexed(2, "idle") });

    snapshot = runtime.getSnapshot();
    expect(snapshot.sessionActive).toBe(false);
    const rows = deriveTranscriptRows(snapshot.projection, {
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.kind === "message" && row.role === "user")).toHaveLength(1);
    expect(rows.some((row) => row.kind === "working")).toBe(false);
  });

it("orders restored compaction truth against only lifecycle-changing events", async () => {
    const { shell, runtime } = await startedRuntime();
    const compactingRef = (indexSeq: number, refRevision: string): SessionsFrame =>
      ({
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: indexSeq },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision(refRevision),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:01Z",
            liveState: { isCompacting: true },
          },
        ],
        totalCount: 1,
        truncated: false,
      });
    shell.emitFrame({
      targetId: "local",
      frame: compactingRef(0, "rev-restored-compaction"),
    });

    let snapshot = runtime.getSnapshot();
    expect(snapshot.sessionActive).toBe(true);
    expect(snapshot.projection.contextMaintenance).toEqual({
      startedAt: null,
      reason: "Restored from current session state",
    });
    expect(
      deriveTranscriptRows(snapshot.projection, {
        pendingPrompts: snapshot.pendingPrompts,
        sessionActive: snapshot.sessionActive,
      }).find((row) => row.kind === "working"),
    ).toMatchObject({ activity: "preparing-context", startedAt: null });

    // Activity-inspector-only traffic is newer than the ref, but does not
    // contradict its missed compaction-start lifecycle truth.
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, { type: "agent.event", detail: "still compacting" }),
    });
    expect(runtime.getSnapshot().projection.contextMaintenance).toMatchObject({
      reason: "Restored from current session state",
    });

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(3, { type: "compaction.end", at: "2026-07-11T10:00:03Z" }),
    });
    expect(runtime.getSnapshot().projection.contextMaintenance).toBeNull();

    // A genuinely newer compacting ref can restore the missed start again.
    shell.emitFrame({
      targetId: "local",
      frame: compactingRef(0, "rev-restored-compaction-again"),
    });
    expect(runtime.getSnapshot().projection.contextMaintenance).toMatchObject({
      reason: "Restored from current session state",
    });

    // turn.start unconditionally closes context maintenance, so the older
    // compacting ref cannot synthesize it back into the projection.
    shell.emitFrame({ targetId: "local", frame: turnStart(4) });
    snapshot = runtime.getSnapshot();
    expect(snapshot.projection.turnActive).toBe(true);
    expect(snapshot.projection.contextMaintenance).toBeNull();
  });

it("does not let an older idle ref erase newer warm transcript activity", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 1 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-before-current-work"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:01Z",
            liveState: { isCompacting: false },
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, {
        type: "compaction.start",
        reason: "manual",
        action: "context-full",
        at: "2026-07-11T10:00:02Z",
      }),
    });

    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "live",
      sessionActive: true,
      projection: {
        contextMaintenance: {
          startedAt: "2026-07-11T10:00:02Z",
          reason: "manual",
        },
      },
    });
    runtime.dispose();

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(3, { type: "compaction.end", at: "2026-07-11T10:00:03Z" }),
    });
    shell.emitFrame({ targetId: "local", frame: turnStart(4) });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(5, {
        type: "message.update",
        entryId: "assistant:current",
        role: "assistant",
        text: "Current output",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(6, {
        type: "tool.start",
        callId: "tool-current",
        tool: "read",
        title: "Read current file",
      }),
    });
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "live",
      sessionActive: true,
      projection: {
        turnActive: true,
        contextMaintenance: null,
      },
    });
    expect(runtime.getSnapshot().projection.liveMessages.has("assistant:current")).toBe(true);
    expect(runtime.getSnapshot().projection.toolCalls.has("tool-current")).toBe(true);
    runtime.dispose();
  });

it("settles every volatile warm activity field when a newer complete ref is idle", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(3, {
        type: "message.update",
        entryId: "assistant:stale",
        role: "assistant",
        text: "Stale output",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(4, {
        type: "tool.start",
        callId: "tool-stale",
        tool: "read",
        title: "Read stale file",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(5, {
        type: "compaction.start",
        reason: "manual",
        at: "2026-07-11T10:00:05Z",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 1 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-after-stale-work"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:06Z",
            liveState: { isCompacting: false },
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });

    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionActive).toBe(false);
    expect(snapshot.projection).toMatchObject({
      turnActive: false,
      turnStartedAt: null,
      contextMaintenance: null,
    });
    expect(snapshot.projection.liveMessages.size).toBe(0);
    expect(snapshot.projection.toolCalls.size).toBe(0);
    runtime.dispose();
  });

it("settles mounted activity when idle ref truth stays false across newer work", async () => {
    const { shell, runtime } = await startedRuntime();
    const idle = (seq: number): SessionsFrame => ({
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision(`rev-idle-${seq}`),
          title: "Session",
          status: "idle",
          updatedAt: `2026-07-11T10:00:0${seq}Z`,
          liveState: { isCompacting: false },
        },
      ],
      totalCount: 1,
      truncated: false,
    });

    shell.emitFrame({ targetId: "local", frame: idle(0) });
    expect(runtime.getSnapshot().sessionActive).toBe(false);
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    expect(runtime.getSnapshot().projection.turnActive).toBe(true);

    // The boolean remains idle -> idle; receive order is what proves that the
    // second complete ref supersedes the intervening turn event.
    shell.emitFrame({ targetId: "local", frame: idle(0) });
    expect(runtime.getSnapshot().projection.turnActive).toBe(false);
    expect(runtime.getSnapshot().sessionActive).toBe(false);
  });

it("settles mounted activity when the first complete inventory is idle", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    expect(runtime.getSnapshot().projection.turnActive).toBe(true);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 0 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId:
                "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-first-idle"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:03Z",
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });

    expect(runtime.getSnapshot().projection.turnActive).toBe(false);
    expect(runtime.getSnapshot().sessionActive).toBe(false);
  });

it("settles cached activity after a newly received complete idle inventory", async () => {
    let warm = applyPublicFrame(createProjectionSnapshot(), snapshotFrame(1, []));
    warm = applyPublicFrame(warm, turnStart(2));
    warm = applyPublicFrame(
      warm,
      eventFrame(3, {
        type: "compaction.start",
        reason: "manual",
        at: "2026-07-11T10:00:03Z",
      }),
    );
    const projection = new ProjectionStore({
      cacheStore: {
        load: () => encodeProjectionCache(warm),
        save: () => undefined,
      },
    });
    await projection.hydrated;
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell, projection });
    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 1 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-live-idle"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:04Z",
            liveState: { isCompacting: false },
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });

    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().sessionActive).toBe(false);
    expect(runtime.getSnapshot().projection).toMatchObject({
      turnActive: false,
      contextMaintenance: null,
    });
    runtime.dispose();
    await controller.stop();
  });

it("keeps cached activity until the new connection supplies a complete inventory", async () => {
    let warm = applyPublicFrame(createProjectionSnapshot(), snapshotFrame(1, []));
    warm = applyPublicFrame(warm, turnStart(2));
    warm = applyPublicFrame(warm, {
      v: V,
      type: "sessions",
      cursor: { epoch: "session-index-1", seq: 0 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-cached-idle"),
          title: "Session",
          status: "idle",
          updatedAt: "2026-07-11T10:00:03Z",
        },
      ],
      totalCount: 1,
      truncated: false,
    });
    const projection = new ProjectionStore({
      cacheStore: {
        load: () => encodeProjectionCache(warm),
        save: () => undefined,
      },
    });
    await projection.hydrated;
    expect(projection.getSnapshot().sessionIndexMetadata.has(HOST)).toBe(true);

    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell, projection });
    await controller.start();
    // The cold connection has no host binding yet. Its cached count remains
    // renderable, but completeness is invalidated before "connected" reaches
    // any session runtime.
    expect(controller.getSnapshot().projection.sessionIndexMetadata.has(HOST)).toBe(false);
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "cached",
      projection: { turnActive: true },
    });

    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
    expect(runtime.getSnapshot().projection.turnActive).toBe(true);
    expect(controller.getSnapshot().projection.sessionIndexMetadata.has(HOST)).toBe(false);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 0 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId:
                "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-live-idle"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:04Z",
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });
    expect(runtime.getSnapshot().projection.turnActive).toBe(false);

    runtime.dispose();
    await controller.stop();
  });

it("keeps an attached warm session cached when the complete index omits it", async () => {
    const warm = applyPublicFrame(createProjectionSnapshot(), snapshotFrame(1, []));
    const projection = new ProjectionStore({
      cacheStore: {
        load: () => encodeProjectionCache(warm),
        save: () => undefined,
      },
    });
    await projection.hydrated;
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell, projection });
    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 0 },
        sessions: [],
        totalCount: 0,
        truncated: false,
      } satisfies SessionsFrame,
    });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "response",
        requestId: "attach-missing-index" as never,
        commandId: "attach-missing-index-command" as never,
        command: "session.attach",
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        ok: true,
        result: { attached: true, cursor: { epoch: "epoch-1", seq: 1 } },
      },
    });

    expect(runtime.getSnapshot()).toMatchObject({
      link: "cached",
      canPrompt: false,
      canCancel: false,
    });
    runtime.dispose();
    await controller.stop();
  });

it("keeps stale transcript activity visible as history but not as offline work", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    expect(runtime.getSnapshot().sessionActive).toBe(true);

    shell.emitState({ targetId: "local", state: "disconnected" });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.link).toBe("offline");
    expect(snapshot.projection.turnActive).toBe(true);
    expect(snapshot.sessionActive).toBe(false);
    expect(
      deriveTranscriptRows(snapshot.projection, {
        pendingPrompts: snapshot.pendingPrompts,
        sessionActive: snapshot.sessionActive,
      }).some((row) => row.kind === "working"),
    ).toBe(false);
  });

it("keeps same-epoch reconnect state cached until a complete inventory arrives", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-reconnect-catalog", [commandItem("session.cancel")]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame(
        [{ entryId: "prompt:before-sleep", text: "keep going" }],
        1,
        "active",
      ),
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "live",
      sessionActive: true,
      canPrompt: true,
      canCancel: true,
    });

    // The same-epoch welcome invalidates every retained ref. A ref becomes
    // writable again only if the current connection actually returns it.
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "cached",
      sessionActive: false,
      canPrompt: false,
      canCancel: false,
    });
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      freshness: "cached",
      status: null,
    });

    const currentBoundedInventory = pendingPromptsSessionsFrame(
      [{ entryId: "prompt:before-sleep", text: "keep going" }],
      2,
      "active",
    );
    shell.emitFrame({
      targetId: "local",
      frame: {
        ...currentBoundedInventory,
        totalCount: 7_683,
        truncated: true,
      },
    });
    expect(runtime.getSnapshot()).toMatchObject({
      link: "live",
      sessionActive: true,
      canPrompt: true,
      canCancel: true,
    });
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      freshness: "live",
      lifecycle: "active",
      status: "working",
    });
  });

it("uses queued host work for the same Working and Cancel truth as management", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-queued-work", [commandItem("session.cancel")]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "session-index-1", seq: 1 },
        sessions: [
          {
            hostId: hostId(HOST),
            sessionId: sessionId(SESSION),
            project: {
              projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
            },
            revision: revision("rev-queued-work"),
            title: "Session",
            status: "idle",
            updatedAt: "2026-07-11T10:00:01Z",
            liveState: { queuedMessageCount: 1 },
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.projection.turnActive).toBe(false);
    expect(snapshot.pendingPrompts).toEqual([]);
    expect(snapshot.sessionActive).toBe(true);
    expect(snapshot.canCancel).toBe(true);
    expect(
      deriveTranscriptRows(snapshot.projection, {
        pendingPrompts: snapshot.pendingPrompts,
        sessionActive: snapshot.sessionActive,
      }).find((row) => row.kind === "working"),
    ).toMatchObject({ activity: "working", startedAt: null });
  });

it("disables prompting when the authoritative session ref is closed", async () => {
    const { shell, runtime } = await startedRuntime();
    const sessions: SessionsFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq: 1 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-closed"),
          title: "Closed session",
          status: "closed",
          updatedAt: "2026-07-11T10:00:00Z",
        },
      ],
    };
    expect(runtime.getSnapshot().canPrompt).toBe(true);
    shell.emitFrame({ targetId: "local", frame: sessions });
    expect(runtime.getSnapshot().canPrompt).toBe(false);
  });

it("settles stale turn UI when the authoritative session ref becomes idle", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    expect(runtime.getSnapshot().projection.turnActive).toBe(true);

    const indexed = (seq: number, status: "active" | "idle"): SessionsFrame => ({
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision(`rev-${status}`),
          title: "Session",
          status,
          updatedAt: `2026-07-11T10:00:0${seq}Z`,
        },
      ],
    });
    shell.emitFrame({ targetId: "local", frame: indexed(1, "active") });
    expect(runtime.getSnapshot().projection.turnActive).toBe(true);
    shell.emitFrame({ targetId: "local", frame: indexed(2, "idle") });

    expect(runtime.getSnapshot().projection.turnActive).toBe(false);
    expect(runtime.getSnapshot().projection.liveMessages.size).toBe(0);
    expect(runtime.getSnapshot().canPrompt).toBe(true);
  });

it("clears an old error only after a later turn is authoritatively settled", async () => {
    const { shell, runtime } = await startedRuntime();
    const indexed = (seq: number, status: "active" | "idle"): SessionsFrame => ({
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision(`rev-${status}-${seq}`),
          title: "Session",
          status,
          updatedAt: `2026-07-11T10:00:0${seq}Z`,
        },
      ],
      totalCount: 1,
      truncated: false,
    });

    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    shell.emitFrame({ targetId: "local", frame: indexed(1, "active") });
    shell.emitFrame({ targetId: "local", frame: turnError(3, "first turn failed") });
    shell.emitFrame({ targetId: "local", frame: indexed(2, "idle") });

    // Idle belongs to the failed turn itself, so it settles volatile state but
    // must not erase the error that explains that failure.
    expect(deriveAttention(runtime.getSnapshot().projection).error?.message).toBe(
      "first turn failed",
    );

    // A later turn starts, but its terminal event is missed across reconnect.
    // The complete index still proves active -> idle and safely settles it.
    shell.emitFrame({ targetId: "local", frame: turnStart(4) });
    shell.emitFrame({ targetId: "local", frame: indexed(3, "active") });
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({ targetId: "local", frame: indexed(4, "idle") });

    expect(runtime.getSnapshot().projection.turnActive).toBe(false);
    expect(deriveAttention(runtime.getSnapshot().projection).error).toBeNull();
    expect(runtime.getSnapshot().projection.notices.some((notice) => notice.kind === "error")).toBe(
      false,
    );
  });

it("settles a returned session from a truncated inventory after reconnect", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });

    const session = (status: "active" | "idle"): SessionsFrame["sessions"][number] => ({
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      project: {
        projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
      },
      revision: revision(`rev-${status}`),
      title: "Session",
      status,
      updatedAt: "2026-07-11T10:00:04Z",
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "epoch-1", seq: 1 },
        sessions: [session("active")],
        totalCount: 1,
        truncated: false,
      },
    });
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "epoch-2", seq: 1 },
        sessions: [session("idle")],
        totalCount: 2,
        truncated: true,
      },
    });
    // Truncation means absence is not authoritative. This session was present
    // in the current response, so its idle state is authoritative.
    expect(runtime.getSnapshot().projection.turnActive).toBe(false);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "sessions",
        cursor: { epoch: "epoch-2", seq: 2 },
        sessions: [session("idle")],
        totalCount: 1,
        truncated: false,
      },
    });
    expect(runtime.getSnapshot().projection.turnActive).toBe(false);
  });
});
