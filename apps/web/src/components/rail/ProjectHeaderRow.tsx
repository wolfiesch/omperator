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
  CheckCheck,
  EyeOff,
  FolderSearch,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  UsersRound,
  X,
} from "lucide-react";
import { type FormEvent, useCallback, useRef, useState } from "react";
import type { SessionListView } from "../../lib/workspace-data.ts";
import { type ProjectGroup, type SessionRow } from "../../lib/session-tree.ts";
import { createLiveSession } from "../../features/session-runtime/live-create.ts";
import {
  archiveLiveSession,
  managementCommandSupport,
  projectRevealSupport,
  revealLiveProject,
  sessionCreateSupport,
} from "../../features/session-runtime/session-management.ts";
import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import {
  requiresProfileChoiceForCreate,
  resolveLiveProject,
  resolveLiveProjectCreateTargets,
  resolveLiveSession,
} from "../../platform/live-workspace.ts";
import { useWorkspaceRuntimeSnapshot } from "../../state/shell-data.ts";
import { workspaceStore } from "../../state/store-instance.ts";

export function ProjectHeaderRow({
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
