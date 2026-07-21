import { flattenFileIndex } from "../features/composer/file-refs.ts";
import { contextSourceDescription } from "../features/context-packet/context-packet.ts";
import { selectSessionView } from "../state/workspace-store.ts";
import { resolveTheme } from "../theme/theme.ts";
import type {
  ActionAvailability,
  ActionDefinition,
  ActionEnvironment,
  ActionId,
  AnyActionDefinition,
} from "./types.ts";
import { ACTION_COMPLETED, ACTION_ENABLED, ACTION_HIDDEN } from "./types.ts";

const SURFACE_LABELS = {
  agents: "Agents",
  activity: "Activity",
  review: "Review",
  files: "Files",
  terminals: "Agent terminals",
} as const;

const QUICK_OPEN = ["quick-open"] as const;
const QUICK_OPEN_AND_SHORTCUT = ["quick-open", "shortcut"] as const;
const QUICK_OPEN_SHORTCUT_AND_MENU = ["quick-open", "shortcut", "workspace-menu"] as const;

function defineAction<K extends ActionId>(definition: ActionDefinition<K>): ActionDefinition<K> {
  return definition;
}

function currentSession(environment: ActionEnvironment) {
  const sessionId = environment.workspace.getState().activeSessionId;
  if (sessionId === null) return null;
  const session = environment.shellData().sessions.find((candidate) => candidate.id === sessionId);
  return session === undefined ? null : { sessionId, session };
}

function sessionAvailability(
  environment: ActionEnvironment,
  sessionId: string,
): ActionAvailability {
  const session = environment.shellData().sessions.find((candidate) => candidate.id === sessionId);
  return session === undefined
    ? { status: "disabled", reason: "This session is no longer available." }
    : ACTION_ENABLED;
}

function activeCurrentSessionAvailability(
  environment: ActionEnvironment,
  sessionId: string,
): ActionAvailability {
  const current = currentSession(environment);
  if (current === null || current.sessionId !== sessionId) return ACTION_HIDDEN;
  if (current.session.archivedAt !== undefined) {
    return { status: "disabled", reason: "Archived sessions are read-only." };
  }
  return ACTION_ENABLED;
}

const paletteToggle = defineAction({
  id: "palette.toggle",
  group: "app",
  surfaces: ["shortcut"],
  label: () => "Toggle Quick Open",
  description: () => "Search sessions, loaded files, transcripts, and commands",
  availability: () => ACTION_ENABLED,
  run: (environment) => {
    const workspace = environment.workspace.getState();
    workspace.setPaletteOpen(!workspace.paletteOpen);
    return ACTION_COMPLETED;
  },
});

const railToggle = defineAction({
  id: "rail.toggle",
  group: "workspace",
  surfaces: QUICK_OPEN_AND_SHORTCUT,
  keywords: ["sidebar", "sessions"],
  label: (environment) => {
    const workspace = environment.workspace.getState();
    const hidden = environment.railOverlaid()
      ? !workspace.railOverlayOpen
      : workspace.railCollapsed;
    return workspace.focusMode || hidden ? "Show session list" : "Hide session list";
  },
  description: () => "Sidebar",
  availability: () => ACTION_ENABLED,
  run: (environment) => {
    const workspace = environment.workspace.getState();
    if (workspace.focusMode) {
      workspace.setFocusMode(false);
      workspace.setRailCollapsed(false);
      if (environment.railOverlaid()) workspace.setRailOverlayOpen(true);
    } else if (environment.railOverlaid()) {
      workspace.setRailOverlayOpen(!workspace.railOverlayOpen);
    } else {
      workspace.setRailCollapsed(!workspace.railCollapsed);
    }
    return ACTION_COMPLETED;
  },
});

const terminalToggle = defineAction({
  id: "terminal.toggle",
  group: "workspace",
  surfaces: QUICK_OPEN_SHORTCUT_AND_MENU,
  icon: "terminal",
  keywords: ["drawer", "shell"],
  label: (environment) => {
    const current = currentSession(environment);
    if (current === null) return "Open terminal";
    const workspace = environment.workspace.getState();
    const open =
      !workspace.focusMode && selectSessionView(workspace, current.sessionId).terminalDrawerOpen;
    return open ? "Close terminal" : "Open terminal";
  },
  description: () => "Workspace · Below · ⌘J",
  availability: (environment) => {
    const current = currentSession(environment);
    return current === null
      ? ACTION_HIDDEN
      : activeCurrentSessionAvailability(environment, current.sessionId);
  },
  run: (environment) => {
    const current = currentSession(environment);
    if (current === null) return ACTION_COMPLETED;
    const workspace = environment.workspace.getState();
    const view = selectSessionView(workspace, current.sessionId);
    if (workspace.focusMode) {
      workspace.setFocusMode(false);
      workspace.setTerminalDrawerOpen(current.sessionId, true);
    } else {
      workspace.setTerminalDrawerOpen(current.sessionId, !view.terminalDrawerOpen);
    }
    return ACTION_COMPLETED;
  },
});

const focusToggle = defineAction({
  id: "focus.toggle",
  group: "workspace",
  surfaces: QUICK_OPEN_SHORTCUT_AND_MENU,
  keywords: ["distraction", "fullscreen"],
  label: (environment) =>
    environment.workspace.getState().focusMode ? "Exit focus mode" : "Enter focus mode",
  description: () => "⌘⇧F",
  availability: () => ACTION_ENABLED,
  run: (environment) => {
    const workspace = environment.workspace.getState();
    workspace.setFocusMode(!workspace.focusMode);
    return ACTION_COMPLETED;
  },
});

const themeToggle = defineAction({
  id: "theme.toggle",
  group: "app",
  surfaces: QUICK_OPEN,
  keywords: ["appearance", "dark", "light", "colors"],
  label: (environment) =>
    resolveTheme(environment.workspace.getState().theme) === "dark"
      ? "Switch to light colors"
      : "Switch to dark colors",
  description: () => "Appearance",
  availability: () => ACTION_ENABLED,
  run: (environment) => {
    const workspace = environment.workspace.getState();
    const current = resolveTheme(workspace.theme);
    workspace.setTheme(current === "dark" ? "light" : "dark");
    return ACTION_COMPLETED;
  },
});

const sessionOpen = defineAction({
  id: "session.open",
  group: "workspace",
  surfaces: QUICK_OPEN_AND_SHORTCUT,
  label: (environment, args) =>
    environment.shellData().sessions.find((session) => session.id === args.sessionId)?.title ??
    "Open session",
  description: () => "Session",
  availability: (environment, args) => sessionAvailability(environment, args.sessionId),
  run: (environment, args) => {
    environment.navigate({ kind: "session", sessionId: args.sessionId });
    return ACTION_COMPLETED;
  },
});

const surfaceToggle = defineAction({
  id: "surface.toggle",
  group: "workspace",
  surfaces: ["quick-open", "workspace-menu"],
  icon: (_environment, args) => args.surfaceId,
  label: (environment, args) => {
    const workspace = environment.workspace.getState();
    const view = selectSessionView(workspace, args.sessionId);
    const active = !workspace.focusMode && view.paneOpen && view.paneFamily === args.surfaceId;
    return `${active ? "Close" : "Open"} ${SURFACE_LABELS[args.surfaceId]}`;
  },
  description: () => "Workspace · Right",
  availability: (environment, args) =>
    activeCurrentSessionAvailability(environment, args.sessionId),
  run: (environment, args) => {
    const workspace = environment.workspace.getState();
    const view = selectSessionView(workspace, args.sessionId);
    if (workspace.focusMode) {
      workspace.setFocusMode(false);
      if (!(view.paneOpen && view.paneFamily === args.surfaceId)) {
        workspace.openSessionSurface(args.sessionId, args.surfaceId);
      }
      return ACTION_COMPLETED;
    }
    workspace.toggleSessionSurface(args.sessionId, args.surfaceId);
    return ACTION_COMPLETED;
  },
});

const fileOpen = defineAction({
  id: "file.open",
  group: "workspace",
  surfaces: QUICK_OPEN,
  icon: "files",
  label: (_environment, args) => args.path,
  description: (_environment, args) =>
    args.source === "project-search" ? "Current project" : "Current session · loaded file",
  availability: (environment, args) => {
    const active = activeCurrentSessionAvailability(environment, args.sessionId);
    if (active.status !== "enabled") return active;
    const inspector = environment.inspector(args.sessionId);
    if (inspector === null) {
      return { status: "disabled", reason: "Files are not loaded for this session yet." };
    }
    if (args.source === "project-search") return ACTION_ENABLED;
    const entry = flattenFileIndex(inspector.getState().files.childrenByPath).find(
      (candidate) => candidate.path === args.path && !candidate.isDir,
    );
    return entry === undefined
      ? { status: "disabled", reason: "This file is no longer in the loaded file index." }
      : ACTION_ENABLED;
  },
  run: (environment, args) => {
    const inspector = environment.inspector(args.sessionId);
    if (inspector === null) return ACTION_COMPLETED;
    inspector.getState().selectFile(args.path);
    const workspace = environment.workspace.getState();
    if (workspace.focusMode) workspace.setFocusMode(false);
    workspace.openSessionSurface(args.sessionId, "files");
    return ACTION_COMPLETED;
  },
});

const contextCapture = defineAction({
  id: "context.capture",
  group: "workspace",
  surfaces: ["context-source"],
  label: () => "Add to working set",
  description: (_environment, args) => contextSourceDescription(args.item.source),
  availability: (environment, args) => {
    if (args.item.sessionId !== args.sessionId) {
      return { status: "disabled", reason: "This context belongs to a different session." };
    }
    return activeCurrentSessionAvailability(environment, args.sessionId);
  },
  run: (environment, args) => {
    environment.composer.getState().addContextItem(args.sessionId, args.item);
    return ACTION_COMPLETED;
  },
});

const contextRemove = defineAction({
  id: "context.remove",
  group: "workspace",
  surfaces: ["context-source"],
  label: () => "Remove from working set",
  description: () => "Context for the next new message",
  availability: (environment, args) => {
    const active = activeCurrentSessionAvailability(environment, args.sessionId);
    if (active.status !== "enabled") return active;
    return environment.composer
      .getState()
      .contextItemsBySessionId[args.sessionId]?.some((item) => item.id === args.itemId)
      ? ACTION_ENABLED
      : { status: "disabled", reason: "This context item is no longer in the working set." };
  },
  run: (environment, args) => {
    environment.composer.getState().removeContextItem(args.sessionId, args.itemId);
    return ACTION_COMPLETED;
  },
});

const contextClear = defineAction({
  id: "context.clear",
  group: "workspace",
  surfaces: ["context-source"],
  label: () => "Clear working set",
  description: () => "Context for the next new message",
  availability: (environment, args) => {
    const active = activeCurrentSessionAvailability(environment, args.sessionId);
    if (active.status !== "enabled") return active;
    return (environment.composer.getState().contextItemsBySessionId[args.sessionId]?.length ?? 0) >
      0
      ? ACTION_ENABLED
      : { status: "disabled", reason: "The working set is already empty." };
  },
  run: (environment, args) => {
    environment.composer.getState().clearContextItems(args.sessionId);
    return ACTION_COMPLETED;
  },
});

const agentOpen = defineAction({
  id: "agent.open",
  group: "workspace",
  surfaces: ["tool-link"],
  icon: "agents",
  label: () => "Open agent",
  description: () => "Transcript tool result · Agents",
  availability: (environment, args) => {
    const active = activeCurrentSessionAvailability(environment, args.sessionId);
    if (active.status !== "enabled") return active;
    const inspector = environment.inspector(args.sessionId);
    if (inspector === null) {
      return { status: "disabled", reason: "Agents are not loaded for this session yet." };
    }
    return inspector.getState().agentMap.agents[args.agentId] === undefined
      ? { status: "disabled", reason: "This agent is no longer available." }
      : ACTION_ENABLED;
  },
  run: (environment, args) => {
    const inspector = environment.inspector(args.sessionId);
    if (inspector === null) return ACTION_COMPLETED;
    inspector.getState().selectAgent(args.agentId);
    const workspace = environment.workspace.getState();
    if (workspace.focusMode) workspace.setFocusMode(false);
    workspace.openSessionSurface(args.sessionId, "agents");
    return ACTION_COMPLETED;
  },
});

const reviewOpen = defineAction({
  id: "review.open",
  group: "workspace",
  surfaces: ["tool-link"],
  icon: "review",
  label: () => "Open turn review",
  description: () => "Transcript tool result · Review",
  availability: (environment, args) => {
    const active = activeCurrentSessionAvailability(environment, args.sessionId);
    if (active.status !== "enabled") return active;
    return environment.inspector(args.sessionId) === null
      ? { status: "disabled", reason: "Review is not loaded for this session yet." }
      : ACTION_ENABLED;
  },
  run: (environment, args) => {
    const inspector = environment.inspector(args.sessionId);
    if (inspector === null) return ACTION_COMPLETED;
    inspector.getState().loadTurnReview(args.turnId);
    const workspace = environment.workspace.getState();
    if (workspace.focusMode) workspace.setFocusMode(false);
    workspace.openSessionSurface(args.sessionId, "review");
    return ACTION_COMPLETED;
  },
});

const previewOpen = defineAction({
  id: "preview.open",
  group: "workspace",
  surfaces: ["tool-link"],
  label: () => "Open preview",
  description: () => "Session preview",
  availability: (environment, args) => sessionAvailability(environment, args.sessionId),
  run: (environment, args) => {
    environment.navigate({ kind: "preview", sessionId: args.sessionId });
    return ACTION_COMPLETED;
  },
});

function routeAction<
  K extends "inbox.open" | "agents.open" | "settings.open" | "hosts.open" | "usage.open",
>(
  id: K,
  group: "navigate" | "app",
  label: string,
  description: string,
  route: "/agents" | "/hosts" | "/inbox" | "/settings" | "/usage",
  keywords: readonly string[] = [],
): ActionDefinition<K> {
  return defineAction({
    id,
    group,
    surfaces: QUICK_OPEN,
    keywords,
    label: () => label,
    description: () => description,
    availability: () => ACTION_ENABLED,
    run: (environment) => {
      environment.navigate({ kind: "route", route });
      return ACTION_COMPLETED;
    },
  });
}

const transcriptSearchOpen = defineAction({
  id: "transcript-search.open",
  group: "navigate",
  surfaces: QUICK_OPEN,
  icon: "search",
  keywords: ["history", "prior decisions", "code discussions"],
  label: () => "Open transcript search",
  description: () => "Prior decisions and code discussions",
  availability: () => ACTION_ENABLED,
  run: (environment, args) => {
    environment.navigate({ kind: "transcript-search", query: args.query });
    return ACTION_COMPLETED;
  },
});

export const CORE_ACTIONS: readonly AnyActionDefinition[] = Object.freeze([
  paletteToggle,
  railToggle,
  terminalToggle,
  focusToggle,
  themeToggle,
  sessionOpen,
  surfaceToggle,
  fileOpen,
  contextCapture,
  contextRemove,
  contextClear,
  agentOpen,
  reviewOpen,
  previewOpen,
  routeAction("inbox.open", "navigate", "Open Inbox", "Attention across sessions", "/inbox"),
  transcriptSearchOpen,
  routeAction("agents.open", "navigate", "Open Agent View", "Agents", "/agents"),
  routeAction("settings.open", "app", "Open settings", "Preferences", "/settings"),
  routeAction("hosts.open", "app", "Open Hosts", "Connections", "/hosts", ["targets"]),
  routeAction("usage.open", "app", "Open usage", "Limits and credits", "/usage", ["quota"]),
]);
