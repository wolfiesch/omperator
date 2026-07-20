import type { DesktopRuntimeSnapshot } from "@t4-code/client";

import type {
  SessionListView,
  WorkspaceSession,
} from "../../lib/workspace-data.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import type { SessionPreviewSelection } from "../../state/workspace-store.ts";

export type CompletedSessionManagementAction = "archive" | "restore" | "delete";

export interface SessionManagementNavigation {
  readonly view: SessionListView;
  readonly destinationSessionId: string | null;
  readonly navigate: boolean;
}

/**
 * Resolve post-command navigation from the converged authoritative inventory.
 * The acted-on row is the pre-command row, so its archive state records which
 * list a delete came from even after the host has removed it.
 */
export function resolveSessionManagementNavigation(
  action: CompletedSessionManagementAction,
  actedOn: WorkspaceSession,
  sessions: readonly WorkspaceSession[],
  active: boolean,
): SessionManagementNavigation {
  if (action === "restore") {
    return {
      view: "current",
      destinationSessionId: actedOn.id,
      navigate: true,
    };
  }

  const view: SessionListView = actedOn.archivedAt === undefined ? "current" : "archived";
  if (!active) return { view, destinationSessionId: null, navigate: false };

  const destinationSessionId =
    sessions.find(
      (candidate) =>
        candidate.id !== actedOn.id &&
        (view === "archived"
          ? candidate.archivedAt !== undefined
          : candidate.archivedAt === undefined),
    )?.id ?? null;
  return { view, destinationSessionId, navigate: true };
}

/**
 * Carry a host-advertised GUI preview through navigation. Trust metadata comes
 * only from the matching warm projection; a not-yet-attached preview keeps the
 * id without inventing authority or opting the user into an unknown profile.
 */
export function previewSelectionForNavigation(
  snapshot: DesktopRuntimeSnapshot,
  sessionViewId: string,
  previewId: string,
): SessionPreviewSelection | null {
  const address = resolveLiveSession(snapshot, sessionViewId);
  if (address === null) return null;
  const preview = [
    ...(snapshot.projection.sessions.get(
      `${address.hostId}\u0000${address.sessionId}`,
    )?.previews.values() ?? []),
  ].find((candidate) => candidate.previewId === previewId);
  if (preview === undefined) return { previewId, optIn: false };
  return {
    previewId,
    optInKind: preview.authority?.kind ?? null,
    optInAuthorityId: preview.authority?.id ?? null,
    optIn: true,
  };
}
