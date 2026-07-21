import {
  CI_TRIGGER_CAPABILITY,
  CLUSTER_OPERATOR_FEATURE,
  hostId,
  revision,
  sessionId,
  type SessionRef,
  type WorkspaceInfrastructureProjection,
} from "@t4-code/protocol";
import {
  createProjectionSnapshot,
  type DesktopRuntimeController,
  type DesktopRuntimeSnapshot,
} from "@t4-code/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  clusterCiAvailability,
  clusterCreationTargets,
  clusterGuiAvailability,
  clusterOperatorAvailability,
  createClusterSession,
  createClusterWorkspace,
  runClusterCi,
} from "../src/features/targets/cluster-operator.ts";
import {
  ClusterOperatorSection,
  clusterSessionMatchesWorkspace,
  prepareClusterSessionCreation,
} from "../src/features/targets/ClusterOperatorSection.tsx";
import { deriveWorkspaceData } from "../src/platform/live-workspace.ts";

const HOST = "cluster-host";
const TARGET = "cluster-target";
const workspace: WorkspaceInfrastructureProjection = {
  id: "workspace-a",
  displayName: "Release train",
  phase: "Ready",
  retentionPolicy: "Retain",
  storageClass: "t4-workspaces-rwx",
  capacity: "20Gi",
  accessMode: "ReadWriteMany",
  revision: revision("workspace-r2"),
  condition: {
    type: "StorageReady",
    status: "True",
    reason: "Bound",
    message: "The RWX claim is bound.",
    observedGeneration: 2,
  },
};

function snapshot(options: {
  readonly enabled?: boolean;
  readonly connected?: boolean;
  readonly features?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly session?: SessionRef;
  readonly workspace?: WorkspaceInfrastructureProjection;
} = {}): DesktopRuntimeSnapshot {
  const projection = createProjectionSnapshot();
  return {
    version: 1,
    integration: { kind: "omp", displayName: "OMP", level: "first-party" },
    platform: "linux",
    desktopVersion: "test",
    startState: "started",
    clusterOperatorEnabled: options.enabled ?? false,
    targets: new Map([[TARGET, { targetId: TARGET, label: "Cluster", kind: "remote", state: options.connected === false ? "disconnected" : "connected", paired: true }]]),
    connections: new Map([[TARGET, options.connected === false ? "disconnected" : "connected"]]),
    targetHosts: new Map([[TARGET, HOST]]),
    hosts: new Map([[HOST, {
      targetId: TARGET,
      hostId: HOST,
      ompVersion: "17.0.5",
      ompBuild: "8476f445",
      appserverVersion: "1",
      appserverBuild: "test",
      epoch: "host-epoch",
      grantedCapabilities: [...(options.capabilities ?? ["sessions.read", "sessions.manage", "sessions.prompt", "sessions.control", CI_TRIGGER_CAPABILITY])],
      grantedFeatures: [...(options.features ?? [CLUSTER_OPERATOR_FEATURE])],
      negotiatedLimits: {},
      authentication: "paired",
      resumed: false,
    }]]),
    catalogs: new Map(),
    settings: new Map(),
    projection: {
      ...projection,
      workspaces: new Map(options.workspace === undefined ? [] : [[`${HOST}\u0000${options.workspace.id}`, options.workspace]]),
      workspaceCursors: new Map(options.workspace === undefined ? [] : [[HOST, { epoch: "workspace-epoch", seq: 2 }]]),
      sessionIndex: new Map(options.session === undefined ? [] : [[`${HOST}\u0000${String(options.session.sessionId)}`, options.session]]),
      sessionIndexMetadata: new Map(options.session === undefined ? [] : [[HOST, { totalCount: 1, truncated: false }]]),
    },
    runtimeErrors: [],
  } as DesktopRuntimeSnapshot;
}

const session: SessionRef = {
  hostId: hostId(HOST),
  sessionId: sessionId("session-a"),
  project: { projectId: "cluster/workspace-a" as never, name: "Release train" },
  revision: revision("session-r3"),
  title: "Ship release",
  status: "active",
  updatedAt: "2026-07-20T12:00:00.000Z",
  liveState: {
    phase: "running",
    cluster: {
      workspaceId: workspace.id,
      phase: "Running",
      gui: { state: "Ready", previewId: "preview-a" },
    },
    ci: {
      provider: "woodpecker",
      correlation: "exact",
      repositoryId: "repo-a",
      branch: "main",
      ref: "refs/heads/main",
      commit: "0123456789abcdef",
      pipelineNumber: 42,
      status: "running",
      currentStage: "verify",
      startedAt: "2026-07-20T12:01:00.000Z",
      link: "https://ci.tailnet.ts.net/repos/repo-a/pipeline/42",
    },
  },
};

describe("cluster operator presentation", () => {
  it("fails closed with exact disabled, transport, feature, capability, and revision reasons", () => {
    expect(clusterOperatorAvailability(snapshot(), TARGET, HOST, "read")).toEqual({
      enabled: false,
      reason: "Cluster operator is disabled in this app.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, connected: false }), TARGET, HOST, "read")).toEqual({
      enabled: false,
      reason: "Reconnect this host to inspect cluster workspaces.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, features: [] }), TARGET, HOST, "read")).toEqual({
      enabled: false,
      reason: "This host does not advertise cluster operator support.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: [] }), TARGET, HOST, "read")).toEqual({
      enabled: false,
      reason: "This host did not grant session read access.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: ["sessions.read"] }), TARGET, HOST, "manage")).toEqual({
      enabled: false,
      reason: "This host did not grant workspace and session management.",
    });
    expect(clusterOperatorAvailability(snapshot({ enabled: true, capabilities: ["sessions.read", "sessions.manage"] }), TARGET, HOST, "ci", revision("session-r3"))).toEqual({
      enabled: false,
      reason: "This host did not grant CI trigger access.",
    });
    expect(
      clusterOperatorAvailability(
        snapshot({ enabled: true, capabilities: ["sessions.read", CI_TRIGGER_CAPABILITY] }),
        TARGET,
        HOST,
        "ci",
        revision("session-r3"),
      ),
    ).toEqual({ enabled: true });
    expect(clusterOperatorAvailability(snapshot({ enabled: true }), TARGET, HOST, "ci")).toEqual({
      enabled: false,
      reason: "Waiting for the latest session revision.",
    });
  });

  it("binds every operation and creation choice to the advertised target and host", () => {
    const base = snapshot({ enabled: true });
    const otherHost = "cluster-host-b";
    const otherTarget = "cluster-target-b";
    const multiHost = {
      ...base,
      targets: new Map(base.targets).set(otherTarget, {
        targetId: otherTarget,
        label: "Alpha cluster",
        kind: "remote",
        state: "connected",
        paired: true,
      }),
      connections: new Map(base.connections).set(otherTarget, "connected"),
      targetHosts: new Map(base.targetHosts).set(otherTarget, otherHost),
      hosts: new Map(base.hosts).set(otherHost, {
        ...base.hosts.get(HOST)!,
        targetId: otherTarget,
        hostId: otherHost,
      }),
    } as DesktopRuntimeSnapshot;

    expect(clusterCreationTargets(multiHost)).toEqual([
      { targetId: otherTarget, hostId: otherHost, label: "Alpha cluster" },
      { targetId: TARGET, hostId: HOST, label: "Cluster" },
    ]);
    expect(clusterOperatorAvailability(multiHost, TARGET, otherHost, "manage")).toEqual({
      enabled: false,
      reason: "This cluster host is no longer bound to the selected target.",
    });
  });

  it("disables CI and GUI with capability, negotiation, correlation, and host reasons", () => {
    expect(
      clusterCiAvailability(
        snapshot({ enabled: true }),
        TARGET,
        HOST,
        revision("session-r3"),
        { ...session.liveState!.ci!, correlation: "unknown" },
      ),
    ).toEqual({
      enabled: false,
      reason: "CI correlation is unknown; a run cannot be triggered.",
    });
    expect(
      clusterGuiAvailability(snapshot({ enabled: true }), TARGET, HOST, session.liveState!.cluster!.gui),
    ).toEqual({
      enabled: false,
      reason: "This host does not advertise browser preview control.",
    });
    expect(
      clusterGuiAvailability(
        snapshot({
          enabled: true,
          features: [CLUSTER_OPERATOR_FEATURE, "preview.control"],
          capabilities: ["sessions.read"],
        }),
        TARGET,
        HOST,
        session.liveState!.cluster!.gui,
      ),
    ).toEqual({
      enabled: false,
      reason: "This host does not permit browser preview reads.",
    });
    expect(
      clusterGuiAvailability(
        snapshot({
          enabled: true,
          features: [CLUSTER_OPERATOR_FEATURE, "preview.control"],
          capabilities: ["sessions.read", "preview.read"],
        }),
        TARGET,
        HOST,
        session.liveState!.cluster!.gui,
      ),
    ).toEqual({
      enabled: false,
      reason: "This host does not permit browser preview control.",
    });
    expect(
      clusterGuiAvailability(
        snapshot({
          enabled: true,
          features: [CLUSTER_OPERATOR_FEATURE, "preview.control"],
          capabilities: ["sessions.read", "preview.read", "preview.control"],
        }),
        TARGET,
        HOST,
        { state: "Failed", reason: "GUI pod did not become ready." },
      ),
    ).toEqual({ enabled: false, reason: "GUI pod did not become ready." });
    expect(
      clusterGuiAvailability(
        snapshot({
          enabled: true,
          features: [CLUSTER_OPERATOR_FEATURE, "preview.control"],
          capabilities: ["sessions.read", "preview.read", "preview.control"],
        }),
        TARGET,
        HOST,
        session.liveState!.cluster!.gui,
      ),
    ).toEqual({ enabled: true });
  });

  it("derives infrastructure, CI, and GUI truth from canonical projections", () => {
    const data = deriveWorkspaceData(snapshot({ enabled: true, workspace, session }));

    expect(data.clusterWorkspaces).toEqual([{ hostId: HOST, targetId: TARGET, infrastructure: workspace }]);
    expect(data.sessions[0]).toMatchObject({
      cluster: session.liveState?.cluster,
      ci: session.liveState?.ci,
    });
    expect(data.sessions[0]?.ci?.currentStage).toBe("verify");
    expect(data.sessions[0]?.cluster?.gui).toEqual({ state: "Ready", previewId: "preview-a" });
  });

  it("host-qualifies colliding workspace ids and renders exact disabled action reasons", () => {
    const denied = snapshot({
      enabled: true,
      capabilities: ["sessions.read", "sessions.manage"],
      workspace,
      session,
    });
    const projected = deriveWorkspaceData(denied).sessions[0]!;
    expect(clusterSessionMatchesWorkspace(projected, session, HOST, workspace.id)).toBe(true);
    expect(
      clusterSessionMatchesWorkspace(
        projected,
        { ...session, hostId: hostId("other-cluster-host") },
        HOST,
        workspace.id,
      ),
    ).toBe(false);

    const markup = renderToStaticMarkup(
      <ClusterOperatorSection
        controller={{ getSnapshot: () => denied } as unknown as DesktopRuntimeController}
        onOpenPreview={() => undefined}
        onOpenSession={() => undefined}
        snapshot={denied}
      />,
    );
    expect(markup).toContain("GUI: This host does not advertise browser preview control.");
    expect(markup).toContain("CI: This host did not grant CI trigger access.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Open GUI<\/button>/u);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Run CI<\/button>/u);
    expect(markup).toContain(
      "Woodpecker correlation is unavailable because this host did not grant CI trigger access.",
    );
    expect(markup).toMatch(/<fieldset[^>]*disabled=""[^>]*>/u);
    expect(markup).toMatch(/<button[^>]*>Create session with GUI<\/button>/u);
    expect(markup).not.toMatch(
      /<button[^>]*\sdisabled=""[^>]*>Create session with GUI<\/button>/u,
    );
    const failedSession: SessionRef = {
      ...session,
      liveState: {
        ...session.liveState!,
        cluster: {
          ...session.liveState!.cluster!,
          gui: { state: "Failed", reason: "GUI pod did not become ready." },
        },
      },
    };
    const failed = snapshot({
      enabled: true,
      features: [CLUSTER_OPERATOR_FEATURE, "preview.control"],
      capabilities: [
        "sessions.read",
        "sessions.manage",
        CI_TRIGGER_CAPABILITY,
        "preview.read",
        "preview.control",
      ],
      workspace,
      session: failedSession,
    });
    const failedMarkup = renderToStaticMarkup(
      <ClusterOperatorSection
        controller={{ getSnapshot: () => failed } as unknown as DesktopRuntimeController}
        onOpenPreview={() => undefined}
        onOpenSession={() => undefined}
        snapshot={failed}
      />,
    );
    expect(failedMarkup.match(/GUI pod did not become ready\./gu)).toHaveLength(2);
  });

  it("projects no cluster truth without local opt-in and sessions.read", () => {
    for (const denied of [
      snapshot({ workspace, session }),
      snapshot({ enabled: true, capabilities: [], workspace, session }),
    ]) {
      const data = deriveWorkspaceData(denied);
      expect(data.clusterWorkspaces).toEqual([]);
      expect(data.sessions[0]).not.toHaveProperty("cluster");
      expect(data.sessions[0]).not.toHaveProperty("ci");
    }
    const defaultOff = snapshot({ workspace, session });
    expect(
      renderToStaticMarkup(
        <ClusterOperatorSection
          controller={{ getSnapshot: () => defaultOff } as unknown as DesktopRuntimeController}
          onOpenPreview={() => undefined}
          onOpenSession={() => undefined}
          snapshot={defaultOff}
        />,
      ),
    ).toBe("");
  });

  it("keeps session creation unchanged when Woodpecker correlation is empty", async () => {
    const command = vi.fn(
      async (..._args: Parameters<DesktopRuntimeController["command"]>) => ({
        accepted: true,
        result: {},
      }),
    );
    const controller = {
      command,
      getSnapshot: () => snapshot({ enabled: true, workspace }),
    } as unknown as DesktopRuntimeController;
    const preparation = prepareClusterSessionCreation(workspace.id, "  Ship release  ", {
      repositoryId: "",
      ref: "",
      commit: "",
    });

    expect(preparation).toEqual({
      args: {
        workspaceId: workspace.id,
        title: "Ship release",
        runtimeProfile: "default",
        guiEnabled: true,
      },
      error: null,
      invalidField: null,
    });
    if (preparation.args === null) throw new Error(preparation.error);
    await createClusterSession(controller, TARGET, HOST, preparation.args);
    expect(command).toHaveBeenCalledWith(TARGET, {
      hostId: HOST,
      command: "session.create",
      args: {
        workspaceId: workspace.id,
        title: "Ship release",
        runtimeProfile: "default",
        guiEnabled: true,
      },
    });

    const markup = renderToStaticMarkup(
      <ClusterOperatorSection
        controller={controller}
        onOpenPreview={() => undefined}
        onOpenSession={() => undefined}
        snapshot={snapshot({ enabled: true, workspace })}
      />,
    );
    expect(markup).toContain("Woodpecker correlation");
    expect(markup).toContain("Repository ID");
    expect(markup).toMatch(/maxlength="128"/iu);
    expect(markup).toMatch(/maxlength="256"/iu);
    expect(markup).toMatch(/maxlength="40"/iu);
  });

  it("transmits an exact valid Woodpecker correlation on session creation", async () => {
    const command = vi.fn(
      async (..._args: Parameters<DesktopRuntimeController["command"]>) => ({
        accepted: true,
        result: {},
      }),
    );
    const controller = {
      command,
      getSnapshot: () => snapshot({ enabled: true, workspace }),
    } as unknown as DesktopRuntimeController;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const preparation = prepareClusterSessionCreation(workspace.id, undefined, {
      repositoryId: "t4-code",
      ref: "refs/heads/agent/t4-cluster-operator",
      commit,
    });

    expect(preparation).toEqual({
      args: {
        workspaceId: workspace.id,
        runtimeProfile: "default",
        guiEnabled: true,
        ci: {
          provider: "woodpecker",
          repositoryId: "t4-code",
          ref: "refs/heads/agent/t4-cluster-operator",
          commit,
        },
      },
      error: null,
      invalidField: null,
    });
    if (preparation.args === null) throw new Error(preparation.error);
    await createClusterSession(controller, TARGET, HOST, preparation.args);
    expect(command).toHaveBeenCalledWith(TARGET, {
      hostId: HOST,
      command: "session.create",
      args: {
        workspaceId: workspace.id,
        runtimeProfile: "default",
        guiEnabled: true,
        ci: {
          provider: "woodpecker",
          repositoryId: "t4-code",
          ref: "refs/heads/agent/t4-cluster-operator",
          commit,
        },
      },
    });
  });

  it("rejects partial, non-exact commit, and wire-bounds failures before submission", async () => {
    const command = vi.fn(
      async (..._args: Parameters<DesktopRuntimeController["command"]>) => ({
        accepted: true,
        result: {},
      }),
    );
    const controller = {
      command,
      getSnapshot: () => snapshot({ enabled: true, workspace }),
    } as unknown as DesktopRuntimeController;
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const attempts = [
      {
        draft: { repositoryId: "t4-code", ref: "refs/heads/main", commit: "" },
        error:
          "Enter repository ID, ref, and commit together, or leave all three Woodpecker correlation fields empty.",
        invalidField: "correlation",
      },
      {
        draft: { repositoryId: "t4-code", ref: "refs/heads/main", commit: commit.slice(1) },
        error: "Woodpecker commit must be exactly 40 lowercase hexadecimal characters.",
        invalidField: "commit",
      },
      {
        draft: { repositoryId: "t4-code", ref: "refs/heads/main", commit: commit.toUpperCase() },
        error: "Woodpecker commit must be exactly 40 lowercase hexadecimal characters.",
        invalidField: "commit",
      },
      {
        draft: { repositoryId: "t4-code", ref: "refs/heads/main", commit: `g${commit.slice(1)}` },
        error: "Woodpecker commit must be exactly 40 lowercase hexadecimal characters.",
        invalidField: "commit",
      },
      {
        draft: { repositoryId: "a".repeat(129), ref: "refs/heads/main", commit },
        error:
          "Woodpecker repository ID must be 1 to 128 UTF-8 bytes, start with a letter or number, and otherwise use only letters, numbers, '.', '_', ':', '/', or '-' without '..' or '://'.",
        invalidField: "repositoryId",
      },
      {
        draft: { repositoryId: "t4-code", ref: "é".repeat(129), commit },
        error: "Woodpecker ref must be 1 to 256 UTF-8 bytes and contain no control characters.",
        invalidField: "ref",
      },
    ] as const;

    for (const attempt of attempts) {
      const preparation = prepareClusterSessionCreation(workspace.id, undefined, attempt.draft);
      expect(preparation).toEqual({
        args: null,
        error: attempt.error,
        invalidField: attempt.invalidField,
      });
      if (preparation.args !== null) {
        await createClusterSession(controller, TARGET, HOST, preparation.args);
      }
    }
    expect(command).not.toHaveBeenCalled();
  });

  it("sends only allowlisted workspace, session, and CI arguments", async () => {
    const command = vi.fn(async (..._args: Parameters<DesktopRuntimeController["command"]>) => ({ accepted: true, result: {} }));
    const controller = { command, getSnapshot: () => snapshot({ enabled: true, workspace, session }) } as unknown as DesktopRuntimeController;

    await createClusterWorkspace(controller, TARGET, HOST, {
      displayName: "Release train",
      retentionPolicy: "Retain",
      capacity: "20Gi",
      repository: { repositoryId: "repo-a", ref: "refs/heads/main", commit: "0123456789abcdef" },
    });
    await createClusterSession(controller, TARGET, HOST, {
      workspaceId: workspace.id,
      title: "Ship release",
      runtimeProfile: "default",
      guiEnabled: true,
      ci: { provider: "woodpecker", repositoryId: "repo-a", ref: "refs/heads/main", commit: "0123456789abcdef" },
    });
    await runClusterCi(controller, TARGET, HOST, "session-a", revision("session-r3"), {
      provider: "woodpecker",
      action: "run",
      repositoryId: "repo-a",
      ref: "refs/heads/main",
      commit: "0123456789abcdef",
    });

    expect(command.mock.calls.map(([targetId, intent]) => ({ targetId, intent }))).toEqual([
      { targetId: TARGET, intent: { hostId: HOST, command: "workspace.create", args: expect.objectContaining({ displayName: "Release train", capacity: "20Gi" }) } },
      { targetId: TARGET, intent: { hostId: HOST, command: "session.create", args: expect.objectContaining({ workspaceId: workspace.id, guiEnabled: true }) } },
      { targetId: TARGET, intent: { hostId: HOST, sessionId: "session-a", command: "ci.run", expectedRevision: "session-r3", args: expect.objectContaining({ provider: "woodpecker", action: "run", repositoryId: "repo-a" }) } },
    ]);
    const serialized = JSON.stringify(command.mock.calls);
    expect(serialized).not.toMatch(/token|secret|kubeconfig|namespace|image|url/iu);
  });
});
