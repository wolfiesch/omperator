// Live composer behavior against the real DesktopRuntimeController and a
// concrete fake shell: prompt outcomes settle the draft correctly (clear
// only on accepted; rejected/unknown keep everything and never replay),
// double-submits dedupe while pending, the slash palette follows the live
// catalog, stop follows the negotiated cancel command, confirmations stay
// visible until the host acknowledges, session selection attaches once,
// and a reconnect never clears the transcript.
import { describe, expect, it } from "vite-plus/test";
import { createDesktopRuntimeController, type DesktopRuntimeSnapshot } from "@t4-code/client";
import { commandId, confirmationId, hostId, revision, sessionId, type OperationCapability, type SessionsFrame } from "@t4-code/protocol";
import type { CommandRequest, CommandResult, CommandResultError } from "@t4-code/protocol/desktop-ipc";

import { createSubmissionGate, settleSubmission, type SubmissionIo, type SubmissionNotice } from "../src/features/composer/submission.ts";
import { createLiveSessionRuntime } from "../src/features/session-runtime/live-runtime.ts";
import { IMAGE_PROMPTS_UNSUPPORTED_REASON } from "../src/features/session-runtime/intents.ts";
import { IMAGE_UPLOAD_CHUNK_BYTES } from "../src/features/session-runtime/image-upload.ts";
import { buildProjectGroups } from "../src/lib/session-tree.ts";
import { deriveWorkspaceData, sessionViewId } from "../src/platform/live-workspace.ts";
import { createMemoryPersistence } from "../src/state/persistence.ts";
import { createWorkspaceStore, selectSessionView } from "../src/state/workspace-store.ts";
import { deferred, FakeShell, makeTarget, makeWelcome } from "./fake-shell.ts";
import { catalogFrame, commandItem, HOST, pendingPromptsSessionsFrame, PROMPT, SESSION, snapshotFrame, startedRuntime, turnStart, V } from "./live-composer-fixtures.ts";

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
