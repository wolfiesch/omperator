// Bottom drawer for the user's own terminals: renameable tabs, splits (max
// four panes per group), a keyboard-operable height handle, a single notice
// strip for exit/signal/error/permission/offline/reconnecting/backpressure,
// a paste confirmation that names the target shell, a remote-host badge,
// and a visible sample-mode label whenever the fixture bridge feeds it.
// This is the only interactive terminal surface — agent shells never render
// here; their output is read-only Activity evidence.
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  IconButton,
  useReducedMotion,
} from "@t4-code/ui";
import {
  Layers3,
  Plus,
  SquareSplitHorizontal,
  SquareSplitVertical,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { useActionRegistry } from "../../actions/index.ts";
import { captureTerminalContext } from "../context-packet/context-packet.ts";
import { workspaceStore } from "../../state/store-instance.ts";
import { pastePreview } from "./paste-guard.ts";
import {
  getTerminalStore,
  MAX_TERMINALS_PER_GROUP,
  MAX_TERMINAL_TITLE_CHARS,
  resolveDrawerNotice,
  TERMINAL_DRAWER_HEIGHT,
  useTerminalDrawer,
  type PendingPaste,
  type TerminalDrawerStoreApi,
  type TerminalTabState,
} from "./terminal-store.ts";
import { TerminalViewport, type TerminalSelectionChange } from "./TerminalViewport.tsx";

export interface TerminalDrawerProps {
  readonly sessionId: string;
  readonly open: boolean;
}

function clampHeight(height: number): number {
  const max = Math.max(
    TERMINAL_DRAWER_HEIGHT.min,
    Math.floor((typeof window === "undefined" ? 800 : window.innerHeight) * 0.75),
  );
  return Math.min(Math.max(Math.round(height), TERMINAL_DRAWER_HEIGHT.min), max);
}

/** Drawer height handle: pointer drag plus arrow keys; commits on release. */
function HeightHandle({
  api,
  height,
  onPreview,
  onEpoch,
}: {
  readonly api: TerminalDrawerStoreApi;
  readonly height: number;
  readonly onPreview: (height: number | null) => void;
  readonly onEpoch: () => void;
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
    document.documentElement.classList.add("no-transitions");
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    onPreview(clampHeight(drag.startHeight + (drag.startY - event.clientY)));
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    document.documentElement.classList.remove("no-transitions");
    const next = clampHeight(drag.startHeight + (drag.startY - event.clientY));
    onPreview(null);
    api.getState().setDrawerHeight(next);
    onEpoch();
  };
  return (
    <div
      aria-label="Resize terminal drawer"
      aria-orientation="horizontal"
      aria-valuemin={TERMINAL_DRAWER_HEIGHT.min}
      aria-valuenow={Math.round(height)}
      className="-top-1 absolute inset-x-0 z-10 h-2 cursor-row-resize outline-none focus-visible:bg-ring/40"
      onKeyDown={(event) => {
        const delta = event.key === "ArrowUp" ? 16 : event.key === "ArrowDown" ? -16 : 0;
        if (delta === 0) return;
        event.preventDefault();
        api.getState().setDrawerHeight(clampHeight(height + delta));
        onEpoch();
      }}
      onPointerCancel={onPointerEnd}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      role="separator"
      tabIndex={0}
    />
  );
}

/** One tab: activate, double-click or F2 to rename, hover/focus to close. */
function TerminalTab({
  api,
  tab,
  active,
}: {
  readonly api: TerminalDrawerStoreApi;
  readonly tab: TerminalTabState;
  readonly active: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim().length > 0) {
      api.getState().renameTerminal(tab.id, draft);
    }
    setDraft(null);
    api.getState().requestFocus();
  };
  const stopped = tab.status === "exited" || tab.status === "error" || tab.status === "denied";
  return (
    <span className="group/tab flex shrink-0 items-center" key={tab.id}>
      {draft !== null ? (
        <input
          aria-label={`Rename ${tab.title}`}
          autoFocus
          className="h-6 w-28 rounded-md bg-secondary px-2 text-foreground text-xs outline-none ring-2 ring-ring"
          maxLength={MAX_TERMINAL_TITLE_CHARS}
          onBlur={commit}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") {
              setDraft(null);
              api.getState().requestFocus();
            }
          }}
          value={draft}
        />
      ) : (
        <button
          aria-selected={active}
          className={cn(
            "flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "bg-secondary font-medium text-foreground"
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
          )}
          data-terminal-tab={tab.id}
          onClick={() => api.getState().setActiveTerminal(tab.id)}
          onDoubleClick={() => setDraft(tab.title)}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              setDraft(tab.title);
            }
          }}
          role="tab"
          tabIndex={active ? 0 : -1}
          title="Double-click or press F2 to rename"
          type="button"
        >
          <SquareTerminal aria-hidden="true" className="size-3" />
          {tab.title}
          {stopped && (
            <span className="text-muted-foreground">
              · {tab.status === "exited" ? "exited" : "stopped"}
            </span>
          )}
        </button>
      )}
      <button
        aria-label={`Close ${tab.title}`}
        className="-ms-1 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 outline-none transition-opacity duration-(--motion-duration-fast) hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/tab:opacity-100"
        onClick={() => api.getState().closeTerminal(tab.id)}
        tabIndex={-1}
        type="button"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </span>
  );
}

function TabStrip({
  api,
  tabs,
  activeId,
}: {
  readonly api: TerminalDrawerStoreApi;
  readonly tabs: readonly TerminalTabState[];
  readonly activeId: string | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Roving tablist: arrows move activation (selection follows focus).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (target === undefined) return;
    api.getState().setActiveTerminal(target.id);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-terminal-tab="${target.id}"]`)
      ?.focus();
  };
  return (
    <div
      aria-label="Terminal tabs"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="tablist"
    >
      {tabs.map((tab) => (
        <TerminalTab active={tab.id === activeId} api={api} key={tab.id} tab={tab} />
      ))}
    </div>
  );
}

/** Exit/signal/error/permission/offline/reconnecting/backpressure line. */
function NoticeStrip({ api }: { readonly api: TerminalDrawerStoreApi }) {
  // Select stable slices, derive the notice during render: a selector that
  // allocates per snapshot would loop useSyncExternalStore.
  const connection = useTerminalDrawer(api, (state) => state.connection);
  const tabs = useTerminalDrawer(api, (state) => state.tabs);
  const activeTerminalId = useTerminalDrawer(api, (state) => state.activeTerminalId);
  const notice = resolveDrawerNotice({ connection, tabs, activeTerminalId });
  return (
    <div aria-live="polite" className="shrink-0">
      {notice !== null && (
        <div
          className={cn(
            "flex items-center gap-2 border-border border-t px-3 py-1.5",
            notice.level === "error" && "bg-destructive/8 dark:bg-destructive/16",
            notice.level === "warning" && "bg-warning/8 dark:bg-warning/16",
            notice.level === "info" && "bg-secondary/60",
          )}
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              notice.level === "error" && "text-destructive-foreground",
              notice.level === "warning" && "text-warning-foreground",
            )}
          >
            {notice.message}
          </span>
          {notice.restartTerminalId !== null && notice.restartLabel !== null && (
            <Button
              onClick={() => {
                if (notice.restartTerminalId !== null) {
                  api.getState().restartTerminal(notice.restartTerminalId);
                }
              }}
              size="xs"
              variant="outline"
            >
              {notice.restartLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Risky paste confirmation: names the target shell, previews a bounded
 * excerpt, and lists why it asked. The text is never logged anywhere. */
function PasteGuardDialog({
  api,
  pending,
  hostLabel,
}: {
  readonly api: TerminalDrawerStoreApi;
  readonly pending: PendingPaste;
  readonly hostLabel: string;
}) {
  const title =
    api.getState().tabs.find((tab) => tab.id === pending.terminalId)?.title ?? "this shell";
  const { preview, truncated } = pastePreview(pending.text);
  const { assessment } = pending;
  const reasons: string[] = [];
  if (assessment.multiline) reasons.push(`runs ${assessment.lines} lines as soon as they land`);
  if (assessment.large) reasons.push(`is large (${assessment.chars.toLocaleString()} characters)`);
  for (const label of assessment.destructive) reasons.push(label);
  const destructive = assessment.destructive.length > 0;
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : api.getState().cancelPaste())} open>
      <DialogPopup aria-label={`Paste into ${title}`} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Paste into {title}?</DialogTitle>
          <DialogDescription>
            This paste {reasons.length > 1 ? reasons.join("; ") : (reasons[0] ?? "needs a look")}.
            It goes to <span className="font-medium text-foreground">{title}</span> on{" "}
            <span className="font-medium text-foreground">{hostLabel}</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6">
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border bg-secondary/60 p-2 font-mono text-xs">
            {preview}
            {truncated && <span className="text-muted-foreground">{"\n"}… preview cut short</span>}
          </pre>
        </div>
        <DialogFooter variant="bare">
          <Button onClick={() => api.getState().cancelPaste()} size="sm" variant="ghost">
            Don't paste
          </Button>
          <Button
            onClick={() => api.getState().confirmPaste()}
            size="sm"
            variant={destructive ? "destructive" : "default"}
          >
            Paste into {title}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DrawerBody({
  api,
  sessionId,
  closing,
  onExited,
}: {
  readonly api: TerminalDrawerStoreApi;
  readonly sessionId: string;
  /** Close was clicked: play the exit beat, then unmount via onExited. */
  readonly closing: boolean;
  readonly onExited: () => void;
}) {
  const actionRegistry = useActionRegistry();
  const tabs = useTerminalDrawer(api, (state) => state.tabs);
  const groups = useTerminalDrawer(api, (state) => state.groups);
  const activeId = useTerminalDrawer(api, (state) => state.activeTerminalId);
  const height = useTerminalDrawer(api, (state) => state.drawerHeight);
  const sampleMode = useTerminalDrawer(api, (state) => state.sampleMode);
  const host = useTerminalDrawer(api, (state) => state.host);
  const shellLabel = useTerminalDrawer(api, (state) => state.shellLabel);
  const cwdLabel = useTerminalDrawer(api, (state) => state.cwdLabel);
  const pendingPaste = useTerminalDrawer(api, (state) => state.pendingPaste);
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [terminalSelection, setTerminalSelection] = useState<{
    readonly terminalId: string;
    readonly title: string;
    readonly text: string;
  } | null>(null);
  const handleSelectionChange = useCallback(
    (selection: TerminalSelectionChange) =>
      setTerminalSelection((current) =>
        selection.text.trim().length > 0
          ? selection
          : current?.terminalId === selection.terminalId
            ? null
            : current,
      ),
    [],
  );

  // Sample-mode QA handle for deterministic screenshots and manual state
  // checks (connection flips, host overrides). Never present off-fixture.
  useEffect(() => {
    if (!sampleMode || typeof window === "undefined") return;
    const target = window as unknown as Record<string, unknown>;
    const registry = (target.__ompTerminalQa ??= {}) as Record<string, TerminalDrawerStoreApi>;
    registry[sessionId] = api;
    return () => {
      delete registry[sessionId];
    };
  }, [sampleMode, api, sessionId]);

  useEffect(() => {
    if (
      terminalSelection !== null &&
      !tabs.some((tab) => tab.id === terminalSelection.terminalId)
    ) {
      setTerminalSelection(null);
    }
  }, [tabs, terminalSelection]);

  const activeGroup =
    groups.find((group) => activeId !== null && group.terminalIds.includes(activeId)) ??
    groups[0];
  const visibleIds = activeGroup?.terminalIds ?? (activeId !== null ? [activeId] : []);
  const direction = activeGroup?.direction ?? "horizontal";
  const splitDisabled = visibleIds.length >= MAX_TERMINALS_PER_GROUP;

  return (
    <section
      aria-label="Terminal drawer"
      className={cn(
        "relative flex shrink-0 flex-col border-border border-t bg-background pb-(--app-safe-area-bottom)",
        closing ? "drawer-exit" : "drawer-enter",
      )}
      onAnimationEnd={(event) => {
        if (closing && event.target === event.currentTarget) onExited();
      }}
      style={{ height: clampHeight(previewHeight ?? height) }}
    >
      <HeightHandle
        api={api}
        height={previewHeight ?? height}
        onEpoch={() => setResizeEpoch((value) => value + 1)}
        onPreview={setPreviewHeight}
      />
      <div className="flex h-8 min-h-8 shrink-0 items-center gap-1 border-border border-b px-2">
        <TabStrip activeId={activeId} api={api} tabs={tabs} />
        <span className="hidden shrink-0 truncate font-mono text-[.6875rem] text-muted-foreground sm:block">
          {shellLabel}
          {cwdLabel !== null && ` · ${cwdLabel}`}
        </span>
        {host.remote && (
          <Badge size="sm" variant="info">
            {host.label}
          </Badge>
        )}
        {sampleMode && (
          <Badge size="sm" variant="outline">
            Sample shell
          </Badge>
        )}
        <Button
          aria-label="Add terminal selection to working set"
          disabled={terminalSelection === null}
          onClick={() => {
            if (terminalSelection === null) return;
            const item = captureTerminalContext(sessionId, terminalSelection);
            if (item !== null) {
              actionRegistry.execute({ id: "context.capture", args: { sessionId, item } });
            }
          }}
          size="xs"
          title="Add only the selected terminal text to the next new message"
          variant="outline"
        >
          <Layers3 aria-hidden="true" />
          <span className="hidden sm:inline">Add selection</span>
        </Button>
        <IconButton
          aria-label={
            splitDisabled
              ? `Split right (max ${MAX_TERMINALS_PER_GROUP} panes)`
              : "Split right"
          }
          disabled={splitDisabled || tabs.length === 0}
          onClick={() => api.getState().splitActiveGroup("horizontal")}
          size="icon-xs"
        >
          <SquareSplitHorizontal />
        </IconButton>
        <IconButton
          aria-label={
            splitDisabled ? `Split down (max ${MAX_TERMINALS_PER_GROUP} panes)` : "Split down"
          }
          disabled={splitDisabled || tabs.length === 0}
          onClick={() => api.getState().splitActiveGroup("vertical")}
          size="icon-xs"
        >
          <SquareSplitVertical />
        </IconButton>
        <IconButton
          aria-label="New shell"
          onClick={() => api.getState().openTerminal()}
          size="icon-xs"
        >
          <Plus />
        </IconButton>
        <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
        <IconButton
          aria-label="Close terminal drawer"
          onClick={() => workspaceStore.getState().setTerminalDrawerOpen(sessionId, false)}
          size="icon-xs"
        >
          <X />
        </IconButton>
      </div>
      {tabs.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-muted-foreground text-sm">
            No shells yet. They run on {host.remote ? host.label : "the project's host"},
            separate from anything the session does on its own.
          </p>
          <Button onClick={() => api.getState().openTerminal()} size="sm" variant="outline">
            New shell
          </Button>
        </div>
      ) : (
        <>
          <div
            className="grid min-h-0 flex-1"
            style={
              direction === "vertical"
                ? { gridTemplateRows: `repeat(${visibleIds.length}, minmax(0, 1fr))` }
                : { gridTemplateColumns: `repeat(${visibleIds.length}, minmax(0, 1fr))` }
            }
          >
            {visibleIds.map((terminalId) => (
              <div
                className={cn(
                  "min-h-0 min-w-0 p-1",
                  direction === "vertical"
                    ? "border-border border-t first:border-t-0"
                    : "border-border border-s first:border-s-0",
                  terminalId === activeId &&
                    visibleIds.length > 1 &&
                    "bg-secondary/30 inset-ring-1 inset-ring-border",
                )}
                key={terminalId}
                onMouseDown={() => {
                  if (terminalId !== activeId) api.getState().setActiveTerminal(terminalId);
                }}
              >
                <TerminalViewport
                  active={terminalId === activeId}
                  api={api}
                  onSelectionChange={handleSelectionChange}
                  resizeEpoch={resizeEpoch + (previewHeight ?? height)}
                  terminalId={terminalId}
                />
              </div>
            ))}
          </div>
          <NoticeStrip api={api} />
        </>
      )}
      {pendingPaste !== null && (
        <PasteGuardDialog api={api} hostLabel={host.label} pending={pendingPaste} />
      )}
    </section>
  );
}

export function TerminalDrawer({ sessionId, open }: TerminalDrawerProps) {
  const api = getTerminalStore(sessionId);
  const reducedMotion = useReducedMotion();
  // Close click plays a short content exit (opacity/4px, transform-only so
  // the PTY box never resizes mid-animation), then unmounts: the height
  // snap and terminal refit happen exactly once. Reduced motion unmounts
  // immediately; reopening mid-exit cancels the exit.
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) setRendered(true);
    else if (reducedMotion) setRendered(false);
  }, [open, reducedMotion]);
  if (!open && !rendered) return null;
  if (api === null) return null;
  if (!open && reducedMotion) return null;
  return (
    <DrawerBody
      api={api}
      closing={!open}
      onExited={() => setRendered(false)}
      sessionId={sessionId}
    />
  );
}
