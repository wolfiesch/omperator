import type {
  DesktopRuntimeController,
  PublicOmpServerEvent,
  ProjectionSnapshot,
} from "@t4-code/client";
import {
  decodeSessionListResult,
  type SessionRef,
} from "@t4-code/protocol";

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

function completeInventory(event: PublicOmpServerEvent): CompleteInventory | null {
  let refs: readonly SessionRef[];
  let explicitHostId: string | undefined;
  let truncated: boolean;
  try {
    if (event.kind === "sessions") {
      refs = event.payload.sessions;
      explicitHostId = event.payload.hostId === undefined
        ? undefined
        : String(event.payload.hostId);
      truncated = event.payload.truncated === true;
    } else if (
      event.kind === "response" &&
      event.payload.ok &&
      (event.payload.command === "session.list" || event.payload.command === "host.list")
    ) {
      const decoded = decodeSessionListResult(event.payload.result);
      refs = decoded.sessions;
      explicitHostId = String(event.payload.hostId);
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
  event: PublicOmpServerEvent,
  store: ComposerStoreApi = composerStore,
): void {
  if (event.kind === "session.delta" && event.payload.remove !== undefined) {
    const hostId = String(event.payload.hostId);
    const sessionId = String(event.payload.remove);
    const ownerKey = sessionKey(hostId, String(event.payload.sessionId));
    const appliedCursor = current.sessionDeltaCursors.get(ownerKey);
    const applied =
      appliedCursor !== undefined &&
      appliedCursor.epoch === event.payload.cursor.epoch &&
      appliedCursor.seq === event.payload.cursor.seq;
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

  const inventory = completeInventory(event);
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
  return controller.subscribeEvents((event) => {
    const current = controller.getSnapshot().projection;
    reconcileAuthoritativeSessionDeletion(previous, current, event.event, store);
    previous = current;
  });
}
