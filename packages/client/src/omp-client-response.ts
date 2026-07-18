import type { Pending } from "./omp-client-contracts.ts";
import type { PendingRequests } from "./omp-client-pending.ts";
import type { OmpResponse } from "./omp-protocol-provider.ts";

/**
 * A confirmation decision is consumed even when the user denies the command or
 * the approved command itself fails. Only confirmation_invalid means the host
 * did not consume this decision.
 */
export function isConfirmationDecisionConsumed(frame: OmpResponse): boolean {
  return frame.error?.code !== "confirmation_invalid";
}

function matchingConfirmRequests(
  entries: ReadonlyMap<string, Pending>,
  frame: OmpResponse,
): string[] {
  const matches: string[] = [];
  for (const [requestKey, pending] of entries) {
    if (pending.kind !== "confirm" || pending.message.kind !== "confirm") continue;
    if (String(pending.message.commandId) !== String(frame.commandId)) continue;
    if (pending.message.hostId !== frame.hostId) continue;
    if (pending.message.sessionId !== frame.sessionId) continue;
    matches.push(requestKey);
  }
  return matches;
}

export function handleResponseFrame(
  pendingRequests: PendingRequests,
  frame: OmpResponse,
  callbacks: {
    readonly protocolFailure: (message: string) => void;
    readonly publish: (frame: OmpResponse) => void;
    readonly attached: (hostId: string, sessionId: string, frame: OmpResponse) => void;
  },
): void {
  const requestKey = String(frame.requestId);
  const pending = pendingRequests.entries.get(requestKey);
  if (pending === undefined) {
    // OMP answers a valid confirmation with the original challenged command's
    // requestId. Correlate a live confirm alias even if that command timed out.
    if (isConfirmationDecisionConsumed(frame)) {
      for (const alias of matchingConfirmRequests(pendingRequests.entries, frame)) {
        pendingRequests.settle(alias, frame);
      }
    }
    callbacks.publish(frame);
    return;
  }
  if (pending.message.kind === "pair-start" || frame.hostId !== pending.message.hostId) {
    callbacks.protocolFailure("response host correlation mismatch");
    return;
  }
  const expectedSession = pending.message.sessionId;
  if (frame.sessionId !== expectedSession) {
    callbacks.protocolFailure("response session correlation mismatch");
    return;
  }
  if (
    pending.intent !== undefined &&
    frame.command !== undefined &&
    frame.command !== pending.intent.command
  ) {
    callbacks.protocolFailure("response command name correlation mismatch");
    return;
  }
  if (pending.commandId !== undefined && String(frame.commandId) !== pending.commandId) {
    callbacks.protocolFailure("response command correlation mismatch");
    return;
  }
  pendingRequests.settle(requestKey, frame);
  // A valid decision completes both the held command and confirm promises.
  // confirmation_invalid only settles its own confirm request.
  if (pending.kind !== "confirm" && isConfirmationDecisionConsumed(frame)) {
    for (const alias of matchingConfirmRequests(pendingRequests.entries, frame)) {
      pendingRequests.settle(alias, frame);
    }
  }
  if (pending.kind === "attach" && frame.ok && pending.intent?.sessionId !== undefined) {
    callbacks.attached(pending.intent.hostId, pending.intent.sessionId, frame);
  }
  callbacks.publish(frame);
}
