// Files pane: lazy workspace tree with search over loaded folders and a
// preview surface that stays honest about what it can show — code, images,
// binaries, read failures, and offline hosts each get their own state.
import { Badge, Button, cn, Skeleton } from "@t4-code/ui";
import { ChevronRight, FilePlus2, FileText, Folder, ImageIcon, WifiOff } from "lucide-react";
import { useEffect, useMemo } from "react";
import type * as React from "react";

import { useActionRegistry } from "../../actions/index.ts";
import { FamilyEmpty } from "./FamilyEmpty.tsx";
import { PaneHeading } from "./PaneHeading.tsx";
import { useInspector, type FileDraft, type InspectorStoreApi } from "./inspector-store.ts";
import type { FilePreview, FileTreeNode } from "./model.ts";
import { useComposer } from "../composer/composer-store.ts";
import { captureFileContext } from "../context-packet/context-packet.ts";

const EMPTY_CONTEXT_ITEMS = [] as const;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

interface FlatRow {
  readonly node: FileTreeNode;
  readonly depth: number;
}

function TreeRows({ api, query }: { readonly api: InspectorStoreApi; readonly query: string }) {
  const childrenByPath = useInspector(api, (state) => state.files.childrenByPath);
  const expanded = useInspector(api, (state) => state.files.expanded);
  const selectedPath = useInspector(api, (state) => state.files.selectedPath);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result: FlatRow[] = [];
    const visit = (path: string, depth: number) => {
      const children = childrenByPath[path];
      if (children === undefined || children === "loading" || children === "error") return;
      for (const node of children) {
        const matches = needle.length === 0 || node.name.toLowerCase().includes(needle);
        if (node.kind === "dir") {
          // A searched directory shows when it or anything loaded under it matches.
          const before = result.length;
          const open = needle.length > 0 || expanded[node.path] === true;
          if (matches || open) result.push({ node, depth });
          if (open) visit(node.path, depth + 1);
          if (!matches && result.length === before + 1 && needle.length > 0) result.pop();
        } else if (matches) {
          result.push({ node, depth });
        }
      }
    };
    visit("", 0);
    return result;
  }, [childrenByPath, expanded, query]);

  const rootState = childrenByPath[""];
  if (rootState === undefined || rootState === "loading") {
    return (
      <div className="flex flex-col gap-1.5 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  }
  if (rootState === "error") {
    return (
      <p className="px-3 py-4 text-muted-foreground text-xs">
        The host could not list this project's files right now.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="px-3 py-4 text-muted-foreground text-xs">
        {query.trim().length > 0
          ? "No loaded file matches. Search covers folders you have opened."
          : "This project reports no files."}
      </p>
    );
  }

  return (
    <div aria-label="Project files" role="tree">
      {rows.map(({ node, depth }) => {
        const isDir = node.kind === "dir";
        const isOpen = expanded[node.path] === true;
        const children = childrenByPath[node.path];
        return (
          <div key={node.path} role="none">
            <button
              aria-expanded={isDir ? isOpen : undefined}
              aria-selected={selectedPath === node.path}
              className={cn(
                "flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-start outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                selectedPath === node.path ? "bg-secondary" : "hover:bg-secondary/60",
              )}
              onClick={() => {
                if (isDir) api.getState().setFileExpanded(node.path, !isOpen);
                else api.getState().selectFile(node.path);
              }}
              role="treeitem"
              style={{ paddingInlineStart: 8 + depth * 14 }}
              type="button"
            >
              {isDir ? (
                <>
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
                      isOpen && "rotate-90",
                    )}
                  />
                  <Folder aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                </>
              ) : (
                <FileText
                  aria-hidden="true"
                  className="ms-5 size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{node.name}</span>
            </button>
            {isDir && isOpen && children === "loading" && (
              <div className="py-1" style={{ paddingInlineStart: 30 + depth * 14 }}>
                <Skeleton className="h-3.5 w-24" />
              </div>
            )}
            {isDir && isOpen && children === "error" && (
              <p
                className="py-1 text-muted-foreground text-xs"
                style={{ paddingInlineStart: 30 + depth * 14 }}
              >
                Could not list this folder.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PreviewBody({ preview }: { readonly preview: FilePreview }) {
  switch (preview.kind) {
    case "code": {
      const lines = preview.text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      return (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {lines.map((line, index) => (
            <div className="flex" key={index}>
              <span className="w-10 shrink-0 select-none pe-2 text-end font-mono text-[.6875rem] text-muted-foreground/70 tabular-nums leading-5">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 whitespace-pre font-mono text-xs leading-5">
                {line || " "}
              </span>
            </div>
          ))}
          {preview.truncated && (
            <p className="px-3 py-2 text-muted-foreground text-xs">
              Truncated preview. The full file lives on the host.
            </p>
          )}
        </div>
      );
    }
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
          <img
            alt={`Preview of ${preview.path}`}
            className="max-h-full max-w-full rounded-md border border-border [image-rendering:pixelated]"
            src={preview.src}
            style={{ minHeight: 96, minWidth: 96 }}
          />
        </div>
      );
    case "binary":
      return (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="max-w-xs text-center text-muted-foreground text-xs">
            Binary file · {formatBytes(preview.sizeBytes)}. No text preview.
          </p>
        </div>
      );
    case "diagnostic":
      return (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="max-w-xs rounded-md bg-warning/8 px-3 py-2 text-center text-warning-foreground text-xs dark:bg-warning/16">
            {preview.message}
          </p>
        </div>
      );
    case "offline":
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6">
          <WifiOff aria-hidden="true" className="size-4 text-muted-foreground" />
          <p className="max-w-xs text-center text-muted-foreground text-xs">
            The host is unreachable, so this file cannot be read right now. Nothing is lost.
          </p>
        </div>
      );
  }
}

function EditorBody({
  api,
  draft,
  saveEnabled,
}: {
  readonly api: InspectorStoreApi;
  readonly draft: FileDraft;
  readonly saveEnabled: boolean;
}) {
  const saving = draft.status === "saving";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <textarea
        aria-label={`Edit ${draft.path}`}
        className="min-h-32 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        disabled={saving}
        onChange={(event) => api.getState().updateFileDraft(draft.path, event.target.value)}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "s" &&
            draft.status === "dirty" &&
            saveEnabled
          ) {
            event.preventDefault();
            api.getState().saveFile(draft.path);
          }
        }}
        spellCheck={false}
        value={draft.text}
      />
      {draft.message !== null && (
        <p
          className="border-border border-t px-3 py-2 text-warning-foreground text-xs"
          role="alert"
        >
          {draft.message}
        </p>
      )}
    </div>
  );
}

export function FilesPane({
  api,
  sessionId,
  trailing,
}: {
  readonly api: InspectorStoreApi;
  readonly sessionId: string;
  readonly trailing?: React.ReactNode | undefined;
}) {
  const actionRegistry = useActionRegistry();
  const query = useInspector(api, (state) => state.files.query);
  const selectedPath = useInspector(api, (state) => state.files.selectedPath);
  const preview = useInspector(api, (state) => state.files.preview);
  const offline = useInspector(api, (state) => state.files.offline);
  const draftsByPath = useInspector(api, (state) => state.files.draftsByPath);
  const fileWrite = useInspector(api, (state) => state.actions.fileWrite);
  const draft = selectedPath === null ? undefined : draftsByPath[selectedPath];
  const stagedContext = useComposer(
    (state) => state.contextItemsBySessionId[sessionId] ?? EMPTY_CONTEXT_ITEMS,
  );
  const editablePreview =
    preview !== null && preview !== "loading" && preview.kind === "code" && !preview.truncated;
  const rootKnown = useInspector(api, (state) => state.files.childrenByPath[""] !== undefined);
  const contextPreview: FilePreview | null =
    draft !== undefined
      ? { kind: "code", path: draft.path, text: draft.text, truncated: false }
      : preview !== null && preview !== "loading" && preview.kind === "code"
        ? preview
        : null;
  const contextAlreadyAdded =
    selectedPath !== null &&
    stagedContext.some((item) => item.source.kind === "file" && item.source.path === selectedPath);

  // Root loads lazily on first open, like every other directory.
  useEffect(() => {
    if (!rootKnown && !offline) api.getState().setFileExpanded("", true);
  }, [api, offline, rootKnown]);

  if (offline) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeading family="files" summary="host unreachable" trailing={trailing} />
        <FamilyEmpty family="files" />
        <p className="border-border border-t px-3 py-2 text-muted-foreground text-xs">
          This session's host is offline. Files return when the host does.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeading family="files" summary={selectedPath ?? undefined} trailing={trailing} />
      <div className="shrink-0 border-border border-b px-2 py-1.5">
        <input
          aria-label="Search loaded files"
          className="h-7 w-full rounded-md border border-input bg-popover px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          onChange={(event) => api.getState().setFilesQuery(event.target.value)}
          placeholder="Search loaded folders"
          type="search"
          value={query}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <TreeRows api={api} query={query} />
      </div>
      {selectedPath !== null && (
        <section
          aria-label={`Preview of ${selectedPath}`}
          className="flex max-h-[50%] min-h-24 shrink-0 flex-col border-border border-t"
        >
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
            {preview !== null && preview !== "loading" && preview.kind === "image" ? (
              <ImageIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
              <bdi>{selectedPath}</bdi>
            </span>
            {contextPreview !== null && (
              <Button
                onClick={() => {
                  const item = captureFileContext(sessionId, contextPreview);
                  if (item !== null) {
                    actionRegistry.execute({ id: "context.capture", args: { sessionId, item } });
                  }
                }}
                size="xs"
                title="Add the visible excerpt to the next new message"
                variant="outline"
              >
                <FilePlus2 aria-hidden="true" />
                {contextAlreadyAdded ? "Refresh context" : "Add context"}
              </Button>
            )}
            {draft === undefined ? (
              <>
                <Badge size="sm" variant="outline">
                  Read-only
                </Badge>
                {preview !== null && preview !== "loading" && preview.kind === "code" && (
                  <Button
                    disabled={!editablePreview || !fileWrite.enabled}
                    onClick={() => api.getState().startFileEdit(selectedPath)}
                    size="xs"
                    title={
                      preview.truncated
                        ? "The host returned only part of this file."
                        : (fileWrite.reason ?? undefined)
                    }
                    variant="outline"
                  >
                    Edit
                  </Button>
                )}
              </>
            ) : (
              <>
                <Badge size="sm" variant="outline">
                  {draft.status === "saving"
                    ? "Saving"
                    : draft.status === "conflict"
                      ? "Conflict"
                      : draft.status === "error"
                        ? "Error"
                        : "Editing"}
                </Badge>
                <Button
                  disabled={draft.status === "saving"}
                  onClick={() => api.getState().discardFileDraft(selectedPath)}
                  size="xs"
                  variant="ghost"
                >
                  Discard
                </Button>
                <Button
                  disabled={draft.status !== "dirty" || !fileWrite.enabled}
                  onClick={() => api.getState().saveFile(selectedPath)}
                  size="xs"
                  title={fileWrite.reason ?? undefined}
                >
                  Save
                </Button>
              </>
            )}
          </div>
          {preview === "loading" || preview === null ? (
            <div className="flex flex-col gap-1.5 p-3">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
            </div>
          ) : draft === undefined ? (
            <PreviewBody preview={preview} />
          ) : (
            <EditorBody api={api} draft={draft} saveEnabled={fileWrite.enabled} />
          )}
        </section>
      )}
    </div>
  );
}
