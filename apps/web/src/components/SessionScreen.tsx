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
  StatusPill,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
  useReducedMotion,
} from "@t4-code/ui";
import { Popover } from "@base-ui/react/popover";
import { Check, PanelBottomClose, PanelBottomOpen, PanelRight, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { WorkspaceProject, WorkspaceSession } from "../lib/workspace-data.ts";
import { PaneContent } from "../features/panes/PaneContent.tsx";
import { TerminalDrawer } from "../features/terminal/TerminalDrawer.tsx";
import { FreshnessBadge, SessionMain } from "../features/transcript/SessionMain.tsx";
import { RIGHT_PANE_DOCK_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import {
  RIGHT_PANE_WIDTH,
  selectSessionView,
  type SessionViewState,
} from "../state/workspace-store.ts";
import { PANE_FAMILY_META } from "./pane-families.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";

function FamilyToggles({ sessionId, view }: { sessionId: string; view: SessionViewState }) {
  return (
    <>
      <div aria-label="Session panels" className="hidden items-center gap-0.5 sm:flex" role="group">
        {PANE_FAMILY_META.map((meta) => {
          const active = view.paneOpen && view.paneFamily === meta.id;
          const Icon = meta.icon;
          return (
            <Tooltip key={meta.id}>
              <TooltipTrigger
                render={
                  <IconButton
                    aria-label={active ? `Close ${meta.label}` : `Open ${meta.label}`}
                    aria-pressed={active}
                    className={cn(active && "bg-secondary text-foreground")}
                    onClick={() => workspaceStore.getState().togglePaneFamily(sessionId, meta.id)}
                    size="icon-sm"
                  >
                    <Icon aria-hidden="true" />
                  </IconButton>
                }
              />
              <TooltipPopup side="bottom">{meta.label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      <MobileFamilyMenu sessionId={sessionId} view={view} />
    </>
  );
}

function MobileFamilyMenu({ sessionId, view }: { sessionId: string; view: SessionViewState }) {
  const [open, setOpen] = useState(false);
  const activeMeta = PANE_FAMILY_META.find((entry) => entry.id === view.paneFamily);
  const TriggerIcon = view.paneOpen && activeMeta !== undefined ? activeMeta.icon : PanelRight;
  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label="Session panels"
        className={cn(
          "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent text-foreground outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:hidden",
          view.paneOpen && "bg-secondary",
        )}
      >
        <TriggerIcon aria-hidden="true" className="size-5 text-muted-foreground" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={6}>
          <Popover.Popup className="w-[min(13rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none transition-[scale,opacity] duration-(--motion-duration-fast) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Popover.Title className="px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
              Session panels
            </Popover.Title>
            <ul>
              {PANE_FAMILY_META.map((meta) => {
                const active = view.paneOpen && view.paneFamily === meta.id;
                const Icon = meta.icon;
                return (
                  <li key={meta.id}>
                    <button
                      aria-pressed={active}
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        workspaceStore.getState().togglePaneFamily(sessionId, meta.id);
                        setOpen(false);
                      }}
                      type="button"
                    >
                      <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                      {active && <Check aria-hidden="true" className="size-4 text-accent-text" />}
                    </button>
                  </li>
                );
              })}
            </ul>
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
  session,
  project,
  nowMs,
}: {
  session: WorkspaceSession;
  project: WorkspaceProject;
  nowMs: number;
}) {
  const archived = session.archivedAt !== undefined;
  const view = useWorkspace((state) => selectSessionView(state, session.id));
  const paneDocks = useMediaQuery(RIGHT_PANE_DOCK_QUERY);
  const [panePreviewWidth, setPanePreviewWidth] = useState<number | null>(null);

  // Transcript scroll ownership lives in TranscriptTimeline (virtualized
  // scroller: number = reading anchor, null = following the tail). This
  // wrapper never scrolls and never writes the session scroll key.

  const activeMeta = PANE_FAMILY_META.find((entry) => entry.id === view.paneFamily);
  const paneWidth = panePreviewWidth ?? view.paneWidth;

  // Docked pane enter/exit: the wrapper's measured width tweens between 0
  // and the persisted pane width; the pane stays mounted while closing and
  // unmounts on transition end. Reduced motion unmounts immediately (a 0ms
  // transition never fires transitionend).
  const reducedMotion = useReducedMotion();
  const paneOpen = paneDocks && view.paneOpen && activeMeta !== undefined;
  const [paneRendered, setPaneRendered] = useState(paneOpen);
  useEffect(() => {
    if (paneOpen) setPaneRendered(true);
    else if (reducedMotion) setPaneRendered(false);
  }, [paneOpen, reducedMotion]);
  useEffect(() => {
    const state = workspaceStore.getState();
    state.setSessionListView(archived ? "archived" : "current");
    if (!archived) return;
    state.setPaneOpen(session.id, false);
    state.setTerminalDrawerOpen(session.id, false);
  }, [archived, session.id]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader gap-1.5 px-1.5 sm:gap-2 sm:px-3">
        <span className="min-w-0 truncate font-medium text-sm">{session.title}</span>
        <span className="hidden shrink-0 text-muted-foreground text-xs sm:inline">
          {project.name}
        </span>
        <span className="hidden shrink-0 font-mono text-muted-foreground text-xs md:inline">
          {session.model}
        </span>
        {archived && <Badge variant="outline">Archived · read-only</Badge>}
        {session.status !== null && (
          <>
            <StatusPill className="hidden shrink-0 sm:inline-flex" status={session.status} />
            <StatusPill className="shrink-0 sm:hidden" labelHidden status={session.status} />
          </>
        )}
        <span className="shrink-0">
          <FreshnessBadge session={session} />
        </span>
        <span className="min-w-0 flex-1" />
        {!archived && <FamilyToggles sessionId={session.id} view={view} />}
        {!archived && <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-border sm:block" />}
        {!archived && <Tooltip>
          <TooltipTrigger
            render={
              <IconButton
                aria-label={
                  view.terminalDrawerOpen ? "Close terminal drawer" : "Open terminal drawer"
                }
                aria-pressed={view.terminalDrawerOpen}
                className="size-11 sm:size-7"
                onClick={() =>
                  workspaceStore
                    .getState()
                    .setTerminalDrawerOpen(session.id, !view.terminalDrawerOpen)
                }
                size="icon-sm"
              >
                {view.terminalDrawerOpen ? <PanelBottomClose /> : <PanelBottomOpen />}
              </IconButton>
            }
          />
          <TooltipPopup side="bottom">
            {view.terminalDrawerOpen ? "Close terminal drawer" : "Open terminal drawer"}
          </TooltipPopup>
        </Tooltip>}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden">
            <SessionMain key={session.id} nowMs={nowMs} project={project} session={session} />
          </div>
          {!archived && <TerminalDrawer open={view.terminalDrawerOpen} sessionId={session.id} />}
        </div>

        {!archived && paneDocks && paneRendered && activeMeta !== undefined && (
          <div
            aria-hidden={paneOpen ? undefined : "true"}
            className="pane-dock flex min-h-0 shrink-0"
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && event.propertyName === "width" && !paneOpen) {
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
              onCommit={(width) => workspaceStore.getState().setPaneWidth(session.id, width)}
              onPreview={setPanePreviewWidth}
              width={paneWidth}
            />
            <aside
              aria-label={activeMeta.label}
              className="flex min-h-0 shrink-0 flex-col bg-background"
              style={{ width: `min(${paneWidth}px, 42vw)` }}
            >
              <div className="surface-subheader gap-2 px-3">
                <span className="font-medium text-xs">{activeMeta.label}</span>
                <span className="flex-1" />
                <IconButton
                  aria-label={`Close ${activeMeta.label}`}
                  onClick={() => workspaceStore.getState().setPaneOpen(session.id, false)}
                  size="icon-xs"
                >
                  <X />
                </IconButton>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                <div className="pane-content-enter" key={view.paneFamily}>
                  <PaneContent family={view.paneFamily} />
                </div>
              </ScrollArea>
              <p className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
                Esc closes this panel.
              </p>
            </aside>
          </div>
        )}
      </div>

      {!archived && !paneDocks && activeMeta !== undefined && (
        <Sheet
          onOpenChange={(open) => workspaceStore.getState().setPaneOpen(session.id, open)}
          open={view.paneOpen}
        >
          <SheetPopup aria-label={activeMeta.label} side="right">
            <div className="surface-subheader gap-2 px-3">
              <span className="font-medium text-xs">{activeMeta.label}</span>
            </div>
            <PaneContent family={view.paneFamily} />
          </SheetPopup>
        </Sheet>
      )}
    </div>
  );
}
