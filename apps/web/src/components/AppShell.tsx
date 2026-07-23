// Shell frame: titlebar, resizable project/session rail (docked, collapsed
// strip, or narrow-width overlay), the routed center, and the command
// palette. Keyboard: Cmd/Ctrl+K palette, Cmd/Ctrl+B rail, Cmd/Ctrl+1..9
// visible sessions, Escape peels the topmost open surface.
import { Button, Sheet, SheetClose, SheetPopup, SheetTitle } from "@t4-code/ui";
import { deriveAttentionInbox } from "@t4-code/client";
import { Outlet, useNavigate } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ActionRegistryProvider,
  CORE_ACTIONS,
  createActionRegistry,
  type ActionDestination,
} from "../actions/index.ts";
import { handoffTranscriptSearchQuery } from "../features/transcript-search/index.ts";
import { composerStore } from "../features/composer/composer-store.ts";
import { TRANSCRIPT_SEARCH_ROUTE } from "../features/transcript-search/route.ts";
import { getInspectorStore } from "../features/panes/inspector-store.ts";
import {
  startDesktopRuntime,
  useDesktopRuntimeSelector,
} from "../platform/desktop-runtime.ts";
import {
  ATTENTION_INBOX_FIXTURES,
  buildAttentionInboxViewModel,
} from "../features/attention/index.ts";
import { getShellData, useShellData } from "../state/shell-data.ts";
import { RAIL_OVERLAY_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { isEditableTarget, resolveShortcutInvocation } from "../keyboard/shortcuts.ts";
import { buildProjectGroups, listVisibleSessionIds } from "../lib/session-tree.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { RAIL_COLLAPSED_WIDTH, RAIL_WIDTH, selectSessionView } from "../state/workspace-store.ts";
import { CommandPalette } from "./CommandPalette.tsx";
import { CollapsedRail, Rail } from "./Rail.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { Titlebar } from "./Titlebar.tsx";
import { resolveRailTogglePresentation } from "./rail-toggle.ts";

const EXPANDED_RAIL_SESSION_LIMIT = 100;

export function AppShell() {
  const navigate = useNavigate();
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  const railCollapsed = useWorkspace((state) => state.railCollapsed);
  const railWidth = useWorkspace((state) => state.railWidth);
  const railOverlayOpen = useWorkspace((state) => state.railOverlayOpen);
  const focusMode = useWorkspace((state) => state.focusMode);
  const sessionListView = useWorkspace((state) => state.sessionListView);
  const railSort = useWorkspace((state) => state.railSort);
  const railQuery = useWorkspace((state) => state.railQuery);
  const railFilter = useWorkspace((state) => state.railFilter);
  const projectManualOrder = useWorkspace((state) => state.projectManualOrder);
  const sessionManualOrderByProjectId = useWorkspace(
    (state) => state.sessionManualOrderByProjectId,
  );
  const projectExpandedById = useWorkspace((state) => state.projectExpandedById);
  const hiddenProjectIds = useWorkspace((state) => state.hiddenProjectIds);
  const projectAliasById = useWorkspace((state) => state.projectAliasById);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const lastVisitedAtBySessionId = useWorkspace((state) => state.lastVisitedAtBySessionId);
  const lastSeenAttentionOutcomeBySessionKey = useWorkspace(
    (state) => state.lastSeenAttentionOutcomeBySessionKey,
  );
  const [railPreviewWidth, setRailPreviewWidth] = useState<number | null>(null);
  const [nowMs] = useState(() => Date.now());

  const shellData = useShellData();
  const defaultProjectsExpanded = shellData.sessions.length < EXPANDED_RAIL_SESSION_LIMIT;
  const currentGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "current",
        hiddenProjectIds,
        {
          filter: railFilter,
          query: railQuery,
          sort: railSort,
          defaultExpanded: defaultProjectsExpanded,
          activeSessionId,
          projectManualOrder,
          sessionManualOrderByProjectId,
          projectAliasById,
        },
      ),
    [
      shellData,
      projectExpandedById,
      activeSessionId,
      defaultProjectsExpanded,
      lastVisitedAtBySessionId,
      hiddenProjectIds,
      projectAliasById,
      railFilter,
      railQuery,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const archivedGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "archived",
        {},
        {
          filter: railFilter,
          query: railQuery,
          sort: railSort,
          defaultExpanded: defaultProjectsExpanded,
          activeSessionId,
          projectManualOrder,
          sessionManualOrderByProjectId,
          projectAliasById,
        },
      ),
    [
      shellData,
      projectExpandedById,
      activeSessionId,
      defaultProjectsExpanded,
      lastVisitedAtBySessionId,
      railFilter,
      railQuery,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
      projectAliasById,
    ],
  );
  const allCurrentGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "current",
        {},
        {
          sort: railSort,
          defaultExpanded: defaultProjectsExpanded,
          activeSessionId,
          projectManualOrder,
          sessionManualOrderByProjectId,
          projectAliasById,
        },
      ),
    [
      shellData,
      projectExpandedById,
      activeSessionId,
      defaultProjectsExpanded,
      lastVisitedAtBySessionId,
      projectAliasById,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
    ],
  );
  const allArchivedGroups = useMemo(
    () =>
      buildProjectGroups(
        shellData,
        projectExpandedById,
        lastVisitedAtBySessionId,
        "archived",
        {},
        {
          sort: railSort,
          defaultExpanded: defaultProjectsExpanded,
          activeSessionId,
          projectManualOrder,
          sessionManualOrderByProjectId,
          projectAliasById,
        },
      ),
    [
      shellData,
      projectExpandedById,
      activeSessionId,
      defaultProjectsExpanded,
      lastVisitedAtBySessionId,
      railSort,
      projectManualOrder,
      sessionManualOrderByProjectId,
      projectAliasById,
    ],
  );
  const allSessionGroups = useMemo(
    () => [...allCurrentGroups, ...allArchivedGroups],
    [allArchivedGroups, allCurrentGroups],
  );
  const groups = sessionListView === "archived" ? archivedGroups : currentGroups;
  const currentCount = shellData.sessions.filter(
    (session) => session.archivedAt === undefined,
  ).length;
  const archivedCount = shellData.sessions.length - currentCount;
  const liveAttentionCount = useDesktopRuntimeSelector(
    (snapshot) =>
      deriveAttentionInbox(snapshot, {
        seenOutcomeIdsBySessionKey: lastSeenAttentionOutcomeBySessionKey,
      }).urgentCount,
  );
  const attentionCount =
    liveAttentionCount ??
    buildAttentionInboxViewModel(ATTENTION_INBOX_FIXTURES.sample.items).urgentCount;
  const hiddenProjectIdSet = useMemo(
    () => new Set(Object.keys(hiddenProjectIds).filter((id) => hiddenProjectIds[id] === true)),
    [hiddenProjectIds],
  );
  const actionRegistry = useMemo(
    () =>
      createActionRegistry(CORE_ACTIONS, {
        workspace: workspaceStore,
        composer: composerStore,
        platform: rendererPlatform,
        railOverlaid: () => railOverlaid,
        shellData: getShellData,
        inspector: getInspectorStore,
        visibleSessionIds: () => {
          const state = workspaceStore.getState();
          return listVisibleSessionIds(
            buildProjectGroups(
              getShellData(),
              state.projectExpandedById,
              state.lastVisitedAtBySessionId,
              state.sessionListView,
              state.hiddenProjectIds,
              {
                activeSessionId: state.activeSessionId,
                defaultExpanded:
                  getShellData().sessions.length < EXPANDED_RAIL_SESSION_LIMIT,
                filter: state.railFilter,
                query: state.railQuery,
                sort: state.railSort,
                projectManualOrder: state.projectManualOrder,
                sessionManualOrderByProjectId: state.sessionManualOrderByProjectId,
                projectAliasById: state.projectAliasById,
              },
            ),
          );
        },
        navigate: (destination: ActionDestination) => {
          if (destination.kind === "session") {
            void navigate({
              params: { sessionId: destination.sessionId },
              to: "/sessions/$sessionId",
            });
            return;
          }
          if (destination.kind === "transcript-search") {
            handoffTranscriptSearchQuery(destination.query);
            void navigate({ to: TRANSCRIPT_SEARCH_ROUTE });
            return;
          }
          if (destination.kind === "preview") {
            void navigate({
              params: { sessionId: destination.sessionId },
              to: "/sessions/$sessionId/preview",
            });
            return;
          }
          switch (destination.route) {
            case "/agents":
              void navigate({ to: "/agents" });
              return;
            case "/hosts":
              void navigate({ to: "/hosts" });
              return;
            case "/inbox":
              void navigate({ to: "/inbox" });
              return;
            case "/settings":
              void navigate({ to: "/settings" });
              return;
            case "/usage":
              void navigate({ to: "/usage" });
          }
        },
      }),
    [navigate, railOverlaid],
  );

  // Desktop mode: start the runtime once. StrictMode's doubled effect and
  // HMR remounts are safe — start is idempotent on a global singleton.
  useEffect(() => {
    startDesktopRuntime();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        // Dialog-based surfaces (palette, sheets) close themselves; the
        // docked pane is plain layout, so Escape peels it here.
        const state = workspaceStore.getState();
        if (state.paletteOpen || (state.railOverlayOpen && !state.focusMode)) return;
        if (state.focusMode) {
          state.setFocusMode(false);
          event.preventDefault();
          return;
        }
        const activeId = state.activeSessionId;
        if (activeId !== null && selectSessionView(state, activeId).paneOpen) {
          state.setPaneOpen(activeId, false);
          event.preventDefault();
        }
        return;
      }

      const invocation = resolveShortcutInvocation(
        event,
        actionRegistry.environment.visibleSessionIds,
      );
      if (invocation === null) return;
      if (isEditableTarget(event.target) && invocation.id === "session.open") return;
      event.preventDefault();
      actionRegistry.execute(invocation);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actionRegistry]);

  // Rail collapse/expand animates width via .rail-dock; the center column
  // reflows with it and keeps its own focus and scroll.
  const effectiveRailWidth = railPreviewWidth ?? railWidth;
  const railToggle = resolveRailTogglePresentation({
    overlaid: railOverlaid,
    overlayOpen: railOverlayOpen,
    collapsed: railCollapsed || focusMode,
  });

  return (
    <ActionRegistryProvider registry={actionRegistry}>
      <div className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-x-hidden bg-background text-foreground">
        <Titlebar
          focusMode={focusMode}
          onExitFocus={() => actionRegistry.execute({ id: "focus.toggle", args: undefined })}
          onToggleRail={() => actionRegistry.execute({ id: "rail.toggle", args: undefined })}
          railToggle={railToggle}
        />
        {rendererPlatform.demo && (
          <div
            aria-label="Sample data notice"
            className="flex min-h-7 shrink-0 items-center justify-center gap-1.5 border-border/60 border-b bg-primary/8 px-2 text-center text-xs"
          >
            <span className="font-semibold text-primary">Sample data</span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="truncate text-muted-foreground">
              Explore freely. No live hosts, accounts, or files are connected.
            </span>
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {!railOverlaid && !focusMode && (
            <>
              <div
                className="rail-dock flex h-full shrink-0 flex-col overflow-hidden border-border/60 border-r bg-(--sidebar-background)"
                style={{ width: railCollapsed ? RAIL_COLLAPSED_WIDTH : effectiveRailWidth }}
              >
                {railCollapsed ? (
                  <div className="h-full" style={{ width: RAIL_COLLAPSED_WIDTH }}>
                    <CollapsedRail
                      attentionCount={attentionCount}
                      groups={allCurrentGroups.filter(
                        (group) => !hiddenProjectIdSet.has(group.project.id),
                      )}
                      onExpand={(projectId) => {
                        const state = workspaceStore.getState();
                        state.setRailCollapsed(false);
                        state.setProjectExpanded(projectId, true);
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex h-full flex-col" style={{ width: effectiveRailWidth }}>
                    <Rail
                      allGroups={allCurrentGroups}
                      attentionCount={attentionCount}
                      archivedCount={archivedCount}
                      currentCount={currentCount}
                      groups={groups}
                      hiddenProjectIds={hiddenProjectIdSet}
                      nowMs={nowMs}
                      pinnedSessionGroups={allSessionGroups}
                      view={sessionListView}
                    />
                  </div>
                )}
              </div>
              {!railCollapsed && (
                <ResizeHandle
                  bounds={RAIL_WIDTH}
                  edge="right"
                  label="Resize session list"
                  onCommit={(width) => workspaceStore.getState().setRailWidth(width)}
                  onPreview={setRailPreviewWidth}
                  width={effectiveRailWidth}
                />
              )}
            </>
          )}
          <main className="flex min-h-0 min-w-0 flex-1">
            <Outlet />
          </main>
        </div>

        {railOverlaid && (
          <Sheet
            onOpenChange={(open) => workspaceStore.getState().setRailOverlayOpen(open)}
            open={railOverlayOpen && !focusMode}
          >
            <SheetPopup
              aria-label="Working folders and sessions"
              className="w-[min(20rem,calc(100vw-1rem))] p-0"
              showCloseButton={false}
              side="left"
            >
              <div className="flex h-14 shrink-0 items-center border-border border-b px-3">
                <SheetTitle className="text-sm">
                  <span aria-hidden="true">T4 Code</span>
                  <span className="sr-only">Working folders and sessions</span>
                </SheetTitle>
                <SheetClose
                  aria-label="Close"
                  className="ml-auto size-11"
                  render={<Button size="icon" variant="ghost" />}
                >
                  <X aria-hidden="true" className="size-4" />
                </SheetClose>
              </div>
              <div className="min-h-0 flex-1">
                <Rail
                  allGroups={allCurrentGroups}
                  attentionCount={attentionCount}
                  archivedCount={archivedCount}
                  currentCount={currentCount}
                  groups={groups}
                  hiddenProjectIds={hiddenProjectIdSet}
                  nowMs={nowMs}
                  pinnedSessionGroups={allSessionGroups}
                  view={sessionListView}
                />
              </div>
            </SheetPopup>
          </Sheet>
        )}

        <CommandPalette groups={allSessionGroups} registry={actionRegistry} />
      </div>
    </ActionRegistryProvider>
  );
}
