import type { DesktopRuntimeSnapshot } from "@t4-code/client";
import type { SessionEvent, SessionRef } from "@t4-code/protocol";

import type { TranscriptServerEvent } from "../transcript/projection.ts";
import { pendingPromptsFromRef } from "./pending-prompts.ts";
import { sessionIsWorking } from "./session-working.ts";
import { sessionRefIsCurrent } from "./session-inventory.ts";

const TRANSCRIPT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "snapshot",
  "entry",
  "event",
  "gap",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTranscriptEvent(
  event: { readonly kind: string },
): event is TranscriptServerEvent {
  return TRANSCRIPT_EVENT_KINDS.has(event.kind);
}

export function getQueuedFollowUps(ref: SessionRef | undefined): readonly string[] {
  if (!isRecord(ref?.liveState)) return [];
  const queuedMessages = ref.liveState.queuedMessages;
  if (!isRecord(queuedMessages)) return [];
  const followUp = queuedMessages.followUp;
  if (!Array.isArray(followUp)) return [];
  return followUp.filter((item): item is string => typeof item === "string");
}

export function retiredPendingPromptId(event: SessionEvent): string | null {
  if (event.type !== "message.settled" && event.type !== "message.discarded") return null;
  const candidate =
    typeof event.transientEntryId === "string"
      ? event.transientEntryId
      : event.type === "message.discarded" && typeof event.entryId === "string"
        ? event.entryId
        : null;
  return candidate !== null && candidate.length > 0 && candidate.length <= 512
    ? candidate
    : null;
}

export function activePendingPromptId(event: SessionEvent): string | null {
  if (
    (event.type !== "message.update" && event.type !== "message.delta") ||
    event.role !== "user" ||
    typeof event.entryId !== "string"
  ) {
    return null;
  }
  return event.entryId.length > 0 && event.entryId.length <= 512 ? event.entryId : null;
}

export function sessionIsWorkingWithPendingPrompts(
  ref: SessionRef | undefined,
  pendingPrompts: ReturnType<typeof pendingPromptsFromRef>,
): boolean {
  if (ref === undefined) return false;
  const liveState = isRecord(ref.liveState) ? ref.liveState : {};
  return sessionIsWorking({
    ...ref,
    liveState: { ...liveState, pendingPrompts },
  } as SessionRef);
}

export function sessionRefIsCompacting(ref: SessionRef | undefined): boolean {
  if (!isRecord(ref?.liveState)) return false;
  return ref.liveState.isCompacting === true || ref.liveState.phase === "compacting";
}

export function authoritativeWorkingState(
  runtime: DesktopRuntimeSnapshot,
  targetId: string,
  hostId: string,
  sessionId: string,
  projectionKey: string,
  retiredPendingPromptIds: ReadonlySet<string>,
): boolean | null {
  if (runtime.connections.get(targetId) !== "connected") return null;
  if (runtime.targetHosts.get(targetId) !== hostId) return null;
  if (!sessionRefIsCurrent(runtime, hostId, sessionId)) return null;
  const ref = runtime.projection.sessionIndex.get(projectionKey);
  if (ref === undefined) return null;
  const pendingPrompts = pendingPromptsFromRef(ref).filter(
    (prompt) => !retiredPendingPromptIds.has(prompt.entryId),
  );
  return sessionIsWorkingWithPendingPrompts(ref, pendingPrompts);
}
