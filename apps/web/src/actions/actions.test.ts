import { describe, expect, it } from "vite-plus/test";

import { createMemoryPersistence } from "../state/persistence.ts";
import { createComposerStore } from "../features/composer/composer-store.ts";
import {
  captureReviewContext,
  captureTerminalContext,
  captureTranscriptContext,
} from "../features/context-packet/context-packet.ts";
import { createWorkspaceStore } from "../state/workspace-store.ts";
import { createInspectorStore, type InspectorStoreApi } from "../features/panes/inspector-store.ts";
import type { ProjectGroup } from "../lib/session-tree.ts";
import type { WorkspaceData, WorkspaceSession } from "../lib/workspace-data.ts";
import type { RendererPlatform } from "../platform/bridge.ts";
import { CORE_ACTIONS } from "./core-actions.ts";
import { buildQuickOpenItems } from "./quick-open.ts";
import { createActionRegistry } from "./registry.ts";
import type { ActionDestination, ActionEnvironment } from "./types.ts";

function session(
  id: string,
  title: string,
  updatedAt: string,
  projectId = "project",
): WorkspaceSession {
  return {
    id,
    projectId,
    title,
    model: "gpt-5",
    status: null,
    freshness: "live",
    pendingApprovals: 0,
    latestTurnCompletedAt: null,
    createdAt: updatedAt,
    updatedAt,
    lastActivity: "",
  };
}

const firstSession = session("session-a", "Fix app router", "2026-07-20T08:00:00.000Z");
const secondSession = session("session-b", "Write release notes", "2026-07-20T07:00:00.000Z");
const shellData: WorkspaceData = {
  hosts: [{ id: "host", runtimeKind: "omp", name: "This Mac", kind: "local" }],
  projects: [{ id: "project", name: "T4 Code", path: "T4 Code", hostId: "host" }],
  sessions: [firstSession, secondSession],
};

const groups: readonly ProjectGroup[] = [
  {
    project: shellData.projects[0]!,
    displayName: "T4 Code",
    host: shellData.hosts[0]!,
    expanded: true,
    sessions: [
      { session: firstSession, unread: false },
      { session: secondSession, unread: false },
    ],
    groupStatus: null,
    unreadCount: 0,
    pendingApprovals: 0,
  },
];

function inspectorStore(): InspectorStoreApi {
  return createInspectorStore({
    sampleMode: true,
    controller: () => ({
      kind: "fixture",
      performControl: () => {},
      performReview: () => {},
      loadDir: () => {},
      loadPreview: () => {},
    }),
    seed: {
      files: {
        childrenByPath: {
          "": [
            { path: "README.md", name: "README.md", kind: "file" },
            { path: "src", name: "src", kind: "dir" },
          ],
          src: [
            { path: "src/app.ts", name: "app.ts", kind: "file" },
            { path: "src/router.ts", name: "router.ts", kind: "file" },
          ],
        },
        expanded: {},
        selectedPath: null,
        preview: null,
        previewRevision: null,
        query: "",
        draftsByPath: {},
        offline: false,
      },
    },
  });
}

function setup() {
  const workspace = createWorkspaceStore({
    persistence: createMemoryPersistence(),
    overrides: { activeSessionId: firstSession.id },
  });
  const inspector = inspectorStore();
  const destinations: ActionDestination[] = [];
  const platform: RendererPlatform = {
    mode: "browser",
    windowChrome: null,
    demo: false,
    platform: "darwin",
    persistence: createMemoryPersistence(),
    shell: null,
    browser: null,
  };
  const composer = createComposerStore();
  const environment: ActionEnvironment = {
    workspace,
    composer,
    platform,
    railOverlaid: () => false,
    shellData: () => shellData,
    inspector: (sessionId) => (sessionId === firstSession.id ? inspector : null),
    visibleSessionIds: () => shellData.sessions.map((entry) => entry.id),
    navigate: (destination) => destinations.push(destination),
  };
  return {
    workspace,
    composer,
    inspector,
    destinations,
    registry: createActionRegistry(CORE_ACTIONS, environment),
  };
}

describe("typed action registry", () => {
  it("rejects duplicate stable action ids", () => {
    const { registry } = setup();
    expect(() =>
      createActionRegistry([CORE_ACTIONS[0]!, CORE_ACTIONS[0]!], registry.environment),
    ).toThrow("Duplicate action id: palette.toggle");
  });

  it("rechecks loaded-file availability before execution", () => {
    const { inspector, registry, workspace } = setup();
    const invocation = {
      id: "file.open" as const,
      args: { sessionId: firstSession.id, path: "src/app.ts" },
    };
    expect(registry.present(invocation).availability.status).toBe("enabled");

    inspector.setState((state) => ({
      files: { ...state.files, childrenByPath: {} },
    }));
    expect(registry.execute(invocation)).toEqual({
      executed: false,
      availability: {
        status: "disabled",
        reason: "This file is no longer in the loaded file index.",
      },
    });
    expect(inspector.getState().files.selectedPath).toBeNull();
    expect(workspace.getState().sessionViewById[firstSession.id]?.paneOpen ?? false).toBe(false);
  });

  it("selects an indexed file and opens the shared Files surface", () => {
    const { inspector, registry, workspace } = setup();
    const result = registry.execute({
      id: "file.open",
      args: { sessionId: firstSession.id, path: "src/app.ts" },
    });
    expect(result.executed).toBe(true);
    expect(inspector.getState().files.selectedPath).toBe("src/app.ts");
    expect(workspace.getState().sessionViewById[firstSession.id]).toMatchObject({
      paneFamily: "files",
      paneOpen: true,
    });
  });

  it("uses the same registry behavior for stateful workspace actions", () => {
    const { registry, workspace } = setup();
    expect(registry.present({ id: "focus.toggle", args: undefined }).label).toBe(
      "Enter focus mode",
    );
    registry.execute({ id: "focus.toggle", args: undefined });
    expect(workspace.getState().focusMode).toBe(true);
    expect(registry.present({ id: "focus.toggle", args: undefined }).label).toBe("Exit focus mode");
  });

  it("publishes the shared actions used by workspace menus and transcript tool links", () => {
    const { registry } = setup();
    expect(registry.list("workspace-menu").map((action) => action.id)).toEqual([
      "terminal.toggle",
      "focus.toggle",
      "surface.toggle",
    ]);
    expect(registry.list("tool-link").map((action) => action.id)).toEqual([
      "agent.open",
      "review.open",
      "preview.open",
    ]);
  });

  it("captures, removes, and clears the working set through shared actions", () => {
    const { composer, registry } = setup();
    const first = captureTranscriptContext(firstSession.id, {
      id: "message-1",
      role: "assistant",
      text: "First response",
    });
    const second = captureTranscriptContext(firstSession.id, {
      id: "message-2",
      role: "user",
      text: "Second message",
    });
    if (first === null || second === null) throw new Error("expected context items");

    expect(
      registry.execute({
        id: "context.capture",
        args: { sessionId: firstSession.id, item: first },
      }).executed,
    ).toBe(true);
    expect(composer.getState().contextItemsBySessionId[firstSession.id]).toEqual([first]);

    expect(
      registry.execute({
        id: "context.remove",
        args: { sessionId: firstSession.id, itemId: first.id },
      }).executed,
    ).toBe(true);
    expect(composer.getState().contextItemsBySessionId[firstSession.id]).toBeUndefined();

    registry.execute({
      id: "context.capture",
      args: { sessionId: firstSession.id, item: first },
    });
    registry.execute({
      id: "context.capture",
      args: { sessionId: firstSession.id, item: second },
    });
    expect(
      registry.execute({ id: "context.clear", args: { sessionId: firstSession.id } }).executed,
    ).toBe(true);
    expect(composer.getState().contextItemsBySessionId[firstSession.id]).toBeUndefined();
  });

  it("stages terminal selections and review patches through the shared capture action", () => {
    const { composer, registry } = setup();
    const terminal = captureTerminalContext(
      firstSession.id,
      { terminalId: "terminal-1", title: "Tests", text: "selected failure only" },
      { id: "terminal-selection" },
    );
    const review = captureReviewContext(
      firstSession.id,
      { path: "src/app.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
      { id: "review-patch" },
    );
    if (terminal === null || review === null) throw new Error("expected source context");

    for (const item of [terminal, review]) {
      expect(
        registry.execute({
          id: "context.capture",
          args: { sessionId: firstSession.id, item },
        }).executed,
      ).toBe(true);
    }

    expect(composer.getState().contextItemsBySessionId[firstSession.id]).toEqual([
      terminal,
      review,
    ]);
  });

  it("refuses working-set capture for another or inactive session", () => {
    const { composer, registry } = setup();
    const item = captureTranscriptContext(firstSession.id, {
      id: "message-1",
      role: "assistant",
      text: "Response",
    });
    if (item === null) throw new Error("expected context item");

    expect(
      registry.execute({
        id: "context.capture",
        args: { sessionId: secondSession.id, item },
      }).availability,
    ).toEqual({ status: "disabled", reason: "This context belongs to a different session." });

    const inactiveItem = captureTranscriptContext(secondSession.id, {
      id: "message-2",
      role: "assistant",
      text: "Inactive response",
    });
    if (inactiveItem === null) throw new Error("expected inactive context item");
    expect(
      registry.execute({
        id: "context.capture",
        args: { sessionId: secondSession.id, item: inactiveItem },
      }).availability,
    ).toEqual({ status: "hidden" });
    expect(composer.getState().contextItemsBySessionId).toEqual({});
  });

  it("selects a transcript-linked agent and opens the shared Agents surface", () => {
    const { inspector, registry, workspace } = setup();
    inspector.getState().ingestAgent({
      id: "agent-a",
      parentId: null,
      title: "Implementation agent",
      kind: "agent",
      state: "running",
      progress: null,
      startedAt: null,
      lastActivityAt: null,
      model: null,
      worktree: null,
      path: null,
      currentTool: null,
      contextUsed: null,
      contextLimit: null,
      evidence: null,
      transcriptEntries: [],
      transcriptReceived: false,
      transcriptFreshness: "fresh",
      transcriptHistoryTruncated: false,
      transcript: [],
    });
    workspace.getState().setFocusMode(true);

    expect(
      registry.execute({
        id: "agent.open",
        args: { sessionId: firstSession.id, agentId: "agent-a" },
      }).executed,
    ).toBe(true);
    expect(inspector.getState().selectedAgentId).toBe("agent-a");
    expect(workspace.getState().focusMode).toBe(false);
    expect(workspace.getState().sessionViewById[firstSession.id]).toMatchObject({
      paneFamily: "agents",
      paneOpen: true,
    });
  });

  it("refuses a transcript link after its agent disappears", () => {
    const { inspector, registry } = setup();
    const invocation = {
      id: "agent.open" as const,
      args: { sessionId: firstSession.id, agentId: "missing-agent" },
    };
    expect(registry.execute(invocation)).toEqual({
      executed: false,
      availability: { status: "disabled", reason: "This agent is no longer available." },
    });
    expect(inspector.getState().selectedAgentId).toBeNull();
  });

  it("loads a linked turn review before opening the Review surface", () => {
    const { inspector, registry, workspace } = setup();
    expect(
      registry.execute({
        id: "review.open",
        args: { sessionId: firstSession.id, turnId: "turn-42" },
      }).executed,
    ).toBe(true);
    expect(inspector.getState().review).toMatchObject({
      source: "turn",
      turnId: "turn-42",
      loading: true,
    });
    expect(workspace.getState().sessionViewById[firstSession.id]).toMatchObject({
      paneFamily: "review",
      paneOpen: true,
    });
  });

  it("routes transcript previews through the action environment", () => {
    const { destinations, registry } = setup();
    expect(
      registry.execute({ id: "preview.open", args: { sessionId: firstSession.id } }).executed,
    ).toBe(true);
    expect(destinations).toEqual([{ kind: "preview", sessionId: firstSession.id }]);
  });
});

describe("Quick Open providers", () => {
  it("ranks sessions by title and keeps stable session keys", () => {
    const { registry } = setup();
    const items = buildQuickOpenItems("release", {
      registry,
      groups,
      activeSessionFiles: [],
    });
    const sessions = items.filter((item) => item.kind === "session");
    expect(sessions[0]).toMatchObject({
      key: "session:session-b",
      title: "Write release notes",
      invocation: { id: "session.open", args: { sessionId: "session-b" } },
    });
  });

  it("returns only active-session files already present in the loaded index", () => {
    const { inspector, registry } = setup();
    const loaded = Object.values(inspector.getState().files.childrenByPath)
      .filter((children): children is Exclude<typeof children, string> => Array.isArray(children))
      .flat()
      .map((entry) => ({
        path: entry.path,
        name: entry.name,
        isDir: entry.kind === "dir",
      }));
    const items = buildQuickOpenItems("app", { registry, groups, activeSessionFiles: loaded });
    expect(items.find((item) => item.kind === "file")).toMatchObject({
      key: "file:session-a:src/app.ts",
      title: "src/app.ts",
      indexScope: "loaded",
      invocation: {
        id: "file.open",
        args: { sessionId: "session-a", path: "src/app.ts" },
      },
    });
    expect(items.some((item) => item.key.includes("ghost"))).toBe(false);
  });

  it("prefers trusted project-search matches and can open a file not in the loaded tree", () => {
    const { inspector, registry } = setup();
    const items = buildQuickOpenItems("config", {
      registry,
      groups,
      activeSessionFiles: [{ path: "src/config.ts", name: "config.ts", isDir: false }],
      projectFileMatches: [
        { path: "src/config.ts" },
        { path: "packages/config/runtime.ts" },
      ],
    });
    const files = items.filter((item) => item.kind === "file");
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      provider: "project-files",
      indexScope: "project",
      invocation: {
        id: "file.open",
        args: { sessionId: "session-a", path: "src/config.ts", source: "project-search" },
      },
    });
    expect(
      registry.execute({
        id: "file.open",
        args: {
          sessionId: "session-a",
          path: "packages/config/runtime.ts",
          source: "project-search",
        },
      }).executed,
    ).toBe(true);
    expect(inspector.getState().files.selectedPath).toBe("packages/config/runtime.ts");
  });

  it("adds transcript search only as a two-character fallback", () => {
    const { registry } = setup();
    const oneCharacter = buildQuickOpenItems("x", {
      registry,
      groups,
      activeSessionFiles: [],
    });
    const twoCharacters = buildQuickOpenItems("xy", {
      registry,
      groups,
      activeSessionFiles: [],
    });
    expect(oneCharacter.some((item) => item.provider === "transcript-fallback")).toBe(false);
    expect(twoCharacters.find((item) => item.provider === "transcript-fallback")).toMatchObject({
      title: "View all transcript results",
      invocation: { id: "transcript-search.open", args: { query: "xy" } },
    });
  });

  it("keeps existing groups ordered around the loaded-file group", () => {
    const { inspector, registry } = setup();
    const loaded = [{ path: "src/app.ts", name: "app.ts", isDir: false }];
    const groupsInOrder = buildQuickOpenItems("app", {
      registry,
      groups,
      activeSessionFiles: loaded,
    }).map((item) => item.group);
    expect([...new Set(groupsInOrder)]).toEqual(["recent", "files", "navigate", "app"]);
    expect(inspector.getState().files.selectedPath).toBeNull();
  });
});
