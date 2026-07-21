// Composer-local attachment staging, keyed by session. Draft *text*
// continuity lives in the shared workspace store (setSessionDraft); model /
// thinking / fast / mode selections are SESSION state owned by the runtime
// (live host or fixture) and are never persisted renderer-side. This store
// keeps only in-memory attachments awaiting the next prompt.
import { createStore, type StoreApi, useStore } from "zustand";

import type { AttachmentMaterializationReservation, StagedAttachment } from "./attachments.ts";
import type { SubmissionNotice, SubmissionToken } from "./submission.ts";
import {
  admitContextItem,
  type ContextItemAdmission,
  type ContextPacketItem,
} from "../context-packet/context-packet.ts";

/**
 * The retired v1 options-persistence key. Model/thinking/fast/mode moved to
 * session-state authority; any surviving blob is stale renderer truth and
 * gets removed on boot so it can never leak back into a control.
 */
export const LEGACY_COMPOSER_STORAGE_KEY = "omp:composer:v1";

export type AttachmentIntakeToken = string;

export function purgeLegacyComposerPersistence(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(LEGACY_COMPOSER_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing to purge.
  }
}

export interface ComposerStoreState {
  readonly attachmentsBySessionId: Record<string, readonly StagedAttachment[]>;
  readonly contextItemsBySessionId: Readonly<Record<string, readonly ContextPacketItem[]>>;
  readonly contextNoticeBySessionId: Readonly<Record<string, string>>;
  readonly pendingSubmissionBySessionId: Readonly<Record<string, SubmissionToken>>;
  readonly submissionNoticeBySessionId: Readonly<Record<string, SubmissionNotice>>;
  readonly attachmentRejectionsBySessionId: Readonly<Record<string, readonly string[]>>;
  addAttachments(sessionId: string, attachments: readonly StagedAttachment[]): void;
  removeAttachment(sessionId: string, attachmentId: string): void;
  clearAttachments(sessionId: string): void;
  addContextItem(sessionId: string, item: ContextPacketItem): ContextItemAdmission;
  removeContextItem(sessionId: string, itemId: string): void;
  removeContextItems(sessionId: string, itemIds: readonly string[]): void;
  clearContextItems(sessionId: string): void;
  setContextNotice(sessionId: string, notice: string | null): void;
  beginSubmission(sessionId: string): SubmissionToken | null;
  isSubmissionCurrent(sessionId: string, token: SubmissionToken): boolean;
  finishSubmission(sessionId: string, token: SubmissionToken): void;
  setSubmissionNotice(sessionId: string, notice: SubmissionNotice): void;
  setAttachmentRejections(sessionId: string, rejections: readonly string[]): void;
  beginAttachmentIntake(
    sessionId: string,
    reservation: AttachmentMaterializationReservation,
  ): AttachmentIntakeToken;
  isAttachmentIntakeCurrent(sessionId: string, token: AttachmentIntakeToken): boolean;
  finishAttachmentIntake(sessionId: string, token: AttachmentIntakeToken): void;
  pendingAttachmentIntakeUsage(): AttachmentMaterializationReservation;
  /** Invalidate async owners and release renderer-owned values after permanent deletion. */
  disposeSession(sessionId: string): void;
}

export type ComposerStoreApi = StoreApi<ComposerStoreState>;

export interface ComposerStoreOptions {
  /** Test seam; production releases each renderer-local blob URL exactly once. */
  readonly revokePreviewUrl?: (previewUrl: string) => void;
}

export function createComposerStore(options: ComposerStoreOptions = {}): ComposerStoreApi {
  const revokePreviewUrl = options.revokePreviewUrl ?? ((url: string) => URL.revokeObjectURL(url));
  let submissionSequence = 0;
  let attachmentIntakeSequence = 0;
  const attachmentIntakeGenerationBySessionId = new Map<string, number>();
  const attachmentIntakes = new Map<
    AttachmentIntakeToken,
    AttachmentMaterializationReservation & {
      readonly generation: number;
      readonly sessionId: string;
    }
  >();
  return createStore<ComposerStoreState>((set, get) => ({
    attachmentsBySessionId: {},
    contextItemsBySessionId: {},
    contextNoticeBySessionId: {},
    pendingSubmissionBySessionId: {},
    submissionNoticeBySessionId: {},
    attachmentRejectionsBySessionId: {},
    addAttachments: (sessionId, attachments) =>
      set((state) => ({
        attachmentsBySessionId: {
          ...state.attachmentsBySessionId,
          [sessionId]: [...(state.attachmentsBySessionId[sessionId] ?? []), ...attachments],
        },
      })),
    removeAttachment: (sessionId, attachmentId) => {
      const attachment = (get().attachmentsBySessionId[sessionId] ?? []).find(
        (candidate) => candidate.id === attachmentId,
      );
      if (attachment === undefined) return;
      revokePreviewUrl(attachment.previewUrl);
      set((state) => ({
        attachmentsBySessionId: {
          ...state.attachmentsBySessionId,
          [sessionId]: (state.attachmentsBySessionId[sessionId] ?? []).filter(
            (attachment) => attachment.id !== attachmentId,
          ),
        },
      }));
    },
    clearAttachments: (sessionId) => {
      const attachments = get().attachmentsBySessionId[sessionId] ?? [];
      if (attachments.length === 0) return;
      for (const attachment of attachments) revokePreviewUrl(attachment.previewUrl);
      set((state) => {
        const { [sessionId]: _cleared, ...remaining } = state.attachmentsBySessionId;
        return { attachmentsBySessionId: remaining };
      });
    },
    addContextItem: (sessionId, item) => {
      if (item.sessionId !== sessionId) {
        return { accepted: false, reason: "This context belongs to a different session." };
      }
      const admission = admitContextItem(get().contextItemsBySessionId[sessionId] ?? [], item);
      if (!admission.accepted) {
        get().setContextNotice(sessionId, admission.reason);
        return admission;
      }
      set((state) => {
        const { [sessionId]: _clearedNotice, ...remainingNotices } = state.contextNoticeBySessionId;
        return {
          contextItemsBySessionId: {
            ...state.contextItemsBySessionId,
            [sessionId]: admission.items,
          },
          contextNoticeBySessionId: remainingNotices,
        };
      });
      return admission;
    },
    removeContextItem: (sessionId, itemId) => {
      get().removeContextItems(sessionId, [itemId]);
    },
    removeContextItems: (sessionId, itemIds) => {
      if (itemIds.length === 0) return;
      const removed = new Set(itemIds);
      set((state) => {
        const remaining = (state.contextItemsBySessionId[sessionId] ?? []).filter(
          (item) => !removed.has(item.id),
        );
        if (remaining.length === 0) {
          const { [sessionId]: _cleared, ...rest } = state.contextItemsBySessionId;
          return { contextItemsBySessionId: rest };
        }
        return {
          contextItemsBySessionId: {
            ...state.contextItemsBySessionId,
            [sessionId]: remaining,
          },
        };
      });
    },
    clearContextItems: (sessionId) => {
      set((state) => {
        const { [sessionId]: _cleared, ...remaining } = state.contextItemsBySessionId;
        return { contextItemsBySessionId: remaining };
      });
    },
    setContextNotice: (sessionId, notice) => {
      set((state) => {
        if (notice === null) {
          const { [sessionId]: _cleared, ...remaining } = state.contextNoticeBySessionId;
          return { contextNoticeBySessionId: remaining };
        }
        return {
          contextNoticeBySessionId: {
            ...state.contextNoticeBySessionId,
            [sessionId]: notice,
          },
        };
      });
    },
    beginSubmission: (sessionId) => {
      if (get().pendingSubmissionBySessionId[sessionId] !== undefined) return null;
      submissionSequence += 1;
      const token = `submission-${submissionSequence}`;
      set((state) => ({
        pendingSubmissionBySessionId: {
          ...state.pendingSubmissionBySessionId,
          [sessionId]: token,
        },
      }));
      return token;
    },
    isSubmissionCurrent: (sessionId, token) =>
      get().pendingSubmissionBySessionId[sessionId] === token,
    finishSubmission: (sessionId, token) => {
      if (get().pendingSubmissionBySessionId[sessionId] !== token) return;
      set((state) => {
        const { [sessionId]: _finished, ...remaining } = state.pendingSubmissionBySessionId;
        return { pendingSubmissionBySessionId: remaining };
      });
    },
    setSubmissionNotice: (sessionId, notice) => {
      set((state) => {
        if (notice === null) {
          const { [sessionId]: _cleared, ...remaining } = state.submissionNoticeBySessionId;
          return { submissionNoticeBySessionId: remaining };
        }
        return {
          submissionNoticeBySessionId: {
            ...state.submissionNoticeBySessionId,
            [sessionId]: notice,
          },
        };
      });
    },
    setAttachmentRejections: (sessionId, rejections) => {
      set((state) => {
        if (rejections.length === 0) {
          const { [sessionId]: _cleared, ...remaining } = state.attachmentRejectionsBySessionId;
          return { attachmentRejectionsBySessionId: remaining };
        }
        return {
          attachmentRejectionsBySessionId: {
            ...state.attachmentRejectionsBySessionId,
            [sessionId]: [...rejections],
          },
        };
      });
    },
    beginAttachmentIntake: (sessionId, reservation) => {
      if (
        !Number.isSafeInteger(reservation.bytes) ||
        reservation.bytes < 0 ||
        !Number.isSafeInteger(reservation.count) ||
        reservation.count < 0
      ) {
        throw new Error("Attachment intake reservation must use non-negative safe integers.");
      }
      attachmentIntakeSequence += 1;
      const token = `attachment-intake-${attachmentIntakeSequence}`;
      attachmentIntakes.set(token, {
        ...reservation,
        generation: attachmentIntakeGenerationBySessionId.get(sessionId) ?? 0,
        sessionId,
      });
      return token;
    },
    isAttachmentIntakeCurrent: (sessionId, token) => {
      const intake = attachmentIntakes.get(token);
      return (
        intake?.sessionId === sessionId &&
        intake.generation === (attachmentIntakeGenerationBySessionId.get(sessionId) ?? 0)
      );
    },
    finishAttachmentIntake: (sessionId, token) => {
      if (attachmentIntakes.get(token)?.sessionId === sessionId) attachmentIntakes.delete(token);
    },
    pendingAttachmentIntakeUsage: () => {
      let bytes = 0;
      let count = 0;
      for (const intake of attachmentIntakes.values()) {
        bytes += intake.bytes;
        count += intake.count;
      }
      return { bytes, count };
    },
    disposeSession: (sessionId) => {
      attachmentIntakeGenerationBySessionId.set(
        sessionId,
        (attachmentIntakeGenerationBySessionId.get(sessionId) ?? 0) + 1,
      );
      const attachments = get().attachmentsBySessionId[sessionId] ?? [];
      for (const attachment of attachments) revokePreviewUrl(attachment.previewUrl);
      set((state) => {
        const { [sessionId]: _attachments, ...remainingAttachments } = state.attachmentsBySessionId;
        const { [sessionId]: _pending, ...remainingPending } = state.pendingSubmissionBySessionId;
        const { [sessionId]: _notice, ...remainingNotices } = state.submissionNoticeBySessionId;
        const { [sessionId]: _rejections, ...remainingRejections } =
          state.attachmentRejectionsBySessionId;
        const { [sessionId]: _contextItems, ...remainingContextItems } =
          state.contextItemsBySessionId;
        const { [sessionId]: _contextNotice, ...remainingContextNotices } =
          state.contextNoticeBySessionId;
        return {
          attachmentsBySessionId: remainingAttachments,
          pendingSubmissionBySessionId: remainingPending,
          submissionNoticeBySessionId: remainingNotices,
          attachmentRejectionsBySessionId: remainingRejections,
          contextItemsBySessionId: remainingContextItems,
          contextNoticeBySessionId: remainingContextNotices,
        };
      });
    },
  }));
}

// Module singleton mirrors the workspace-store wiring style.
export const composerStore = createComposerStore();
if (typeof localStorage !== "undefined") purgeLegacyComposerPersistence(localStorage);

export function useComposer<T>(selector: (state: ComposerStoreState) => T): T {
  return useStore(composerStore, selector);
}
