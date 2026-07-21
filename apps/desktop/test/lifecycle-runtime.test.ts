import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appserverLogsDirectory,
  DesktopLifecycle,
  type DesktopLifecycleOptions,
} from "../src/lifecycle.ts";
import { DesktopIpcRegistry, type IpcMainLike } from "../src/ipc.ts";
import { discoverOmpExecutable } from "../src/service.ts";
import type { TargetManagerOptions } from "../src/target-manager.ts";
import type { ServiceManager } from "@t4-code/service-manager";
import type { ProcessRunner } from "@t4-code/remote";
import type { ApplicationMenuOptions } from "../src/menu.ts";
import {
  DEFAULT_LOCAL_PROFILE,
  LocalProfileRegistry,
  type LocalProfileRegistryState,
} from "../src/local-profiles.ts";

describe("appserver log authority", () => {
  it("stays independent from Electron user-data overrides", () => {
    expect(appserverLogsDirectory("/home/alice", "linux", {})).toBe(
      "/home/alice/.local/state/t4-code/appserver",
    );
    expect(
      appserverLogsDirectory("/home/alice", "linux", { XDG_STATE_HOME: "/srv/alice-state" }),
    ).toBe("/srv/alice-state/t4-code/appserver");
    expect(appserverLogsDirectory("/Users/alice", "darwin", {})).toBe(
      "/Users/alice/Library/Logs/T4 Code/appserver",
    );
    expect(appserverLogsDirectory("/home/alice", "linux", {}, "fable-swarm")).toBe(
      "/home/alice/.local/state/t4-code/appserver/profiles/fable-swarm",
    );
    expect(appserverLogsDirectory("/Users/alice", "darwin", {}, "fable-swarm")).toBe(
      "/Users/alice/Library/Logs/T4 Code/appserver/profiles/fable-swarm",
    );
  });
});

class FakeApp {
  readonly listeners = new Map<string, (...args: unknown[]) => void>();
  requestSingleInstanceLock(): boolean {
    return true;
  }
  quit(): void {}
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  removeListener(event: string): this {
    this.listeners.delete(event);
    return this;
  }
  whenReady(): Promise<void> {
    return Promise.resolve();
  }
  setAsDefaultProtocolClient(): boolean {
    return true;
  }
  getPath(): string {
    return "/tmp/t4-test";
  }
}
class FakeWindow {
  readonly frame = { url: "file:///trusted/index.html" };
  readonly sent: unknown[][] = [];
  readonly listeners = new Map<string, (...args: never[]) => void>();
  readonly onceListeners = new Map<string, (...args: never[]) => void>();
  destroyed = false;
  readonly webContents = {
    mainFrame: this.frame,
    isDestroyed: () => this.destroyed,
    send: (...args: unknown[]) => this.sent.push(args),
    on: (event: string, listener: (...args: never[]) => void) => {
      this.listeners.set(event, listener);
    },
    once: (event: string, listener: (...args: never[]) => void) => {
      this.onceListeners.set(event, listener);
    },
  };
  showCount = 0;
  focusCount = 0;
  show(): void {
    this.showCount += 1;
  }
  focus(): void {
    this.focusCount += 1;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(event: string, listener: (...args: never[]) => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  emit(event: string, ...args: never[]): void {
    this.listeners.get(event)?.(...args);
    const once = this.onceListeners.get(event);
    if (once !== undefined) {
      this.onceListeners.delete(event);
      once(...args);
    }
  }
  finishLoad(): void {
    this.emit("did-finish-load");
  }
  close(): void {
    this.destroyed = true;
    this.emit("closed");
  }
}

class FakeBrowserRuntime {
  disposeCount = 0;
  readonly calls: unknown[] = [];

  async call(call: unknown): Promise<{ surfaces: readonly [] }> {
    this.calls.push(call);
    return { surfaces: [] };
  }
  async dispose(): Promise<void> {
    this.disposeCount += 1;
  }
}
class FakeIpc implements IpcMainLike {
  readonly handlers = new Map<string, unknown>();
  readonly removals = new Map<string, number>();
  handle(channel: string, listener: unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.removals.set(channel, (this.removals.get(channel) ?? 0) + 1);
    this.handlers.delete(channel);
  }
}
function setup(
  serviceManager?: ServiceManager,
  probeAppserver: (executable: string) => Promise<boolean> = async () => true,
  overrides: {
    readonly discoverExecutable?: () => Promise<string | undefined>;
    readonly discoverHostExecutable?: () => Promise<string | undefined>;
    readonly createServiceManager?: NonNullable<DesktopLifecycleOptions["createServiceManager"]>;
    readonly createProjectionCache?: NonNullable<DesktopLifecycleOptions["createProjectionCache"]>;
    readonly createBrowserRuntime?: NonNullable<DesktopLifecycleOptions["createBrowserRuntime"]>;
    readonly clusterOperatorEnabled?: boolean;
  } = {},
) {
  const app = new FakeApp();
  const windows: FakeWindow[] = [];
  const ipc = new FakeIpc();
  const registries: DesktopIpcRegistry[] = [];
  const runtimes: unknown[] = [];
  const browserRuntimes: FakeBrowserRuntime[] = [];
  const createBrowserRuntime =
    overrides.createBrowserRuntime ??
    (() => {
      const runtime = new FakeBrowserRuntime();
      browserRuntimes.push(runtime);
      return runtime as never;
    });
  let managerOptions: TargetManagerOptions | undefined;
  let closeCount = 0;
  let updateScheduleCount = 0;
  let updateDisposeCount = 0;
  let menuOptions: ApplicationMenuOptions | undefined;
  let windowOptions: { readonly clusterOperatorEnabled?: boolean } | undefined;
  let localProfileState: LocalProfileRegistryState = {
    version: 1,
    records: [DEFAULT_LOCAL_PROFILE],
    ignoredProfileIds: [],
  };
  const localProfileRegistry = new LocalProfileRegistry(
    {
      read: () => localProfileState,
      write: async (value) => {
        localProfileState = value;
      },
    },
    async () => [DEFAULT_LOCAL_PROFILE],
  );
  const updateState = { version: 1 as const, currentVersion: "0.1.17", phase: "idle" as const };
  const updateController = {
    getState: () => updateState,
    checkForUpdate: async () => updateState,
    downloadUpdate: async () => updateState,
    restartToUpdate: () => updateState,
    subscribe: () => () => {},
    schedulePassiveCheck: () => {
      updateScheduleCount += 1;
    },
    dispose: () => {
      updateDisposeCount += 1;
    },
  };
  const manager = {
    isConnected: () => false,
    close: async () => {
      closeCount += 1;
    },
    connect: async () => "connecting",
    disconnect: async () => {},
    command: async () => ({ targetId: "local", requestId: "1", commandId: "1", accepted: true }),
    pairStart: async () => ({ targetId: "remote", paired: false }),
    listTargets: async () => [],
    addRemoteTarget: async (target: never) => target,
    removeTarget: async () => {},
  };
  const lifecycle = new DesktopLifecycle({
    app: app as never,
    getAllWindows: () => windows.filter((window) => !window.destroyed) as never,
    createWindow: (options?: { readonly clusterOperatorEnabled?: boolean }) => {
      windowOptions = options;
      const next = new FakeWindow();
      windows.push(next);
      return {
        window: next as never,
        trustedRenderer: { origin: "file://", url: "file:///trusted/index.html" },
      };
    },
    createBrowserRuntime,
    createIpcRegistry: (runtime) => {
      runtimes.push(runtime);
      const registry = new DesktopIpcRegistry(runtime, ipc);
      registries.push(registry);
      return registry;
    },
    loadIdentity: () => ({ deviceId: "device-test", deviceName: "Desktop Test" }),
    createCursorStore: () => ({ load: () => [], save: () => {} }),
    createCredentials: () => undefined,
    createLocalProfileRegistry: () => localProfileRegistry,
    ...(overrides.createProjectionCache === undefined
      ? {}
      : { createProjectionCache: overrides.createProjectionCache }),
    ...(overrides.clusterOperatorEnabled === undefined
      ? {}
      : { clusterOperatorEnabled: overrides.clusterOperatorEnabled }),
    discoverExecutable:
      overrides.discoverExecutable ??
      (serviceManager === undefined ? async () => undefined : async () => "/opt/omp/bin/omp"),
    discoverHostExecutable:
      overrides.discoverHostExecutable ??
      (serviceManager === undefined && overrides.createServiceManager === undefined
        ? async () => undefined
        : async () => "/opt/t4/bin/t4-host"),
    ...(overrides.createServiceManager === undefined && serviceManager === undefined
      ? {}
      : {
          createServiceManager: overrides.createServiceManager ?? (() => serviceManager!),
          probeAppserver,
        }),
    createTargetManager: (options) => {
      managerOptions = options;
      return manager as never;
    },
    createUpdateController: () => updateController as never,
    installMenu: (options) => {
      menuOptions = options;
    },
  });
  return {
    app,
    windows,
    ipc,
    registries,
    runtimes,
    browserRuntimes,
    lifecycle,
    manager,
    localProfileRegistry,
    get managerOptions() {
      return managerOptions;
    },
    get closeCount() {
      return closeCount;
    },
    get updateScheduleCount() {
      return updateScheduleCount;
    },
    get updateDisposeCount() {
      return updateDisposeCount;
    },
    get menuOptions() {
      return menuOptions;
    },
    get windowOptions() {
      return windowOptions;
    },
  };
}

describe("desktop Electron lifecycle", () => {
  it("propagates explicit cluster operator opt-in to main and renderer runtimes", async () => {
    const disabled = setup();
    await disabled.lifecycle.start();
    expect(disabled.managerOptions?.clusterOperatorEnabled).toBeUndefined();
    expect(disabled.windowOptions?.clusterOperatorEnabled).not.toBe(true);
    await disabled.lifecycle.stop();

    const enabled = setup(undefined, async () => true, { clusterOperatorEnabled: true });
    await enabled.lifecycle.start();
    expect(enabled.managerOptions?.clusterOperatorEnabled).toBe(true);
    expect(enabled.windowOptions?.clusterOperatorEnabled).toBe(true);
    await enabled.lifecycle.stop();
  });
  it("queues initial argv, second-instance, and open-url links until renderer load", async () => {
    const original = [...process.argv];
    process.argv.push("t4-code://pair/argv-host/123456");
    const fixture = setup();
    await fixture.lifecycle.start();
    process.argv.splice(0, process.argv.length, ...original);
    fixture.app.listeners.get("second-instance")?.({}, ["t4-code://pair/second-host/234567"]);
    let prevented = false;
    fixture.app.listeners.get("open-url")?.(
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      "t4-code://pair/url-host/345678",
    );
    expect(prevented).toBe(true);
    const window = fixture.windows[0]!;
    expect(window.sent).toEqual([]);
    window.finishLoad();
    expect(window.sent.map((entry) => entry[0])).toEqual([
      "omp:pair-link",
      "omp:pair-link",
      "omp:pair-link",
    ]);
    expect(
      window.sent.map((entry) => {
        const payload = entry[1] as { hostHint: string };
        return payload.hostHint;
      }),
    ).toEqual(["argv-host", "second-host", "url-host"]);
    expect(window.showCount).toBe(1);
    expect(window.focusCount).toBe(1);
    await fixture.lifecycle.stop();
  });
  it("recreates the browser runtime with each trusted window and disposes it on close and stop", async () => {
    const fixture = setup();
    await fixture.lifecycle.start();
    const first = fixture.windows[0]!;
    first.close();
    expect(fixture.browserRuntimes[0]?.disposeCount).toBe(1);
    fixture.app.listeners.get("activate")?.();
    expect(fixture.windows).toHaveLength(2);
    expect(fixture.registries).toHaveLength(2);
    expect(fixture.browserRuntimes).toHaveLength(2);
    expect(fixture.runtimes[0]).toMatchObject({ manager: fixture.manager });
    expect(fixture.runtimes[1]).toMatchObject({ manager: fixture.manager });
    expect(fixture.managerOptions).toBeDefined();
    await fixture.lifecycle.stop();
    expect(fixture.browserRuntimes[1]?.disposeCount).toBe(1);
  });
  it("keeps browser and speech handlers stable while a renderer reload swaps browser targets", async () => {
    const fixture = setup();
    await fixture.lifecycle.start();
    const window = fixture.windows[0]!;
    const oldRuntime = fixture.browserRuntimes[0]!;
    const browserCall = fixture.ipc.handlers.get("browser:call") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const stopSpeaking = fixture.ipc.handlers.get("omp:speech:stop") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;

    window.emit("did-start-loading");

    const replacement = fixture.browserRuntimes[1]!;
    expect(fixture.ipc.handlers.get("browser:call")).toBe(browserCall);
    expect(fixture.ipc.handlers.get("omp:speech:stop")).toBe(stopSpeaking);
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const result = await browserCall(event, {
      channel: "browser:call",
      payload: { version: 1, method: "surface.list", request: {} },
    });
    expect(result).toEqual({ surfaces: [] });
    expect(
      await stopSpeaking(event, {
        channel: "omp:speech:stop",
        payload: {},
      }),
    ).toEqual({ accepted: true });

    expect(oldRuntime.disposeCount).toBe(1);
    expect(oldRuntime.calls).toEqual([]);
    expect(replacement.calls).toHaveLength(1);
    await fixture.lifecycle.stop();
    expect(replacement.disposeCount).toBe(1);
  });
  it("contains child WebContents event failures", async () => {
    let emit:
      | Parameters<NonNullable<DesktopLifecycleOptions["createBrowserRuntime"]>>[0]["emit"]
      | undefined;
    let browserCreates = 0;
    const fixture = setup(undefined, async () => true, {
      createBrowserRuntime: (options) => {
        browserCreates += 1;
        emit = options.emit;
        return new FakeBrowserRuntime() as never;
      },
    });
    await fixture.lifecycle.start();
    fixture.registries[0]!.emitBrowserEvent = () => {
      throw new Error("child browser event failed");
    };

    expect(emit).toBeDefined();
    expect(() => emit?.({} as never)).not.toThrow();
    const window = fixture.windows[0]!;
    window.emit("did-start-loading");
    expect(browserCreates).toBe(2);
    await fixture.lifecycle.stop();
  });
  it("keeps the replacement browser IPC target after an earlier runtime finishes disposing", async () => {
    const disposals: Array<() => void> = [];
    const browserRuntimes: FakeBrowserRuntime[] = [];
    const fixture = setup(undefined, async () => true, {
      createBrowserRuntime: () => {
        const runtime = new FakeBrowserRuntime();
        runtime.dispose = () => {
          runtime.disposeCount += 1;
          return new Promise<void>((resolve) => {
            disposals.push(resolve);
          });
        };
        browserRuntimes.push(runtime);
        return runtime as never;
      },
    });
    await fixture.lifecycle.start();
    const window = fixture.windows[0]!;
    window.emit("did-start-loading");
    const replacement = browserRuntimes[1]!;
    const browserCall = fixture.ipc.handlers.get("browser:call") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const payload = {
      channel: "browser:call",
      payload: { version: 1, method: "surface.list", request: {} },
    };

    disposals.shift()?.();
    await Promise.resolve();
    const result = await browserCall(event, payload);
    expect(result).toEqual({ surfaces: [] });
    expect(replacement.calls).toHaveLength(1);

    const stopping = fixture.lifecycle.stop();
    disposals.shift()?.();
    await stopping;
    expect(replacement.disposeCount).toBe(1);
  });
  it("keeps close cleanup callable until a deferred browser disposal settles and protects a reopened target", async () => {
    const disposals: Array<() => void> = [];
    const browserRuntimes: FakeBrowserRuntime[] = [];
    const fixture = setup(undefined, async () => true, {
      createBrowserRuntime: () => {
        const runtime = new FakeBrowserRuntime();
        runtime.dispose = () => {
          runtime.disposeCount += 1;
          return new Promise<void>((resolve) => {
            disposals.push(resolve);
          });
        };
        browserRuntimes.push(runtime);
        return runtime as never;
      },
    });
    await fixture.lifecycle.start();
    const first = fixture.windows[0]!;
    const browserCall = fixture.ipc.handlers.get("browser:call") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const stopSpeaking = fixture.ipc.handlers.get("omp:speech:stop") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const callPayload = {
      channel: "browser:call",
      payload: { version: 1, method: "surface.list", request: {} },
    };
    const firstEvent = { sender: first.webContents, senderFrame: first.webContents.mainFrame };

    first.close();

    expect(fixture.ipc.handlers.get("browser:call")).toBe(browserCall);
    expect(fixture.ipc.handlers.get("omp:speech:stop")).toBe(stopSpeaking);
    let unavailableError: unknown;
    try {
      await browserCall(firstEvent, callPayload);
    } catch (error) {
      unavailableError = error;
    }
    if (
      typeof unavailableError !== "object" ||
      unavailableError === null ||
      !("code" in unavailableError) ||
      !("message" in unavailableError)
    )
      throw unavailableError;
    expect(unavailableError.code).toBe("invalid_state");
    expect(unavailableError.message).toBe("Browser runtime is unavailable");
    expect(
      await stopSpeaking(firstEvent, {
        channel: "omp:speech:stop",
        payload: {},
      }),
    ).toEqual({ accepted: true });

    fixture.app.listeners.get("activate")?.();
    const second = fixture.windows[1]!;
    const reopenedCall = fixture.ipc.handlers.get("browser:call") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const secondEvent = { sender: second.webContents, senderFrame: second.webContents.mainFrame };
    expect(reopenedCall).not.toBe(browserCall);
    expect(await reopenedCall(secondEvent, callPayload)).toEqual({ surfaces: [] });
    expect(browserRuntimes[1]?.calls).toHaveLength(1);

    disposals.shift()?.();
    await Promise.resolve();
    expect(await reopenedCall(secondEvent, callPayload)).toEqual({ surfaces: [] });
    expect(browserRuntimes[1]?.calls).toHaveLength(2);

    const stopping = fixture.lifecycle.stop();
    disposals.shift()?.();
    await stopping;
  });
  it("keeps browser and speech handlers installed during stop, then removes them exactly once", async () => {
    const fixture = setup();
    await fixture.lifecycle.start();
    const window = fixture.windows[0]!;
    const browserCall = fixture.ipc.handlers.get("browser:call") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const stopSpeaking = fixture.ipc.handlers.get("omp:speech:stop") as (
      event: unknown,
      payload: unknown,
    ) => Promise<unknown>;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const stopping = fixture.lifecycle.stop();

    expect(fixture.ipc.handlers.get("browser:call")).toBe(browserCall);
    expect(fixture.ipc.handlers.get("omp:speech:stop")).toBe(stopSpeaking);
    let unavailableError: unknown;
    try {
      await browserCall(event, {
        channel: "browser:call",
        payload: { version: 1, method: "surface.list", request: {} },
      });
    } catch (error) {
      unavailableError = error;
    }
    if (
      typeof unavailableError !== "object" ||
      unavailableError === null ||
      !("code" in unavailableError)
    ) {
      throw unavailableError;
    }
    expect(unavailableError.code).toBe("invalid_state");
    expect(
      await stopSpeaking(event, {
        channel: "omp:speech:stop",
        payload: {},
      }),
    ).toEqual({ accepted: true });

    await stopping;
    expect(fixture.ipc.handlers.get("browser:call")).toBeUndefined();
    expect(fixture.ipc.handlers.get("omp:speech:stop")).toBeUndefined();
    const browserRemovals = fixture.ipc.removals.get("browser:call");
    const speechRemovals = fixture.ipc.removals.get("omp:speech:stop");
    await fixture.lifecycle.stop();
    expect(fixture.ipc.removals.get("browser:call")).toBe(browserRemovals);
    expect(fixture.ipc.removals.get("omp:speech:stop")).toBe(speechRemovals);
  });
  it("does not recreate a browser runtime when a load completes during shutdown", async () => {
    let browserCreates = 0;
    let disposeStarts = 0;
    let resolveDispose: (() => void) | undefined;
    const fixture = setup(undefined, async () => true, {
      createBrowserRuntime: () => {
        browserCreates += 1;
        return {
          dispose: () => {
            disposeStarts += 1;
            return new Promise<void>((resolve) => {
              resolveDispose = resolve;
            });
          },
        } as never;
      },
    });
    await fixture.lifecycle.start();
    const stopping = fixture.lifecycle.stop();
    expect(disposeStarts).toBe(1);
    fixture.windows[0]!.finishLoad();
    expect(browserCreates).toBe(1);
    resolveDispose?.();
    await stopping;
  });
  it("creates one projection cache after readiness and injects it into every IPC binding", async () => {
    const cache = {
      load: () => ({ available: false, value: null }),
      save: (_value: string) => ({ saved: false }),
    };
    let cacheCreates = 0;
    const fixture = setup(undefined, async () => true, {
      createProjectionCache: () => {
        cacheCreates += 1;
        return cache;
      },
    });
    expect(cacheCreates).toBe(0);
    await fixture.lifecycle.start();
    expect(cacheCreates).toBe(1);
    expect(fixture.runtimes[0]).toMatchObject({ projectionCache: cache });
    fixture.windows[0]!.close();
    fixture.app.listeners.get("activate")?.();
    expect(fixture.runtimes).toHaveLength(2);
    expect(fixture.runtimes[1]).toMatchObject({ projectionCache: cache });
    expect(cacheCreates).toBe(1);
    await fixture.lifecycle.stop();
  });
  it("routes the native update menu to the trusted renderer and schedules one passive check", async () => {
    const fixture = setup();
    await fixture.lifecycle.start();
    fixture.menuOptions?.onOpenUpdates();
    const window = fixture.windows[0]!;
    expect(window.sent).toEqual([]);
    window.finishLoad();
    expect(window.sent).toEqual([]);
    const rendererReady = fixture.ipc.handlers.get("app:update:renderer-ready") as (
      event: unknown,
      payload: unknown,
    ) => unknown;
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    expect(rendererReady(event, { channel: "app:update:renderer-ready", payload: {} })).toEqual({
      openSettings: true,
    });
    expect(rendererReady(event, { channel: "app:update:renderer-ready", payload: {} })).toEqual({
      openSettings: false,
    });
    fixture.menuOptions?.onOpenUpdates();
    expect(window.sent).toEqual([["app:update:open", { source: "menu" }]]);

    window.emit("did-start-loading");
    fixture.menuOptions?.onOpenUpdates();
    expect(window.sent).toHaveLength(1);
    expect(rendererReady(event, { channel: "app:update:renderer-ready", payload: {} })).toEqual({
      openSettings: true,
    });
    expect(window.showCount).toBe(3);
    expect(window.focusCount).toBe(3);
    expect(fixture.updateScheduleCount).toBe(1);
    await fixture.lifecycle.stop();
    expect(fixture.updateDisposeCount).toBe(1);
  });
  it("closes the target manager exactly once across before-quit and stop", async () => {
    const fixture = setup();
    await fixture.lifecycle.start();
    fixture.app.listeners.get("before-quit")?.();
    await Promise.resolve();
    await fixture.lifecycle.stop();
    await fixture.lifecycle.stop();
    expect(fixture.closeCount).toBe(1);
  });
  it("installs and starts the owned service before exposing local connect", async () => {
    const calls: string[] = [];
    let inspections = 0;
    const service: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        inspections += 1;
        return inspections === 1
          ? { definition: "missing", service: "stopped", diagnostics: "" }
          : {
              definition: "current",
              service: inspections >= 3 ? "running" : "stopped",
              diagnostics: "",
            };
      },
      install: async () => {
        calls.push("install");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };
    let probes = 0;
    const fixture = setup(service, async () => {
      probes += 1;
      return probes >= 2;
    });
    await fixture.lifecycle.start();
    expect(calls).toEqual(["inspect", "install", "inspect", "start", "inspect", "inspect"]);
    expect(probes).toBe(2);
    expect(fixture.windows).toHaveLength(1);
    await fixture.lifecycle.stop();
  });
  it("replaces a healthy legacy appserver with the T4-owned service", async () => {
    const calls: string[] = [];
    let inspections = 0;
    const service: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        inspections += 1;
        return inspections === 1
          ? { definition: "missing", service: "running", diagnostics: "legacy owner" }
          : { definition: "current", service: "running", diagnostics: "T4 owner" };
      },
      install: async () => {
        calls.push("install");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {
        calls.push("stop");
      },
      restart: async () => {
        calls.push("restart");
      },
      uninstall: async () => {
        calls.push("uninstall");
      },
    };
    let probes = 0;
    const fixture = setup(service, async (executable) => {
      probes += 1;
      expect(executable).toBe("/opt/omp/bin/omp");
      return true;
    });

    await fixture.lifecycle.start();

    expect(probes).toBe(1);
    expect(calls).toEqual(["inspect", "install", "inspect", "inspect"]);
    expect(
      (
        fixture.runtimes[0] as { getServiceManager: () => ServiceManager | undefined }
      ).getServiceManager(),
    ).toBe(service);
    expect(fixture.windows).toHaveLength(1);
    await fixture.lifecycle.stop();
  });
  it("automatically repairs the default service when its connected target falls back to connecting", async () => {
    const calls: string[] = [];
    let state: "running" | "stopped" = "running";
    const repaired = Promise.withResolvers<void>();
    const service: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        if (state === "running" && calls.includes("start")) repaired.resolve();
        return { definition: "current", service: state, diagnostics: "" };
      },
      install: async () => { calls.push("install"); },
      start: async () => {
        calls.push("start");
        state = "running";
      },
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };
    const fixture = setup(service, async () => true);
    await fixture.lifecycle.start();
    expect(calls).toEqual(["inspect", "inspect"]);
    calls.length = 0;

    state = "stopped";
    fixture.managerOptions?.events.onState({ targetId: "local", state: "connecting" });
    await repaired.promise;

    expect(calls).toEqual(["inspect", "start", "inspect"]);
    await fixture.lifecycle.stop();
  });
  it("shares in-flight profile discovery but revalidates the executable on later recovery", async () => {
    const service: ServiceManager = {
      inspect: async () => ({ definition: "current", service: "running", diagnostics: "" }),
      install: async () => {},
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };
    const executableDiscoveries = ["/opt/old/omp", "/opt/current/omp", "/opt/newer/omp"];
    let discoveries = 0;
    const managerExecutables: string[] = [];
    const fixture = setup(service, async () => true, {
      discoverExecutable: async () => {
        const executable = executableDiscoveries[discoveries];
        discoveries += 1;
        return executable;
      },
      createServiceManager: (options) => {
        managerExecutables.push(`${options.profileId ?? "default"}:${options.argv[2]}`);
        return service;
      },
    });
    await fixture.localProfileRegistry.add({ profileId: "profile-one", label: "Profile One" });
    await fixture.localProfileRegistry.add({ profileId: "profile-two", label: "Profile Two" });
    await fixture.lifecycle.start();
    const runtime = fixture.runtimes[0] as {
      profileRuntime: {
        list(): Promise<unknown>;
        status(profileId: string): Promise<unknown>;
      };
    };
    await runtime.profileRuntime.list();
    expect(discoveries).toBe(2);
    expect(managerExecutables).toEqual([
      "default:/opt/old/omp",
      "profile-one:/opt/current/omp",
      "profile-two:/opt/current/omp",
    ]);

    await fixture.localProfileRegistry.add({ profileId: "profile-three", label: "Profile Three" });
    await runtime.profileRuntime.status("profile-three");
    expect(discoveries).toBe(3);
    expect(managerExecutables.at(-1)).toBe("profile-three:/opt/newer/omp");
    await fixture.lifecycle.stop();
  });
  it("cancels and awaits in-flight service recovery during teardown", async () => {
    const calls: string[] = [];
    let inspections = 0;
    const service: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        inspections += 1;
        return inspections === 1
          ? { definition: "missing", service: "stopped", diagnostics: "" }
          : { definition: "current", service: "running", diagnostics: "" };
      },
      install: async () => {
        calls.push("install");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {
        calls.push("stop");
      },
      restart: async () => {
        calls.push("restart");
      },
      uninstall: async () => {
        calls.push("uninstall");
      },
    };
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const fixture = setup(service, async () => {
      entered.resolve();
      return release.promise;
    });

    const starting = fixture.lifecycle.start();
    await entered.promise;
    const stopping = fixture.lifecycle.stop();
    release.resolve(false);
    await Promise.all([starting, stopping]);

    expect(calls).toEqual(["inspect", "install", "inspect", "inspect"]);
    expect(fixture.windows).toHaveLength(1);
    expect(fixture.closeCount).toBe(1);
  });
  it("does not publish a manager or startup error when recovery rejects during teardown", async () => {
    const calls: string[] = [];
    const entered = Promise.withResolvers<void>();
    const inspection = Promise.withResolvers<{
      definition: "missing";
      service: "stopped";
      diagnostics: string;
    }>();
    const service: ServiceManager = {
      inspect: async () => {
        calls.push("inspect");
        entered.resolve();
        return inspection.promise;
      },
      install: async () => {
        calls.push("install");
      },
      start: async () => {
        calls.push("start");
      },
      stop: async () => {
        calls.push("stop");
      },
      restart: async () => {
        calls.push("restart");
      },
      uninstall: async () => {
        calls.push("uninstall");
      },
    };
    const fixture = setup(service, async () => false);

    const starting = fixture.lifecycle.start();
    await entered.promise;
    const stopping = fixture.lifecycle.stop();
    inspection.reject(new Error("late inspect failure"));
    await Promise.all([starting, stopping]);

    const internal = fixture.lifecycle as unknown as {
      serviceManager?: ServiceManager;
      startupServiceError?: unknown;
      serviceAvailabilityIssue?: unknown;
    };
    expect(calls).toEqual(["inspect"]);
    expect(internal.serviceManager).toBeUndefined();
    expect(internal.startupServiceError).toBeUndefined();
    expect(internal.serviceAvailabilityIssue).toBeUndefined();
    expect(fixture.windows).toHaveLength(1);
  });
  it("does not publish a ready manager when teardown wins the final recovery continuation", async () => {
    const service: ServiceManager = {
      inspect: async () => ({ definition: "current", service: "running", diagnostics: "" }),
      install: async () => {},
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      uninstall: async () => {},
    };
    let probeCalls = 0;
    let stopPromise: Promise<void> | undefined;
    let fixture!: ReturnType<typeof setup>;
    // This must stay non-async: the raw Promise ordering places stop() after
    // ensureServiceReady() resolves but before recoverServiceManager() resumes.
    const probe = (): Promise<boolean> => {
      probeCalls += 1;
      if (probeCalls === 1) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        queueMicrotask(() => {
          resolve(true);
          queueMicrotask(() => {
            stopPromise = fixture.lifecycle.stop();
          });
        });
      });
    };
    fixture = setup(service, probe);

    await fixture.lifecycle.start();
    await stopPromise!;

    const internal = fixture.lifecycle as unknown as {
      stopping: boolean;
      serviceManager?: ServiceManager;
      startupServiceError?: unknown;
      serviceAvailabilityIssue?: unknown;
    };
    expect(probeCalls).toBe(2);
    expect(internal.stopping).toBe(true);
    expect(internal.serviceManager).toBeUndefined();
    expect(internal.startupServiceError).toBeUndefined();
    expect(internal.serviceAvailabilityIssue).toBeUndefined();
    expect(fixture.windows).toHaveLength(1);
  });
  it("recovers an updated OMP once across concurrent IPC retries and keeps the reason across reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "t4-recovery-"));
    const executable = join(root, "omp");
    await writeFile(executable, "");
    await chmod(executable, 0o755);
    let compatible = false;
    let discoveryCalls = 0;
    const probeArgs: string[][] = [];
    const runner: ProcessRunner = {
      spawn: async (spec) => {
        probeArgs.push([...(spec.args ?? [])]);
        return {
          kill: () => {},
          result: Promise.resolve(
            compatible && spec.args?.[0] === "bridge"
              ? {
                  exitCode: 0,
                  signal: null,
                  stdout:
                    "Expose the private OMP authority bridge used by T4 Code\n\nFLAGS\n  --stdio  Use the versioned JSON-lines standard I/O transport\n",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              : compatible
              ? {
                  exitCode: 0,
                  signal: null,
                  stdout: JSON.stringify({ state: "stopped", reason: "unreachable" }),
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }
              : {
                  exitCode: 2,
                  signal: null,
                  stdout: "",
                  stderr: "Error: unknown flag: --json\n",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                },
          ),
        };
      },
    };
    const serviceCalls: string[] = [];
    const recovered: ServiceManager = {
      inspect: async () => {
        serviceCalls.push("inspect");
        return { definition: "current", service: "running", diagnostics: "ready" };
      },
      install: async () => {
        serviceCalls.push("install");
      },
      start: async () => {
        serviceCalls.push("start");
      },
      stop: async () => {
        serviceCalls.push("stop");
      },
      restart: async () => {
        serviceCalls.push("restart");
      },
      uninstall: async () => {
        serviceCalls.push("uninstall");
      },
    };
    let factories = 0;
    const fixture = setup(undefined, async () => true, {
      discoverExecutable: () => {
        discoveryCalls += 1;
        return discoverOmpExecutable({
          environment: { OMP_EXECUTABLE: executable, PATH: "" },
          homeDirectory: root,
          runner,
        });
      },
      createServiceManager: () => {
        factories += 1;
        return recovered;
      },
    });

    await fixture.lifecycle.start();
    expect(discoveryCalls).toBe(1);
    expect(probeArgs.length >= 1).toBe(true);
    const probesAfterInitialDiscovery = probeArgs.length;
    fixture.windows[0]!.finishLoad();
    fixture.windows[0]!.close();
    fixture.app.listeners.get("activate")?.();

    const runtime = fixture.runtimes[1] as {
      window: FakeWindow;
      getServiceAvailabilityIssue: () => { code: string } | undefined;
    };
    expect(runtime.getServiceAvailabilityIssue()?.code).toBe("omp_incompatible");
    const event = {
      sender: runtime.window.webContents,
      senderFrame: runtime.window.webContents.mainFrame,
    };
    const bootstrap = fixture.ipc.handlers.get("omp:bootstrap") as (
      event: unknown,
      request: unknown,
    ) => Promise<{ service?: { issue?: { code: string } } }>;
    const bootstrapResult = await bootstrap(event, { channel: "omp:bootstrap", payload: {} });
    expect(bootstrapResult.service?.issue?.code).toBe("omp_incompatible");
    expect(discoveryCalls).toBe(1);
    expect(probeArgs).toHaveLength(probesAfterInitialDiscovery);

    compatible = true;
    const inspect = fixture.ipc.handlers.get("omp:service:inspect") as (
      event: unknown,
      request: unknown,
    ) => Promise<unknown>;
    const payload = { channel: "omp:service:inspect", payload: {} };
    const [first, second] = await Promise.all([inspect(event, payload), inspect(event, payload)]);
    expect(first).toEqual({ definition: "current", service: "running", diagnostics: "ready" });
    expect(second).toEqual(first);
    expect(factories).toBe(1);
    expect(discoveryCalls).toBe(2);
    expect(serviceCalls).toEqual(["inspect", "inspect", "inspect"]);
    expect(probeArgs).toHaveLength(probesAfterInitialDiscovery + 2);
    expect(probeArgs.slice(-2)).toEqual([
      ["bridge", "--help"],
      ["appserver", "status", "--json"],
    ]);

    const start = fixture.ipc.handlers.get("omp:service:start") as (
      event: unknown,
      request: unknown,
    ) => Promise<unknown>;
    await start(event, { channel: "omp:service:start", payload: {} });
    expect(serviceCalls).toEqual(["inspect", "inspect", "inspect", "start"]);
    expect(probeArgs.slice(-2)).toEqual([
      ["bridge", "--help"],
      ["appserver", "status", "--json"],
    ]);
    await fixture.lifecycle.stop();
  });
});
