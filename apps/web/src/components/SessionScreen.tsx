// Active session surface: 40px subheader, resume/empty context frame,
// closed-by-default right pane (docked aside above 980px, sheet below), and
// the user terminal drawer affordance. The center body, pane bodies, and
// drawer live in feature seams (transcript/panes/terminal) for later lanes.
import {
  Badge,
  cn,
  IconButton,
  ScrollArea,
  Sheet,
  SheetPopup,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  useReducedMotion,
} from "@t4-code/ui";
import { Popover } from "@base-ui/react/popover";
import { Link } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  Cpu,
  FileDown,
  FolderGit2,
  Laptop,
  Maximize2,
  PanelsTopLeft,
  Server,
  SquareTerminal,
  Wifi,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useActionRegistry } from "../actions/index.ts";
import type { WorkspaceHost, WorkspaceProject, WorkspaceSession } from "../lib/workspace-data.ts";
import { PaneContent } from "../features/panes/PaneContent.tsx";
import { TerminalDrawer } from "../features/terminal/TerminalDrawer.tsx";
import {
  transcriptFileName,
  transcriptRowsToJson,
  transcriptRowsToMarkdown,
  type ExportContent,
  type ExportMeta,
} from "../features/transcript/export.ts";
import {
  SessionMain,
  SessionConnectionBadge,
  SessionStateBadge,
} from "../features/transcript/SessionMain.tsx";
import { RIGHT_PANE_DOCK_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { resolveLiveSession } from "../platform/live-workspace.ts";
import { useShellData } from "../state/shell-data.ts";
import {
  RIGHT_PANE_WIDTH,
  type SessionSurfaceId,
  selectSessionView,
  selectSessionWorkspaceLayout,
} from "../state/workspace-store.ts";
import { SESSION_SURFACES } from "./pane-families.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";

const FRESHNESS_LABEL = {
  live: "Live connection",
  cached: "Cached session",
  offline: "Host offline",
} as const;

function SessionContextMenu({
  host,
  onExport,
  onOpenHostHealth,
  project,
  session,
}: {
  host: WorkspaceHost | undefined;
  onExport: (format: "md" | "json") => void;
  onOpenHostHealth: () => void;
  project: WorkspaceProject;
  session: WorkspaceSession;
}) {
  const [open, setOpen] = useState(false);
  const HostIcon = host?.kind === "remote" ? Server : Laptop;
  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label={`Session context: ${project.name}${host === undefined ? "" : ` on ${host.name}`}`}
        className={cn(
          "flex size-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-transparent text-muted-foreground outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-auto sm:max-w-56 sm:justify-start sm:rounded-md sm:px-1.5",
          open && "bg-secondary text-foreground",
        )}
      >
        <FolderGit2 aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="hidden truncate text-xs sm:inline">{project.name}</span>
        <ChevronDown aria-hidden="true" className="hidden size-3 shrink-0 sm:block" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="start" className="z-50" side="bottom" sideOffset={6}>
          <Popover.Popup className="w-[min(19rem,calc(100vw-1rem))] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-(--overlay-shadow) outline-none transition-[scale,opacity] duration-(--motion-duration-fast) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <div className="flex items-start gap-2 px-1.5 pt-1 pb-2">
              <div className="min-w-0 flex-1">
                <Popover.Title className="truncate font-medium text-sm">
                  {project.name}
                </Popover.Title>
                <Popover.Description className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                  {project.path}
                </Popover.Description>
              </div>
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  session.freshness === "live"
                    ? "bg-success"
                    : session.freshness === "cached"
                      ? "bg-warning"
                      : "bg-muted-foreground",
                )}
              />
            </div>
            <dl className="rounded-lg bg-secondary/60 px-2.5 py-1">
              <div className="flex min-h-9 items-center gap-2 border-border border-b">
                <HostIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <dt className="text-muted-foreground text-xs">Host</dt>
                <dd className="ml-auto max-w-40 truncate text-xs">
                  {host?.name ?? "Unknown host"}
                </dd>
              </div>
              <div className="flex min-h-9 items-center gap-2 border-border border-b">
                <Cpu aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <dt className="text-muted-foreground text-xs">Model</dt>
                <dd className="ml-auto max-w-40 truncate font-mono text-[10px]">{session.model}</dd>
              </div>
              <div className="flex min-h-9 items-center gap-2">
                <Wifi aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <dt className="text-muted-foreground text-xs">Connection</dt>
                <dd className="ml-auto text-xs">{FRESHNESS_LABEL[session.freshness]}</dd>
              </div>
            </dl>
            <button
              className="mt-1 flex min-h-9 w-full cursor-pointer items-center justify-center rounded-lg text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setOpen(false);
                onOpenHostHealth();
              }}
              type="button"
            >
              View host health
            </button>
            <div className="mt-1 border-border border-t px-1.5 pt-1.5 pb-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
              Export transcript
            </div>
            <div className="flex gap-1">
              <button
                className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setOpen(false);
                  onExport("md");
                }}
                type="button"
              >
                <FileDown aria-hidden="true" className="size-3.5" />
                Markdown
              </button>
              <button
                className="flex min-h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setOpen(false);
                  onExport("json");
                }}
                type="button"
              >
                <FileDown aria-hidden="true" className="size-3.5" />
                JSON
              </button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function WorkspaceMenu({
  sessionId,
  paneOpen,
  paneFamily,
  terminalOpen,
}: {
  sessionId: string;
  paneOpen: boolean;
  paneFamily: SessionSurfaceId;
  terminalOpen: boolean;
}) {
  const actionRegistry = useActionRegistry();
  const [open, setOpen] = useState(false);
  const workspaceActive = paneOpen || terminalOpen;
  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label="Workspace tools"
        aria-pressed={workspaceActive}
        className={cn(
          "flex size-11 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-lg border border-transparent px-2 text-foreground outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-auto sm:rounded-md",
          (workspaceActive || open) && "bg-secondary",
        )}
      >
        <PanelsTopLeft aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="hidden text-xs lg:inline">Workspace</span>
        <ChevronDown aria-hidden="true" className="hidden size-3 text-muted-foreground sm:block" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={6}>
          <Popover.Popup className="w-[min(17rem,calc(100vw-1rem))] rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-(--overlay-shadow) outline-none transition-[scale,opacity] duration-(--motion-duration-fast) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Popover.Title className="px-2 pt-1 pb-2 font-medium text-sm">Workspace</Popover.Title>
            <p className="px-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Open on the right
            </p>
            <ul>
              {SESSION_SURFACES.map((meta) => {
                const active = paneOpen && paneFamily === meta.id;
                const Icon = meta.icon;
                const label = meta.id === "terminals" ? "Agent terminals" : meta.label;
                const invocation = {
                  id: "surface.toggle" as const,
                  args: { sessionId, surfaceId: meta.id },
                };
                const presentation = actionRegistry.present(invocation);
                return (
                  <li key={meta.id}>
                    <button
                      aria-label={`${presentation.label} panel`}
                      aria-pressed={active}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
                      disabled={presentation.availability.status !== "enabled"}
                      onClick={() => {
                        if (actionRegistry.execute(invocation).executed) setOpen(false);
                      }}
                      title={
                        presentation.availability.status === "disabled"
                          ? presentation.availability.reason
                          : undefined
                      }
                      type="button"
                    >
                      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="text-[10px] text-muted-foreground">Right</span>
                      {active && <Check aria-hidden="true" className="size-4 text-accent-text" />}
                    </button>
                  </li>
                );
              })}
            </ul>
            <div aria-hidden="true" className="my-1 h-px bg-border" />
            <p className="px-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Open below
            </p>
            <button
              aria-label={`${actionRegistry.present({ id: "terminal.toggle", args: undefined }).label} below`}
              aria-pressed={terminalOpen}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9"
              disabled={
                actionRegistry.present({ id: "terminal.toggle", args: undefined }).availability
                  .status !== "enabled"
              }
              onClick={() => {
                if (actionRegistry.execute({ id: "terminal.toggle", args: undefined }).executed) {
                  setOpen(false);
                }
              }}
              type="button"
            >
              <SquareTerminal aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Terminal</span>
              <span className="font-mono text-[10px] text-muted-foreground">⌘J</span>
              {terminalOpen && <Check aria-hidden="true" className="size-4 text-accent-text" />}
            </button>
            <div aria-hidden="true" className="my-1 h-px bg-border" />
            <p className="px-2 pb-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Layout
            </p>
            <button
              aria-label={actionRegistry.present({ id: "focus.toggle", args: undefined }).label}
              className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
              onClick={() => {
                if (actionRegistry.execute({ id: "focus.toggle", args: undefined }).executed) {
                  setOpen(false);
                }
              }}
              type="button"
            >
              <Maximize2 aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">Enter focus mode</span>
              <span className="font-mono text-[10px] text-muted-foreground">⌘⇧F</span>
            </button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Session mounts are deliberately instant — no entrance animation on hard
// reload, deep link, or in-app A→B switches. Content renders fully opaque
// at its final coordinates on the first frame.

export function SessionScreen({
  sessionId,
  session,
  project,
  nowMs,
  onOpenHostHealth,
}: {
  sessionId: string;
  session: WorkspaceSession;
  project: WorkspaceProject;
  nowMs: number;
  onOpenHostHealth: () => void;
}) {
  const archived = session.archivedAt !== undefined;
  // Subscribe to the pane/drawer primitives only, never the whole view
  // object: its identity changes on every scroll-anchor write (each scroll
  // event while reading history) and every composer keystroke (draft), and
  // a whole-view subscription re-renders this entire surface per frame.
  const viewPaneFamily = useWorkspace((state) => selectSessionView(state, sessionId).paneFamily);
  const secondarySurfaceId = useWorkspace(
    (state) => selectSessionWorkspaceLayout(state, sessionId).secondary,
  );
  const viewPaneOpen = secondarySurfaceId !== null;
  const viewPaneWidth = useWorkspace((state) => selectSessionView(state, sessionId).paneWidth);
  const terminalDrawerOpen = useWorkspace(
    (state) => selectSessionView(state, sessionId).terminalDrawerOpen,
  );
  const focusMode = useWorkspace((state) => state.focusMode);
  const paneDocks = useMediaQuery(RIGHT_PANE_DOCK_QUERY);
  const shellData = useShellData();
  const host = shellData.hosts.find((entry) => entry.id === project.hostId);
  // Filled by SessionMain with the current transcript rows; the context
  // menu serializes whatever is there at click time.
  const exportRowsRef = useRef<(() => ExportContent) | null>(null);
  const handleExport = (format: "md" | "json") => {
    const content = exportRowsRef.current?.();
    if (content === null || content === undefined) return;
    const exportedAt = new Date();
    const meta: ExportMeta = {
      sessionTitle: session.title,
      projectName: project.name,
      hostName: host?.name ?? "Unknown host",
      model: session.model,
      freshness: session.freshness,
      exportedAt: exportedAt.toISOString(),
      historyTruncated: content.historyTruncated,
      turnActive: content.turnActive,
    };
    const text =
      format === "json"
        ? transcriptRowsToJson(content.rows, meta)
        : transcriptRowsToMarkdown(content.rows, meta);
    const blob = new Blob([text], {
      type: format === "json" ? "application/json" : "text/markdown",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = transcriptFileName(session.title, format, exportedAt);
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const runtimeSnapshot = useDesktopRuntimeSnapshot();
  const previewAddress =
    runtimeSnapshot === null ? null : resolveLiveSession(runtimeSnapshot, sessionId);
  const connectionState =
    runtimeSnapshot === null || previewAddress === null
      ? null
      : (runtimeSnapshot.connections.get(previewAddress.targetId) ?? null);
  const previewCount = rendererPlatform.demo
    ? 1
    : previewAddress === null
      ? 0
      : (runtimeSnapshot?.projection.sessions.get(
          `${previewAddress.hostId}\u0000${previewAddress.sessionId}`,
        )?.previews.size ?? 0);
  const [panePreviewWidth, setPanePreviewWidth] = useState<number | null>(null);

  // Transcript scroll ownership lives in TranscriptTimeline (virtualized
  // scroller: number = reading anchor, null = following the tail). This
  // wrapper never scrolls and never writes the session scroll key.

  const activeMeta = SESSION_SURFACES.find((entry) => entry.id === viewPaneFamily);
  const paneWidth = panePreviewWidth ?? viewPaneWidth;

  // Docked pane enter/exit: the wrapper's measured width tweens between 0
  // and the persisted pane width; the pane stays mounted while closing and
  // unmounts on transition end. Reduced motion unmounts immediately (a 0ms
  // transition never fires transitionend).
  const reducedMotion = useReducedMotion();
  const paneOpen = paneDocks && viewPaneOpen && activeMeta !== undefined;
  const [paneRendered, setPaneRendered] = useState(paneOpen);
  useEffect(() => {
    if (paneOpen) setPaneRendered(true);
    else if (reducedMotion) setPaneRendered(false);
  }, [paneOpen, reducedMotion]);
  useEffect(() => {
    const state = workspaceStore.getState();
    state.setSessionListView(archived ? "archived" : "current");
    if (!archived) return;
    state.closeSessionSurface(sessionId, viewPaneFamily);
    state.setTerminalDrawerOpen(sessionId, false);
  }, [archived, sessionId, viewPaneFamily]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader gap-1.5 px-1.5 sm:gap-2 sm:px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate font-medium text-sm">{session.title}</span>
          <span aria-hidden="true" className="hidden shrink-0 text-border sm:inline">
            /
          </span>
          <span className="shrink-0 sm:min-w-0 sm:shrink">
            <SessionContextMenu
              host={host}
              onExport={handleExport}
              onOpenHostHealth={onOpenHostHealth}
              project={project}
              session={session}
            />
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {connectionState !== null && <SessionConnectionBadge state={connectionState} />}
          {!archived &&
            (connectionState === null || connectionState === "connected") && (
              <SessionStateBadge session={session} />
            )}
          {archived && (
            <Badge
              aria-label="Archived · read-only"
              className="w-20 justify-center px-2 sm:w-32"
              variant="outline"
            >
              <span className="sm:hidden">Archived</span>
              <span className="hidden sm:inline">Archived · read-only</span>
            </Badge>
          )}
        </span>
        {previewCount > 0 && (
          <Link
            aria-label={`Open browser preview${previewCount === 1 ? "" : ` (${previewCount})`}`}
            className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            params={{ sessionId }}
            to="/sessions/$sessionId/preview"
          >
            <Badge variant="outline">Preview{previewCount === 1 ? "" : ` · ${previewCount}`}</Badge>
          </Link>
        )}
        {rendererPlatform.browser !== null && (
          <Link
            aria-label="Open browser workspace"
            className="shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            params={{ sessionId }}
            to="/sessions/$sessionId/browser"
          >
            <Badge variant="outline">Browser</Badge>
          </Link>
        )}
        {!archived && !focusMode && (
          <WorkspaceMenu
            paneFamily={viewPaneFamily}
            paneOpen={viewPaneOpen}
            sessionId={sessionId}
            terminalOpen={terminalDrawerOpen}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <SessionMain
              key={sessionId}
              exportRowsRef={exportRowsRef}
              nowMs={nowMs}
              onOpenHostHealth={onOpenHostHealth}
              project={project}
              session={session}
              sessionId={sessionId}
            />
          </div>
          {!archived && (
            <TerminalDrawer open={!focusMode && terminalDrawerOpen} sessionId={sessionId} />
          )}
        </div>

        {!archived && !focusMode && paneDocks && paneRendered && activeMeta !== undefined && (
          <div
            aria-hidden={paneOpen ? undefined : "true"}
            className="pane-dock flex min-h-0 shrink-0"
            onTransitionEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.propertyName === "width" &&
                !paneOpen
              ) {
                setPaneRendered(false);
              }
            }}
            style={
              paneOpen
                ? { width: `calc(min(${paneWidth}px, 42vw) + 1px)`, opacity: 1 }
                : { width: 0, opacity: 0 }
            }
          >
            <ResizeHandle
              bounds={RIGHT_PANE_WIDTH}
              edge="left"
              label={`Resize ${activeMeta.label} panel`}
              onCommit={(width) => workspaceStore.getState().setPaneWidth(sessionId, width)}
              onPreview={setPanePreviewWidth}
              width={paneWidth}
            />
            <aside
              aria-label={activeMeta.label}
              className="flex min-h-0 shrink-0 flex-col bg-(--sidebar-background)"
              style={{ width: `min(${paneWidth}px, 42vw)` }}
            >
              <ScrollArea className="min-h-0 flex-1">
                <div className="pane-content-enter" key={viewPaneFamily}>
                  <PaneContent
                    sessionId={sessionId}
                    surfaceId={viewPaneFamily}
                    trailing={
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <IconButton
                              aria-label={`Close ${activeMeta.label}`}
                              onClick={() =>
                                workspaceStore
                                  .getState()
                                  .closeSessionSurface(sessionId, viewPaneFamily)
                              }
                              size="icon-xs"
                            >
                              <X />
                            </IconButton>
                          }
                        />
                        <TooltipPopup side="bottom">Close (Esc)</TooltipPopup>
                      </Tooltip>
                    }
                  />
                </div>
              </ScrollArea>
            </aside>
          </div>
        )}
      </div>

      {!archived && !focusMode && !paneDocks && activeMeta !== undefined && (
        <Sheet
          onOpenChange={(open) => {
            const state = workspaceStore.getState();
            if (open) state.openSessionSurface(sessionId, viewPaneFamily);
            else state.closeSessionSurface(sessionId, viewPaneFamily);
          }}
          open={viewPaneOpen}
        >
          <SheetPopup aria-label={activeMeta.label} side="right">
            <PaneContent sessionId={sessionId} surfaceId={viewPaneFamily} />
          </SheetPopup>
        </Sheet>
      )}
    </div>
  );
}
