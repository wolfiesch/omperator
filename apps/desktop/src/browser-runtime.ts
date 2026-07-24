import { randomUUID } from "node:crypto";
import type { BrowserWindow, Session, WebContents } from "electron";
import {
  isBrowserOwnerSessionId,
  type BrowserCall,
  type BrowserCallResult,
  type BrowserErrorCode,
  type BrowserEvent,
  type BrowserJsonValue,
  type BrowserMethod,
  type BrowserProfile,
  type BrowserSurfaceState,
  type OwnerSessionId,
  type SurfaceHandle,
  type SurfaceId,
} from "@t4-code/protocol/browser-ipc";
import type { BrowserSessionMetadata } from "./browser-session-store.ts";
import { BrowserProfileRegistry, type BrowserProfileCreateOptions } from "./browser-profiles.ts";
import { BrowserSessionStore } from "./browser-session-store.ts";
import { BrowserDownloadController } from "./browser-downloads.ts";
import { installBrowserSurfaceSecurity, type BrowserSurfaceSecurityController, type BrowserSurfaceSecurityOptions } from "./browser-security.ts";
import { BrowserAutomationCoordinator } from "./browser-automation.ts";
import { BrowserCaptureCoordinator } from "./browser-capture.ts";
import { BrowserInputCoordinator } from "./browser-input.ts";
import { BrowserNetworkController } from "./browser-network.ts";
import { BrowserProfileAutomation, type BrowserCookieImportRequest, type BrowserProfileSelectionRequest } from "./browser-profile-automation.ts";
import { BrowserSurface, isSafeBrowserUrl, type BrowserSurfaceAction, type BrowserSurfaceAutomationAdapter } from "./browser-surface.ts";

export interface SessionStoreLike {
  readonly load?: () => readonly BrowserSessionMetadata[] | Promise<readonly BrowserSessionMetadata[]>;
  readonly save?: (value: unknown) => Promise<void> | void;
}

export interface ProfileRegistryLike {
  resolve?: (profileId?: string) => unknown;
  getSession?: (profile: BrowserProfile, ownerSessionId?: OwnerSessionId) => unknown;
  markInUse?: (profileId: string) => void;
  release?: (profileId: string) => void;
}
export interface DownloadControllerLike {
  attach?: (webContents: WebContents, surfaceId: SurfaceId, session: Session) => unknown;
  disposeSurface?: (surfaceId: SurfaceId) => unknown;
  list?: (surfaceId?: SurfaceId) => unknown;
  wait?: (downloadId: string, timeoutMs?: number) => Promise<unknown>;
  dispose?: () => unknown;
}
export interface SecurityInstallerLike {
  (options: BrowserSurfaceSecurityOptions): BrowserSurfaceSecurityController;
}

interface BrowserAutomationCoordinatorLike {
  call(call: BrowserCall): Promise<BrowserCallResult>;
  dispose(): void;
}

export interface BrowserRuntimeOptions {
  readonly window: BrowserWindow;
  readonly emit: (event: BrowserEvent) => void;
  readonly userDataPath: string;
  readonly profileRegistry?: ProfileRegistryLike;
  readonly sessionStore?: SessionStoreLike;
  readonly downloadController?: DownloadControllerLike;
  readonly installSecurity?: SecurityInstallerLike;
  readonly allowFileUrls?: boolean;
  readonly prewarmTtlMs?: number;
  /** Test seam for proving owner-scoped dispatch without a real Electron preload. */
  readonly automationCoordinator?: BrowserAutomationCoordinatorLike;
}

export class BrowserRuntimeError extends Error {
  readonly code: BrowserErrorCode;
  readonly method: BrowserMethod | undefined;
  readonly surfaceId: SurfaceId | undefined;

  constructor(code: BrowserErrorCode, message: string, method?: BrowserMethod, surfaceId?: SurfaceId) {
    super(message);
    this.name = "BrowserRuntimeError";
    this.code = code;
    this.method = method;
    this.surfaceId = surfaceId;
  }
}


interface BrowserRuntimeAutomationSurface extends BrowserSurfaceAutomationAdapter {}

type ProtocolCodedError = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly reason?: unknown;
  readonly surfaceId?: unknown;
};


function protocolError(error: unknown, method: BrowserMethod, surfaceId?: SurfaceId): BrowserRuntimeError | undefined {
  if (error instanceof BrowserRuntimeError) return error;
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as ProtocolCodedError;
  const code = candidate.code === "invalid_params" || candidate.code === "not_found" || candidate.code === "invalid_state" || candidate.code === "not_supported" || candidate.code === "timeout" || candidate.code === "security" || candidate.code === "internal" ? candidate.code : undefined;
  if (code === undefined) return undefined;
  const message = typeof candidate.message === "string" ? candidate.message : typeof candidate.reason === "string" ? candidate.reason : "Browser operation failed";
  const errorSurfaceId = typeof candidate.surfaceId === "string" ? candidate.surfaceId as SurfaceId : surfaceId;
  return new BrowserRuntimeError(code, message, method, errorSurfaceId);
}

function listedDownloads(
  controller: DownloadControllerLike,
  surfaceId: SurfaceId,
): readonly { readonly downloadId: string; readonly url?: string }[] {
  const value = controller.list?.(surfaceId);
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is { readonly downloadId: string; readonly url?: string } =>
      typeof entry === "object" &&
      entry !== null &&
      "downloadId" in entry &&
      typeof entry.downloadId === "string" &&
      (!("url" in entry) || entry.url === undefined || typeof entry.url === "string"),
  );
}

function matchesRequestedDownload(downloadUrl: string | undefined, requestedUrl: string): boolean {
  if (downloadUrl === undefined) return false;
  try {
    const download = new URL(downloadUrl);
    const requested = new URL(requestedUrl);
    // Electron may canonicalize or append a query before accepting the item.
    // The origin and resource path still identify the navigation; an
    // unrelated page-initiated download on the same surface does not.
    return download.origin === requested.origin && download.pathname === requested.pathname;
  } catch {
    return false;
  }
}

async function acceptedDownloadAfterNavigationFailure(
  controller: DownloadControllerLike,
  surfaceId: SurfaceId,
  existingDownloadIds: ReadonlySet<string>,
  requestedUrl: string,
  timeoutMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (
      listedDownloads(controller, surfaceId).some(
        (download) =>
          !existingDownloadIds.has(download.downloadId) &&
          matchesRequestedDownload(download.url, requestedUrl),
      )
    ) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(10, remaining)),
    );
  }
}

interface PrewarmEntry {
  readonly surface: BrowserSurface;
  readonly ownerSessionId: OwnerSessionId;
  readonly profileKey: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface RecoveryTarget {
  readonly surface: BrowserSurface;
  readonly contents: WebContents;
  readonly generation: number;
}

interface RecoveryEntry {
  readonly surfaceId: SurfaceId;
  target: RecoveryTarget;
  pending: RecoveryTarget | undefined;
}

function profileKey(profile: BrowserProfile): string {
  return profile.kind === "authenticated-profile" ? `authenticated:${profile.profileId}` : "isolated-session";
}


function surfaceIdFromRequest(request: unknown): SurfaceId {
  if (typeof request !== "object" || request === null || !("surfaceId" in request) || typeof request.surfaceId !== "string") {
    throw new BrowserRuntimeError("invalid_params", "surfaceId is required");
  }
  return request.surfaceId as SurfaceId;
}

function booleanOption(request: unknown, key: string): boolean {
  if (typeof request !== "object" || request === null || !(key in request)) return false;
  const value = (request as Record<string, unknown>)[key];
  return value === true;
}

function requestRecord(request: unknown): Record<string, unknown> {
  if (typeof request !== "object" || request === null || Array.isArray(request)) throw new BrowserRuntimeError("invalid_params", "Request must be an object");
  return request as Record<string, unknown>;
}

function ownerSessionIdFromCall(call: BrowserCall, method: BrowserMethod): OwnerSessionId {
  if (!isBrowserOwnerSessionId(call.ownerSessionId)) {
    throw new BrowserRuntimeError("invalid_params", "ownerSessionId is required", method);
  }
  return call.ownerSessionId;
}

/** Coordinates native surfaces so React chrome always has at most one attached tab. */
export class BrowserRuntime {

  private readonly window: BrowserWindow;
  private readonly emitEvent: (event: BrowserEvent) => void;
  private readonly userDataPath: string;
  private readonly profileRegistry: ProfileRegistryLike;
  private readonly sessionStore: SessionStoreLike;
  private readonly downloadController: DownloadControllerLike;
  private readonly installSecurity: SecurityInstallerLike;
  private readonly allowFileUrls: boolean;
  private readonly prewarmTtlMs: number;
  private readonly surfaces = new Map<SurfaceId, BrowserSurface>();
  private readonly surfaceOwners = new Map<SurfaceId, OwnerSessionId>();
  private readonly securityControllers = new Map<SurfaceId, BrowserSurfaceSecurityController>();
  private readonly orderedSurfaceIds: SurfaceId[] = [];
  private readonly prewarmEntries = new Map<OwnerSessionId, PrewarmEntry>();
  private readonly restoredOwners = new Set<OwnerSessionId>();
  private readonly restoringOwners = new Map<OwnerSessionId, Promise<readonly BrowserSurfaceState[]>>();
  private restoringSurfaceCount = 0;
  private readonly automationCoordinator: BrowserAutomationCoordinatorLike;
  private readonly captureCoordinator: BrowserCaptureCoordinator;
  private readonly inputCoordinator: BrowserInputCoordinator;
  private readonly profileAutomation: BrowserProfileAutomation;
  private readonly networkControllers = new Map<SurfaceId, BrowserNetworkController>();
  private nextSurfaceNumber = 1;
  private readonly activeSurfaceIds = new Map<OwnerSessionId, SurfaceId>();
  private disposed = false;
  private readonly recoveries = new Map<SurfaceId, RecoveryEntry>();

  constructor(options: BrowserRuntimeOptions) {
    this.window = options.window;
    this.emitEvent = options.emit;
    this.userDataPath = options.userDataPath;
    this.profileRegistry = options.profileRegistry ?? new BrowserProfileRegistry({ userDataPath: options.userDataPath });
    this.sessionStore = options.sessionStore ?? new BrowserSessionStore({ userDataPath: options.userDataPath });
    this.downloadController =
      options.downloadController ??
      new BrowserDownloadController({ emit: (event) => this.emit(event) });
    this.installSecurity = options.installSecurity ?? installBrowserSurfaceSecurity;
    this.allowFileUrls = options.allowFileUrls === true;
    this.prewarmTtlMs = Math.max(1_000, options.prewarmTtlMs ?? 30_000);
    this.automationCoordinator = options.automationCoordinator ?? new BrowserAutomationCoordinator({
      resolveSurface: (surfaceId) => {
        try {
          // Runtime calls resolve an owner-scoped adapter before they reach this coordinator.
          const surface = surfaceId === undefined ? undefined : this.surfaces.get(surfaceId as SurfaceId);
          if (!surface) return undefined;
          return this.automationAdapter(surface);
        } catch {
          return undefined;
        }
      },
      downloads: {
        wait: (downloadId, timeoutMs) => Promise.resolve(this.downloadController.wait?.(downloadId, timeoutMs) ?? undefined),
        list: (surfaceId) => {
          const listed = this.downloadController.list?.(surfaceId);
          return Array.isArray(listed) ? listed as readonly { readonly downloadId?: unknown }[] : [];
        },
      },
      emit: (event) => this.emit(event),
    });
    this.captureCoordinator = new BrowserCaptureCoordinator();

    this.inputCoordinator = new BrowserInputCoordinator();
    this.profileAutomation = new BrowserProfileAutomation({ registry: this.profileRegistry as BrowserProfileRegistry });
  }

  private emit(event: BrowserEvent): void {
    if (this.disposed) return;
    const surfaceId = event.type === "state"
      ? event.surface.surfaceId
      : event.type === "download"
        ? event.download.surfaceId
        : event.type === "console"
          ? event.console.surfaceId
          : event.error.surfaceId;
    const ownerSessionId = this.surfaceOwners.get(surfaceId);
    // Events without an explicit managed owner are never broadcast to a workspace.
    if (ownerSessionId === undefined) return;
    try {
      this.emitEvent({ ...event, ownerSessionId });
    } catch {
      // Browser event listeners are not allowed to terminate the desktop process.
    }
  }

  private reportNonFatal(surface: BrowserSurface, kind: "renderer" | "security", code: string, error: unknown, fallback: string): void {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
    try {
      this.emit({
        type: "error",
        error: {
          surfaceId: surface.surfaceId,
          kind,
          code: code.slice(0, 128),
          message: (message || fallback).slice(0, 1_024),
          url: surface.state.url,
          fatal: false,
          timestamp: Date.now(),
        },
      });
    } catch {
      // A browser error notification must not terminate the desktop process.
    }
  }

  private observeNonFatal(operation: () => unknown, surface: BrowserSurface, kind: "renderer" | "security", code: string, fallback: string): void {
    try {
      const result = operation();
      if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
        void Promise.resolve(result).catch((error: unknown) => this.reportNonFatal(surface, kind, code, error, fallback));
      }
    } catch (error) {
      this.reportNonFatal(surface, kind, code, error, fallback);
    }
  }

  private installSurfaceControllers(surface: BrowserSurface, contents: WebContents, session: Session): void {
    this.observeNonFatal(
      () => this.downloadController.attach?.(contents, surface.surfaceId, session),
      surface,
      "renderer",
      "download_attach_failed",
      "Browser download attachment failed",
    );
    try {
      const security = this.installSecurity({
        webContents: contents,
        session,
        profile: surface.profile,
        window: this.window,
        onPopup: (request) => {
          const ownerSessionId = this.surfaceOwners.get(surface.surfaceId);
          // A popup cannot inherit the one-time consent that created an
          // authenticated surface. Keep it blocked until the UI can ask again.
          if (surface.profile.kind === "authenticated-profile" || ownerSessionId === undefined || !isSafeBrowserUrl(request.url, this.allowFileUrls)) return false;
          this.createSurface(ownerSessionId, surface.profile, request.url, { x: 0, y: 0, width: 800, height: 600 }, false);
          return true;
        },
        onDownload: (request) => isSafeBrowserUrl(request.url, this.allowFileUrls),
      });
      this.securityControllers.set(surface.surfaceId, security);
    } catch (error) {
      this.reportNonFatal(surface, "security", "security_install_failed", error, "Browser security installation failed");
    }
    try {
      this.networkController(surface, "browser.network.requests");
    } catch (error) {
      this.reportNonFatal(surface, "security", "network_install_failed", error, "Browser network installation failed");
    }
  }

  private disposeSecurity(surface: BrowserSurface): void {
    const security = this.securityControllers.get(surface.surfaceId);
    this.securityControllers.delete(surface.surfaceId);
    if (!security) return;
    try {
      security.dispose();
    } catch (error) {
      this.reportNonFatal(surface, "security", "security_dispose_failed", error, "Browser security disposal failed");
    }
  }

  private async disposeNetwork(surface: BrowserSurface, network: BrowserNetworkController): Promise<void> {
    try {
      await network.dispose();
    } catch (error) {
      this.reportNonFatal(surface, "security", "network_dispose_failed", error, "Browser network disposal failed");
    }
  }

  private persistInBackground(surface: BrowserSurface): void {
    void this.persist().catch((error: unknown) => this.reportNonFatal(surface, "renderer", "session_persist_failed", error, "Browser session persistence failed"));
  }

  private isRecoveryCurrent(target: RecoveryTarget): boolean {
    const { surface, contents, generation } = target;
    return !this.disposed
      && this.surfaces.get(surface.surfaceId) === surface
      && surface.webContents === contents
      && surface.generation === generation;
  }

  private sameRecoveryTarget(left: RecoveryTarget, right: RecoveryTarget): boolean {
    return left.surface === right.surface
      && left.contents === right.contents
      && left.generation === right.generation;
  }

  private takePendingRecovery(entry: RecoveryEntry): RecoveryTarget | undefined {
    const pending = entry.pending;
    entry.pending = undefined;
    return pending;
  }

  private scheduleSurfaceRecovery(surface: BrowserSurface, contents: WebContents, generation: number): void {
    const target: RecoveryTarget = { surface, contents, generation };
    if (!this.isRecoveryCurrent(target)) return;
    const existing = this.recoveries.get(surface.surfaceId);
    if (existing) {
      if (this.sameRecoveryTarget(existing.target, target)
        || (existing.pending !== undefined && this.sameRecoveryTarget(existing.pending, target))) return;
      existing.pending = target;
      return;
    }
    const entry: RecoveryEntry = { surfaceId: surface.surfaceId, target, pending: undefined };
    this.recoveries.set(surface.surfaceId, entry);
    void this.runRecovery(entry).catch((error: unknown) => this.reportNonFatal(surface, "renderer", "recovery_failed", error, "Browser renderer recovery failed"));
  }

  private async runRecovery(entry: RecoveryEntry): Promise<void> {
    let target: RecoveryTarget = entry.target;
    try {
      while (true) {
        entry.pending = undefined;
        await this.recoverSurface(target);
        const pending = this.takePendingRecovery(entry);
        if (pending === undefined) return;
        entry.target = pending;
        target = pending;
      }
    } finally {
      if (this.recoveries.get(entry.surfaceId) === entry) this.recoveries.delete(entry.surfaceId);
    }
  }

  private lookup(surfaceId: SurfaceId, ownerSessionId: OwnerSessionId, method?: BrowserMethod): BrowserSurface {
    const surface = this.surfaces.get(surfaceId);
    if (!surface || this.surfaceOwners.get(surfaceId) !== ownerSessionId) {
      throw new BrowserRuntimeError("not_found", `Unknown browser surface ${surfaceId}`, method, surfaceId);
    }
    return surface;
  }

  private activeSurface(ownerSessionId: OwnerSessionId, method?: BrowserMethod): BrowserSurface {
    const active = this.activeSurfaceIds.get(ownerSessionId);
    const id = active !== undefined && this.surfaceOwners.get(active) === ownerSessionId
      ? active
      : [...this.orderedSurfaceIds].reverse().find((surfaceId) => this.surfaceOwners.get(surfaceId) === ownerSessionId);
    if (!id) throw new BrowserRuntimeError("not_found", "No browser surface is open", method);
    return this.lookup(id, ownerSessionId, method);
  }

  private surfaceStates(ownerSessionId: OwnerSessionId): readonly BrowserSurfaceState[] {
    return this.orderedSurfaceIds
      .filter((surfaceId) => this.surfaceOwners.get(surfaceId) === ownerSessionId)
      .map((surfaceId) => this.surfaces.get(surfaceId)?.state)
      .filter((state): state is BrowserSurfaceState => state !== undefined);
  }

  private automationAdapter(surface: BrowserSurface, method?: BrowserMethod): BrowserRuntimeAutomationSurface {
    const candidate = (surface as unknown as { automationAdapter?: () => unknown }).automationAdapter;
    if (typeof candidate !== "function") throw new BrowserRuntimeError("not_supported", "Browser surface automation is unavailable", method, surface.surfaceId);
    try {
      const adapter = candidate.call(surface);
      if (typeof adapter !== "object" || adapter === null) throw new BrowserRuntimeError("not_supported", "Browser surface automation is unavailable", method, surface.surfaceId);
      const result = adapter as BrowserRuntimeAutomationSurface;
      const contents = result.webContents;
      if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) {
        throw new BrowserRuntimeError("not_found", "Browser surface has no live webContents", method, surface.surfaceId);
      }
      return result;
    } catch (error) {
      if (error instanceof BrowserRuntimeError) throw error;
      throw new BrowserRuntimeError("not_found", "Browser surface has no live webContents", method, surface.surfaceId);
    }
  }

  private networkController(surface: BrowserSurface, method: BrowserMethod): BrowserNetworkController {
    const existing = this.networkControllers.get(surface.surfaceId);
    if (existing) return existing;
    const adapter = this.automationAdapter(surface, method);
    const session = adapter.browserSession ?? adapter.session;
    if (!session) throw new BrowserRuntimeError("not_supported", "Browser surface session is unavailable", method, surface.surfaceId);
    const controller = new BrowserNetworkController({ session, webContents: adapter.webContents });
    this.networkControllers.set(surface.surfaceId, controller);
    return controller;
  }

  private targetSurface(request: Record<string, unknown>, ownerSessionId: OwnerSessionId, method: BrowserMethod): BrowserSurface {
    return typeof request.surfaceId === "string"
      ? this.lookup(request.surfaceId as SurfaceId, ownerSessionId, method)
      : this.activeSurface(ownerSessionId, method);
  }

  private unwrapControllerResult(result: unknown, method: BrowserMethod, surfaceId?: SurfaceId): unknown {
    if (typeof result !== "object" || result === null || !("ok" in result)) return result;
    const candidate = result as { readonly ok?: unknown; readonly value?: unknown; readonly code?: unknown; readonly message?: unknown; readonly reason?: unknown };
    if (candidate.ok === true) return candidate.value;
    const error = protocolError(candidate, method, surfaceId);
    if (error) throw error ?? new BrowserRuntimeError("internal", "Browser operation failed", method, surfaceId);
    throw new BrowserRuntimeError("internal", "Browser operation failed", method, surfaceId);
  }

  private resolveProfile(profile: unknown): BrowserProfile {
    if (typeof profile !== "object" || profile === null || !("kind" in profile) || !("profileId" in profile) || typeof profile.kind !== "string" || typeof profile.profileId !== "string") {
      throw new BrowserRuntimeError("invalid_params", "An explicit browser profile is required");
    }
    if (profile.kind === "isolated-session" && profile.profileId === "isolated-session") return { kind: "isolated-session", profileId: "isolated-session" };
    if (profile.kind !== "authenticated-profile" || profile.profileId.length === 0 || (profile as { explicitOptIn?: unknown }).explicitOptIn !== true) {
      throw new BrowserRuntimeError("security", "Authenticated profiles require explicit opt-in and an exact profileId");
    }
    const selected = { kind: "authenticated-profile", profileId: profile.profileId, explicitOptIn: true } as const;
    const resolved = this.profileRegistry.resolve?.(selected.profileId);
    if (this.profileRegistry.resolve && resolved === undefined) {
      throw new BrowserRuntimeError("security", "Authenticated profile was not found");
    }
    if (resolved && typeof resolved === "object" && "profileId" in resolved && resolved.profileId !== selected.profileId) {
      throw new BrowserRuntimeError("security", "Authenticated profile selection was not exact");
    }
    return selected;
  }

  private resolveSession(profile: BrowserProfile, ownerSessionId: OwnerSessionId): Session {
    const candidate = this.profileRegistry?.getSession?.(
      profile,
      profile.kind === "isolated-session" ? ownerSessionId : undefined,
    );
    if (profile.kind === "isolated-session" && candidate && typeof candidate === "object" && !("then" in candidate)) {
      return candidate as Session;
    }
    if (profile.kind === "isolated-session") throw new BrowserRuntimeError("security", "An isolated browser session could not be created");
    if (candidate && typeof candidate === "object" && !("then" in candidate)) return candidate as Session;
    throw new BrowserRuntimeError("security", "An authenticated browser session could not be created");
  }

  private createSurface(
    ownerSessionId: OwnerSessionId,
    profile: BrowserProfile,
    url: string,
    bounds: { x: number; y: number; width: number; height: number },
    visible: boolean,
    identity?: Pick<BrowserSessionMetadata, "surfaceId" | "handle">,
  ): BrowserSurface {
    const surfaceId = identity?.surfaceId ?? randomUUID() as SurfaceId;
    const handle = identity?.handle ?? `surface:${this.nextSurfaceNumber++}` as SurfaceHandle;
    const handleNumber = Number(handle.slice("surface:".length));
    if (Number.isSafeInteger(handleNumber)) this.nextSurfaceNumber = Math.max(this.nextSurfaceNumber, handleNumber + 1);
    const session = this.resolveSession(profile, ownerSessionId);
    const surface = new BrowserSurface({
      window: this.window,
      surfaceId,
      handle,
      profile,
      session,
      url,
      bounds,
      visible,
      allowFileUrls: this.allowFileUrls,
      emit: (event) => this.emit(event),
      onCrash: (crashed, contents, generation) => this.scheduleSurfaceRecovery(crashed, contents, generation),
    });
    this.surfaces.set(surfaceId, surface);
    this.surfaceOwners.set(surfaceId, ownerSessionId);
    this.orderedSurfaceIds.push(surfaceId);
    this.profileRegistry.markInUse?.(profile.profileId);
    const contents = surface.webContents;
    if (contents) this.installSurfaceControllers(surface, contents, session);
    if (this.restoringSurfaceCount === 0) this.persistInBackground(surface);
    return surface;
  }

  private async recoverSurface(target: RecoveryTarget): Promise<void> {
    const { surface, contents, generation } = target;
    if (!this.isRecoveryCurrent(target)) return;
    this.disposeSecurity(surface);
    const network = this.networkControllers.get(surface.surfaceId);
    this.networkControllers.delete(surface.surfaceId);
    if (network) await this.disposeNetwork(surface, network);
    if (!this.isRecoveryCurrent(target)) return;
    const adapter = await surface.replaceAfterCrash(contents, generation);
    if (!adapter) return;
    const recoveredTarget: RecoveryTarget = {
      surface,
      contents: adapter.webContents,
      generation: surface.generation,
    };
    if (!this.isRecoveryCurrent(recoveredTarget)) return;
    const ownerSessionId = this.surfaceOwners.get(surface.surfaceId);
    if (ownerSessionId === undefined) return;
    const session = this.resolveSession(surface.profile, ownerSessionId);
    this.installSurfaceControllers(surface, adapter.webContents, session);
  }

  private async persist(): Promise<void> {
    const save = this.sessionStore.save;
    if (!save) return;
    const metadata: BrowserSessionMetadata[] = [];
    for (const [order, id] of this.orderedSurfaceIds.entries()) {
      const surface = this.surfaces.get(id);
      if (!surface) continue;
      const ownerSessionId = this.surfaceOwners.get(id);
      if (ownerSessionId === undefined) continue;
      // Authenticated pages require fresh, explicit user selection after an
      // app restart. Do not persist their URL as an auto-load instruction.
      if (surface.profile.kind === "authenticated-profile") continue;
      metadata.push({ surfaceId: id, handle: surface.handle, ownerSessionId, profile: surface.state.profile, url: surface.state.url, order, zoom: 1 });
    }
    await Promise.resolve(save.call(this.sessionStore, metadata));
  }

  /** Restores only records that explicitly belong to this durable workspace session. */
  async restore(ownerSessionId: OwnerSessionId): Promise<readonly BrowserSurfaceState[]> {
    if (this.restoredOwners.has(ownerSessionId)) return this.surfaceStates(ownerSessionId);
    const inFlight = this.restoringOwners.get(ownerSessionId);
    if (inFlight) return inFlight;
    const operation = (async (): Promise<readonly BrowserSurfaceState[]> => {
      const load = this.sessionStore.load;
      const records = load === undefined ? [] : await Promise.resolve(load.call(this.sessionStore));
      this.restoringSurfaceCount += 1;
      try {
        if (Array.isArray(records)) {
          for (const record of [...records].sort((left, right) => left.order - right.order)) {
            if (record.ownerSessionId !== ownerSessionId || this.surfaces.has(record.surfaceId)) continue;
            // A stored opt-in is not fresh consent. Old authenticated records
            // are ignored without loading their URL or touching the profile.
            if (record.profile.kind === "authenticated-profile") continue;
            try {
              const profile = this.resolveProfile(record.profile);
              this.createSurface(ownerSessionId, profile, record.url, { x: 0, y: 0, width: 800, height: 600 }, false, record);
            } catch {
              // A deleted profile or malformed legacy record must not fall back to another owner.
            }
          }
        }
      } finally {
        this.restoringSurfaceCount -= 1;
      }
      this.restoredOwners.add(ownerSessionId);
      return this.surfaceStates(ownerSessionId);
    })();
    this.restoringOwners.set(ownerSessionId, operation);
    try {
      return await operation;
    } finally {
      this.restoringOwners.delete(ownerSessionId);
    }
  }

  private async activate(surface: BrowserSurface, ownerSessionId: OwnerSessionId): Promise<void> {
    for (const candidate of this.surfaces.values()) {
      if (candidate.surfaceId !== surface.surfaceId) candidate.setVisible(false);
    }
    surface.setVisible(true);
    this.activeSurfaceIds.set(ownerSessionId, surface.surfaceId);
    try {
      await this.persist();
    } catch (error) {
      this.reportNonFatal(surface, "renderer", "session_persist_failed", error, "Browser session persistence failed");
    }
  }

  async prewarm(ownerSessionId: OwnerSessionId, profile: BrowserProfile, url = "about:blank"): Promise<BrowserSurfaceState> {
    if (this.disposed) throw new BrowserRuntimeError("invalid_state", "Browser runtime is disposed");
    await this.restore(ownerSessionId);
    const resolved = this.resolveProfile(profile);
    if (!isSafeBrowserUrl(url, this.allowFileUrls)) throw new BrowserRuntimeError("security", "Unsafe browser URL");
    const existing = this.prewarmEntries.get(ownerSessionId);
    if (existing && existing.profileKey === profileKey(resolved)) return existing.surface.state;
    this.clearPrewarm(ownerSessionId);
    const surface = this.createSurface(ownerSessionId, resolved, url, { x: 0, y: 0, width: 800, height: 600 }, false);
    const timer = setTimeout(() => {
      if (this.prewarmEntries.get(ownerSessionId)?.surface.surfaceId === surface.surfaceId) this.clearPrewarm(ownerSessionId);
    }, this.prewarmTtlMs);
    this.prewarmEntries.set(ownerSessionId, { surface, ownerSessionId, profileKey: profileKey(resolved), timer });
    return surface.state;
  }

  private clearPrewarm(ownerSessionId: OwnerSessionId): void {
    const entry = this.prewarmEntries.get(ownerSessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.prewarmEntries.delete(ownerSessionId);
    const existing = this.surfaces.get(entry.surface.surfaceId);
    if (existing) this.removeSurface(existing);
  }

  private removeSurface(surface: BrowserSurface): BrowserSurfaceState {
    this.disposeSecurity(surface);
    const network = this.networkControllers.get(surface.surfaceId);
    this.networkControllers.delete(surface.surfaceId);
    if (network) {
      void this.disposeNetwork(surface, network).catch((error: unknown) => this.reportNonFatal(surface, "security", "network_dispose_failed", error, "Browser network disposal failed"));
    }
    const state = surface.close();
    this.observeNonFatal(
      () => this.downloadController.disposeSurface?.(surface.surfaceId),
      surface,
      "renderer",
      "download_dispose_failed",
      "Browser download disposal failed",
    );
    const index = this.orderedSurfaceIds.indexOf(surface.surfaceId);
    if (index >= 0) this.orderedSurfaceIds.splice(index, 1);
    this.surfaces.delete(surface.surfaceId);
    const ownerSessionId = this.surfaceOwners.get(surface.surfaceId);
    this.surfaceOwners.delete(surface.surfaceId);
    this.profileRegistry.release?.(surface.profile.profileId);
    if (ownerSessionId !== undefined && this.activeSurfaceIds.get(ownerSessionId) === surface.surfaceId) {
      const next = [...this.orderedSurfaceIds].reverse().find((surfaceId) => this.surfaceOwners.get(surfaceId) === ownerSessionId);
      if (next === undefined) this.activeSurfaceIds.delete(ownerSessionId);
      else this.activeSurfaceIds.set(ownerSessionId, next);
    }
    this.persistInBackground(surface);
    return state;
  }
  async call(call: BrowserCall): Promise<BrowserCallResult> {
    const method = call.method;
    try {
    if (this.disposed) throw new BrowserRuntimeError("invalid_state", "Browser runtime is disposed", method);
    const ownerSessionId = ownerSessionIdFromCall(call, method);
    await this.restore(ownerSessionId);
    const request = requestRecord(call.request);
    switch (method) {
      case "browser.profiles.list":
        return { profiles: this.unwrapControllerResult(this.profileAutomation.list(), method) };
      case "browser.profiles.create": {
        const profileOptions: BrowserProfileCreateOptions = {
          ...(typeof request.profileId === "string" ? { profileId: request.profileId } : {}),
          ...(typeof request.label === "string" ? { label: request.label } : {}),
        };
        return this.unwrapControllerResult(this.profileAutomation.create(profileOptions), method) as BrowserCallResult;
      }
      case "browser.profiles.rename":
        return this.unwrapControllerResult(this.profileAutomation.rename(
          typeof request.profileId === "string" ? request.profileId : "",
          typeof request.label === "string" ? request.label : "",
        ), method) as BrowserCallResult;
      case "browser.profiles.clear":
        return this.unwrapControllerResult(this.profileAutomation.clear(request as unknown as BrowserProfileSelectionRequest), method) as BrowserCallResult;
      case "browser.profiles.delete":
        return this.unwrapControllerResult(this.profileAutomation.delete(request as unknown as BrowserProfileSelectionRequest), method) as BrowserCallResult;
      case "browser.import.cookies":
        return this.unwrapControllerResult(this.profileAutomation.importCookies(request as unknown as BrowserCookieImportRequest), method) as BrowserCallResult;
      case "surface.create": {
        const profile = this.resolveProfile(request.profile);
        const url = request.url === undefined ? "about:blank" : request.url;
        if (typeof url !== "string" || !isSafeBrowserUrl(url, this.allowFileUrls)) throw new BrowserRuntimeError("security", "Unsafe browser URL", method);
        const bounds = typeof request.bounds === "object" && request.bounds !== null ? request.bounds as { x: number; y: number; width: number; height: number } : { x: 0, y: 0, width: 800, height: 600 };
        const visible = request.visible !== false;
        let surface: BrowserSurface;
        const entry = this.prewarmEntries.get(ownerSessionId);
        if (entry && entry.profileKey === profileKey(profile) && entry.surface.state.url === url) {
          surface = entry.surface;
          this.prewarmEntries.delete(ownerSessionId);
          clearTimeout(entry.timer);
          surface.setBounds(bounds);
          if (visible) await this.activate(surface, ownerSessionId);
        } else {
          if (entry) this.clearPrewarm(ownerSessionId);
          surface = this.createSurface(ownerSessionId, profile, url, bounds, false);
          if (visible) await this.activate(surface, ownerSessionId);
        }
        return { surface: surface.state, ...(booleanOption(request, "snapshotAfter") ? { snapshot: await surface.snapshot() } : {}) };
      }
      case "surface.list":
        return { surfaces: this.surfaceStates(ownerSessionId) };
      case "surface.get": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: surface.state };
      }
      case "surface.close": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: this.removeSurface(surface) };
      }
      case "surface.navigate": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        if (typeof request.url !== "string") throw new BrowserRuntimeError("invalid_params", "url is required", method, surface.surfaceId);
        const previous = surface.state;
        const existingDownloadIds = new Set(
          listedDownloads(this.downloadController, surface.surfaceId).map(
            (download) => download.downloadId,
          ),
        );
        try {
          return await surface.navigate(
            request.url,
            booleanOption(request, "snapshotAfter"),
          );
        } catch (error) {
          const acceptedDownload = await acceptedDownloadAfterNavigationFailure(
            this.downloadController,
            surface.surfaceId,
            existingDownloadIds,
            request.url,
          );
          if (!acceptedDownload) throw error;
          const restored = surface.restoreAfterDownloadNavigation(previous);
          return {
            surface: restored,
            ...(booleanOption(request, "snapshotAfter")
              ? { snapshot: await surface.snapshot() }
              : {}),
          };
        }
      }
      case "surface.reload": return this.actionFor(ownerSessionId, method, request, (surface) => surface.reload(booleanOption(request, "snapshotAfter")));
      case "surface.goBack": return this.actionFor(ownerSessionId, method, request, (surface) => surface.goBack(booleanOption(request, "snapshotAfter")));
      case "surface.goForward": return this.actionFor(ownerSessionId, method, request, (surface) => surface.goForward(booleanOption(request, "snapshotAfter")));
      case "surface.stop": return this.actionFor(ownerSessionId, method, request, (surface) => surface.stop(booleanOption(request, "snapshotAfter")));
      case "surface.snapshot": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { snapshot: await surface.snapshot() };
      }
      case "surface.screenshot": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return this.captureCoordinator.call(method, request, this.automationAdapter(surface, method));
      }
      case "surface.title": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return await surface.title();
      }
      case "surface.evaluate": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        if (typeof request.expression !== "string") throw new BrowserRuntimeError("invalid_params", "expression is required", method, surface.surfaceId);
        const args = Array.isArray(request.args) ? request.args as readonly BrowserJsonValue[] : [];
        return { value: await surface.evaluate(request.expression, args) };
      }
      case "surface.setBounds": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        if (typeof request.bounds !== "object" || request.bounds === null) throw new BrowserRuntimeError("invalid_params", "bounds is required", method, surface.surfaceId);
        const visible = typeof request.visible === "boolean" ? request.visible : undefined;
        surface.setBounds(request.bounds as { x: number; y: number; width: number; height: number });
        if (visible === true) {
          await this.activate(surface, ownerSessionId);
        } else if (visible === false) {
          surface.setVisible(false);
        }
        return { surface: surface.state };
      }
      case "surface.setMuted": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: surface.setMuted(request.muted === true) };
      }
      case "surface.setOmnibarVisible": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: surface.state };
      }
      case "surface.focusAddressBar": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: surface.setFocused("address") };
      }
      case "surface.focusWebView": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        await this.activate(surface, ownerSessionId);
        return { surface: surface.setFocused("webview") };
      }
      case "surface.restore": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        await surface.restore(typeof request.url === "string" ? request.url : undefined);
        return { surface: surface.state };
      }
      case "surface.downloads": {
        const surfaceId = surfaceIdFromRequest(request);
        this.lookup(surfaceId, ownerSessionId, method);
        return { downloads: await Promise.resolve(this.downloadController?.list?.(surfaceId) ?? []) };
      }
      case "browser.snapshot":
      case "browser.eval":
      case "browser.wait":
      case "browser.click":
      case "browser.dblclick":
      case "browser.hover":
      case "browser.focus":
      case "browser.type":
      case "browser.fill":
      case "browser.press":
      case "browser.keydown":
      case "browser.keyup":
      case "browser.check":
      case "browser.uncheck":
      case "browser.select":
      case "browser.scroll":
      case "browser.scroll_into_view":
      case "browser.get.text":
      case "browser.get.html":
      case "browser.get.value":
      case "browser.get.attr":
      case "browser.get.count":
      case "browser.get.box":
      case "browser.get.styles":
      case "browser.get.title":
      case "browser.is.visible":
      case "browser.is.enabled":
      case "browser.is.checked":
      case "browser.find.role":
      case "browser.find.text":
      case "browser.find.label":
      case "browser.find.placeholder":
      case "browser.find.testid":
      case "browser.find.first":
      case "browser.find.last":
      case "browser.find.nth":
      case "browser.highlight":
      case "browser.frame.select":
      case "browser.frame.main":
      case "browser.cookies.get":
      case "browser.cookies.set":
      case "browser.cookies.clear":
      case "browser.storage.get":
      case "browser.storage.set":
      case "browser.storage.clear":
      case "browser.design_mode.set":
      case "browser.design_mode.status":
      case "browser.console.list":
      case "browser.console.clear":
      case "browser.console.show":
      case "browser.errors.list":
      case "browser.state.save":
      case "browser.state.load":
      case "browser.addinitscript":
      case "browser.addscript":
      case "browser.addstyle": {
        const surface = this.targetSurface(request, ownerSessionId, method);
        this.automationAdapter(surface, method);
        const scopedCall: BrowserCall = {
          ...call,
          request: { ...request, surfaceId: surface.surfaceId } as BrowserCall["request"],
        };
        return this.automationCoordinator.call(scopedCall);
      }
      case "browser.download.wait": {
        const surfaceId = surfaceIdFromRequest(request);
        this.lookup(surfaceId, ownerSessionId, method);
        const downloadId = typeof request.downloadId === "string" ? request.downloadId : "";
        const downloads = this.downloadController.list?.(surfaceId);
        if (!downloadId || !Array.isArray(downloads) || !downloads.some((download) => download !== null && typeof download === "object" && "downloadId" in download && download.downloadId === downloadId)) {
          throw new BrowserRuntimeError("not_found", "Download is not owned by this browser surface", method, surfaceId);
        }
        return this.automationCoordinator.call(call);
      }
      case "browser.screenshot":
      case "browser.viewport.set":
      case "browser.zoom.set":
      case "browser.is_webview_focused":
      case "browser.screencast.start":
      case "browser.screencast.stop":
      case "browser.trace.start":
      case "browser.trace.stop": {
        const surface = this.targetSurface(request, ownerSessionId, method);
        return this.captureCoordinator.call(method, request, this.automationAdapter(surface, method));
      }
      case "browser.focus_webview": {
        const surface = this.targetSurface(request, ownerSessionId, method);
        await this.activate(surface, ownerSessionId);
        return this.captureCoordinator.call(method, request, this.automationAdapter(surface, method));
      }
      case "browser.input_mouse":
      case "browser.input_keyboard":
      case "browser.input_touch": {
        const surface = this.targetSurface(request, ownerSessionId, method);
        return this.inputCoordinator.call(method, request, this.automationAdapter(surface, method));
      }
      case "browser.offline.set":
      case "browser.geolocation.set":
      case "browser.network.route":
      case "browser.network.unroute":
      case "browser.network.requests": {
        const surface = this.targetSurface(request, ownerSessionId, method);
        const network = this.networkController(surface, method);
        let result: unknown;
        if (method === "browser.offline.set") result = network.setOffline(request as never);
        else if (method === "browser.geolocation.set") result = network.setGeolocation(request);
        else if (method === "browser.network.route") result = network.route(request as never);
        else if (method === "browser.network.unroute") result = network.unroute(typeof request.routeId === "string" ? request.routeId : "");
        else result = network.listRequests(request as never);
        return this.unwrapControllerResult(result, method, surface.surfaceId) as BrowserCallResult;
      }
      case "browser.navigate": {
        const surface = this.activeSurface(ownerSessionId, method);
        if (typeof request.url !== "string") throw new BrowserRuntimeError("invalid_params", "url is required", method, surface.surfaceId);
        return surface.navigate(request.url, booleanOption(request, "snapshotAfter"));
      }
      case "browser.back": return this.activeSurface(ownerSessionId, method).goBack(booleanOption(request, "snapshotAfter"));
      case "browser.forward": return this.activeSurface(ownerSessionId, method).goForward(booleanOption(request, "snapshotAfter"));
      case "browser.reload": return this.activeSurface(ownerSessionId, method).reload(booleanOption(request, "snapshotAfter"));
      case "browser.url.get": {
        const surface = this.activeSurface(ownerSessionId, method);
        return surface.title();
      }
      case "browser.tab.list":
        return { surfaces: this.surfaceStates(ownerSessionId) };
      case "browser.tab.switch": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        await this.activate(surface, ownerSessionId);
        return { surface: surface.state };
      }
      case "browser.tab.close": {
        const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
        return { surface: this.removeSurface(surface) };
      }
      default:
        throw new BrowserRuntimeError("not_supported", `Browser method ${method} is not supported`, method);
    }
    } catch (error) {
      const coded = protocolError(error, method);
      if (coded) throw coded;
      throw error;
    }
  }

  private async actionFor(ownerSessionId: OwnerSessionId, method: BrowserMethod, request: Record<string, unknown>, action: (surface: BrowserSurface) => Promise<BrowserSurfaceAction>): Promise<BrowserSurfaceAction> {
    const surface = this.lookup(surfaceIdFromRequest(request), ownerSessionId, method);
    return action(surface);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const ownerSessionId of this.prewarmEntries.keys()) this.clearPrewarm(ownerSessionId);
    let reportingSurface: BrowserSurface | undefined;
    try {
      await this.persist();
    } catch (error) {
      reportingSurface = this.surfaces.values().next().value as BrowserSurface | undefined;
      if (reportingSurface) this.reportNonFatal(reportingSurface, "renderer", "session_persist_failed", error, "Browser session persistence failed");
    }
    for (const surface of this.surfaces.values()) {
      reportingSurface = surface;
      this.disposeSecurity(surface);
      const network = this.networkControllers.get(surface.surfaceId);
      this.networkControllers.delete(surface.surfaceId);
      if (network) await this.disposeNetwork(surface, network);
      surface.close();
      this.observeNonFatal(
        () => this.downloadController.disposeSurface?.(surface.surfaceId),
        surface,
        "renderer",
        "download_dispose_failed",
        "Browser download disposal failed",
      );
      this.profileRegistry.release?.(surface.profile.profileId);
    }
    this.networkControllers.clear();
    this.surfaces.clear();
    this.surfaceOwners.clear();
    this.orderedSurfaceIds.length = 0;
    this.activeSurfaceIds.clear();
    this.restoredOwners.clear();
    this.recoveries.clear();
    this.automationCoordinator.dispose();
    this.captureCoordinator.dispose();
    this.inputCoordinator.dispose();
    this.profileAutomation.dispose();
    try {
      await Promise.resolve(this.downloadController.dispose?.());
    } catch (error) {
      if (reportingSurface) this.reportNonFatal(reportingSurface, "renderer", "download_dispose_failed", error, "Browser download disposal failed");
    } finally {
      this.disposed = true;
    }
  }
}
