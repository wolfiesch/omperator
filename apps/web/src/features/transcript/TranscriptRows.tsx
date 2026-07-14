// Row renderers for the transcript timeline. No card-per-message: user
// messages get a quiet 4% wash block, assistant prose flows on the page, and
// tool work reads as a compact causal group with per-call disclosure.
// Elapsed-time labels self-tick their own text nodes (adapted from T3 Code
// MessagesTimeline `WorkingTimer`, MIT, T3 Tools Inc., commit
// f61fa9499d96fee825492aba204593c37b27e0cb) so a running clock never
// re-renders the list.
import { AnimatedHeight, cn, Spinner } from "@t4-code/ui";
import {
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  FileJson,
  Globe,
  RotateCcw,
  SearchIcon,
  SquarePen,
  Terminal,
  Unplug,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { TranscriptImageSource } from "../session-runtime/transcript-images.ts";
import { useAnchoredDisclosure } from "./disclosure-anchor.tsx";
import { CopyButton, Markdown } from "./Markdown.tsx";
import type { ToolCall, TranscriptNotice } from "./projection.ts";
import { formatElapsed, type TranscriptRow } from "./rows.ts";
import { TranscriptImages } from "./TranscriptImages.tsx";

// ---------------------------------------------------------------------------
// Self-ticking elapsed label
// ---------------------------------------------------------------------------

/**
 * First paint is a pure function of (fromIso, nowMs) — reproducible under
 * the fixture runtime's fixed nowMs — then the label ticks forward by real
 * elapsed time from mount, mutating only its own text node.
 */
function ElapsedSince({ fromIso, nowMs }: { readonly fromIso: string; readonly nowMs: number }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [initialText] = useState(() => formatElapsed(fromIso, nowMs));
  useEffect(() => {
    const mountedAt = performance.now();
    const id = setInterval(() => {
      if (textRef.current !== null) {
        textRef.current.textContent = formatElapsed(fromIso, nowMs + performance.now() - mountedAt);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [fromIso, nowMs]);
  return (
    <span className="tabular-nums" ref={textRef}>
      {initialText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function ReasoningDisclosure({ reasoning }: { readonly reasoning: string }) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  return (
    <div className="mb-1.5">
      <button
        aria-expanded={open}
        className={cn(
          "flex min-h-11 cursor-pointer items-center gap-1 rounded-md py-0.5 pr-1.5 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6",
          open && "text-foreground",
        )}
        onClick={(event) =>
          anchoredToggle(event.currentTarget, () => setOpen((value) => !value))
        }
        type="button"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
        Reasoning
      </button>
      <AnimatedHeight>
        {open && (
          <div className="disclosure-content-enter mt-1 border-border border-l pl-3 text-muted-foreground text-xs leading-relaxed">
            <Markdown className="text-xs" text={reasoning} />
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
}

function MessageRow({
  row,
  imageSource,
}: {
  readonly row: Extract<TranscriptRow, { kind: "message" }>;
  readonly imageSource: TranscriptImageSource;
}) {
  if (row.role === "user") {
    return (
      <div className="group/message flex justify-end py-2">
        <div className="relative max-w-[85%] rounded-lg bg-secondary px-3 py-2">
          <Markdown text={row.text} />
          <TranscriptImages
            images={row.images}
            issue={row.imageIssue}
            label="Attached"
            source={imageSource}
          />
          <span className="mt-1 flex justify-end opacity-100 transition-opacity duration-(--motion-duration-fast) sm:absolute sm:-left-8 sm:top-1.5 sm:mt-0 sm:block sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/message:opacity-100">
            <CopyButton label="Copy message" text={row.text} />
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="group/message py-2">
      {row.reasoning !== "" && <ReasoningDisclosure reasoning={row.reasoning} />}
      <Markdown text={row.text} />
      <TranscriptImages
        images={row.images}
        issue={row.imageIssue}
        label="Response"
        source={imageSource}
      />
      <div
        className={cn(
          "mt-1 flex h-11 items-center gap-1 opacity-100 transition-opacity duration-(--motion-duration-fast) sm:h-6 sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/message:opacity-100",
          row.live && "invisible",
        )}
      >
        <CopyButton label="Copy response" text={row.text} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tool groups
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { readonly label: string; readonly Icon: typeof Terminal }> = {
  bash: { label: "Shell", Icon: Terminal },
  edit: { label: "Edit", Icon: SquarePen },
  read: { label: "Read", Icon: Eye },
  search: { label: "Search", Icon: SearchIcon },
  browser: { label: "Browser", Icon: Globe },
  subagent: { label: "Agent", Icon: Bot },
};

function resultText(call: ToolCall, key: string): string {
  const value = call.result?.[key];
  return typeof value === "string" ? value : "";
}

function argText(call: ToolCall, key: string): string {
  const value = call.args[key];
  return typeof value === "string" ? value : "";
}

/** One-line preview under the tool title, per known treatment. */
function toolPreview(call: ToolCall): string {
  switch (call.tool) {
    case "bash":
      return argText(call, "command");
    case "edit": {
      const path = argText(call, "path");
      const additions = call.result?.additions;
      const deletions = call.result?.deletions;
      return typeof additions === "number" && typeof deletions === "number"
        ? `${path}  +${additions} −${deletions}`
        : path;
    }
    case "read": {
      const range = argText(call, "range");
      return range === "" ? argText(call, "path") : `${argText(call, "path")}:${range}`;
    }
    case "search":
      return argText(call, "pattern");
    case "browser":
      return argText(call, "url");
    case "subagent":
      return argText(call, "task") || argText(call, "agent");
    default:
      return "";
  }
}

/** Select the compact secondary label, omitting tool-name duplicates. */
export function toolDetail(call: ToolCall): string {
  const preview = toolPreview(call);
  const detail = preview !== "" ? preview : call.title;
  const normalized = detail.trim().toLowerCase();
  const toolName = call.tool.trim().toLowerCase();
  const primaryLabel = TOOL_META[call.tool]?.label.trim().toLowerCase();
  return normalized === toolName || normalized === primaryLabel ? "" : detail;
}

/** Expanded body per known treatment; null falls back to raw JSON. */
function toolBody(call: ToolCall): { readonly text: string; readonly mono: boolean } | null {
  switch (call.tool) {
    case "bash": {
      const output = resultText(call, "output");
      return output === "" ? null : { text: output, mono: true };
    }
    case "edit": {
      const diff = resultText(call, "diff");
      return diff === "" ? null : { text: diff, mono: true };
    }
    case "read": {
      const preview = resultText(call, "preview");
      return preview === "" ? null : { text: preview, mono: true };
    }
    case "search": {
      const files = call.result?.files;
      if (!Array.isArray(files)) return null;
      const matches = call.result?.matches;
      const head = typeof matches === "number" ? `${matches} matches` : "matches";
      return { text: `${head}\n${files.filter((f) => typeof f === "string").join("\n")}`, mono: true };
    }
    case "browser": {
      const note = resultText(call, "note");
      const title = resultText(call, "title");
      const combined = [title, note].filter((part) => part !== "").join(" — ");
      return combined === "" ? null : { text: combined, mono: false };
    }
    case "subagent": {
      const summary = resultText(call, "summary");
      return summary === "" ? null : { text: summary, mono: false };
    }
    default:
      return null;
  }
}

function DiffBody({ diff }: { readonly diff: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border border-border font-mono text-xs leading-relaxed">
      {diff.split("\n").map((line, index) => (
        <div
          className={cn(
            "px-2",
            line.startsWith("+") && "bg-(--diff-added-background)",
            line.startsWith("-") && "bg-(--diff-removed-background)",
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: static diff lines never reorder
          key={index}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

const ToolCallRow = memo(function ToolCallRow({
  call,
  nowMs,
  imageSource,
}: {
  readonly call: Extract<TranscriptRow, { kind: "tool-group" }>["calls"][number];
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
}) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  const meta = TOOL_META[call.tool];
  const Icon = meta?.Icon ?? FileJson;
  const detail = toolDetail(call);
  const body = toolBody(call);
  const rawFallback = meta === undefined || (open && body === null);
  return (
    <div>
      <button
        aria-expanded={open}
        className={cn(
          "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0",
          open && "bg-accent/50",
        )}
        onClick={(event) =>
          anchoredToggle(event.currentTarget, () => setOpen((value) => !value))
        }
        type="button"
      >
        {call.state === "running" ? (
          <Spinner className="size-3.5 shrink-0 text-status-working" />
        ) : call.state === "error" ? (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0 text-status-error" />
        ) : (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-xs">{meta?.label ?? call.tool}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs">
          {detail}
        </span>
        {call.state === "running" && (
          <span className="shrink-0 text-muted-foreground text-xs">
            <ElapsedSince fromIso={call.startedAt} nowMs={nowMs} />
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      {call.state === "running" && call.progress.length > 0 && (
        <pre className="mt-0.5 ml-7 overflow-x-auto whitespace-pre-wrap font-mono text-muted-foreground text-xs leading-relaxed">
          {call.progress.join("\n")}
        </pre>
      )}
      <TranscriptImages
        className="mr-1 ml-7"
        images={call.images}
        issue={call.imageIssue}
        label={`${meta?.label ?? call.tool} result`}
        source={imageSource}
      />
      <AnimatedHeight>
        {open && (
          <div className="disclosure-content-enter mt-1 mb-1.5 ml-7 space-y-1.5">
          {Object.keys(call.args).length > 0 && (
            <pre className="overflow-x-auto rounded-md border border-border bg-(--markdown-codeblock-background) px-2 py-1.5 font-mono text-muted-foreground text-xs">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {body !== null &&
            (call.tool === "edit" ? (
              <DiffBody diff={body.text} />
            ) : (
              <pre
                className={cn(
                  "overflow-x-auto whitespace-pre-wrap rounded-md border border-border px-2 py-1.5 text-xs leading-relaxed",
                  body.mono ? "font-mono" : "font-sans",
                )}
              >
                {body.text}
              </pre>
            ))}
          {rawFallback && call.result !== null && (
            <pre className="overflow-x-auto rounded-md border border-border bg-(--markdown-codeblock-background) px-2 py-1.5 font-mono text-muted-foreground text-xs">
              {JSON.stringify(call.result, null, 2)}
            </pre>
          )}
          </div>
        )}
      </AnimatedHeight>
    </div>
  );
});

function ToolGroupRow({
  row,
  nowMs,
  imageSource,
}: {
  readonly row: Extract<TranscriptRow, { kind: "tool-group" }>;
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
}) {
  return (
    <div className="my-1.5 rounded-lg border border-border/60 px-1 py-1">
      {row.calls.map((call) => (
        <ToolCallRow call={call} imageSource={imageSource} key={call.callId} nowMs={nowMs} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notices, unknown entries, working indicator
// ---------------------------------------------------------------------------

function noticeContent(notice: TranscriptNotice): {
  readonly Icon: typeof AlertTriangle;
  readonly text: string;
  readonly toneClass: string;
} {
  switch (notice.kind) {
    case "error":
      return {
        Icon: CircleAlert,
        text: notice.message,
        toneClass: "text-destructive-foreground",
      };
    case "retry":
      return {
        Icon: RotateCcw,
        text: `Retry ${notice.attempt}: ${notice.reason}`,
        toneClass: "text-warning-foreground",
      };
    case "compaction":
      return {
        Icon: Archive,
        text: `${notice.summary}${notice.droppedEntries > 0 ? ` (${notice.droppedEntries} entries folded)` : ""}`,
        toneClass: "text-muted-foreground",
      };
    case "gap":
      return {
        Icon: Unplug,
        text: `Stream interrupted: ${notice.reason}. Catching up from a fresh snapshot.`,
        toneClass: "text-warning-foreground",
      };
    case "protocol":
      return {
        Icon: AlertTriangle,
        text: notice.message,
        toneClass: "text-warning-foreground",
      };
  }
}

function NoticeRow({ row }: { readonly row: Extract<TranscriptRow, { kind: "notice" }> }) {
  const { Icon, text, toneClass } = noticeContent(row.notice);
  return (
    <div className={cn("flex items-start gap-2 py-2 text-xs", toneClass)} role="note">
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </div>
  );
}

function UnknownEntryRow({
  row,
}: {
  readonly row: Extract<TranscriptRow, { kind: "unknown-entry" }>;
}) {
  const [open, setOpen] = useState(false);
  const anchoredToggle = useAnchoredDisclosure();
  return (
    <div className="py-1">
      <button
        aria-expanded={open}
        className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0"
        onClick={(event) =>
          anchoredToggle(event.currentTarget, () => setOpen((value) => !value))
        }
        type="button"
      >
        <FileJson aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="font-mono">{row.entryKind}</span>
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3.5 transition-transform duration-(--motion-duration-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      <AnimatedHeight>
        {open && (
          <pre className="disclosure-content-enter mt-1 ml-7 overflow-x-auto rounded-md border border-border bg-(--markdown-codeblock-background) px-2 py-1.5 font-mono text-muted-foreground text-xs">
            {JSON.stringify(row.data, null, 2)}
          </pre>
        )}
      </AnimatedHeight>
    </div>
  );
}

function WorkingRow({
  row,
  nowMs,
}: {
  readonly row: Extract<TranscriptRow, { kind: "working" }>;
  readonly nowMs: number;
}) {
  return (
    <div className="flex items-center gap-2 py-3 text-status-working text-xs">
      <Spinner className="size-3.5" />
      <span>
        Working for <ElapsedSince fromIso={row.startedAt} nowMs={nowMs} />
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const TranscriptRowContent = memo(function TranscriptRowContent({
  row,
  nowMs,
  imageSource,
}: {
  readonly row: TranscriptRow;
  /** Elapsed-label time base from the session runtime snapshot. */
  readonly nowMs: number;
  readonly imageSource: TranscriptImageSource;
}) {
  switch (row.kind) {
    case "message":
      return <MessageRow imageSource={imageSource} row={row} />;
    case "tool-group":
      return <ToolGroupRow imageSource={imageSource} nowMs={nowMs} row={row} />;
    case "notice":
      return <NoticeRow row={row} />;
    case "unknown-entry":
      return <UnknownEntryRow row={row} />;
    case "working":
      return <WorkingRow nowMs={nowMs} row={row} />;
  }
});
