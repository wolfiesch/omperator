import { describe, expect, it } from "vitest";

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

class MockDesktopLifecycle {
  start(): Promise<void> {
    return Promise.resolve();
  }
}

class MockElectronApp {
  on(): this {
    return this;
  }

  removeListener(): this {
    return this;
  }

  quit(): void {}

  setPath(): void {}
}

const vitest = await import("vitest") as unknown as VitestMockApi;
vitest.vi.mock("electron", () => ({ app: new MockElectronApp() }));
vitest.vi.mock("../src/lifecycle.ts", () => ({
  DesktopLifecycle: MockDesktopLifecycle,
  developmentSandboxServiceConfig: () => undefined,
}));

// Main bootstraps at module evaluation, so load it only after mocking native Electron.
const { applyDevelopmentSandbox, bootstrapDesktopMain } = await import("../src/main.ts");

type ProcessEvent = "uncaughtException" | "unhandledRejection";
type ProcessListener = (reason: unknown) => void;

class FakeProcess {
  readonly platform = "linux";
  private readonly listeners = new Map<ProcessEvent, Set<ProcessListener>>();

  on(event: ProcessEvent, listener: ProcessListener): this {
    let eventListeners = this.listeners.get(event);
    if (eventListeners === undefined) {
      eventListeners = new Set();
      this.listeners.set(event, eventListeners);
    }
    eventListeners.add(listener);
    return this;
  }

  removeListener(event: ProcessEvent, listener: ProcessListener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: ProcessEvent, reason: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(reason);
  }

  listenerCount(event: ProcessEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeApp {
  quitCalls = 0;
  private readonly listeners = new Set<() => void>();

  on(_event: "window-all-closed", listener: () => void): this {
    this.listeners.add(listener);
    return this;
  }

  removeListener(_event: "window-all-closed", listener: () => void): this {
    this.listeners.delete(listener);
    return this;
  }

  quit(): void {
    this.quitCalls += 1;
  }
}

function runtime(start: () => Promise<void> = () => Promise.resolve()): {
  readonly app: FakeApp;
  readonly process: FakeProcess;
  readonly reports: string[];
  readonly lifecycle: { start(): Promise<void> };
} {
  return {
    app: new FakeApp(),
    process: new FakeProcess(),
    reports: [],
    lifecycle: { start },
  };
}

describe("main runtime failure policy", () => {
  it("reports bounded runtime rejections without quitting or duplicating listeners", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    for (let index = 0; index < 12; index += 1) {
      harness.process.emit("unhandledRejection", new Error(`browser failure ${index}`));
    }

    expect(harness.app.quitCalls).toBe(0);
    expect(harness.reports).toHaveLength(10);
    expect(harness.reports.at(-1)).toContain("further runtime rejections suppressed");

    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });
    expect(harness.process.listenerCount("unhandledRejection")).toBe(1);
    expect(harness.process.listenerCount("uncaughtException")).toBe(1);
  });

  it("quits once after a fatal lifecycle startup failure", async () => {
    const harness = runtime(async () => {
      throw new Error("startup failed");
    });

    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    expect(harness.app.quitCalls).toBe(1);
    expect(harness.reports).toEqual(["[desktop] fatal startup failure: Error: startup failed"]);
  });

  it("keeps uncaught main exceptions fatal", async () => {
    const harness = runtime();
    await bootstrapDesktopMain({ ...harness, report: (message) => harness.reports.push(message) });

    harness.process.emit("uncaughtException", new Error("main invariant violated"));
    harness.process.emit("uncaughtException", new Error("another invariant violated"));

    expect(harness.app.quitCalls).toBe(1);
    expect(harness.reports).toEqual([
      "[desktop] fatal main exception: Error: main invariant violated",
      "[desktop] fatal main exception: Error: another invariant violated",
    ]);
  });
});

describe("development sandbox startup", () => {
  function sandboxApp(): {
    readonly paths: [string, string][];
    readonly switches: string[];
    setPath(name: string, path: string): void;
    readonly commandLine: { appendSwitch(name: string): void };
  } {
    const paths: [string, string][] = [];
    const switches: string[] = [];
    return {
      paths,
      switches,
      setPath: (name, path) => { paths.push([name, path]); },
      commandLine: { appendSwitch: (name) => { switches.push(name); } },
    };
  }

  it("redirects userData and mocks the keychain the sandboxed HOME cannot provide", () => {
    const target = sandboxApp();

    applyDevelopmentSandbox(target, { electronUserData: "/tmp/sandbox/electron/user-data" }, "darwin");

    expect(target.paths).toEqual([["userData", "/tmp/sandbox/electron/user-data"]]);
    expect(target.switches).toEqual(["use-mock-keychain"]);
  });

  it("leaves the keychain alone off macOS", () => {
    const target = sandboxApp();

    applyDevelopmentSandbox(target, { electronUserData: "/tmp/sandbox/electron/user-data" }, "linux");

    expect(target.paths).toEqual([["userData", "/tmp/sandbox/electron/user-data"]]);
    expect(target.switches).toEqual([]);
  });

  it("touches nothing outside a development sandbox", () => {
    const target = sandboxApp();

    applyDevelopmentSandbox(target, undefined, "darwin");

    expect(target.paths).toEqual([]);
    expect(target.switches).toEqual([]);
  });
});
