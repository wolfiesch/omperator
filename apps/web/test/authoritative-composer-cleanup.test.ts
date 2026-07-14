import {
  applyPublicFrame,
  createProjectionSnapshot,
  type ProjectionFrame,
  type ProjectionSnapshot,
} from "@t4-code/client";
import {
  hostId,
  projectId,
  revision,
  sessionId,
  type SessionRef,
} from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

import { admitAttachments, type StagedAttachment } from "../src/features/composer/attachments.ts";
import { reconcileAuthoritativeSessionDeletion } from "../src/features/composer/authoritative-cleanup.ts";
import { createComposerStore } from "../src/features/composer/composer-store.ts";
import { createTranscriptImageSource } from "../src/features/session-runtime/transcript-images.ts";
import { sessionViewId } from "../src/platform/live-workspace.ts";

const HOST = hostId("cleanup-host");
const V = "omp-app/1" as const;

function viewId(id: string): string {
  return sessionViewId(String(HOST), id);
}

function ref(id: string): SessionRef {
  return {
    hostId: HOST,
    sessionId: sessionId(id),
    project: { projectId: projectId("cleanup-project"), name: "Cleanup" },
    revision: revision(`revision-${id}`),
    title: id,
    status: "idle",
    updatedAt: "2026-07-14T00:00:00Z",
  };
}

function inventory(
  ids: readonly string[],
  seq: number,
  options: { readonly totalCount?: number; readonly truncated?: boolean } = {},
): Extract<ProjectionFrame, { type: "sessions" }> {
  return {
    v: V,
    type: "sessions",
    hostId: HOST,
    cursor: { epoch: "cleanup-epoch", seq },
    sessions: ids.map(ref),
    totalCount: options.totalCount ?? ids.length,
    truncated: options.truncated ?? false,
  };
}

function removeDelta(id: string, seq: number): Extract<ProjectionFrame, { type: "session.delta" }> {
  return {
    v: V,
    type: "session.delta",
    hostId: HOST,
    sessionId: sessionId(id),
    cursor: { epoch: "cleanup-epoch", seq },
    revision: revision(`delta-${seq}`),
    remove: sessionId(id),
  };
}

function staged(id: string): StagedAttachment {
  const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], `${id}.png`, {
    type: "image/png",
  });
  return admitAttachments([], [{ file }], {
    createId: () => `attachment-${id}`,
    createPreviewUrl: () => `blob:test/${id}`,
  }).accepted[0] as StagedAttachment;
}

function apply(snapshot: ProjectionSnapshot, frame: ProjectionFrame): ProjectionSnapshot {
  return applyPublicFrame(snapshot, frame);
}

describe("authoritative composer cleanup", () => {
  it("releases only sessions omitted by a complete authoritative inventory", () => {
    const revoked: string[] = [];
    const store = createComposerStore({ revokePreviewUrl: (url) => revoked.push(url) });
    store.getState().addAttachments(viewId("deleted"), [staged("deleted")]);
    store.getState().addAttachments(viewId("kept"), [staged("kept")]);
    const previous = apply(createProjectionSnapshot(), inventory(["deleted", "kept"], 1));
    const frame = inventory(["kept"], 2);
    const current = apply(previous, frame);

    reconcileAuthoritativeSessionDeletion(previous, current, frame, store);

    expect(store.getState().attachmentsBySessionId[viewId("deleted")]).toBeUndefined();
    expect(store.getState().attachmentsBySessionId[viewId("kept")]).toHaveLength(1);
    expect(revoked).toEqual(["blob:test/deleted"]);
    reconcileAuthoritativeSessionDeletion(previous, current, frame, store);
    expect(revoked).toEqual(["blob:test/deleted"]);
  });

  it("preserves staged Files for truncated inventories and stale remove deltas", () => {
    const revoked: string[] = [];
    const store = createComposerStore({ revokePreviewUrl: (url) => revoked.push(url) });
    store.getState().addAttachments(viewId("survivor"), [staged("survivor")]);
    let previous = apply(createProjectionSnapshot(), inventory(["survivor", "other"], 1));
    const truncated = inventory(["other"], 2, { totalCount: 2, truncated: true });
    let current = apply(previous, truncated);
    reconcileAuthoritativeSessionDeletion(previous, current, truncated, store);
    expect(store.getState().attachmentsBySessionId[viewId("survivor")]).toHaveLength(1);

    const cursorSeed = {
      v: V,
      type: "session.delta",
      hostId: HOST,
      sessionId: sessionId("survivor"),
      cursor: { epoch: "cleanup-epoch", seq: 5 },
      revision: revision("delta-5"),
      upsert: ref("survivor"),
    } as const satisfies Extract<ProjectionFrame, { type: "session.delta" }>;
    previous = apply(current, cursorSeed);
    const stale = removeDelta("survivor", 4);
    current = apply(previous, stale);
    reconcileAuthoritativeSessionDeletion(previous, current, stale, store);

    expect(store.getState().attachmentsBySessionId[viewId("survivor")]).toHaveLength(1);
    expect(revoked).toEqual([]);
  });

  it("releases Files after an accepted current remove delta", () => {
    const revoked: string[] = [];
    const store = createComposerStore({ revokePreviewUrl: (url) => revoked.push(url) });
    store.getState().addAttachments(viewId("deleted"), [staged("deleted")]);
    const transcriptImages = createTranscriptImageSource({
      hostId: String(HOST),
      sessionId: "deleted",
      availability: { available: false, reason: "Waiting for the host." },
      readChunk: async () => ({ accepted: false }),
    });
    const transcriptImage = {
      entryId: "deleted-entry",
      sha256: "a".repeat(64),
      mimeType: "image/png" as const,
    };
    const previous = apply(createProjectionSnapshot(), inventory(["deleted"], 1));
    const frame = removeDelta("deleted", 2);
    const current = apply(previous, frame);

    reconcileAuthoritativeSessionDeletion(previous, current, frame, store);

    expect(store.getState().attachmentsBySessionId[viewId("deleted")]).toBeUndefined();
    expect(revoked).toEqual(["blob:test/deleted"]);
    expect(transcriptImages.getSnapshot(transcriptImage)).toEqual({
      status: "unavailable",
      reason: "This session was removed from the host.",
    });
  });
});
