// Center frame when no session is active. Browser mode teaches the two ways
// into the sample workspace. Desktop mode tells the truth about why there is
// nothing here — still connecting, a local service that needs attention, a
// genuinely empty host, or a bounded startup error — using the same status
// language as the onboarding service card. The sample-workspace copy never
// renders inside the desktop shell.
import type { DesktopRuntimeController, DesktopShellPort } from "@t4-code/client";
import {
  BrandLockup,
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@t4-code/ui";
import { History } from "lucide-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { desktopRuntime, useDesktopRuntimeSnapshot } from "../platform/desktop-runtime.ts";
import { ToneBadge } from "../features/onboarding/bits.tsx";
import { PairForm } from "../features/targets/TargetsScreen.tsx";
import { createTargetsStore, type TargetsStoreApi } from "../features/targets/targets-store.ts";
import {
  createHomeActions,
  deriveDesktopHomeState,
  deriveHomeServiceView,
  homeServiceRetryDelay,
  shouldInspectHomeService,
  shouldRetryHomeService,
  type HomeActions,
} from "../platform/home-state.ts";
import { rendererPlatform, workspaceStore } from "../state/store-instance.ts";

export function HomePane({ railOverlaid }: { railOverlaid: boolean }) {
  const snapshot = useDesktopRuntimeSnapshot();
  const controller = desktopRuntime();
  const shell = rendererPlatform.shell;
  if (snapshot === null || controller === null || shell === null) {
    return <BrowserHomePane railOverlaid={railOverlaid} />;
  }
  return <DesktopHomePane controller={controller} shell={shell} />;
}

// ---------------------------------------------------------------------------
// Desktop: honest zero-session states
// ---------------------------------------------------------------------------

function useHomeActions(shell: DesktopShellPort, controller: DesktopRuntimeController): HomeActions {
  return useMemo(() => {
    // Capture the optional port methods so calls never depend on `this`
    // binding inside the preload object.
    const inspect = shell.serviceInspect;
    const install = shell.serviceInstall;
    const start = shell.serviceStart;
    return createHomeActions({
      ...(inspect === undefined ? {} : { serviceInspect: () => inspect() }),
      ...(install === undefined ? {} : { serviceInstall: () => install() }),
      ...(start === undefined ? {} : { serviceStart: () => start() }),
      connectLocal: () => controller.connect("local"),
    });
  }, [shell, controller]);
}

function DesktopHomePane({
  controller,
  shell,
}: {
  readonly controller: DesktopRuntimeController;
  readonly shell: DesktopShellPort;
}) {
  const snapshot = useDesktopRuntimeSnapshot();
  const actions = useHomeActions(shell, controller);
  const targetsApi = useMemo(() => createTargetsStore(controller, {}), [controller]);
  const actionsState = useSyncExternalStore(actions.subscribe, actions.getState);
  const state = snapshot === null ? null : deriveDesktopHomeState(snapshot);
  const browserDirect = shell.serviceInspect === undefined;
  const needsInspection = state !== null && state.kind === "service";

  // Entering the service state reads the real service once. A failed read
  // settles visibly instead of being retriggered by its own pending-state
  // update (the old behavior produced a tight IPC loop).
  useEffect(() => {
    if (shouldInspectHomeService(needsInspection, shell.serviceInspect !== undefined, actionsState)) {
      void actions.run("inspect");
    }
  }, [needsInspection, shell, actions, actionsState]);

  // Recovery is paced independently of renders: 5s, 15s, 30s, then one
  // final retry at 60s. The action controller still deduplicates in-flight
  // work, and a successful read resets the finite budget.
  useEffect(() => {
    if (!shouldRetryHomeService(needsInspection, shell.serviceInspect !== undefined, actionsState)) return;
    const retry = setTimeout(() => {
      void actions.run("inspect", "automatic");
    }, homeServiceRetryDelay(actionsState.consecutiveInspectionFailures));
    return () => clearTimeout(retry);
  }, [needsInspection, shell, actions, actionsState]);

  if (state === null) return null;

  if (state.kind === "pairing-required") {
    return (
      <BrowserPairingPane
        api={targetsApi}
        label={state.label}
        targetId={state.targetId}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader px-3">
        <span className="font-medium text-muted-foreground text-xs">No session open</span>
      </div>
      {state.kind === "connecting" && (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia variant="default">
              <BrandLockup byline size="lg" />
            </EmptyMedia>
            <EmptyTitle>Connecting to this machine</EmptyTitle>
            <ToneBadge className="justify-center" label="Connecting" live tone="working" />
            <EmptyDescription>
              Looking for sessions on this machine. This usually takes a moment.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {state.kind === "empty" && (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyMedia variant="default">
              <BrandLockup byline size="lg" />
            </EmptyMedia>
            <EmptyTitle>{browserDirect ? "Choose a live session" : "No sessions yet"}</EmptyTitle>
            <EmptyDescription>
              {browserDirect
                ? "This Tailnet connection is live. Choose a session from the list on the left to inspect it."
                : "This machine is connected. Sessions you start here or from a paired device appear in the list on the left the moment they exist."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {state.kind === "service" && <ServiceAttention actions={actions} shell={shell} />}
      {state.kind === "error" && (
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>Something went wrong on startup</EmptyTitle>
            <EmptyDescription>{state.message}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              disabled={actionsState.pending !== null}
              onClick={() => void actions.run("retry")}
              variant="outline"
            >
              {actionsState.pending === "retry" ? "Retrying…" : "Try again"}
            </Button>
            {actionsState.failure !== null && (
              <p className="text-muted-foreground text-xs" role="status">
                {actionsState.failure}
              </p>
            )}
          </EmptyContent>
        </Empty>
      )}
    </div>
  );
}

function BrowserPairingPane({
  api,
  label,
  targetId,
}: {
  readonly api: TargetsStoreApi;
  readonly label: string;
  readonly targetId: string;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader px-3">
        <span className="font-medium text-muted-foreground text-xs">Remote host · {label}</span>
      </div>
      <Empty className="flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="default">
            <BrandLockup byline size="lg" />
          </EmptyMedia>
          <EmptyTitle>Pair this browser with the host</EmptyTitle>
          <ToneBadge className="justify-center" label="Pairing required" tone="working" />
          <EmptyDescription>
            This is the live T4 Code client. Enter the one-time code created on the host to load its
            real sessions and activity.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="w-full max-w-md">
          <PairForm api={api} requested={undefined} targetId={targetId} />
        </EmptyContent>
      </Empty>
    </div>
  );
}

function ServiceAttention({
  actions,
  shell,
}: {
  readonly actions: HomeActions;
  readonly shell: DesktopShellPort;
}) {
  const actionsState = useSyncExternalStore(actions.subscribe, actions.getState);
  const view = deriveHomeServiceView(
    actionsState.inspection,
    {
      inspect: shell.serviceInspect !== undefined,
      install: shell.serviceInstall !== undefined,
      start: shell.serviceStart !== undefined,
    },
    actionsState.failure,
  );
  const busy = actionsState.pending !== null;
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-md flex-col gap-3">
        <div
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5"
          data-service-status={view.label}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">Local OMP appserver</span>
            <ToneBadge label={view.label} live={view.live} tone={view.tone} />
          </div>
          <p
            className={view.tone === "error" ? "text-destructive-foreground text-xs" : "text-muted-foreground text-xs"}
            role="status"
          >
            {view.detail}
          </p>
          {view.diagnostics !== null && (
            <p className="rounded-md bg-secondary px-2.5 py-2 font-mono text-muted-foreground text-xs">
              {view.diagnostics}
            </p>
          )}
          {actionsState.failure !== null && actionsState.failure !== view.detail && (
            <p className="text-warning-foreground text-xs" role="status">
              {actionsState.failure}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {view.primary !== null && view.primaryLabel !== null && (
              <Button
                disabled={busy}
                onClick={() => void actions.run(view.primary ?? "inspect")}
                size="xs"
              >
                {actionsState.pending === view.primary ? "Working…" : view.primaryLabel}
              </Button>
            )}
            <Button
              disabled={busy}
              onClick={() => void actions.run("inspect")}
              size="xs"
              variant="ghost"
            >
              {actionsState.pending === "inspect" ? "Checking…" : "Check again"}
            </Button>
          </div>
        </div>
        <p className="px-1 text-muted-foreground text-xs">
          Sessions appear here as soon as this window reaches the service.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Browser: the sample-workspace teaching copy (unchanged)
// ---------------------------------------------------------------------------

function BrowserHomePane({ railOverlaid }: { railOverlaid: boolean }) {
  const modKey = rendererPlatform.platform === "darwin" ? "⌘" : "Ctrl+";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="surface-subheader px-3">
        <span className="font-medium text-muted-foreground text-xs">No session open</span>
      </div>
      <Empty className="flex-1 border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <History aria-hidden="true" className="size-5 text-muted-foreground" />
          </EmptyMedia>
          <EmptyTitle>Pick up where a session left off</EmptyTitle>
          <EmptyDescription>
            Every running and finished session is in the list{" "}
            {railOverlaid ? "behind the sidebar button" : "on the left"}, grouped by project. Open
            one to see where it stands.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <div className="flex items-center gap-2">
            {railOverlaid && (
              <Button
                onClick={() => workspaceStore.getState().setRailOverlayOpen(true)}
                variant="outline"
              >
                Browse sessions
              </Button>
            )}
            <Button
              onClick={() => workspaceStore.getState().setPaletteOpen(true)}
              variant="outline"
            >
              Search sessions
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            {modKey}K searches, {modKey}1 to {modKey}9 jump straight to a session.
          </p>
        </EmptyContent>
      </Empty>
    </div>
  );
}
