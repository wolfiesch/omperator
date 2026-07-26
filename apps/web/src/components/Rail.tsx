// Project/session rail: grouped rows with explicit state, unread and
// pending-approval markers, keyboard roving, and a collapsed icon strip.
// Row/grouping interaction follows T3's sidebar; rendering is token-native.
import { Badge, cn } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import {
  Folder,
  Inbox,
  LayoutList,
  ListFilter,
  Pin,
  Search,
  X,
} from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { SessionListView, WorkspaceSession } from "../lib/workspace-data.ts";
import {
  flattenProjectGroups,
  moveIdInManualOrder,
  moveIdToManualIndex,
  type ProjectGroup,
  type RailFilter,
} from "../lib/session-tree.ts";
import { presentSessionState } from "../features/session-runtime/session-state.ts";
import { useWorkspaceRuntimeSnapshot } from "../state/shell-data.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { SessionListTabs } from "./SessionListTabs.tsx";

import { ProjectHeaderRow } from "./rail/ProjectHeaderRow.tsx";
import { RailOptionsMenu } from "./rail/RailOptionsMenu.tsx";
import { SessionRowItem } from "./rail/SessionRowItem.tsx";

export function describeSessionState(session: WorkspaceSession): string {
  return presentSessionState(session).label;
}

/** Roving focus among session rows: arrows move, Home/End jump. */
function handleRailKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-session-row]")];
  if (rows.length === 0) return;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = rows.length - 1;
  else if (event.key === "ArrowDown")
    next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1);
  else next = current <= 0 ? 0 : current - 1;
  rows[next]?.focus();
  event.preventDefault();
}

const RAIL_FILTERS: ReadonlyArray<{ readonly value: RailFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "attention", label: "Attention" },
  { value: "running", label: "Running" },
  { value: "unread", label: "Unread" },
  { value: "errors", label: "Errors" },
];

export function Rail({
  allGroups,
  groups,
  hiddenProjectIds,
  nowMs,
  pinnedSessionGroups,
  view,
  currentCount,
  archivedCount,
  attentionCount,
}: {
  allGroups: readonly ProjectGroup[];
  groups: readonly ProjectGroup[];
  hiddenProjectIds: ReadonlySet<string>;
  nowMs: number;
  pinnedSessionGroups: readonly ProjectGroup[];
  view: SessionListView;
  currentCount: number;
  archivedCount: number;
  attentionCount: number;
}) {
  const navigate = useNavigate();
  const runtimeSnapshot = useWorkspaceRuntimeSnapshot();
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const organization = useWorkspace((state) => state.railOrganization);
  const sort = useWorkspace((state) => state.railSort);
  const query = useWorkspace((state) => state.railQuery);
  const filter = useWorkspace((state) => state.railFilter);
  const pinnedProjectIds = useWorkspace((state) => state.pinnedProjectIds);
  const pinnedSessionIds = useWorkspace((state) => state.pinnedSessionIds);
  const projectManualOrder = useWorkspace((state) => state.projectManualOrder);
  const sessionManualOrderByProjectId = useWorkspace(
    (state) => state.sessionManualOrderByProjectId,
  );
  const [announcement, setAnnouncement] = useState("");
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
  const [flatLimit, setFlatLimit] = useState(40);
  const navRef = useRef<HTMLElement | null>(null);
  const flatEntries = useMemo(
    () => flattenProjectGroups(groups, sort, sessionManualOrderByProjectId["*"]),
    [groups, sessionManualOrderByProjectId, sort],
  );
  const pinnedSourceEntries = useMemo(
    () => flattenProjectGroups(pinnedSessionGroups, sort, sessionManualOrderByProjectId["*"]),
    [pinnedSessionGroups, sessionManualOrderByProjectId, sort],
  );
  const pinnedEntries = useMemo(() => {
    const seen = new Set<string>();
    return pinnedSourceEntries.filter(({ row }) => {
      if (pinnedSessionIds[row.session.id] !== true || seen.has(row.session.id)) return false;
      seen.add(row.session.id);
      return true;
    });
  }, [pinnedSessionIds, pinnedSourceEntries]);
  const pinnedGroups = useMemo(
    () =>
      allGroups.filter(
        (group) =>
          pinnedProjectIds[group.project.id] === true && !hiddenProjectIds.has(group.project.id),
      ),
    [allGroups, hiddenProjectIds, pinnedProjectIds],
  );
  const actionSessionsByProjectId = useMemo(
    () => new Map(allGroups.map((group) => [group.project.id, group.sessions] as const)),
    [allGroups],
  );
  const matchCount = flatEntries.length;
  const matchCountTruncated = allGroups.some(
    (group) => group.host.sessionInventoryTruncated === true,
  );

  const moveProject = (projectId: string, direction: -1 | 1) => {
    const visibleIds = groups.map((group) => group.project.id);
    workspaceStore
      .getState()
      .setProjectManualOrder(
        moveIdInManualOrder(projectManualOrder, visibleIds, projectId, direction),
      );
  };

  const moveSession = (
    projectId: string,
    visibleIds: readonly string[],
    sessionId: string,
    direction: -1 | 1,
  ) => {
    workspaceStore
      .getState()
      .setSessionManualOrder(
        projectId,
        moveIdInManualOrder(
          sessionManualOrderByProjectId[projectId] ?? [],
          visibleIds,
          sessionId,
          direction,
        ),
      );
  };

  const dropProject = (sourceId: string, targetId: string) => {
    const visibleIds = groups.map((group) => group.project.id);
    workspaceStore
      .getState()
      .setProjectManualOrder(
        moveIdToManualIndex(projectManualOrder, visibleIds, sourceId, targetId),
      );
  };

  const dropSession = (
    projectId: string,
    visibleIds: readonly string[],
    sourceId: string,
    targetId: string,
  ) => {
    workspaceStore
      .getState()
      .setSessionManualOrder(
        projectId,
        moveIdToManualIndex(
          sessionManualOrderByProjectId[projectId] ?? [],
          visibleIds,
          sourceId,
          targetId,
        ),
      );
  };

  const dismissProject = (group: ProjectGroup) => {
    const disclosures = [
      ...(navRef.current?.querySelectorAll<HTMLElement>("[data-project-disclosure]") ?? []),
    ];
    const currentIndex = disclosures.findIndex(
      (element) => element.dataset.projectDisclosure === group.project.id,
    );
    const focusTarget =
      disclosures[currentIndex + 1] ?? disclosures[currentIndex - 1] ?? navRef.current;
    workspaceStore.getState().setProjectHidden(group.project.id, true);
    setAnnouncement(
      `Removed ${group.displayName} from Projects. The folder and OMP sessions are unchanged.`,
    );
    requestAnimationFrame(() => {
      const target = focusTarget?.isConnected ? focusTarget : navRef.current;
      target?.focus();
    });
  };

  let rowIndex = 0;
  return (
    <nav
      aria-label="Working folders and sessions"
      className="flex h-full min-h-0 flex-col overflow-y-auto px-1.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onKeyDown={handleRailKeyDown}
      ref={navRef}
      tabIndex={-1}
    >
      <div className="px-1.5 pb-1.5">
        <div className="flex h-8 items-center gap-1">
          <h2 className="font-medium text-foreground text-xs">Sessions</h2>
          <span
            className="ml-auto text-[10px] text-muted-foreground"
            title={
              matchCountTruncated
                ? "The host has more sessions than this bounded view currently shows."
                : undefined
            }
          >
            {matchCount}
            {matchCountTruncated ? "+" : ""} matches
          </span>
          <RailOptionsMenu
            hiddenGroups={allGroups.filter((group) => hiddenProjectIds.has(group.project.id))}
            organization={organization}
            sort={sort}
          />
        </div>
        <label className="mb-1.5 flex h-8 items-center gap-2 rounded-md border border-border/80 bg-background/45 px-2 focus-within:ring-2 focus-within:ring-ring">
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="sr-only">Filter sessions</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => workspaceStore.getState().setRailQuery(event.target.value)}
            placeholder="Filter sessions"
            type="search"
            value={query}
          />
          {query !== "" && (
            <button
              aria-label="Clear session filter"
              className="flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
              onClick={() => workspaceStore.getState().setRailQuery("")}
              type="button"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          )}
        </label>
        <div className="mb-1.5 grid grid-cols-3 gap-1" aria-label="Session filters">
          {RAIL_FILTERS.map((item) => (
            <button
              aria-pressed={filter === item.value}
              className={cn(
                "h-7 shrink-0 cursor-pointer rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === item.value
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              key={item.value}
              onClick={() => workspaceStore.getState().setRailFilter(item.value)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          aria-label="Open attention inbox"
          className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
          onClick={() => {
            workspaceStore.getState().setRailOverlayOpen(false);
            void navigate({ to: "/inbox" });
          }}
          type="button"
        >
          <Inbox aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm">Attention</span>
          {attentionCount > 0 && (
            <Badge aria-label={`${attentionCount} items need attention`} variant="secondary">
              {attentionCount}
            </Badge>
          )}
        </button>
        <SessionListTabs archivedCount={archivedCount} currentCount={currentCount} view={view} />
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {(view === "current" ? currentCount === 0 : archivedCount === 0) && (
        <p className="px-2 py-5 text-center text-muted-foreground text-sm">
          {view === "archived" ? "No archived sessions." : "No current sessions."}
        </p>
      )}
      {matchCount === 0 && (view === "current" ? currentCount > 0 : archivedCount > 0) && (
        <div className="mx-1.5 my-3 rounded-lg border border-dashed border-border px-3 py-4 text-center">
          <ListFilter aria-hidden="true" className="mx-auto mb-2 size-4 text-muted-foreground" />
          <p className="text-sm">No sessions match these filters.</p>
          <button
            className="mt-2 cursor-pointer text-brand text-xs hover:underline"
            onClick={() => {
              workspaceStore.getState().setRailQuery("");
              workspaceStore.getState().setRailFilter("all");
            }}
            type="button"
          >
            Clear filters
          </button>
        </div>
      )}
      {(pinnedEntries.length > 0 || pinnedGroups.length > 0) && (
        <section aria-label="Pinned sessions" className="mb-2 border-border/60 border-b pb-1.5">
          <div className="flex h-7 items-center gap-1 px-1.5 text-muted-foreground">
            <Pin aria-hidden="true" className="size-3" />
            <h3 className="font-medium text-[11px] uppercase tracking-wide">Pinned</h3>
          </div>
          <div className="flex flex-col gap-px">
            {pinnedGroups.map((group) => (
              <button
                className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                key={`pinned-project:${group.project.id}`}
                onClick={() => {
                  const state = workspaceStore.getState();
                  state.setSessionListView("current");
                  state.setRailOrganization("by-project");
                  state.setRailQuery("");
                  state.setRailFilter("all");
                  state.setProjectExpanded(group.project.id, true);
                  requestAnimationFrame(() => {
                    const project = Array.from(
                      navRef.current?.querySelectorAll<HTMLElement>("[data-project-id]") ?? [],
                    ).find((element) => element.dataset.projectId === group.project.id);
                    project?.scrollIntoView({ block: "nearest" });
                  });
                }}
                type="button"
              >
                <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{group.displayName}</span>
                <span className="text-muted-foreground text-xs">{group.sessions.length}</span>
              </button>
            ))}
            {pinnedEntries.slice(0, 8).map(({ group, row }) => (
              <SessionRowItem
                active={row.session.id === activeSessionId}
                contextLabel={group.displayName}
                index={rowIndex++}
                key={`pinned:${row.session.id}`}
                nowMs={nowMs}
                onAnnounce={setAnnouncement}
                row={row}
                runtimeSnapshot={runtimeSnapshot}
              />
            ))}
          </div>
        </section>
      )}
      {organization === "flat" ? (
        <section aria-label="All sessions" className="mb-1">
          <div className="flex h-7 items-center gap-1 px-1.5 text-muted-foreground">
            <LayoutList aria-hidden="true" className="size-3" />
            <h3 className="font-medium text-[11px] uppercase tracking-wide">All sessions</h3>
          </div>
          <div className="flex flex-col gap-px">
            {flatEntries.slice(0, flatLimit).map(({ group, row }, index) => (
              <SessionRowItem
                active={row.session.id === activeSessionId}
                canMoveDown={index < flatEntries.length - 1}
                canMoveUp={index > 0}
                contextLabel={group.displayName}
                index={rowIndex++}
                key={row.session.id}
                manual={sort === "manual"}
                nowMs={nowMs}
                onAnnounce={setAnnouncement}
                onMove={(direction) =>
                  moveSession(
                    "*",
                    flatEntries.map((entry) => entry.row.session.id),
                    row.session.id,
                    direction,
                  )
                }
                onDrop={(sourceId) =>
                  dropSession(
                    "*",
                    flatEntries.map((entry) => entry.row.session.id),
                    sourceId,
                    row.session.id,
                  )
                }
                row={row}
                runtimeSnapshot={runtimeSnapshot}
              />
            ))}
          </div>
          {flatEntries.length > flatLimit && (
            <button
              className="mt-1 h-8 w-full cursor-pointer rounded-md text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
              onClick={() => setFlatLimit((limit) => limit + 40)}
              type="button"
            >
              Show {Math.min(40, flatEntries.length - flatLimit)} more
            </button>
          )}
        </section>
      ) : (
        groups.map((group, groupIndex) => {
          const limit = projectLimits[group.project.id] ?? 5;
          const visibleRows = group.sessions.slice(0, limit);
          const sessionIds = group.sessions.map((row) => row.session.id);
          return (
            <section
              aria-label={group.displayName}
              className="mb-1"
              data-project-id={group.project.id}
              key={group.project.id}
            >
              <ProjectHeaderRow
                actionSessions={actionSessionsByProjectId.get(group.project.id) ?? group.sessions}
                allowCreate={view === "current"}
                canMoveDown={groupIndex < groups.length - 1}
                canMoveUp={groupIndex > 0}
                group={group}
                manual={sort === "manual"}
                onDismiss={() => dismissProject(group)}
                onMove={(direction) => moveProject(group.project.id, direction)}
                onDrop={(sourceId) => dropProject(sourceId, group.project.id)}
                onAnnounce={setAnnouncement}
                onPin={() => {
                  const pinned = pinnedProjectIds[group.project.id] === true;
                  workspaceStore.getState().setProjectPinned(group.project.id, !pinned);
                  setAnnouncement(`${group.displayName} ${pinned ? "unpinned" : "pinned"}.`);
                }}
                onRestore={() => {
                  workspaceStore.getState().setProjectHidden(group.project.id, false);
                  setAnnouncement(
                    `Restored ${group.displayName} to Projects on this Omperator client.`,
                  );
                }}
                pinned={pinnedProjectIds[group.project.id] === true}
                runtimeSnapshot={runtimeSnapshot}
                shortcutHidden={hiddenProjectIds.has(group.project.id)}
                view={view}
              />
              {group.expanded && (
                <div className="mt-0.5 flex flex-col gap-px">
                  {visibleRows.map((row, index) => (
                    <SessionRowItem
                      active={row.session.id === activeSessionId}
                      canMoveDown={index < group.sessions.length - 1}
                      canMoveUp={index > 0}
                      index={rowIndex++}
                      key={row.session.id}
                      manual={sort === "manual"}
                      nowMs={nowMs}
                      onAnnounce={setAnnouncement}
                      onMove={(direction) =>
                        moveSession(group.project.id, sessionIds, row.session.id, direction)
                      }
                      onDrop={(sourceId) =>
                        dropSession(group.project.id, sessionIds, sourceId, row.session.id)
                      }
                      row={row}
                      runtimeSnapshot={runtimeSnapshot}
                    />
                  ))}
                  {group.sessions.length > limit && (
                    <button
                      className="h-8 w-full cursor-pointer rounded-md text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
                      onClick={() =>
                        setProjectLimits((limits) => ({
                          ...limits,
                          [group.project.id]: limit + 20,
                        }))
                      }
                      type="button"
                    >
                      Show {Math.min(20, group.sessions.length - limit)} more
                    </button>
                  )}
                </div>
              )}
            </section>
          );
        })
      )}
    </nav>
  );
}

export { CollapsedRail } from "./CollapsedRail.tsx";
