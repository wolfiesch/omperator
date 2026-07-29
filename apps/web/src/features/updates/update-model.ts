import type { DesktopUpdatePhase, DesktopUpdateState } from "@t4-code/protocol/desktop-ipc";

export type AppUpdateDelivery = "desktop" | "android" | "web";

/** One renderer-owned shape across Electron, Android, and the hosted web app. */
export interface AppUpdateState extends DesktopUpdateState {
  readonly delivery: AppUpdateDelivery;
  /** Monotonic Android-native state revision; renderer snapshots never synthesize this. */
  readonly nativeRevision?: number;
  /** Android has handed one immutable, verified APK to the system installer. */
  readonly handoff?: "installer";
  /** Reserved for trusted, bounded release metadata when the feed publishes it. */
  readonly releaseNotes?: string;
}

export interface AppUpdateAction {
  readonly label: string;
  readonly busy: boolean;
  readonly kind: "check" | "download" | "restart" | "refresh";
}

export function updateIsAvailable(phase: DesktopUpdatePhase): boolean {
  return phase === "available" || phase === "manual" || phase === "downloading" || phase === "ready";
}

export function actionForUpdate(state: AppUpdateState): AppUpdateAction {
  if (state.delivery === "web") {
    return { label: "Refresh T4 Code", busy: false, kind: "refresh" };
  }
  if (state.delivery === "android" && state.handoff === "installer") {
    return { label: "Check again", busy: false, kind: "check" };
  }
  switch (state.phase) {
    case "checking":
      return { label: "Checking…", busy: true, kind: "check" };
    case "downloading":
      return { label: "Downloading…", busy: true, kind: "download" };
    case "available":
    case "manual":
      return { label: state.delivery === "android" ? "Download and verify" : "Download update", busy: false, kind: "download" };
    case "ready":
      return { label: "Restart to update", busy: false, kind: "restart" };
    case "error":
      return { label: "Try again", busy: false, kind: "check" };
    case "current":
      return { label: "Check again", busy: false, kind: "check" };
    case "idle":
      return { label: "Check for updates", busy: false, kind: "check" };
  }
}

export function updateStatusLabel(state: AppUpdateState): string {
  if (state.delivery === "web") return "Web deployment";
  if (state.delivery === "android" && state.handoff === "installer") return "Installer opened";
  switch (state.phase) {
    case "idle":
      return "Ready to check";
    case "checking":
      return "Checking";
    case "current":
      return "Up to date";
    case "available":
    case "manual":
      return "Update available";
    case "downloading":
      return "Downloading";
    case "ready":
      return "Ready to restart";
    case "error":
      return "Check failed";
  }
}

export function defaultUpdateMessage(state: AppUpdateState): string {
  if (state.message !== undefined) return state.message;
  if (state.delivery === "web") {
    return "The web app follows the current T4 deployment. Refresh to load the latest published build.";
  }
  switch (state.phase) {
    case "idle":
      return "T4 Code checks release metadata quietly. It never downloads, installs, or restarts without your action.";
    case "checking":
      return "Comparing this build with the latest published T4 Code release.";
    case "current":
      return "This installation matches the latest published T4 Code release.";
    case "available":
      return "A newer release is ready to download. You choose when to install it.";
    case "manual":
      return state.delivery === "android"
        ? "A newer APK is ready. T4 Code will download and verify the exact release before Android asks you to confirm installation."
        : "A newer release is ready. T4 Code will open the correct package for this installation.";
    case "downloading":
      return "T4 Code is downloading the published release for verification in the background.";
    case "ready":
      return "The verified update is ready. Restart when it is convenient.";
    case "error":
      return "T4 Code could not check the published release. Your current installation is unchanged.";
  }
}

export function formatUpdateTimestamp(value: number | undefined): string | null {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return null;
  }
}
