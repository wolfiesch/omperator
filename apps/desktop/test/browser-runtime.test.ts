import { describe, expect, it } from "vitest";
import type { BrowserCallResult, BrowserEvent } from "@t4-code/protocol/browser-ipc";
import type { BrowserSurface as BrowserSurfaceType } from "../src/browser-surface.ts";

type VitestMockApi = {
  readonly vi: {
    mock(moduleName: string, factory: () => unknown): void;
  };
};

// The local Vitest declaration intentionally exposes only the common assertion API.
const vitest = await import("vitest") as unknown as VitestMockApi;

const electron = (() => {
  type Listener = (...args: unknown[]) => void;
  const loadFailures: unknown[] = [];


  class FakeWebContents {
    readonly listeners = new Map<string, Listener[]>();
    readonly navigationHistory = {
      canGoBack: () => this.canGoBack,
      canGoForward: () => this.canGoForward,
      goBack: () => { this.goBackCount += 1; },
      goForward: () => { this.goForwardCount += 1; },
    };
    canGoBack = false;
    canGoForward = false;
    goBackCount = 0;
    goForwardCount = 0;
    closed = false;
    url = "about:blank";
    title = "";
    on(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }
    removeListener(event: string, listener: Listener): void {
      const listeners = this.listeners.get(event) ?? [];
      this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
    isDestroyed(): boolean { return this.closed; }
    close(): void { this.closed = true; this.emit("destroyed"); }
    loadURL(url: string): Promise<void> {
      this.url = url;
      const failure = loadFailures.shift();
      return failure === undefined ? Promise.resolve() : Promise.reject(failure);
    }
    getURL(): string { return this.url; }
    getTitle(): string { return this.title; }
    isLoadingMainFrame(): boolean { return false; }
    reload(): void {}
    stop(): void {}
    setAudioMuted(): void {}
    setZoomFactor(): void {}
    getZoomFactor(): number { return 1; }
    focus(): void {}
    executeJavaScript(): Promise<unknown> { return Promise.resolve(undefined); }
  }

  class FakeWebContentsView {
    readonly webContents = new FakeWebContents();
    bounds: unknown;
    setBounds(bounds: unknown): void { this.bounds = bounds; }
  }

  const views: FakeWebContentsView[] = [];
  class WebContentsView extends FakeWebContentsView {
    constructor() {
      super();
      views.push(this);
    }
  }

  return {
    WebContentsView,
    session: { defaultSession: {} },
    views,
    ipcMain: { on: () => {}, removeListener: () => {} },
    contentTracing: { startRecording: async () => {}, stopRecording: async () => "" },
    failNextLoad: (error: unknown) => { loadFailures.push(error); },
    reset: () => {
      views.length = 0;
      loadFailures.length = 0;
    },
  };
})();

vitest.vi.mock("electron", () => ({
  WebContentsView: electron.WebContentsView,
  contentTracing: electron.contentTracing,
  ipcMain: electron.ipcMain,
  session: electron.session,
}));

// These imports follow the Electron mock; the native Electron binding cannot load in this test process.
const { BrowserRuntime } = await import("../src/browser-runtime.ts");
const { BrowserSessionStore, decodeBrowserSessionStoreState } = await import("../src/browser-session-store.ts");
const { BrowserSurface } = await import("../src/browser-surface.ts");

class FakeWindow {
  closed = false;
  readonly contentView = {
    children: new Set<unknown>(),
    addChildView: (view: unknown) => { this.contentView.children.add(view); },
    removeChildView: (view: unknown) => { this.contentView.children.delete(view); },
  };
  close(): void { this.closed = true; }
}

const isolatedProfile = { kind: "isolated-session", profileId: "isolated-session" } as const;
const OWNER_A = "workspace-session-a";
const OWNER_B = "workspace-session-b";
const OWNER_C = "workspace-session-c";

function browserCall(method: string, request: Record<string, unknown>, ownerSessionId = OWNER_A): never {
  return { method, request, ownerSessionId } as never;
}

async function expectContentReadyTimeout(surface: BrowserSurfaceType): Promise<void> {
  try {
    await surface.waitForContentReady(0);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error)) throw error;
    expect(error.code).toBe("timeout");
    return;
  }
  throw new Error("Expected content readiness to time out");
}

async function settleBackgroundWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowserRuntime native view lifecycle", () => {
  it("routes accessibility snapshots and design mode through the exact owner-scoped surface", async () => {
    electron.reset();
    const calls: unknown[] = [];
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-design-mode",
      profileRegistry: {
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: () => {} },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
      }),
      automationCoordinator: {
        call: async (call) => {
          calls.push(call);
          if (call.method === "browser.snapshot") {
            return {
              snapshot: {
                url: "https://example.test/",
                title: "Example",
                elements: [{ role: "heading", name: "Visible heading", visible: true }],
              },
            };
          }
          return { enabled: true, selection: "Heading" };
        },
        dispose: () => {},
      },
    });
    const created = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://example.test/",
    })) as BrowserCallResult<"surface.create">;

    const result = await runtime.call(browserCall("browser.design_mode.set", {
      surfaceId: created.surface.surfaceId,
      enabled: true,
    }));
    const snapshot = await runtime.call(browserCall("browser.snapshot", {
      surfaceId: created.surface.surfaceId,
    }));

    expect(result).toEqual({ enabled: true, selection: "Heading" });
    expect(snapshot).toEqual({
      snapshot: {
        url: "https://example.test/",
        title: "Example",
        elements: [{ role: "heading", name: "Visible heading", visible: true }],
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "browser.design_mode.set",
      ownerSessionId: OWNER_A,
      request: {
        surfaceId: created.surface.surfaceId,
        enabled: true,
      },
    });
    expect(calls[1]).toMatchObject({
      method: "browser.snapshot",
      ownerSessionId: OWNER_A,
      request: { surfaceId: created.surface.surfaceId },
    });
    await runtime.dispose();
  });

  it("requests isolated Electron sessions using the owning OMP session id", async () => {
    electron.reset();
    const ownerSessions: unknown[] = [];
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-owner-partitions",
      profileRegistry: {
        getSession: (_profile, ownerSessionId) => {
          ownerSessions.push(ownerSessionId);
          return {};
        },
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: () => {} },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
      }),
    });

    await runtime.call(browserCall("surface.create", { profile: isolatedProfile }, OWNER_A));
    await runtime.call(browserCall("surface.create", { profile: isolatedProfile }, OWNER_B));

    expect(ownerSessions).toEqual([OWNER_A, OWNER_B]);
    await runtime.dispose();
  });

  it("creates and attaches a surface, detaches it while hidden, reattaches it, and disposes without orphaning it", async () => {
    electron.reset();
    const window = new FakeWindow();
    const released: string[] = [];
    const profileSession = {};
    const downloadAttachments: unknown[][] = [];
    const runtime = new BrowserRuntime({
      window: window as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-test",
      profileRegistry: {
        getSession: () => profileSession,
        markInUse: () => {},
        release: (profileId) => { released.push(profileId); },
      },
      sessionStore: { save: () => {} },
      downloadController: {
        attach: (...args) => { downloadAttachments.push(args); },
        disposeSurface: () => {},
        dispose: () => {},
      },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
      }),
    });

    const created = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://example.test/",
    })) as BrowserCallResult<"surface.create">;
    expect(created.surface.surfaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(electron.views).toHaveLength(1);
    const view = electron.views[0]!;
    expect(window.contentView.children).toEqual(new Set([view]));
    const surfaceId = created.surface.surfaceId;
    expect(created.surface.handle).toBe("surface:1");
    expect(downloadAttachments).toEqual([[view.webContents, surfaceId, profileSession]]);
    await runtime.call(browserCall("surface.setBounds", {
      surfaceId,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      visible: false,
    }));
    expect(window.contentView.children).toEqual(new Set());
    expect(view.webContents.closed).toBe(false);

    await runtime.call(browserCall("surface.setBounds", {
      surfaceId,
      bounds: { x: 1, y: 2, width: 300, height: 200 },
      visible: true,
    }));
    expect(window.contentView.children).toEqual(new Set([view]));

    await runtime.dispose();
    expect(window.contentView.children).toEqual(new Set());
    expect(view.webContents.closed).toBe(true);
    expect(released).toEqual(["isolated-session"]);
  });

  it("keeps surfaces and prewarmed views within their owning workspace session", async () => {
    electron.reset();
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-ownership",
      profileRegistry: {
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: () => {} },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
      }),
    });

    const owned = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://owner-a.example.test/",
    }, OWNER_A)) as BrowserCallResult<"surface.create">;
    const prewarmed = await runtime.prewarm(OWNER_B as never, isolatedProfile, "https://prewarm-b.example.test/");
    const createdByA = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://prewarm-b.example.test/",
    }, OWNER_A)) as BrowserCallResult<"surface.create">;

    const aList = await runtime.call(browserCall("surface.list", {}, OWNER_A)) as BrowserCallResult<"surface.list">;
    const bList = await runtime.call(browserCall("surface.list", {}, OWNER_B)) as BrowserCallResult<"surface.list">;
    expect(aList.surfaces.map((surface) => surface.surfaceId)).toEqual([
      owned.surface.surfaceId,
      createdByA.surface.surfaceId,
    ]);
    expect(bList.surfaces.map((surface) => surface.surfaceId)).toEqual([prewarmed.surfaceId]);

    let crossOwnerError: unknown;
    try {
      await runtime.call(browserCall("surface.get", { surfaceId: prewarmed.surfaceId }, OWNER_A));
    } catch (error) {
      crossOwnerError = error;
    }
    expect((crossOwnerError as { code?: unknown }).code).toBe("not_found");

    let crossOwnerDesignModeError: unknown;
    try {
      await runtime.call(browserCall("browser.design_mode.status", {
        surfaceId: prewarmed.surfaceId,
      }, OWNER_A));
    } catch (error) {
      crossOwnerDesignModeError = error;
    }
    expect((crossOwnerDesignModeError as { code?: unknown }).code).toBe("not_found");

    let fallbackError: unknown;
    try {
      await runtime.call(browserCall("browser.navigate", { url: "https://no-owner.example.test/" }, OWNER_C));
    } catch (error) {
      fallbackError = error;
    }
    expect((fallbackError as { code?: unknown }).code).toBe("not_found");
    await runtime.dispose();
  });

  it("restores only persisted surfaces with a matching explicit owner", async () => {
    electron.reset();
    const persisted = { value: [] as unknown[] };
    const options = {
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-restore-ownership",
      profileRegistry: {
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: {
        load: () => persisted.value as never,
        save: (metadata: unknown) => { persisted.value = metadata as unknown[]; },
      },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" } as const),
      }),
    };
    const initial = new BrowserRuntime(options);
    const a = await initial.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://persisted-a.example.test/",
    }, OWNER_A)) as BrowserCallResult<"surface.create">;
    const b = await initial.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://persisted-b.example.test/",
    }, OWNER_B)) as BrowserCallResult<"surface.create">;
    await initial.dispose();

    const restored = new BrowserRuntime({ ...options, window: new FakeWindow() as never });
    const aList = await restored.call(browserCall("surface.list", {}, OWNER_A)) as BrowserCallResult<"surface.list">;
    const bList = await restored.call(browserCall("surface.list", {}, OWNER_B)) as BrowserCallResult<"surface.list">;
    expect(aList.surfaces.map((surface) => surface.surfaceId)).toEqual([a.surface.surfaceId]);
    expect(bList.surfaces.map((surface) => surface.surfaceId)).toEqual([b.surface.surfaceId]);
    await restored.dispose();
  });

  it("does not restore authenticated pages before fresh user consent", async () => {
    electron.reset();
    const authenticated = {
      kind: "authenticated-profile",
      profileId: "work",
      explicitOptIn: true,
    } as const;
    let sessionRequests = 0;
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-authenticated-restore",
      profileRegistry: {
        resolve: () => authenticated,
        getSession: () => {
          sessionRequests += 1;
          return electron.session.defaultSession;
        },
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: {
        load: () => [{
          surfaceId: "11111111-1111-4111-8111-111111111111",
          handle: "surface:1",
          ownerSessionId: OWNER_A,
          profile: authenticated,
          url: "https://authenticated.example.test/",
          order: 0,
          zoom: 1,
        }] as never,
        save: () => {},
      },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
    });

    const restored = await runtime.call(browserCall("surface.list", {}, OWNER_A)) as BrowserCallResult<"surface.list">;

    expect(restored.surfaces).toEqual([]);
    expect(sessionRequests).toBe(0);
    expect(electron.views).toHaveLength(0);
    await runtime.dispose();
  });

  it("creates a hidden managed surface for accepted popups", async () => {
    electron.reset();
    let popup: ((request: { readonly url: string; readonly frameName: string; readonly disposition: string; readonly referrer: string }) => boolean) | undefined;
    const window = new FakeWindow();
    const runtime = new BrowserRuntime({
      window: window as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-popup",
      profileRegistry: {
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: () => {} },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: (options) => {
        if (options.onPopup !== undefined) popup = options.onPopup;
        return {
          auth: null,
          clearTrustGrants: () => {},
          dispose: () => {},
          grantCertificate: () => false,
          setProfile: () => {},
          configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
        };
      },
    });
    await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://origin.example.test/",
    }, OWNER_A));
    if (popup === undefined) throw new Error("Expected popup callback to be installed");
    expect(popup({
      url: "https://popup.example.test/",
      frameName: "popup",
      disposition: "new-window",
      referrer: "https://origin.example.test/",
    })).toBe(true);

    const listed = await runtime.call(browserCall("surface.list", {}, OWNER_A)) as BrowserCallResult<"surface.list">;
    expect(listed.surfaces).toHaveLength(2);
    expect(listed.surfaces[1]?.url).toBe("https://popup.example.test/");
    expect(listed.surfaces[1]?.visible).toBe(false);
    expect(electron.views).toHaveLength(2);
    await runtime.dispose();
  });

  it("blocks authenticated popups until the user can consent to the new surface", async () => {
    electron.reset();
    let popup: ((request: { readonly url: string; readonly frameName: string; readonly disposition: string; readonly referrer: string }) => boolean) | undefined;
    const authenticated = {
      kind: "authenticated-profile",
      profileId: "work",
      explicitOptIn: true,
    } as const;
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-authenticated-popup",
      profileRegistry: {
        resolve: () => authenticated,
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: () => {} },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: (options) => {
        if (options.onPopup !== undefined) popup = options.onPopup;
        return {
          auth: null,
          clearTrustGrants: () => {},
          dispose: () => {},
          grantCertificate: () => false,
          setProfile: () => {},
          configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
        };
      },
    });
    await runtime.call(browserCall("surface.create", {
      profile: authenticated,
      url: "https://authenticated.example.test/",
    }, OWNER_A));
    if (popup === undefined) throw new Error("Expected popup callback to be installed");

    expect(popup({
      url: "https://popup.example.test/",
      frameName: "popup",
      disposition: "new-window",
      referrer: "https://authenticated.example.test/",
    })).toBe(false);

    const listed = await runtime.call(browserCall("surface.list", {}, OWNER_A)) as BrowserCallResult<"surface.list">;
    expect(listed.surfaces).toHaveLength(1);
    expect(electron.views).toHaveLength(1);
    await runtime.dispose();
  });

  it("contains background browser failures without closing the parent window", async () => {
    electron.reset();
    electron.failNextLoad(new Error("initial load failed"));
    const window = new FakeWindow();
    const events: BrowserEvent[] = [];
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      let installationCount = 0;
      const runtime = new BrowserRuntime({
        window: window as never,
        emit: (event) => { events.push(event); },
        userDataPath: "/tmp/t4-browser-runtime-failures",
        profileRegistry: {
          getSession: () => electron.session.defaultSession,
          markInUse: () => {},
          release: () => {},
        },
        sessionStore: { save: () => Promise.reject(new Error("session persistence failed")) },
        downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
        installSecurity: () => {
          installationCount += 1;
          if (installationCount > 1) throw new Error("security reinstall failed");
          return {
            auth: null,
            clearTrustGrants: () => {},
            dispose: () => {},
            grantCertificate: () => false,
            setProfile: () => {},
            configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
          };
        },
      });

      const created = await runtime.call(browserCall("surface.create", {
        profile: isolatedProfile,
        url: "https://example.test/",
        visible: false,
      })) as BrowserCallResult<"surface.create">;
      const networkControllers = runtime as unknown as {
        networkControllers: Map<string, { dispose: () => Promise<void> }>;
      };
      networkControllers.networkControllers.set(created.surface.surfaceId, {
        dispose: async () => { throw new Error("network disposal failed"); },
      });
      electron.failNextLoad(new Error("replacement load failed"));
      electron.views[0]!.webContents.emit("render-process-gone", {}, { reason: "crashed" });
      await settleBackgroundWork();

      const tabs = await runtime.call(browserCall("browser.tab.list", {}));
      if (
        typeof tabs !== "object"
        || tabs === null
        || !("surfaces" in tabs)
        || !Array.isArray(tabs.surfaces)
      ) {
        throw new Error("browser.tab.list must return a surfaces array");
      }
      expect(tabs.surfaces).toHaveLength(1);
      expect(electron.views).toHaveLength(2);
      expect(window.closed).toBe(false);
      expect(unhandled).toEqual([]);
      const errors = events.filter((event): event is Extract<BrowserEvent, { type: "error" }> => event.type === "error");
      expect(errors.some(({ error }) => error.code === "load_failed" && error.fatal === false)).toBe(true);
      expect(errors.some(({ error }) => error.code === "session_persist_failed" && error.fatal === false)).toBe(true);
      expect(errors.some(({ error }) => error.code === "network_dispose_failed" && error.fatal === false)).toBe(true);
      expect(errors.some(({ error }) => error.code === "security_install_failed" && error.fatal === false)).toBe(true);

      await runtime.dispose();
      expect(window.closed).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("assigns independent UUID identities and monotonic handles, including persisted session metadata", async () => {
    electron.reset();
    const savedSessions: unknown[] = [];
    const runtime = new BrowserRuntime({
      window: new FakeWindow() as never,
      emit: () => {},
      userDataPath: "/tmp/t4-browser-runtime-identities",
      profileRegistry: {
        getSession: () => electron.session.defaultSession,
        markInUse: () => {},
        release: () => {},
      },
      sessionStore: { save: (metadata) => { savedSessions.push(metadata); } },
      downloadController: { attach: () => {}, disposeSurface: () => {}, dispose: () => {} },
      installSecurity: () => ({
        auth: null,
        clearTrustGrants: () => {},
        dispose: () => {},
        grantCertificate: () => false,
        setProfile: () => {},
        configureProxy: async () => ({ ok: false, code: "not_supported", message: "Not used by this test" }),
      }),
    });

    const first = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://one.example.test/",
    })) as BrowserCallResult<"surface.create">;
    const second = await runtime.call(browserCall("surface.create", {
      profile: isolatedProfile,
      url: "https://two.example.test/",
    })) as BrowserCallResult<"surface.create">;

    expect(first.surface.surfaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(second.surface.surfaceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.surface.surfaceId).not.toBe(second.surface.surfaceId);
    expect(first.surface.handle).toBe("surface:1");
    expect(second.surface.handle).toBe("surface:2");
    const savedBeforeClose = savedSessions.at(-1);

    const firstLookup = await runtime.call(browserCall("surface.get", { surfaceId: first.surface.surfaceId })) as BrowserCallResult<"surface.get">;
    expect(firstLookup.surface.surfaceId).toBe(first.surface.surfaceId);
    expect(firstLookup.surface.handle).toBe("surface:1");
    expect(firstLookup.surface.profile).toEqual(isolatedProfile);
    await runtime.call(browserCall("surface.close", { surfaceId: first.surface.surfaceId }));
    const secondLookup = await runtime.call(browserCall("surface.get", { surfaceId: second.surface.surfaceId })) as BrowserCallResult<"surface.get">;
    expect(secondLookup.surface.surfaceId).toBe(second.surface.surfaceId);
    expect(secondLookup.surface.handle).toBe("surface:2");
    expect(secondLookup.surface.profile).toEqual(isolatedProfile);

    const restored = new BrowserSessionStore({
      store: {
        get store() { return { version: 2, surfaces: savedBeforeClose }; },
        set: () => {},
      },
    }).load();
    expect(restored).toHaveLength(2);
    const restoredFirst = restored.find(({ surfaceId }) => surfaceId === first.surface.surfaceId);
    if (!restoredFirst) throw new Error("Expected the first surface session to be persisted");
    expect(restoredFirst.handle).toBe("surface:1");
    expect(restoredFirst.ownerSessionId).toBe(OWNER_A);
    expect(restoredFirst.profile).toEqual(isolatedProfile);
    const restoredSecond = restored.find(({ surfaceId }) => surfaceId === second.surface.surfaceId);
    if (!restoredSecond) throw new Error("Expected the second surface session to be persisted");
    expect(restoredSecond.handle).toBe("surface:2");
    expect(restoredSecond.profile).toEqual(isolatedProfile);
    expect(decodeBrowserSessionStoreState({
      version: 2,
      surfaces: [
        { ...restored[0], handle: "surface:1" },
        { ...restored[1], handle: "surface:1" },
      ],
    }).surfaces).toEqual([]);
    expect(decodeBrowserSessionStoreState({
      version: 2,
      surfaces: [{ ...restored[0], ownerSessionId: undefined, sessionId: "legacy-runtime-owner" }],
    }).surfaces).toEqual([]);

    await runtime.dispose();
  });
});

describe("BrowserSurface history navigation", () => {
  it("invalidates content readiness synchronously before navigation-history back and forward", async () => {
    electron.reset();
    const surface = new BrowserSurface({
      window: new FakeWindow() as never,
      surfaceId: "ab12cd34-5678-4abc-8def-0123456789ab" as never,
      handle: "surface:1" as never,
      profile: isolatedProfile,
      session: electron.session.defaultSession as never,
      url: "https://example.test/",
      bounds: { x: 0, y: 0, width: 300, height: 200 },
      visible: false,
      emit: () => {},
    });
    const contents = electron.views[0]!.webContents;

    contents.emit("did-finish-load");
    await surface.waitForContentReady(1);
    contents.canGoBack = true;
    const back = surface.goBack();
    await expectContentReadyTimeout(surface);
    await back;
    expect(contents.goBackCount).toBe(1);

    contents.emit("did-finish-load");
    await surface.waitForContentReady(1);
    contents.canGoForward = true;
    const forward = surface.goForward();
    await expectContentReadyTimeout(surface);
    await forward;
    expect(contents.goForwardCount).toBe(1);
  });
});
