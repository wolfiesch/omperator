import { cn, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { Brain, Hammer, Zap } from "lucide-react";

import { isSessionMode, isThinkingLevel, type SessionIntent } from "../session-runtime/intents.ts";
import {
  thinkingLabel,
  type ComposerControlsSnapshot,
} from "../session-runtime/session-controls.ts";
import { ControlMenu } from "./ComposerControls.tsx";

const MODE_LABEL: Record<string, string> = {
  build: "Build",
  plan: "Plan first",
  readOnly: "Read only",
};

const MODE_DETAIL: Record<string, string | null> = {
  build: "Make changes directly",
  plan: "Propose a plan before touching anything",
  readOnly: "Inspect only; no writes, no commands",
};
const SESSION_MODES = ["build", "plan", "readOnly"] as const;

export function fastModeTooltip(enabled: boolean): string {
  return enabled
    ? "Fast mode requests provider priority processing; reasoning effort is unchanged"
    : "Request provider priority processing when supported; reasoning effort is unchanged";
}

export function RuntimeOptions({
  controls,
  disabled,
  onIntent,
  compact,
}: {
  readonly controls: ComposerControlsSnapshot;
  readonly disabled: boolean;
  readonly onIntent: (intent: SessionIntent) => void;
  readonly compact: boolean;
}) {
  const controlClassName = compact
    ? "h-11 w-full max-w-none justify-start px-2 text-sm"
    : undefined;

  return (
    <>
      <ControlMenu
        busy={controls.pendingControl === "model"}
        choices={controls.modelChoices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          detail: choice.kind === "role" ? `Role · ${choice.detail ?? "Inherited"}` : choice.detail,
          disabledReason: controls.modelSupported ? null : controls.modelUnsupportedReason,
        }))}
        className={controlClassName}
        disabled={disabled || controls.modelLabel === null}
        icon={null}
        label="Model — this session"
        note={controls.modelSupported ? null : controls.modelUnsupportedReason}
        onSelect={(id) => {
          const choice = controls.modelChoices.find((entry) => entry.id === id);
          if (choice === undefined || (choice.selector === null && choice.role === null)) return;
          onIntent({ kind: "setModel", selector: choice.selector, role: choice.role });
        }}
        value={controls.modelSelectedId ?? ""}
        valueLabel={controls.modelLabel ?? "Model —"}
      />
      <ControlMenu
        busy={controls.pendingControl === "thinking"}
        choices={controls.thinkingLevels.map((level) => ({
          id: level,
          label: thinkingLabel(level),
          detail: null,
          disabledReason: controls.thinkingSupported ? null : controls.thinkingUnsupportedReason,
        }))}
        className={controlClassName}
        disabled={disabled}
        icon={<Brain aria-hidden="true" className="size-3.5 shrink-0" />}
        label="Thinking — this session"
        note={controls.thinkingSupported ? null : controls.thinkingUnsupportedReason}
        onSelect={(id) => {
          if (isThinkingLevel(id)) onIntent({ kind: "setThinking", level: id });
        }}
        value={controls.thinking ?? ""}
        valueLabel={thinkingLabel(controls.thinking)}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-busy={controls.pendingControl === "fast" || undefined}
              aria-disabled={!controls.fastSupported || undefined}
              aria-label={controls.fast ? "Fast mode on" : "Fast mode off"}
              aria-pressed={controls.fast}
              className={cn(
                "flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64",
                controls.fast && "text-accent-text hover:text-accent-text",
                !controls.fastSupported &&
                  "cursor-default opacity-64 hover:bg-transparent hover:text-muted-foreground",
                controls.pendingControl === "fast" && "animate-pulse motion-reduce:animate-none",
                compact && "h-11 w-full justify-start px-2 text-sm",
              )}
              disabled={disabled || controls.pendingControl === "fast"}
              onClick={() => {
                if (controls.fastSupported) {
                  onIntent({ kind: "setFast", enabled: !controls.fast });
                }
              }}
              type="button"
            >
              <Zap aria-hidden="true" className="size-3.5" />
              Fast
            </button>
          }
        />
        <TooltipPopup side="top">
          {!controls.fastSupported
            ? (controls.fastUnsupportedReason ?? "Not offered by this host")
            : fastModeTooltip(controls.fast)}
        </TooltipPopup>
      </Tooltip>
      {controls.modeSupported && controls.mode !== null && (
        <ControlMenu
          choices={SESSION_MODES.map((mode) => ({
            id: mode,
            label: MODE_LABEL[mode] ?? mode,
            detail: MODE_DETAIL[mode] ?? null,
          }))}
          className={controlClassName}
          disabled={disabled}
          icon={<Hammer aria-hidden="true" className="size-3.5 shrink-0" />}
          label="Mode"
          onSelect={(id) => {
            if (isSessionMode(id)) onIntent({ kind: "setMode", mode: id });
          }}
          value={controls.mode}
          valueLabel={MODE_LABEL[controls.mode] ?? controls.mode}
        />
      )}
    </>
  );
}
