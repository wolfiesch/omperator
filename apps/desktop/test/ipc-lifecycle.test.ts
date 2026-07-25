import { describe, expect, it } from "vitest";
import type { ServiceAvailabilityIssue } from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import { DesktopIpcRegistry, runtimeError, type IpcMainLike, type IpcRuntime } from "../src/ipc.ts";

class FakeIpc implements IpcMainLike {
  readonly handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  handle(channel: string, listener: (event: never, payload: unknown) => unknown): void { this.handlers.set(channel, listener as never); }
  removeHandler(channel: string): void { this.handlers.delete(channel); }
}
function fakeWindow() {
  const frame = { url: "file:///trusted/index.html" };
  const sent: unknown[][] = [];
  const webContents = { mainFrame: frame, isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) };
  const window = { webContents, isDestroyed: () => false };
  return { window, sent };
}
function makeRuntime(serviceManager?: ServiceManager, serviceAvailabilityIssue?: ServiceAvailabilityIssue) {
  const view = fakeWindow();
  const manager = { isConnected: () => true, connect: async () => "connected", disconnect: async () => {}, command: async () => ({ targetId: "local", requestId: "1", commandId: "1", accepted: true }), pairStart: async () => ({ targetId: "remote", paired: true }), listTargets: async () => [], addRemoteTarget: async (target: unknown) => target, removeTarget: async () => {} };
  return { view, runtime: { manager, window: view.window, trustedRenderer: { origin: "file://", url: "file:///trusted/index.html" }, ...(serviceManager === undefined ? {} : { serviceManager }), ...(serviceAvailabilityIssue === undefined ? {} : { getServiceAvailabilityIssue: () => serviceAvailabilityIssue }) } as unknown as IpcRuntime };
}
const request = (channel: string, payload: unknown = {}): unknown => ({ channel, payload });

describe("desktop IPC lifecycle proof", () => {
  it("routes t4-omp inspect, install, and remove through the trusted desktop service", async () => {
    const ipc = new FakeIpc();
    const { runtime: baseRuntime } = makeRuntime();
    const calls: string[] = [];
    const launcherState = (phase: "not-installed" | "installed") => ({
      phase,
      command: "t4-omp" as const,
      location: "~/.local/bin/t4-omp" as const,
      message: phase === "installed" ? "Ready" : "Not installed",
    });
    const runtime: IpcRuntime = {
      ...baseRuntime,
      t4OmpLauncher: {
        inspect: async () => { calls.push("inspect"); return launcherState("not-installed"); },
        install: async () => { calls.push("install"); return launcherState("installed"); },
        remove: async () => { calls.push("remove"); return launcherState("not-installed"); },
      },
    };
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    for (const action of ["inspect", "install", "remove"] as const) {
      await ipc.handlers.get(`app:t4-omp:${action}`)!(event, request(`app:t4-omp:${action}`));
    }
    expect(calls).toEqual(["inspect", "install", "remove"]);
  });
  it("exposes strict profile lifecycle handlers and bounds their service diagnostics", async () => {
    const ipc = new FakeIpc();
    const { runtime: baseRuntime } = makeRuntime();
    const calls: string[] = [];
    const profile = {
      profileId: "fable-swarm",
      label: "Fable Swarm",
      targetId: "local:fable-swarm",
      autoStart: true,
      isDefault: false,
      service: {
        definition: "current" as const,
        service: "running" as const,
        diagnostics: "token=do-not-render /home/alice/private",
      },
      privateValue: "must-not-cross-ipc",
    };
    const runtime: IpcRuntime = {
      ...baseRuntime,
      profileRuntime: {
        list: async () => [profile],
        add: async (input: { profileId: string }) => { calls.push(`add:${input.profileId}`); return profile; },
        update: async (input: { profileId: string }) => { calls.push(`update:${input.profileId}`); return profile; },
        remove: async (profileId: string) => { calls.push(`remove:${profileId}`); },
        status: async (profileId: string) => { calls.push(`status:${profileId}`); return profile; },
        action: async (profileId: string, action: string) => {
          calls.push(`${action}:${profileId}`);
          return profile;
        },
      } as never,
    };
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = {
      sender: runtime.window.webContents,
      senderFrame: runtime.window.webContents.mainFrame,
    };

    const listed = await ipc.handlers.get("omp:profiles:list")!(
      event,
      request("omp:profiles:list"),
    ) as { profiles: Array<{ service: { diagnostics: string } }> };
    expect(listed.profiles[0]?.service.diagnostics).toBe("token=[redacted] [redacted]");
    expect("privateValue" in (listed.profiles[0] ?? {})).toBe(false);
    await ipc.handlers.get("omp:profiles:add")!(event, request("omp:profiles:add", {
      profile: { profileId: "fable-swarm", label: "Fable Swarm", autoStart: true },
    }));
    await ipc.handlers.get("omp:profiles:update")!(event, request("omp:profiles:update", {
      profileId: "fable-swarm",
      changes: { autoStart: false },
    }));
    await ipc.handlers.get("omp:profiles:status")!(event, request("omp:profiles:status", {
      profileId: "fable-swarm",
    }));
    for (const action of ["start", "stop", "restart"] as const) {
      await ipc.handlers.get(`omp:profiles:${action}`)!(event, request(`omp:profiles:${action}`, {
        profileId: "fable-swarm",
      }));
    }
    await ipc.handlers.get("omp:profiles:remove")!(event, request("omp:profiles:remove", {
      profileId: "fable-swarm",
    }));
    expect(calls).toEqual([
      "add:fable-swarm",
      "update:fable-swarm",
      "status:fable-swarm",
      "start:fable-swarm",
      "stop:fable-swarm",
      "restart:fable-swarm",
      "remove:fable-swarm",
    ]);
    await expect(ipc.handlers.get("omp:profiles:start")!(event, request("omp:profiles:start", {
      profileId: "../escape",
    }))).rejects.toThrow("invalid profileId");
  });

  it("rejects payload keys and channel/action mismatches at the invoke boundary", async () => {
    const ipc = new FakeIpc();
    const { runtime } = makeRuntime();
    new DesktopIpcRegistry(runtime, ipc).install();
    const handler = ipc.handlers.get("omp:targets:list")!;
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    await expect(handler(event, request("omp:targets:list", { extra: true }))).rejects.toThrow();
    await expect(handler(event, request("omp:connect", {}))).rejects.toThrow();
  });
  it("routes projection cache load/save through the trusted shell service", async () => {
    const ipc = new FakeIpc();
    const { runtime: baseRuntime } = makeRuntime();
    const value = JSON.stringify({
      kind: "t4-code-projection",
      version: 1,
      data: { sessions: [], sessionIndex: [], lru: [], freshness: "cached" },
    });
    const saves: string[] = [];
    const runtime: IpcRuntime = {
      ...baseRuntime,
      projectionCache: {
        load: () => ({ available: true, value }),
        save: (serialized) => {
          saves.push(serialized);
          return { saved: true };
        },
      },
    };
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    expect(await ipc.handlers.get("app:projection-cache:load")!(
      event,
      request("app:projection-cache:load"),
    )).toEqual({ available: true, value });
    expect(await ipc.handlers.get("app:projection-cache:save")!(
      event,
      request("app:projection-cache:save", { value }),
    )).toEqual({ saved: true });
    expect(saves).toEqual([value]);
    await expect(ipc.handlers.get("app:projection-cache:save")!(
      event,
      request("app:projection-cache:save", { value, storageKey: "renderer-selected-file" }),
    )).rejects.toThrow();
    expect(saves).toEqual([value]);
  });
  it("takes no path from the renderer when choosing a directory", async () => {
    const ipc = new FakeIpc();
    const { runtime: baseRuntime } = makeRuntime();
    new DesktopIpcRegistry(baseRuntime, ipc).install();
    const event = { sender: baseRuntime.window.webContents, senderFrame: baseRuntime.window.webContents.mainFrame };
    // The renderer may ask, but it may not name a directory: the main process
    // runs the dialog and returns only what the operator picked.
    await expect(ipc.handlers.get("app:directory:choose")!(
      event,
      request("app:directory:choose", { path: "/etc" }),
    )).rejects.toThrow();
    // An untrusted sender cannot reach the dialog at all.
    await expect(ipc.handlers.get("app:directory:choose")!(
      { sender: {}, senderFrame: {} } as never,
      request("app:directory:choose"),
    )).rejects.toThrow();
  });
  it("returns the directory the operator picked, and nothing when dismissed", async () => {
    const { runtime: baseRuntime } = makeRuntime();
    const event = { sender: baseRuntime.window.webContents, senderFrame: baseRuntime.window.webContents.mainFrame };
    const parents: unknown[] = [];

    const pickIpc = new FakeIpc();
    new DesktopIpcRegistry(baseRuntime, pickIpc, {
      showOpenDialog: async (parent: unknown) => {
        parents.push(parent);
        return { canceled: false, filePaths: ["/tmp/chosen-project"] };
      },
    } as never).install();
    expect(await pickIpc.handlers.get("app:directory:choose")!(
      event,
      request("app:directory:choose"),
    )).toEqual({ path: "/tmp/chosen-project" });
    // Parented to the requesting window so it cannot open behind it.
    expect(parents).toEqual([baseRuntime.window]);

    const cancelIpc = new FakeIpc();
    new DesktopIpcRegistry(baseRuntime, cancelIpc, {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    } as never).install();
    expect(await cancelIpc.handlers.get("app:directory:choose")!(
      event,
      request("app:directory:choose"),
    )).toEqual({});
  });
  it("serializes concurrent service actions", async () => {
    const ipc = new FakeIpc();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const serviceManager = { inspect: async () => ({ definition: "current", service: "running", diagnostics: "ok" }), start: async () => { order.push("start"); await gate; }, stop: async () => { order.push("stop"); } } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const start = ipc.handlers.get("omp:service:start")!(event, request("omp:service:start"));
    const stop = ipc.handlers.get("omp:service:stop")!(event, request("omp:service:stop"));
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start"]);
    release();
    await Promise.all([start, stop]);
    expect(order).toEqual(["start", "stop"]);
  });
  it("linearizes inspection with actions and never reuses a pre-write snapshot", async () => {
    const ipc = new FakeIpc();
    let resolveFirst!: (value: { definition: "current"; service: "stopped"; diagnostics: string }) => void;
    const firstInspection = new Promise<{ definition: "current"; service: "stopped"; diagnostics: string }>((resolve) => {
      resolveFirst = resolve;
    });
    let inspectCalls = 0;
    let service: "stopped" | "running" = "stopped";
    let startCalls = 0;
    const serviceManager = {
      inspect: async () => {
        inspectCalls += 1;
        if (inspectCalls === 1) return firstInspection;
        return { definition: "current" as const, service, diagnostics: "" };
      },
      start: async () => {
        startCalls += 1;
        service = "running";
      },
    } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const inspect = ipc.handlers.get("omp:service:inspect")!;
    const start = ipc.handlers.get("omp:service:start")!;

    const before = inspect(event, request("omp:service:inspect"));
    await Promise.resolve();
    const write = start(event, request("omp:service:start"));
    await Promise.resolve();
    expect(startCalls).toBe(0);
    resolveFirst({ definition: "current", service: "stopped", diagnostics: "" });
    await before;
    await write;
    const after = await inspect(event, request("omp:service:inspect"));

    expect(inspectCalls).toBe(2);
    expect(startCalls).toBe(1);
    expect(after).toEqual({ definition: "current", service: "running", diagnostics: "" });
  });
  it("bounds service inspection and redacts diagnostic details", async () => {
    const ipc = new FakeIpc();
    const attack = [
      "Authorization: Bearer BEARER_SECRET authorization=Basic BASIC_SECRET",
      "Bearer BARE_BEARER_SECRET Basic BARE_BASIC_SECRET",
      "ws://alice:WS_SECRET@tailnet.local/private/path",
      "wss://tailnet.local/socket?token=QUERY_SECRET",
      "/Users/alice/Library/Application Support/T4 Code/auth.json",
      "at (/Users/alice/private/main.js:1:2)",
      "path=/home/alice/.config/t4-code/auth.json",
      "cwd=/home/alice/My Project",
      "file:///Users/alice/private/file.ts",
      '{"token":"TOPSECRET"}',
      '{"authorization":"Bearer JSON_SECRET"}',
      'token="secret with spaces"',
      "password='two words'",
      "access_token=ACCESS_SECRET",
      "client_secret=CLIENT_SECRET",
      "api_key=API_SECRET",
    ].join("\n");
    const serviceManager = { inspect: async () => ({ definition: "drifted", service: "failed", diagnostics: attack }) } as never as ServiceManager;
    const { runtime } = makeRuntime(serviceManager);
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const result = await ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect"));
    const inspection = result as { diagnostics: string };
    expect(inspection.diagnostics.length).toBeLessThanOrEqual(512);
    const error = runtimeError(new Error(attack));
    for (const leaked of [
      "BEARER_SECRET", "BASIC_SECRET", "BARE_BEARER_SECRET", "BARE_BASIC_SECRET",
      "WS_SECRET", "QUERY_SECRET", "tailnet.local", "TOPSECRET", "JSON_SECRET",
      "secret with spaces", "two words", "ACCESS_SECRET", "CLIENT_SECRET", "API_SECRET",
      "alice", "auth.json", "main.js", "file.ts", "/Users/", "/home/", "file:///",
    ]) {
      expect(inspection.diagnostics).not.toContain(leaked);
      expect(error.message).not.toContain(leaked);
    }
  });
  it("preserves a typed service-unavailable reason at the inspect boundary", async () => {
    const ipc = new FakeIpc();
    const reason = "Installed OMP is incompatible; `omp appserver status --json` is required.";
    const { runtime } = makeRuntime(undefined, { code: "omp_incompatible", message: reason });
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const inspection = await ipc.handlers.get("omp:service:inspect")!(event, request("omp:service:inspect"));
    expect(inspection).toEqual({
      definition: "missing",
      service: "unknown",
      diagnostics: "",
      issue: { code: "omp_incompatible", message: reason },
    });
  });
  it("keeps bootstrap read-only and shares one dynamic acquisition across concurrent inspection", async () => {
    const ipc = new FakeIpc();
    let acquisitions = 0;
    let inspections = 0;
    const serviceManager = {
      inspect: async () => {
        inspections += 1;
        return { definition: "current", service: "running", diagnostics: "" };
      },
    } as never as ServiceManager;
    const { runtime: baseRuntime } = makeRuntime();
    const runtime: IpcRuntime = {
      ...baseRuntime,
      getServiceManager: () => undefined,
      acquireServiceManager: async () => {
        acquisitions += 1;
        return serviceManager;
      },
    };
    new DesktopIpcRegistry(runtime, ipc).install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };
    const bootstrap = await ipc.handlers.get("omp:bootstrap")!(event, request("omp:bootstrap"));
    expect(acquisitions).toBe(0);
    expect((bootstrap as { service: { issue: { code: string } } }).service.issue.code).toBe("service_unavailable");
    const inspect = ipc.handlers.get("omp:service:inspect")!;
    await Promise.all([
      inspect(event, request("omp:service:inspect")),
      inspect(event, request("omp:service:inspect")),
    ]);
    expect(acquisitions).toBe(1);
    expect(inspections).toBe(1);
  });
  it("does not send events to destroyed windows", () => {
    const ipc = new FakeIpc();
    const { runtime, view } = makeRuntime();
    new DesktopIpcRegistry(runtime, ipc).install();
    view.window.isDestroyed = () => true;
    const registry = new DesktopIpcRegistry(runtime, ipc);
    registry.emitPairLink({ hostHint: "host", code: "123456", issuedAt: 1 });
    expect(view.sent).toEqual([]);
  });
  it("keeps update actions behind exact trusted IPC and emits each state once", async () => {
    const ipc = new FakeIpc();
    const { runtime: baseRuntime, view } = makeRuntime();
    const idle = Object.freeze({ version: 1 as const, currentVersion: "0.1.17", phase: "idle" as const });
    const available = Object.freeze({ version: 1 as const, currentVersion: "0.1.17", phase: "available" as const, availableVersion: "0.1.18", checkedAt: 123 });
    let checks = 0;
    let downloads = 0;
    let restarts = 0;
    let pendingUpdateOpen = true;
    let stateListener: ((state: typeof available) => void) | undefined;
    const runtime: IpcRuntime = {
      ...baseRuntime,
      drainPendingUpdateOpen: () => {
        const pending = pendingUpdateOpen;
        pendingUpdateOpen = false;
        return pending;
      },
      updateController: {
        getState: () => idle,
        checkForUpdate: async () => { checks += 1; return available; },
        downloadUpdate: async () => { downloads += 1; return available; },
        restartToUpdate: () => { restarts += 1; return available; },
        subscribe: (listener) => {
          stateListener = listener as (state: typeof available) => void;
          return () => { stateListener = undefined; };
        },
      },
    };
    const registry = new DesktopIpcRegistry(runtime, ipc);
    registry.install();
    const event = { sender: runtime.window.webContents, senderFrame: runtime.window.webContents.mainFrame };

    expect(await ipc.handlers.get("app:update:get-state")!(event, request("app:update:get-state"))).toEqual(idle);
    expect(await ipc.handlers.get("app:update:check")!(event, request("app:update:check"))).toEqual(available);
    expect(await ipc.handlers.get("app:update:download")!(event, request("app:update:download"))).toEqual(available);
    expect(await ipc.handlers.get("app:update:restart")!(event, request("app:update:restart"))).toEqual(available);
    expect(await ipc.handlers.get("app:update:renderer-ready")!(event, request("app:update:renderer-ready"))).toEqual({ openSettings: true });
    expect(await ipc.handlers.get("app:update:renderer-ready")!(event, request("app:update:renderer-ready"))).toEqual({ openSettings: false });
    expect({ checks, downloads, restarts }).toEqual({ checks: 1, downloads: 1, restarts: 1 });
    await expect(ipc.handlers.get("app:update:check")!(event, request("app:update:check", { url: "https://attacker.invalid" }))).rejects.toThrow("unknown key");
    expect(() => ipc.handlers.get("app:update:renderer-ready")!(event, request("app:update:renderer-ready", { openSettings: true }))).toThrow("unknown key");

    stateListener?.(available);
    registry.emitOpenUpdateSettings();
    expect(view.sent).toEqual([
      ["app:update:state", available],
      ["app:update:open", { source: "menu" }],
    ]);
    registry.uninstall();
    expect(stateListener).toBeUndefined();
  });
});
