import { Button, IconButton } from "@t4-code/ui";
import {
  FileCode2,
  GitCompareArrows,
  Globe2,
  Layers3,
  MessageSquareText,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";

import { contextSourceDescription, type ContextPacketItem } from "./context-packet.ts";

const SOURCE_ICONS = {
  file: FileCode2,
  transcript: MessageSquareText,
  review: GitCompareArrows,
  terminal: SquareTerminal,
  browser: Globe2,
} as const;

export function ContextPacketChips({
  items,
  deferredReason,
  onRemove,
  onClear,
}: {
  readonly items: readonly ContextPacketItem[];
  readonly deferredReason: string | null;
  readonly onRemove: (id: string) => void;
  readonly onClear: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="border-input border-b bg-secondary/25 px-3 pt-2.5 pb-2">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
        <Layers3 aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-foreground">Working set</span>
        <span className="hidden truncate sm:inline">for the next new message</span>
        <span aria-hidden="true" className="shrink-0">
          ·
        </span>
        <span className="shrink-0">{items.length}</span>
        <Button
          className="ms-auto h-6 shrink-0 px-1.5 text-muted-foreground"
          onClick={onClear}
          size="xs"
          variant="ghost"
        >
          <Trash2 aria-hidden="true" className="size-3" />
          Clear
        </Button>
      </div>
      <ul aria-label="Working set for the next new message" className="flex flex-wrap gap-1.5">
        {items.map((item) => {
          const SourceIcon = SOURCE_ICONS[item.source.kind];
          const source = contextSourceDescription(item.source);
          return (
            <li
              className="group flex h-7 max-w-full items-center gap-1.5 rounded-md border border-input bg-background px-1.5 text-xs"
              key={item.id}
            >
              <SourceIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <details className="relative min-w-0">
                <summary className="max-w-48 cursor-pointer truncate" title={source}>
                  {item.label}
                </summary>
                <div className="absolute bottom-full start-0 z-30 mb-2 max-h-72 w-[min(38rem,calc(100vw-3rem))] overflow-auto rounded-lg border border-border bg-popover p-3 shadow-(--overlay-shadow)">
                  <p className="mb-2 text-muted-foreground text-xs">{source}</p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {item.body}
                  </pre>
                </div>
              </details>
              {(item.redacted || item.truncated) && (
                <span
                  className="text-muted-foreground"
                  title="Sensitive values may be redacted and long excerpts are shortened"
                >
                  {item.redacted ? "redacted" : "shortened"}
                </span>
              )}
              <IconButton
                aria-label={`Remove ${item.label} from the working set`}
                className="size-5"
                onClick={() => onRemove(item.id)}
                size="icon-xs"
              >
                <X className="size-3" />
              </IconButton>
            </li>
          );
        })}
      </ul>
      {deferredReason !== null && (
        <p className="mt-1.5 text-muted-foreground text-xs">{deferredReason}</p>
      )}
    </div>
  );
}
