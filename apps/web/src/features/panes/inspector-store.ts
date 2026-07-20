// Per-session inspector store: the state behind the five right-pane
// families. Renderer projection only — frames arrive through the attached
// controller (fixture today, the Electron bridge later) and the store never
// invents runtime truth. One store per session keeps A→B→A switches cheap
// and isolates progress churn to the session that produced it.
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  type AgentMapState,
  clearStaleChildren,
  EMPTY_AGENT_MAP,
  patchAgent,
  removeAgentSubtree,
  upsertAgent,
} from "./agent-tree.ts";
import { appendActivity } from "./activity-log.ts";
import { isSafeRelativePath } from "./live-projection.ts";
import {
  ALL_ACTIONS_AVAILABLE,
  type ActivityEntry,
  type ActivityFilter,
  type AgentControlScope,
  type AgentNode,
  type FilePreview,
  type FileTreeNode,
  type InspectorActionAvailability,
  type ReviewComment,
  type ReviewFile,
  type ShellInventoryRow,
} from "./model.ts";

export type FileChildren = readonly FileTreeNode[] | "loading" | "error";

export type FileDraftStatus = "clean" | "dirty" | "saving" | "conflict" | "error";

export interface FileDraft {
  readonly path: string;
  readonly originalText: string;
  readonly baseRevision: string | null;
  readonly text: string;
  readonly status: FileDraftStatus;
  readonly message: string | null;
}

export interface ReviewViewState {
  readonly files: readonly ReviewFile[];
  readonly comments: readonly ReviewComment[];
  readonly selectedPath: string | null;
  readonly view: "unified" | "split";
  readonly wrap: boolean;
  readonly viewedByPath: Readonly<Record<string, boolean>>;
  /** Line the comment composer is open on, if any. */
  readonly draftAnchor: { readonly line: number; readonly side: "old" | "new" } | null;
}

export interface FilesViewState {
  readonly childrenByPath: Readonly<Record<string, FileChildren>>;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly selectedPath: string | null;
  readonly preview: FilePreview | "loading" | null;
  readonly previewRevision: string | null;
  readonly query: string;
  readonly draftsByPath: Readonly<Record<string, FileDraft>>;
  /** Host unreachable: the tree stays, previews degrade to offline. */
  readonly offline: boolean;
}

export interface InspectorState {
  /** True when a fixture controller feeds this store; surfaces sample labels. */
  readonly sampleMode: boolean;
  readonly agentMap: AgentMapState;
  readonly selectedAgentId: string | null;
  /** Pending control confirmation; the dialog renders exactly this scope. */
  readonly pendingControl: AgentControlScope | null;
  readonly activity: readonly ActivityEntry[];
  readonly activitySeq: number;
  readonly activityFilter: ActivityFilter;
  readonly activityQuery: string;
  /** Stream clipped at this seq while paused; null = live. */
  readonly activityPausedAtSeq: number | null;
  readonly expandedActivitySeq: number | null;
  readonly review: ReviewViewState;
  readonly files: FilesViewState;
  readonly terminals: readonly ShellInventoryRow[];
  /** What the runtime currently offers; disabled controls say why not. */
  readonly actions: InspectorActionAvailability;
}

export interface InspectorActions {
  selectAgent(agentId: string | null): void;
  requestControl(scope: AgentControlScope | null): void;
  setActionAvailability(actions: InspectorActionAvailability): void;
  /** Confirmed control action; delegates to the attached controller. */
  confirmControl(): void;
  ingestAgent(node: AgentNode): void;
  updateAgent(agentId: string, patch: Partial<AgentNode>): void;
  removeAgent(agentId: string): void;
  ingestActivity(entry: Omit<ActivityEntry, "seq">): void;
  setActivityFilter(filter: ActivityFilter): void;
  setActivityQuery(query: string): void;
  setActivityPaused(paused: boolean): void;
  setExpandedActivity(seq: number | null): void;
  selectReviewFile(path: string | null): void;
  setReviewView(view: "unified" | "split"): void;
  setReviewWrap(wrap: boolean): void;
  setReviewViewed(path: string, viewed: boolean): void;
  openCommentDraft(line: number, side: "old" | "new"): void;
  closeCommentDraft(): void;
  addComment(path: string, line: number, side: "old" | "new", text: string): void;
  removeComment(commentId: string): void;
  applyReviewFile(path: string): void;
  discardReviewFile(path: string): void;
  setFilesQuery(query: string): void;
  setFileExpanded(path: string, expanded: boolean): void;
  /** Lazy-load a directory listing without touching tree expansion. */
  requestDir(path: string): void;
  selectFile(path: string | null): void;
  startFileEdit(path: string): void;
  updateFileDraft(path: string, text: string): void;
  saveFile(path: string): void;
  discardFileDraft(path: string): void;
}

export type InspectorStore = InspectorState & InspectorActions;
export type InspectorStoreApi = StoreApi<InspectorStore>;

/**
 * The seam the Electron bridge replaces. The fixture controller answers
 * synchronously and deterministically; a live controller forwards app-wire
 * commands and streams results back through the ingest actions.
 */
export interface InspectorController {
  readonly kind: "fixture" | "desktop";
  /** Scoped agent control (steer/cancel/wake) after explicit confirmation. */
  performControl(scope: AgentControlScope): void;
  /** Review apply/discard for one file after explicit confirmation. */
  performReview(action: "apply" | "discard", path: string): void;
  /** Lazy directory listing; resolves through `resolveDir`. */
  loadDir(path: string): void;
  /** File preview fetch; resolves through `resolvePreview`. */
  loadPreview(path: string): void;
  /** Full-file write, gated by the authority revision that produced the draft. */
  writeFile?(path: string, content: string, baseRevision: string | null): void;
}

const INITIAL_REVIEW: ReviewViewState = {
  files: [],
  comments: [],
  selectedPath: null,
  view: "unified",
  wrap: false,
  viewedByPath: {},
  draftAnchor: null,
};

const INITIAL_FILES: FilesViewState = {
  childrenByPath: {},
  expanded: {},
  selectedPath: null,
  preview: null,
  previewRevision: null,
  draftsByPath: {},
  query: "",
  offline: false,
};

function isLoadableDirectoryPath(path: string): boolean {
  return path === "" || isSafeRelativePath(path);
}

export interface CreateInspectorStoreOptions {
  readonly sampleMode: boolean;
  readonly controller: (api: InspectorStoreApi) => InspectorController;
  readonly seed?: Partial<InspectorState>;
  /** Millisecond clock for store-authored timestamps; real time by default. */
  readonly clock?: () => number;
}

export function createInspectorStore(options: CreateInspectorStoreOptions): InspectorStoreApi {
  let controller: InspectorController | null = null;
  let commentCounter = 0;
  const clock = options.clock ?? (() => Date.now());

  const store = createStore<InspectorStore>((set, get) => ({
    sampleMode: options.sampleMode,
    agentMap: EMPTY_AGENT_MAP,
    selectedAgentId: null,
    pendingControl: null,
    activity: [],
    activitySeq: 0,
    activityFilter: "all",
    activityQuery: "",
    activityPausedAtSeq: null,
    expandedActivitySeq: null,
    review: INITIAL_REVIEW,
    files: INITIAL_FILES,
    terminals: [],
    actions: ALL_ACTIONS_AVAILABLE,
    ...options.seed,

    selectAgent: (agentId) => set({ selectedAgentId: agentId }),
    requestControl: (scope) => set({ pendingControl: scope }),
    setActionAvailability: (actions) => set({ actions }),
    confirmControl: () => {
      const scope = get().pendingControl;
      set({ pendingControl: null });
      if (scope !== null) controller?.performControl(scope);
    },
    ingestAgent: (node) =>
      set((state) => ({
        agentMap: clearStaleChildren(upsertAgent(state.agentMap, node), node.id),
      })),
    updateAgent: (agentId, patch) =>
      set((state) => ({
        agentMap: clearStaleChildren(patchAgent(state.agentMap, agentId, patch), agentId),
      })),
    removeAgent: (agentId) =>
      set((state) => ({
        agentMap: removeAgentSubtree(state.agentMap, agentId),
        selectedAgentId: state.selectedAgentId === agentId ? null : state.selectedAgentId,
      })),
    ingestActivity: (entry) =>
      set((state) => {
        const seq = state.activitySeq + 1;
        return {
          activitySeq: seq,
          activity: appendActivity(state.activity, { ...entry, seq }),
        };
      }),
    setActivityFilter: (filter) => set({ activityFilter: filter }),
    setActivityQuery: (query) => set({ activityQuery: query }),
    setActivityPaused: (paused) =>
      set((state) => ({ activityPausedAtSeq: paused ? state.activitySeq : null })),
    setExpandedActivity: (seq) => set({ expandedActivitySeq: seq }),
    selectReviewFile: (path) =>
      set((state) => ({ review: { ...state.review, selectedPath: path, draftAnchor: null } })),
    setReviewView: (view) => set((state) => ({ review: { ...state.review, view } })),
    setReviewWrap: (wrap) => set((state) => ({ review: { ...state.review, wrap } })),
    setReviewViewed: (path, viewed) =>
      set((state) => ({
        review: {
          ...state.review,
          viewedByPath: { ...state.review.viewedByPath, [path]: viewed },
        },
      })),
    openCommentDraft: (line, side) =>
      set((state) => ({ review: { ...state.review, draftAnchor: { line, side } } })),
    closeCommentDraft: () =>
      set((state) => ({ review: { ...state.review, draftAnchor: null } })),
    addComment: (path, line, side, text) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      commentCounter += 1;
      const comment: ReviewComment = {
        id: `comment-${commentCounter}`,
        path,
        line,
        side,
        text: trimmed,
        at: new Date(clock()).toISOString(),
      };
      set((state) => ({
        review: {
          ...state.review,
          comments: [...state.review.comments, comment],
          draftAnchor: null,
        },
      }));
    },
    removeComment: (commentId) =>
      set((state) => ({
        review: {
          ...state.review,
          comments: state.review.comments.filter((comment) => comment.id !== commentId),
        },
      })),
    applyReviewFile: (path) => controller?.performReview("apply", path),
    discardReviewFile: (path) => controller?.performReview("discard", path),
    setFilesQuery: (query) => set((state) => ({ files: { ...state.files, query } })),
    setFileExpanded: (path, expanded) => {
      if (!isLoadableDirectoryPath(path)) return;
      set((state) => ({
        files: {
          ...state.files,
          expanded: { ...state.files.expanded, [path]: expanded },
        },
      }));
      const { files } = get();
      if (expanded && files.childrenByPath[path] === undefined) {
        set((state) => ({
          files: {
            ...state.files,
            childrenByPath: { ...state.files.childrenByPath, [path]: "loading" },
          },
        }));
        controller?.loadDir(path);
      }
    },
    requestDir: (path) => {
      if (!isLoadableDirectoryPath(path)) return;
      if (get().files.childrenByPath[path] !== undefined) return;
      set((state) => ({
        files: {
          ...state.files,
          childrenByPath: { ...state.files.childrenByPath, [path]: "loading" },
        },
      }));
      controller?.loadDir(path);
    },
    selectFile: (path) => {
      set((state) => ({
        files: {
          ...state.files,
          selectedPath: path,
          preview: path === null ? null : "loading",
          previewRevision: null,
        },
      }));
      if (path !== null) controller?.loadPreview(path);
    },
    startFileEdit: (path) =>
      set((state) => {
        if (state.files.draftsByPath[path] !== undefined) return state;
        const preview = state.files.preview;
        if (
          state.files.selectedPath !== path ||
          preview === null ||
          preview === "loading" ||
          preview.kind !== "code" ||
          preview.path !== path ||
          preview.truncated
        )
          return state;
        const draft: FileDraft = {
          path,
          originalText: preview.text,
          baseRevision: state.files.previewRevision,
          text: preview.text,
          status: "clean",
          message: null,
        };
        return {
          files: {
            ...state.files,
            draftsByPath: { ...state.files.draftsByPath, [path]: draft },
          },
        };
      }),
    updateFileDraft: (path, text) =>
      set((state) => {
        const draft = state.files.draftsByPath[path];
        if (draft === undefined || draft.status === "saving") return state;
        return {
          files: {
            ...state.files,
            draftsByPath: {
              ...state.files.draftsByPath,
              [path]: {
                ...draft,
                text,
                status: text === draft.originalText ? "clean" : "dirty",
                message: null,
              },
            },
          },
        };
      }),
    saveFile: (path) => {
      const draft = get().files.draftsByPath[path];
      if (draft === undefined || draft.status !== "dirty") return;
      set((state) => ({
        files: {
          ...state.files,
          draftsByPath: {
            ...state.files.draftsByPath,
            [path]: { ...draft, status: "saving", message: null },
          },
        },
      }));
      if (controller?.writeFile === undefined) {
        resolveFileWriteOutcome(store, path, "error");
        return;
      }
      controller.writeFile(path, draft.text, draft.baseRevision);
    },
    discardFileDraft: (path) =>
      set((state) => {
        if (state.files.draftsByPath[path] === undefined) return state;
        const draftsByPath = { ...state.files.draftsByPath };
        delete draftsByPath[path];
        return { files: { ...state.files, draftsByPath } };
      }),
  }));

  controller = options.controller(store);
  return store;
}

/** Resolution helpers controllers use to answer lazy loads. */
export function resolveDir(
  api: InspectorStoreApi,
  path: string,
  children: readonly FileTreeNode[] | "error",
): void {
  api.setState((state) => ({
    files: {
      ...state.files,
      childrenByPath: { ...state.files.childrenByPath, [path]: children },
    },
  }));
}

export function resolvePreview(
  api: InspectorStoreApi,
  preview: FilePreview,
  baseRevision: string | null = null,
): void {
  api.setState((state) => {
    if (state.files.selectedPath !== preview.path) return state;
    const draft = state.files.draftsByPath[preview.path];
    const files = { ...state.files, preview, previewRevision: baseRevision };
    if (draft === undefined) return { files };
    if (preview.kind !== "code") {
      const shouldConflict = draft.status === "dirty" || draft.status === "saving";
      return {
        files: {
          ...files,
          ...(shouldConflict
            ? {
                draftsByPath: {
                  ...state.files.draftsByPath,
                  [preview.path]: {
                    ...draft,
                    status: "conflict",
                    message:
                      "The host could not confirm this file's current text. Your draft is safe; discard it only when you are ready to reload.",
                  },
                },
              }
            : {}),
        },
      };
    }
    if (preview.text === draft.originalText || (draft.status === "saving" && preview.text === draft.text)) {
      if (draft.status !== "clean") return { files };
      return {
        files: {
          ...files,
          draftsByPath: {
            ...state.files.draftsByPath,
            [preview.path]: { ...draft, baseRevision },
          },
        },
      };
    }
    if (draft.status === "clean") {
      return {
        files: {
          ...files,
          draftsByPath: {
            ...state.files.draftsByPath,
            [preview.path]: {
              ...draft,
              baseRevision,
              originalText: preview.text,
              text: preview.text,
            },
          },
        },
      };
    }
    return {
      files: {
        ...files,
        draftsByPath: {
          ...state.files.draftsByPath,
          [preview.path]: {
            ...draft,
            status: "conflict",
            message:
              "The file changed on the host while you were editing. Your draft is safe and will not overwrite it.",
          },
        },
      },
    };
  });
}

export function resolveFileWriteOutcome(
  api: InspectorStoreApi,
  path: string,
  outcome: "saved" | "conflict" | "error",
): void {
  api.setState((state) => {
    const draft = state.files.draftsByPath[path];
    if (draft === undefined) return state;
    if (outcome === "saved") {
      const draftsByPath = { ...state.files.draftsByPath };
      delete draftsByPath[path];
      return {
        files: {
          ...state.files,
          draftsByPath,
          ...(state.files.selectedPath === path
            ? { preview: "loading" as const }
            : {}),
        },
      };
    }
    return {
      files: {
        ...state.files,
        draftsByPath: {
          ...state.files.draftsByPath,
          [path]: {
            ...draft,
            status: outcome,
            message:
              outcome === "conflict"
                ? "The host could not confirm this draft's base revision. Your draft is safe; discard it only when you are ready to reload."
                : "The host did not confirm this save. Your draft is safe and was not resent.",
          },
        },
      },
    };
  });
}

/** Review outcome applied by a controller once the runtime confirms it. */
export function resolveReviewOutcome(
  api: InspectorStoreApi,
  path: string,
  applyState: "applied" | "discarded",
): void {
  api.setState((state) => ({
    review: {
      ...state.review,
      files: state.review.files.map((file) =>
        file.path === path ? { ...file, applyState } : file,
      ),
    },
  }));
}

// One inspector store per session, created on first use and kept for the
// window's lifetime so pane state survives A→B→A session switching.
const storesBySession = new Map<string, InspectorStoreApi>();

export type InspectorStoreFactory = (sessionId: string) => InspectorStoreApi;

let factory: InspectorStoreFactory | null = null;

/** The shell bridge (fixture boot today, Electron later) installs this once. */
export function installInspectorStoreFactory(next: InspectorStoreFactory): void {
  factory = next;
  storesBySession.clear();
}

export function getInspectorStore(sessionId: string): InspectorStoreApi | null {
  const existing = storesBySession.get(sessionId);
  if (existing !== undefined) return existing;
  if (factory === null) return null;
  const created = factory(sessionId);
  storesBySession.set(sessionId, created);
  return created;
}

export function useInspector<T>(api: InspectorStoreApi, selector: (state: InspectorStore) => T): T {
  return useStore(api, selector);
}
