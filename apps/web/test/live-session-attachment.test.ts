// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import { ProjectionStore, applyPublicFrame, createDesktopRuntimeController, createProjectionSnapshot, encodeProjectionCache } from "@t4-code/client";
import { hostId, sessionId } from "@t4-code/protocol";
import type { CommandRequest, CommandResult } from "@t4-code/protocol/desktop-ipc";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import type { SessionRuntime } from "../src/features/session-runtime/controller.ts";
import { obtainLiveRuntime } from "../src/features/session-runtime/useSessionRuntime.ts";
import { sessionViewId } from "../src/platform/live-workspace.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";
import { durableEntryFrame, entry, eventFrame, HOST, pendingPromptsSessionsFrame, SESSION, settle, snapshotFrame, startedController, startedRuntime, V } from "./live-composer-fixtures.ts";

describe("session attachment and transcript history", () => {
it("selecting the same session twice attaches exactly once", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    const viewId = sessionViewId(HOST, SESSION);

    const first = obtainLiveRuntime(controller, viewId, cache);
    const again = obtainLiveRuntime(controller, viewId, cache);
    expect(again).toBe(first);
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);
  });

it("replaces a startup fallback runtime when a named target binds the restored host", async () => {
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    const cache = new Map<string, SessionRuntime>();
    const viewId = sessionViewId(HOST, SESSION);

    const fallback = obtainLiveRuntime(controller, viewId, cache);
    expect(shell.commandCount("session.attach")).toBe(0);

    shell.emitState({ targetId: "local:candidate", state: "connected" });
    shell.emitFrame({
      targetId: "local:candidate",
      frame: makeWelcome(HOST, ["sessions.read", "sessions.prompt"]),
    });
    const rebound = obtainLiveRuntime(controller, viewId, cache);

    expect(rebound).not.toBe(fallback);
    await Promise.resolve();
    expect(shell.commands.find((request) => request.intent.command === "session.attach")?.targetId)
      .toBe("local:candidate");

    fallback.dispose();
    rebound.dispose();
    await controller.stop();
  });

it("paints a bounded cold tail before starting the full live attach", async () => {
    const shell = new FakeShell();
    shell.commandResult = (request) =>
      request.intent.command === "transcript.page"
        ? {
            entries: [entry("tail-1", "Newest saved answer")],
            nextCursor: "older-1",
            hasMore: true,
            generation: "generation-1",
          }
        : undefined;
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"], ["transcript.page"]),
    });
    shell.emitFrame({ targetId: "local", frame: pendingPromptsSessionsFrame([], 0, "idle") });

    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    await settle();

    expect(
      shell.commands
        .map((request) => request.intent.command)
        .filter((command) => command === "transcript.page" || command === "session.attach"),
    ).toEqual(["transcript.page", "session.attach"]);
    expect(runtime.getSnapshot().projection.entries.map((value) => value.id)).toEqual(["tail-1"]);
    expect(runtime.getSnapshot().transcriptHistory).toMatchObject({
      phase: "ready",
      hasMore: true,
    });

    runtime.dispose();
    await controller.stop();
  });

it("prepends overlapping history without changing the live cursor", async () => {
    const shell = new FakeShell();
    shell.commandResult = (request) => {
      if (request.intent.command !== "transcript.page") return undefined;
      return request.intent.args.before === "older-1"
        ? {
            entries: [entry("history-1", "Earlier"), entry("tail-1", "Overlap")],
            hasMore: false,
            generation: "generation-1",
          }
        : {
            entries: [entry("tail-1", "Tail"), entry("tail-2", "Tail two")],
            nextCursor: "older-1",
            hasMore: true,
            generation: "generation-1",
          };
    };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"], ["transcript.page"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: snapshotFrame(5, [
        entry("tail-1", "Tail"),
        entry("tail-2", "Tail two"),
        entry("live-1", "Live"),
      ]),
    });
    shell.emitFrame({ targetId: "local", frame: pendingPromptsSessionsFrame([], 0, "idle") });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    await settle();

    await runtime.loadEarlierTranscript?.();

    expect(runtime.getSnapshot().projection.entries.map((value) => value.id)).toEqual([
      "history-1",
      "tail-1",
      "tail-2",
      "live-1",
    ]);
    expect(runtime.getSnapshot().projection.cursor).toEqual({ epoch: "epoch-1", seq: 5 });
    expect(runtime.getSnapshot().transcriptHistory).toMatchObject({
      phase: "ready",
      hasMore: false,
    });

    runtime.dispose();
    await controller.stop();
  });

it("restores an entry missing from a gappy warm projection when the page supplies it", async () => {
    const shell = new FakeShell();
    shell.commandResult = (request) => {
      if (request.intent.command !== "transcript.page") return undefined;
      return {
        entries: [
          entry("tail-1", "Tail"),
          entry("gap-1", "Dropped user turn"),
          entry("tail-2", "Tail two"),
        ],
        hasMore: false,
        generation: "generation-1",
      };
    };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"], ["transcript.page"]),
    });
    // Warm projection is missing "gap-1" but retains the entries on both sides of it.
    shell.emitFrame({
      targetId: "local",
      frame: snapshotFrame(5, [entry("tail-1", "Tail"), entry("tail-2", "Tail two")]),
    });
    shell.emitFrame({ targetId: "local", frame: pendingPromptsSessionsFrame([], 0, "idle") });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    await settle();

    expect(runtime.getSnapshot().projection.entries.map((value) => value.id)).toEqual([
      "tail-1",
      "gap-1",
      "tail-2",
    ]);

    runtime.dispose();
    await controller.stop();
  });

it("keeps live entries outside the page range in order while repairing a gap", async () => {
    const shell = new FakeShell();
    shell.commandResult = (request) => {
      if (request.intent.command !== "transcript.page") return undefined;
      // The bounded page only describes the tail-1..tail-2 range.
      return {
        entries: [
          entry("tail-1", "Tail"),
          entry("gap-1", "Dropped user turn"),
          entry("tail-2", "Tail two"),
        ],
        hasMore: false,
        generation: "generation-1",
      };
    };
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.read"], ["transcript.page"]),
    });
    // Warm projection straddles the page: it holds an older entry before the page
    // range and a newer entry after it, and is missing "gap-1" inside the range.
    shell.emitFrame({
      targetId: "local",
      frame: snapshotFrame(5, [
        entry("older-1", "Older"),
        entry("tail-1", "Tail"),
        entry("tail-2", "Tail two"),
        entry("newer-1", "Newer"),
      ]),
    });
    shell.emitFrame({ targetId: "local", frame: pendingPromptsSessionsFrame([], 0, "idle") });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    await settle();

    expect(runtime.getSnapshot().projection.entries.map((value) => value.id)).toEqual([
      "older-1",
      "tail-1",
      "gap-1",
      "tail-2",
      "newer-1",
    ]);

    runtime.dispose();
    await controller.stop();
  });

it("rebuilds retained ask, approval, and plan state across runtime recreation", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(2, {
        type: "ask.request",
        askId: "warm-ask",
        question: "Which path?",
        options: [{ id: "one", label: "One" }],
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: durableEntryFrame(3, entry("between-events", "Durable event gap")),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(4, {
        type: "approval.request",
        approvalId: "warm-approval",
        title: "Approval",
        message: "Continue?",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(5, {
        type: "plan.ready",
        planId: "warm-plan",
        title: "Plan",
        body: "1. Continue",
      }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(6, { type: "ask.resolved", askId: "warm-ask" }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: snapshotFrame(6, [entry("between-events", "Durable event gap")]),
    });
    runtime.dispose();

    const recreated = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(recreated.getSnapshot().projection.ask).toBeNull();
    expect(recreated.getSnapshot().projection.approval?.approvalId).toBe("warm-approval");
    expect(recreated.getSnapshot().projection.plan?.planId).toBe("warm-plan");
    expect(
      shell.commands.findLast((request) => request.intent.command === "session.attach")?.intent
        .args,
    ).toEqual({ cursor: { epoch: "epoch-1", seq: 6 } });

    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(7, { type: "approval.resolved", approvalId: "warm-approval" }),
    });
    shell.emitFrame({
      targetId: "local",
      frame: eventFrame(8, { type: "plan.resolved", planId: "warm-plan" }),
    });
    recreated.dispose();
    const settled = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(settled.getSnapshot().projection.approval).toBeNull();
    expect(settled.getSnapshot().projection.ask).toBeNull();
    expect(settled.getSnapshot().projection.plan).toBeNull();
    settled.dispose();
  });

it("subscribes before attach so synchronous replay frames reach the transcript", async () => {
    class SynchronousReplayShell extends FakeShell {
      private replayed = false;

      override async command(request: CommandRequest): Promise<CommandResult> {
        const result = super.command(request);
        if (request.intent.command === "session.attach" && !this.replayed) {
          this.replayed = true;
          this.emitFrame({
            targetId: request.targetId,
            frame: eventFrame(2, {
              type: "ask.request",
              askId: "attach-replay-ask",
              question: "Replay reached the renderer?",
              options: [],
            }),
          });
        }
        return result;
      }
    }

    const shell = new SynchronousReplayShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    expect(runtime.getSnapshot().projection.ask?.askId).toBe("attach-replay-ask");
    expect(runtime.getSnapshot().projection.cursor).toEqual({ epoch: "epoch-1", seq: 2 });

    runtime.dispose();
    await controller.stop();
  });

it("keeps cached controls gated until an exact-head attach acknowledgement", async () => {
    let warm = applyPublicFrame(createProjectionSnapshot(), snapshotFrame(1, []));
    warm = applyPublicFrame(
      warm,
      eventFrame(2, {
        type: "ask.request",
        askId: "cached-ask",
        question: "Still pending?",
        options: [],
      }),
    );
    const cache = encodeProjectionCache(warm);
    const projection = new ProjectionStore({
      cacheStore: {
        load: () => cache,
        save: () => undefined,
      },
    });
    await projection.hydrated;
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell, projection });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame([], 0, "idle"),
    });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });

    expect(runtime.getSnapshot().link).toBe("cached");
    expect(runtime.getSnapshot().canPrompt).toBe(false);
    expect(runtime.getSnapshot().canCancel).toBe(false);
    expect(runtime.getSnapshot().projection.ask?.askId).toBe("cached-ask");

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "response",
        requestId: "attach-ahead" as never,
        commandId: "attach-ahead-command" as never,
        command: "session.attach",
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        ok: true,
        result: { attached: true, cursor: { epoch: "epoch-1", seq: 3 } },
      },
    });
    expect(runtime.getSnapshot().link).toBe("cached");
    expect(runtime.getSnapshot().canPrompt).toBe(false);

    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "response",
        requestId: "attach-exact" as never,
        commandId: "attach-exact-command" as never,
        command: "session.attach",
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        ok: true,
        result: { attached: true, cursor: { epoch: "epoch-1", seq: 2 } },
      },
    });
    expect(runtime.getSnapshot().link).toBe("live");
    expect(runtime.getSnapshot().canPrompt).toBe(true);
    expect(runtime.getSnapshot().projection.ask?.askId).toBe("cached-ask");

    runtime.dispose();
    await controller.stop();
  });

it("waits for connection before attaching and ignores repeated connected notifications", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    shell.emitState({ targetId: "local", state: "disconnected" });
    obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);

    expect(shell.commandCount("session.attach")).toBe(0);
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);
  });

it("reattaches once after disconnect and reconnect", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);

    shell.emitState({ targetId: "local", state: "disconnected" });
    await Promise.resolve();
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    shell.emitState({ targetId: "local", state: "connected" });
    expect(shell.commandCount("session.attach")).toBe(2);
    const reconnectAttach = shell.commands.filter(
      (request) => request.intent.command === "session.attach",
    )[1];
    expect(reconnectAttach?.intent.args).toEqual({ cursor: { epoch: "epoch-1", seq: 1 } });
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(2);
  });

it("reattaches after a new host welcome even when the disconnected notification was missed", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);
    await settle();
    expect(shell.commandCount("session.attach")).toBe(1);

    shell.emitFrame({
      targetId: "local",
      frame: {
        ...makeWelcome(HOST, ["sessions.prompt"]),
        epoch: "epoch-2",
      },
    });
    await settle();

    expect(shell.commandCount("session.attach")).toBe(2);
  });

it("retries an attach rejected by the host on a later controller notification", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    shell.commandBehavior = { kind: "reject" };
    obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);
    await settle();
    expect(shell.commandCount("session.attach")).toBe(1);

    shell.commandBehavior = { kind: "accept" };
    shell.emitState({ targetId: "local", state: "connected" });
    await settle();
    expect(shell.commandCount("session.attach")).toBe(2);
  });

it("does not reattach after disposal while an attach is pending", async () => {
    const { shell, controller } = await startedController();
    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const cache = new Map<string, SessionRuntime>();
    const runtime = obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);
    shell.emitState({ targetId: "local", state: "disconnected" });
    shell.emitState({ targetId: "local", state: "connected" });
    runtime.dispose();
    gate.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);
  });

it("reconnect flips the link but never clears the transcript", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: snapshotFrame(1, [entry("entry-1", "Hello from the host")]),
    });
    expect(runtime.getSnapshot().link).toBe("live");
    expect(runtime.getSnapshot().projection.entries).toHaveLength(1);

    shell.emitState({ targetId: "local", state: "disconnected" });
    const offline = runtime.getSnapshot();
    expect(offline.link).toBe("offline");
    expect(offline.canPrompt).toBe(false);
    expect(offline.projection.entries).toHaveLength(1);

    shell.emitState({ targetId: "local", state: "connected" });
    // Reconnect drops inventory completeness; the host replays its session
    // list before the link may claim live again.
    shell.emitFrame({ targetId: "local", frame: pendingPromptsSessionsFrame([], 99, "idle") });
    const restored = runtime.getSnapshot();
    expect(restored.link).toBe("live");
    expect(restored.projection.entries.map((item) => String(item.id))).toEqual(["entry-1"]);
    expect(restored.projection.entries[0]?.data.text).toBe("Hello from the host");
  });
});
