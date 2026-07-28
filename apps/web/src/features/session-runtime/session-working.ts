import type { SessionRef } from "@t4-code/protocol";

import { pendingPromptsFromRef } from "./pending-prompts.ts";

/** Pure authority projection used by both workspace and session-management code. */
export function sessionIsWorking(ref: SessionRef | undefined): boolean {
  if (ref === undefined) return false;
  if (pendingPromptsFromRef(ref).length > 0) return true;
  const rawRef = ref as unknown as Record<string, unknown>;
  if (
    ref.status === "active" ||
    ref.pendingApproval === true ||
    ref.pendingUserInput === true ||
    rawRef.working === true ||
    rawRef.isWorking === true ||
    rawRef.turnActive === true ||
    rawRef.inFlight === true ||
    (typeof rawRef.queuedMessageCount === "number" && rawRef.queuedMessageCount > 0) ||
    (Array.isArray(rawRef.queuedMessages) && rawRef.queuedMessages.length > 0)
  ) {
    return true;
  }
  const liveState = ref.liveState;
  if (liveState === undefined || liveState === null || typeof liveState !== "object") return false;
  const live = liveState as Record<string, unknown>;
  const phase = live.phase;
  return (
    phase === "working" ||
    phase === "running" ||
    phase === "active" ||
    phase === "streaming" ||
    phase === "compacting" ||
    phase === "queued" ||
    phase === "waiting" ||
    phase === "awaiting-input" ||
    phase === "awaiting_input" ||
    live.working === true ||
    live.isWorking === true ||
    live.isRunning === true ||
    live.turnActive === true ||
    live.inFlight === true ||
    live.isStreaming === true ||
    live.isCompacting === true ||
    live.pendingApproval === true ||
    live.pendingUserInput === true ||
    (typeof live.queuedMessageCount === "number" && live.queuedMessageCount > 0) ||
    (typeof live.queue === "number" && live.queue > 0) ||
    (Array.isArray(live.queuedMessages) && live.queuedMessages.length > 0) ||
    (Array.isArray(live.queue) && live.queue.length > 0)
  );
}
