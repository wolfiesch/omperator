// Live session runtime: the desktop implementation of the SessionRuntime
// seam, backed by a DesktopRuntimeController. Frames flow one way — the
// controller's typed subscription feeds the same transcript reducer the
// fixture uses — and every user action leaves as a typed command through
// the controller. Nothing here scrapes terminal output, parses logs, or
// invents runtime truth; what the frames do not say, the UI does not show.
import type {
  DesktopRuntimeController,
  DesktopRuntimeSnapshot,
  SessionProjection,
} from "@t4-code/client";
import {
  hostId as brandHostId,
  PROTOCOL_VERSION,
  revision as brandRevision,
  sessionId as brandSessionId,
  type CatalogItem,
  type ConfirmationChallenge,
  type Revision,
  type SessionRef,
  type SessionSnapshotFrame,
} from "@t4-code/protocol";
import type { RendererServerFrame } from "@t4-code/protocol/desktop-ipc";

import {
  initialProjection,
  reduceTranscript,
  type ApprovalRequest,
  type TranscriptFrame,
  type TranscriptProjection,
} from "../transcript/projection.ts";
import { slashCommandsFromCatalog } from "../composer/slash.ts";
import type {
  PromptOutcome,
  SessionLink,
  SessionRuntime,
  SessionRuntimeSnapshot,
} from "./controller.ts";
import type { SessionIntent } from "./intents.ts";
import {
  commandSupport,
  deriveComposerControls,
  FAST_SET_COMMAND,
  MODEL_SET_COMMAND,
  THINKING_SET_COMMAND,
  type PendingControl,
} from "./session-controls.ts";

export interface LiveRuntimeOptions {
  readonly controller: DesktopRuntimeController;
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

const REJECTED_REASON = "The host turned this message away. It stays here so you can try again.";
const UNKNOWN_REASON =
  "The connection dropped before the host answered. Check the transcript before sending again.";

/** Bounded failure copy per control; the label itself never lies. */
const CONTROL_REJECTED: Record<PendingControl, string> = {
  model: "The host declined the model change. The session keeps its current model.",
  thinking: "The host declined the thinking change. The session keeps its current level.",
  fast: "The host declined the fast-mode change.",
};
const CONTROL_UNKNOWN =
  "The connection dropped before the host answered. The control shows the host's last confirmed value.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Frame types the transcript reducer accepts; mirrors the subscription. */
const TRANSCRIPT_FRAME_TYPES: ReadonlySet<string> = new Set([
  "snapshot",
  "entry",
  "event",
  "gap",
]);

function isTranscriptFrame(frame: RendererServerFrame): frame is TranscriptFrame {
  return TRANSCRIPT_FRAME_TYPES.has(frame.type);
}

/** Follow-ups the host reports as queued, read strictly from the ref. */
function getQueuedFollowUps(ref: SessionRef | undefined): readonly string[] {
  if (!isRecord(ref?.liveState)) return [];
  const queuedMessages = ref.liveState.queuedMessages;
  if (!isRecord(queuedMessages)) return [];
  const followUp = queuedMessages.followUp;
  if (!Array.isArray(followUp)) return [];
  const result: string[] = [];
  for (const item of followUp) {
    if (typeof item === "string") result.push(item);
  }
  return result;
}

/** Commands the runtime recognizes as this session's abort affordance. */
function findCancelCommand(items: readonly CatalogItem[]): CatalogItem | undefined {
  return items.find(
    (item) =>
      item.kind === "command" &&
      (String(item.id) === "session.cancel" || item.name === "session.cancel" || item.name === "cancel"),
  );
}

interface PendingChallenge {
  readonly challenge: ConfirmationChallenge;
  readonly approval: ApprovalRequest;
}

export function createLiveSessionRuntime(options: LiveRuntimeOptions): SessionRuntime {
  const { controller, targetId } = options;
  const projectionKey = `${options.hostId}\u0000${options.sessionId}`;
  const wireHostId = brandHostId(options.hostId);
  const wireSessionId = brandSessionId(options.sessionId);

  let transcript = initialProjection();
  let snapshot: SessionRuntimeSnapshot | null = null;
  let disposed = false;
  // Composer control command state: which control awaits the host, and the
  // last failure. Values themselves always come from server state — the
  // label never swaps optimistically.
  let pendingControl: PendingControl | null = null;
  let controlError: string | null = null;
  // Control commands change the session revision. Keep later revisioned
  // prompt commands behind the full control round-trip so a fast tap on
  // Send cannot race the model/thinking/fast delta and be rejected stale.
  let controlBarrier: Promise<void> | null = null;
  /** Challenges the user decided and the shell acknowledged; hidden locally. */
  const decidedChallenges = new Set<string>();
  const listeners = new Set<() => void>();

  const warmSession = (runtime: DesktopRuntimeSnapshot): SessionProjection | undefined =>
    runtime.projection.sessions.get(projectionKey);

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  // Seed from the controller's warm projection: settled entries install as a
  // synthetic snapshot at the session cursor, so later live frames apply
  // contiguously. In-flight stream state before attach is not reconstructed
  // — the next real frame or snapshot brings it.
  const warm = warmSession(controller.getSnapshot());
  if (warm !== undefined && warm.cursor !== undefined) {
    const seed: SessionSnapshotFrame = {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      cursor: warm.cursor,
      revision: brandRevision(warm.revision ?? "rev-unknown"),
      hostId: wireHostId,
      sessionId: wireSessionId,
      entries: [...warm.entries],
    };
    transcript = reduceTranscript(transcript, seed);
  }

  const expectedRevision = (): Revision | undefined => {
    const runtime = controller.getSnapshot();
    const warmRevision = warmSession(runtime)?.revision;
    if (warmRevision !== undefined) return brandRevision(warmRevision);
    const ref = runtime.projection.sessionIndex.get(projectionKey);
    return ref?.revision;
  };

  const sendCommand = async (
    command: string,
    args: Record<string, unknown>,
    withRevision: boolean,
    usePromptLease = true,
    revisionOverride?: Revision,
    promptLeaseRevision?: Revision,
  ): Promise<PromptOutcome> => {
    const revisionValue = withRevision ? (revisionOverride ?? expectedRevision()) : undefined;
    if (withRevision && revisionValue === undefined) return { kind: "unknown", reason: UNKNOWN_REASON };
    try {
      const intentPayload = {
        hostId: wireHostId,
        sessionId: wireSessionId,
        command,
        args,
        ...(revisionValue === undefined ? {} : { expectedRevision: revisionValue }),
      };
      const result = usePromptLease
        ? await controller.commandWithPromptLease(
            targetId,
            intentPayload,
            promptLeaseRevision === undefined ? undefined : String(promptLeaseRevision),
          )
        : await controller.commandWithControllerLease(targetId, intentPayload);
      return result.accepted ? { kind: "accepted" } : { kind: "rejected", reason: REJECTED_REASON };
    } catch {
      return { kind: "unknown", reason: UNKNOWN_REASON };
    }
  };

  /**
   * Some valid hosts enqueue a revision-changing control response before the
   * matching host-wide session.delta reaches this client (notably when another
   * attached client is ahead of it in the broadcast loop). An authoritative
   * session.list round-trip closes that ordering window without guessing a
   * revision or weakening stale-write protection.
   */
  const reconcileAcceptedControl = async (sentRevision: Revision): Promise<boolean> => {
    if (String(expectedRevision()) !== String(sentRevision)) return true;
    try {
      const refreshed = await controller.command(targetId, {
        hostId: wireHostId,
        command: "session.list",
        args: {},
      });
      return refreshed.accepted && expectedRevision() !== undefined;
    } catch {
      return false;
    }
  };

  // session.cancel is deliberately revision-optional: the controller lease is
  // acquired against current session truth, while the challenged command must
  // remain executable if lifecycle events advance the projection before the
  // user approves it. Keeping the lease revision off the command prevents a
  // valid Stop confirmation from replaying as stale.
  const sendCancelCommand = async (): Promise<PromptOutcome> => {
    const leaseRevision = expectedRevision();
    if (leaseRevision === undefined) return { kind: "unknown", reason: UNKNOWN_REASON };
    try {
      const result = await controller.commandWithControllerLease(
        targetId,
        {
          hostId: wireHostId,
          sessionId: wireSessionId,
          command: "session.cancel",
          args: {},
        },
        String(leaseRevision),
      );
      return result.accepted ? { kind: "accepted" } : { kind: "rejected", reason: REJECTED_REASON };
    } catch {
      return { kind: "unknown", reason: UNKNOWN_REASON };
    }
  };

  const grantedFor = (runtime: DesktopRuntimeSnapshot): readonly string[] => {
    const host = runtime.hosts.get(options.hostId);
    return host === undefined ? [] : [...host.grantedCapabilities, ...host.grantedFeatures];
  };

  /**
   * One control command round-trip: honest refusal when the catalog does
   * not offer it, a pending mark while in flight, and a bounded error on
   * anything but acceptance. Reconciliation is the server's session state
   * arriving as frames — never a local echo.
   */
  const runControlCommand = async (
    control: PendingControl,
    command: string,
    args: Record<string, unknown>,
  ): Promise<PromptOutcome> => {
    const runtime = controller.getSnapshot();
    const support = commandSupport(runtime.catalogs.get(options.hostId), grantedFor(runtime), command);
    if (!support.supported) {
      const reason = support.reason ?? "Not available on this host";
      controlError = reason;
      notify();
      return { kind: "rejected", reason };
    }
    pendingControl = control;
    controlError = null;
    notify();
    const sentRevision = expectedRevision();
    let outcome =
      sentRevision === undefined
        ? ({ kind: "unknown", reason: UNKNOWN_REASON } as const)
        : await sendCommand(command, args, true, false, sentRevision);
    if (
      outcome.kind === "accepted" &&
      sentRevision !== undefined &&
      !(await reconcileAcceptedControl(sentRevision))
    ) {
      outcome = { kind: "unknown", reason: CONTROL_UNKNOWN };
    }
    pendingControl = null;
    if (outcome.kind === "rejected") controlError = CONTROL_REJECTED[control];
    else if (outcome.kind === "unknown") controlError = CONTROL_UNKNOWN;
    notify();
    return outcome;
  };

  const applyControlCommand = (
    control: PendingControl,
    command: string,
    args: Record<string, unknown>,
  ): Promise<PromptOutcome> => {
    const previous = controlBarrier;
    const task =
      previous === null
        ? runControlCommand(control, command, args)
        : previous.then(() => runControlCommand(control, command, args));
    const barrier = task.then(
      () => undefined,
      () => undefined,
    );
    controlBarrier = barrier;
    void barrier.then(() => {
      if (controlBarrier === barrier) controlBarrier = null;
    });
    return task;
  };

  const waitForControlCommands = async (): Promise<void> => {
    while (controlBarrier !== null) {
      const barrier = controlBarrier;
      await barrier;
      if (controlBarrier === barrier) return;
    }
  };

  const sendAfterControlCommands = async (
    command: string,
    args: Record<string, unknown>,
  ): Promise<PromptOutcome> => {
    await waitForControlCommands();
    return sendCommand(command, args, true);
  };

  // Active turns advance the session revision while output streams. Steer and
  // follow-up are revision-optional on the wire, so bind any negotiated prompt
  // lease to current session truth without putting that volatile revision on
  // the command itself.
  const sendActiveTurnMessage = async (
    command: "session.steer" | "session.followUp",
    args: Record<string, unknown>,
  ): Promise<PromptOutcome> => {
    await waitForControlCommands();
    const leaseRevision = expectedRevision();
    if (leaseRevision === undefined) return { kind: "unknown", reason: UNKNOWN_REASON };
    return sendCommand(command, args, false, true, undefined, leaseRevision);
  };

  const applyFrame = (frame: TranscriptFrame) => {
    const next = reduceTranscript(transcript, frame);
    if (next !== transcript) {
      transcript = next;
      notify();
    }
  };

  let attached = false;
  let attaching = false;
  let retryAfterAttach = false;
  let connectionGeneration = 0;
  let previousConnected = controller.getSnapshot().connections.get(targetId) === "connected";
  const attachIfConnected = (runtime: DesktopRuntimeSnapshot) => {
    if (disposed) return;
    const connected = runtime.connections.get(targetId) === "connected";
    if (connected !== previousConnected) {
      previousConnected = connected;
      connectionGeneration += 1;
      if (!connected) attached = false;
    }
    if (!connected) return;
    if (attached) return;
    if (attaching) {
      retryAfterAttach = true;
      return;
    }
    attaching = true;
    retryAfterAttach = false;
    const generation = connectionGeneration;
    attached = true;
    void controller
      .attachSession(targetId, options.hostId, options.sessionId)
      .then((result) => {
        if (result.accepted !== true || generation !== connectionGeneration) attached = false;
      })
      .catch(() => {
        attached = false;
      })
      .finally(() => {
        attaching = false;
        if (disposed) return;
        if (retryAfterAttach && generation !== connectionGeneration) {
          retryAfterAttach = false;
          attachIfConnected(controller.getSnapshot());
        } else {
          retryAfterAttach = false;
        }
      });
  };
  attachIfConnected(controller.getSnapshot());

  const unsubscribeFrames = controller.subscribeFrames(
    {
      targetId,
      hostId: options.hostId,
      sessionId: options.sessionId,
      // session.delta belongs to the host-wide session-index cursor domain,
      // not this session's transcript cursor domain. The shared desktop
      // projection already consumes it for ref/revision/control truth.
      types: ["snapshot", "entry", "event", "gap"],
    },
    (event) => {
      if (isTranscriptFrame(event.frame)) applyFrame(event.frame);
    },
  );
  // Connection state, catalog, confirmation, and freshness changes all
  // surface through the controller snapshot; re-derive on every change.
  const unsubscribeRuntime = controller.subscribe((runtime) => {
    attachIfConnected(runtime);
    notify();
  });

  const pendingChallenge = (runtime: DesktopRuntimeSnapshot): PendingChallenge | null => {
    const confirmations = warmSession(runtime)?.confirmations;
    if (confirmations === undefined) return null;
    const results = warmSession(runtime)?.results;
    for (const challenge of confirmations.values()) {
      const confirmationId = String(challenge.confirmationId);
      if (decidedChallenges.has(confirmationId)) continue;
      const expiresAtMs = Date.parse(challenge.expiresAt);
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= Date.now()) continue;
      let resolved = false;
      if (results !== undefined) {
        for (const result of results.values()) {
          if (result.commandId !== undefined && result.commandId === String(challenge.commandId)) {
            resolved = true;
            break;
          }
        }
      }
      if (resolved) continue;
      return {
        challenge,
        approval: {
          approvalId: confirmationId,
          title: "Approval needed",
          message: challenge.summary,
          command: challenge.summary,
          args: challenge.preview === undefined ? {} : { preview: challenge.preview },
          requestedAt: challenge.expiresAt,
          expiresAt: challenge.expiresAt,
        },
      };
    }
    return null;
  };

  const confirmChallenge = async (approvalId: string, decision: "approve" | "deny") => {
    const runtime = controller.getSnapshot();
    const challenge = warmSession(runtime)?.confirmations.get(approvalId);
    if (challenge === undefined) return;
    try {
      const result = await controller.confirm({
        targetId,
        confirmationId: challenge.confirmationId,
        commandId: challenge.commandId,
        hostId: challenge.hostId,
        ...(challenge.sessionId === undefined ? {} : { sessionId: challenge.sessionId }),
        decision,
      });
      // The decision reached the host; the card retires. On a thrown or
      // unaccepted round-trip the challenge stays visible — never an
      // optimistic disappearance.
      if (result.accepted) {
        decidedChallenges.add(approvalId);
        notify();
      }
    } catch {
      // Outcome unknown: keep the challenge on screen.
    }
  };

  const submitPrompt = async (intent: SessionIntent): Promise<PromptOutcome> => {
    if (intent.kind === "prompt") {
      return sendAfterControlCommands("session.prompt", { message: intent.text });
    }
    if (intent.kind === "steer") {
      return sendActiveTurnMessage("session.steer", { message: intent.text });
    }
    if (intent.kind === "followUp") {
      return sendActiveTurnMessage("session.followUp", { message: intent.text });
    }
    if (intent.kind === "setModel") {
      // Session-scoped switch: the host resolves a role or a concrete
      // selector; the renderer never writes settings from the composer.
      // The wire takes role XOR selector — a cycle-role pick sends the
      // role and lets the host resolve it, never the cached selector.
      const args: Record<string, unknown> = { persistence: "session" };
      if (intent.role !== null) args.role = intent.role;
      else if (intent.selector !== null) args.selector = intent.selector;
      return applyControlCommand("model", MODEL_SET_COMMAND, args);
    }
    if (intent.kind === "setThinking") {
      return applyControlCommand("thinking", THINKING_SET_COMMAND, { level: intent.level });
    }
    if (intent.kind === "setFast") {
      return applyControlCommand("fast", FAST_SET_COMMAND, { enabled: intent.enabled });
    }
    if (intent.kind === "setMode") {
      // No live protocol exists for working modes; the control is hidden,
      // and a stray intent gets the honest refusal instead of a fake echo.
      return { kind: "rejected", reason: "This host has no working-mode command yet." };
    }
    if (intent.kind === "ask") {
      const value = intent.text !== "" ? intent.text : intent.optionIds.join(", ");
      return sendCommand(
        "session.ui.respond",
        {
          requestId: intent.askId,
          value,
        },
        true,
      );
    }
    if (intent.kind === "plan") {
      if (intent.action === "approve") {
        return sendCommand(
          "session.ui.respond",
          {
            requestId: intent.planId,
            confirmed: true,
          },
          true,
        );
      } else if (intent.action === "reject") {
        return sendCommand(
          "session.ui.respond",
          {
            requestId: intent.planId,
            confirmed: false,
          },
          true,
        );
      } else {
        return sendCommand(
          "session.ui.respond",
          {
            requestId: intent.planId,
            value: intent.note,
          },
          true,
        );
      }
    }
    if (intent.kind === "cancel") {
      const runtime = controller.getSnapshot();
      const catalog = runtime.catalogs.get(options.hostId);
      if (catalog === undefined || findCancelCommand(catalog.items) === undefined) {
        return { kind: "rejected", reason: "This host does not offer a stop command." };
      }
      return sendCancelCommand();
    }
    // approval
    const runtime = controller.getSnapshot();
    const hasChallenge = warmSession(runtime)?.confirmations.has(intent.approvalId) ?? false;
    if (hasChallenge) {
      await confirmChallenge(intent.approvalId, intent.decision === "approve" ? "approve" : "deny");
      return { kind: "accepted" };
    } else {
      return sendCommand(
        "session.ui.respond",
        {
          requestId: intent.approvalId,
          confirmed: intent.decision === "approve",
        },
        true,
      );
    }
  };

  return {
    getSnapshot(): SessionRuntimeSnapshot {
      if (snapshot === null) {
        const runtime = controller.getSnapshot();
        const warmNow = warmSession(runtime);
        const connection = runtime.connections.get(targetId);
        const link: SessionLink =
          connection !== "connected"
            ? "offline"
            : warmNow !== undefined && warmNow.freshness !== "fresh"
              ? "cached"
              : "live";
        const granted = grantedFor(runtime);
        const canPrompt = link === "live" && granted.includes("sessions.prompt");
        const catalog = runtime.catalogs.get(options.hostId);
        const cancelItem = catalog === undefined ? undefined : findCancelCommand(catalog.items);
        const cancelSupported = cancelItem !== undefined && cancelItem.supported !== false;
        const canCancel = link === "live" && transcript.turnActive && cancelSupported;
        const cancelDisabledReason = cancelSupported
          ? null
          : catalog === undefined
            ? "Waiting for this host's command list"
            : (cancelItem?.reason ?? "This host does not offer a stop command");
        const challenge = pendingChallenge(runtime);
        const projection: TranscriptProjection =
          transcript.approval === null && challenge !== null
            ? { ...transcript, approval: challenge.approval }
            : transcript;
        const contextUsage = runtime.projection.sessionIndex.get(projectionKey)?.contextUsage;

        // Session control truth: warm ref first, session index second.
        const ref = warmNow?.ref ?? runtime.projection.sessionIndex.get(projectionKey);
        const queuedFollowUps = getQueuedFollowUps(ref);

        snapshot = {
          projection,
          link,
          canPrompt,
          canCancel,
          cancelDisabledReason,
          slashCommands:
            catalog === undefined
              ? []
              : slashCommandsFromCatalog(
                  catalog.items,
                  { link, turnActive: transcript.turnActive },
                  granted,
                ),
          contextUsedTokens: contextUsage?.used ?? 0,
          contextWindowTokens: contextUsage?.limit ?? 0,
          queuedFollowUps,
          controls: deriveComposerControls({
            catalog,
            settings: runtime.settings.get(options.hostId),
            ref,
            granted,
            pendingControl,
            controlError,
          }),
          nowMs: Date.now(),
        };
      }
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      void submitPrompt(intent);
    },
    submitPrompt,
    pause() {
      // Live frames keep applying in the background so switch-back is warm.
    },
    resume() {
      if (disposed) return;
      // Re-activate this session in the shared projection LRU.
      controller.activateSession(options.hostId, options.sessionId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeFrames();
      unsubscribeRuntime();
      listeners.clear();
    },
  };
}
