// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import {
  ProjectionStore,
  applyPublicFrame,
  createDesktopRuntimeController,
  createProjectionSnapshot,
  decodeProjectionCache,
  encodeProjectionCache,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
} from "@t4-code/client";
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
  type DurableEntryFrame,
  type LiveEventFrame,
  type OperationCapability,
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
import { deriveAttention, deriveTranscriptRows } from "../src/features/transcript/rows.ts";
import { buildProjectGroups } from "../src/lib/session-tree.ts";
import { deriveWorkspaceData, sessionViewId } from "../src/platform/live-workspace.ts";
import {
  acquireRuntimeController,
  startRuntimeController,
  type RuntimeSlotHolder,
} from "../src/platform/desktop-runtime.ts";
import { createMemoryPersistence } from "../src/state/persistence.ts";
import { createWorkspaceStore, selectSessionView } from "../src/state/workspace-store.ts";
import { bindProjectionInventoryResults, deferred, FakeShell, makeTarget, makeWelcome } from "./fake-shell.ts";

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

function turnError(seq: number, message: string): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event: {
      type: "turn.error",
      message,
      retryable: true,
      at: "2026-07-11T10:00:02Z",
    },
  };
}

function eventFrame(seq: number, event: LiveEventFrame["event"]): LiveEventFrame {
  return {
    v: V,
    type: "event",
    cursor: { epoch: "epoch-1", seq },
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    event,
  };
}

function durableEntryFrame(seq: number, value: DurableEntry): DurableEntryFrame {
  return {
    v: V,
    type: "entry",
    cursor: { epoch: "epoch-1", seq },
    revision: revision(`rev-${seq}`),
    hostId: hostId(HOST),
    sessionId: sessionId(SESSION),
    entry: value,
  };
}

function commandItem(
  name: string,
  capabilities?: readonly string[],
  slashCommand = false,
): CatalogItem {
  return {
    id: catalogId(`cmd-${name}`),
    kind: "command",
    name,
    description: `${name} command`,
    ...(capabilities === undefined ? {} : { capabilities: [...capabilities] }),
    ...(slashCommand ? { metadata: { slashCommand: true } } : {}),
  };
}

function catalogFrame(
  rev: string,
  items: CatalogItem[],
  operations?: OperationCapability[],
): CatalogFrame {
  return {
    v: V,
    type: "catalog",
    hostId: hostId(HOST),
    revision: revision(rev),
    items,
    ...(operations === undefined ? {} : { operations }),
  };
}

function pendingPromptSessionsFrame(
  entryIdValue: string,
  text: string,
  attachmentCount = 0,
): SessionsFrame {
  return {
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
        revision: revision("rev-pending"),
        title: "Session",
        status: "active",
        updatedAt: "2026-07-11T10:00:00Z",
        liveState: {
          pendingPrompt: {
            entryId: entryIdValue,
            text,
            attachmentCount,
            at: "2026-07-11T10:00:01Z",
          },
        },
      },
    ],
    totalCount: 1,
    truncated: false,
  };
}

function pendingPromptsSessionsFrame(
  prompts: readonly {
    readonly entryId: string;
    readonly text: string;
    readonly attachmentCount?: number;
    readonly at?: string;
  }[],
  seq = 1,
  status: "active" | "idle" = prompts.length > 0 ? "active" : "idle",
): SessionsFrame {
  return {
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
        revision: revision(`rev-pending-${seq}`),
        title: "Session",
        status,
        updatedAt: `2026-07-11T10:00:${String(seq).padStart(2, "0")}Z`,
        liveState: {
          pendingPrompts: prompts.map((prompt, index) => ({
            entryId: prompt.entryId,
            text: prompt.text,
            attachmentCount: prompt.attachmentCount ?? 0,
            at: prompt.at ?? `2026-07-11T10:01:${String(index).padStart(2, "0")}Z`,
          })),
        },
      },
    ],
    totalCount: 1,
    truncated: false,
  };
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
  // Complete session inventory: dispatch-time write freshness requires this
  // session's indexed ref, not just a bound target. seq 0 stays below every
  // frame the tests emit themselves.
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
            projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
          },
          revision: revision("rev-1"),
          title: "Session",
          status: "idle",
          updatedAt: "2026-07-11T09:59:00Z",
          liveState: { isStreaming: false },
        },
      ],
      totalCount: 1,
      truncated: false,
    } satisfies SessionsFrame,
  });
  bindProjectionInventoryResults(shell, controller);
  return { shell, controller };
}
async function settle(rounds = 12): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
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

    // Fail-closed: without proven session freshness the prompt refuses
    // locally (honest reason) instead of risking an unknown outcome.
    expect(outcome?.kind).toBe("rejected");
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

    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-1", [commandItem("compact", undefined, true)]),
    });
    expect(runtime.getSnapshot().slashCommands?.map((command) => command.name)).toEqual([
      "/compact",
    ]);

    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("rev-2", [
        commandItem("review", undefined, true),
        commandItem("terminal", ["terminal.io"], true),
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

  it("uses official OMP operation capabilities instead of mistaking typed commands for slash commands", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame(
        "official-operations",
        [commandItem("session.cancel")],
        [
          {
            operationId: "session.prompt" as OperationCapability["operationId"],
            label: "Prompt",
            execution: "typed",
            supported: true,
          },
          {
            operationId: "slash.compact" as OperationCapability["operationId"],
            label: "/compact",
            description: "Compact the active conversation",
            execution: "headless",
            supported: true,
            metadata: { aliases: ["compress"], inlineHint: "[focus]" },
          },
          {
            operationId: "slash.plan" as OperationCapability["operationId"],
            label: "/plan",
            description: "Toggle plan mode",
            execution: "terminal-only",
            supported: false,
            disabledReason: {
              code: "terminal_only",
              message: "/plan requires the OMP terminal interface.",
            },
          },
        ],
      ),
    });

    const commands = runtime.getSnapshot().slashCommands ?? [];
    expect(commands.map((command) => command.name)).toEqual(["/compact", "/plan"]);
    expect(commands[0]?.aliases).toEqual(["/compress"]);
    expect(commands[0]?.argsHint).toBe("[focus]");
    expect(commands[0]?.disabledReason).toBeNull();
    expect(commands[1]?.disabledReason).toBe("/plan requires the OMP terminal interface.");
  });

  it("treats an explicit empty operation list as authoritative", async () => {
    const { shell, runtime } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("empty-operations", [commandItem("/legacy")], []),
    });

    expect(runtime.getSnapshot().slashCommands).toEqual([]);
  });

  it("disables operation-derived commands for read-only clients", async () => {
    const { shell, runtime } = await startedRuntime([]);
    shell.emitFrame({
      targetId: "local",
      frame: catalogFrame("read-only-operations", [], [
        {
          operationId: "slash.compact" as OperationCapability["operationId"],
          label: "/compact",
          execution: "headless",
          supported: true,
        },
      ]),
    });

    expect(runtime.getSnapshot().slashCommands?.[0]?.disabledReason).toBe(
      "Not granted on this host",
    );
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

describe("workspace projection safety", () => {
  it("retires a stale command confirmation when a newer idle ref settles the session", async () => {
    const { shell, controller } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: {
        v: V,
        type: "confirmation",
        confirmationId: confirmationId("cancel-confirmation"),
        commandId: commandId("cancel-command"),
        hostId: hostId(HOST),
        sessionId: sessionId(SESSION),
        commandHash: "sha256:cancel",
        revision: revision("rev-1"),
        expiresAt: "2999-01-01T00:00:00Z",
        summary: "session.cancel",
      },
    });
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      pendingApprovals: 1,
      status: "pendingApproval",
    });

    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame([], 2, "idle"),
    });
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      lifecycle: "idle",
      pendingApprovals: 0,
      status: null,
    });
  });

  it("gives cached and offline freshness precedence over stale working refs", async () => {
    const { shell, controller } = await startedRuntime();
    shell.emitFrame({
      targetId: "local",
      frame: pendingPromptsSessionsFrame(
        [{ entryId: "prompt:stale-workspace", text: "keep going" }],
        1,
        "active",
      ),
    });
    expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
      freshness: "live",
      latestTurnCompletedAt: null,
      status: "working",
    });

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
    const cached = deriveWorkspaceData(controller.getSnapshot());
    expect(cached.sessions[0]).toMatchObject({
      freshness: "cached",
      latestTurnCompletedAt: null,
      status: null,
    });
    expect(
      buildProjectGroups(cached, {}, { [sessionViewId(HOST, SESSION)]: "2026-07-10T10:00:00Z" })[0]
        ?.sessions[0]?.unread,
    ).toBe(false);

    shell.emitState({ targetId: "local", state: "disconnected" });
    const offline = deriveWorkspaceData(controller.getSnapshot());
    expect(offline.sessions[0]).toMatchObject({
      freshness: "offline",
      latestTurnCompletedAt: null,
      status: null,
    });
    expect(
      buildProjectGroups(offline, {}, { [sessionViewId(HOST, SESSION)]: "2026-07-10T10:00:00Z" })[0]
        ?.sessions[0]?.unread,
    ).toBe(false);
  });

  it("shows idle refs with pending, queued, or compacting host work as working", async () => {
    const { shell, controller } = await startedRuntime();
    const liveStates = [
      {
        pendingPrompts: [
          {
            entryId: "prompt:workspace",
            text: "keep going",
            attachmentCount: 0,
            at: "2026-07-11T10:00:01Z",
          },
        ],
      },
      { queuedMessageCount: 1 },
      { isCompacting: true },
    ] as const;

    for (const [index, liveState] of liveStates.entries()) {
      shell.emitFrame({
        targetId: "local",
        frame: {
          v: V,
          type: "sessions",
          cursor: { epoch: "session-index-1", seq: index + 1 },
          sessions: [
            {
              hostId: hostId(HOST),
              sessionId: sessionId(SESSION),
              project: {
                projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
              },
              revision: revision(`rev-workspace-${index}`),
              title: "Session",
              status: "idle",
              updatedAt: `2026-07-11T10:00:0${index + 1}Z`,
              liveState,
            },
          ],
          totalCount: 1,
          truncated: false,
        },
      });

      expect(deriveWorkspaceData(controller.getSnapshot()).sessions[0]).toMatchObject({
        lifecycle: "idle",
        status: "working",
        latestTurnCompletedAt: null,
      });
    }
  });

  it("marks a host inventory partial when indexed refs fall below its advertised total", async () => {
    const { controller } = await startedRuntime();
    const base = controller.getSnapshot();
    const ref: SessionsFrame["sessions"][number] = {
      hostId: hostId(HOST),
      sessionId: sessionId(SESSION),
      project: {
        projectId: "project-1" as SessionsFrame["sessions"][number]["project"]["projectId"],
        name: "lycaon",
      },
      revision: revision("rev-1"),
      title: "Indexed session",
      status: "idle",
      updatedAt: "2026-07-11T10:00:00Z",
    };
    const incomplete: DesktopRuntimeSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        sessionIndex: new Map([[`${HOST}\u0000${SESSION}`, ref]]),
        sessionIndexMetadata: new Map([[HOST, { totalCount: 2, truncated: false }]]),
      },
    };

    expect(deriveWorkspaceData(incomplete).hosts[0]?.sessionInventoryTruncated).toBe(true);
  });

  it("keeps identical raw project ids isolated by host", async () => {
    const { controller } = await startedRuntime();
    const base = controller.getSnapshot();
    const firstHost = base.hosts.get(HOST);
    expect(firstHost).toBeDefined();
    if (firstHost === undefined) return;

    const otherHost = "host-b";
    const rawProjectId = "/workspace" as SessionsFrame["sessions"][number]["project"]["projectId"];
    const makeArchivedRef = (host: string, session: string): SessionsFrame["sessions"][number] => ({
      hostId: hostId(host),
      sessionId: sessionId(session),
      project: { projectId: rawProjectId, name: "workspace" },
      revision: revision(`rev-${session}`),
      title: session,
      status: "idle",
      updatedAt: "2026-07-11T10:00:00Z",
      archivedAt: "2026-07-12T10:00:00Z",
    });
    const firstRef = makeArchivedRef(HOST, "session-a");
    const secondRef = makeArchivedRef(otherHost, "session-b");
    const crossHost: DesktopRuntimeSnapshot = {
      ...base,
      targets: new Map([...base.targets, ["remote", makeTarget("remote", "connected")]]),
      connections: new Map([...base.connections, ["remote", "connected"]]),
      targetHosts: new Map([...base.targetHosts, ["remote", otherHost]]),
      hosts: new Map([
        ...base.hosts,
        [otherHost, { ...firstHost, targetId: "remote", hostId: otherHost }],
      ]),
      projection: {
        ...base.projection,
        sessionIndex: new Map([
          [`${HOST}\u0000session-a`, firstRef],
          [`${otherHost}\u0000session-b`, secondRef],
        ]),
        sessionIndexMetadata: new Map([
          [HOST, { totalCount: 1, truncated: false }],
          [otherHost, { totalCount: 1, truncated: false }],
        ]),
      },
    };

    const data = deriveWorkspaceData(crossHost);
    expect(data.projects.map((project) => project.id)).toEqual([
      `${encodeURIComponent(HOST)}/${encodeURIComponent(rawProjectId)}`,
      `${encodeURIComponent(otherHost)}/${encodeURIComponent(rawProjectId)}`,
    ]);
    expect(
      buildProjectGroups(data, {}, {}, "current", { [data.projects[0]!.id]: true }).map(
        (group) => group.project.id,
      ),
    ).toEqual([data.projects[1]!.id]);
  });

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
  it("hydrates the renderer projection from shell cache and persists later mutations", async () => {
    let warm = applyPublicFrame(
      createProjectionSnapshot(),
      snapshotFrame(1, [entry("cached", "from shell cache")]),
    );
    warm = applyPublicFrame(warm, pendingPromptsSessionsFrame([], 1, "idle"));
    const cachedValue = encodeProjectionCache(warm);
    const saves: string[] = [];
    let loads = 0;
    const cacheLoad = deferred<{ available: boolean; value: string | null }>();
    type CacheShell = FakeShell & {
      loadProjectionCache: () => Promise<{ available: boolean; value: string | null }>;
      saveProjectionCache: (request: { value: string }) => Promise<{ saved: boolean }>;
    };
    const shell = new FakeShell() as CacheShell;
    shell.loadProjectionCache = () => {
      loads += 1;
      return cacheLoad.promise;
    };
    shell.saveProjectionCache = async ({ value }) => {
      saves.push(value);
      return { saved: true };
    };
    const holder: RuntimeSlotHolder = {};
    const controller = acquireRuntimeController(shell, holder);
    const starting = controller.start();
    await settle();
    expect(loads).toBe(1);
    expect(shell.bootstrapCalls).toBe(0);
    cacheLoad.resolve({ available: true, value: cachedValue });
    await starting;
    expect(shell.bootstrapCalls).toBe(1);
    const cachedSession = controller.getSnapshot().projection.sessions.get(`${HOST}\u0000${SESSION}`);
    expect(cachedSession?.entries.map((item) => item.data)).toContainEqual({
      role: "assistant",
      text: "from shell cache",
    });
    const cachedGroups = buildProjectGroups(
      deriveWorkspaceData(controller.getSnapshot()),
      {},
      {},
    );
    expect(cachedGroups).toHaveLength(1);
    expect(cachedGroups[0]?.sessions.map((row) => row.session.id)).toContain(
      sessionViewId(HOST, SESSION),
    );
    expect(cachedGroups[0]?.host).toMatchObject({
      id: HOST,
      name: HOST,
      kind: "remote",
    });
    const cachedRow = cachedGroups[0]?.sessions[0];
    expect(cachedRow?.session.freshness).toBe("offline");
    const cachedRuntime = createLiveSessionRuntime({
      controller,
      targetId: "local",
      hostId: HOST,
      sessionId: SESSION,
    });
    expect(cachedRuntime.getSnapshot()).toMatchObject({
      link: "cached",
      canPrompt: false,
      canCancel: false,
    });
    expect(shell.commandCount("session.attach")).toBe(0);

    expect(shell.connectCalls).toBe(1);
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: durableEntryFrame(2, entry("live", "persist this mutation")),
    });
    await settle();
    expect(shell.commandCount("session.attach")).toBe(1);
    cachedRuntime.dispose();
    expect(saves.length).toBeGreaterThan(0);
    const persisted = decodeProjectionCache(saves.at(-1)!);
    const persistedSession = persisted.sessions.get(`${HOST}\u0000${SESSION}`);
    expect(persistedSession?.entries.map((item) => item.data)).toContainEqual({
      role: "assistant",
      text: "persist this mutation",
    });
    await controller.stop();
  });

  it("skips projection cache saves when the shell reports caching unavailable", async () => {
    let loads = 0;
    let saves = 0;
    type CacheShell = FakeShell & {
      loadProjectionCache: () => Promise<{ available: boolean; value: string | null }>;
      saveProjectionCache: (request: { value: string }) => Promise<{ saved: boolean }>;
    };
    const shell = new FakeShell() as CacheShell;
    shell.loadProjectionCache = async () => {
      loads += 1;
      return { available: false, value: null };
    };
    shell.saveProjectionCache = async () => {
      saves += 1;
      return { saved: false };
    };
    const holder: RuntimeSlotHolder = {};
    const controller = acquireRuntimeController(shell, holder);

    await controller.start();
    shell.emitFrame({
      targetId: "local",
      frame: makeWelcome(HOST, ["sessions.prompt"]),
    });
    shell.emitFrame({
      targetId: "local",
      frame: durableEntryFrame(2, entry("live", "do not persist")),
    });
    await settle();
    await controller.stop();

    expect(loads).toBe(1);
    expect(saves).toBe(0);
  });

  it("retains one live controller across a persisted pagehide/pageshow", async () => {
    class FakePageLifecycleTarget {
      private readonly listeners = new Map<string, Set<EventListener>>();
      addEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set<EventListener>();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }
      removeEventListener(type: "pagehide" | "pageshow", listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
      }
      dispatch(type: "pagehide" | "pageshow", persisted: boolean): void {
        const event = { type, persisted } as unknown as Event;
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }

    const shell = new FakeShell();
    const holder: RuntimeSlotHolder = {};
    const pageTarget = new FakePageLifecycleTarget();
    const first = acquireRuntimeController(shell, holder);
    startRuntimeController(shell, holder, pageTarget);
    await first.start();

    pageTarget.dispatch("pagehide", true);
    pageTarget.dispatch("pageshow", true);
    expect(acquireRuntimeController(shell, holder)).toBe(first);
    expect(first.getSnapshot().startState).toBe("started");

    pageTarget.dispatch("pagehide", false);
    expect(acquireRuntimeController(shell, holder)).not.toBe(first);
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
