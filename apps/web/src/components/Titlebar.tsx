// 52px window titlebar. Inert zones drag the frameless window; every control
// opts out. macOS traffic-light inset is reserved via [data-platform];
// Linux window controls are injected by the desktop shell later.
import { Badge, BrandLockup, IconButton, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { Minimize2, Moon, PanelLeft, Search, Settings, Sun, UsersRound } from "lucide-react";
import { useEffect } from "react";

import { updateIsAvailable } from "../features/updates/update-model.ts";
import { subscribeNativeUpdateSettingsOpen } from "../features/updates/update-navigation.ts";
import { useAppUpdateState } from "../features/updates/update-store.ts";
import { rendererPlatform, useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { resolveTheme } from "../theme/theme.ts";
import { HostedAppAction } from "./HostedAppAction.tsx";
import { MobileConnectionAction } from "./MobileConnectionAction.tsx";
import type { RailTogglePresentation } from "./rail-toggle.ts";

function ThemeToggle() {
  const theme = useWorkspace((state) => state.theme);
  const resolved = resolveTheme(theme);
  const nextLabel = resolved === "dark" ? "Switch to light colors" : "Switch to dark colors";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            aria-label={nextLabel}
            className="hidden size-11 sm:inline-flex sm:size-7"
            onClick={() =>
              workspaceStore.getState().setTheme(resolved === "dark" ? "light" : "dark")
            }
            size="icon-sm"
          >
            {resolved === "dark" ? (
              <Sun className="theme-icon-enter" key="sun" />
            ) : (
              <Moon className="theme-icon-enter" key="moon" />
            )}
          </IconButton>
        }
      />
      <TooltipPopup side="bottom">{nextLabel}</TooltipPopup>
    </Tooltip>
  );
}

function SettingsButton() {
  const navigate = useNavigate();
  const update = useAppUpdateState();
  const hasUpdate = updateIsAvailable(update.phase);

  useEffect(
    () => subscribeNativeUpdateSettingsOpen(() => void navigate({ to: "/settings" })),
    [navigate],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            aria-label={hasUpdate ? "Open settings; T4 Code update available" : "Open settings"}
            className="size-11 sm:size-7"
            onClick={() => void navigate({ to: "/settings" })}
            size="icon-sm"
          >
            <span className="relative">
              <Settings />
              {hasUpdate && (
                <span
                  aria-hidden="true"
                  className="absolute -end-1 -top-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
                />
              )}
            </span>
          </IconButton>
        }
      />
      <TooltipPopup side="bottom">
        {hasUpdate ? "Settings · T4 Code update available" : "Settings (Ctrl+,)"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function Titlebar({
  focusMode,
  onExitFocus,
  onToggleRail,
  railToggle,
}: {
  focusMode: boolean;
  onExitFocus: () => void;
  onToggleRail: () => void;
  railToggle: RailTogglePresentation;
}) {
  const navigate = useNavigate();
  return (
    <header
      className="drag-region workspace-topbar titlebar-traffic-light-inset titlebar-window-controls-reserve shrink-0 gap-1 border-border/60 border-b bg-(--sidebar-background) px-1 sm:gap-1.5 sm:px-2.5"
      data-window-chrome={rendererPlatform.windowChrome ?? undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-expanded={railToggle.expanded}
              aria-label={railToggle.label}
              className="size-11 sm:size-7"
              onClick={onToggleRail}
              size="icon-sm"
            >
              <PanelLeft />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">{railToggle.label} (Ctrl+B)</TooltipPopup>
      </Tooltip>
      <BrandLockup
        aria-label="T4 Code"
        className="min-w-0 [&>span>span]:hidden sm:[&>span>span]:inline"
      />
      <div className="flex-1" />
      {focusMode && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                aria-label="Exit focus mode"
                className="flex size-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border/60 bg-secondary/60 text-foreground outline-none transition-colors duration-(--motion-duration-fast) hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:h-7 sm:w-auto sm:rounded-md sm:px-2"
                onClick={onExitFocus}
                type="button"
              >
                <Minimize2 aria-hidden="true" className="size-3.5" />
                <span className="hidden text-xs md:inline">Focus mode</span>
              </button>
            }
          />
          <TooltipPopup side="bottom">Exit focus mode (Ctrl+Shift+F)</TooltipPopup>
        </Tooltip>
      )}
      {rendererPlatform.mode === "browser" && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge className="no-drag hidden cursor-default sm:inline-flex" variant="outline">
                Sample data
              </Badge>
            }
          />
          <TooltipPopup side="bottom">Built-in sample sessions. Nothing here is live.</TooltipPopup>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="Open Agent View"
              className="size-11 sm:size-7"
              onClick={() => void navigate({ to: "/agents" })}
              size="icon-sm"
            >
              <UsersRound />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">Agent View</TooltipPopup>
      </Tooltip>
      <HostedAppAction />
      <MobileConnectionAction />
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="Search sessions and transcripts"
              className="size-11 sm:size-7"
              onClick={() => workspaceStore.getState().setPaletteOpen(true)}
              size="icon-sm"
            >
              <Search />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">Search sessions and transcripts (Ctrl+K)</TooltipPopup>
      </Tooltip>
      <ThemeToggle />
      <SettingsButton />
    </header>
  );
}
