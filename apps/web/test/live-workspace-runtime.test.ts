import {
  OMP_RUNTIME_INTEGRATION,
  createProjectionSnapshot,
  type DesktopRuntimeSnapshot,
  type SessionProjection,
} from "@t4-code/client";
import { describe, expect, it } from "vite-plus/test";

import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";
import { workspaceSnapshotEqual } from "../src/state/shell-data.ts";

function warmProjection(
  freshness: SessionProjection["freshness"],
  confirmationCount = 0,
): SessionProjection {
  return {
    hostId: "host-local",
    sessionId: "session-1",
    entries: [],
    events: [],
    agents: new Map(),
    agentTranscripts: new Map(),
    terminals: new Map(),
    files: new Map(),
    reviews: new Map(),
    audit: [],
    confirmations: new Map(
      Array.from({ length: confirmationCount }, (_, index) => [
        `confirmation-${index}`,
        {} as SessionProjection["confirmations"] extends ReadonlyMap<string, infer Value>
          ? Value
          : never,
      ]),
    ),
    results: new Map(),
    previews: new Map(),
    previewEvents: [],
    freshness,
    transcriptEventArrivalOrdinal: 0,
    contextMaintenanceEventArrivalOrdinal: 0,
    entryIds: new Set(),
  };
}

describe("live workspace runtime identity", () => {
  it("carries the owning OMP integration into the UI host model", () => {
    const snapshot: DesktopRuntimeSnapshot = {
      version: 1,
      integration: OMP_RUNTIME_INTEGRATION,
      platform: "darwin",
      desktopVersion: "test",
      startState: "started",
      targets: new Map([
        [
          "local",
          {
            targetId: "local",
            label: "This machine",
            kind: "local",
            state: "connected",
            paired: true,
          },
        ],
      ]),
      connections: new Map([["local", "connected"]]),
      targetHosts: new Map([["local", "host-local"]]),
      hosts: new Map([
        [
          "host-local",
          {
            targetId: "local",
            hostId: "host-local",
            ompVersion: "test",
            ompBuild: "test",
            appserverVersion: "test",
            appserverBuild: "test",
            epoch: "epoch-1",
            grantedCapabilities: [],
            grantedFeatures: [],
            negotiatedLimits: {},
            authentication: "local",
            resumed: false,
          },
        ],
      ]),
      catalogs: new Map(),
      settings: new Map(),
      projection: createProjectionSnapshot(),
      runtimeErrors: [],
    };

    expect(deriveWorkspaceData(snapshot).hosts).toEqual([
      expect.objectContaining({ id: "host-local", runtimeKind: "omp" }),
    ]);
  });

  it("ignores transcript-only warm projection churn for shell rendering", () => {
    const projection = createProjectionSnapshot();
    const base: DesktopRuntimeSnapshot = {
      version: 1,
      integration: OMP_RUNTIME_INTEGRATION,
      platform: "darwin",
      desktopVersion: "test",
      startState: "started",
      targets: new Map(),
      connections: new Map(),
      targetHosts: new Map(),
      hosts: new Map(),
      catalogs: new Map(),
      settings: new Map(),
      projection: {
        ...projection,
        sessions: new Map([["host-local\u0000session-1", warmProjection("fresh")]]),
      },
      runtimeErrors: [],
    };
    const transcriptOnly: DesktopRuntimeSnapshot = {
      ...base,
      projection: {
        ...base.projection,
        sessions: new Map([["host-local\u0000session-1", warmProjection("fresh")]]),
        arrivalOrdinal: 1,
      },
    };
    const confirmationChanged: DesktopRuntimeSnapshot = {
      ...transcriptOnly,
      projection: {
        ...transcriptOnly.projection,
        sessions: new Map([["host-local\u0000session-1", warmProjection("fresh", 1)]]),
      },
    };

    expect(workspaceSnapshotEqual(base, transcriptOnly)).toBe(true);
    expect(workspaceSnapshotEqual(transcriptOnly, confirmationChanged)).toBe(false);
  });
});
