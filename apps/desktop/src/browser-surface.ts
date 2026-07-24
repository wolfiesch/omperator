import { join } from "node:path";
import type { BrowserWindow, Session, WebContents, WebContentsView } from "electron";
import { WebContentsView as NativeWebContentsView, session as electronSession } from "electron";
import type {
  BrowserBounds,
  BrowserEvent,
  BrowserJsonValue,
  BrowserProfile,
  BrowserReadyState,
  BrowserSnapshot,
  BrowserSurfaceState,
  SurfaceHandle,
  SurfaceId,
} from "@t4-code/protocol/browser-ipc";

export interface BrowserSurfaceOptions {
  readonly window: BrowserWindow;
  readonly surfaceId: SurfaceId;
  readonly handle: SurfaceHandle;
  readonly profile: BrowserProfile;
  readonly session?: Session;
  readonly url: string;
  readonly bounds: BrowserBounds;
  readonly visible: boolean;
  readonly allowFileUrls?: boolean;
  readonly emit: (event: BrowserEvent) => void;
  readonly onCrash?: (surface: BrowserSurface, contents: WebContents, generation: number) => void;
}

export interface BrowserSurfaceAction {
  readonly surface: BrowserSurfaceState;
  readonly postActionSnapshot?: BrowserSnapshot;
}
export interface BrowserSurfaceViewport {
  readonly width: number;
  readonly height: number;
}

/** Stable, credential-free surface view consumed by browser automation modules. */
export interface BrowserSurfaceAutomationAdapter {
  readonly surfaceId: SurfaceId;
  readonly webContents: WebContents;
  readonly browserSession: Session;
  readonly session: Session;
  readonly profile: BrowserProfile;
  readonly bounds: BrowserBounds;
  readonly viewport: BrowserSurfaceViewport;
  readonly state: BrowserSurfaceState;
  readonly snapshot: () => Promise<BrowserSnapshot>;
  readonly getSnapshot: () => Promise<BrowserSnapshot>;
  readonly getBounds: () => BrowserBounds;
  readonly getViewport: () => BrowserSurfaceViewport;
  readonly setBounds: (bounds: BrowserBounds) => BrowserSurfaceState;
  readonly setViewport: (viewport: BrowserSurfaceViewport) => BrowserSurfaceViewport;
  readonly resetViewport: () => BrowserSurfaceViewport;
  readonly setZoomFactor: (zoomFactor: number) => number;
  readonly getZoomFactor: () => number;
  readonly focus: () => void;
  readonly isFocused: () => boolean;
  readonly waitForContentReady: (timeoutMs: number) => Promise<void>;
}

const DEFAULT_BOUNDS: BrowserBounds = { x: 0, y: 0, width: 800, height: 600 };
const EMPTY_URL = "about:blank";

export function isSafeBrowserUrl(value: string, allowFile = false): boolean {
  if (value.length === 0 || value.length > 16_384) return false;
  if (value === "about:blank") return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
    if (parsed.protocol === "about:") return parsed.href === "about:blank";
    if (parsed.protocol === "file:") return allowFile;
    return false;
  } catch {
    return false;
  }
}

function copyBounds(bounds: BrowserBounds): BrowserBounds {
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
}

function safeBounds(bounds: BrowserBounds): BrowserBounds {
  const candidate = bounds ?? DEFAULT_BOUNDS;
  return {
    x: Number.isFinite(candidate.x) ? candidate.x : 0,
    y: Number.isFinite(candidate.y) ? candidate.y : 0,
    width: Math.max(1, Number.isFinite(candidate.width) ? candidate.width : DEFAULT_BOUNDS.width),
    height: Math.max(1, Number.isFinite(candidate.height) ? candidate.height : DEFAULT_BOUNDS.height),
  };
}

function safeViewport(viewport: BrowserSurfaceViewport): BrowserSurfaceViewport {
  const width = Number.isFinite(viewport?.width) ? Math.floor(viewport.width) : DEFAULT_BOUNDS.width;
  const height = Number.isFinite(viewport?.height) ? Math.floor(viewport.height) : DEFAULT_BOUNDS.height;
  return { width: Math.max(1, Math.min(4_096, width)), height: Math.max(1, Math.min(4_096, height)) };
}

function stateReadyState(value: string): BrowserReadyState {
  return value === "loading" || value === "interactive" ? value : "complete";
}

function failureMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return (message || fallback).slice(0, 1_024);
}
type BrowserSurfaceReadyErrorCode = "invalid_state" | "internal" | "timeout";

class BrowserSurfaceReadyError extends Error {
  readonly code: BrowserSurfaceReadyErrorCode;

  constructor(code: BrowserSurfaceReadyErrorCode, message: string) {
    super(message);
    this.name = "BrowserSurfaceReadyError";
    this.code = code;
  }
}

/** One native WebContentsView and its serializable browser state. */
export class BrowserSurface {
  readonly surfaceId: SurfaceId;
  readonly handle: SurfaceHandle;
  readonly profile: BrowserProfile;
  readonly window: BrowserWindow;

  private readonly emit: (event: BrowserEvent) => void;
  private readonly allowFileUrls: boolean;
  private readonly onCrash: ((surface: BrowserSurface, contents: WebContents, generation: number) => void) | undefined;
  private readonly browserSession: Session;
  private view: WebContentsView | null = null;
  private attached = false;
  private stateValue: BrowserSurfaceState;
  private contentReadyContents: WebContents | null = null;
  private contentReadyFailure: { contents: WebContents; error: BrowserSurfaceReadyError } | null = null;
  private closed = false;
  private replacing = false;
  private viewGeneration = 0;
  private zoomFactor = 1;
  private viewportValue: BrowserSurfaceViewport;
  constructor(options: BrowserSurfaceOptions) {
    this.surfaceId = options.surfaceId;
    this.handle = options.handle;
    this.profile = options.profile;
    this.window = options.window;
    this.emit = options.emit;
    this.allowFileUrls = options.allowFileUrls === true;
    this.onCrash = options.onCrash;
    this.browserSession = options.session ?? electronSession.defaultSession;
    const now = Date.now();
    this.stateValue = {
      surfaceId: options.surfaceId,
      handle: options.handle,
      profile: options.profile,
      url: isSafeBrowserUrl(options.url, this.allowFileUrls) ? options.url : EMPTY_URL,
      title: "",
      lifecycle: "creating",
      readyState: "loading",
      loading: true,
      progress: 0,
      canGoBack: false,
      canGoForward: false,
      bounds: safeBounds(options.bounds),
      visible: options.visible,
      muted: false,
      focused: "none",
      createdAt: now,
      updatedAt: now,
    };
    this.viewportValue = { width: this.stateValue.bounds.width, height: this.stateValue.bounds.height };
    this.createView();
  }

  get state(): BrowserSurfaceState {
    return { ...this.stateValue, bounds: copyBounds(this.stateValue.bounds) };
  }

  get webContents(): WebContents | null {
    return this.view?.webContents ?? null;
  }

  get nativeView(): WebContentsView | null {
    return this.view;
  }
  /**
   * Returns a fresh structural adapter. Accessors resolve live state so a
   * renderer replacement never leaves automation holding stale WebContents.
   */
  automationAdapter(): BrowserSurfaceAutomationAdapter {
    const getSurface = () => this;
    return {
      get surfaceId() { return getSurface().surfaceId; },
      get webContents() {
        const contents = getSurface().webContents;
        if (!contents || contents.isDestroyed()) throw new Error("Surface is unavailable");
        return contents;
      },
      get browserSession() { return getSurface().browserSession; },
      get session() { return getSurface().browserSession; },
      get profile() { return getSurface().profile; },
      get bounds() { return getSurface().state.bounds; },
      get viewport() { return getSurface().getViewport(); },
      get state() { return getSurface().state; },
      snapshot: () => getSurface().snapshot(),
      getSnapshot: () => getSurface().snapshot(),
      getBounds: () => getSurface().state.bounds,
      getViewport: () => getSurface().getViewport(),
      setBounds: (bounds) => getSurface().setBounds(bounds),
      setViewport: (viewport) => getSurface().setViewport(viewport),
      resetViewport: () => getSurface().resetViewport(),
      setZoomFactor: (zoomFactor) => getSurface().setZoomFactor(zoomFactor),
      getZoomFactor: () => getSurface().getZoomFactor(),
      waitForContentReady: (timeoutMs) => getSurface().waitForContentReady(timeoutMs),
      focus: () => { getSurface().setFocused("webview"); },
      isFocused: () => getSurface().isFocused(),
    };
  }

  private update(patch: Partial<BrowserSurfaceState>, emit = true): void {
    if (this.closed) return;
    this.stateValue = { ...this.stateValue, ...patch, updatedAt: Date.now() };
    if (emit) this.emitState();
  }

  private emitState(): void {
    try {
      this.emit({ type: "state", surface: this.state });
    } catch {
      // Child WebContents lifecycle failures must not escape through listeners.
    }
  }

  get generation(): number {
    return this.viewGeneration;
  }

  private isCurrentContents(contents: WebContents, generation: number): boolean {
    return !this.closed && this.view?.webContents === contents && this.viewGeneration === generation;
  }

  private emitNonFatalError(kind: "navigation" | "renderer", code: string, message: string, url?: string): void {
    try {
      this.emit({
        type: "error",
        error: {
          surfaceId: this.surfaceId,
          kind,
          code: code.slice(0, 128),
          message: message.slice(0, 1_024),
          ...(url === undefined ? {} : { url }),
          fatal: false,
          timestamp: Date.now(),
        },
      });
    } catch {
      // Browser event subscribers must not turn a child WebContents failure fatal.
    }
  }

  private loadInBackground(url: string, contents: WebContents, generation: number): void {
    void this.loadContents(url, contents, generation).catch((error: unknown) => {
      if (!this.isCurrentContents(contents, generation)) return;
      this.emitNonFatalError("navigation", "load_failed", failureMessage(error, "Browser page failed to load"), url);
    });
  }

  private createView(): void {
    if (this.closed) return;
    this.contentReadyContents = null;
    this.contentReadyFailure = null;
    const view = new NativeWebContentsView({
      webPreferences: {
        preload: join(__dirname, "browser-content-preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        session: this.browserSession,
      },
    });
    const generation = this.viewGeneration + 1;
    this.view = view;
    this.viewGeneration = generation;
    this.installHandlers(view.webContents, generation);
    if (this.stateValue.visible) this.attach();
    this.loadInBackground(this.stateValue.url, view.webContents, generation);
  }

  private installHandlers(contents: WebContents, generation: number): void {
    type SurfaceEventListener = (...args: never[]) => void;
    const wc = contents as WebContents & {
      on: (name: string, listener: SurfaceEventListener) => void;
    };
    const isCurrent = (): boolean => this.isCurrentContents(contents, generation);
    wc.on("did-start-loading", () => {
      if (!isCurrent()) return;
      this.contentReadyContents = null;
      this.contentReadyFailure = null;
      this.update({ lifecycle: "loading", loading: true, readyState: "loading", progress: 0 });
    });
    wc.on("did-stop-loading", () => {
      if (!isCurrent()) return;
      this.update({ loading: false, progress: 1, lifecycle: "ready", readyState: "complete", canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
    });
    wc.on("did-finish-load", () => {
      if (!isCurrent()) return;
      this.contentReadyContents = contents;
      this.contentReadyFailure = null;
      this.update({ url: contents.getURL() || this.stateValue.url, title: contents.getTitle(), loading: false, lifecycle: "ready", readyState: "complete", progress: 1, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
    });
    wc.on("preload-error", () => {
      if (!isCurrent()) return;
      this.contentReadyFailure = { contents, error: new BrowserSurfaceReadyError("internal", "Browser content preload failed") };
    });
    wc.on("destroyed", () => {
      if (!isCurrent()) return;
      this.contentReadyFailure = { contents, error: new BrowserSurfaceReadyError("invalid_state", "Browser surface was destroyed") };
    });
    wc.on("did-navigate", (_event: unknown, url: string) => {
      if (!isCurrent()) return;
      if (isSafeBrowserUrl(url, this.allowFileUrls)) this.update({ url, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
    });
    wc.on("did-navigate-in-page", (_event: unknown, url: string) => {
      if (!isCurrent()) return;
      if (isSafeBrowserUrl(url, this.allowFileUrls)) this.update({ url, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() });
    });
    wc.on("page-title-updated", (_event: unknown, title: string) => {
      if (isCurrent()) this.update({ title });
    });
    wc.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, validatedURL: string, isMainFrame: boolean) => {
      if (!isCurrent() || !isMainFrame || errorCode === -3) return;
      this.update({ lifecycle: "failed", loading: false, readyState: "complete", progress: 1, ...(isSafeBrowserUrl(validatedURL, this.allowFileUrls) ? { url: validatedURL } : {}) });
      this.emitNonFatalError("navigation", String(errorCode), errorDescription || "Navigation failed", validatedURL || undefined);
    });
    wc.on("render-process-gone", (_event: unknown, details: { reason?: string; exitCode?: number }) => {
      if (!isCurrent() || this.replacing) return;
      this.contentReadyFailure = { contents, error: new BrowserSurfaceReadyError("invalid_state", "Browser renderer exited") };
      this.update({ lifecycle: "crashed", loading: false });
      this.emitNonFatalError("renderer", details?.reason ?? "crashed", "Browser renderer exited", this.stateValue.url);
      try {
        this.onCrash?.(this, contents, generation);
      } catch (error) {
        this.emitNonFatalError("renderer", "recovery_failed", failureMessage(error, "Browser renderer recovery failed"), this.stateValue.url);
      }
    });
  }

  private attach(): void {
    if (this.closed || this.attached || !this.view || !this.stateValue.visible) return;
    const contentView = (this.window as BrowserWindow & { contentView?: { addChildView(view: WebContentsView): void } }).contentView;
    if (!contentView) return;
    try {
      contentView.addChildView(this.view);
      // Mark the view attached immediately after addChildView succeeds. If
      // applying bounds fails while the window is closing, a later visibility
      // update must still treat detach as idempotent.
      this.attached = true;
      try { this.view.setBounds(copyBounds(this.stateValue.bounds)); } catch { /* window is closing */ }
    } catch {
      // A window can close between the visibility check and attachment.
    }
  }

  private detach(): void {
    if (!this.view || !this.attached) return;
    const view = this.view;
    const contentView = (this.window as BrowserWindow & { contentView?: { removeChildView(view: WebContentsView): void } }).contentView;
    try { contentView?.removeChildView(view); } catch { /* already detached */ }
    this.attached = false;
  }

  private closeView(): void {
    const view = this.view;
    if (!view) return;
    this.detach();
    try { view.webContents.close({ waitForBeforeUnload: false }); } catch { /* already closed */ }
    this.view = null;
    this.contentReadyContents = null;
    this.contentReadyFailure = null;
  }
  private applyZoom(): void {
    const contents = this.webContents;
    if (!contents || contents.isDestroyed()) return;
    try { contents.setZoomFactor(this.zoomFactor); } catch { /* before ready or closing */ }
  }

  getBounds(): BrowserBounds {
    return copyBounds(this.stateValue.bounds);
  }

  getViewport(): BrowserSurfaceViewport {
    return { width: this.viewportValue.width, height: this.viewportValue.height };
  }

  setViewport(viewport: BrowserSurfaceViewport): BrowserSurfaceViewport {
    const next = safeViewport(viewport);
    this.viewportValue = next;
    const contents = this.webContents as (WebContents & {
      enableDeviceEmulation?: (parameters: Record<string, unknown>) => void;
    }) | null;
    if (contents && !contents.isDestroyed() && typeof contents.enableDeviceEmulation === "function") {
      try {
        contents.enableDeviceEmulation({
          screenPosition: "desktop",
          screenSize: next,
          viewSize: next,
          deviceScaleFactor: 1,
          scale: 1,
        });
      } catch { /* before ready or closing */ }
    }
    return next;
  }

  resetViewport(): BrowserSurfaceViewport {
    this.viewportValue = { width: this.stateValue.bounds.width, height: this.stateValue.bounds.height };
    const contents = this.webContents as (WebContents & {
      disableDeviceEmulation?: () => void;
    }) | null;
    if (contents && !contents.isDestroyed() && typeof contents.disableDeviceEmulation === "function") {
      try { contents.disableDeviceEmulation(); } catch { /* before ready or closing */ }
    }
    return this.getViewport();
  }

  setZoomFactor(zoomFactor: number): number {
    this.zoomFactor = Math.max(0.25, Math.min(5, Number.isFinite(zoomFactor) ? zoomFactor : 1));
    this.applyZoom();
    return this.zoomFactor;
  }

  getZoomFactor(): number {
    const contents = this.webContents as (WebContents & {
      getZoomFactor?: () => number;
    }) | null;
    if (contents && !contents.isDestroyed() && typeof contents.getZoomFactor === "function") {
      try {
        const factor = contents.getZoomFactor();
        if (Number.isFinite(factor)) return factor;
      } catch { /* before ready or closing */ }
    }
    return this.zoomFactor;
  }

  isFocused(): boolean {
    const contents = this.webContents as (WebContents & {
      isFocused?: () => boolean;
    }) | null;
    if (!contents || contents.isDestroyed() || typeof contents.isFocused !== "function") return false;
    try { return contents.isFocused(); } catch { return false; }
  }
  async waitForContentReady(timeoutMs: number): Promise<void> {
    if (this.closed) throw new BrowserSurfaceReadyError("invalid_state", "Browser surface is closed");
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) throw new BrowserSurfaceReadyError("invalid_state", "Browser surface is unavailable");
    if (this.contentReadyContents === contents) {
      let loadingMainFrame = true;
      try { loadingMainFrame = contents.isLoadingMainFrame(); } catch { /* contents is closing */ }
      if (!loadingMainFrame) return;
    }
    const timeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0;
    if (timeout === 0) throw new BrowserSurfaceReadyError("timeout", "Browser content did not become ready before the timeout");
    type SurfaceEventListener = (...args: never[]) => void;
    const target = contents as WebContents & {
      on: (name: string, listener: SurfaceEventListener) => void;
      removeListener: (name: string, listener: SurfaceEventListener) => void;
    };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onFinish = (): void => {
        this.contentReadyContents = contents;
        this.contentReadyFailure = null;
        settleResolve();
      };
      const onPreloadError = (): void => settleReject(new BrowserSurfaceReadyError("internal", "Browser content preload failed"));
      const onRendererGone = (): void => settleReject(new BrowserSurfaceReadyError("invalid_state", "Browser renderer exited"));
      const onDestroyed = (): void => settleReject(new BrowserSurfaceReadyError("invalid_state", "Browser surface was destroyed"));
      const cleanup = (): void => {
        target.removeListener("did-finish-load", onFinish);
        target.removeListener("preload-error", onPreloadError);
        target.removeListener("render-process-gone", onRendererGone);
        target.removeListener("destroyed", onDestroyed);
        clearTimeout(timer);
      };
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (error: BrowserSurfaceReadyError): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      timer = setTimeout(() => settleReject(new BrowserSurfaceReadyError("timeout", "Browser content did not become ready before the timeout")), timeout);
      target.on("did-finish-load", onFinish);
      target.on("preload-error", onPreloadError);
      target.on("render-process-gone", onRendererGone);
      target.on("destroyed", onDestroyed);
      if (this.closed || contents.isDestroyed()) settleReject(new BrowserSurfaceReadyError("invalid_state", "Browser surface is unavailable"));
      else {
        const currentFailure = this.contentReadyFailure;
        if (currentFailure?.contents === contents) settleReject(currentFailure.error);
        else if (this.contentReadyContents === contents) {
          let loadingMainFrame = true;
          try { loadingMainFrame = contents.isLoadingMainFrame(); } catch { /* contents is closing */ }
          if (!loadingMainFrame) settleResolve();
        }
      }
    });
  }


  private async loadContents(url: string, contents: WebContents, generation: number): Promise<void> {
    if (!this.isCurrentContents(contents, generation)) return;
    this.update({ url, lifecycle: "loading", loading: true, readyState: "loading", progress: 0 });
    this.contentReadyContents = null;
    this.contentReadyFailure = null;
    try {
      await contents.loadURL(url);
    } catch (error) {
      if (this.isCurrentContents(contents, generation)) this.update({ lifecycle: "failed", loading: false, progress: 1 });
      throw error;
    }
  }

  async load(url: string): Promise<void> {
    if (this.closed) return;
    if (!isSafeBrowserUrl(url, this.allowFileUrls)) throw new Error("Unsafe browser URL");
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    await this.loadContents(url, contents, this.viewGeneration);
  }

  async navigate(url: string, snapshotAfter = false): Promise<BrowserSurfaceAction> {
    await this.load(url);
    return this.action(snapshotAfter);
  }

  /**
   * Electron rejects loadURL when a navigation becomes a download even though
   * the previous document remains usable. Restore that document's projected
   * state once the owning download controller confirms it accepted the item.
   */
  restoreAfterDownloadNavigation(previous: BrowserSurfaceState): BrowserSurfaceState {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) {
      this.contentReadyContents = contents;
      this.contentReadyFailure = null;
    }
    this.update({
      url: previous.url,
      title: previous.title,
      lifecycle: previous.lifecycle,
      readyState: previous.readyState,
      loading: previous.loading,
      progress: previous.progress,
      canGoBack: previous.canGoBack,
      canGoForward: previous.canGoForward,
    });
    return this.state;
  }

  async reload(snapshotAfter = false): Promise<BrowserSurfaceAction> {
    const contents = this.view?.webContents;
    this.contentReadyContents = null;
    this.contentReadyFailure = null;
    if (contents && !contents.isDestroyed()) contents.reload();
    return this.action(snapshotAfter);
  }

  async goBack(snapshotAfter = false): Promise<BrowserSurfaceAction> {
    const contents = this.view?.webContents;
    if (contents?.navigationHistory.canGoBack()) {
      this.contentReadyContents = null;
      this.contentReadyFailure = null;
      contents.navigationHistory.goBack();
    }
    return this.action(snapshotAfter);
  }

  async goForward(snapshotAfter = false): Promise<BrowserSurfaceAction> {
    const contents = this.view?.webContents;
    if (contents?.navigationHistory.canGoForward()) {
      this.contentReadyContents = null;
      this.contentReadyFailure = null;
      contents.navigationHistory.goForward();
    }
    return this.action(snapshotAfter);
  }

  async stop(snapshotAfter = false): Promise<BrowserSurfaceAction> {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.stop();
    this.update({ loading: false, progress: 1 });
    return this.action(snapshotAfter);
  }

  private async action(snapshotAfter: boolean): Promise<BrowserSurfaceAction> {
    return { surface: this.state, ...(snapshotAfter ? { postActionSnapshot: await this.snapshot() } : {}) };
  }

  setVisible(visible: boolean): BrowserSurfaceState {
    if (visible) {
      this.update({ visible: true });
      this.attach();
    } else {
      this.detach();
      const contents = this.view?.webContents as (WebContents & { blur?: () => void }) | null;
      try { contents?.blur?.(); } catch { /* closing */ }
      this.update({ visible: false, focused: "none" });
    }
    return this.state;
  }

  setBounds(bounds: BrowserBounds): BrowserSurfaceState {
    const next = safeBounds(bounds);
    this.update({ bounds: next });
    if (this.stateValue.visible) {
      try { this.view?.setBounds(copyBounds(next)); } catch { /* window is closing */ }
    }
    return this.state;
  }

  setMuted(muted: boolean): BrowserSurfaceState {
    const contents = this.view?.webContents;
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(muted);
    this.update({ muted });
    return this.state;
  }

  setFocused(focused: "address" | "webview" | "none"): BrowserSurfaceState {
    if (focused === "webview") {
      try { this.view?.webContents.focus(); } catch { /* closing */ }
    }
    this.update({ focused });
    return this.state;
  }

  async title(): Promise<{ title: string; url: string }> {
    const contents = this.view?.webContents;
    return { title: contents && !contents.isDestroyed() ? contents.getTitle() : this.stateValue.title, url: contents && !contents.isDestroyed() ? contents.getURL() || this.stateValue.url : this.stateValue.url };
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const contents = this.view?.webContents;
    let title = this.stateValue.title;
    let url = this.stateValue.url;
    let readyState: BrowserReadyState = this.stateValue.readyState;
    if (contents && !contents.isDestroyed()) {
      title = contents.getTitle();
      url = contents.getURL() || url;
      try {
        const metadata = await contents.executeJavaScript("({title:document.title,url:document.URL,readyState:document.readyState})", true) as { title?: unknown; url?: unknown; readyState?: unknown };
        if (typeof metadata.title === "string") title = metadata.title;
        if (typeof metadata.url === "string" && isSafeBrowserUrl(metadata.url, this.allowFileUrls)) url = metadata.url;
        if (typeof metadata.readyState === "string") readyState = stateReadyState(metadata.readyState);
      } catch { /* page may be gone */ }
    }
    return { surfaceId: this.surfaceId, handle: this.handle, url, title, readyState, viewport: copyBounds(this.stateValue.bounds), elements: [], capturedAt: Date.now() };
  }

  async evaluate(expression: string, args: readonly BrowserJsonValue[] = []): Promise<BrowserJsonValue> {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) throw new Error("Surface is unavailable");
    const serialized = JSON.stringify(args);
    const script = args.length > 0 ? `((${expression})).apply(null, ${serialized})` : `(${expression})`;
    return await contents.executeJavaScript(script, true) as BrowserJsonValue;
  }

  async replaceAfterCrash(expectedContents?: WebContents, expectedGeneration?: number): Promise<BrowserSurfaceAutomationAdapter | undefined> {
    if (
      this.closed
      || this.replacing
      || (expectedContents !== undefined && this.webContents !== expectedContents)
      || (expectedGeneration !== undefined && this.viewGeneration !== expectedGeneration)
    ) return undefined;
    this.replacing = true;
    try {
      const url = isSafeBrowserUrl(this.stateValue.url, this.allowFileUrls) ? this.stateValue.url : EMPTY_URL;
      const visible = this.stateValue.visible;
      this.closeView();
      this.update({ lifecycle: "creating", loading: true, readyState: "loading", progress: 0, url });
      this.createView();
      this.applyZoom();
      if (!visible) this.detach();
      return this.automationAdapter();
    } finally {
      this.replacing = false;
    }
  }

  setZoom(zoomFactor: number): BrowserSurfaceState {
    this.setZoomFactor(zoomFactor);
    return this.state;
  }

  canDiscard(): boolean {
    return !this.closed && !this.stateValue.visible && !this.stateValue.loading && this.stateValue.focused === "none";
  }

  discard(): boolean {
    if (!this.canDiscard()) return false;
    this.closeView();
    return true;
  }

  async restore(url?: string): Promise<void> {
    if (this.closed) throw new Error("Surface is closed");
    if (url !== undefined && !isSafeBrowserUrl(url, this.allowFileUrls)) throw new Error("Unsafe browser URL");
    if (!this.view) this.createView();
    if (url !== undefined) await this.load(url);
  }

  close(): BrowserSurfaceState {
    if (this.closed) return this.state;
    this.closed = true;
    this.closeView();
    this.stateValue = { ...this.stateValue, visible: false, loading: false, lifecycle: "closed", updatedAt: Date.now() };
    this.emitState();
    return this.state;
  }
}
