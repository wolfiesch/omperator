import { Popover } from "@base-ui/react/popover";
import { IconButton } from "@t4-code/ui";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { rendererPlatform } from "../state/store-instance.ts";

interface BeforeInstallPromptEvent extends Event {
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
  prompt(): Promise<void>;
}

declare global {
  interface Navigator {
    readonly standalone?: boolean;
  }

  interface WindowEventMap {
    readonly appinstalled: Event;
    readonly beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

export function isIosInstallDevice(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
): boolean {
  return (
    /iPad|iPhone|iPod/iu.test(userAgent) ||
    (/Macintosh|MacIntel/iu.test(`${userAgent} ${platform}`) && maxTouchPoints > 1)
  );
}

export function isHostedBrowserRuntime(
  shellAvailable: boolean,
  nativeShellAvailable: boolean,
  gatewayConfigAvailable: boolean,
) {
  return shellAvailable && !nativeShellAvailable && gatewayConfigAvailable;
}

export function isStandaloneWebApp(displayModeStandalone: boolean, navigatorStandalone: boolean) {
  return displayModeStandalone || navigatorStandalone;
}

function currentStandaloneState() {
  if (typeof window === "undefined") return false;
  return isStandaloneWebApp(
    window.matchMedia("(display-mode: standalone)").matches,
    window.navigator.standalone === true,
  );
}

function currentIosState() {
  if (typeof window === "undefined") return false;
  return isIosInstallDevice(
    window.navigator.userAgent,
    window.navigator.platform,
    window.navigator.maxTouchPoints,
  );
}

export function HostedAppAction() {
  const browserHosted =
    typeof window !== "undefined" &&
    isHostedBrowserRuntime(
      rendererPlatform.shell !== null,
      window.ompShell !== undefined,
      document.getElementById("t4-backend") !== null,
    );
  const [standalone, setStandalone] = useState(currentStandaloneState);
  const [installationCompleted, setInstallationCompleted] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [ios] = useState(currentIosState);

  useEffect(() => {
    if (!browserHosted) return;
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const onDisplayModeChange = () => setStandalone(currentStandaloneState());
    const onInstallPrompt = (event: BeforeInstallPromptEvent) => {
      event.preventDefault();
      setInstallationCompleted(false);
      setInstallPrompt(event);
      setInstructionsOpen(false);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setInstructionsOpen(false);
      setInstallationCompleted(true);
    };

    displayMode.addEventListener("change", onDisplayModeChange);
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      displayMode.removeEventListener("change", onDisplayModeChange);
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [browserHosted]);

  if (!browserHosted) return null;
  if (!standalone && installationCompleted) return null;

  const label = standalone ? "Reload T4 Code" : "Install T4 Code";
  const handleAction = async () => {
    if (standalone) {
      window.location.reload();
      return;
    }
    if (installPrompt === null) {
      setInstructionsOpen(true);
      return;
    }

    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") setInstallationCompleted(true);
    } catch {
      setInstallPrompt(null);
      setInstructionsOpen(true);
    }
  };

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (!standalone && installPrompt === null) setInstructionsOpen(open);
      }}
      open={!standalone && installPrompt === null && instructionsOpen}
    >
      <Popover.Trigger
        render={
          <IconButton
            aria-label={label}
            className="size-11 lg:size-7"
            onClick={() => void handleAction()}
            size="icon-sm"
            title={label}
          >
            {standalone ? <RefreshCw aria-hidden="true" /> : <Download aria-hidden="true" />}
          </IconButton>
        }
      />
      <Popover.Portal>
        <Popover.Positioner align="end" className="z-50" side="bottom" sideOffset={6}>
          <Popover.Popup className="w-[min(17rem,calc(100vw-1rem))] rounded-lg bg-popover p-3 text-popover-foreground shadow-(--overlay-shadow) outline-none transition-[scale,opacity] duration-(--motion-duration-fast) data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0">
            <Popover.Title className="font-medium text-sm">Install T4 Code</Popover.Title>
            <Popover.Description className="pt-1 text-muted-foreground text-xs leading-5">
              {ios
                ? "Tap Share in the browser, then Add to Home Screen."
                : "Open the browser menu, then choose Install app or Add to Home screen."}
            </Popover.Description>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
