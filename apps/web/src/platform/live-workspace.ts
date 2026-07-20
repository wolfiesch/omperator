// Live workspace projection: folds a DesktopRuntimeSnapshot into the display
// shapes the rail, palette, and session header render. Pure derivation from
// protocol truth — session refs, host metadata, connection states — with no
// fixture reads and no invented data. Remote absolute paths never surface;
// projects display their advertised name or a basename.
import {
  type DesktopRuntimeSnapshot,
  readSessionAttention,
  type SessionProjection,
} from "@t4-code/client";
import { CLUSTER_OPERATOR_FEATURE } from "@t4-code/protocol";
import type { SessionStatus } from "@t4-code/ui";

import type {
  WorkspaceClusterWorkspace,
  WorkspaceData,
  WorkspaceHost,
  SessionLifecycle,
  WorkspaceProject,
  WorkspaceSession,
} from "../lib/workspace-data.ts";
import { resolveCurrentHostTargetId } from "../lib/host-target.ts";
import { sessionIsWorking } from "../features/session-runtime/session-management.ts";
import {
  readSessionControl,
  sessionControlDisplayKind,
} from "../features/session-runtime/session-observer.ts";
import { hostSessionInventoryIsComplete } from "../features/session-runtime/session-inventory.ts";

/** Composite route id for one live session; unambiguous and URL-safe. */
export function sessionViewId(hostId: string, sessionId: string): string {
  return `${encodeURIComponent(hostId)}/${encodeURIComponent(sessionId)}`;
}

export interface SessionAttentionOutcomeMarker {
  readonly sessionKey: string;
  readonly outcomeId: string;
}

/** Latest durable outcome for the route the user is actually viewing. */
export function sessionAttentionOutcomeMarker(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): SessionAttentionOutcomeMarker | null {
  for (const ref of snapshot.projection.sessionIndex.values()) {
    const hostId = String(ref.hostId);
    const sessionId = String(ref.sessionId);
    if (sessionViewId(hostId, sessionId) !== viewId) continue;
    const attention = readSessionAttention(ref);
    const outcome = attention.status === "valid" ? attention.value.latestOutcome : undefined;
    return outcome === undefined
      ? null
      : { sessionKey: `${hostId}\u0000${sessionId}`, outcomeId: outcome.id };
  }
  return null;
}

export interface LiveSessionAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
}

/** Resolve a session view id back to its target/host/session triple. */
export function resolveLiveSession(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): LiveSessionAddress | null {
  const separator = viewId.indexOf("/");
  if (separator <= 0) return null;
  const hostId = decodeURIComponent(viewId.slice(0, separator));
  const sessionId = decodeURIComponent(viewId.slice(separator + 1));
  const targetId = resolveCurrentHostTargetId(snapshot, hostId);
  return targetId === null ? null : { targetId, hostId, sessionId };
}

/** Composite route id for one live project. */
export interface LiveProjectAddress {
  readonly targetId: string;
  readonly hostId: string;
  readonly projectId: string;
}

export interface LiveProjectCreateTarget {
  readonly address: LiveProjectAddress;
  readonly label: string;
  readonly profileId?: string;
  readonly current: boolean;
}

/** Never make a cross-profile account/model-routing choice silently. */
export function requiresProfileChoiceForCreate(
  targets: readonly LiveProjectCreateTarget[],
): boolean {
  return targets.length > 1 || (targets.length === 1 && targets[0]?.current === false);
}

/** Resolve a project view id, rejecting malformed ids and unbound hosts. */
export function resolveLiveProject(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): LiveProjectAddress | null {
  const separator = viewId.indexOf("/");
  if (separator <= 0 || separator !== viewId.lastIndexOf("/") || separator === viewId.length - 1) {
    return null;
  }
  try {
    const hostId = decodeURIComponent(viewId.slice(0, separator));
    const projectId = decodeURIComponent(viewId.slice(separator + 1));
    if (hostId === "" || projectId === "") return null;
    const targetId = resolveCurrentHostTargetId(snapshot, hostId);
    if (targetId !== null) return { targetId, hostId, projectId };
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve every connected local OMP profile that can address the same stable
 * project id. Named profile appservers share only this opaque id; the renderer
 * never receives or forwards an absolute cwd. Remote hosts stay pinned to their
 * original target because equal project ids do not imply equal filesystems.
 */
export function resolveLiveProjectCreateTargets(
  snapshot: DesktopRuntimeSnapshot,
  viewId: string,
): readonly LiveProjectCreateTarget[] {
  const source = resolveLiveProject(snapshot, viewId);
  if (source === null) return [];
  const sourceTarget = snapshot.targets.get(source.targetId);
  if (sourceTarget?.kind !== "local") {
    return [{ address: source, label: sourceTarget?.label ?? "This host", current: true }];
  }
  const candidates: LiveProjectCreateTarget[] = [];
  for (const target of snapshot.targets.values()) {
    if (target.kind !== "local" || snapshot.connections.get(target.targetId) !== "connected")
      continue;
    const hostId = snapshot.targetHosts.get(target.targetId);
    if (hostId === undefined) continue;
    candidates.push({
      address: { targetId: target.targetId, hostId, projectId: source.projectId },
      label: target.label,
      profileId:
        target.targetId === "local"
          ? "default"
          : target.targetId.startsWith("local:")
            ? target.targetId.slice("local:".length)
            : target.targetId,
      current: target.targetId === source.targetId,
    });
  }
  candidates.sort((left, right) => {
    if (left.current !== right.current) return left.current ? -1 : 1;
    return (
      left.label.localeCompare(right.label) ||
      left.address.targetId.localeCompare(right.address.targetId)
    );
  });
  return candidates;
}
/** Warm per-session projection for a view id, when the runtime holds one. */
export function warmSessionProjection(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
  sessionId: string,
): SessionProjection | undefined {
  return snapshot.projection.sessions.get(`${hostId}\u0000${sessionId}`);
}

/** Display name for a project: advertised name, else the id's basename. */
function projectDisplayName(project: {
  readonly projectId: string;
  readonly name?: string;
}): string {
  if (project.name !== undefined && project.name !== "") return project.name;
  const id = String(project.projectId);
  const segments = id.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.at(-1) ?? id;
}

function hostConnection(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): { readonly targetId: string | null; readonly state: string | null } {
  const targetId = resolveCurrentHostTargetId(snapshot, hostId);
  return targetId === null
    ? { targetId: null, state: null }
    : { targetId, state: snapshot.connections.get(targetId) ?? null };
}
function clusterHostTarget(
  snapshot: DesktopRuntimeSnapshot,
  hostId: string,
): string | null {
  if (snapshot.clusterOperatorEnabled !== true) return null;
  const host = snapshot.hosts.get(hostId);
  if (
    host === undefined ||
    !host.grantedFeatures.includes(CLUSTER_OPERATOR_FEATURE) ||
    !host.grantedCapabilities.includes("sessions.read")
  ) {
    return null;
  }
  return resolveCurrentHostTargetId(snapshot, hostId);
}

const derived = new WeakMap<DesktopRuntimeSnapshot, WorkspaceData>();

const EMPTY_WORKSPACE: WorkspaceData = Object.freeze({
  hosts: Object.freeze([]),
  projects: Object.freeze([]),
  sessions: Object.freeze([]),
  clusterWorkspaces: Object.freeze([]),
});

/**
 * Derive the display workspace from a runtime snapshot. Referentially
 * stable per snapshot so memoized consumers skip unchanged derivations.
 */
export function deriveWorkspaceData(snapshot: DesktopRuntimeSnapshot): WorkspaceData {
  const cached = derived.get(snapshot);
  if (cached !== undefined) return cached;

  const indexedSessionCountByHost = new Map<string, number>();
  for (const ref of snapshot.projection.sessionIndex.values()) {
    const hostId = String(ref.hostId);
    indexedSessionCountByHost.set(hostId, (indexedSessionCountByHost.get(hostId) ?? 0) + 1);
  }

  const hosts: WorkspaceHost[] = [];
  const hostIds = new Set(snapshot.hosts.keys());
  for (const ref of snapshot.projection.sessionIndex.values()) {
    hostIds.add(String(ref.hostId));
  }
  if (snapshot.clusterOperatorEnabled === true) {
    for (const key of snapshot.projection.workspaces.keys()) {
      const separator = key.indexOf("\u0000");
      if (separator > 0) hostIds.add(key.slice(0, separator));
    }
  }
  for (const hostId of hostIds) {
    const meta = snapshot.hosts.get(hostId);
    if (meta === undefined) {
      // Projection caches retain stable host ids but intentionally do not
      // persist target bindings or welcome capabilities. This display-only
      // placeholder keeps cached rows grouped without inventing authority;
      // the first live welcome replaces it with authenticated metadata.
      hosts.push({
        id: hostId,
        runtimeKind: snapshot.integration.kind,
        name: hostId,
        kind: "remote",
        sessionInventoryTruncated: true,
      });
      continue;
    }
    const target = snapshot.targets.get(meta.targetId);
    const inventoryMetadata = snapshot.projection.sessionIndexMetadata.get(hostId);
    hosts.push({
      id: hostId,
      runtimeKind: snapshot.integration.kind,
      name: target?.label ?? "This machine",
      kind: target?.kind ?? "local",
      ...(target?.kind === "local"
        ? {
            profileId:
              target.targetId === "local"
                ? "default"
                : target.targetId.startsWith("local:")
                  ? target.targetId.slice("local:".length)
                  : "default",
          }
        : {}),
      sessionInventoryTruncated:
        inventoryMetadata === undefined ||
        inventoryMetadata.truncated ||
        (indexedSessionCountByHost.get(hostId) ?? 0) < inventoryMetadata.totalCount,
    });
  }

  const clusterWorkspaces: WorkspaceClusterWorkspace[] = [];
  if (snapshot.clusterOperatorEnabled === true) {
    for (const [key, infrastructure] of snapshot.projection.workspaces) {
      const separator = key.indexOf("\u0000");
      if (separator <= 0) continue;
      const hostId = key.slice(0, separator);
      const targetId = clusterHostTarget(snapshot, hostId);
      if (targetId !== null) clusterWorkspaces.push({ hostId, targetId, infrastructure });
    }
  }

  const projects = new Map<string, WorkspaceProject>();
  const projectsWithAdvertisedNames = new Set<string>();
  const sessions: WorkspaceSession[] = [];
  const refs = [...snapshot.projection.sessionIndex.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  for (const ref of refs) {
    const hostId = String(ref.hostId);
    const sessionId = String(ref.sessionId);
    const projectId = `${encodeURIComponent(hostId)}/${encodeURIComponent(String(ref.project.projectId))}`;
    const advertisedProjectName =
      ref.project.name !== undefined && ref.project.name !== "" ? ref.project.name : null;
    if (!projects.has(projectId)) {
      const name = projectDisplayName(ref.project);
      projects.set(projectId, { id: projectId, name, path: name, hostId });
      if (advertisedProjectName !== null) projectsWithAdvertisedNames.add(projectId);
    } else if (advertisedProjectName !== null && !projectsWithAdvertisedNames.has(projectId)) {
      // A just-created session may omit the optional project name while
      // older refs for the same project still advertise it. Refs are sorted
      // newest-first, so upgrade the id fallback with the first real name and
      // keep that newest advertised value stable for the rest of the fold.
      projects.set(projectId, {
        id: projectId,
        name: advertisedProjectName,
        path: advertisedProjectName,
        hostId,
      });
      projectsWithAdvertisedNames.add(projectId);
    }
    const connection = hostConnection(snapshot, hostId);
    const warm = warmSessionProjection(snapshot, hostId, sessionId);
    const offline = connection.state !== "connected";
    const inventoryReady = hostSessionInventoryIsComplete(snapshot, hostId);
    const freshness = offline
      ? "offline"
      : !inventoryReady || (warm !== undefined && warm.freshness !== "fresh")
        ? "cached"
        : "live";
    const pendingApprovals = warm?.confirmations.size ?? (ref.pendingApproval === true ? 1 : 0);
    const rawArchivedAt = (ref as unknown as { readonly archivedAt?: unknown }).archivedAt;
    const archivedAt =
      typeof rawArchivedAt === "string" && Number.isFinite(Date.parse(rawArchivedAt))
        ? rawArchivedAt
        : null;
    // Ref activity is current only with a fresh connected projection. Cached
    // and offline rows must surface freshness instead of a stale Working pill.
    // Last-known activity still prevents inventing a completion timestamp:
    // losing freshness is not evidence that the turn completed.
    const lastKnownWorking = sessionIsWorking(ref);
    const displayWorking = freshness === "live" && lastKnownWorking;
    // Ownership display: while another app provably runs this session, the
    // rail says "Active elsewhere" instead of a status pill that implies this
    // app's turn. A quiet, malformed, or unrecognized control shape is still
    // read-only, but only a confirmed live lock may claim another app.
    const control = freshness === "live" ? readSessionControl(ref) : null;
    const controlKind = control === null ? undefined : sessionControlDisplayKind(control);
    let lifecycle: SessionLifecycle = "unknown";
    if (ref.status === "active") lifecycle = "active";
    else if (ref.status === "idle") lifecycle = "idle";
    else if (ref.status === "closed") lifecycle = "closed";
    let status: SessionStatus | null = null;
    if (connection.state === "connecting") status = "connecting";
    else if (freshness === "live" && controlKind === undefined) {
      if (pendingApprovals > 0) status = "pendingApproval";
      else if (ref.pendingUserInput === true) status = "awaitingInput";
      else if (ref.proposedPlan !== undefined && ref.proposedPlan !== "") status = "planReady";
      else if (displayWorking) status = "working";
    }
    sessions.push({
      id: sessionViewId(hostId, sessionId),
      projectId,
      title: ref.title,
      model: ref.model ?? "",
      status,
      lifecycle,
      freshness,
      pendingApprovals,
      latestTurnCompletedAt: lastKnownWorking ? null : ref.updatedAt,
      createdAt: ref.updatedAt,
      updatedAt: ref.updatedAt,
      lastActivity: "",
      ...(archivedAt === null ? {} : { archivedAt }),
      ...(controlKind === undefined ? {} : { control: controlKind }),
      ...(clusterHostTarget(snapshot, hostId) === null || ref.liveState?.cluster === undefined
        ? {}
        : { cluster: ref.liveState.cluster }),
      ...(clusterHostTarget(snapshot, hostId) === null || ref.liveState?.ci === undefined
        ? {}
        : { ci: ref.liveState.ci }),
    });
  }

  const data: WorkspaceData =
    sessions.length === 0 && hosts.length === 0 && clusterWorkspaces.length === 0
      ? EMPTY_WORKSPACE
      : Object.freeze({
          hosts: Object.freeze(hosts),
          projects: Object.freeze([...projects.values()]),
          sessions: Object.freeze(sessions),
          clusterWorkspaces: Object.freeze(clusterWorkspaces),
        });
  derived.set(snapshot, data);
  return data;
}

/** The most recently updated live session, for first-frame auto-open. */
export function latestSessionViewId(snapshot: DesktopRuntimeSnapshot): string | null {
  let latest: { viewId: string; updatedAt: string } | null = null;
  for (const ref of snapshot.projection.sessionIndex.values()) {
    if (latest === null || ref.updatedAt.localeCompare(latest.updatedAt) > 0) {
      latest = {
        viewId: sessionViewId(String(ref.hostId), String(ref.sessionId)),
        updatedAt: ref.updatedAt,
      };
    }
  }
  return latest?.viewId ?? null;
}
