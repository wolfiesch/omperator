// Display shapes for the workspace tree: hosts, projects, and sessions as
// the rail, palette, and session header render them. Both providers build
// this shape — the browser fixture from sample data, the desktop runtime
// from live protocol frames — and nothing below this seam knows which one
// is feeding it. Display data only; never runtime authority.
import type { SessionStatus } from "@t4-code/ui";
import type { RuntimeKind } from "@t4-code/client";
import type {
  SessionCiState,
  SessionClusterState,
  WorkspaceInfrastructureProjection,
} from "@t4-code/protocol";

/** How current the projection of a session is. */
export type SessionFreshness = "live" | "cached" | "offline";
export type SessionListView = "current" | "archived";
/** Runtime-reported lifecycle, kept separate from T4's richer attention/status pills. */
export type SessionLifecycle = "active" | "idle" | "closed" | "unknown";

export interface WorkspaceHost {
  readonly id: string;
  /** Runtime that owns this host. Equal native ids from other runtimes are distinct. */
  readonly runtimeKind: RuntimeKind;
  readonly name: string;
  readonly kind: "local" | "remote";
  /** Native OMP profile id for local hosts. Absent for fixtures and remote hosts. */
  readonly profileId?: string;
  /** True when the host reported only part of its durable session index. */
  readonly sessionInventoryTruncated?: boolean;
}

export interface WorkspaceProject {
  readonly id: string;
  readonly name: string;
  /** Display location: a project name or basename, never a remote absolute path. */
  readonly path: string;
  readonly hostId: string;
}

export interface WorkspaceSession {
  readonly id: string;
  readonly projectId: string;
  /** Durable session title (survives disconnects and restarts). */
  readonly title: string;
  readonly model: string;
  /** Rich live activity/attention status, or null when no pill applies. */
  readonly status: SessionStatus | null;
  /** Raw lifecycle reported by the runtime. Missing fixture data is treated as unknown. */
  readonly lifecycle?: SessionLifecycle;
  readonly freshness: SessionFreshness;
  /** Commands waiting on the user's go-ahead. */
  readonly pendingApprovals: number;
  readonly latestTurnCompletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** One-line summary of where the session left off. */
  readonly lastActivity: string;
  /** Host authority for archive state; absent means current/default. */
  readonly archivedAt?: string;
  /**
   * Ownership display state while this session is not writable here:
   * another app confirmed active (observer), waiting to take over after the
   * other app went quiet (suspect), this app taking over (reconciling), a
   * terminal session with no compatible handoff signal (unverified), or
   * ownership unclear from a malformed/unrecognized control shape (unclear).
   * Only "observer" may say another app is active. Absent when writable,
   * and on cached/offline rows where freshness copy wins. Values mirror
   * SessionControlDisplayKind in session-observer.ts.
   */
  readonly control?: "observer" | "suspect" | "reconciling" | "unverified" | "unclear";
  /** Cluster runtime and GUI truth, present only after local opt-in and host grant. */
  readonly cluster?: SessionClusterState;
  /** Strict CI correlation and progress from the authoritative session projection. */
  readonly ci?: SessionCiState;
}

export interface WorkspaceClusterWorkspace {
  readonly hostId: string;
  readonly targetId: string;
  readonly infrastructure: WorkspaceInfrastructureProjection;
}

export interface WorkspaceData {
  readonly hosts: readonly WorkspaceHost[];
  readonly projects: readonly WorkspaceProject[];
  readonly sessions: readonly WorkspaceSession[];
  readonly clusterWorkspaces?: readonly WorkspaceClusterWorkspace[];
}
