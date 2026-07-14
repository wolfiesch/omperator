// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import { createDesktopRuntimeController, type DesktopRuntimeController } from "@t4-code/client";
import {
  catalogId,
  commandId,
  confirmationId,
  entryId,
  hostId,
  revision,
  sessionId,
  type CatalogFrame,
  type CatalogItem,
  type DurableEntry,
  type LiveEventFrame,
  type SessionSnapshotFrame,
  type SessionsFrame,
} from "@t4-code/protocol";
import type {
  CommandRequest,
  CommandResult,
  CommandResultError,
} from "@t4-code/protocol/desktop-ipc";

import {
  createSubmissionGate,
  settleSubmission,
  type SubmissionIo,
  type SubmissionNotice,
} from "../src/features/composer/submission.ts";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import type { SessionRuntime } from "../src/features/session-runtime/controller.ts";
import { IMAGE_PROMPTS_UNSUPPORTED_REASON } from "../src/features/session-runtime/intents.ts";
import { IMAGE_UPLOAD_CHUNK_BYTES } from "../src/features/session-runtime/image-upload.ts";
import { obtainLiveRuntime } from "../src/features/session-runtime/useSessionRuntime.ts";
import { deriveWorkspaceData, sessionViewId } from "../src/platform/live-workspace.ts";
import {
  acquireRuntimeController,
  startRuntimeController,
  type RuntimeSlotHolder,
} from "../src/platform/desktop-runtime.ts";
import { createMemoryPersistence } from "../src/state/persistence.ts";
import { createWorkspaceStore, selectSessionView } from "../src/state/workspace-store.ts";
import { deferred, FakeShell, makeWelcome } from "./fake-shell.ts";

const V = "omp-app/1" as const;
const HOST = "host-a";
const SESSION = "session-a";

function entry(id: string, text: string): DurableEntry {
  return {
    id: entryId(id),
    parentId: null,
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    kind: "message",
    timestamp: "2026-07-11T10:00:00Z",
    data: { role: "assistant", text },
  };
}

function snapshotFrame(seq: number, entries: DurableEntry[]): SessionSnapshotFrame {
  return {
    v: V,
    type: "snapshot",
    cursor: { epoch: "epoch-1", seq },
    revision: revision("rev-1"),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    entries,
  };
}

function turnStart(seq: number): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event: { type: "turn.start", at: "2026-07-11T10:00:01Z" },
  };
}

function commandItem(name: string, capabilities?: readonly string[]): CatalogItem {
  return {
    id: catalogId(`cmd-${name}`),
    kind: "command",
    name,
    description: `${name} command`,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
  };
}

function catalogFrame(rev: string, items: CatalogItem[]): CatalogFrame {
  return { v: V, type: "catalog", hostId: hostId(HOST), revision: revision(rev), items };
}

interface ControllerSetup {
  readonly shell: FakeShell;
  readonly controller: DesktopRuntimeController;
}

async function startedController(
  capabilities: readonly string[] = ["sessions.prompt"],
  features: readonly string[] = [],
): Promise<ControllerSetup> {
  const shell = new FakeShell();
  const controller = createDesktopRuntimeController({ shell });
  await controller.start();
  shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, capabilities, features) });
  shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
  return { shell, controller };
}

interface LiveSetup extends ControllerSetup {
  readonly runtime: SessionRuntime;
}

async function startedRuntime(
  capabilities: readonly string[] = ["sessions.prompt"],
  features: readonly string[] = [],
): Promise<LiveSetup> {
  const { shell, controller } = await startedController(capabilities, features);
  const runtime = createLiveSessionRuntime({
    controller,
    targetId: "local",
    hostId: HOST,
    sessionId: SESSION,
  });
  return { shell, controller, runtime };
}

interface DraftHarness {
  readonly io: SubmissionIo;
  readonly draft: () => string;
  readonly setDraft: (value: string) => void;
  readonly notice: () => SubmissionNotice;
  readonly removed: readonly string[];
}

function draftHarness(initialDraft: string): DraftHarness {
  const store = createWorkspaceStore({ persistence: createMemoryPersistence() });
  const viewId = sessionViewId(HOST, SESSION);
  store.getState().setSessionDraft(viewId, initialDraft);
  let notice: SubmissionNotice = null;
  const removed: string[] = [];
  return {
    io: {
      getDraft: () => selectSessionView(store.getState(), viewId).draft,
      clearDraft: () => store.getState().setSessionDraft(viewId, ""),
      removeAttachments: (ids) => removed.push(...ids),
      setNotice: (value) => {
        notice = value;
      },
    },
    draft: () => selectSessionView(store.getState(), viewId).draft,
    setDraft: (value) => store.getState().setSessionDraft(viewId, value),
    notice: () => notice,
    removed,
  };
}

const PROMPT = {
  kind: "prompt",
  text: "ship it",
  attachments: [],
} as const;

const REJECTION_CASES: readonly {
  readonly label: string;
  readonly error?: CommandResultError;
  readonly reason: string;
}[] = [
  {
    label: "busy session",
    error: { code: "session_busy", message: "session is busy" },
    reason:
      "This session is still handling the previous turn. Your draft is safe; wait for the session to become idle, then send it again.",
  },
  {
    label: "stale revision",
    error: { code: "stale_revision", message: "revision changed" },
    reason:
      "The session changed before the host could accept this message. Your draft is safe; wait for the session to refresh, then send it again.",
  },
  {
    label: "closed session",
    error: { code: "unknown_session", message: "session is not indexed" },
    reason:
      "This session is closed on the host, so it cannot accept another message. Your draft is safe; start a new session before sending it.",
  },
  {
    label: "unknown outcome",
    error: { code: "outcome_unknown", message: "connection closed before result" },
    reason:
      "The host could not confirm whether this message was accepted. Your draft is safe; check the transcript before sending again to avoid a duplicate.",
  },
  {
    label: "unclassified rejection",
    reason:
      "The host did not accept this message. Your draft is safe; check the session state and try again.",
  },
];

describe("prompt submission outcomes", () => {
  it("accepted clears the submitted draft and attachments through the live runtime", async () => {
    const { shell, runtime } = await startedRuntime();
    const harness = draftHarness("ship it");
    const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));

    const outcome = await gate.submit(
      PROMPT,
      { text: "ship it", attachmentIds: ["att-1"] },
      harness.io,
    );

    expect(outcome).toEqual({ kind: "accepted" });
    expect(harness.draft()).toBe("");
    expect(harness.removed).toEqual(["att-1"]);
    expect(harness.notice()).toBeNull();
    expect(shell.commandCount("session.prompt")).toBe(1);
    const sent = shell.commands.find((request) => request.intent.command === "session.prompt");
    expect(sent?.intent.args).toEqual({ message: "ship it" });
    expect(sent?.intent.expectedRevision).toBeUndefined();
  });

  it("does not send before the first session snapshot establishes a revision", async () => {
    const shell = new FakeShell();
    const controller = createDesktopRuntimeController({ shell });
    await controller.start();
    shell.emitFrame({ targetId: "local", frame: makeWelcome(HOST, ["sessions.prompt"]) });
    const runtime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    const harness = draftHarness("ship it");
    const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));

    const outcome = await gate.submit(PROMPT, { text: "ship it", attachmentIds: [] }, harness.io);

    expect(outcome?.kind).toBe("unknown");
    expect(harness.draft()).toBe("ship it");
    expect(shell.commandCount("session.prompt")).toBe(0);
  });

  it("rejects image metadata without a negotiated upload protocol instead of dropping it", async () => {
    const { shell, runtime } = await startedRuntime();

    const outcome = await runtime.submitPrompt({
      kind: "prompt",
      text: "inspect this",
      attachments: [
        {
          id: "attachment-proof",
          kind: "image",
          mediaType: "image/png",
          name: "proof.png",
          sizeBytes: 12,
        },
      ],
    });

    expect(outcome).toEqual({ kind: "rejected", reason: IMAGE_PROMPTS_UNSUPPORTED_REASON });
    expect(shell.commandCount("session.prompt")).toBe(0);
  });

  it("uploads negotiated images and sends only ordered image refs in the prompt", async () => {
    const { shell, runtime } = await startedRuntime(["sessions.prompt"], ["prompt.images"]);
    const imageId = "123e4567-e89b-42d3-a456-426614174000";
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03,
    ]);
    const file = new File([bytes], "proof-from-android.png", { type: "" });
    let received = 0;
    shell.command = async (request: CommandRequest): Promise<CommandResult> => {
      shell.commands.push(request);
      const command = request.intent.command;
      let result: unknown;
      if (command === "session.image.begin") {
        result = { imageId, chunkBytes: IMAGE_UPLOAD_CHUNK_BYTES };
      } else if (command === "session.image.chunk") {
        const content = String(request.intent.args?.content);
        received += atob(content).length;
        result = { imageId, received, complete: received === file.size };
      } else if (command === "session.image.discard") {
        result = { discarded: true };
      } else if (command === "session.prompt") {
        result = { accepted: true };
      }
      return {
        targetId: request.targetId,
        requestId: `image-req-${shell.commands.length}`,
        commandId: `image-cmd-${shell.commands.length}`,
        accepted: true,
        ...(result === undefined ? {} : { result }),
      };
    };

    expect(runtime.getSnapshot().controls.attachmentsSupported).toBe(true);
    const outcome = await runtime.submitPrompt({
      kind: "prompt",
      text: "inspect this image",
      attachments: [
        {
          id: "attachment-proof",
          kind: "image",
          mediaType: "image/png",
          name: file.name,
          sizeBytes: file.size,
          file,
        },
      ],
    });

    expect(outcome).toEqual({ kind: "accepted" });
    expect(
      shell.commands
        .filter((request) => request.intent.command.startsWith("session.image."))
        .map((request) => request.intent.command),
    ).toEqual(["session.image.begin", "session.image.chunk", "session.image.discard"]);
    const begin = shell.commands.find(
      (request) => request.intent.command === "session.image.begin",
    );
    expect(begin?.intent.args).toMatchObject({
      mimeType: "image/png",
      size: file.size,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const prompt = shell.commands.find((request) => request.intent.command === "session.prompt");
    expect(prompt?.intent.args).toEqual({
      message: "inspect this image",
      images: [{ imageId }],
    });
    expect(JSON.stringify(prompt?.intent.args)).not.toContain(file.name);
    expect(JSON.stringify(prompt?.intent.args)).not.toContain("iVBOR");
    expect(shell.commandCount("session.prompt")).toBe(1);
  });

  it.each(REJECTION_CASES)(
    "$label keeps the exact draft and shows actionable copy without replaying",
    async ({ error, reason }) => {
      const { shell, runtime } = await startedRuntime();
      shell.commandBehavior = { kind: "reject", ...(error === undefined ? {} : { error }) };
      const harness = draftHarness("ship it");
      const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));
      const outcome = await gate.submit(
        PROMPT,
        { text: "ship it", attachmentIds: ["att-1"] },
        harness.io,
      );
      expect(outcome).toEqual({ kind: "rejected", reason });
      expect(harness.draft()).toBe("ship it");
      expect(harness.removed).toEqual([]);
      expect(harness.notice()).toEqual({ kind: "rejected", message: reason });
      expect(shell.commandCount("session.prompt")).toBe(1);
    },
  );

  it("keeps the duplicate-send warning when unknown outcome includes runtime fallout", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.commandBehavior = {
      kind: "reject",
      error: {
        code: "outcome_unknown",
        message: "rpc child stdout frame exceeded 1 MiB after oversized agent_end",
        details: { diagnostic: "x".repeat(8_192) },
      },
    };
    const harness = draftHarness("ship it");
    const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));
    const outcome = await gate.submit(PROMPT, { text: "ship it", attachmentIds: [] }, harness.io);
    expect(outcome).toEqual({
      kind: "rejected",
      reason:
        "The host could not confirm whether this message was accepted. Your draft is safe; check the transcript before sending again to avoid a duplicate.",
    });
    expect(harness.draft()).toBe("ship it");
    expect(shell.commandCount("session.prompt")).toBe(1);
  });

  it("an unknown outcome (transport died mid-flight) keeps everything and never replays", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.commandBehavior = { kind: "throw" };
    const harness = draftHarness("ship it");
    const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));

    const outcome = await gate.submit(PROMPT, { text: "ship it", attachmentIds: [] }, harness.io);

    expect(outcome?.kind).toBe("unknown");
    expect(harness.draft()).toBe("ship it");
    expect(harness.notice()?.kind).toBe("unknown");
    expect(shell.commandCount("session.prompt")).toBe(1);
  });

  it("deduplicates a double-submit while the first is still pending", async () => {
    const { shell, runtime } = await startedRuntime();
    const gate = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate };
    const harness = draftHarness("ship it");
    const submission = createSubmissionGate((intent) => runtime.submitPrompt(intent));

    const first = submission.submit(PROMPT, { text: "ship it", attachmentIds: [] }, harness.io);
    expect(submission.pending()).toBe(true);
    const second = await submission.submit(
      PROMPT,
      { text: "ship it", attachmentIds: [] },
      harness.io,
    );
    expect(second).toBeNull();

    gate.resolve(true);
    const outcome = await first;
    expect(outcome).toEqual({ kind: "accepted" });
    expect(shell.commandCount("session.prompt")).toBe(1);
  });

  it("text typed during the round-trip survives an accepted outcome", async () => {
    // End-to-end: the shell defers, the user keeps typing, acceptance lands.
    const { shell, runtime } = await startedRuntime();
    const wire = deferred<boolean>();
    shell.commandBehavior = { kind: "defer", gate: wire };
    const harness = draftHarness("v1");
    const gate = createSubmissionGate((intent) => runtime.submitPrompt(intent));

    const settled = gate.submit(
      { ...PROMPT, text: "v1" },
      { text: "v1", attachmentIds: [] },
      harness.io,
    );
    expect(gate.pending()).toBe(true);
    // The user types more while the send is in flight.
    harness.setDraft("v1 plus what I typed while sending");
    wire.resolve(true);
    const outcome = await settled;

    expect(outcome).toEqual({ kind: "accepted" });
    expect(harness.draft()).toBe("v1 plus what I typed while sending");

    // Pure settlement invariant: acceptance clears only an unchanged draft.
    const unchanged = settleSubmission(
      { kind: "accepted" },
      { text: "v1", attachmentIds: [] },
      "v1",
    );
    expect(unchanged.clearDraft).toBe(true);
  });
});

describe("stop affordance and slash catalog", () => {
  it("offers no stop command until the catalog advertises session.cancel", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: snapshotFrame(1, []) });
    shell.emitFrame({ targetId: "local", frame: turnStart(2) });

    let snapshot = runtime.getSnapshot();
    expect(snapshot.projection.turnActive).toBe(true);
    expect(snapshot.canCancel).toBe(false);
    expect(snapshot.cancelDisabledReason).toBe("Waiting for this host's command list");

    const before = shell.commandCount("session.cancel");
    const outcome = await runtime.submitPrompt({ kind: "cancel" });
    expect(outcome.kind).toBe("rejected");
    expect(shell.commandCount("session.cancel")).toBe(before);

    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [commandItem("session.cancel")]),
    });
    snapshot = runtime.getSnapshot();
    expect(snapshot.canCancel).toBe(true);
    expect(snapshot.cancelDisabledReason).toBeNull();
    await runtime.submitPrompt({ kind: "cancel" });
    expect(shell.commandCount("session.cancel")).toBe(1);
  });

  it("catalog updates change the slash choices live and gate terminal commands honestly", async () => {
    const { shell, runtime } = await startedRuntime();
    // Desktop mode never invents commands: before a catalog, the palette is
    // empty (not the browser built-ins).
    expect(runtime.getSnapshot().slashCommands).toEqual([]);

    shell.emitFrame({ targetId: "local", frame: catalogFrame("rev-1", [commandItem("compact")]) });
    expect(runtime.getSnapshot().slashCommands?.map((command) => command.name)).toEqual([
      "/compact",
    ]);

    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [
        commandItem("review"),
        commandItem("terminal", ["terminal.io"]),
      ]),
    });
    const commands = runtime.getSnapshot().slashCommands ?? [];
    expect(commands.map((command) => command.name)).toEqual(["/review", "/terminal"]);
    // terminal.io was not negotiated on this connection: the command stays
    // visible with the honest reason instead of pretending to work.
    expect(commands.find((command) => command.name === "/terminal")?.disabledReason).toBe(
      "Needs terminal access on this host",
    );
    expect(commands.find((command) => command.name === "/review")?.disabledReason).toBeNull();
  });
});

describe("confirmations", () => {
  const challenge = {
    v: V,
    type: "confirmation",
    confirmationId: confirmationId("confirm-1"),
    commandId: commandId("cmd-1"),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    commandHash: "sha256:abc",
    revision: revision("rev-1"),
    expiresAt: "2999-01-01T00:00:00Z",
    summary: "Write src/index.ts",
  } as const;

  it("sends the typed confirm request and hides the card only after the host acknowledges", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({ targetId: "local", frame: challenge });
    expect(runtime.getSnapshot().projection.approval?.approvalId).toBe("confirm-1");

    const gate = deferred<boolean>();
    shell.confirmBehavior = { kind: "defer", gate };
    const settled = runtime.submitPrompt({
      kind: "approval",
      approvalId: "confirm-1",
      decision: "approve",
    });
    // Round-trip still in flight: the card must stay visible.
    expect(runtime.getSnapshot().projection.approval?.approvalId).toBe("confirm-1");

    gate.resolve(true);
    await settled;
    expect(runtime.getSnapshot().projection.approval).toBeNull();

    expect(shell.confirms).toHaveLength(1);
    const request = shell.confirms[0];
    expect(String(request?.confirmationId)).toBe("confirm-1");
    expect(String(request?.commandId)).toBe("cmd-1");
    expect(request?.decision).toBe("approve");
  });
});
describe("session lifecycle", () => {
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
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(2);
  });

  it("retries an attach rejected by the host on a later controller notification", async () => {
    const { shell, controller } = await startedController();
    const cache = new Map<string, SessionRuntime>();
    shell.commandBehavior = { kind: "reject" };
    obtainLiveRuntime(controller, sessionViewId(HOST, SESSION), cache);
    await Promise.resolve();
    await Promise.resolve();
    expect(shell.commandCount("session.attach")).toBe(1);

    shell.commandBehavior = { kind: "accept" };
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    shell.emitState({ targetId: "local", state: "connected" });
    await Promise.resolve();
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
    const restored = runtime.getSnapshot();
    expect(restored.link).toBe("live");
    expect(restored.projection.entries.map((item) => String(item.id))).toEqual(["entry-1"]);
    expect(restored.projection.entries[0]?.data.text).toBe("Hello from the host");
  });
});

describe("workspace projection safety", () => {
  it("keeps the advertised project name when the newest session omits it", async () => {
    const { shell, controller } = await startedRuntime();
    const project = "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"];
    const sessions: SessionsFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq: 1 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId("session-new"),
          project: { projectId: project },
          revision: revision("rev-new"),
          title: "Session",
          status: "idle",
          updatedAt: "2026-07-11T11:00:00Z",
        },
        {
          hostId: hostId(HOST),
          sessionId: sessionId("session-old"),
          project: { projectId: project, name: "lycaon" },
          revision: revision("rev-old"),
          title: "Existing session",
          status: "idle",
          updatedAt: "2026-07-11T10:00:00Z",
        },
      ],
    };
    shell.emitFrame({ targetId: "local", frame: sessions });

    const data = deriveWorkspaceData(controller.getSnapshot());
    expect(data.sessions).toHaveLength(2);
    expect(data.projects).toEqual([expect.objectContaining({ name: "lycaon", path: "lycaon" })]);
  });

  it("renders live titles and never a remote absolute path", async () => {
    const { shell, controller } = await startedRuntime();
    const sessions: SessionsFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq: 1 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId:
              "/home/user/dev/secret-project" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Fix the flaky test",
          status: "active",
          updatedAt: "2026-07-11T10:00:00Z",
        },
      ],
    };
    shell.emitFrame({ targetId: "local", frame: sessions });

    const data = deriveWorkspaceData(controller.getSnapshot());
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]?.title).toBe("Fix the flaky test");
    const project = data.projects[0];
    expect(project?.name).toBe("secret-project");
    expect(project?.path).toBe("secret-project");
    expect(project?.name.includes("/home/")).toBe(false);
    expect(project?.path.includes("/home/")).toBe(false);
  });
});

describe("window runtime slot", () => {
  it("StrictMode/HMR double-invocation reuses one controller and starts once", async () => {
    const shell = new FakeShell();
    const holder: RuntimeSlotHolder = {};

    const first = acquireRuntimeController(shell, holder);
    const again = acquireRuntimeController(shell, holder);
    expect(again).toBe(first);

    startRuntimeController(shell, holder);
    startRuntimeController(shell, holder);
    await first.start();
    expect(shell.bootstrapCalls).toBe(1);
    expect(shell.connectCalls).toBe(1);
    await first.stop();
  });
});
describe("authoritative live runtime protocol", () => {
  it("uses prompt-lease for prompt, steer, followUp and response, and controller-lease for cancel", async () => {
    const { shell, controller, runtime } = await startedRuntime(
      ["sessions.prompt", "sessions.control"],
      ["prompt.lease"],
    );
    // Emit catalog containing cancel so cancel intent is allowed
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [commandItem("session.cancel")]),
    });

    let promptLeaseCalled = false;
    let promptLeaseRevision: string | undefined;
    let controllerLeaseCalled = false;

    const origPromptLease = controller.commandWithPromptLease;
    controller.commandWithPromptLease = async function (targetId, intent, leaseRevision) {
      promptLeaseCalled = true;
      promptLeaseRevision = leaseRevision;
      return origPromptLease.call(this, targetId, intent, leaseRevision);
    };

    const origControllerLease = controller.commandWithControllerLease;
    controller.commandWithControllerLease = async function (targetId, intent) {
      controllerLeaseCalled = true;
      return origControllerLease.call(this, targetId, intent);
    };

    // 1. prompt -> session.prompt
    promptLeaseCalled = false;
    await runtime.submitPrompt(PROMPT);
    expect(promptLeaseCalled).toBe(true);
    const cmd1 = shell.commands.find((c) => c.intent.command === "session.prompt");
    expect(cmd1).toBeDefined();
    expect(cmd1?.intent.args).toEqual({ message: "ship it", leaseId: "prompt-lease-fixture" });
    expect(cmd1?.intent.expectedRevision).toBeUndefined();
    expect(promptLeaseRevision).toBe("rev-1");

    // 2. steer -> session.steer
    promptLeaseCalled = false;
    await runtime.submitPrompt({ kind: "steer", text: "steer message" });
    expect(promptLeaseCalled).toBe(true);
    const cmd2 = shell.commands.find((c) => c.intent.command === "session.steer");
    expect(cmd2).toBeDefined();
    expect(cmd2?.intent.args).toEqual({
      message: "steer message",
      leaseId: "prompt-lease-fixture",
    });
    expect(cmd2?.intent.expectedRevision).toBeUndefined();

    // 3. followUp -> session.followUp (sent immediately, even during active turn)
    promptLeaseCalled = false;
    await runtime.submitPrompt({ kind: "followUp", text: "followup message" });
    expect(promptLeaseCalled).toBe(true);
    const cmd3 = shell.commands.find((c) => c.intent.command === "session.followUp");
    expect(cmd3).toBeDefined();
    expect(cmd3?.intent.args).toEqual({
      message: "followup message",
      leaseId: "prompt-lease-fixture",
    });
    expect(cmd3?.intent.expectedRevision).toBeUndefined();

    // 4. cancel -> session.cancel (controller-lease path)
    controllerLeaseCalled = false;
    await runtime.submitPrompt({ kind: "cancel" });
    expect(controllerLeaseCalled).toBe(true);
    const cmd4 = shell.commands.find((c) => c.intent.command === "session.cancel");
    expect(cmd4).toBeDefined();
    expect(cmd4?.intent.expectedRevision).toBeUndefined();
  });

  it("omits volatile revisions from prompt, steer, and follow-up commands", async () => {
    const { shell, runtime } = await startedRuntime();

    await runtime.submitPrompt(PROMPT);
    await runtime.submitPrompt({ kind: "steer", text: "steer message" });
    await runtime.submitPrompt({ kind: "followUp", text: "followup message" });

    const prompt = shell.commands.find((request) => request.intent.command === "session.prompt");
    const steer = shell.commands.find((request) => request.intent.command === "session.steer");
    const followUp = shell.commands.find(
      (request) => request.intent.command === "session.followUp",
    );
    expect(prompt?.intent.expectedRevision).toBeUndefined();
    expect(steer?.intent.expectedRevision).toBeUndefined();
    expect(followUp?.intent.expectedRevision).toBeUndefined();
  });

  it("projects queuedFollowUps from host liveState and performs no local queue mutation", async () => {
    const { shell, runtime } = await startedRuntime();

    // Initially, queuedFollowUps should be empty
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);

    // Submit a follow-up. Since there is no local queue, it is sent immediately.
    await runtime.submitPrompt({ kind: "followUp", text: "local-followup" });
    // Local queue remains empty (no local queue mutation)
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);

    // Now, emit host session index update with queued followUps
    const sessions: SessionsFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq: 2 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Session Title",
          status: "active",
          updatedAt: "2026-07-11T10:00:00Z",
          liveState: {
            queuedMessages: {
              followUp: ["host-queued-1", "host-queued-2"],
            },
          },
        },
      ],
    };
    shell.emitFrame({ targetId: "local", frame: sessions });

    // Verify projection derived queuedFollowUps from host state
    expect(runtime.getSnapshot().queuedFollowUps).toEqual(["host-queued-1", "host-queued-2"]);

    // Verify strict type checks (invalid liveState format should result in empty array)
    const badSessions: SessionsFrame = {
      v: V,
      type: "sessions",
      cursor: { epoch: "epoch-1", seq: 3 },
      sessions: [
        {
          hostId: hostId(HOST),
          sessionId: sessionId(SESSION),
          project: {
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Session Title",
          status: "active",
          updatedAt: "2026-07-11T10:00:00Z",
          liveState: {
            queuedMessages: "not-an-object",
          },
        },
      ],
    };
    shell.emitFrame({ targetId: "local", frame: badSessions });
    expect(runtime.getSnapshot().queuedFollowUps).toEqual([]);
  });

  it("routes ask/approval and challenge properly based on confirmation map presence", async () => {
    const { shell, runtime } = await startedRuntime();

    // 1. Ask intent routing -> session.ui.respond with requestId and value string
    await runtime.submitPrompt({
      kind: "ask",
      askId: "ask-question-1",
      optionIds: ["opt-1", "opt-2"],
      text: "User input text",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "ask-question-1",
      value: "User input text",
    });

    // Ask with empty text should send selected options combined or as choice
    await runtime.submitPrompt({
      kind: "ask",
      askId: "ask-question-2",
      optionIds: ["opt-choice"],
      text: "",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "ask-question-2",
      value: "opt-choice",
    });

    // 2. Streamed approval (no matching confirmation challenge) -> session.ui.respond with requestId and confirmed
    await runtime.submitPrompt({
      kind: "approval",
      approvalId: "rpc-approval-1",
      decision: "approve",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "rpc-approval-1",
      confirmed: true,
    });

    await runtime.submitPrompt({
      kind: "approval",
      approvalId: "rpc-approval-2",
      decision: "deny",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "rpc-approval-2",
      confirmed: false,
    });

    // 3. Plan approval intent (approve/reject/revise) -> session.ui.respond
    await runtime.submitPrompt({
      kind: "plan",
      planId: "plan-1",
      action: "approve",
      note: "",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "plan-1",
      confirmed: true,
    });

    await runtime.submitPrompt({
      kind: "plan",
      planId: "plan-2",
      action: "reject",
      note: "",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "plan-2",
      confirmed: false,
    });

    await runtime.submitPrompt({
      kind: "plan",
      planId: "plan-3",
      action: "revise",
      note: "Revision notes",
    });
    expect(shell.commands.at(-1)?.intent.command).toBe("session.ui.respond");
    expect(shell.commands.at(-1)?.intent.args).toEqual({
      requestId: "plan-3",
      value: "Revision notes",
    });
  });
});
