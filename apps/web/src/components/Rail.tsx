// Project/session rail: grouped rows with explicit state, unread and
// pending-approval markers, keyboard roving, and a collapsed icon strip.
// Row/grouping interaction follows T3's sidebar; rendering is token-native.
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  Spinner,
  StatusPill,
  Tooltip,
  TooltipPopup,
  TooltipTrigger,
} from "@t4-code/ui";
import { Popover } from "@base-ui/react/popover";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleStop,
  CheckCheck,
  EyeOff,
  FolderSearch,
  Folder,
  Inbox,
  LayoutList,
  ListFilter,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SessionListView, WorkspaceSession } from "../lib/workspace-data.ts";
import {
  flattenProjectGroups,
  formatRelativeTime,
  moveIdInManualOrder,
  moveIdToManualIndex,
  type ProjectGroup,
  type RailFilter,
  type RailOrganization,
  type RailSort,
  type SessionRow,
} from "../lib/session-tree.ts";
import { composerStore } from "../features/composer/composer-store.ts";
import { createLiveSession } from "../features/session-runtime/live-create.ts";
import {
  archiveLiveSession,
  deleteLiveSession,
  managementCommandSupport,
  projectRevealSupport,
  revealLiveProject,
  renameLiveSession,
  restoreLiveSession,
  sessionCreateSupport,
  terminateLiveSession,
} from "../features/session-runtime/session-management.ts";
import { resolveSessionManagementNavigation } from "../features/session-runtime/session-navigation.ts";
import { presentSessionControlKind } from "../features/session-runtime/session-observer.ts";
import { desktopRuntime } from "../platform/desktop-runtime.ts";
import {
  deriveWorkspaceData,
  requiresProfileChoiceForCreate,
  resolveLiveProject,
  resolveLiveProjectCreateTargets,
  resolveLiveSession,
} from "../platform/live-workspace.ts";
import { useWorkspaceRuntimeSnapshot } from "../state/shell-data.ts";
import { useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { SessionListTabs } from "./SessionListTabs.tsx";

export function describeSessionState(session: WorkspaceSession): string {
  if (session.freshness === "offline") return "Offline";
  if (session.freshness === "cached") return "Cached";
  // Owner kind is never proven across the wire, so labels stay generic —
  // and only a confirmed live lock reads "Active elsewhere".
  if (session.control !== undefined) return presentSessionControlKind(session.control).railLabel;
  if (session.status !== null) return "";
  if (session.lifecycle === "idle") return "Idle";
  if (session.lifecycle === "closed") return "Stopped";
  return "Status unknown";
}

type SessionDialog = "rename" | "terminate" | "delete" | null;
type SessionAction = "rename" | "terminate" | "archive" | "restore" | "delete";

function SessionRowItem({
  row,
  active,
  index,
  nowMs,
  runtimeSnapshot,
  onAnnounce,
  contextLabel,
  manual,
  canMoveUp,
  canMoveDown,
  onMove,
  onDrop,
}: {
  row: SessionRow;
  active: boolean;
  index: number;
  nowMs: number;
  runtimeSnapshot: ReturnType<typeof useWorkspaceRuntimeSnapshot>;
  onAnnounce: (message: string) => void;
  contextLabel?: string;
  manual?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMove?: (direction: -1 | 1) => void;
  onDrop?: (sourceId: string) => void;
}) {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  const { session } = row;
  const pinned = useWorkspace((state) => state.pinnedSessionIds[session.id] === true);
  const stateLabel = describeSessionState(session);
  const ariaState = stateLabel !== "" ? stateLabel : (session.status ?? "Status unknown");
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<SessionDialog>(null);
  const [renameValue, setRenameValue] = useState(session.title);
  const [deleteValue, setDeleteValue] = useState("");
  const [pending, setPending] = useState<SessionAction | null>(null);
  const pendingRef = useRef<SessionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address =
    runtimeSnapshot === null ? null : resolveLiveSession(runtimeSnapshot, session.id);
  const archived = session.archivedAt !== undefined;

  const support = (
    command:
      | "session.rename"
      | "session.close"
      | "session.archive"
      | "session.restore"
      | "session.delete",
  ) =>
    runtimeSnapshot === null || address === null
      ? { supported: false, reason: "Connect to this host to manage the session" }
      : managementCommandSupport(runtimeSnapshot, address, command);
  const renameSupport = support("session.rename");
  const terminateSupport = support("session.close");
  const archiveSupport = support("session.archive");
  const restoreSupport = support("session.restore");
  const deleteSupport = support("session.delete");
  const workingReason =
    archiveSupport.reason === "Terminate the runtime before archiving or deleting it" ||
    deleteSupport.reason === "Terminate the runtime before archiving or deleting it"
      ? "Terminate the runtime before archiving or deleting it"
      : null;

  const runAction = useCallback(
    async (action: SessionAction) => {
      if (pendingRef.current !== null || controller === null || address === null) return;
      pendingRef.current = action;
      setPending(action);
      setError(null);
      try {
        if (action === "rename") await renameLiveSession(controller, address, renameValue);
        else if (action === "terminate") await terminateLiveSession(controller, address);
        else if (action === "archive") await archiveLiveSession(controller, address);
        else if (action === "restore") await restoreLiveSession(controller, address);
        else await deleteLiveSession(controller, address);
        // Archive/restore preserves the same draft contract as A to B to A.
        // Only confirmed permanent deletion releases its staged blob URLs.
        if (action === "delete") {
          composerStore.getState().disposeSession(session.id);
        }
        const verb =
          action === "rename"
            ? "renamed"
            : action === "terminate"
              ? "runtime terminated"
              : action === "archive"
                ? "archived"
                : action === "restore"
                  ? "restored"
                  : "permanently deleted";
        onAnnounce(`${session.title} ${verb}.`);
        setMenuOpen(false);
        setDialog(null);
        if (action !== "rename" && action !== "terminate") {
          const navigation = resolveSessionManagementNavigation(
            action,
            session,
            deriveWorkspaceData(controller.getSnapshot()).sessions,
            active,
          );
          workspaceStore.getState().setSessionListView(navigation.view);
          if (navigation.navigate) {
            workspaceStore.getState().setRailOverlayOpen(false);
            if (navigation.destinationSessionId === null) void navigate({ to: "/" });
            else
              void navigate({
                params: { sessionId: navigation.destinationSessionId },
                to: "/sessions/$sessionId",
              });
          }
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session action failed.");
      } finally {
        pendingRef.current = null;
        setPending(null);
      }
    },
    [active, address, controller, navigate, onAnnounce, renameValue, session.id, session.title],
  );

  const menuItem = (
    action: SessionAction,
    label: string,
    icon: ReactNode,
    available: { readonly supported: boolean; readonly reason: string | null },
  ) => (
    <button
      aria-disabled={!available.supported || pending !== null}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
        available.supported && pending === null
          ? "cursor-pointer hover:bg-accent"
          : "cursor-not-allowed text-muted-foreground opacity-64",
        action === "delete" && available.supported && "text-destructive-foreground",
      )}
      onClick={() => {
        if (!available.supported || pending !== null) return;
        if (action === "rename") {
          setRenameValue(session.title);
          setDialog("rename");
          setMenuOpen(false);
        } else if (action === "terminate") {
          setError(null);
          setDialog("terminate");
          setMenuOpen(false);
        } else if (action === "delete") {
          setDeleteValue("");
          setDialog("delete");
          setMenuOpen(false);
        } else void runAction(action);
      }}
      title={available.reason ?? undefined}
      type="button"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        {!available.supported && available.reason !== null && (
          <span className="text-muted-foreground text-xs leading-snug">{available.reason}</span>
        )}
      </span>
    </button>
  );

  return (
    <div
      aria-roledescription={manual ? "sortable session" : undefined}
      className={cn("flex min-w-0 flex-col", manual && "cursor-grab active:cursor-grabbing")}
      data-session-item={session.id}
      draggable={manual}
      onDragOver={(event) => {
        if (!manual) return;
        event.stopPropagation();
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragStart={(event) => {
        if (!manual) return;
        event.stopPropagation();
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `session:${session.id}`);
      }}
      onDrop={(event) => {
        if (!manual || onDrop === undefined) return;
        event.stopPropagation();
        event.preventDefault();
        const value = event.dataTransfer.getData("text/plain");
        if (value.startsWith("session:")) onDrop(value.slice("session:".length));
      }}
    >
      <div
        className={cn(
          "group/session relative flex min-w-0 items-stretch rounded-md transition-colors duration-(--motion-duration-fast)",
          active ? "bg-secondary shadow-[inset_2px_0_0_0_var(--color-brand)]" : "hover:bg-accent",
          session.freshness === "offline" && "opacity-72",
        )}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-current={active ? "true" : undefined}
                aria-label={`${session.title}, ${session.model}, ${archived ? "archived, " : ""}${ariaState}${row.unread ? ", unread" : ""}`}
                className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                data-session-row={session.id}
                onClick={() => {
                  workspaceStore.getState().setRailOverlayOpen(false);
                  void navigate({
                    params: { sessionId: session.id },
                    to: "/sessions/$sessionId",
                  });
                }}
                tabIndex={index === 0 ? 0 : -1}
                type="button"
              >
                <span className="flex w-full items-center gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 flex-1 line-clamp-2 break-words text-foreground text-sm leading-5",
                      active ? "font-semibold" : "font-medium",
                    )}
                  >
                    {session.title}
                  </span>
                  {session.pendingApprovals > 0 && (
                    <Badge
                      aria-label={`${session.pendingApprovals} waiting for approval`}
                      className="shrink-0"
                      variant="warning"
                    >
                      {session.pendingApprovals}
                    </Badge>
                  )}
                  {row.unread && (
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-brand" />
                  )}
                </span>
                <span className="flex w-full items-center gap-1 text-xs text-muted-foreground leading-4">
                  {contextLabel !== undefined && (
                    <>
                      <span className="max-w-24 truncate">{contextLabel}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span className="shrink-0">{formatRelativeTime(session.updatedAt, nowMs)}</span>
                  <span className="min-w-0 flex-1" />
                  {session.status !== null ? (
                    <StatusPill className="shrink-0 gap-1" status={session.status} />
                  ) : (
                    stateLabel !== "" && <span className="shrink-0">{stateLabel}</span>
                  )}
                </span>
              </button>
            }
          />
          <TooltipPopup className="max-w-72" collisionPadding={8} side="right">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{session.title}</span>
              <span className="break-words font-mono text-muted-foreground">{session.model}</span>
            </span>
          </TooltipPopup>
        </Tooltip>
        <div className="flex shrink-0 items-stretch sm:pointer-events-none sm:absolute sm:inset-y-0 sm:right-8 sm:z-10 sm:bg-linear-to-l sm:from-(--sidebar-background) sm:from-70% sm:to-transparent sm:pl-5 sm:opacity-0 sm:transition-opacity sm:group-hover/session:pointer-events-auto sm:group-hover/session:opacity-100 sm:focus-within:pointer-events-auto sm:focus-within:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={`${pinned ? "Unpin" : "Pin"} chat ${session.title}`}
                  className="flex min-h-11 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:w-7"
                  disabled={pending !== null}
                  onClick={() => {
                    workspaceStore.getState().setSessionPinned(session.id, !pinned);
                    onAnnounce(`${session.title} ${pinned ? "unpinned" : "pinned"}.`);
                  }}
                  type="button"
                >
                  {pinned ? (
                    <PinOff aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Pin aria-hidden="true" className="size-3.5" />
                  )}
                </button>
              }
            />
            <TooltipPopup side="right">{pinned ? "Unpin chat" : "Pin chat"}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-disabled={
                    pending !== null ||
                    (archived ? !restoreSupport.supported : !archiveSupport.supported)
                  }
                  aria-label={`${archived ? "Restore" : "Archive"} chat ${session.title}`}
                  className={cn(
                    "flex min-h-11 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:w-7",
                    pending === null &&
                      (archived ? restoreSupport.supported : archiveSupport.supported)
                      ? "cursor-pointer hover:text-foreground"
                      : "cursor-not-allowed opacity-48",
                  )}
                  onClick={() => {
                    const available = archived
                      ? restoreSupport.supported
                      : archiveSupport.supported;
                    if (!available || pending !== null) return;
                    void runAction(archived ? "restore" : "archive");
                  }}
                  title={(archived ? restoreSupport.reason : archiveSupport.reason) ?? undefined}
                  type="button"
                >
                  {pending === (archived ? "restore" : "archive") ? (
                    <Spinner className="size-3.5" />
                  ) : archived ? (
                    <RotateCcw aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Archive aria-hidden="true" className="size-3.5" />
                  )}
                </button>
              }
            />
            <TooltipPopup side="right">{archived ? "Restore chat" : "Archive chat"}</TooltipPopup>
          </Tooltip>
        </div>
        <Popover.Root onOpenChange={setMenuOpen} open={menuOpen}>
          <Popover.Trigger
            aria-label={`Actions for ${session.title}`}
            className="flex min-h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:w-8"
            disabled={pending !== null}
          >
            {pending === null ? (
              <MoreHorizontal aria-hidden="true" className="size-4" />
            ) : (
              <Spinner className="size-3.5" />
            )}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
              <Popover.Popup className="max-h-[min(22rem,calc(100dvh-1rem))] w-[min(15rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                <Popover.Title className="truncate px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
                  {session.title}
                </Popover.Title>
                <button
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  onClick={() => {
                    workspaceStore.getState().setSessionPinned(session.id, !pinned);
                    onAnnounce(`${session.title} ${pinned ? "unpinned" : "pinned"}.`);
                    setMenuOpen(false);
                  }}
                  type="button"
                >
                  {pinned ? (
                    <PinOff aria-hidden="true" className="size-4" />
                  ) : (
                    <Pin aria-hidden="true" className="size-4" />
                  )}
                  {pinned ? "Unpin session" : "Pin session"}
                </button>
                {manual && onMove !== undefined && (
                  <>
                    <button
                      aria-disabled={!canMoveUp}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        canMoveUp
                          ? "cursor-pointer hover:bg-accent"
                          : "cursor-not-allowed opacity-48",
                      )}
                      onClick={() => {
                        if (!canMoveUp) return;
                        onMove(-1);
                        setMenuOpen(false);
                      }}
                      type="button"
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                      Move up
                    </button>
                    <button
                      aria-disabled={!canMoveDown}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        canMoveDown
                          ? "cursor-pointer hover:bg-accent"
                          : "cursor-not-allowed opacity-48",
                      )}
                      onClick={() => {
                        if (!canMoveDown) return;
                        onMove(1);
                        setMenuOpen(false);
                      }}
                      type="button"
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                      Move down
                    </button>
                  </>
                )}
                {!archived &&
                  menuItem(
                    "rename",
                    "Rename",
                    <Pencil aria-hidden="true" className="size-4" />,
                    renameSupport,
                  )}
                {!archived &&
                  menuItem(
                    "terminate",
                    "Terminate runtime",
                    <CircleStop aria-hidden="true" className="size-4" />,
                    terminateSupport,
                  )}
                {archived
                  ? menuItem(
                      "restore",
                      "Restore",
                      <RotateCcw aria-hidden="true" className="size-4" />,
                      restoreSupport,
                    )
                  : menuItem(
                      "archive",
                      "Archive",
                      <Archive aria-hidden="true" className="size-4" />,
                      archiveSupport,
                    )}
                {menuItem(
                  "delete",
                  "Permanently delete",
                  <Trash2 aria-hidden="true" className="size-4" />,
                  deleteSupport,
                )}
                {workingReason !== null && (
                  <p className="border-border border-t px-2 pt-2 pb-1 text-muted-foreground text-xs">
                    {workingReason}
                  </p>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {error !== null && (
        <p className="px-2 pt-1 text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      )}

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "rename"}
      >
        <DialogPopup
          aria-label={`Rename ${session.title}`}
          className="max-w-sm"
          showCloseButton={false}
        >
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void runAction("rename");
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-base">Rename session</DialogTitle>
              <DialogDescription>
                Use a short name you will recognize in this working folder.
              </DialogDescription>
              <label className="flex flex-col gap-1 pt-2">
                <span className="font-medium text-muted-foreground text-xs">Session name</span>
                <input
                  autoFocus
                  className="h-11 rounded-lg border border-input bg-input/32 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
                  maxLength={512}
                  onChange={(event) => setRenameValue(event.target.value)}
                  value={renameValue}
                />
              </label>
              {error !== null && (
                <p className="text-destructive-foreground text-xs" role="alert">
                  {error}
                </p>
              )}
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    className="min-h-11 sm:min-h-8"
                    disabled={pending !== null}
                    size="sm"
                    variant="ghost"
                  />
                }
              >
                Cancel
              </DialogClose>
              <Button
                className="min-h-11 sm:min-h-8"
                disabled={pending !== null || renameValue.trim().length === 0}
                size="sm"
                type="submit"
              >
                {pending === "rename" && <Spinner />}
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "terminate"}
      >
        <DialogPopup
          aria-label={`Terminate runtime for ${session.title}`}
          className="max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-base">
              Terminate runtime for “{session.title}”?
            </DialogTitle>
            <DialogDescription>
              This stops the process handling this session and ends any in-flight turn. The
              transcript, draft, artifacts, and generated output stay intact. Archive or delete only
              after the host reports the runtime closed.
            </DialogDescription>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  className="min-h-11 sm:min-h-8"
                  disabled={pending !== null}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              Keep runtime
            </DialogClose>
            <Button
              className="min-h-11 sm:min-h-8"
              disabled={pending !== null}
              onClick={() => void runAction("terminate")}
              size="sm"
              variant="destructive"
            >
              {pending === "terminate" && <Spinner />}
              Terminate runtime
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        open={dialog === "delete"}
      >
        <DialogPopup
          aria-label={`Permanently delete ${session.title}`}
          className="max-w-md"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle className="text-base">Permanently delete “{session.title}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes the session, transcript, artifacts, and generated output. It
              cannot be undone.
            </DialogDescription>
            <label className="flex flex-col gap-1 pt-2">
              <span className="font-medium text-muted-foreground text-xs">
                Type the exact session title to confirm
              </span>
              <input
                autoComplete="off"
                autoFocus
                className="h-11 rounded-lg border border-input bg-input/32 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
                onChange={(event) => setDeleteValue(event.target.value)}
                value={deleteValue}
              />
            </label>
            {error !== null && (
              <p className="text-destructive-foreground text-xs" role="alert">
                {error}
              </p>
            )}
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={
                <Button
                  className="min-h-11 sm:min-h-8"
                  disabled={pending !== null}
                  size="sm"
                  variant="ghost"
                />
              }
            >
              Keep session
            </DialogClose>
            <Button
              className="min-h-11 sm:min-h-8"
              disabled={pending !== null || deleteValue !== session.title}
              onClick={() => void runAction("delete")}
              size="sm"
              variant="destructive"
            >
              {pending === "delete" && <Spinner />}
              Permanently delete
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function ProjectHeaderRow({
  group,
  actionSessions,
  allowCreate,
  shortcutHidden,
  onDismiss,
  onRestore,
  pinned,
  manual,
  canMoveUp,
  canMoveDown,
  onMove,
  onDrop,
  onPin,
  onAnnounce,
  runtimeSnapshot,
  view,
}: {
  group: ProjectGroup;
  actionSessions: readonly SessionRow[];
  allowCreate: boolean;
  shortcutHidden: boolean;
  onDismiss: () => void;
  onRestore: () => void;
  pinned: boolean;
  manual: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onDrop: (sourceId: string) => void;
  onPin: () => void;
  onAnnounce: (message: string) => void;
  runtimeSnapshot: ReturnType<typeof useWorkspaceRuntimeSnapshot>;
  view: SessionListView;
}) {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  const [pending, setPending] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(group.displayName);
  const [menuOpen, setMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disclosureRef = useRef<HTMLButtonElement | null>(null);

  const snapshot = runtimeSnapshot;
  const address = snapshot !== null ? resolveLiveProject(snapshot, group.project.id) : null;
  const createTargets =
    snapshot === null
      ? []
      : resolveLiveProjectCreateTargets(snapshot, group.project.id).filter(
          (target) => sessionCreateSupport(snapshot, target.address).supported,
        );
  const createSupport =
    createTargets.length > 0
      ? { supported: true, reason: null }
      : address !== null && snapshot !== null
        ? sessionCreateSupport(snapshot, address)
        : { supported: false, reason: "Connect to this host to create a session" };
  const projectIsLocal =
    snapshot !== null &&
    address !== null &&
    snapshot.targets.get(address.targetId)?.kind === "local";
  const revealSupport =
    snapshot !== null && address !== null
      ? projectRevealSupport(snapshot, address)
      : { supported: false, reason: "Connect to this host to reveal the project" };
  const configuredLocalProfiles =
    projectIsLocal && snapshot !== null
      ? [...snapshot.targets.values()].filter((target) => target.kind === "local")
      : [];
  // Every configured local profile that cannot create here right now is still
  // shown, with why: disconnected profiles say so, connected-but-unsupported
  // profiles surface the host's reason.
  const unavailableLocalProfiles =
    snapshot === null || address === null
      ? []
      : configuredLocalProfiles
          .filter(
            (profile) =>
              !createTargets.some((target) => target.address.targetId === profile.targetId),
          )
          .map((profile) => {
            if (snapshot.connections.get(profile.targetId) !== "connected") {
              return { label: profile.label, reason: "Not connected", targetId: profile.targetId };
            }
            const hostId = snapshot.targetHosts.get(profile.targetId);
            const support =
              hostId === undefined
                ? null
                : sessionCreateSupport(snapshot, {
                    hostId,
                    projectId: address.projectId,
                    targetId: profile.targetId,
                  });
            return {
              label: profile.label,
              reason: support?.reason ?? "Unavailable",
              targetId: profile.targetId,
            };
          });
  const canCreate = allowCreate && createTargets.length > 0 && controller !== null && !pending;
  // Never fall back to an opaque direct create while other configured profiles
  // exist or nothing can create: the chooser stays, listing each configured
  // profile as available or unavailable and linking host management.
  const chooseCreateProfile =
    requiresProfileChoiceForCreate(createTargets) ||
    configuredLocalProfiles.length > 1 ||
    (projectIsLocal && createTargets.length === 0);
  // The chooser opens whenever it has something to show — even when no target
  // can create right now, it explains why and links host management. Only the
  // per-profile create rows are gated on a live connection.
  const createMenuAvailable =
    allowCreate && !pending && (canCreate || configuredLocalProfiles.length > 0);
  const emptyCurrentProject = view === "current" && group.sessions.length === 0;
  const inventoryTruncated = group.host.sessionInventoryTruncated === true;
  const showShortcutAction = emptyCurrentProject || (view === "archived" && shortcutHidden);

  const markAllRead = () => {
    const visits = Object.fromEntries(
      actionSessions.map(({ session }) => [
        session.id,
        session.latestTurnCompletedAt ?? session.updatedAt,
      ]),
    );
    workspaceStore.getState().markSessionsVisited(visits);
    onAnnounce(`Marked all sessions in ${group.displayName} as read.`);
    setMenuOpen(false);
  };

  const archiveAll = async () => {
    if (controller === null || snapshot === null || pending) return;
    const candidates = actionSessions.flatMap(({ session }) => {
      const sessionAddress = resolveLiveSession(snapshot, session.id);
      if (sessionAddress === null) return [];
      const support = managementCommandSupport(snapshot, sessionAddress, "session.archive");
      return support.supported ? [{ session, address: sessionAddress }] : [];
    });
    if (candidates.length === 0) {
      setError("No sessions in this project can be archived right now.");
      return;
    }
    setPending(true);
    setError(null);
    let completed = 0;
    try {
      for (const candidate of candidates) {
        await archiveLiveSession(controller, candidate.address);
        completed += 1;
      }
      onAnnounce(`Archived ${completed} sessions in ${group.displayName}.`);
      setMenuOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Project archive failed.";
      setError(`${completed} archived before the operation stopped. ${message}`);
    } finally {
      setPending(false);
    }
  };

  const revealProject = async () => {
    if (controller === null || address === null || pending || !revealSupport.supported) return;
    setPending(true);
    setError(null);
    try {
      await revealLiveProject(controller, address);
      onAnnounce(`Revealed ${group.displayName} in Finder.`);
      setMenuOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Project reveal failed.");
    } finally {
      setPending(false);
    }
  };

  const handleCreate = useCallback(
    async (targetAddress: NonNullable<typeof address>) => {
      if (!canCreate || controller === null) return;
      setPending(true);
      setError(null);
      try {
        const result = await createLiveSession(controller, targetAddress);
        setCreateMenuOpen(false);
        workspaceStore.getState().setRailOverlayOpen(false);
        void navigate({ params: { sessionId: result.viewId }, to: "/sessions/$sessionId" });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Session creation failed.");
      } finally {
        setPending(false);
      }
    },
    [canCreate, controller, navigate],
  );

  return (
    <div
      aria-roledescription={manual ? "sortable project" : undefined}
      className={cn("flex flex-col", manual && "cursor-grab active:cursor-grabbing")}
      data-project-drag-handle={group.project.id}
      draggable={manual}
      onDragOver={(event) => {
        if (!manual) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDragStart={(event) => {
        if (!manual) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `project:${group.project.id}`);
      }}
      onDrop={(event) => {
        if (!manual) return;
        event.preventDefault();
        const value = event.dataTransfer.getData("text/plain");
        if (value.startsWith("project:")) onDrop(value.slice("project:".length));
      }}
    >
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-expanded={group.expanded}
                aria-label={`${group.displayName}, ${group.sessions.length} ${group.sessions.length === 1 ? "session" : "sessions"}${group.unreadCount > 0 ? `, ${group.unreadCount} unread` : ""}`}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background sm:min-h-0"
                data-project-disclosure={group.project.id}
                onClick={() =>
                  workspaceStore.getState().setProjectExpanded(group.project.id, !group.expanded)
                }
                ref={disclosureRef}
                type="button"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
                    group.expanded && "rotate-90",
                  )}
                />
                <span className="min-w-0 flex-1 line-clamp-2 break-words font-medium text-foreground text-xs leading-4">
                  {group.displayName}
                </span>
                {group.host.kind === "remote" && (
                  <Cable aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                )}
                {group.host.kind === "local" &&
                  group.host.profileId !== undefined &&
                  group.host.profileId !== "default" && (
                    <UsersRound
                      aria-hidden="true"
                      className="size-3 shrink-0 text-muted-foreground"
                    />
                  )}
                {!group.expanded && group.unreadCount > 0 && (
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-brand" />
                )}
                {!group.expanded && group.groupStatus !== null && (
                  <StatusPill className="shrink-0" labelHidden status={group.groupStatus} />
                )}
                <span className="shrink-0 text-xs text-muted-foreground leading-4">
                  {group.sessions.length}
                </span>
              </button>
            }
          />
          <TooltipPopup className="max-w-72" collisionPadding={8} side="right">
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{group.displayName}</span>
              <span className="break-words text-muted-foreground">
                {group.host.kind === "remote" ? "Remote host" : "Host profile"}: {group.host.name}
              </span>
            </span>
          </TooltipPopup>
        </Tooltip>
        {allowCreate && chooseCreateProfile ? (
          <Popover.Root onOpenChange={setCreateMenuOpen} open={createMenuOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Popover.Trigger
                    aria-label={`New session in ${group.displayName} — choose the OMP profile that will own it`}
                    className="flex h-11 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 font-medium text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:px-1.5"
                    disabled={!createMenuAvailable}
                  >
                    {pending ? (
                      <Spinner className="size-3" />
                    ) : (
                      <Plus aria-hidden="true" className="size-3" />
                    )}
                    New
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </Popover.Trigger>
                }
              />
              <TooltipPopup side="right">Choose the OMP profile for a new session</TooltipPopup>
            </Tooltip>
            <Popover.Portal>
              <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
                <Popover.Popup className="w-[min(15rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                  <Popover.Title className="truncate px-2 pt-1 font-medium text-xs">
                    New session in {group.displayName}
                  </Popover.Title>
                  <Popover.Description className="px-2 pb-1.5 text-muted-foreground text-xs leading-snug">
                    The OMP profile you choose will own this session.
                  </Popover.Description>
                  {createTargets.map((target) => (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      disabled={pending}
                      key={target.address.targetId}
                      onClick={() => void handleCreate(target.address)}
                      type="button"
                    >
                      <UsersRound
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">{target.label}</span>
                        {target.profileId !== undefined && (
                          <span className="truncate font-mono text-muted-foreground text-[11px]">
                            {target.profileId}
                          </span>
                        )}
                      </span>
                      {target.current && <Badge variant="outline">Current</Badge>}
                    </button>
                  ))}
                  {createTargets.length === 0 && (
                    <p className="px-2 py-1.5 text-muted-foreground text-xs leading-snug">
                      No connected profile can start a session here yet.
                    </p>
                  )}
                  {unavailableLocalProfiles.map((profile) => (
                    <div
                      aria-disabled="true"
                      className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left opacity-64 sm:min-h-8"
                      key={profile.targetId}
                    >
                      <UsersRound
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">{profile.label}</span>
                        <span className="truncate text-muted-foreground text-[11px]">
                          {profile.reason}
                        </span>
                      </span>
                    </div>
                  ))}
                  {(unavailableLocalProfiles.length > 0 || createTargets.length === 0) && (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        workspaceStore.getState().setRailOverlayOpen(false);
                        void navigate({ to: "/hosts" });
                      }}
                      type="button"
                    >
                      <Cable aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col py-1">
                        <span className="truncate text-sm">Open Hosts</span>
                        <span className="truncate text-muted-foreground text-[11px]">
                          Connect a profile to use it here
                        </span>
                      </span>
                    </button>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : allowCreate ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-disabled={!canCreate}
                  aria-label={`New session in ${group.displayName}`}
                  className={cn(
                    "flex h-11 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:h-6 sm:px-1.5",
                    canCreate
                      ? "cursor-pointer hover:bg-accent hover:text-foreground"
                      : "cursor-not-allowed opacity-64",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!canCreate) return;
                    const target = createTargets[0];
                    if (target !== undefined) void handleCreate(target.address);
                  }}
                  title={createSupport.reason ?? undefined}
                  type="button"
                >
                  {pending ? (
                    <Spinner className="size-3" />
                  ) : (
                    <Plus aria-hidden="true" className="size-3" />
                  )}
                  New
                </button>
              }
            />
            <TooltipPopup side="right">
              {createSupport.reason ?? `New session in ${group.displayName}`}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <Popover.Root onOpenChange={setMenuOpen} open={menuOpen}>
          <Popover.Trigger
            aria-label={`Actions for ${group.displayName}`}
            className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:size-6"
          >
            <MoreHorizontal aria-hidden="true" className="size-4" />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
              <Popover.Popup className="max-h-[min(22rem,calc(100dvh-1rem))] w-[min(17rem,calc(100vw-1rem))] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
                <Popover.Title className="truncate px-2 pt-1 pb-1.5 font-medium text-muted-foreground text-xs">
                  {group.displayName}
                </Popover.Title>
                <button
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  onClick={() => {
                    onPin();
                    setMenuOpen(false);
                  }}
                  type="button"
                >
                  {pinned ? (
                    <PinOff aria-hidden="true" className="size-4" />
                  ) : (
                    <Pin aria-hidden="true" className="size-4" />
                  )}
                  {pinned ? "Unpin project" : "Pin project"}
                </button>
                <button
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  onClick={() => {
                    setRenameValue(group.displayName);
                    setRenameOpen(true);
                    setMenuOpen(false);
                  }}
                  type="button"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  Rename project
                </button>
                <button
                  aria-disabled={!revealSupport.supported || pending}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                    revealSupport.supported && !pending
                      ? "cursor-pointer hover:bg-accent"
                      : "cursor-not-allowed text-muted-foreground opacity-64",
                  )}
                  onClick={() => void revealProject()}
                  title={revealSupport.reason ?? "Reveal this project in Finder"}
                  type="button"
                >
                  <FolderSearch aria-hidden="true" className="size-4 shrink-0" />
                  Reveal in Finder
                </button>
                <button
                  className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                  onClick={markAllRead}
                  type="button"
                >
                  <CheckCheck aria-hidden="true" className="size-4" />
                  Mark all as read
                </button>
                {view === "current" && group.sessions.length > 0 && (
                  <button
                    aria-disabled={pending}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                      pending ? "cursor-not-allowed opacity-64" : "cursor-pointer hover:bg-accent",
                    )}
                    onClick={() => void archiveAll()}
                    type="button"
                  >
                    {pending ? (
                      <Spinner className="size-4" />
                    ) : (
                      <Archive aria-hidden="true" className="size-4" />
                    )}
                    Archive chats
                  </button>
                )}
                {manual && (
                  <>
                    <button
                      aria-disabled={!canMoveUp}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        canMoveUp
                          ? "cursor-pointer hover:bg-accent"
                          : "cursor-not-allowed opacity-48",
                      )}
                      onClick={() => {
                        if (!canMoveUp) return;
                        onMove(-1);
                        setMenuOpen(false);
                      }}
                      type="button"
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                      Move folder up
                    </button>
                    <button
                      aria-disabled={!canMoveDown}
                      className={cn(
                        "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        canMoveDown
                          ? "cursor-pointer hover:bg-accent"
                          : "cursor-not-allowed opacity-48",
                      )}
                      onClick={() => {
                        if (!canMoveDown) return;
                        onMove(1);
                        setMenuOpen(false);
                      }}
                      type="button"
                    >
                      <ArrowDown aria-hidden="true" className="size-4" />
                      Move folder down
                    </button>
                  </>
                )}
                {showShortcutAction &&
                  (emptyCurrentProject ? (
                    <button
                      aria-disabled={inventoryTruncated || pending || undefined}
                      className={cn(
                        "flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                        inventoryTruncated || pending
                          ? "cursor-not-allowed text-muted-foreground opacity-64"
                          : "cursor-pointer hover:bg-accent",
                      )}
                      onClick={() => {
                        if (inventoryTruncated || pending) return;
                        setMenuOpen(false);
                        onDismiss();
                      }}
                      type="button"
                    >
                      <X aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm">Remove shortcut</span>
                        <span className="block text-muted-foreground text-xs leading-snug">
                          {inventoryTruncated
                            ? "This host is showing a partial session list, so this shortcut can't be removed safely."
                            : "Only changes this T4 Code client. The folder and OMP sessions stay unchanged."}
                        </span>
                      </span>
                    </button>
                  ) : (
                    <button
                      className="flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                      onClick={() => {
                        setMenuOpen(false);
                        onRestore();
                        requestAnimationFrame(() =>
                          requestAnimationFrame(() => disclosureRef.current?.focus()),
                        );
                      }}
                      type="button"
                    >
                      <RotateCcw aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      <span className="min-w-0">
                        <span className="block text-sm">Show shortcut</span>
                        <span className="block text-muted-foreground text-xs leading-snug">
                          Makes the empty folder shortcut available in this client again.
                        </span>
                      </span>
                    </button>
                  ))}
                {view === "current" && !emptyCurrentProject && (
                  <button
                    className="flex min-h-11 w-full cursor-pointer items-start gap-2 rounded-md px-2 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                    onClick={() => {
                      setMenuOpen(false);
                      onDismiss();
                    }}
                    type="button"
                  >
                    <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      <span className="block text-sm">Remove</span>
                      <span className="block text-muted-foreground text-xs leading-snug">
                        Hides this project in T4. Files and sessions stay unchanged.
                      </span>
                    </span>
                  </button>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>
      {error !== null && (
        <p className="px-2 pt-0.5 text-destructive-foreground text-xs" role="alert">
          {error}
        </p>
      )}
      <Dialog onOpenChange={setRenameOpen} open={renameOpen}>
        <DialogPopup
          aria-label={`Rename ${group.displayName}`}
          className="max-w-sm"
          showCloseButton={false}
        >
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              const next = renameValue.trim();
              if (next.length === 0) return;
              workspaceStore
                .getState()
                .setProjectAlias(group.project.id, next === group.project.name ? null : next);
              setRenameOpen(false);
              onAnnounce(`Renamed project to ${next} in this T4 client.`);
            }}
          >
            <DialogHeader>
              <DialogTitle className="text-base">Rename project</DialogTitle>
              <DialogDescription>
                This changes only the name shown in T4. The folder on disk keeps its current name.
              </DialogDescription>
              <label className="flex flex-col gap-1 pt-2">
                <span className="font-medium text-muted-foreground text-xs">Project name</span>
                <input
                  autoFocus
                  className="h-11 rounded-lg border border-input bg-input/32 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-10"
                  maxLength={120}
                  onChange={(event) => setRenameValue(event.target.value)}
                  value={renameValue}
                />
              </label>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                render={<Button className="min-h-11 sm:min-h-8" size="sm" variant="ghost" />}
              >
                Cancel
              </DialogClose>
              <Button
                className="min-h-11 sm:min-h-8"
                disabled={renameValue.trim().length === 0}
                size="sm"
                type="submit"
              >
                Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
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

function RailOptionsMenu({
  hiddenGroups,
  organization,
  sort,
}: {
  hiddenGroups: readonly ProjectGroup[];
  organization: RailOrganization;
  sort: RailSort;
}) {
  const [open, setOpen] = useState(false);
  const option = (selected: boolean, label: string, onSelect: () => void) => (
    <button
      aria-pressed={selected}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
        selected && "bg-secondary font-medium",
      )}
      onClick={() => {
        onSelect();
        setOpen(false);
      }}
      type="button"
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", selected ? "bg-brand" : "bg-transparent")}
      />
      {label}
    </button>
  );

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger
        aria-label="Organize sessions"
        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <SlidersHorizontal aria-hidden="true" className="size-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={4}>
          <Popover.Popup className="w-[min(15rem,calc(100vw-1rem))] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-(--overlay-shadow) outline-none">
            <Popover.Title className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">
              Organize sidebar
            </Popover.Title>
            {option(organization === "by-project", "By project", () =>
              workspaceStore.getState().setRailOrganization("by-project"),
            )}
            {option(organization === "flat", "In one list", () =>
              workspaceStore.getState().setRailOrganization("flat"),
            )}
            <div className="my-1 border-border border-t" />
            <p className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">Sort by</p>
            {option(sort === "priority", "Priority", () =>
              workspaceStore.getState().setRailSort("priority"),
            )}
            {option(sort === "updated", "Last updated", () =>
              workspaceStore.getState().setRailSort("updated"),
            )}
            {option(sort === "manual", "Manual order", () =>
              workspaceStore.getState().setRailSort("manual"),
            )}
            {hiddenGroups.length > 0 && (
              <>
                <div className="my-1 border-border border-t" />
                <p className="px-2 pt-1 pb-1 font-medium text-muted-foreground text-xs">
                  Hidden projects
                </p>
                {hiddenGroups.map((group) => (
                  <button
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
                    key={group.project.id}
                    onClick={() => {
                      workspaceStore.getState().setProjectHidden(group.project.id, false);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <RotateCcw aria-hidden="true" className="size-4" />
                    <span className="min-w-0 flex-1 truncate">Show {group.displayName}</span>
                  </button>
                ))}
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

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
          <span className="ml-auto text-[10px] text-muted-foreground">{matchCount} matches</span>
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
                    `Restored ${group.displayName} to Projects on this T4 Code client.`,
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
