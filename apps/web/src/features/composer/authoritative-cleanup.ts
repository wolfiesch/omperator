import type {
  DesktopRuntimeController,
  ProjectionSnapshot,
} from "@t4-code/client";
import {
  decodeSessionListResult,
  decodeSessions,
  type SessionRef,
} from "@t4-code/protocol";
import type { RendererServerFrame } from "@t4-code/protocol/desktop-ipc";

import { composerStore, type ComposerStoreApi } from "./composer-store.ts";
import { sessionViewId } from "../../platform/live-workspace.ts";
import { disposeTranscriptImagesForSession } from "../session-runtime/transcript-images.ts";

interface CompleteInventory {
  readonly sessionIdsByHost: ReadonlyMap<string, ReadonlySet<string>>;
}

function sessionKey(hostId: string, sessionId: string): string {
  return `${hostId}\u0000${sessionId}`;
}

function knownSession(snapshot: ProjectionSnapshot, hostId: string, sessionId: string): boolean {
  const key = sessionKey(hostId, sessionId);
  return snapshot.sessionIndex.has(key) || snapshot.sessions.has(key);
}

function completeInventory(frame: RendererServerFrame): CompleteInventory | null {
  let refs: readonly SessionRef[];
  let explicitHostId: string | undefined;
  let truncated: boolean;
  try {
    if (frame.type === "sessions") {
      const decoded = decodeSessions(frame);
      refs = decoded.sessions;
      explicitHostId = decoded.hostId === undefined ? undefined : String(decoded.hostId);
      truncated = decoded.truncated === true;
    } else if (
      frame.type === "response" &&
      frame.ok &&
      (frame.command === "session.list" || frame.command === "host.list")
    ) {
      const decoded = decodeSessionListResult(frame.result);
      refs = decoded.sessions;
      explicitHostId = String(frame.hostId);
      truncated = decoded.truncated;
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (truncated) return null;

  const sessionIdsByHost = new Map<string, Set<string>>();
  if (explicitHostId !== undefined) sessionIdsByHost.set(explicitHostId, new Set());
  for (const ref of refs) {
    const hostId = String(ref.hostId);
    const ids = sessionIdsByHost.get(hostId) ?? new Set<string>();
    ids.add(String(ref.sessionId));
    sessionIdsByHost.set(hostId, ids);
  }
  return { sessionIdsByHost };
}

/**
 * Release renderer-owned Files only after the host has authoritatively removed
 * a session. Cache eviction, disconnects, truncated inventories, and stale
 * deltas deliberately do nothing.
 */
export function reconcileAuthoritativeSessionDeletion(
  previous: ProjectionSnapshot,
  current: ProjectionSnapshot,
  frame: RendererServerFrame,
  store: ComposerStoreApi = composerStore,
): void {
  if (frame.type === "session.delta" && frame.remove !== undefined) {
    const hostId = String(frame.hostId);
    const sessionId = String(frame.remove);
    const ownerKey = sessionKey(hostId, String(frame.sessionId));
    const appliedCursor = current.sessionDeltaCursors.get(ownerKey);
    const applied =
      appliedCursor !== undefined &&
      appliedCursor.epoch === frame.cursor.epoch &&
      appliedCursor.seq === frame.cursor.seq;
    if (
      applied &&
      knownSession(previous, hostId, sessionId) &&
      !knownSession(current, hostId, sessionId)
    ) {
      store.getState().disposeSession(sessionViewId(hostId, sessionId));
      disposeTranscriptImagesForSession(hostId, sessionId);
    }
    return;
  }

  const inventory = completeInventory(frame);
  if (inventory === null) return;
  for (const [hostId, incomingSessionIds] of inventory.sessionIdsByHost) {
    const previousSessionIds = new Set<string>();
    for (const ref of previous.sessionIndex.values()) {
      if (String(ref.hostId) === hostId) previousSessionIds.add(String(ref.sessionId));
    }
    for (const session of previous.sessions.values()) {
      if (session.hostId === hostId) previousSessionIds.add(session.sessionId);
    }
    for (const sessionId of previousSessionIds) {
      if (
        !incomingSessionIds.has(sessionId) &&
        !knownSession(current, hostId, sessionId)
      ) {
        store.getState().disposeSession(sessionViewId(hostId, sessionId));
        disposeTranscriptImagesForSession(hostId, sessionId);
      }
    }
  }
}

/** Bind one cleanup observer to the window's one runtime controller. */
export function bindAuthoritativeComposerCleanup(
  controller: DesktopRuntimeController,
  store: ComposerStoreApi = composerStore,
): () => void {
  let previous = controller.getSnapshot().projection;
  return controller.subscribeFrames((event) => {
    const current = controller.getSnapshot().projection;
    reconcileAuthoritativeSessionDeletion(previous, current, event.frame, store);
    previous = current;
  });
}
