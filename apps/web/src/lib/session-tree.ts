// Derives the project/session tree the rail and palette render: grouping,
// expansion, aggregated status, unread markers, and the visible-session order
// behind Cmd/Ctrl+1..9.
import { resolveHighestPriorityStatus, type SessionStatus } from "@t4-code/ui";

import { isSessionUnread } from "../state/workspace-store.ts";
import type {
  WorkspaceData,
  WorkspaceHost,
  SessionListView,
  WorkspaceProject,
  WorkspaceSession,
} from "./workspace-data.ts";

export interface SessionRow {
  readonly session: WorkspaceSession;
  readonly unread: boolean;
}

export type RailOrganization = "by-project" | "flat";
export type RailSort = "priority" | "updated" | "manual";
export type RailFilter = "all" | "attention" | "running" | "unread" | "errors";

export interface RailViewOptions {
  readonly filter?: RailFilter;
  readonly query?: string;
  readonly sort?: RailSort;
  /** New projects default closed in large inventories; explicit client state always wins. */
  readonly defaultExpanded?: boolean;
  /** Keep the routed session discoverable when its project has no explicit disclosure state. */
  readonly activeSessionId?: string | null;
  readonly projectManualOrder?: readonly string[];
  readonly sessionManualOrderByProjectId?: Readonly<Record<string, readonly string[]>>;
  readonly projectAliasById?: Readonly<Record<string, string>>;
}

export interface ProjectGroup {
  readonly project: WorkspaceProject;
  /** Client-only label; project.name remains the host's real folder name. */
  readonly displayName: string;
  readonly host: WorkspaceHost;
  readonly expanded: boolean;
  readonly sessions: readonly SessionRow[];
  /** Highest-priority status among children; the collapsed-group signal. */
  readonly groupStatus: SessionStatus | null;
  readonly unreadCount: number;
  readonly pendingApprovals: number;
}

function manualRank(order: readonly string[] | undefined, id: string): number {
  const rank = order?.indexOf(id) ?? -1;
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
}

/**
 * T4's visible Priority order is deliberately simple and user-facing:
 * approval, input, running, unread completion, error, plan, then recency.
 */
export function sessionPriority(row: SessionRow): number {
  if (row.session.pendingApprovals > 0 || row.session.status === "pendingApproval") return 6;
  if (row.session.status === "awaitingInput") return 5;
  if (row.session.status === "working") return 4;
  if (row.unread) return 3;
  if (row.session.status === "error") return 2;
  if (row.session.status === "planReady") return 1;
  return 0;
}

function compareUpdated(left: WorkspaceSession, right: WorkspaceSession): number {
  return (
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.id.localeCompare(right.id)
  );
}

function matchesFilter(row: SessionRow, filter: RailFilter): boolean {
  if (filter === "all") return true;
  if (filter === "attention") {
    return row.session.pendingApprovals > 0 || row.session.status === "awaitingInput" || row.unread;
  }
  if (filter === "running") {
    return row.session.status === "working";
  }
  if (filter === "unread") return row.unread;
  return row.session.status === "error";
}

export function sortSessionRows(
  rows: readonly SessionRow[],
  sort: RailSort,
  manualOrder?: readonly string[],
): SessionRow[] {
  return [...rows].sort((left, right) => {
    if (sort === "manual") {
      const manual =
        manualRank(manualOrder, left.session.id) - manualRank(manualOrder, right.session.id);
      if (manual !== 0) return manual;
    }
    if (sort === "priority") {
      const priority = sessionPriority(right) - sessionPriority(left);
      if (priority !== 0) return priority;
    }
    return compareUpdated(left.session, right.session);
  });
}

export function flattenProjectGroups(
  groups: readonly ProjectGroup[],
  sort: RailSort,
  manualOrder?: readonly string[],
): Array<{ readonly group: ProjectGroup; readonly row: SessionRow }> {
  const entries = groups.flatMap((group) => group.sessions.map((row) => ({ group, row })));
  return entries.sort((left, right) => {
    if (sort === "manual") {
      const manual =
        manualRank(manualOrder, left.row.session.id) -
        manualRank(manualOrder, right.row.session.id);
      if (manual !== 0) return manual;
    }
    if (sort === "priority") {
      const priority = sessionPriority(right.row) - sessionPriority(left.row);
      if (priority !== 0) return priority;
    }
    return compareUpdated(left.row.session, right.row.session);
  });
}

export function moveIdInManualOrder(
  storedOrder: readonly string[],
  visibleIds: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const visible = new Set(visibleIds);
  const seen = new Set<string>();
  const complete: string[] = [];
  const hidden: string[] = [];
  for (const entry of storedOrder) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (visible.has(entry)) complete.push(entry);
    else hidden.push(entry);
  }
  for (const visibleId of visibleIds) {
    if (seen.has(visibleId)) continue;
    seen.add(visibleId);
    complete.push(visibleId);
  }
  const index = complete.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= complete.length) return [...complete, ...hidden];
  const next = [...complete];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return [...next, ...hidden];
}

/** Move an item to the position occupied by another visible item. */
export function moveIdToManualIndex(
  storedOrder: readonly string[],
  visibleIds: readonly string[],
  id: string,
  targetId: string,
): string[] {
  const visible = new Set(visibleIds);
  const seen = new Set<string>();
  const complete: string[] = [];
  const hidden: string[] = [];
  for (const entry of storedOrder) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    if (visible.has(entry)) complete.push(entry);
    else hidden.push(entry);
  }
  for (const visibleId of visibleIds) {
    if (seen.has(visibleId)) continue;
    seen.add(visibleId);
    complete.push(visibleId);
  }
  const from = complete.indexOf(id);
  const to = complete.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return [...complete, ...hidden];
  const next = [...complete];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return [...next, ...hidden];
}

export function buildProjectGroups(
  data: WorkspaceData,
  projectExpandedById: Readonly<Record<string, boolean>>,
  lastVisitedAtBySessionId: Readonly<Record<string, string>>,
  view: SessionListView = "current",
  hiddenProjectIds: Readonly<Record<string, true>> = {},
  options: RailViewOptions = {},
): ProjectGroup[] {
  const filter = options.filter ?? "all";
  const query = options.query?.trim().toLowerCase() ?? "";
  const sort = options.sort ?? "updated";
  const filtering = filter !== "all" || query !== "";
  const groups: ProjectGroup[] = [];
  for (const project of data.projects) {
    const host = data.hosts.find((entry) => entry.id === project.hostId);
    if (host === undefined) continue;
    const displayName = options.projectAliasById?.[project.id] ?? project.name;
    const sessions = data.sessions
      .filter(
        (session) =>
          session.projectId === project.id &&
          (view === "archived"
            ? session.archivedAt !== undefined
            : session.archivedAt === undefined),
      )
      .map((session) => ({
        session,
        unread: isSessionUnread(
          lastVisitedAtBySessionId[session.id],
          session.latestTurnCompletedAt,
        ),
      }))
      .filter((row) => {
        if (!matchesFilter(row, filter)) return false;
        if (query === "") return true;
        return `${row.session.title} ${row.session.model} ${displayName} ${project.name} ${host.name}`
          .toLowerCase()
          .includes(query);
      });
    // Current is also the project-management view. Keep known projects
    // reachable after their final current session is archived so the user can
    // immediately create another session in that working folder, unless they
    // explicitly removed that empty shortcut. A new current session always
    // makes the project visible again. Archived is session-only and never
    // applies the Current-tab dismissal.
    if (sessions.length === 0 && (view === "archived" || filtering)) continue;
    if (view === "current" && hiddenProjectIds[project.id] === true) continue;
    groups.push({
      project,
      displayName,
      host,
      expanded:
        projectExpandedById[project.id] ??
        (sessions.some((row) => row.session.id === options.activeSessionId)
          ? true
          : (options.defaultExpanded ?? true)),
      sessions: sortSessionRows(
        sessions,
        sort,
        options.sessionManualOrderByProjectId?.[project.id],
      ),
      groupStatus: resolveHighestPriorityStatus(sessions.map((row) => row.session.status)),
      unreadCount: sessions.filter((row) => row.unread).length,
      pendingApprovals: sessions.reduce((sum, row) => sum + row.session.pendingApprovals, 0),
    });
  }
  return groups.sort((left, right) => {
    if (sort === "manual") {
      const manual =
        manualRank(options.projectManualOrder, left.project.id) -
        manualRank(options.projectManualOrder, right.project.id);
      if (manual !== 0) return manual;
    }
    if (sort === "priority") {
      const priority =
        Math.max(0, ...right.sessions.map(sessionPriority)) -
        Math.max(0, ...left.sessions.map(sessionPriority));
      if (priority !== 0) return priority;
    }
    const leftUpdated = Math.max(
      0,
      ...left.sessions.map((row) => Date.parse(row.session.updatedAt)),
    );
    const rightUpdated = Math.max(
      0,
      ...right.sessions.map((row) => Date.parse(row.session.updatedAt)),
    );
    return (
      rightUpdated - leftUpdated ||
      left.displayName.localeCompare(right.displayName) ||
      left.project.id.localeCompare(right.project.id)
    );
  });
}

/** Sessions reachable by Cmd/Ctrl+1..9: rail order, expanded projects only. */
export function listVisibleSessionIds(groups: readonly ProjectGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    if (!group.expanded) continue;
    for (const row of group.sessions) ids.push(row.session.id);
  }
  return ids;
}

/** Compact relative time for rail rows and the session header. */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const thenMs = Date.parse(iso);
  if (Number.isNaN(thenMs)) return "";
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}
