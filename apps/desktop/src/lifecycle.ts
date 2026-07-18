import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CursorStore } from "@t4-code/client";
import { parsePairDeepLink, PendingPairQueue, type PendingPair } from "@t4-code/protocol";
import { decodeLocalProfileId, type ServiceAvailabilityIssue } from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import type { RemoteTargetRegistry } from "./remote-runtime/registry.ts";
import { createDesktopWindow, type DesktopWindowHandle } from "./window.ts";
import { DesktopIpcRegistry, runtimeError, type IpcRuntime } from "./ipc.ts";
import { ElectronCursorStore, ElectronRemoteTargetStore, ElectronCredentialCiphertextStore, ElectronLocalProfileStore, ElectronProjectionCacheStore, electronSafeStorage, loadDeviceIdentity, type DeviceIdentity } from "./stores.ts";
import { VersionedRemoteTargetRegistry, DeviceCredentialStore } from "./remote-runtime/index.ts";
import { LocalTargetManager, type TargetManagerOptions } from "./target-manager.ts";
import { createAppserverServiceManager, discoverOmpExecutable, OmpAppserverCompatibilityError, probeOmpAppserver, NodeServiceFileSystem } from "./service.ts";
import { createDesktopSpeechService, type DesktopSpeechService } from "./speech.ts";
import { createElectronUpdateController } from "./electron-update-controller.ts";
import { installApplicationMenu, type ApplicationMenuOptions } from "./menu.ts";
import { DesktopUpdateController } from "./update-controller.ts";
import { LocalProfileRegistry } from "./local-profiles.ts";
import { LocalProfileRuntime } from "./profile-runtime.ts";

type ProjectionCacheRuntime = NonNullable<IpcRuntime["projectionCache"]>;

export function appserverLogsDirectory(
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  profileId = "default",
): string {
  const profile = decodeLocalProfileId(profileId);
  const base = platform === "darwin"
    ? join(homeDirectory, "Library", "Logs", "T4 Code", "appserver")
    : (() => {
        const configuredStateRoot = environment.XDG_STATE_HOME;
        const stateRoot = configuredStateRoot?.startsWith("/") === true
          ? configuredStateRoot
          : join(homeDirectory, ".local", "state");
        return join(stateRoot, "t4-code", "appserver");
      })();
  return profile === "default" ? base : join(base, "profiles", profile);
}

export interface DesktopLifecycleOptions {
  readonly app?: typeof app;
  readonly getAllWindows?: () => readonly BrowserWindow[];
  readonly createWindow?: () => DesktopWindowHandle;
  readonly createIpcRegistry?: (runtime: IpcRuntime) => DesktopIpcRegistry;
  readonly loadIdentity?: () => DeviceIdentity;
  readonly createCursorStore?: () => CursorStore;
  readonly createRemoteRegistry?: () => RemoteTargetRegistry;
  readonly createCredentials?: () => DeviceCredentialStore | undefined;
  readonly createLocalProfileRegistry?: () => LocalProfileRegistry;
  readonly createProjectionCache?: () => ProjectionCacheRuntime;
  readonly discoverExecutable?: () => Promise<string | undefined>;
  readonly probeAppserver?: (executable: string) => Promise<boolean>;
  readonly createServiceManager?: (options: Parameters<typeof createAppserverServiceManager>[0]) => ServiceManager;
  readonly createTargetManager?: (options: TargetManagerOptions) => LocalTargetManager;
  readonly createSpeechService?: (options: { readonly discoverExecutable: () => Promise<string | undefined> }) => DesktopSpeechService;
  readonly createUpdateController?: () => DesktopUpdateController;
  readonly installMenu?: (options: ApplicationMenuOptions) => void;
}

class ServiceRecoveryCancelledError extends Error {
  constructor() {
    super("desktop service recovery was cancelled");
    this.name = "ServiceRecoveryCancelledError";
  }
}

export class DesktopLifecycle {
  private readonly pendingPairs = new PendingPairQueue(8);
  private readonly electronApp: typeof app;
  private readonly allWindows: () => readonly BrowserWindow[];
  private readonly windowFactory: () => DesktopWindowHandle;
  private readonly ipcFactory: (runtime: IpcRuntime) => DesktopIpcRegistry;
  private readonly identityFactory: () => DeviceIdentity;
  private readonly cursorStoreFactory: () => CursorStore;
  private readonly remoteRegistryFactory: () => RemoteTargetRegistry;
  private readonly credentialsFactory: () => DeviceCredentialStore | undefined;
  private readonly localProfileRegistryFactory: () => LocalProfileRegistry;
  private readonly projectionCacheFactory: () => ProjectionCacheRuntime;
  private readonly executableFactory: () => Promise<string | undefined>;
  private readonly serviceFactory: (options: Parameters<typeof createAppserverServiceManager>[0]) => ServiceManager;
  private readonly speechServiceFactory: (options: { readonly discoverExecutable: () => Promise<string | undefined> }) => DesktopSpeechService;
  private readonly appserverProbe: (executable: string) => Promise<boolean>;
  private readonly targetManagerFactory: (options: TargetManagerOptions) => LocalTargetManager;
  private readonly updateControllerFactory: () => DesktopUpdateController;
  private readonly menuInstaller: (options: ApplicationMenuOptions) => void;
  private mainWindow: BrowserWindow | undefined;
  private ipc: DesktopIpcRegistry | undefined;
  private manager: LocalTargetManager | undefined;
  private localProfileRegistry: LocalProfileRegistry | undefined;
  private speechService: DesktopSpeechService | undefined;
  private profileRuntime: LocalProfileRuntime | undefined;
  private projectionCache: ProjectionCacheRuntime | undefined;
  private serviceManager: ServiceManager | undefined;
  private readonly serviceManagers = new Map<string, ServiceManager>();
  private serviceAvailabilityIssue: ServiceAvailabilityIssue | undefined;
  private serviceExecutablePromise: Promise<string | undefined> | undefined;
  private serviceRecoveryPromise: Promise<ServiceManager | undefined> | undefined;
  private readonly serviceRecoveryPromises = new Map<string, Promise<ServiceManager | undefined>>();
  private readonly serviceAvailabilityIssues = new Map<string, ServiceAvailabilityIssue>();
  private updateController: DesktopUpdateController | undefined;
  private pendingUpdateOpen = false;
  private rendererLoaded = false;
  private updateRendererReady = false;
  private startupPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private startupServiceError: unknown;
  private started = false;
  private stopping = false;
  private beforeQuitHandler: (() => void) | undefined;

  constructor(options: DesktopLifecycleOptions = {}) {
    this.electronApp = options.app ?? app;
    this.allWindows = options.getAllWindows ?? (() => BrowserWindow.getAllWindows());
    this.windowFactory = options.createWindow ?? createDesktopWindow;
    this.ipcFactory = options.createIpcRegistry ?? ((runtime) => new DesktopIpcRegistry(runtime));
    this.identityFactory = options.loadIdentity ?? (() => loadDeviceIdentity());
    this.cursorStoreFactory = options.createCursorStore ?? (() => new ElectronCursorStore());
    this.remoteRegistryFactory = options.createRemoteRegistry ?? (() => new VersionedRemoteTargetRegistry(new ElectronRemoteTargetStore()));
    this.credentialsFactory = options.createCredentials ?? (() => {
      if (!electronSafeStorage.isEncryptionAvailable()) return undefined;
      try { return new DeviceCredentialStore(new ElectronCredentialCiphertextStore(), electronSafeStorage); } catch { return undefined; }
    });
    this.localProfileRegistryFactory = options.createLocalProfileRegistry ?? (
      () => new LocalProfileRegistry(new ElectronLocalProfileStore())
    );
    this.projectionCacheFactory = options.createProjectionCache ?? (() => new ElectronProjectionCacheStore());
    this.executableFactory = options.discoverExecutable ?? (() => discoverOmpExecutable());
    this.appserverProbe = options.probeAppserver ?? ((executable) => probeOmpAppserver(executable));
    this.serviceFactory = options.createServiceManager ?? createAppserverServiceManager;
    this.targetManagerFactory = options.createTargetManager ?? ((managerOptions) => new LocalTargetManager(managerOptions));
    this.speechServiceFactory = options.createSpeechService ?? ((speechOptions) => createDesktopSpeechService(speechOptions));
    this.updateControllerFactory = options.createUpdateController ?? createElectronUpdateController;
    this.menuInstaller = options.installMenu ?? installApplicationMenu;
  }
  async start(): Promise<void> {
    if (this.startupPromise !== undefined) return this.startupPromise;
    this.startupPromise = this.startInternal();
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    const gotLock = this.electronApp.requestSingleInstanceLock();
    if (!gotLock) {
      this.electronApp.quit();
      return;
    }
    const ingest = (value: string): void => {
      const parsed = parsePairDeepLink(value);
      if (parsed === null) return;
      const pending: PendingPair = { hostHint: parsed.hostHint, code: parsed.code, issuedAt: parsed.issuedAt };
      if (this.rendererLoaded && this.mainWindow !== undefined && !this.mainWindow.isDestroyed()) this.ipc?.emitPairLink(pending);
      else this.pendingPairs.push(pending);
    };
    for (const argument of process.argv) ingest(argument);
    this.electronApp.on("second-instance", (_event, argv) => {
      for (const argument of argv) ingest(argument);
      this.mainWindow?.show();
      this.mainWindow?.focus();
    });
    this.electronApp.on("open-url", (event, value) => {
      event.preventDefault();
      ingest(value);
    });
    await this.electronApp.whenReady();
    this.projectionCache = this.projectionCacheFactory();
    if (process.platform === "darwin") this.electronApp.setAsDefaultProtocolClient("t4-code");
    this.updateController = this.updateControllerFactory();
    this.menuInstaller({ onOpenUpdates: () => this.openUpdatesFromMenu() });
    const identity = this.identityFactory();
    const remoteRegistry = this.remoteRegistryFactory();
    const credentials = this.credentialsFactory();
    this.localProfileRegistry = this.localProfileRegistryFactory();
    await this.acquireServiceManager();
    if (this.stopping) return;
    this.manager = this.targetManagerFactory({
      cursorStore: this.cursorStoreFactory(),
      registry: remoteRegistry,
      localProfiles: () => this.localProfileRegistry?.list() ?? Promise.resolve([]),
      ...(credentials === undefined ? {} : { credentials }),
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      events: {
        onEvent: (targetId, event) => this.ipc?.emitServerEvent(targetId, event),
        onState: (state) => this.ipc?.emitConnectionState(state),
        onError: (error) => this.ipc?.emitRuntimeError(error),
      },
    });
    this.profileRuntime = new LocalProfileRuntime({
      registry: this.localProfileRegistry,
      targets: this.manager,
      acquireServiceManager: (profileId) => this.acquireServiceManager(profileId),
      releaseServiceManager: (profileId) => this.releaseServiceManager(profileId),
      getServiceAvailabilityIssue: (profileId) => this.getServiceAvailabilityIssue(profileId),
    });
    this.speechService = this.speechServiceFactory({
      discoverExecutable: () => this.discoverServiceExecutable(),
    });
    this.bindWindow(this.windowFactory());
    await this.profileRuntime.startAutomaticProfiles((profileId, error) => {
      this.ipc?.emitRuntimeError(runtimeError(error, `local:${profileId}`));
    });
    this.beforeQuitHandler = () => {
      void this.stop().catch(() => {
        // Electron is already quitting; teardown remains best effort.
      });
    };
    this.electronApp.on("before-quit", this.beforeQuitHandler);
    this.electronApp.on("activate", () => {
      if (this.stopping) return;
      if (this.allWindows().length === 0) this.bindWindow(this.windowFactory());
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }
  private async stopInternal(): Promise<void> {
    this.stopping = true;
    await this.speechService?.dispose();
    this.speechService = undefined;
    this.ipc?.uninstall();
    this.ipc = undefined;
    this.mainWindow = undefined;
    this.updateController?.dispose();
    this.updateController = undefined;
    this.projectionCache = undefined;
    const manager = this.manager;
    this.manager = undefined;
    const recovery = this.serviceRecoveryPromise;
    const recoveries = [...this.serviceRecoveryPromises.values()];
    await Promise.all([
      manager?.close() ?? Promise.resolve(),
      recovery?.then(() => undefined, () => undefined) ?? Promise.resolve(),
      ...recoveries.map((value) => value.then(() => undefined, () => undefined)),
    ]);
    if (this.beforeQuitHandler !== undefined) this.electronApp.removeListener("before-quit", this.beforeQuitHandler);
    this.beforeQuitHandler = undefined;
  }
  private async ensureServiceReady(manager: ServiceManager, executable: string): Promise<void> {
    this.assertServiceRecoveryActive();
    let inspection = await manager.inspect();
    this.assertServiceRecoveryActive();
    if (inspection.definition !== "current") {
      await manager.install();
      this.assertServiceRecoveryActive();
      inspection = await manager.inspect();
      this.assertServiceRecoveryActive();
    }
    if (inspection.service !== "running") {
      await manager.start();
      this.assertServiceRecoveryActive();
    }
    const deadline = Date.now() + 5_000;
    while (true) {
      this.assertServiceRecoveryActive();
      inspection = await manager.inspect();
      this.assertServiceRecoveryActive();
      const ready = inspection.service === "running" && await this.appserverProbe(executable);
      this.assertServiceRecoveryActive();
      if (ready) return;
      if (Date.now() >= deadline) throw new Error(`appserver service did not become ready (${inspection.diagnostics.slice(0, 512)})`);
      const delay = Promise.withResolvers<void>();
      setTimeout(delay.resolve, 100);
      await delay.promise;
    }
  }

  /**
   * Discover and prepare the service as one lifecycle-owned transaction.
   * A constructed manager is retained for explicit inspection/repair even
   * when automatic startup fails, and all windows/retries share one attempt.
   */
  private acquireServiceManager(profileId = "default"): Promise<ServiceManager | undefined> {
    const profile = decodeLocalProfileId(profileId);
    if (this.stopping) return Promise.resolve(undefined);
    const current = profile === "default"
      ? this.serviceManager
      : this.serviceManagers.get(profile);
    if (current !== undefined) return Promise.resolve(current);
    const activeRecovery = profile === "default"
      ? this.serviceRecoveryPromise
      : this.serviceRecoveryPromises.get(profile);
    if (activeRecovery !== undefined) return activeRecovery;
    const recovery = this.recoverServiceManager(profile);
    if (profile === "default") this.serviceRecoveryPromise = recovery;
    else this.serviceRecoveryPromises.set(profile, recovery);
    const clearRecovery = (): void => {
      if (profile === "default") {
        if (this.serviceRecoveryPromise === recovery) this.serviceRecoveryPromise = undefined;
      } else if (this.serviceRecoveryPromises.get(profile) === recovery) {
        this.serviceRecoveryPromises.delete(profile);
      }
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }

  private async recoverServiceManager(profileId = "default"): Promise<ServiceManager | undefined> {
    if (this.stopping) return undefined;
    let executable: string | undefined;
    try {
      executable = await this.discoverServiceExecutable();
      this.assertServiceRecoveryActive();
    } catch (error) {
      if (this.stopping || error instanceof ServiceRecoveryCancelledError) return undefined;
      this.recordServiceFailure(error, profileId);
      return undefined;
    }
    if (executable === undefined) {
      const issue: ServiceAvailabilityIssue = {
        code: "omp_not_found",
        message: "OMP was not found. Install or update OMP, then choose Check again.",
      };
      if (profileId === "default") this.serviceAvailabilityIssue = issue;
      else this.serviceAvailabilityIssues.set(profileId, issue);
      return undefined;
    }
    try {
      const candidate = this.serviceFactory({
        profileId,
        homeDirectory: homedir(),
        logsDirectory: appserverLogsDirectory(homedir(), process.platform, process.env, profileId),
        executable,
        argv: executable.endsWith("/ompd") ? [] : ["appserver", "serve"],
        fs: new NodeServiceFileSystem(),
      });
      this.assertServiceRecoveryActive();
      if (profileId !== "default") {
        this.serviceManagers.set(profileId, candidate);
        this.serviceAvailabilityIssues.delete(profileId);
        return candidate;
      }
      // A healthy appserver may have been launched outside T4 Code. Use it
      // as-is; service installation/startup is only a cold-start fallback.
      try {
        const alreadyReady = await this.appserverProbe(executable).catch(() => false);
        this.assertServiceRecoveryActive();
        if (!alreadyReady) await this.ensureServiceReady(candidate, executable);
      } catch (error) {
        if (this.stopping || error instanceof ServiceRecoveryCancelledError) return undefined;
        // Creation succeeded, so keep the manager available for authoritative
        // inspection and explicit repair actions even if automatic startup did
        // not finish. The preparation error remains a one-shot runtime event.
        this.serviceManager = candidate;
        this.serviceAvailabilityIssue = undefined;
        this.startupServiceError = error;
        return candidate;
      }
      this.assertServiceRecoveryActive();
      this.serviceManager = candidate;
      this.serviceAvailabilityIssue = undefined;
      this.startupServiceError = undefined;
      return candidate;
    } catch (error) {
      if (this.stopping || error instanceof ServiceRecoveryCancelledError) return undefined;
      this.recordServiceFailure(error, profileId);
      return undefined;
    }
  }

  /** Share only concurrent OMP discovery; later repair attempts must revalidate the executable. */
  private discoverServiceExecutable(): Promise<string | undefined> {
    if (this.serviceExecutablePromise !== undefined) return this.serviceExecutablePromise;
    const discovery = Promise.resolve().then(() => this.executableFactory());
    this.serviceExecutablePromise = discovery;
    const clearDiscovery = (): void => {
      if (this.serviceExecutablePromise === discovery) this.serviceExecutablePromise = undefined;
    };
    void discovery.then(clearDiscovery, clearDiscovery);
    return discovery;
  }

  private assertServiceRecoveryActive(): void {
    if (this.stopping) throw new ServiceRecoveryCancelledError();
  }

  private recordServiceFailure(error: unknown, profileId = "default"): void {
    const issue: ServiceAvailabilityIssue = error instanceof OmpAppserverCompatibilityError
      ? { code: "omp_incompatible", message: error.message }
      : {
          code: "service_unavailable",
          message: runtimeError(error, "local").message || "The local OMP service is unavailable. Choose Check again to retry.",
        };
    if (profileId === "default") {
      this.startupServiceError = error;
      this.serviceAvailabilityIssue = issue;
    } else {
      this.serviceAvailabilityIssues.set(profileId, issue);
    }
  }

  private getServiceAvailabilityIssue(profileId: string): ServiceAvailabilityIssue | undefined {
    const profile = decodeLocalProfileId(profileId);
    return profile === "default"
      ? this.serviceAvailabilityIssue
      : this.serviceAvailabilityIssues.get(profile);
  }

  private releaseServiceManager(profileId: string): void {
    const profile = decodeLocalProfileId(profileId);
    if (profile === "default") return;
    this.serviceManagers.delete(profile);
    this.serviceRecoveryPromises.delete(profile);
    this.serviceAvailabilityIssues.delete(profile);
  }

  private bindWindow(handle: DesktopWindowHandle): void {
    this.rendererLoaded = false;
    this.updateRendererReady = false;
    const manager = this.manager;
    if (manager === undefined) return;
    this.mainWindow = handle.window;
    this.ipc?.uninstall();
    this.ipc = this.ipcFactory({
      manager,
      window: handle.window,
      trustedRenderer: handle.trustedRenderer,
      getServiceManager: () => this.serviceManager,
      acquireServiceManager: () => this.acquireServiceManager(),
      getServiceAvailabilityIssue: () => this.serviceAvailabilityIssue,
      ...(this.speechService === undefined ? {} : { speech: this.speechService }),
      ...(this.profileRuntime === undefined ? {} : { profileRuntime: this.profileRuntime }),
      ...(this.projectionCache === undefined ? {} : { projectionCache: this.projectionCache }),
      drainPairLinks: () => this.pendingPairs.drain(),
      drainPendingUpdateOpen: () => this.markUpdateRendererReady(),
      ...(this.updateController === undefined ? {} : { updateController: this.updateController }),
    });
    this.ipc.install();
    handle.window.webContents.on("did-start-loading", () => {
      this.updateRendererReady = false;
    });
    handle.window.webContents.once("did-finish-load", () => {
      this.rendererLoaded = true;
      if (this.startupServiceError !== undefined) {
        this.ipc?.emitRuntimeError(runtimeError(this.startupServiceError, "local"));
        this.startupServiceError = undefined;
      }
      const links = this.pendingPairs.drain();
      for (const link of links) this.ipc?.emitPairLink(link);
      this.updateController?.schedulePassiveCheck();
    });
    handle.window.on("closed", () => {
      if (this.mainWindow === handle.window) {
        this.mainWindow = undefined;
        this.rendererLoaded = false;
        this.updateRendererReady = false;
        this.ipc?.uninstall();
        this.ipc = undefined;
      }
    });
  }

  private openUpdatesFromMenu(): void {
    if (this.stopping) return;
    if (this.mainWindow === undefined && this.manager !== undefined) {
      this.bindWindow(this.windowFactory());
    }
    this.mainWindow?.show();
    this.mainWindow?.focus();
    if (this.updateRendererReady) this.ipc?.emitOpenUpdateSettings();
    else this.pendingUpdateOpen = true;
  }

  private markUpdateRendererReady(): boolean {
    this.updateRendererReady = true;
    const openSettings = this.pendingUpdateOpen;
    this.pendingUpdateOpen = false;
    return openSettings;
  }
}
