// One compatibility table for session-scoped live events. App-wire keeps
// SessionEvent intentionally open so newer runtimes can add leaf event types
// without a protocol bump; the web client therefore distinguishes events it
// can project from events it only exposes in the raw activity inspector.

export type SessionEventActivityKind = "tool" | "agent" | "job" | "system" | "error" | "shell";

export type SessionEventProjectionKind =
  | "turn-start"
  | "turn-end"
  | "agent-end"
  | "message-delta"
  | "message-update"
  | "message-settled"
  | "message-discarded"
  | "tool-start"
  | "tool-progress"
  | "tool-result"
  | "tool-error"
  | "approval-request"
  | "approval-resolved"
  | "ask-request"
  | "ask-resolved"
  | "plan-ready"
  | "plan-resolved"
  | "turn-error"
  | "turn-retry"
  | "compaction"
  | "compaction-start"
  | "compaction-end"
  | "inspect-only";

export interface SessionEventSpec {
  readonly activityKind: SessionEventActivityKind;
  readonly projection: SessionEventProjectionKind;
}

/**
 * Canonical appserver events plus the legacy inspector spellings T4 already
 * shipped. Aliases share a projection kind so the transcript and Activity
 * pane cannot silently drift into two different definitions of "known".
 */
export const SESSION_EVENT_VOCABULARY = {
  "turn.start": { activityKind: "system", projection: "turn-start" },
  "turn.end": { activityKind: "system", projection: "turn-end" },
  "message.delta": { activityKind: "system", projection: "message-delta" },
  "message.update": { activityKind: "system", projection: "message-update" },
  "message.settled": { activityKind: "system", projection: "message-settled" },
  "message.discarded": { activityKind: "system", projection: "message-discarded" },
  "tool.start": { activityKind: "tool", projection: "tool-start" },
  "tool.progress": { activityKind: "tool", projection: "tool-progress" },
  "tool.result": { activityKind: "tool", projection: "tool-result" },
  "approval.request": { activityKind: "system", projection: "approval-request" },
  "approval.resolved": { activityKind: "system", projection: "approval-resolved" },
  "ask.request": { activityKind: "system", projection: "ask-request" },
  "ask.resolved": { activityKind: "system", projection: "ask-resolved" },
  "plan.ready": { activityKind: "system", projection: "plan-ready" },
  "plan.resolved": { activityKind: "system", projection: "plan-resolved" },
  "turn.error": { activityKind: "error", projection: "turn-error" },
  "turn.retry": { activityKind: "system", projection: "turn-retry" },
  "turn.retry.result": { activityKind: "system", projection: "inspect-only" },
  compaction: { activityKind: "system", projection: "compaction" },
  "compaction.start": { activityKind: "system", projection: "compaction-start" },
  "compaction.end": { activityKind: "system", projection: "compaction-end" },

  // Complete canonical OMP appserver runtime vocabulary. Most lifecycle and
  // support events belong in Activity rather than as transcript rows, but
  // they are still recognized so an additive runtime leaf never looks like a
  // protocol failure.
  "agent.start": { activityKind: "agent", projection: "inspect-only" },
  "agent.end": { activityKind: "agent", projection: "agent-end" },
  "agent.event": { activityKind: "agent", projection: "inspect-only" },
  "model.fallback": { activityKind: "system", projection: "inspect-only" },
  "model.fallback.result": { activityKind: "system", projection: "inspect-only" },
  "ttsr.triggered": { activityKind: "system", projection: "inspect-only" },
  "todo.reminder": { activityKind: "system", projection: "inspect-only" },
  "todo.cleared": { activityKind: "system", projection: "inspect-only" },
  "irc.message": { activityKind: "agent", projection: "inspect-only" },
  notice: { activityKind: "system", projection: "inspect-only" },
  "thinking.level.changed": { activityKind: "system", projection: "inspect-only" },
  "goal.updated": { activityKind: "system", projection: "inspect-only" },
  session_archived: { activityKind: "system", projection: "inspect-only" },
  session_restored: { activityKind: "system", projection: "inspect-only" },
  session_deleted: { activityKind: "system", projection: "inspect-only" },

  // Compatibility spellings used by the original Activity fixtures.
  "tool.end": { activityKind: "tool", projection: "tool-result" },
  "tool.error": { activityKind: "error", projection: "tool-error" },
  "session.compaction": { activityKind: "system", projection: "compaction" },
  "session.retry": { activityKind: "system", projection: "turn-retry" },
  "session.error": { activityKind: "error", projection: "turn-error" },

  // Inspector-only event families. They still advance the transcript cursor;
  // their complete payload remains available in Activity's raw inspector.
  "agent.spawn": { activityKind: "agent", projection: "inspect-only" },
  "agent.lifecycle": { activityKind: "agent", projection: "inspect-only" },
  "agent.progress": { activityKind: "agent", projection: "inspect-only" },
  "agent.transcript": { activityKind: "agent", projection: "inspect-only" },
  "job.start": { activityKind: "job", projection: "inspect-only" },
  "job.end": { activityKind: "job", projection: "inspect-only" },
  "session.system": { activityKind: "system", projection: "inspect-only" },
  "shell.output": { activityKind: "shell", projection: "inspect-only" },
} as const satisfies Readonly<Record<string, SessionEventSpec>>;

export type KnownSessionEventType = keyof typeof SESSION_EVENT_VOCABULARY;

/** Events emitted by the current OMP appserver runtime (including the
 * appserver-generated settlement correlation and RPC UI attention leaves). */
export const OMP_APPSERVER_SESSION_EVENT_TYPES = [
  "agent.start",
  "agent.end",
  "turn.start",
  "turn.end",
  "message.update",
  "message.settled",
  "message.discarded",
  "tool.start",
  "tool.progress",
  "tool.result",
  "compaction.start",
  "compaction.end",
  "turn.retry",
  "turn.retry.result",
  "model.fallback",
  "model.fallback.result",
  "ttsr.triggered",
  "todo.reminder",
  "todo.cleared",
  "irc.message",
  "notice",
  "thinking.level.changed",
  "goal.updated",
  "session_archived",
  "session_restored",
  "session_deleted",
  "agent.event",
  "approval.request",
  "approval.resolved",
  "ask.request",
  "ask.resolved",
] as const satisfies readonly KnownSessionEventType[];

export const TRANSCRIPT_SESSION_EVENT_TYPES: readonly KnownSessionEventType[] = Object.freeze(
  (Object.keys(SESSION_EVENT_VOCABULARY) as KnownSessionEventType[]).filter(
    (type) => SESSION_EVENT_VOCABULARY[type].projection !== "inspect-only",
  ),
);

/** Own-property lookup also makes hostile names such as `__proto__` unknown. */
export function sessionEventSpec(type: string): SessionEventSpec | undefined {
  return Object.prototype.hasOwnProperty.call(SESSION_EVENT_VOCABULARY, type)
    ? SESSION_EVENT_VOCABULARY[type as KnownSessionEventType]
    : undefined;
}
