import type { DesktopRuntimeController, DesktopRuntimeSnapshot, SessionProjection } from "@t4-code/client";
import {
  revision as brandRevision,
  type HostId,
  type Revision,
  type SessionId,
} from "@t4-code/protocol";

import type { ApprovalRequest } from "../transcript/projection.ts";
import { promptRejectionReason } from "./command-errors.ts";
import type { PromptOutcome } from "./controller.ts";
import { runImagePromptUpload } from "./image-upload.ts";
import { IMAGE_PROMPTS_UNSUPPORTED_REASON, type SessionIntent } from "./intents.ts";
import {
  CONTROL_REJECTED,
  CONTROL_UNKNOWN,
  findCancelCommand,
  UNKNOWN_PROMPT_REASON as UNKNOWN_REASON,
} from "./live-controls.ts";
import {
  commandSupport,
  FAST_SET_COMMAND,
  MODE_SET_COMMAND,
  MODEL_SET_COMMAND,
  THINKING_SET_COMMAND,
  type PendingControl,
} from "./session-controls.ts";
import { WriteGateError } from "./session-observer.ts";

interface PendingChallenge {
  readonly challenge: SessionProjection["confirmations"] extends ReadonlyMap<string, infer Value>
    ? Value
    : never;
  readonly approval: ApprovalRequest;
}

type WriteGate = (
  phase?: "strict" | "queued-prompt",
) => { readonly kind: "rejected"; readonly reason: string } | null;

interface LivePromptDispatcherOptions {
  readonly controller: DesktopRuntimeController;
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly projectionKey: string;
  readonly wireHostId: HostId;
  readonly wireSessionId: SessionId;
  readonly warmSession: (runtime: DesktopRuntimeSnapshot) => SessionProjection | undefined;
  readonly writeGate: WriteGate;
  readonly notify: () => void;
}

export interface LivePromptDispatcher {
  readonly controlError: string | null;
  readonly pendingControl: PendingControl | null;
  grantedFor(runtime: DesktopRuntimeSnapshot): readonly string[];
  pendingChallenge(runtime: DesktopRuntimeSnapshot): PendingChallenge | null;
  submitPrompt(intent: SessionIntent): Promise<PromptOutcome>;
}

export function createLivePromptDispatcher(
  options: LivePromptDispatcherOptions,
): LivePromptDispatcher {
  const { controller, targetId, wireHostId, wireSessionId } = options;
  const { notify, projectionKey, warmSession, writeGate } = options;
  let pendingControl: PendingControl | null = null;
  let controlError: string | null = null;
  let controlBarrier: Promise<void> | null = null;
  const decidedChallenges = new Set<string>();

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
    gatePhase: "strict" | "queued-prompt" = "strict",
  ): Promise<PromptOutcome> => {
    const revisionValue = withRevision ? (revisionOverride ?? expectedRevision()) : undefined;
    if (withRevision && revisionValue === undefined)
      return { kind: "unknown", reason: UNKNOWN_REASON };
    // Lease acquisition inside the client is a wait; the gate re-runs
    // after it, immediately before the command dispatches.
    const guard = () => {
      const gated = writeGate(gatePhase);
      if (gated !== null) throw new WriteGateError(gated.reason);
    };
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
            guard,
          )
        : await controller.commandWithControllerLease(targetId, intentPayload, undefined, guard);
      return result.accepted
        ? { kind: "accepted" }
        : { kind: "rejected", reason: promptRejectionReason(result.error) };
    } catch (error) {
      if (error instanceof WriteGateError) return { kind: "rejected", reason: error.reason };
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
    const gated = writeGate();
    if (gated !== null) return gated;
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
        () => {
          // Re-read after the controller-lease acquisition wait.
          const raced = writeGate();
          if (raced !== null) throw new WriteGateError(raced.reason);
        },
      );
      return result.accepted
        ? { kind: "accepted" }
        : { kind: "rejected", reason: promptRejectionReason(result.error) };
    } catch (error) {
      if (error instanceof WriteGateError) return { kind: "rejected", reason: error.reason };
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
    // This runs behind the control barrier: the session may have been taken
    // over by another app while an earlier control round-trip was in flight.
    const gated = writeGate();
    if (gated !== null) {
      controlError = gated.reason;
      notify();
      return gated;
    }
    const runtime = controller.getSnapshot();
    const support = commandSupport(
      runtime.catalogs.get(options.hostId),
      grantedFor(runtime),
      command,
    );
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
    // The barrier wait can span a takeover; recheck before dispatch.
    const gated = writeGate("queued-prompt");
    if (gated !== null) return gated;
    const leaseRevision = expectedRevision();
    if (leaseRevision === undefined) return { kind: "unknown", reason: UNKNOWN_REASON };
    // Ordinary prompts are revision-optional on the wire for the same reason
    // as steer/follow-up: live output or a just-reconciled control can advance
    // the projection between composition and host receipt. The prompt lease
    // still binds against the captured authoritative revision; only the
    // volatile compare-and-swap field stays off the command itself.
    return sendCommand(command, args, false, true, undefined, leaseRevision, "queued-prompt");
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
    const gated = writeGate();
    if (gated !== null) return gated;
    const leaseRevision = expectedRevision();
    if (leaseRevision === undefined) return { kind: "unknown", reason: UNKNOWN_REASON };
    return sendCommand(command, args, false, true, undefined, leaseRevision);
  };

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

  const confirmChallenge = async (
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<PromptOutcome> => {
    // The approval dialog is a wait: ownership can change while it is open.
    // Recheck immediately before the decision leaves; a gated challenge
    // simply stays on screen with the surfaces explaining why.
    const gated = writeGate();
    if (gated !== null) return gated;
    const runtime = controller.getSnapshot();
    const challenge = warmSession(runtime)?.confirmations.get(approvalId);
    if (challenge === undefined) {
      return { kind: "rejected", reason: "This approval was already resolved on the host." };
    }
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
        return { kind: "accepted" };
      }
      return {
        kind: "rejected",
        reason: "The host did not accept this decision. The approval stays on screen.",
      };
    } catch {
      return {
        kind: "unknown",
        reason:
          "The connection dropped before the host answered. The approval stays on screen; decide again once you're back.",
      };
    }
  };

  const submitPrompt = async (intent: SessionIntent): Promise<PromptOutcome> => {
    // Every intent below writes. Gate on CURRENT freshness precedence —
    // cached/offline copy first, then strict ownership truth — never a
    // stale raw ref. While another app owns this session (or this app is
    // still reconciling the transcript), refuse locally with the same
    // reason the surfaces show; the host would refuse anyway.
    {
      const gated = writeGate();
      if (gated !== null) return gated;
    }
    if (intent.kind === "prompt") {
      if (intent.attachments.length > 0) {
        const granted = grantedFor(controller.getSnapshot());
        if (!granted.includes("sessions.prompt") || !granted.includes("prompt.images")) {
          return { kind: "rejected", reason: IMAGE_PROMPTS_UNSUPPORTED_REASON };
        }
        await waitForControlCommands();
        return runImagePromptUpload({
          targetId,
          attachments: intent.attachments,
          // Upload begin/chunk are session mutations; each dispatch rechecks
          // current freshness + ownership (discard cleanup stays allowed).
          writeGate: () => writeGate(),
          command: (command, args) =>
            controller.command(targetId, {
              hostId: wireHostId,
              sessionId: wireSessionId,
              command,
              args: { ...args },
            }),
          sendPrompt: (images) =>
            sendAfterControlCommands("session.prompt", {
              message: intent.text,
              images: images.map((image) => ({ ...image })),
            }),
          rejectionReason: promptRejectionReason,
        });
      }
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
      return applyControlCommand("mode", MODE_SET_COMMAND, { mode: intent.mode });
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
      return confirmChallenge(
        intent.approvalId,
        intent.decision === "approve" ? "approve" : "deny",
      );
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
    get controlError() {
      return controlError;
    },
    get pendingControl() {
      return pendingControl;
    },
    grantedFor,
    pendingChallenge,
    submitPrompt,
  };
}
