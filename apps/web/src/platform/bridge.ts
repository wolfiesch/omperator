// Renderer platform seam. The Electron preload injects `window.ompShell`,
// which is a `DesktopShellPort` — a typed command/event port to the desktop
// backend and nothing more. It has no UI persistence: workspace view state
// is always renderer-local (localStorage), in both modes. Components never
// look past this boundary for platform facts.
import { isBrowserShellPort, type BrowserShellPort, type DesktopShellPort } from "@t4-code/client";

import { createBrowserShellPort } from "./browser-shell-port.ts";
import { createLocalStoragePersistence, type WorkspacePersistence } from "../state/persistence.ts";
import { WORKSPACE_STORAGE_KEY } from "../state/workspace-store.ts";

export type ShellPlatform = "linux" | "darwin";

export interface RendererPlatformOptions {
  readonly forceFixture?: boolean;
}

export interface RendererPlatform {
  /** "desktop" when a live desktop-compatible shell port is available. */
  readonly mode: "desktop" | "browser";
  /** Native window chrome exists only when Electron injected the shell port. */
  readonly windowChrome: ShellPlatform | null;
  /** True only for the explicit, read-only public demo build. */
  readonly demo: boolean;
  readonly platform: ShellPlatform;
  /** Workspace view-state persistence; always renderer-local. */
  readonly persistence: WorkspacePersistence;
  /** The desktop command/event port; null in the browser. */
  readonly shell: DesktopShellPort | null;
  /** The native browser surface port; only available in the desktop host. */
  readonly browser: BrowserShellPort | null;
}

declare global {
  interface Window {
    ompShell?: DesktopShellPort;
    t4Browser?: BrowserShellPort;
  }
}

function injectedShell(): DesktopShellPort | null {
  if (typeof window === "undefined") return null;
  const shell = window.ompShell;
  return shell !== undefined && shell.kind === "desktop" ? shell : null;
}

function injectedBrowser(): BrowserShellPort | null {
  if (typeof window === "undefined") return null;
  return isBrowserShellPort(window.t4Browser) ? window.t4Browser : null;
}


export function resolveRendererPlatform(
  platformOverride?: ShellPlatform,
  options: RendererPlatformOptions = {},
): RendererPlatform {
  const forceFixture = options.forceFixture === true;
  const shell = forceFixture ? null : injectedShell();
  const platform =
    shell?.platform ??
    platformOverride ??
    (typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "darwin" : "linux");

  // The public demo must stay on deterministic fixtures even if a URL or
  // injected global tries to supply a live backend.
  let resolvedShell: DesktopShellPort | null = shell;
  if (resolvedShell === null && !forceFixture) {
    resolvedShell = createBrowserShellPort();
  }

  return {
    mode: resolvedShell === null ? "browser" : "desktop",
    demo: forceFixture,
    platform,
    windowChrome: shell === null ? null : platform,
    persistence: createLocalStoragePersistence(WORKSPACE_STORAGE_KEY),
    shell: resolvedShell,
    browser: shell === null ? null : injectedBrowser(),
  };
}
