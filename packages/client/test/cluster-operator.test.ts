import {
  CI_TRIGGER_CAPABILITY,
  CLUSTER_OPERATOR_FEATURE,
  hostId,
  revision,
  type WorkspaceStateFrame,
} from "@t4-code/protocol";
import { describe, expect, it, vi } from "vite-plus/test";

import { bootstrapDesktopHost, type DesktopBootstrapCommand } from "../src/desktop-runtime-bootstrap.ts";
import {
  DEFAULT_CLUSTER_OPERATOR_ENABLED,
  applyPublicFrame,
  clusterOperatorRequestedFeatures,
  createProjectionSnapshot,
  ProjectionStore,
  type ProjectionFrame,
} from "../src/index.ts";

const HOST = hostId("cluster-host");
const welcome = {
  hostId: HOST,
  grantedCapabilities: ["sessions.read", "sessions.manage", CI_TRIGGER_CAPABILITY],
  grantedFeatures: [CLUSTER_OPERATOR_FEATURE, "host.watch"],
} as never;

function workspaceState(
  seq: number,
  phase: "Pending" | "Ready" | "Failed" | "Terminating" | "Unknown",
  workspaceId = "workspace-a",
): WorkspaceStateFrame {
  return {
    v: "omp-app/1",
    type: "workspace.state",
    hostId: HOST,
    workspaceId,
    cursor: { epoch: "workspace-epoch", seq },
    revision: revision(`workspace-r${seq}`),
    upsert: {
      id: workspaceId,
      displayName: "Operator workspace",
      phase,
      retentionPolicy: "Retain",
      capacity: "20Gi",
      storageClass: "rwx",
      accessMode: "ReadWriteMany",
      revision: revision(`workspace-r${seq}`),
    },
  } as WorkspaceStateFrame;
}

describe("cluster operator client contract", () => {
  it("is source-default-off and requests the one feature only after explicit opt-in", () => {
    expect(DEFAULT_CLUSTER_OPERATOR_ENABLED).toBe(false);
    expect(clusterOperatorRequestedFeatures(["resume", CLUSTER_OPERATOR_FEATURE])).toEqual([
      "resume",
    ]);
    expect(
      clusterOperatorRequestedFeatures(["resume", CLUSTER_OPERATOR_FEATURE], true),
    ).toEqual(["resume", CLUSTER_OPERATOR_FEATURE]);
  });

  it("does not issue cluster bootstrap commands while the local option is off", async () => {
    const issue = vi.fn(async (_intent: Parameters<DesktopBootstrapCommand>[0]) => ({
      targetId: "cluster",
      requestId: "bootstrap-request",
      commandId: "bootstrap-command",
      accepted: true as const,
      result: { cursor: { epoch: "session-epoch", seq: 1 }, sessions: [] },
    }));

    await bootstrapDesktopHost({ targetId: "cluster", frame: welcome, issue });

    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.calls.map(([intent]) => intent.command)).toEqual([
      "session.list",
      "host.watch",
    ]);
    expect(issue).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "workspace.list" }),
    );
  });

  it("bootstraps cluster workspace state only when enabled and advertised", async () => {
    const commands: string[] = [];
    const issue = vi.fn(async (intent: { readonly command: string }) => {
      commands.push(intent.command);
      return {
        accepted: true,
        result:
          intent.command === "session.list"
            ? { cursor: { epoch: "session-epoch", seq: 1 }, sessions: [] }
            : intent.command === "workspace.list"
              ? {
                  cursor: { epoch: "workspace-epoch", seq: 4 },
                  workspaces: [workspaceState(4, "Ready").upsert],
                }
              : {},
      };
    }) as never;

    await bootstrapDesktopHost({
      targetId: "cluster",
      frame: welcome,
      issue,
      clusterOperatorEnabled: true,
    });

    expect(commands).toEqual(["session.list", "host.watch", "workspace.list"]);
  });

  it("keeps workspace cursors independent and drops duplicate replay", () => {
    let state = createProjectionSnapshot();
    state = applyPublicFrame(state, workspaceState(1, "Pending") as ProjectionFrame);
    const first = state.workspaces.get(`${String(HOST)}\u0000workspace-a`);
    expect(first?.phase).toBe("Pending");
    expect(state.workspaceCursors.get(String(HOST))).toEqual({
      epoch: "workspace-epoch",
      seq: 1,
    });

    state = applyPublicFrame(state, workspaceState(1, "Failed") as ProjectionFrame);
    expect(state.workspaces.get(`${String(HOST)}\u0000workspace-a`)).toBe(first);

    state = applyPublicFrame(
      state,
      {
        v: "omp-app/1",
        type: "sessions",
        hostId: HOST,
        cursor: { epoch: "session-epoch", seq: 900 },
        sessions: [],
        totalCount: 0,
        truncated: false,
      } as ProjectionFrame,
    );
    state = applyPublicFrame(state, workspaceState(2, "Ready") as ProjectionFrame);
    expect(state.workspaces.get(`${String(HOST)}\u0000workspace-a`)?.phase).toBe("Ready");
    expect(state.workspaceCursors.get(String(HOST))?.seq).toBe(2);
  });

  it("accepts a complete workspace inventory at the same cursor as the latest delta", () => {
    const store = new ProjectionStore();
    store.applyPublicFrame(workspaceState(2, "Ready") as ProjectionFrame);
    store.replaceWorkspaceInventory(
      String(HOST),
      [workspaceState(2, "Failed", "workspace-b").upsert!],
      { epoch: "workspace-epoch", seq: 2 },
    );

    expect(store.snapshot.workspaces.has(`${String(HOST)}\u0000workspace-a`)).toBe(false);
    expect(store.snapshot.workspaces.get(`${String(HOST)}\u0000workspace-b`)?.phase).toBe("Failed");
    expect(store.snapshot.workspaceCursors.get(String(HOST))?.seq).toBe(2);
  });

  it("applies exact workspace removals without disturbing another host", () => {
    const hostB = hostId("cluster-host-b");
    let state = applyPublicFrame(createProjectionSnapshot(), workspaceState(1, "Ready") as ProjectionFrame);
    state = applyPublicFrame(
      state,
      { ...workspaceState(1, "Ready", "workspace-b"), hostId: hostB } as ProjectionFrame,
    );
    state = applyPublicFrame(
      state,
      {
        v: "omp-app/1",
        type: "workspace.state",
        hostId: HOST,
        workspaceId: "workspace-a",
        cursor: { epoch: "workspace-epoch", seq: 2 },
        revision: revision("workspace-r2"),
        remove: "workspace-a",
      } as WorkspaceStateFrame as ProjectionFrame,
    );

    expect(state.workspaces.has(`${String(HOST)}\u0000workspace-a`)).toBe(false);
    expect(state.workspaces.has(`${String(hostB)}\u0000workspace-b`)).toBe(true);
  });
});
