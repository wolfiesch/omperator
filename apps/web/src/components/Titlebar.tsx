// 52px window titlebar. Inert zones drag the frameless window; every control
// opts out. macOS traffic-light inset is reserved via [data-platform];
// Linux window controls are injected by the desktop shell later.
import { Badge, BrandLockup, IconButton, Tooltip, TooltipPopup, TooltipTrigger } from "@t4-code/ui";
import { useNavigate } from "@tanstack/react-router";
import { Command, Moon, PanelLeft, Settings, Sun } from "lucide-react";

import { rendererPlatform, useWorkspace, workspaceStore } from "../state/store-instance.ts";
import { resolveTheme } from "../theme/theme.ts";
import { HostedAppAction } from "./HostedAppAction.tsx";
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
            className="size-11 sm:size-7"
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <IconButton
            aria-label="Open settings"
            className="size-11 sm:size-7"
            onClick={() => void navigate({ to: "/settings" })}
            size="icon-sm"
          >
            <Settings />
          </IconButton>
        }
      />
      <TooltipPopup side="bottom">Settings (Ctrl+,)</TooltipPopup>
    </Tooltip>
  );
}

export function Titlebar({
  onToggleRail,
  railToggle,
}: {
  onToggleRail: () => void;
  railToggle: RailTogglePresentation;
}) {
  return (
    <header className="drag-region workspace-topbar titlebar-traffic-light-inset titlebar-window-controls-reserve shrink-0 gap-1 border-border border-b bg-background px-1 sm:gap-2 sm:px-3">
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
      <BrandLockup className="min-w-0" />
      <div className="flex-1" />
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
      <HostedAppAction />
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              aria-label="Search sessions and commands"
              className="size-11 sm:size-7"
              onClick={() => workspaceStore.getState().setPaletteOpen(true)}
              size="icon-sm"
            >
              <Command />
            </IconButton>
          }
        />
        <TooltipPopup side="bottom">Search sessions and commands (Ctrl+K)</TooltipPopup>
      </Tooltip>
      <ThemeToggle />
      <SettingsButton />
    </header>
  );
}
