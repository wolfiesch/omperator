import type { SessionStatus } from "@t4-code/ui";

import type { FileRefEntry } from "../features/composer/file-refs.ts";
import type { ComposerStoreApi } from "../features/composer/composer-store.ts";
import type { ContextPacketItem } from "../features/context-packet/context-packet.ts";
import type { InspectorStoreApi } from "../features/panes/inspector-store.ts";
import type { ProjectGroup } from "../lib/session-tree.ts";
import type { WorkspaceData } from "../lib/workspace-data.ts";
import type { RendererPlatform } from "../platform/bridge.ts";
import type { SessionSurfaceId, WorkspaceStoreApi } from "../state/workspace-store.ts";

/** Stable names shared by Quick Open, shortcuts, and future menus. */
export type ActionId =
  | "palette.toggle"
  | "rail.toggle"
  | "terminal.toggle"
  | "focus.toggle"
  | "theme.toggle"
  | "session.open"
  | "surface.toggle"
  | "file.open"
  | "context.capture"
  | "context.remove"
  | "context.clear"
  | "agent.open"
  | "review.open"
  | "preview.open"
  | "inbox.open"
  | "transcript-search.open"
  | "agents.open"
  | "settings.open"
  | "hosts.open"
  | "usage.open";

/** Session surfaces currently exposed by Quick Open. */
export type ActionSessionSurface = SessionSurfaceId;

export interface ActionArguments {
  readonly "palette.toggle": undefined;
  readonly "rail.toggle": undefined;
  readonly "terminal.toggle": undefined;
  readonly "focus.toggle": undefined;
  readonly "theme.toggle": undefined;
  readonly "session.open": { readonly sessionId: string };
  readonly "surface.toggle": {
    readonly sessionId: string;
    readonly surfaceId: ActionSessionSurface;
  };
  readonly "file.open": {
    readonly sessionId: string;
    readonly path: string;
    readonly source?: "loaded" | "project-search";
  };
  readonly "context.capture": { readonly sessionId: string; readonly item: ContextPacketItem };
  readonly "context.remove": { readonly sessionId: string; readonly itemId: string };
  readonly "context.clear": { readonly sessionId: string };
  readonly "agent.open": { readonly sessionId: string; readonly agentId: string };
  readonly "review.open": { readonly sessionId: string; readonly turnId: string };
  readonly "preview.open": { readonly sessionId: string };
  readonly "inbox.open": undefined;
  readonly "transcript-search.open": { readonly query: string };
  readonly "agents.open": undefined;
  readonly "settings.open": undefined;
  readonly "hosts.open": undefined;
  readonly "usage.open": undefined;
}

export type ActionInvocation<K extends ActionId = ActionId> = K extends ActionId
  ? { readonly id: K; readonly args: ActionArguments[K] }
  : never;

export type ActionAvailability =
  | { readonly status: "enabled" }
  | { readonly status: "disabled"; readonly reason: string }
  | { readonly status: "hidden" };

export const ACTION_ENABLED: ActionAvailability = Object.freeze({ status: "enabled" });
export const ACTION_HIDDEN: ActionAvailability = Object.freeze({ status: "hidden" });
export const ACTION_COMPLETED = Object.freeze({ completed: true as const });
export type ActionRunResult = typeof ACTION_COMPLETED;

export type ActionGroup = "workspace" | "navigate" | "app";
export type ActionSurface =
  | "quick-open"
  | "shortcut"
  | "workspace-menu"
  | "tool-link"
  | "context-source";
export type ActionIcon = "search" | "terminal" | ActionSessionSurface;

export interface ActionPresentation {
  readonly group: ActionGroup;
  readonly label: string;
  readonly description: string;
  readonly icon: ActionIcon | null;
  readonly availability: ActionAvailability;
}

export interface ActionExecution {
  readonly executed: boolean;
  readonly availability: ActionAvailability;
}

export type ActionDestination =
  | {
      readonly kind: "route";
      readonly route: "/agents" | "/hosts" | "/inbox" | "/settings" | "/usage";
    }
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "preview"; readonly sessionId: string }
  | { readonly kind: "transcript-search"; readonly query: string };

/**
 * Live seams used by action definitions. Every registry read calls these
 * functions again, so a palette row cannot run from a stale snapshot.
 */
export interface ActionEnvironment {
  readonly workspace: WorkspaceStoreApi;
  readonly composer: ComposerStoreApi;
  readonly platform: RendererPlatform;
  readonly railOverlaid: () => boolean;
  readonly shellData: () => WorkspaceData;
  readonly inspector: (sessionId: string) => InspectorStoreApi | null;
  readonly visibleSessionIds: () => readonly string[];
  readonly navigate: (destination: ActionDestination) => void;
}

export interface ActionDefinition<K extends ActionId> {
  readonly id: K;
  readonly group: ActionGroup;
  readonly surfaces: readonly ActionSurface[];
  readonly icon?:
    | ActionIcon
    | ((environment: ActionEnvironment, args: ActionArguments[K]) => ActionIcon);
  readonly keywords?: readonly string[];
  readonly label: (environment: ActionEnvironment, args: ActionArguments[K]) => string;
  readonly description: (environment: ActionEnvironment, args: ActionArguments[K]) => string;
  readonly availability: (
    environment: ActionEnvironment,
    args: ActionArguments[K],
  ) => ActionAvailability;
  readonly run: (environment: ActionEnvironment, args: ActionArguments[K]) => ActionRunResult;
}

export type AnyActionDefinition = {
  readonly [K in ActionId]: ActionDefinition<K>;
}[ActionId];

export interface ActionRegistry {
  readonly environment: ActionEnvironment;
  definition<K extends ActionId>(id: K): ActionDefinition<K>;
  present<K extends ActionId>(invocation: ActionInvocation<K>): ActionPresentation;
  execute<K extends ActionId>(invocation: ActionInvocation<K>): ActionExecution;
  list(surface: ActionSurface): readonly AnyActionDefinition[];
}

export type QuickOpenGroup = "recent" | "files" | "workspace" | "navigate" | "app";
export type QuickOpenProviderId =
  | "actions"
  | "sessions"
  | "project-files"
  | "loaded-files"
  | "transcript-fallback";

export type QuickOpenStatus =
  | { readonly kind: "icon"; readonly icon: ActionIcon }
  | { readonly kind: "session"; readonly status: SessionStatus }
  | null;

export interface QuickOpenItem {
  readonly key: string;
  readonly kind: "action" | "session" | "file" | "transcript-fallback";
  readonly provider: QuickOpenProviderId;
  readonly group: QuickOpenGroup;
  readonly title: string;
  readonly subtitle: string;
  readonly invocation: ActionInvocation;
  readonly availability: ActionAvailability;
  readonly status: QuickOpenStatus;
  /** Lower is a better match; used only inside the item's display group. */
  readonly score: number;
  readonly indexScope?: "loaded" | "project";
}

export interface QuickOpenProjectFileMatch {
  readonly path: string;
}

export interface QuickOpenProviderContext {
  readonly registry: ActionRegistry;
  readonly groups: readonly ProjectGroup[];
  readonly activeSessionFiles: readonly FileRefEntry[];
  readonly projectFileMatches?: readonly QuickOpenProjectFileMatch[];
}

export interface QuickOpenProvider {
  readonly id: QuickOpenProviderId;
  readonly search: (query: string, context: QuickOpenProviderContext) => readonly QuickOpenItem[];
}
