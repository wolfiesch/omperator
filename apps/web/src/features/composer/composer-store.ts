// Composer-local attachment staging, keyed by session. Draft *text*
// continuity lives in the shared workspace store (setSessionDraft); model /
// thinking / fast / mode selections are SESSION state owned by the runtime
// (live host or fixture) and are never persisted renderer-side. This store
// keeps only in-memory attachments awaiting the next prompt.
import { createStore, type StoreApi, useStore } from "zustand";

import type { StagedAttachment } from "./attachments.ts";
import type { SubmissionNotice, SubmissionToken } from "./submission.ts";

/**
 * The retired v1 options-persistence key. Model/thinking/fast/mode moved to
 * session-state authority; any surviving blob is stale renderer truth and
 * gets removed on boot so it can never leak back into a control.
 */
export const LEGACY_COMPOSER_STORAGE_KEY = "omp:composer:v1";

export function purgeLegacyComposerPersistence(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(LEGACY_COMPOSER_STORAGE_KEY);
  } catch {
    // Storage unavailable: nothing to purge.
  }
}

export interface ComposerStoreState {
  readonly attachmentsBySessionId: Record<string, readonly StagedAttachment[]>;
  readonly pendingSubmissionBySessionId: Readonly<Record<string, SubmissionToken>>;
  readonly submissionNoticeBySessionId: Readonly<Record<string, SubmissionNotice>>;
  readonly attachmentRejectionsBySessionId: Readonly<Record<string, readonly string[]>>;
  addAttachments(sessionId: string, attachments: readonly StagedAttachment[]): void;
  removeAttachment(sessionId: string, attachmentId: string): void;
  clearAttachments(sessionId: string): void;
  beginSubmission(sessionId: string): SubmissionToken | null;
  isSubmissionCurrent(sessionId: string, token: SubmissionToken): boolean;
  finishSubmission(sessionId: string, token: SubmissionToken): void;
  setSubmissionNotice(sessionId: string, notice: SubmissionNotice): void;
  setAttachmentRejections(sessionId: string, rejections: readonly string[]): void;
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
  return createStore<ComposerStoreState>((set, get) => ({
    attachmentsBySessionId: {},
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
    disposeSession: (sessionId) => {
      const attachments = get().attachmentsBySessionId[sessionId] ?? [];
      for (const attachment of attachments) revokePreviewUrl(attachment.previewUrl);
      set((state) => {
        const { [sessionId]: _attachments, ...remainingAttachments } = state.attachmentsBySessionId;
        const { [sessionId]: _pending, ...remainingPending } = state.pendingSubmissionBySessionId;
        const { [sessionId]: _notice, ...remainingNotices } = state.submissionNoticeBySessionId;
        const { [sessionId]: _rejections, ...remainingRejections } =
          state.attachmentRejectionsBySessionId;
        return {
          attachmentsBySessionId: remainingAttachments,
          pendingSubmissionBySessionId: remainingPending,
          submissionNoticeBySessionId: remainingNotices,
          attachmentRejectionsBySessionId: remainingRejections,
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
