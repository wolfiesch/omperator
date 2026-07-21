import type { DesktopRuntimeController, DesktopRuntimeSnapshot } from "@t4-code/client";
import {
  CI_TRIGGER_CAPABILITY,
  CLUSTER_OPERATOR_FEATURE,
  hostId,
  sessionId,
  type CiRunArguments,
  type ClusterSessionCreateArguments,
  type ClusterWorkspaceCreateArguments,
  type Revision,
  type SessionCiState,
  type SessionClusterState,
} from "@t4-code/protocol";

import { resolveCurrentHostTargetId } from "../../lib/host-target.ts";
import { previewHostSupport } from "../preview/preview-model.ts";

export type ClusterOperation = "read" | "manage" | "ci";

export interface ClusterOperatorAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface ClusterCreationTarget {
  readonly targetId: string;
  readonly hostId: string;
  readonly label: string;
}

export function clusterCreationTargets(
  snapshot: DesktopRuntimeSnapshot,
): readonly ClusterCreationTarget[] {
  if (snapshot.clusterOperatorEnabled !== true) return [];
  const targets: ClusterCreationTarget[] = [];
  for (const [hostIdValue, host] of snapshot.hosts) {
    if (!host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE)) continue;
    const targetId = resolveCurrentHostTargetId(snapshot, hostIdValue);
    if (targetId === null) continue;
    targets.push({
      targetId,
      hostId: hostIdValue,
      label: snapshot.targets.get(targetId)?.label ?? hostIdValue,
    });
  }
  targets.sort(
    (left, right) =>
      left.label.localeCompare(right.label) || left.hostId.localeCompare(right.hostId),
  );
  return targets;
}

export function clusterOperatorAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostIdValue: string,
  operation: ClusterOperation,
  expectedRevision?: Revision,
): ClusterOperatorAvailability {
  if (snapshot.clusterOperatorEnabled !== true) {
    return { enabled: false, reason: "Cluster operator is disabled in this app." };
  }
  if (snapshot.targetHosts.get(targetId) !== hostIdValue) {
    return {
      enabled: false,
      reason: "This cluster host is no longer bound to the selected target.",
    };
  }
  if (snapshot.connections.get(targetId) !== "connected") {
    return { enabled: false, reason: "Reconnect this host to inspect cluster workspaces." };
  }
  const host = snapshot.hosts.get(hostIdValue);
  if (host === undefined || !host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE)) {
    return { enabled: false, reason: "This host does not advertise cluster operator support." };
  }
  if (!host.grantedCapabilities.includes("sessions.read")) {
    return { enabled: false, reason: "This host did not grant session read access." };
  }
  if (operation === "manage" && !host.grantedCapabilities.includes("sessions.manage")) {
    return {
      enabled: false,
      reason: "This host did not grant workspace and session management.",
    };
  }
  if (operation === "ci" && !host.grantedCapabilities.includes(CI_TRIGGER_CAPABILITY)) {
    return { enabled: false, reason: "This host did not grant CI trigger access." };
  }
  if (operation === "ci" && expectedRevision === undefined) {
    return { enabled: false, reason: "Waiting for the latest session revision." };
  }
  return { enabled: true };
}

export function clusterCiAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostIdValue: string,
  expectedRevision: Revision | undefined,
  ci: SessionCiState | undefined,
): ClusterOperatorAvailability {
  const availability = clusterOperatorAvailability(
    snapshot,
    targetId,
    hostIdValue,
    "ci",
    expectedRevision,
  );
  if (!availability.enabled) return availability;
  if (ci === undefined) {
    return { enabled: false, reason: "CI status is unavailable for this session." };
  }
  if (ci.correlation !== "exact") {
    return {
      enabled: false,
      reason: "CI correlation is unknown; a run cannot be triggered.",
    };
  }
  return { enabled: true };
}

export function clusterGuiAvailability(
  snapshot: DesktopRuntimeSnapshot,
  targetId: string,
  hostIdValue: string,
  gui: SessionClusterState["gui"] | undefined,
): ClusterOperatorAvailability {
  const availability = clusterOperatorAvailability(
    snapshot,
    targetId,
    hostIdValue,
    "read",
  );
  if (!availability.enabled) return availability;
  const support = previewHostSupport(snapshot.hosts.get(hostIdValue));
  if (!support.supported) {
    return {
      enabled: false,
      reason: support.reason ?? "This host does not permit browser preview reads.",
    };
  }
  if (!support.controlSupported) {
    return {
      enabled: false,
      reason: "This host does not permit browser preview control.",
    };
  }
  if (gui === undefined) {
    return { enabled: false, reason: "GUI status is unavailable for this session." };
  }
  if (gui.state !== "Ready") {
    return {
      enabled: false,
      reason:
        gui.reason === undefined || gui.reason === ""
          ? `GUI is ${gui.state.toLocaleLowerCase()}.`
          : gui.reason,
    };
  }
  if (gui.previewId === undefined) {
    return { enabled: false, reason: "Waiting for the negotiated GUI preview." };
  }
  return { enabled: true };
}

function requireAvailability(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  operation: ClusterOperation,
  expectedRevision?: Revision,
): void {
  const availability = clusterOperatorAvailability(
    controller.getSnapshot(),
    targetId,
    hostIdValue,
    operation,
    expectedRevision,
  );
  if (!availability.enabled) throw new Error(availability.reason);
}

export async function createClusterWorkspace(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  args: ClusterWorkspaceCreateArguments,
) {
  requireAvailability(controller, targetId, hostIdValue, "manage");
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    command: "workspace.create",
    args: { ...args },
  });
  if (!result.accepted) throw new Error("Cluster workspace creation was rejected.");
  return result;
}

export async function createClusterSession(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  args: ClusterSessionCreateArguments,
) {
  requireAvailability(controller, targetId, hostIdValue, "manage");
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    command: "session.create",
    args: { ...args },
  });
  if (!result.accepted) throw new Error("Cluster session creation was rejected.");
  return result;
}

export async function runClusterCi(
  controller: DesktopRuntimeController,
  targetId: string,
  hostIdValue: string,
  sessionIdValue: string,
  expectedRevision: Revision,
  args: CiRunArguments,
) {
  requireAvailability(controller, targetId, hostIdValue, "ci", expectedRevision);
  const result = await controller.command(targetId, {
    hostId: hostId(hostIdValue),
    sessionId: sessionId(sessionIdValue),
    command: "ci.run",
    expectedRevision,
    args: { ...args },
  });
  if (!result.accepted) throw new Error("CI run was rejected.");
  return result;
}
