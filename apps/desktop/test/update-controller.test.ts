import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  compareVersions,
  decodeReleaseManifest,
  DesktopUpdateController,
  UPDATE_MANIFEST_URL,
  type NativeUpdaterPort,
  type UpdateFetchResponse,
} from "../src/update-controller.ts";
import { detectNativeLinuxPackage } from "../src/linux-update-package.ts";

const digest = "a".repeat(64);

function asset(
  version: string,
  platform: "android" | "linux" | "mac",
  kind: "apk" | "deb" | "appimage" | "dmg" | "zip",
  arch: "universal" | "x86_64" | "arm64",
  name: string,
) {
  return {
    platform,
    kind,
    arch,
    name,
    url: `https://github.com/wolfiesch/omperator/releases/download/v${version}/${name}`,
    size: 1024,
    sha256: digest,
  };
}

function manifest(version: string) {
  return {
    schemaVersion: 1,
    channel: "stable",
    version,
    tag: `v${version}`,
    publishedAt: "2026-07-15T20:00:00.000Z",
    releaseUrl: `https://github.com/wolfiesch/omperator/releases/tag/v${version}`,
    assets: [
      asset(version, "android", "apk", "universal", `Omperator-${version}-android.apk`),
      asset(version, "linux", "deb", "x86_64", `Omperator-${version}-linux-amd64.deb`),
      asset(version, "linux", "appimage", "x86_64", `Omperator-${version}-linux-x86_64.AppImage`),
      asset(version, "mac", "dmg", "arm64", `Omperator-${version}-mac-arm64.dmg`),
      asset(version, "mac", "zip", "arm64", `Omperator-${version}-mac-arm64.zip`),
    ],
  };
}

class FakeUpdater extends EventEmitter implements NativeUpdaterPort {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  checkCalls = 0;
  downloadCalls = 0;
  restartCalls = 0;
  checkResult: {
    readonly isUpdateAvailable: boolean;
    readonly updateInfo: { readonly version: string };
  } | null = null;
  checkGate:
    | Promise<{
        readonly isUpdateAvailable: boolean;
        readonly updateInfo: { readonly version: string };
      } | null>
    | undefined;

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.checkGate === undefined ? this.checkResult : this.checkGate;
  }

  async downloadUpdate(): Promise<readonly string[]> {
    this.downloadCalls += 1;
    return ["/private/update-path-must-not-cross-ipc"];
  }

  quitAndInstall(): void {
    this.restartCalls += 1;
  }
}

function response(
  value: unknown,
  options: {
    readonly contentLength?: string | null;
    readonly chunkBytes?: number;
    readonly onCancel?: () => void;
    readonly onRead?: () => void;
  } = {},
): UpdateFetchResponse {
  const text = JSON.stringify(value);
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  let cancelled = false;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-length"
          ? options.contentLength === undefined
            ? String(bytes.byteLength)
            : options.contentLength
          : null,
    },
    body: {
      getReader: () => ({
        read: async () => {
          options.onRead?.();
          if (cancelled || offset >= bytes.byteLength) return { done: true };
          const chunkSize = options.chunkBytes ?? bytes.byteLength;
          const value = bytes.subarray(offset, offset + chunkSize);
          offset += value.byteLength;
          return { done: false, value };
        },
        cancel: async () => {
          cancelled = true;
          options.onCancel?.();
        },
      }),
    },
  };
}

function controller(
  options: {
    readonly updater?: FakeUpdater;
    readonly platform?: "linux" | "darwin";
    readonly isPackaged?: boolean;
    readonly nativeLinuxPackage?: "appimage" | "deb";
    readonly fetchManifest?: () => Promise<UpdateFetchResponse>;
    readonly opened?: string[];
    readonly timers?: Array<() => void>;
  } = {},
) {
  const updater = options.updater ?? new FakeUpdater();
  const opened = options.opened ?? [];
  const timers = options.timers ?? [];
  const instance = new DesktopUpdateController({
    currentVersion: "0.1.17",
    platform: options.platform ?? "linux",
    isPackaged: options.isPackaged ?? true,
    ...(options.nativeLinuxPackage === undefined
      ? {}
      : { nativeLinuxPackage: options.nativeLinuxPackage }),
    nativeUpdater: updater,
    fetchManifest: async (url) => {
      expect(url).toBe(UPDATE_MANIFEST_URL);
      return options.fetchManifest?.() ?? response(manifest("0.1.18"));
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    now: () => 1234,
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: () => {},
  });
  return { instance, updater, opened, timers };
}

describe("desktop update controller", () => {
  it("orders stable and prerelease versions", () => {
    expect(compareVersions("1.2.3", "1.2.2")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.2", "1.2.3-beta.10")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3-rc.1")).toBe(1);
  });

  it("strictly validates immutable release assets and rejects injected URLs", () => {
    const decoded = decodeReleaseManifest(manifest("0.1.18"));
    expect(decoded.version).toBe("0.1.18");
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.assets)).toBe(true);

    const hostile = manifest("0.1.18");
    hostile.assets[1] = {
      ...hostile.assets[1]!,
      url: "https://attacker.invalid/Omperator-0.1.18-linux-amd64.deb",
    };
    expect(() => decodeReleaseManifest(hostile)).toThrow("invalid release asset URL");
    const substituted = manifest("0.1.18");
    substituted.assets[1] = {
      ...substituted.assets[1]!,
      platform: "linux",
      kind: "appimage",
      arch: "x86_64",
      name: "Omperator-0.1.18-linux-amd64.deb",
    };
    expect(() => decodeReleaseManifest(substituted)).toThrow("invalid canonical release assets");
    expect(() => decodeReleaseManifest({ ...manifest("0.1.18"), extra: true })).toThrow(
      "unknown extra",
    );
  });

  it("keeps unpackaged Linux builds manual and opens only the exact verified deb asset", async () => {
    const { instance, updater, opened } = controller({ isPackaged: false });
    const state = await instance.checkForUpdate();
    expect(state).toMatchObject({
      phase: "manual",
      currentVersion: "0.1.17",
      availableVersion: "0.1.18",
      checkedAt: 1234,
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(updater.checkCalls).toBe(0);

    const openedState = await instance.downloadUpdate();
    expect(opened).toEqual([
      "https://github.com/wolfiesch/omperator/releases/download/v0.1.18/Omperator-0.1.18-linux-amd64.deb",
    ]);
    expect(openedState.phase).toBe("manual");
    expect(updater.downloadCalls).toBe(0);
    instance.dispose();
  });

  it("uses the signed native update feed for packaged mac builds", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "0.1.18" } };
    const { instance, opened } = controller({ platform: "darwin", updater });
    expect(await instance.checkForUpdate()).toMatchObject({
      phase: "available",
      availableVersion: "0.1.18",
    });
    await instance.downloadUpdate();
    instance.restartToUpdate();
    expect(opened).toEqual([]);
    expect(updater.checkCalls).toBe(1);
    expect(updater.downloadCalls).toBe(1);
    expect(updater.restartCalls).toBe(1);
    instance.dispose();
  });

  it("keeps unpackaged mac builds on the verified manual download path", async () => {
    const { instance, updater, opened } = controller({ platform: "darwin", isPackaged: false });
    expect((await instance.checkForUpdate()).phase).toBe("manual");
    await instance.downloadUpdate();
    expect(opened).toEqual([
      "https://github.com/wolfiesch/omperator/releases/download/v0.1.18/Omperator-0.1.18-mac-arm64.dmg",
    ]);
    expect(updater.checkCalls).toBe(0);
    instance.dispose();
  });

  it("uses electron-updater only for packaged AppImage and never auto-downloads or auto-installs", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "0.1.18" } };
    const { instance } = controller({ updater, nativeLinuxPackage: "appimage" });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);

    expect(await instance.checkForUpdate()).toMatchObject({
      phase: "available",
      availableVersion: "0.1.18",
    });
    expect(updater.checkCalls).toBe(1);
    expect(updater.downloadCalls).toBe(0);
    expect(updater.restartCalls).toBe(0);

    expect((await instance.downloadUpdate()).phase).toBe("ready");
    expect(updater.downloadCalls).toBe(1);
    expect(updater.restartCalls).toBe(0);
    instance.restartToUpdate();
    expect(updater.restartCalls).toBe(1);
    instance.dispose();
  });

  it("uses electron-updater for packaged deb while keeping every action user-driven", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "0.1.18" } };
    const { instance, opened } = controller({ updater, nativeLinuxPackage: "deb" });
    expect((await instance.checkForUpdate()).phase).toBe("available");
    expect(updater.checkCalls).toBe(1);
    expect(updater.downloadCalls).toBe(0);
    expect(opened).toEqual([]);
    await instance.downloadUpdate();
    expect(updater.downloadCalls).toBe(1);
    expect(updater.restartCalls).toBe(0);
    instance.restartToUpdate();
    expect(updater.restartCalls).toBe(1);
    instance.dispose();
  });

  it("surfaces a native installer launch failure instead of remaining ready", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "0.1.18" } };
    updater.quitAndInstall = () => {
      updater.restartCalls += 1;
      updater.emit("error", new Error("native installer could not start"));
    };
    const { instance } = controller({ updater, nativeLinuxPackage: "deb" });

    await instance.checkForUpdate();
    await instance.downloadUpdate();
    expect(instance.restartToUpdate()).toMatchObject({
      phase: "error",
      availableVersion: "0.1.18",
      message: "native installer could not start",
    });
    expect(updater.restartCalls).toBe(1);
    instance.dispose();
  });

  it("detects only packaged AppImage or exact deb package identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-update-package-"));
    await mkdir(join(root, "deb"));
    await writeFile(join(root, "deb", "package-type"), "deb\n");
    await mkdir(join(root, "rpm"));
    await writeFile(join(root, "rpm", "package-type"), "rpm\n");
    expect(
      detectNativeLinuxPackage({
        platform: "linux",
        isPackaged: true,
        appImagePath: "/opt/T4-Code.AppImage",
        resourcesPath: join(root, "appimage"),
      }),
    ).toBe("appimage");
    expect(
      detectNativeLinuxPackage({
        platform: "linux",
        isPackaged: true,
        appImagePath: "/opt/T4-Code.AppImage",
        resourcesPath: join(root, "deb"),
      }),
    ).toBe("deb");
    expect(
      detectNativeLinuxPackage({
        platform: "linux",
        isPackaged: true,
        resourcesPath: join(root, "rpm"),
      }),
    ).toBeUndefined();
    expect(
      detectNativeLinuxPackage({
        platform: "darwin",
        isPackaged: true,
        resourcesPath: join(root, "deb"),
      }),
    ).toBeUndefined();
    expect(
      detectNativeLinuxPackage({
        platform: "linux",
        isPackaged: false,
        resourcesPath: join(root, "deb"),
      }),
    ).toBeUndefined();
  });

  it("coalesces concurrent checks and downloads while forwarding bounded progress", async () => {
    const updater = new FakeUpdater();
    let resolveCheck!: (value: {
      readonly isUpdateAvailable: boolean;
      readonly updateInfo: { readonly version: string };
    }) => void;
    updater.checkGate = new Promise((resolve) => {
      resolveCheck = resolve;
    });
    const { instance } = controller({ updater, nativeLinuxPackage: "appimage" });
    const states: string[] = [];
    instance.subscribe((state) => states.push(`${state.phase}:${state.progressPercent ?? ""}`));
    const first = instance.checkForUpdate(false);
    const second = instance.checkForUpdate(true);
    expect(first).toBe(second);
    expect(updater.checkCalls).toBe(1);
    resolveCheck({ isUpdateAvailable: true, updateInfo: { version: "0.1.18" } });
    await first;

    updater.downloadUpdate = async () => {
      updater.downloadCalls += 1;
      updater.emit("download-progress", { percent: 37.5 });
      updater.emit("update-downloaded", { version: "0.1.18" });
      return [];
    };
    const download = instance.downloadUpdate();
    const sameDownload = instance.downloadUpdate();
    expect(download).toBe(sameDownload);
    expect((await download).phase).toBe("ready");
    expect(updater.downloadCalls).toBe(1);
    expect(states).toContain("downloading:37.5");
    expect(states).toContain("ready:100");
    instance.dispose();
  });

  it("does one quiet packaged passive check and never schedules one in dev", async () => {
    const packagedTimers: Array<() => void> = [];
    const { instance: packaged } = controller({
      timers: packagedTimers,
      fetchManifest: async () => {
        throw new Error("offline https://private.invalid/token=secret");
      },
    });
    packaged.schedulePassiveCheck();
    packaged.schedulePassiveCheck();
    expect(packagedTimers).toHaveLength(1);
    packagedTimers[0]!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(packaged.getState()).toEqual({
      version: 1,
      currentVersion: "0.1.17",
      phase: "idle",
    });
    const timerCountAfterCheck = packagedTimers.length;
    packaged.schedulePassiveCheck();
    expect(packagedTimers).toHaveLength(timerCountAfterCheck);
    packaged.dispose();

    const devTimers: Array<() => void> = [];
    const { instance: dev } = controller({ isPackaged: false, timers: devTimers });
    dev.schedulePassiveCheck();
    expect(devTimers).toHaveLength(0);
    dev.dispose();
  });

  it("never lets a stale passive check interrupt a native download or ready update", async () => {
    const updater = new FakeUpdater();
    updater.checkResult = { isUpdateAvailable: true, updateInfo: { version: "0.1.18" } };
    let resolveDownload!: (paths: readonly string[]) => void;
    updater.downloadUpdate = () => {
      updater.downloadCalls += 1;
      return new Promise((resolve) => {
        resolveDownload = resolve;
      });
    };
    const timers: Array<() => void> = [];
    const { instance } = controller({ updater, nativeLinuxPackage: "appimage", timers });

    instance.schedulePassiveCheck();
    expect(timers).toHaveLength(1);
    expect((await instance.checkForUpdate(true)).phase).toBe("available");
    const download = instance.downloadUpdate();
    expect(instance.getState().phase).toBe("downloading");

    // Model a timer callback that was already queued when the interactive check cancelled it.
    timers[0]!();
    await Promise.resolve();
    expect(updater.checkCalls).toBe(1);
    expect(instance.getState().phase).toBe("downloading");

    resolveDownload([]);
    expect((await download).phase).toBe("ready");
    expect((await instance.checkForUpdate(false)).phase).toBe("ready");
    expect(updater.checkCalls).toBe(1);
    instance.dispose();
  });

  it("surfaces interactive failures without leaking URLs, paths, or secrets", async () => {
    const { instance } = controller({
      fetchManifest: async () => {
        throw new Error(
          "Bearer LIVE_TOKEN failed at /home/alice/update.json https://private.invalid/token=SECRET",
        );
      },
    });
    const state = await instance.checkForUpdate();
    expect(state.phase).toBe("error");
    expect(state.message).not.toContain("LIVE_TOKEN");
    expect(state.message).not.toContain("alice");
    expect(state.message).not.toContain("private.invalid");
    expect(state.message).not.toContain("SECRET");
    instance.dispose();
  });

  it("stops oversized manifest streams with missing or underreported Content-Length", async () => {
    for (const contentLength of [null, "1"] as const) {
      let cancelled = 0;
      const oversized = { payload: "x".repeat(256 * 1024) };
      const { instance } = controller({
        fetchManifest: async () =>
          response(oversized, {
            contentLength,
            chunkBytes: 64 * 1024,
            onCancel: () => {
              cancelled += 1;
            },
          }),
      });
      const state = await instance.checkForUpdate();
      expect(state).toMatchObject({ phase: "error", message: "Update manifest is too large" });
      expect(cancelled).toBe(1);
      instance.dispose();
    }
  });

  it("rejects malformed Content-Length before reading an update body", async () => {
    let reads = 0;
    const { instance } = controller({
      fetchManifest: async () =>
        response(manifest("0.1.18"), {
          contentLength: "12junk",
          onRead: () => {
            reads += 1;
          },
        }),
    });
    const state = await instance.checkForUpdate();
    expect(state).toMatchObject({
      phase: "error",
      message: "Update manifest Content-Length is invalid",
    });
    expect(reads).toBe(0);
    instance.dispose();
  });
});
