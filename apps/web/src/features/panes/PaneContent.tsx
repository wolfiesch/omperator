// Registered session-surface body: routes one explicit session and surface
// ID to its renderer. Route identity is never inferred from global active
// state, so an outgoing screen cannot briefly show an incoming session's
// inspector during navigation.
import type * as React from "react";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { desktopRuntime } from "../../platform/desktop-runtime.ts";
import { rendererPlatform } from "../../state/store-instance.ts";
import type { SessionSurfaceId } from "../../state/workspace-store.ts";
import { installTerminalStoreFactory, createTerminalStore } from "../terminal/terminal-store.ts";
import { createFixturePtyBridge } from "../terminal/pty.ts";
import { createLivePtySessionFactory } from "../terminal/live-pty.ts";
import { ActivityPane } from "./ActivityPane.tsx";
import { AgentsPane } from "./AgentsPane.tsx";
import { AGENT_OWNED_TERMINAL_IDS, installFixtureInspector } from "./fixtures.ts";
import { FilesPane } from "./FilesPane.tsx";
import { getInspectorStore } from "./inspector-store.ts";
import { installLiveInspector } from "./live-inspector.ts";
import { resolveLiveSession } from "../../platform/live-workspace.ts";
import { transcriptImageSourceForSession } from "../session-runtime/transcript-images.ts";
import { ReviewPane } from "./ReviewPane.tsx";
import { TerminalsPane } from "./TerminalsPane.tsx";

// Fixture wiring for the whole surface: inspector data and the sample PTY
// bridge. The Electron shell installs real factories before first render
// instead, and this branch never runs.
if (rendererPlatform.mode === "browser") {
  installFixtureInspector();
  const bridge = createFixturePtyBridge({ agentOwnedTerminalIds: AGENT_OWNED_TERMINAL_IDS });
  // Screenshot/QA boot switch: ?term=tabs|split|exited seeds drawer shells.
  const termBoot =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("term");
  installTerminalStoreFactory((sessionId) => {
    const store = createTerminalStore({ sessionId, bridge, cwd: null });
    if (termBoot !== null && store.getState().tabs.length === 0) {
      const state = store.getState();
      const first = state.openTerminal();
      if (termBoot === "split") state.splitActiveGroup("horizontal");
      if (termBoot === "tabs") state.openTerminal();
      if (termBoot === "exited") state.sendInput(first, "exit 137\r");
    }
    return store;
  });
} else {
  // Desktop: bind each drawer store to the exact live session address.
  const controller = desktopRuntime();
  if (controller !== null) {
    installLiveInspector(controller);
    installTerminalStoreFactory((viewId) => {
      const snapshot = controller.getSnapshot();
      const address = resolveLiveSession(snapshot, viewId);
      if (address === null) {
        const bridge = {
          kind: "desktop" as const,
          open: () => { throw new Error("Live session unavailable"); },
        };
        return createTerminalStore({ sessionId: viewId, bridge, cwd: null, host: { label: "Unavailable host", remote: false } });
      }
      const bridge = createLivePtySessionFactory(controller, () => controller.getSnapshot(), address);
      const target = snapshot.targets.get(address.targetId);
      return createTerminalStore({
        sessionId: viewId,
        host: { label: target?.label ?? address.hostId, remote: target?.kind !== "local" },
        bridge,
        cwd: null,
      });
    });
  }
}

export interface PaneContentProps {
  readonly sessionId: string;
  readonly surfaceId: SessionSurfaceId;
  /** Optional trailing action forwarded to the pane heading (e.g. dock close button). */
  readonly trailing?: React.ReactNode | undefined;
}

type SurfaceRendererProps = Required<Pick<PaneContentProps, "sessionId" | "surfaceId">> &
  Pick<PaneContentProps, "trailing"> & {
    readonly store: NonNullable<ReturnType<typeof getInspectorStore>>;
  };

type SurfaceRenderer = (props: SurfaceRendererProps) => React.ReactNode;

/** Compile-time exhaustive: adding an ID requires adding its renderer here. */
export const SESSION_SURFACE_RENDERERS = Object.freeze({
  agents: ({ sessionId, store, trailing }) => {
    const controller = rendererPlatform.mode === "browser" ? null : desktopRuntime();
    const address =
      controller === null ? null : resolveLiveSession(controller.getSnapshot(), sessionId);
    const imageSource =
      address === null
        ? undefined
        : (transcriptImageSourceForSession(address.hostId, address.sessionId) ?? undefined);
    return (
      <AgentsPane api={store} imageSource={imageSource} sessionId={sessionId} trailing={trailing} />
    );
  },
  activity: ({ store, trailing }) => <ActivityPane api={store} trailing={trailing} />,
  review: ({ sessionId, store, trailing }) => (
    <ReviewPane api={store} sessionId={sessionId} trailing={trailing} />
  ),
  files: ({ sessionId, store, trailing }) => (
    <FilesPane api={store} sessionId={sessionId} trailing={trailing} />
  ),
  terminals: ({ sessionId, store, trailing }) => (
    <TerminalsPane api={store} sessionId={sessionId} trailing={trailing} />
  ),
} satisfies Record<SessionSurfaceId, SurfaceRenderer>);

export function PaneContent({ sessionId, surfaceId, trailing }: PaneContentProps) {
  const store = getInspectorStore(sessionId);
  if (store === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeading family={surfaceId} trailing={trailing} />
        <FamilyEmpty className="min-h-0 flex-1" family={surfaceId} />
      </div>
    );
  }
  return SESSION_SURFACE_RENDERERS[surfaceId]({ sessionId, store, surfaceId, trailing });
}
