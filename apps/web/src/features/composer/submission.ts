// Prompt submission gate: the piece between the composer's Send affordance
// and `SessionRuntime.submitPrompt`. It owns the three safety behaviors the
// UI must never get wrong:
//   - the draft clears only after the runtime reports "accepted";
//   - a rejected or unknown outcome keeps the exact draft, attachments, and
//     caret, and surfaces a retry-safe notice — never an automatic replay;
//   - while one submission is in flight, further submits are no-ops.
// Pure decision logic lives in `settleSubmission`; the gate adds the
// in-flight latch and applies the settlement through a tiny IO seam so the
// component stays declarative and tests can drive the real runtime headless.
import type { PromptOutcome } from "../session-runtime/controller.ts";
import type { SessionIntent } from "../session-runtime/intents.ts";

/** What one submission carried, remembered so settlement can compare. */
export interface SubmittedPrompt {
  /** The draft text exactly as it stood at submit time (untrimmed). */
  readonly text: string;
  /** Attachment ids sent with the prompt; removed only on acceptance. */
  readonly attachmentIds: readonly string[];
}

/** Inline status under the composer; null when the last send settled clean. */
export type SubmissionNotice = {
  readonly kind: "rejected" | "unknown";
  readonly message: string;
} | null;

export interface SubmissionSettlement {
  readonly clearDraft: boolean;
  readonly removeAttachmentIds: readonly string[];
  readonly notice: SubmissionNotice;
}

/**
 * Decide what an outcome does to the composer. On acceptance the draft
 * clears only when it still reads exactly what was submitted — anything the
 * user typed during the round-trip survives. Rejected and unknown outcomes
 * touch nothing: same draft, same attachments, one honest notice.
 */
export function settleSubmission(
  outcome: PromptOutcome,
  submitted: SubmittedPrompt,
  currentDraft: string,
): SubmissionSettlement {
  if (outcome.kind === "accepted") {
    return {
      clearDraft: currentDraft === submitted.text,
      removeAttachmentIds: submitted.attachmentIds,
      notice: null,
    };
  }
  return {
    clearDraft: false,
    removeAttachmentIds: [],
    notice: { kind: outcome.kind, message: outcome.reason },
  };
}

/** How a settlement lands in the composer's stores. */
export interface SubmissionIo {
  readonly getDraft: () => string;
  readonly clearDraft: () => void;
  readonly removeAttachments: (ids: readonly string[]) => void;
  readonly setNotice: (notice: SubmissionNotice) => void;
}

export interface SubmissionGate {
  /** True while a submission is awaiting its outcome. */
  readonly pending: () => boolean;
  /**
   * Submit once. Returns the runtime's outcome, or null when another
   * submission is already in flight (the duplicate is dropped, not queued).
   */
  readonly submit: (
    intent: SessionIntent,
    submitted: SubmittedPrompt,
    io: SubmissionIo,
  ) => Promise<PromptOutcome | null>;
}

/**
 * Session-durable in-flight ownership. The composer supplies a store-backed
 * latch so A to B to A navigation cannot manufacture a second unlocked gate
 * while the first submission is still awaiting the host.
 */
export interface SubmissionLatch {
  readonly pending: () => boolean;
  readonly begin: () => SubmissionToken | null;
  readonly current: (token: SubmissionToken) => boolean;
  readonly end: (token: SubmissionToken) => void;
}

export type SubmissionToken = string;

function createLocalSubmissionLatch(): SubmissionLatch {
  let generation = 0;
  let active: SubmissionToken | null = null;
  return {
    pending: () => active !== null,
    begin: () => {
      if (active !== null) return null;
      generation += 1;
      active = `local-${generation}`;
      return active;
    },
    current: (token) => active === token,
    end: (token) => {
      if (active === token) active = null;
    },
  };
}

export function createSubmissionGate(
  submitPrompt: (intent: SessionIntent) => Promise<PromptOutcome>,
  latch: SubmissionLatch = createLocalSubmissionLatch(),
): SubmissionGate {
  return {
    pending: latch.pending,
    async submit(intent, submitted, io) {
      const token = latch.begin();
      if (token === null) return null;
      io.setNotice(null);
      let outcome: PromptOutcome;
      try {
        outcome = await submitPrompt(intent);
      } catch {
        // The runtime contract resolves with an outcome; a throw is the
        // transport vanishing mid-flight, which is the same truth as
        // "unknown": nothing may be cleared and nothing replays.
        outcome = {
          kind: "unknown",
          reason: "The connection dropped before the host answered. Check the transcript before sending again.",
        };
      }
      try {
        // Confirmed deletion invalidates this owner. Its late outcome must not
        // recreate UI state, clear a newer draft, or run accepted callbacks.
        if (!latch.current(token)) return null;
        const settlement = settleSubmission(outcome, submitted, io.getDraft());
        if (settlement.clearDraft) io.clearDraft();
        if (settlement.removeAttachmentIds.length > 0) {
          io.removeAttachments(settlement.removeAttachmentIds);
        }
        io.setNotice(settlement.notice);
        return outcome;
      } finally {
        latch.end(token);
      }
    },
  };
}
