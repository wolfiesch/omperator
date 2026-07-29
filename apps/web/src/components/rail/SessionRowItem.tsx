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
  CircleStop,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useRef, useState } from "react";
import { formatRelativeTime, type SessionRow } from "../../lib/session-tree.ts";
import { composerStore } from "../../features/composer/composer-store.ts";
import {
  archiveLiveSession,
  deleteLiveSession,
  managementCommandSupport,
  renameLiveSession,
  restoreLiveSession,
  terminateLiveSession,
} from "../../features/session-runtime/session-management.ts";
import { resolveSessionManagementNavigation } from "../../features/session-runtime/session-navigation.ts";
import { presentSessionState } from "../../features/session-runtime/session-state.ts";
import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import { deriveWorkspaceData, resolveLiveSession } from "../../platform/live-workspace.ts";
import { useWorkspaceRuntimeSnapshot } from "../../state/shell-data.ts";
import { useWorkspace, workspaceStore } from "../../state/store-instance.ts";

type SessionDialog = "rename" | "terminate" | "delete" | null;
type SessionAction = "rename" | "terminate" | "archive" | "restore" | "delete";

export function SessionRowItem({
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
  const statePresentation = presentSessionState(session);
  const stateLabel = statePresentation.label;
  const ariaState = stateLabel;
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<SessionDialog>(null);
  const [renameValue, setRenameValue] = useState(session.title);
  const [deleteValue, setDeleteValue] = useState("");
  const [pending, setPending] = useState<SessionAction | null>(null);
  const pendingRef = useRef<SessionAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const address = runtimeSnapshot === null ? null : resolveLiveSession(runtimeSnapshot, session.id);
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
                  <span className="flex w-28 shrink-0 justify-end overflow-hidden">
                    {statePresentation.status !== null ? (
                      <StatusPill className="gap-1" status={statePresentation.status} />
                    ) : (
                      <span className="truncate">{stateLabel}</span>
                    )}
                  </span>
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
