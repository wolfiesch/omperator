import type { DesktopRuntimeSnapshot } from "@t4-code/client";

import { describe, expect, it } from "vite-plus/test";

import {
  previewSelectionForNavigation,
  resolveSessionManagementNavigation,
} from "../src/features/session-runtime/session-navigation.ts";
import { sessionViewId } from "../src/platform/live-workspace.ts";
import type { WorkspaceSession } from "../src/lib/workspace-data.ts";

function session(id: string, archived = false): WorkspaceSession {
  return {
    id,
    projectId: "project",
    title: id,
    model: "model",
    status: null,
    freshness: "live",
    pendingApprovals: 0,
    latestTurnCompletedAt: null,
    createdAt: "2026-07-13T00:00:00Z",
    updatedAt: "2026-07-13T00:00:00Z",
    lastActivity: "",
    ...(archived ? { archivedAt: "2026-07-13T01:00:00Z" } : {}),
  };
}

describe("session management navigation", () => {
  const current = session("current");
  const nextCurrent = session("next-current");
  const archived = session("archived", true);
  const nextArchived = session("next-archived", true);
  const inventory = [nextCurrent, nextArchived];

  it("keeps archive and current delete in Current and selects the next current session", () => {
    expect(
      resolveSessionManagementNavigation("archive", current, inventory, true),
    ).toEqual({
      view: "current",
      destinationSessionId: "next-current",
      navigate: true,
    });
    expect(
      resolveSessionManagementNavigation("delete", current, inventory, true),
    ).toEqual({
      view: "current",
      destinationSessionId: "next-current",
      navigate: true,
    });
  });

  it("keeps archived delete in Archived and selects the next archived session", () => {
    expect(
      resolveSessionManagementNavigation("delete", archived, inventory, true),
    ).toEqual({
      view: "archived",
      destinationSessionId: "next-archived",
      navigate: true,
    });
  });

  it("switches restore to Current and keeps the restored session open", () => {
    expect(
      resolveSessionManagementNavigation("restore", archived, inventory, true),
    ).toEqual({
      view: "current",
      destinationSessionId: "archived",
      navigate: true,
    });
  });

  it("does not replace the active route for an inactive destructive row", () => {
    expect(
      resolveSessionManagementNavigation("delete", archived, inventory, false),
    ).toEqual({
      view: "archived",
      destinationSessionId: null,
      navigate: false,
    });
  });

  it("preserves the advertised preview id and only opts into negotiated authority", () => {
    const hostId = "cluster/host";
    const sessionId = "session/gui";
    const viewId = sessionViewId(hostId, sessionId);
    const snapshot = {
      targetHosts: new Map([["cluster-target", hostId]]),
      connections: new Map([["cluster-target", "connected"]]),
      projection: {
        sessions: new Map([
          [
            `${hostId}\u0000${sessionId}`,
            {
              previews: new Map([
                [
                  "preview-a",
                  {
                    previewId: "preview-a",
                    authority: {
                      id: "omp-session",
                      kind: "isolated-session",
                    },
                  },
                ],
              ]),
            },
          ],
        ]),
      },
    } as unknown as DesktopRuntimeSnapshot;

    expect(viewId).toBe("cluster%2Fhost/session%2Fgui");
    expect(previewSelectionForNavigation(snapshot, viewId, "preview-a")).toEqual({
      previewId: "preview-a",
      optInKind: "isolated-session",
      optInAuthorityId: "omp-session",
      optIn: true,
    });
    expect(previewSelectionForNavigation(snapshot, viewId, "preview-pending")).toEqual({
      previewId: "preview-pending",
      optIn: false,
    });
  });
});
