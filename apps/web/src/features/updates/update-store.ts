import type { DesktopShellPort } from "@t4-code/client";
import { decodeAndroidUpdateState } from "@t4-code/protocol";
import type { DesktopUpdateState } from "@t4-code/protocol/desktop-ipc";
import { useSyncExternalStore } from "react";

import packageMetadata from "../../../package.json" with { type: "json" };
import { nativeMobilePlatform, nativeUpdatePlugin, type NativeUpdateState } from "../../platform/native-mobile.ts";
import { rendererPlatform } from "../../state/store-instance.ts";
import type { AppUpdateState } from "./update-model.ts";

const BUILD_VERSION = packageMetadata.version;

type Listener = () => void;

interface UpdateShell extends DesktopShellPort {
  readonly getUpdateState?: () => Promise<DesktopUpdateState>;
  readonly checkForUpdate?: () => Promise<DesktopUpdateState>;
  readonly downloadUpdate?: () => Promise<DesktopUpdateState>;
  readonly restartToUpdate?: () => Promise<DesktopUpdateState>;
  readonly onUpdateState?: (listener: (state: DesktopUpdateState) => void) => () => void;
}

function initialState(): AppUpdateState {
  const mobile = nativeMobilePlatform();
  if (mobile === "android") {
    return { version: 1, currentVersion: BUILD_VERSION, phase: "idle", delivery: "android" };
  }
  const shell = rendererPlatform.shell as UpdateShell | null;
  if (shell !== null && shell.getUpdateState !== undefined) {
    return { version: 1, currentVersion: BUILD_VERSION, phase: "idle", delivery: "desktop" };
  }
  return { version: 1, currentVersion: BUILD_VERSION, phase: "current", delivery: "web" };
}

function fromDesktop(state: DesktopUpdateState): AppUpdateState {
  return Object.freeze({ ...state, delivery: "desktop" });
}

export function fromAndroidUpdateState(state: NativeUpdateState): AppUpdateState {
  const decoded = decodeAndroidUpdateState(state);
  const checkedAt = decoded.checkedAt;
  let phase: AppUpdateState["phase"];
  let handoff: AppUpdateState["handoff"];
  switch (decoded.phase) {
    case "available":
      phase = "manual";
      break;
    case "installer":
      phase = "manual";
      handoff = "installer";
      break;
    case "idle":
      phase = "idle";
      break;
    case "checking":
      phase = "checking";
      break;
    case "current":
      phase = "current";
      break;
    case "downloading":
      phase = "downloading";
      break;
    case "error":
      phase = "error";
      break;
    default:
      throw new Error("invalid Android updater phase");
  }
  const message = decoded.error ?? decoded.message;
  return Object.freeze({
    version: 1,
    currentVersion: decoded.currentVersion,
    phase,
    delivery: "android",
    nativeRevision: decoded.revision,
    ...(handoff === undefined ? {} : { handoff }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(decoded.latestVersion === undefined ? {} : { availableVersion: decoded.latestVersion }),
    ...(message === undefined ? {} : { message }),
  });
}

export function shouldAcceptAndroidRevision(current: number | undefined, next: number): boolean {
  return current === undefined || next >= current;
}

class AppUpdateController {
  private snapshot = initialState();
  private readonly listeners = new Set<Listener>();
  private stopNativeState: (() => void) | null = null;
  private androidCheck: Promise<NativeUpdateState> | null = null;
  private androidDownload: Promise<NativeUpdateState> | null = null;
  private nativeListenerGeneration = 0;
  private started = false;

  readonly getSnapshot = (): AppUpdateState => this.snapshot;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private publish(snapshot: AppUpdateState): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private publishAndroid(state: NativeUpdateState): void {
    const next = fromAndroidUpdateState(state);
    if (
      this.snapshot.delivery === "android" &&
      next.nativeRevision !== undefined &&
      !shouldAcceptAndroidRevision(this.snapshot.nativeRevision, next.nativeRevision)
    ) {
      return;
    }
    this.publish(next);
  }

  private fail(message: string): void {
    this.publish({
      ...this.snapshot,
      phase: "error",
      message,
    });
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    if (this.snapshot.delivery === "desktop") {
      const shell = rendererPlatform.shell as UpdateShell | null;
      if (shell === null) return;
      this.stopNativeState = shell.onUpdateState?.((state) => this.publish(fromDesktop(state))) ?? null;
      void shell.getUpdateState?.().then(
        (state) => this.publish(fromDesktop(state)),
        () => this.fail("T4 Code could not read the updater state."),
      );
      return;
    }
    if (this.snapshot.delivery === "android") {
      const plugin = nativeUpdatePlugin();
      if (plugin === null) {
        this.fail("The Android update service is unavailable. Close T4 Code and open it again.");
        return;
      }
      const generation = ++this.nativeListenerGeneration;
      void this.startAndroid(plugin, generation);
    }
  }

  private async startAndroid(plugin: NonNullable<ReturnType<typeof nativeUpdatePlugin>>, generation: number): Promise<void> {
    try {
      const handle = await plugin.addListener("stateChanged", (state) => {
        if (!this.started || generation !== this.nativeListenerGeneration) return;
        try {
          this.publishAndroid(state);
        } catch {
          this.fail("T4 Code received an invalid Android updater state.");
        }
      });
      if (!this.started || generation !== this.nativeListenerGeneration) {
        await handle.remove().catch(() => undefined);
        return;
      }
      this.stopNativeState = () => {
        void handle.remove().catch(() => undefined);
      };

      const state = await plugin.getState();
      if (!this.started || generation !== this.nativeListenerGeneration) return;
      this.publishAndroid(state);
      if (state.phase === "idle") {
        const checked = await this.checkAndroid();
        if (!this.started || generation !== this.nativeListenerGeneration) return;
        this.publishAndroid(checked);
      }
    } catch {
      if (this.started && generation === this.nativeListenerGeneration) {
        this.fail("T4 Code could not read the Android updater state.");
      }
    }
  }

  private stop(): void {
    this.nativeListenerGeneration += 1;
    this.stopNativeState?.();
    this.stopNativeState = null;
    this.started = false;
  }

  private checkAndroid(): Promise<NativeUpdateState> {
    if (this.androidCheck !== null) return this.androidCheck;
    const plugin = nativeUpdatePlugin();
    if (plugin === null) return Promise.reject(new Error("missing Android updater"));
    const request = plugin.checkForUpdate();
    this.androidCheck = request;
    void request.finally(() => {
      if (this.androidCheck === request) this.androidCheck = null;
    }).catch(() => undefined);
    return request;
  }

  private downloadAndroid(): Promise<NativeUpdateState> {
    if (this.androidDownload !== null) return this.androidDownload;
    const plugin = nativeUpdatePlugin();
    if (plugin === null) return Promise.reject(new Error("missing Android updater"));
    const request = plugin.openUpdate();
    this.androidDownload = request;
    void request.finally(() => {
      if (this.androidDownload === request) this.androidDownload = null;
    }).catch(() => undefined);
    return request;
  }

  async check(): Promise<void> {
    if (this.snapshot.delivery === "web") {
      if (typeof window !== "undefined") window.location.reload();
      return;
    }
    try {
      if (this.snapshot.delivery === "android") {
        this.publishAndroid(await this.checkAndroid());
        return;
      }
      const checking = { ...this.snapshot, phase: "checking" as const };
      delete checking.message;
      this.publish(checking);
      const shell = rendererPlatform.shell as UpdateShell | null;
      if (shell?.checkForUpdate === undefined) throw new Error("missing desktop updater");
      this.publish(fromDesktop(await shell.checkForUpdate()));
    } catch {
      this.fail("T4 Code could not check for updates. Try again when you are online.");
    }
  }

  async download(): Promise<void> {
    try {
      if (this.snapshot.delivery === "android") {
        this.publishAndroid(await this.downloadAndroid());
        return;
      }
      const shell = rendererPlatform.shell as UpdateShell | null;
      if (shell?.downloadUpdate === undefined) throw new Error("missing desktop updater");
      this.publish(fromDesktop(await shell.downloadUpdate()));
    } catch {
      this.fail(
        this.snapshot.delivery === "android"
          ? "T4 Code could not verify and open the Android update. Your current installation is unchanged."
          : "T4 Code could not open the update. Your current installation is unchanged.",
      );
    }
  }

  async restart(): Promise<void> {
    try {
      const shell = rendererPlatform.shell as UpdateShell | null;
      if (shell?.restartToUpdate === undefined) throw new Error("missing desktop updater");
      this.publish(fromDesktop(await shell.restartToUpdate()));
    } catch {
      this.fail("T4 Code could not restart into the update. Your current installation is unchanged.");
    }
  }
}

export const appUpdateController = new AppUpdateController();

export function useAppUpdateState(): AppUpdateState {
  return useSyncExternalStore(
    appUpdateController.subscribe,
    appUpdateController.getSnapshot,
    appUpdateController.getSnapshot,
  );
}
