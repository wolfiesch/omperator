// Observer UX against the real DesktopRuntimeController and the concrete
// fake shell: `liveState.sessionControl` gates every write affordance
// (prompt, cancel, slash palette, model/thinking/fast) with honest copy
// while attach and transcript reading stay available, absence keeps the
// session writable, and the gate lifts the moment the host clears the
// field. No command ever leaves this client while another app owns the
// session — the server stays final authority, this client just never asks.
import { describe, expect, it } from "vite-plus/test";
import {
  catalogId,
  commandId,
  confirmationId,
  hostId,
  projectId,
  revision,
  sessionId,
  type CatalogFrame,
  type CatalogItem,
  type SessionDeltaFrame,
  type SessionsFrame,
} from "@t4-code/protocol";
import { createDesktopRuntimeController, type DesktopRuntimeController } from "@t4-code/client";

import type { SessionRuntime } from "../src/features/session-runtime/controller.ts";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import {
  OFFLINE_WRITE_REASON,
  presentSessionControl,
} from "../src/features/session-runtime/session-observer.ts";
import { presentSessionState } from "../src/features/session-runtime/session-state.ts";
import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";

const V = "omp-app/1" as const;
const HOST = "host-a";
const SESSION = "session-a";

function commandItem(name: string): CatalogItem {
  return {
    id: catalogId(`cmd-${name}`),
    kind: "command",
    name,
    description: `${name} command`,
  };
}

const CATALOG: CatalogFrame = {
  v: V,
  type: "catalog",
  hostId: hostId(HOST),
  revision: revision("rev-cat"),
  items: [
    commandItem("session.cancel"),
    commandItem("session.model.set"),
    commandItem("session.thinking.set"),
    commandItem("session.fast.set"),
    commandItem("retry"),
  ],
};

function sessionsUpsert(seq: number, extra: Record<string, unknown>): SessionsFrame {
  return {
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
        revision: revision("rev-1"),
        title: "Session",
        status: "active",
        updatedAt: "2026-07-11T10:00:00Z",
        ...extra,
      },
    ],
  };
}

function sessionDelta(seq: number, extra: Record<string, unknown>): SessionDeltaFrame {
  return {
    v: V,
    type: "session.delta",
    cursor: { epoch: "epoch-1", seq },
    revision: revision("rev-2"),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    upsert: {
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      project: { projectId: projectId("project-1") },
      revision: revision("rev-2"),
      title: "Session",
      status: "active",
      updatedAt: "2026-07-11T10:00:01Z",
      ...extra,
    },
  };
}

interface Setup {
  readonly shell: FakeShell;
  readonly controller: DesktopRuntimeController;
  readonly runtime: SessionRuntime;
}

async function startedRuntime(): Promise<Setup> {
  const shell = new FakeShell();
  const controller = createDesktopRuntimeController({ shell });
  await controller.start();
  shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
  shell.emitFrame({
    targetId: "local",
    frame: {
      v: V,
      type: "snapshot",
      cursor: { epoch: "epoch-1", seq: 1 },
      revision: revision("rev-1"),
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      entries: [],
    },
  });
  shell.emitFrame({ targetId: "local", frame: CATALOG });
  const runtime = createLiveSessionRuntime({
    controller,
    targetId: "local",
    hostId: HOST,
    sessionId: SESSION,
  });
  return { shell, controller, runtime };
}

const OBSERVER_LIVE = {
  sessionControl: { mode: "observer", lockStatus: "live", transcript: "live" },
} as const;

describe("live runtime observer gating", () => {
  it("keeps a session without the field fully writable (backward compatibility)", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { isStreaming: false } }),
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionControl).toBeNull();
    expect(snapshot.link).toBe("live");
    expect(snapshot.canPrompt).toBe(true);
    expect(snapshot.controls.modelSupported).toBe(true);
    runtime.dispose();
    await controller.stop();
  });

  it("marks an externally discovered row read-only before the session is opened", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { hostOwned: false, status: "idle" }),
    });

    const row = deriveWorkspaceData(controller.getSnapshot()).sessions[0]!;
    expect(row).toMatchObject({ hostOwned: false, lifecycle: "idle", status: null });
    expect(row.control).toBeUndefined();
    expect(presentSessionState(row).label).toBe("Read-only");

    runtime.dispose();
    await controller.stop();
  });

  it("gates every write while observing, with reading intact", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { ...OBSERVER_LIVE, isStreaming: true } }),
    });

    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionControl).toEqual(OBSERVER_LIVE.sessionControl);
    const presentation = presentSessionControl(OBSERVER_LIVE.sessionControl);
    // Transcript reading stays available; only writes gate.
    expect(snapshot.link).toBe("live");
    expect(snapshot.canPrompt).toBe(false);
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.cancelDisabledReason).toBe(presentation.cancelReason);
    // Slash actions stay visible with the honest reason.
    for (const command of snapshot.slashCommands ?? []) {
      expect(command.disabledReason).toBe(presentation.slashReason);
    }
    // Model/thinking/fast controls gate; values keep host truth.
    expect(snapshot.controls.modelSupported).toBe(false);
    expect(snapshot.controls.modelUnsupportedReason).toBe(presentation.controlReason);
    expect(snapshot.controls.thinkingSupported).toBe(false);
    expect(snapshot.controls.fastSupported).toBe(false);
    expect(snapshot.controls.attachmentsSupported).toBe(false);

    // Every prompt-shaped write refuses locally; nothing reaches the wire.
    for (const intent of [
      { kind: "prompt", text: "ship it", attachments: [] },
      { kind: "steer", text: "go left" },
      { kind: "followUp", text: "and then" },
      { kind: "prompt", text: "/retry", attachments: [] },
      { kind: "cancel" },
      { kind: "setModel", role: "default", selector: null },
      { kind: "setThinking", level: "high" },
      { kind: "setFast", enabled: true },
    ] as const) {
      const outcome = await runtime.submitPrompt(intent);
      expect(outcome).toEqual({ kind: "rejected", reason: presentation.composerReason });
    }
    expect(shell.commandCount("session.prompt")).toBe(0);
    expect(shell.commandCount("session.steer")).toBe(0);
    expect(shell.commandCount("session.followUp")).toBe(0);
    expect(shell.commandCount("session.cancel")).toBe(0);
    expect(shell.commandCount("session.model.set")).toBe(0);
    expect(shell.commandCount("session.thinking.set")).toBe(0);
    expect(shell.commandCount("session.fast.set")).toBe(0);

    // Ownership remains separate from confirmed turn activity.
    const row = deriveWorkspaceData(controller.getSnapshot()).sessions[0];
    expect(row).toMatchObject({ control: "observer", status: "working" });

    runtime.dispose();
    await controller.stop();
  });

  it("projects the snapshot-transcript observer and reconciling states distinctly", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        liveState: {
          sessionControl: { mode: "observer", lockStatus: "suspect", transcript: "snapshot" },
        },
      }),
    });
    expect(runtime.getSnapshot().sessionControl).toEqual({
      mode: "observer",
      lockStatus: "suspect",
      transcript: "snapshot",
    });

    shell.emitFrame({
      targetId: "local",
      frame: sessionDelta(3, {
        liveState: { sessionControl: { mode: "reconciling", transcript: "live" } },
      }),
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionControl).toEqual({ mode: "reconciling", transcript: "live" });
    expect(snapshot.canPrompt).toBe(false);
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      control: "reconciling",
      status: "working",
    });
    runtime.dispose();
    await controller.stop();
  });

  it("treats a present but unrecognized shape as read-only, never writable", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { sessionControl: { mode: "future-mode" } } }),
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionControl).toEqual({ mode: "unknown" });
    expect(snapshot.canPrompt).toBe(false);
    // The rail row stays read-only without claiming another app is active.
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      control: "unclear",
      status: null,
    });
    runtime.dispose();
    await controller.stop();
  });

  it("never says Active elsewhere for a malformed lock — ownership is unclear", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        liveState: {
          sessionControl: { mode: "observer", lockStatus: "malformed", transcript: "snapshot" },
        },
      }),
    });
    expect(runtime.getSnapshot().canPrompt).toBe(false);
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      control: "unclear",
      status: null,
    });
    runtime.dispose();
    await controller.stop();
  });

  it("projects a quiet lock as waiting to take over, not active elsewhere", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, {
        liveState: {
          sessionControl: { mode: "observer", lockStatus: "suspect", transcript: "live" },
        },
      }),
    });
    expect(runtime.getSnapshot().canPrompt).toBe(false);
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      control: "suspect",
      status: null,
    });
    runtime.dispose();
    await controller.stop();
  });

  it("returns to writable the moment the host clears the field", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { ...OBSERVER_LIVE } }),
    });
    expect(runtime.getSnapshot().canPrompt).toBe(false);

    shell.emitFrame({
      targetId: "local",
      frame: sessionDelta(3, { liveState: { isStreaming: false } }),
    });
    const snapshot = runtime.getSnapshot();
    expect(snapshot.sessionControl).toBeNull();
    expect(snapshot.canPrompt).toBe(true);
    expect(snapshot.controls.modelSupported).toBe(true);
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]?.control).toBeUndefined();

    // Writes flow again once the gate lifts.
    const outcome = await runtime.submitPrompt({ kind: "prompt", text: "go", attachments: [] });
    expect(outcome).toEqual({ kind: "accepted" });
    expect(shell.commandCount("session.prompt")).toBe(1);
    runtime.dispose();
    await controller.stop();
  });
});

describe("dispatch-time rechecks", () => {
  it("rechecks ownership after the control barrier before a prompt dispatches", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { isStreaming: false } }),
    });
    expect(runtime.getSnapshot().canPrompt).toBe(true);

    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const model = runtime.submitPrompt({ kind: "setModel", role: "default", selector: null });
    const prompt = runtime.submitPrompt({ kind: "prompt", text: "race", attachments: [] });

    // Takeover lands while the model round-trip still holds the barrier.
    shell.emitFrame({
      targetId: "local",
      frame: sessionDelta(3, { liveState: { ...OBSERVER_LIVE } }),
    });
    gate.resolve(true);
    await model;

    const outcome = await prompt;
    expect(outcome).toEqual({
      kind: "rejected",
      reason: presentSessionControl(OBSERVER_LIVE.sessionControl).composerReason,
    });
    expect(shell.commandCount("session.prompt")).toBe(0);
    runtime.dispose();
    await controller.stop();
  });

  it("lets offline freshness copy win over stale observer copy", async () => {
    const { shell, controller, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { ...OBSERVER_LIVE } }),
    });
    shell.emitState({ targetId: "local", state: "disconnected" });

    const outcome = await runtime.submitPrompt({ kind: "prompt", text: "go", attachments: [] });
    expect(outcome).toEqual({ kind: "rejected", reason: OFFLINE_WRITE_REASON });
    expect(shell.commandCount("session.prompt")).toBe(0);
    runtime.dispose();
    await controller.stop();
  });
});

describe("lease-acquisition races", () => {
  it("releases a lease acquired across a takeover instead of dispatching cancel", async () => {
    // controller.lease negotiated: session.cancel acquires a lease first.
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"], ["controller.lease"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "snapshot",
        cursor: { epoch: "epoch-1", seq: 1 },
        revision: revision("rev-1"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        entries: [],
      },
    });
    shell.emitFrame({ targetId: "local", frame: CATALOG });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { isStreaming: false } }),
    });

    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const cancel = runtime.submitPrompt({ kind: "cancel" });
    // The takeover lands while controller.lease.acquire is still pending.
    shell.emitFrame({
      targetId: "local",
      frame: sessionDelta(3, { liveState: { ...OBSERVER_LIVE } }),
    });
    gate.resolve(true);

    const outcome = await cancel;
    expect(outcome).toEqual({
      kind: "rejected",
      reason: presentSessionControl(OBSERVER_LIVE.sessionControl).composerReason,
    });
    // The command never left; the freshly acquired lease released
    // best-effort instead of blocking peers until expiry.
    expect(shell.commandCount("session.cancel")).toBe(0);
    expect(shell.commandCount("controller.lease.acquire")).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commandCount("controller.lease.release")).toBe(1);
    runtime.dispose();
    await controller.stop();
  });
});

describe("coalesced lease windows", () => {
  it("a gate rejection never releases a lease a coalesced peer dispatches with", async () => {
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"], ["controller.lease"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { isStreaming: false } }),
    });

    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const intent = {
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      command: "session.cancel",
      args: {},
    };
    // Both calls coalesce onto one pending acquisition; only one gate fails.
    const rejecting = controller.commandWithControllerLease("local", intent, "rev-1", () => {
      throw new Error("gated after acquisition");
    });
    const dispatching = controller.commandWithControllerLease("local", intent, "rev-1");
    gate.resolve(true);

    await expect(rejecting).rejects.toThrow("gated after acquisition");
    const result = await dispatching;
    expect(result.accepted).toBe(true);
    // The peer's dispatch went out with the shared lease intact.
    expect(shell.commandCount("session.cancel")).toBe(1);
    expect(shell.commandCount("controller.lease.release")).toBe(0);
    await controller.stop();
  });
});

describe("approval decision outcomes", () => {
  async function challengedRuntime() {
    const setup = await startedRuntime();
    setup.shell.emitFrame({
      targetId: "local",
      frame: sessionsUpsert(2, { liveState: { isStreaming: false } }),
    });
    // Let the attach round-trip settle so the warm session holds the card.
    await Promise.resolve();
    await Promise.resolve();
    setup.shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "confirmation",
        confirmationId: confirmationId("approve-1"),
        commandId: commandId("cmd-approve-1"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        commandHash: "sha256:approve",
        revision: revision("rev-1"),
        expiresAt: "2999-01-01T00:00:00.000Z",
        summary: "run the tool",
      },
    });
    return setup;
  }

  it("never reports acceptance when the host refused or the wire dropped", async () => {
    const { shell, controller, runtime } = await challengedRuntime();
    shell.confirmBehavior = { kind: "reject" };
    const refused = await runtime.submitPrompt({ kind: "approval", approvalId: "approve-1", decision: "approve" });
    expect(refused.kind).toBe("rejected");
    shell.confirmBehavior = { kind: "throw" };
    const dropped = await runtime.submitPrompt({ kind: "approval", approvalId: "approve-1", decision: "approve" });
    expect(dropped.kind).toBe("unknown");
    // The card never retired optimistically; a working host settles it.
    shell.confirmBehavior = { kind: "accept" };
    const settled = await runtime.submitPrompt({ kind: "approval", approvalId: "approve-1", decision: "approve" });
    expect(settled).toEqual({ kind: "accepted" });
    expect(shell.confirms).toHaveLength(3);
    runtime.dispose();
    await controller.stop();
  });

  it("refuses an approval decision after a takeover without touching the host", async () => {
    const { shell, controller, runtime } = await challengedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: sessionDelta(3, { liveState: { ...OBSERVER_LIVE } }),
    });
    const outcome = await runtime.submitPrompt({ kind: "approval", approvalId: "approve-1", decision: "approve" });
    expect(outcome).toEqual({
      kind: "rejected",
      reason: presentSessionControl(OBSERVER_LIVE.sessionControl).composerReason,
    });
    expect(shell.confirms).toHaveLength(0);
    runtime.dispose();
    await controller.stop();
  });
});
