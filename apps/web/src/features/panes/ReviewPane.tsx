// Review pane: session edits as readable diffs. File list with viewed
// marks, unified/split views, wrap toggle, line-anchored comments, honest
// binary/huge/missing states, and an explicit keep/discard seam.
import {
  Badge,
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@t4-code/ui";
import { Check, Layers3, MessageSquarePlus, WrapText, X } from "lucide-react";
import { Fragment, useMemo, useState } from "react";
import type * as React from "react";

import { useActionRegistry } from "../../actions/index.ts";
import { useComposer } from "../composer/composer-store.ts";
import { captureReviewContext } from "../context-packet/context-packet.ts";
import { PaneHeading } from "./PaneHeading.tsx";
import { useInspector, type InspectorStoreApi } from "./inspector-store.ts";
import type { ReviewComment, ReviewFile, ReviewFileStatus } from "./model.ts";
import { buildSplitRows, parseUnifiedPatch, type DiffRow } from "./review-model.ts";

const EMPTY_CONTEXT_ITEMS = [] as const;

const STATUS_BADGES: Readonly<
  Record<ReviewFileStatus, { letter: string; className: string; label: string }>
> = {
  added: { letter: "A", className: "text-success-foreground", label: "Added" },
  modified: { letter: "M", className: "text-info-foreground", label: "Modified" },
  deleted: { letter: "D", className: "text-destructive-foreground", label: "Deleted" },
  renamed: { letter: "R", className: "text-warning-foreground", label: "Renamed" },
  copied: { letter: "C", className: "text-warning-foreground", label: "Copied" },
  untracked: { letter: "U", className: "text-success-foreground", label: "Untracked" },
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function FileListRow({
  api,
  file,
  selected,
  viewed,
}: {
  readonly api: InspectorStoreApi;
  readonly file: ReviewFile;
  readonly selected: boolean;
  readonly viewed: boolean;
}) {
  const badge = STATUS_BADGES[file.status];
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-md px-2 py-1 transition-colors duration-(--motion-duration-fast)",
        selected ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      <button
        aria-current={selected ? "true" : undefined}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-start outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={() => api.getState().selectReviewFile(file.path)}
        type="button"
      >
        <span
          aria-label={badge.label}
          className={cn(
            "w-3 shrink-0 text-center font-mono font-semibold text-xs",
            badge.className,
          )}
        >
          {badge.letter}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" dir="rtl">
          <bdi>{file.path}</bdi>
        </span>
        {file.applyState !== "pending" && (
          <Badge size="sm" variant={file.applyState === "applied" ? "success" : "outline"}>
            {file.applyState === "applied" ? "Kept" : "Discarded"}
          </Badge>
        )}
        <span className="shrink-0 font-mono text-[.6875rem] tabular-nums">
          {file.additions > 0 && <span className="text-success-foreground">+{file.additions}</span>}{" "}
          {file.deletions > 0 && (
            <span className="text-destructive-foreground">−{file.deletions}</span>
          )}
        </span>
      </button>
      <button
        aria-label={viewed ? `Mark ${file.path} as not viewed` : `Mark ${file.path} as viewed`}
        aria-pressed={viewed}
        className={cn(
          "flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
          viewed
            ? "border-transparent bg-primary text-primary-foreground"
            : "border-input text-transparent hover:text-muted-foreground",
        )}
        onClick={() => api.getState().setReviewViewed(file.path, !viewed)}
        type="button"
      >
        <Check aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}

function CommentCard({
  api,
  comment,
}: {
  readonly api: InspectorStoreApi;
  readonly comment: ReviewComment;
}) {
  return (
    <div className="mx-2 my-1 flex items-start gap-2 rounded-md border border-border bg-card px-2.5 py-1.5">
      <MessageSquarePlus
        aria-hidden="true"
        className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs">{comment.text}</p>
        <p className="pt-0.5 text-[.6875rem] text-muted-foreground">
          Line {comment.line} · yours, local to this review
        </p>
      </div>
      <button
        aria-label="Remove comment"
        className="cursor-pointer rounded p-0.5 text-muted-foreground outline-none transition-colors duration-(--motion-duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => api.getState().removeComment(comment.id)}
        type="button"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}

function CommentDraft({
  api,
  path,
  line,
  side,
}: {
  readonly api: InspectorStoreApi;
  readonly path: string;
  readonly line: number;
  readonly side: "old" | "new";
}) {
  const [text, setText] = useState("");
  return (
    <div className="mx-2 my-1 flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2">
      <textarea
        aria-label={`Comment on line ${line}`}
        autoFocus
        className="min-h-14 w-full resize-y rounded-md border border-input bg-popover px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") api.getState().closeCommentDraft();
        }}
        placeholder="Note for this line"
        value={text}
      />
      <div className="flex justify-end gap-1.5">
        <Button onClick={() => api.getState().closeCommentDraft()} size="xs" variant="ghost">
          Cancel
        </Button>
        <Button
          disabled={text.trim().length === 0}
          onClick={() => api.getState().addComment(path, line, side, text)}
          size="xs"
        >
          Add comment
        </Button>
      </div>
    </div>
  );
}

function DiffCell({
  row,
  wrap,
  side,
  onComment,
}: {
  readonly row: DiffRow | null;
  readonly wrap: boolean;
  readonly side: "old" | "new";
  readonly onComment: ((line: number, side: "old" | "new") => void) | null;
}) {
  if (row === null) {
    return <div className="min-w-0 bg-secondary/40" />;
  }
  if (row.kind === "hunk") {
    return (
      <div className="min-w-0 bg-secondary/60 px-2 py-0.5 font-mono text-[.6875rem] text-muted-foreground">
        {row.text}
      </div>
    );
  }
  const line = side === "old" ? row.oldLine : row.newLine;
  const commentLine = row.kind === "del" ? row.oldLine : row.newLine;
  const commentSide = row.kind === "del" ? "old" : "new";
  return (
    <div
      className={cn(
        "group/line flex min-w-0 items-stretch overflow-hidden",
        row.kind === "add" && "bg-(--diff-added-background)",
        row.kind === "del" && "bg-(--diff-removed-background)",
      )}
    >
      <span className="w-9 shrink-0 select-none pe-1.5 text-end font-mono text-[.6875rem] text-muted-foreground/70 tabular-nums leading-5">
        {line ?? ""}
      </span>
      {onComment !== null && commentLine !== null ? (
        <button
          aria-label={`Comment on line ${commentLine}`}
          className="w-4 shrink-0 cursor-pointer select-none text-center font-mono text-muted-foreground/0 leading-5 outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-1 focus-visible:ring-ring group-hover/line:text-muted-foreground"
          onClick={() => onComment(commentLine, commentSide)}
          type="button"
        >
          +
        </button>
      ) : (
        <span className="w-4 shrink-0 select-none text-center font-mono text-muted-foreground/50 leading-5">
          {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 font-mono text-xs leading-5",
          wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre",
        )}
      >
        {row.text || " "}
      </span>
    </div>
  );
}

function ApplyDiscardDialog({
  api,
  action,
  path,
  sampleMode,
  onClose,
}: {
  readonly api: InspectorStoreApi;
  readonly action: "apply" | "discard";
  readonly path: string;
  readonly sampleMode: boolean;
  readonly onClose: () => void;
}) {
  const applying = action === "apply";
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogPopup
        aria-label={applying ? "Keep this change" : "Discard this change"}
        className="max-w-sm"
      >
        <DialogHeader>
          <DialogTitle className="text-base">
            {applying ? "Keep this change?" : "Discard this change?"}
          </DialogTitle>
          <DialogDescription>
            <span className="block break-all font-mono text-foreground text-xs">{path}</span>
            <span className="block pt-1">
              {applying
                ? "Marks this file's edit as accepted on the host."
                : "Reverts this file on the host. The session's other edits stay."}
            </span>
            {sampleMode && (
              <span className="block pt-1 text-xs">
                Sample data: this action is recorded locally only.
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter variant="bare">
          <Button onClick={onClose} size="sm" variant="ghost">
            Not now
          </Button>
          <Button
            onClick={() => {
              if (applying) api.getState().applyReviewFile(path);
              else api.getState().discardReviewFile(path);
              onClose();
            }}
            size="sm"
            variant={applying ? "default" : "destructive"}
          >
            {applying ? "Keep change" : "Discard change"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function FileBody({ api, file }: { readonly api: InspectorStoreApi; readonly file: ReviewFile }) {
  const view = useInspector(api, (state) => state.review.view);
  const wrap = useInspector(api, (state) => state.review.wrap);
  const draftAnchor = useInspector(api, (state) => state.review.draftAnchor);
  const comments = useInspector(api, (state) => state.review.comments);
  const fileComments = comments.filter((comment) => comment.path === file.path);
  const rows = useMemo(
    () => (file.patch === null ? [] : parseUnifiedPatch(file.patch)),
    [file.patch],
  );
  const splitRows = useMemo(() => (view === "split" ? buildSplitRows(rows) : []), [rows, view]);

  if (file.kind !== "text") {
    const note =
      file.kind === "binary"
        ? `Binary file${file.sizeBytes !== null ? ` · ${formatBytes(file.sizeBytes)}` : ""}. No text diff to show.`
        : file.kind === "huge"
          ? `This diff is too large to render (${file.additions + file.deletions} changed lines${file.sizeBytes !== null ? `, ${formatBytes(file.sizeBytes)}` : ""}). Open it in your editor to read it in full.`
          : "This file no longer exists on the host. The deletion itself is the change.";
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <p className="max-w-xs text-center text-muted-foreground text-xs">{note}</p>
      </div>
    );
  }

  if (file.patch === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-8">
        <p className="max-w-xs text-center text-muted-foreground text-xs">
          The host reported this change without a diff to show.
        </p>
      </div>
    );
  }

  const onComment = (line: number, side: "old" | "new") =>
    api.getState().openCommentDraft(line, side);
  const annotationsFor = (row: DiffRow | null) => {
    if (row === null || row.kind === "hunk") return null;
    const line = row.kind === "del" ? row.oldLine : row.newLine;
    const side = row.kind === "del" ? "old" : "new";
    if (line === null) return null;
    const own = fileComments.filter((comment) => comment.line === line && comment.side === side);
    const draft = draftAnchor !== null && draftAnchor.line === line && draftAnchor.side === side;
    if (own.length === 0 && !draft) return null;
    return (
      <>
        {own.map((comment) => (
          <CommentCard api={api} comment={comment} key={comment.id} />
        ))}
        {draft && <CommentDraft api={api} line={line} path={file.path} side={side} />}
      </>
    );
  };

  return (
    <div className={cn("min-h-0 flex-1 overflow-auto py-1", !wrap && "overscroll-x-contain")}>
      {view === "unified"
        ? rows.map((row, index) => (
            <Fragment key={index}>
              <DiffCell onComment={onComment} row={row} side="new" wrap={wrap} />
              {annotationsFor(row)}
            </Fragment>
          ))
        : splitRows.map((pair, index) => (
            <Fragment key={index}>
              <div className="grid min-w-0 grid-cols-2 gap-px overflow-hidden">
                <DiffCell
                  onComment={pair.left?.kind === "del" ? onComment : null}
                  row={pair.left}
                  side="old"
                  wrap={wrap}
                />
                <DiffCell
                  onComment={pair.right?.kind !== "del" ? onComment : null}
                  row={pair.right}
                  side="new"
                  wrap={wrap}
                />
              </div>
              {annotationsFor(pair.right ?? pair.left)}
            </Fragment>
          ))}
    </div>
  );
}

export function ReviewPane({
  api,
  sessionId,
  trailing,
}: {
  readonly api: InspectorStoreApi;
  readonly sessionId: string;
  readonly trailing?: React.ReactNode | undefined;
}) {
  const actionRegistry = useActionRegistry();
  const files = useInspector(api, (state) => state.review.files);
  const selectedPath = useInspector(api, (state) => state.review.selectedPath);
  const view = useInspector(api, (state) => state.review.view);
  const wrap = useInspector(api, (state) => state.review.wrap);
  const viewedByPath = useInspector(api, (state) => state.review.viewedByPath);
  const sampleMode = useInspector(api, (state) => state.sampleMode);
  const actions = useInspector(api, (state) => state.actions);
  const loading = useInspector(api, (state) => state.review.loading ?? false);
  const error = useInspector(api, (state) => state.review.error ?? null);
  const source = useInspector(api, (state) => state.review.source ?? "legacy");
  const pendingAction = useInspector(api, (state) => state.review.pendingAction ?? null);
  const stagedContext = useComposer(
    (state) => state.contextItemsBySessionId[sessionId] ?? EMPTY_CONTEXT_ITEMS,
  );
  const [confirm, setConfirm] = useState<{ action: "apply" | "discard"; path: string } | null>(
    null,
  );

  if (files.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PaneHeading
          family="review"
          summary={loading ? "Loading review" : "0 files"}
          trailing={trailing}
        />
        <div className="flex min-h-0 flex-1 items-center justify-center px-6">
          <p
            className="text-center text-muted-foreground text-xs"
            role={error === null ? "status" : "alert"}
          >
            {error ?? (loading ? "Loading changed files…" : "Nothing to review")}
          </p>
        </div>
      </div>
    );
  }

  const selected = files.find((file) => file.path === selectedPath);
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const viewedCount = files.filter((file) => viewedByPath[file.path] === true).length;
  const contextAlreadyAdded =
    selected !== undefined &&
    stagedContext.some(
      (item) => item.source.kind === "review" && item.source.path === selected.path,
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeading
        family="review"
        summary={`${files.length} ${files.length === 1 ? "file" : "files"} · +${additions} −${deletions} · ${viewedCount}/${files.length} viewed`}
        trailing={trailing}
      />
      {error !== null && (
        <p className="border-border border-b px-2 py-1.5 text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      <div
        aria-label="Changed files"
        className="max-h-[38%] shrink-0 overflow-y-auto border-border border-b p-1.5"
      >
        {files.map((file) => (
          <FileListRow
            api={api}
            file={file}
            key={file.path}
            selected={file.path === selectedPath}
            viewed={viewedByPath[file.path] === true}
          />
        ))}
      </div>
      {selected === undefined ? (
        <div className="flex flex-1 items-center justify-center px-6">
          <p className="text-center text-muted-foreground text-xs">
            Pick a file above to read its change.
          </p>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-1 border-border border-b px-2 py-1">
            <div aria-label="Diff layout" className="flex items-center gap-0.5" role="group">
              {(["unified", "split"] as const).map((mode) => (
                <button
                  aria-pressed={view === mode}
                  className={cn(
                    "h-6 cursor-pointer rounded-md px-2 text-xs capitalize outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
                    view === mode
                      ? "bg-secondary font-medium"
                      : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  )}
                  key={mode}
                  onClick={() => api.getState().setReviewView(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </div>
            <button
              aria-label={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
              aria-pressed={wrap}
              className={cn(
                "flex h-6 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs outline-none transition-colors duration-(--motion-duration-fast) focus-visible:ring-2 focus-visible:ring-ring",
                wrap ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/60",
              )}
              onClick={() => api.getState().setReviewWrap(!wrap)}
              type="button"
            >
              <WrapText aria-hidden="true" className="size-3.5" />
              Wrap
            </button>
            {selected.kind === "text" && selected.patch !== null && (
              <Button
                onClick={() => {
                  const item = captureReviewContext(sessionId, selected);
                  if (item !== null) {
                    actionRegistry.execute({ id: "context.capture", args: { sessionId, item } });
                  }
                }}
                size="xs"
                variant={contextAlreadyAdded ? "secondary" : "outline"}
              >
                <Layers3 aria-hidden="true" />
                {contextAlreadyAdded ? "Refresh context" : "Add change"}
              </Button>
            )}
            <span className="flex-1" />
            {selected.applyState === "pending" ? (
              <>
                <Button
                  disabled={
                    pendingAction !== null ||
                    !(source === "turn"
                      ? actions.reviewApply.enabled
                      : actions.reviewDiscard.enabled)
                  }
                  onClick={() => setConfirm({ action: "discard", path: selected.path })}
                  size="xs"
                  title={
                    pendingAction !== null
                      ? "Waiting for the host to confirm the current review action."
                      : ((source === "turn"
                          ? actions.reviewApply.reason
                          : actions.reviewDiscard.reason) ?? undefined)
                  }
                  variant="destructive-outline"
                >
                  Discard
                </Button>
                <Button
                  disabled={pendingAction !== null || !actions.reviewApply.enabled}
                  onClick={() => setConfirm({ action: "apply", path: selected.path })}
                  size="xs"
                  title={
                    pendingAction !== null
                      ? "Waiting for the host to confirm the current review action."
                      : (actions.reviewApply.reason ?? undefined)
                  }
                >
                  Keep
                </Button>
              </>
            ) : (
              <Badge size="sm" variant={selected.applyState === "applied" ? "success" : "outline"}>
                {selected.applyState === "applied" ? "Kept" : "Discarded"}
              </Badge>
            )}
          </div>
          <FileBody api={api} file={selected} />
        </>
      )}
      {confirm !== null && (
        <ApplyDiscardDialog
          action={confirm.action}
          api={api}
          onClose={() => setConfirm(null)}
          path={confirm.path}
          sampleMode={sampleMode}
        />
      )}
    </div>
  );
}
