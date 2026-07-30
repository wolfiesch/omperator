// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import { hostId, revision, sessionId } from "@t4-code/protocol";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import { deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { makeWelcome } from "./fake-shell.ts";
import { entry, eventFrame, HOST, pendingPromptSessionsFrame, pendingPromptsSessionsFrame, SESSION, snapshotFrame, startedController, turnStart, V } from "./live-composer-fixtures.ts";

describe("session pending prompt lifecycle", () => {
it("recovers one pending prompt across attach, reconnect, and runtime recreation", async () => {
    const { shell, controller } = await startedController();
    const pendingRef = pendingPromptSessionsFrame("prompt:request-attach", "keep going");
    shell.emitFrame({ targetId: "local", frame: pendingRef });

    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    let snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts).toEqual([
      {
        entryId: "prompt:request-attach",
        text: "keep going",
        attachmentCount: 0,
        at: "2026-07-11T10:00:01Z",
      },
    ]);
    let rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.id === "prompt:request-attach")).toHaveLength(1);
    expect(rows.find((row) => row.kind === "working")).toMatchObject({
      activity: "working",
      startedAt: null,
    });

    shell.emitState({ targetId: "local", state: "disconnected" });
    expect(runtime.getSnapshot().pendingPrompts[0]?.entryId).toBe("prompt:request-attach");
    shell.emitState({ targetId: "local", state: "connected" });
    expect(runtime.getSnapshot().pendingPrompts[0]?.entryId).toBe("prompt:request-attach");
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "gap",
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        from: { epoch: "epoch-1", seq: 1 },
        to: { epoch: "epoch-1", seq: 2 },
        reason: "replay_budget_exceeded",
      },
    });
    shell.emitFrame({ targetId: "local", frame: snapshotFrame(2, []) });
    snapshot = runtime.getSnapshot();
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.id === "prompt:request-attach")).toHaveLength(1);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts[0]?.entryId).toBe("prompt:request-attach");

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 2 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.update",
          entryId: "prompt:request-attach",
          role: "user",
          text: "keep going",
          at: "2026-07-11T10:00:01Z",
        },
      },
    });
    snapshot = runtime.getSnapshot();
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.id === "prompt:request-attach")).toHaveLength(1);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 3 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.settled",
          transientEntryId: "prompt:request-attach",
          entryId: "durable-user-attach",
        },
      },
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "entry",
        cursor: { epoch: "epoch-1", seq: 4 },
        revision: revision("rev-user-attached"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        entry: {
          ...entry("durable-user-attach", "keep going"),
          data: { role: "user", text: "keep going" },
        },
      },
    });
    snapshot = runtime.getSnapshot();
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.kind === "message" && row.role === "user")).toHaveLength(1);

    // The ref delta may lag the transcript settlement. A recreated runtime
    // recovers the retained settlement marker and must not resurrect it.
    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts).toEqual([]);
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.kind === "message" && row.role === "user")).toHaveLength(1);
    runtime.dispose();
  });

it("keeps accepted steer and multiple follow-ups visible across reconnect and retirement", async () => {
    const { shell, controller } = await startedController();
    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    expect(runtime.getSnapshot().sessionActive).toBe(true);

    await runtime.submitPrompt({ kind: "steer", text: "steer now" });
    await runtime.submitPrompt({ kind: "followUp", text: "follow one" });
    await runtime.submitPrompt({ kind: "followUp", text: "follow two" });
    expect(
      shell.commands.filter((request) => request.intent.command === "session.steer"),
    ).toHaveLength(1);
    expect(
      shell.commands.filter((request) => request.intent.command === "session.followUp"),
    ).toHaveLength(2);

    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame([
        { entryId: "prompt:steer", text: "steer now" },
        { entryId: "prompt:follow-1", text: "follow one" },
        { entryId: "prompt:follow-2", text: "follow two" },
      ]),
    });
    let snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts.map((prompt) => prompt.entryId)).toEqual([
      "prompt:steer",
      "prompt:follow-1",
      "prompt:follow-2",
    ]);
    let rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(
      rows.filter((row) => row.kind === "message" && row.role === "user").map((row) => row.id),
    ).toEqual(["prompt:steer", "prompt:follow-1", "prompt:follow-2"]);
    expect(rows.find((row) => row.kind === "working")).toMatchObject({
      activity: "working",
      startedAt: "2026-07-11T10:00:01Z",
    });

    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    expect(runtime.getSnapshot().pendingPrompts).toHaveLength(3);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts).toHaveLength(3);

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
          entryId: "prompt:steer",
          role: "user",
          text: "steer now",
          at: "2026-07-11T10:01:00Z",
        },
      },
    });
    snapshot = runtime.getSnapshot();
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.id === "prompt:steer")).toHaveLength(1);

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
          transientEntryId: "prompt:follow-1",
          entryId: "durable-follow-1",
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 5 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.discarded",
          transientEntryId: "prompt:follow-2",
          reason: "prompt_failed",
          at: "2026-07-11T10:01:03Z",
        },
      },
    });
    expect(runtime.getSnapshot().pendingPrompts.map((prompt) => prompt.entryId)).toEqual([
      "prompt:steer",
    ]);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts.map((prompt) => prompt.entryId)).toEqual(["prompt:steer"]);
    rows = deriveTranscriptRows(snapshot.projection, {
      pendingPrompts: snapshot.pendingPrompts,
      sessionActive: snapshot.sessionActive,
    });
    expect(rows.filter((row) => row.kind === "message" && row.role === "user")).toHaveLength(1);
    runtime.dispose();
  });

it("settles only prompt A and preserves newer prompt B through reconnect bootstrap", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame(
        [
          { entryId: "prompt:a", text: "prompt A" },
          { entryId: "prompt:b", text: "prompt B" },
        ],
        1,
        "idle",
      ),
    });
    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().sessionActive).toBe(true);

    shell.emitFrame({ targetId: "local", frame: turnStart(2) });
    for (const [seq, entryIdValue, text] of [
      [3, "prompt:a", "prompt A"],
      [4, "prompt:b", "prompt B"],
    ] as const) {
      shell.emitFrame({
        targetId: "local",
        frame: {
          v: V,
          type: "event",
          cursor: { epoch: "epoch-1", seq },
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          event: {
            type: "message.update",
            entryId: entryIdValue,
            role: "user",
            text,
            at: `2026-07-11T10:02:0${seq}Z`,
          },
        },
      });
    }

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 5 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.settled",
          transientEntryId: "prompt:a",
          entryId: "durable-a",
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "entry",
        cursor: { epoch: "epoch-1", seq: 6 },
        revision: revision("rev-durable-a"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        entry: {
          ...entry("durable-a", "prompt A"),
          data: { role: "user", text: "prompt A" },
        },
      },
    });
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame([{ entryId: "prompt:b", text: "prompt B" }], 2, "idle"),
    });

    let snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts.map((prompt) => prompt.entryId)).toEqual(["prompt:b"]);
    expect(snapshot.projection.turnActive).toBe(true);
    expect(snapshot.projection.liveMessages.has("prompt:b")).toBe(true);
    expect(snapshot.sessionActive).toBe(true);

    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    snapshot = runtime.getSnapshot();
    expect(snapshot.projection.turnActive).toBe(true);
    expect(snapshot.projection.liveMessages.has("prompt:b")).toBe(true);
    expect(snapshot.link).toBe("cached");
    expect(snapshot.sessionActive).toBe(false);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts.map((prompt) => prompt.entryId)).toEqual(["prompt:b"]);
    expect(snapshot.link).toBe("cached");
    expect(snapshot.sessionActive).toBe(false);
    expect(
      deriveTranscriptRows(snapshot.projection, {
        pendingPrompts: snapshot.pendingPrompts,
        sessionActive: snapshot.sessionActive,
      }).filter((row) => row.id === "prompt:b"),
    ).toHaveLength(1);

    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame([{ entryId: "prompt:b", text: "prompt B" }], 3, "idle"),
    });
    expect(runtime.getSnapshot()).toMatchObject({ link: "live", sessionActive: true });
    runtime.dispose();
  });

it("treats a present empty pendingPrompts list as authoritative over legacy singular state", async () => {
    const { shell, controller } = await startedController();
    const legacy = pendingPromptSessionsFrame("prompt:legacy-stale", "stale");
    const legacySession = legacy.sessions[0];
    if (legacySession === undefined) throw new Error("pending prompt fixture missing session");
    shell.emitFrame({
      targetId: "local",
      frame: {
        ...legacy,
        sessions: [
          {
            ...legacySession,
            liveState: { ...legacySession.liveState, pendingPrompts: [] },
          },
        ],
      },
    });

    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);
    runtime.dispose();
  });

it("does not resurrect a discarded pending prompt from a lagging session ref", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptSessionsFrame("prompt:request-discard", "", 2),
    });
    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    let snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts).toEqual([
      expect.objectContaining({
        entryId: "prompt:request-discard",
        text: "",
        attachmentCount: 2,
      }),
    ]);
    expect(
      deriveTranscriptRows(snapshot.projection, {
        pendingPrompts: snapshot.pendingPrompts,
        sessionActive: snapshot.sessionActive,
      }).find((row) => row.id === "prompt:request-discard"),
    ).toMatchObject({ kind: "message", text: "2 images attached" });

    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    snapshot = runtime.getSnapshot();
    expect(snapshot.pendingPrompts[0]?.attachmentCount).toBe(2);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 2 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.discarded",
          transientEntryId: "prompt:request-discard",
          reason: "prompt_failed",
          at: "2026-07-11T10:00:02Z",
        },
      },
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);
    runtime.dispose();
  });

it("allows a later user message to reuse an earlier retired pending prompt id", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptSessionsFrame("prompt:request-reused", "new prompt"),
    });
    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, {
        type: "message.discarded",
        transientEntryId: "prompt:request-reused",
        reason: "prompt_failed",
        at: "2026-07-11T10:00:02Z",
      }),
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(3, {
        type: "message.update",
        entryId: "prompt:request-reused",
        role: "user",
        text: "new prompt",
      }),
    });
    expect(runtime.getSnapshot().pendingPrompts.map((prompt) => prompt.entryId)).toEqual([
      "prompt:request-reused",
    ]);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts.map((prompt) => prompt.entryId)).toEqual([
      "prompt:request-reused",
    ]);
    runtime.dispose();
  });

it("does not let rejected duplicate or gapped events rewrite pending prompt retirement", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptSessionsFrame("prompt:request-retired", "old prompt"),
    });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, {
        type: "message.discarded",
        transientEntryId: "prompt:request-retired",
        reason: "prompt_failed",
      }),
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, {
        type: "message.update",
        entryId: "prompt:request-retired",
        role: "user",
        text: "stale duplicate",
      }),
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(4, {
        type: "message.update",
        entryId: "prompt:request-retired",
        role: "user",
        text: "past a gap",
      }),
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);
    expect(runtime.getSnapshot().projection.phase).toBe("paused");
    runtime.dispose();
  });

it("does not resurrect a legacy entryId discard from warm retained events", async () => {
    const { shell, controller } = await startedController();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptSessionsFrame("prompt:request-legacy-discard", "do the thing"),
    });
    let runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts[0]?.entryId).toBe("prompt:request-legacy-discard");

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "event",
        cursor: { epoch: "epoch-1", seq: 2 },
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        event: {
          type: "message.discarded",
          entryId: "prompt:request-legacy-discard",
          reason: "prompt_failed",
          at: "2026-07-11T10:00:02Z",
        },
      },
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);

    runtime.dispose();
    runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(runtime.getSnapshot().pendingPrompts).toEqual([]);
    runtime.dispose();
  });

it("does not count a lagging retired pending ref as active after settle or discard", async () => {
    for (const retirement of ["settled", "discarded"] as const) {
      const { shell, controller } = await startedController();
      shell.emitFrame({
        targetId: "local",
        frame: pendingPromptsSessionsFrame(
          [{ entryId: `prompt:${retirement}`, text: retirement }],
          1,
          "idle",
        ),
      });
      let runtime = createLiveSessionRuntime({
        controller,
        targetId: "local",
        hostId: HOST,
        sessionId: SESSION,
      });
      expect(runtime.getSnapshot().sessionActive).toBe(true);

      shell.emitFrame({
        targetId: "local",
        frame: {
          v: V,
          type: "event",
          cursor: { epoch: "epoch-1", seq: 2 },
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          event:
            retirement === "settled"
              ? {
                  type: "message.settled",
                  transientEntryId: "prompt:settled",
                  entryId: "durable:settled",
                }
              : {
                  type: "message.discarded",
                  transientEntryId: "prompt:discarded",
                  reason: "prompt_failed",
                  at: "2026-07-11T10:00:02Z",
                },
        },
      });

      let snapshot = runtime.getSnapshot();
      expect(snapshot.pendingPrompts).toEqual([]);
      expect(snapshot.sessionActive).toBe(false);
      expect(
        deriveTranscriptRows(snapshot.projection, {
          pendingPrompts: snapshot.pendingPrompts,
          sessionActive: snapshot.sessionActive,
        }).some((row) => row.kind === "working"),
      ).toBe(false);

      runtime.dispose();
      runtime = createLiveSessionRuntime({
        controller,
        targetId: "local",
        hostId: HOST,
        sessionId: SESSION,
      });
      snapshot = runtime.getSnapshot();
      expect(snapshot.pendingPrompts).toEqual([]);
      expect(snapshot.sessionActive).toBe(false);
      runtime.dispose();
    }
  });
});
