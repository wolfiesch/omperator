// Code-based route tree: the shell frame at the root, the no-session state
// at "/", and the active session at "/sessions/$sessionId". Hash history so
// the same bundle runs unchanged under file:// in the desktop shell.
import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@t4-code/ui";
import type { DesktopShellPort } from "@t4-code/client";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { AppShell } from "./components/AppShell.tsx";
import { HomePane } from "./components/HomePane.tsx";
import { SessionScreen } from "./components/SessionScreen.tsx";
import { AgentViewScreen } from "./features/agent-view/AgentViewScreen.tsx";
import {
  AGENT_VIEW_FIXTURE_GROUPS,
  AGENT_VIEW_FIXTURE_NOW_MS,
} from "./features/agent-view/fixtures.ts";
import { getInspectorStore } from "./features/panes/inspector-store.ts";
import { PreviewWorkspace } from "./features/preview/PreviewWorkspace.tsx";
import { BrowserWorkspace } from "./features/browser/index.ts";
import { FixturePreviewWorkspace } from "./features/preview/FixturePreviewWorkspace.tsx";
import { LiveAttentionInbox } from "./features/attention/index.ts";
import { LiveTranscriptSearch } from "./features/transcript-search/index.ts";
import { TRANSCRIPT_SEARCH_ROUTE } from "./features/transcript-search/route.ts";
import { previewSelectionForNavigation } from "./features/session-runtime/session-navigation.ts";
import { SettingsWorkspace } from "./features/settings/index.ts";
import { LiveSettingsScreen } from "./features/settings/LiveSettingsScreen.tsx";
import { TargetsScreen } from "./features/targets/TargetsScreen.tsx";
import { UsageScreen } from "./features/usage/index.ts";
import {
  createTargetsStore,
  type ProfilesPort,
  type TargetsStoreApi,
} from "./features/targets/targets-store.ts";
import type { WorkspaceProject, WorkspaceSession } from "./lib/workspace-data.ts";
import {
  applySessionRoutePendingGrace,
  createSessionRouteActivationGate,
  createSessionRoutePendingGrace,
  decideSessionRoute,
  preferredHomeSessionId,
} from "./lib/session-route.ts";
import { desktopRuntime, useDesktopRuntimeSnapshot } from "./platform/desktop-runtime.ts";
import { sessionAttentionOutcomeMarker } from "./platform/live-workspace.ts";
import { useShellData } from "./state/shell-data.ts";
import { RAIL_OVERLAY_QUERY, useMediaQuery } from "./hooks/useMediaQuery.ts";
import { fixtureSettingsStore } from "./state/settings-instance.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "./state/store-instance.ts";

const rootRoute = createRootRoute({ component: AppShell });

function HomeRoute() {
  const railOverlaid = useMediaQuery(RAIL_OVERLAY_QUERY);
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const sessionListView = useWorkspace((state) => state.sessionListView);
  const shellData = useShellData();
  const runtimeSnapshot = useDesktopRuntimeSnapshot();
  const browserDirect =
    rendererPlatform.shell !== null && rendererPlatform.shell.serviceInspect === undefined;
  const preferredSessionId = preferredHomeSessionId({
    activeSessionId,
    browserDirect,
    data: shellData,
    liveRuntime: runtimeSnapshot !== null,
    sessionListView,
  });
  // Desktop mode resumes a visible current session or selects the latest one
  // while Current is selected. Empty Archived remains an explicit home state.
  // A browser-direct Tailnet bridge intentionally stays on the live landing
  // page so opening the URL never implicitly attaches a session.
  if (preferredSessionId !== null) {
    return <Navigate params={{ sessionId: preferredSessionId }} to="/sessions/$sessionId" />;
  }
  return <HomePane railOverlaid={railOverlaid} />;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: LiveAttentionInbox,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: TRANSCRIPT_SEARCH_ROUTE,
  component: LiveTranscriptSearch,
});

interface SessionRouteGateProps {
  readonly sessionId: string;
  readonly previewRoute: boolean;
  readonly browserRoute?: boolean;
  readonly children: (
    session: WorkspaceSession,
    project: WorkspaceProject,
    nowMs: number,
  ) => ReactNode;
}

function SessionRouteGate({
  browserRoute = false,
  children,
  previewRoute,
  sessionId,
}: SessionRouteGateProps) {
  const navigate = useNavigate();
  const [nowMs] = useState(() => Date.now());
  const [pendingTimedOut, setPendingTimedOut] = useState(false);
  const [pendingGrace] = useState(() => createSessionRoutePendingGrace(setPendingTimedOut));
  const shellData = useShellData();
  const runtimeSnapshot = useDesktopRuntimeSnapshot();
  const browserDirect =
    rendererPlatform.shell !== null && rendererPlatform.shell.serviceInspect === undefined;
  const session = shellData.sessions.find((entry) => entry.id === sessionId);
  const project =
    session === undefined
      ? undefined
      : shellData.projects.find((entry) => entry.id === session.projectId);
  const rawDecision = decideSessionRoute({
    browserDirect,
    data: shellData,
    routeSessionId: sessionId,
    snapshot: runtimeSnapshot,
  });
  const pendingKey = rawDecision.kind === "pending" ? sessionId : null;
  const decision = applySessionRoutePendingGrace(rawDecision, pendingTimedOut);

  useEffect(() => {
    pendingGrace.update(pendingKey);
  }, [pendingGrace, pendingKey]);
  useEffect(() => () => pendingGrace.dispose(), [pendingGrace]);

  const [activationGate] = useState(() => createSessionRouteActivationGate());
  useEffect(() => {
    const target = activationGate.resolve(decision, session);
    if (target !== null) {
      workspaceStore.getState().activateSession(target, new Date().toISOString());
    }
  }, [activationGate, decision, session]);

  const attentionOutcome =
    runtimeSnapshot === null ? null : sessionAttentionOutcomeMarker(runtimeSnapshot, sessionId);
  const attentionOutcomeId = attentionOutcome?.outcomeId;
  const attentionSessionKey = attentionOutcome?.sessionKey;
  useEffect(() => {
    if (
      decision.kind !== "present" ||
      attentionOutcomeId === undefined ||
      attentionSessionKey === undefined
    ) {
      return;
    }
    workspaceStore.getState().markAttentionOutcomeSeen(attentionSessionKey, attentionOutcomeId);
  }, [attentionOutcomeId, attentionSessionKey, decision.kind]);

  if (decision.kind === "pending") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="surface-subheader px-3">
          <span className="font-medium text-muted-foreground text-xs">Checking session</span>
        </div>
        <div
          aria-live="polite"
          className="flex flex-1 items-center justify-center text-muted-foreground text-sm"
          role="status"
        >
          Loading the current session list…
        </div>
      </div>
    );
  }
  if (decision.kind === "redirect-home") {
    return <Navigate replace to="/" />;
  }
  if (decision.kind === "redirect-session") {
    return previewRoute ? (
      <Navigate
        params={{ sessionId: decision.sessionId }}
        replace
        to="/sessions/$sessionId/preview"
      />
    ) : browserRoute ? (
      <Navigate
        params={{ sessionId: decision.sessionId }}
        replace
        to="/sessions/$sessionId/browser"
      />
    ) : (
      <Navigate params={{ sessionId: decision.sessionId }} replace to="/sessions/$sessionId" />
    );
  }

  if (decision.kind === "unavailable") {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="surface-subheader px-3">
          <span className="font-medium text-muted-foreground text-xs">Host unavailable</span>
        </div>
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>This session host is not answering</EmptyTitle>
            <EmptyDescription>
              T4 Code has not received a complete session list from this host. It may still be
              starting or it may be offline; this page will recover automatically if it reconnects.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void navigate({ to: "/" })} variant="outline">
              Back to all sessions
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }

  if (decision.kind === "not-found" || session === undefined || project === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="surface-subheader px-3">
          <span className="font-medium text-muted-foreground text-xs">Session not found</span>
        </div>
        <Empty className="flex-1 border-0">
          <EmptyHeader>
            <EmptyTitle>That session is gone</EmptyTitle>
            <EmptyDescription>
              It may have been removed, or the link is stale. The list on the left has everything
              that still exists.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => void navigate({ to: "/" })} variant="outline">
              Back to all sessions
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
  return children(session, project, nowMs);
}

function SessionRoute() {
  const navigate = useNavigate();
  const { sessionId } = useParams({ from: "/sessions/$sessionId" });
  return (
    <SessionRouteGate previewRoute={false} sessionId={sessionId}>
      {(session, project, nowMs) => (
        <SessionScreen
          key={sessionId}
          nowMs={nowMs}
          onOpenHostHealth={() => void navigate({ to: "/hosts" })}
          project={project}
          session={session}
          sessionId={sessionId}
        />
      )}
    </SessionRouteGate>
  );
}

function PreviewRoute() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/preview" });
  return (
    <SessionRouteGate previewRoute sessionId={sessionId}>
      {(session, project) =>
        rendererPlatform.demo ? (
          <FixturePreviewWorkspace project={project} session={session} />
        ) : (
          <PreviewWorkspace project={project} session={session} />
        )
      }
    </SessionRouteGate>
  );
}

function BrowserRoute() {
  const { sessionId } = useParams({ from: "/sessions/$sessionId/browser" });
  return (
    <SessionRouteGate browserRoute previewRoute={false} sessionId={sessionId}>
      {(session, project) => (
        <BrowserWorkspace key={session.id} project={project} session={session} />
      )}
    </SessionRouteGate>
  );
}

const browserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/browser",
  component: BrowserRoute,
});

const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId",
  component: SessionRoute,
});

const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sessions/$sessionId/preview",
  component: PreviewRoute,
});

function AgentViewRoute() {
  const navigate = useNavigate();
  const activeSessionId = useWorkspace((state) => state.activeSessionId);
  const snapshot = useDesktopRuntimeSnapshot();
  return (
    <AgentViewScreen
      controller={desktopRuntime()}
      {...(rendererPlatform.demo
        ? {
            fixtureGroups: AGENT_VIEW_FIXTURE_GROUPS,
            fixtureNowMs: AGENT_VIEW_FIXTURE_NOW_MS,
          }
        : {})}
      onBack={() => {
        if (activeSessionId === null) void navigate({ to: "/" });
        else void navigate({ params: { sessionId: activeSessionId }, to: "/sessions/$sessionId" });
      }}
      onOpenSession={(sessionId, agentId) => {
        const inspector = getInspectorStore(sessionId);
        if (
          agentId !== undefined &&
          inspector?.getState().agentMap.agents[agentId] !== undefined
        ) {
          inspector.getState().selectAgent(agentId);
        }
        workspaceStore.getState().openSessionSurface(sessionId, "agents");
        void navigate({ params: { sessionId }, to: "/sessions/$sessionId" });
      }}
      snapshot={snapshot}
    />
  );
}

const agentViewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentViewRoute,
});

// Settings keeps the shell frame: the rail and titlebar stay put, and
// leaving returns to "/" which resumes the previously active session.
// Desktop mode binds to the live runtime; the browser keeps the fixture
// showcase.
function SettingsRoute() {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {controller !== null ? (
        <LiveSettingsScreen
          controller={controller}
          onBack={() => void navigate({ to: "/" })}
          onOpenHosts={() => void navigate({ to: "/hosts" })}
        />
      ) : (
        <SettingsWorkspace api={fixtureSettingsStore()} onBack={() => void navigate({ to: "/" })} />
      )}
    </div>
  );
}

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});

// One targets store per window; action state survives route changes.
let targetsStoreInstance: TargetsStoreApi | null = null;

function profilesPort(shell: DesktopShellPort | null): ProfilesPort | undefined {
  if (shell === null) return undefined;
  const {
    listProfiles,
    addProfile,
    updateProfile,
    removeProfile,
    profileStatus,
    profileStart,
    profileStop,
    profileRestart,
  } = shell;
  if (
    listProfiles === undefined ||
    addProfile === undefined ||
    updateProfile === undefined ||
    removeProfile === undefined ||
    profileStatus === undefined ||
    profileStart === undefined ||
    profileStop === undefined ||
    profileRestart === undefined
  )
    return undefined;
  return {
    list: async () => (await listProfiles()).profiles,
    add: async (profile) => (await addProfile({ profile })).profile,
    update: async (profileId, changes) => (await updateProfile({ profileId, changes })).profile,
    remove: (profileId) => removeProfile({ profileId }),
    status: async (profileId) => (await profileStatus({ profileId })).profile,
    start: async (profileId) => (await profileStart({ profileId })).profile,
    stop: async (profileId) => (await profileStop({ profileId })).profile,
    restart: async (profileId) => (await profileRestart({ profileId })).profile,
  };
}

function HostsRoute() {
  const navigate = useNavigate();
  const controller = desktopRuntime();
  const snapshot = useDesktopRuntimeSnapshot();
  if (controller === null || snapshot === null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="font-medium text-sm">Hosts are managed in the desktop app</p>
        <p className="max-w-[48ch] text-muted-foreground text-xs">
          This browser showcase has no runtime to connect. Open T4 Code on your desktop to add and
          pair computers.
        </p>
        <Button onClick={() => void navigate({ to: "/settings" })} size="sm" variant="outline">
          Back to settings
        </Button>
      </div>
    );
  }
  const shell = rendererPlatform.shell;
  const localProfiles = profilesPort(shell);
  if (targetsStoreInstance === null) {
    targetsStoreInstance = createTargetsStore(
      controller,
      {
        ...(shell?.serviceInspect === undefined ? {} : { inspect: shell.serviceInspect }),
        ...(shell?.serviceInstall === undefined ? {} : { install: shell.serviceInstall }),
        ...(shell?.serviceStart === undefined ? {} : { start: shell.serviceStart }),
        ...(shell?.serviceStop === undefined ? {} : { stop: shell.serviceStop }),
        ...(shell?.serviceRestart === undefined ? {} : { restart: shell.serviceRestart }),
      },
      localProfiles,
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <TargetsScreen
        controller={controller}
        onOpenPreview={(sessionId, previewId) => {
          const selection = previewSelectionForNavigation(snapshot, sessionId, previewId);
          if (selection !== null) {
            workspaceStore.getState().setSessionPreview(sessionId, selection);
          }
          void navigate({ to: "/sessions/$sessionId/preview", params: { sessionId } });
        }}
        onOpenSession={(sessionId) =>
          void navigate({ to: "/sessions/$sessionId", params: { sessionId } })
        }
        api={targetsStoreInstance}
        onBack={() => void navigate({ to: "/settings" })}
        profilesAvailable={localProfiles !== undefined}
        {...(shell?.inspectPhoneSetup && shell.configurePhoneSetup ? {
        phoneSetup: {
            inspect: shell.inspectPhoneSetup,
            configure: shell.configurePhoneSetup,
          },
        } : {})}
        {...(shell?.inspectT4OmpLauncher && shell.installT4OmpLauncher && shell.removeT4OmpLauncher ? {
          t4OmpLauncher: {
            inspect: shell.inspectT4OmpLauncher,
            install: shell.installT4OmpLauncher,
            remove: shell.removeT4OmpLauncher,
          },
        } : {})}
        serviceAvailable={shell?.serviceInspect !== undefined}
        snapshot={snapshot}
      />
    </div>
  );
}

const hostsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/hosts",
  component: HostsRoute,
});

function UsageRoute() {
  const navigate = useNavigate();
  return (
    <UsageScreen
      controller={desktopRuntime()}
      onBack={() => void navigate({ to: "/" })}
      onOpenHosts={() => void navigate({ to: "/hosts" })}
    />
  );
}

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: UsageRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  inboxRoute,
  searchRoute,
  sessionRoute,
  previewRoute,
  browserRoute,
  agentViewRoute,
  settingsRoute,
  hostsRoute,
  usageRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
