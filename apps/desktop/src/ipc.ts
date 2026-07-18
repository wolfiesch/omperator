import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import {
  decodeDesktopEvent,
  decodeDesktopInvokeRequest,
  decodeLocalProfileId,
  decodeDesktopUpdateRendererReadyResult,
  decodeDesktopUpdateState,
  decodeProjectionCacheLoadResult,
  decodeProjectionCacheSaveResult,
  type BootstrapResult,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConnectionStateEvent,
  type ConnectResult,
  type DesktopEventChannel,
  type DesktopInvokeChannel,
  type DesktopInvokeRequest,
  type DesktopUpdateRendererReadyResult,
  type DesktopUpdateState,
  type DisconnectResult,
  type LocalProfile,
  type LocalProfileAddRequest,
  type LocalProfileListResult,
  type LocalProfileRemoveResult,
  type LocalProfileRequest,
  type LocalProfileResult,
  type LocalProfileUpdateRequest,
  type PairLinkEvent,
  type PairRequest,
  type PairResult,
  type PairLinksDrainResult,
  type ProjectionCacheLoadResult,
  type ProjectionCacheSaveRequest,
  type ProjectionCacheSaveResult,
  type RendererServerEvent,
  type RuntimeErrorEvent,
  type ServiceActionResult,
  type ServiceAvailabilityIssue,
  type ServiceInspection,
  type TargetAddRequest,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetRequest,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type SpeechRequest,
  type SpeechResult,
  type TerminalResult,
} from "@t4-code/protocol/desktop-ipc";
import type { ServiceManager } from "@t4-code/service-manager";
import { redactedMessage } from "@t4-code/client";
import { trustedSender, type TrustedRenderer } from "./security.ts";
import type { DesktopSpeechService } from "./speech.ts";
import type { LocalTargetManager } from "./target-manager.ts";
import type { LocalProfileRuntime } from "./profile-runtime.ts";
export interface IpcRuntime {
  readonly manager: LocalTargetManager;
  readonly window: BrowserWindow;
  readonly trustedRenderer: TrustedRenderer;
  /** Static manager support is retained for narrow unit runtimes. */
  readonly serviceManager?: ServiceManager;
  /** Dynamic lifecycle access keeps IPC valid after rediscovery or window reopen. */
  readonly getServiceManager?: () => ServiceManager | undefined;
  readonly speech?: DesktopSpeechService;
  readonly acquireServiceManager?: () => Promise<ServiceManager | undefined>;
  readonly getServiceAvailabilityIssue?: () => ServiceAvailabilityIssue | undefined;
  readonly profileRuntime?: LocalProfileRuntime;
  readonly drainPairLinks?: () => readonly PairLinkEvent[];
  readonly drainPendingUpdateOpen?: () => boolean;
  readonly updateController?: {
    readonly getState: () => DesktopUpdateState;
    readonly checkForUpdate: (interactive?: boolean) => Promise<DesktopUpdateState>;
    readonly downloadUpdate: () => Promise<DesktopUpdateState>;
    readonly restartToUpdate: () => DesktopUpdateState;
    readonly subscribe: (listener: (state: DesktopUpdateState) => void) => () => void;
  };
  readonly projectionCache?: {
    readonly load: () => ProjectionCacheLoadResult | Promise<ProjectionCacheLoadResult>;
    readonly save: (value: string) => ProjectionCacheSaveResult | Promise<ProjectionCacheSaveResult>;
  };
}
export class RemotePairingUnavailableError extends Error {
  readonly code = "remote_pairing_unavailable" as const;
  constructor() {
    super("Remote pairing is not available in this desktop build.");
    this.name = "RemotePairingUnavailableError";
    Object.defineProperty(this, "stack", { value: undefined, enumerable: false, configurable: true });
  }
}
export function validEvent(event: IpcMainInvokeEvent, runtime: IpcRuntime): boolean {
  return trustedSender(event.sender, runtime.window, runtime.trustedRenderer, event.senderFrame);
}

function boundedError(error: unknown): { readonly code: RuntimeErrorEvent["code"]; readonly message: string } {
  const message = error instanceof Error ? error.message : "Desktop operation failed";
  return { code: "internal", message: redactedMessage(message, 2_048) };
}
function decodeRequest(channel: DesktopInvokeChannel, value: unknown): DesktopInvokeRequest {
  const request = decodeDesktopInvokeRequest(value);
  if (request.channel !== channel) throw new Error("channel mismatch");
  return request;
}
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, payload: unknown) => unknown): void;
  removeHandler(channel: string): void;
}
export class DesktopIpcRegistry {
  private installed = false;
  private readonly runtime: IpcRuntime;
  private readonly serviceQueue = { tail: Promise.resolve() };
  private serviceInspectionPromise: Promise<ServiceInspection> | undefined;
  private updateUnsubscribe: (() => void) | undefined;
  private readonly ipc: IpcMainLike;
  constructor(runtime: IpcRuntime, ipc: IpcMainLike = ipcMain) {
    this.runtime = runtime;
    this.ipc = ipc;
  }

  install(): void {
    this.uninstall();
    this.installed = true;
    this.ipc.handle("omp:bootstrap", async (event, payload: unknown): Promise<BootstrapResult> => {
      this.assertSender(event);
      decodeRequest("omp:bootstrap", payload);
      // Bootstrap reports current truth only. It must not join or suppress a
      // user-initiated recovery attempt that starts in the same turn, but it
      // still shares the ordering boundary with every other service read/write.
      const service = await this.enqueueService(() => this.inspectServiceOnce(false));
      return { platform: process.platform === "darwin" ? "darwin" : "linux", version: "omp-app/1", connected: this.runtime.manager.isConnected(), ...(service === undefined ? {} : { service }) };
    });
    this.ipc.handle("omp:connect", async (event, payload: unknown): Promise<ConnectResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:connect", payload).payload as TargetRequest;
      const state = await this.runtime.manager.connect(input.targetId);
      return { targetId: input.targetId, state };
    });
    this.ipc.handle("omp:disconnect", async (event, payload: unknown): Promise<DisconnectResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:disconnect", payload).payload as TargetRequest;
      await this.runtime.manager.disconnect(input.targetId);
      return { targetId: input.targetId, state: "disconnected" };
    });
    this.ipc.handle("omp:confirm", async (event, payload: unknown): Promise<ConfirmResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:confirm", payload).payload as ConfirmRequest;
      return this.runtime.manager.confirm(input);
    });
    this.ipc.handle("omp:terminal:input", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:input", payload).payload as TerminalInputRequest;
      return this.runtime.manager.terminalInput(input);
    });
    this.ipc.handle("omp:terminal:resize", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:resize", payload).payload as TerminalResizeRequest;
      return this.runtime.manager.terminalResize(input);
    });
    this.ipc.handle("omp:terminal:close", async (event, payload: unknown): Promise<TerminalResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:terminal:close", payload).payload as TerminalCloseRequest;
      return this.runtime.manager.terminalClose(input);
    });
    this.ipc.handle("omp:speech:speak", async (event, payload: unknown): Promise<SpeechResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:speech:speak", payload).payload as SpeechRequest;
      return this.runtime.speech?.speakText(input) ?? { accepted: false, error: "Speech is unavailable" };
    });
    this.ipc.handle("omp:speech:stop", async (event, payload: unknown): Promise<SpeechResult> => {
      this.assertSender(event);
      decodeRequest("omp:speech:stop", payload);
      return this.runtime.speech?.stopSpeaking() ?? { accepted: false, error: "Speech is unavailable" };
    });
    this.ipc.handle("omp:command", async (event, payload: unknown): Promise<CommandResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:command", payload).payload as CommandRequest;
      return this.runtime.manager.command(input.targetId, input.intent);
    });
    this.ipc.handle("omp:pair", async (event, payload: unknown): Promise<PairResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:pair", payload).payload as PairRequest;
      return this.runtime.manager.pairStart(input.targetId, input.code);
    });
    this.ipc.handle("omp:pair-links:drain", async (event, payload: unknown): Promise<PairLinksDrainResult> => {
      this.assertSender(event);
      decodeRequest("omp:pair-links:drain", payload);
      return { links: Object.freeze([...(this.runtime.drainPairLinks?.() ?? [])]) };
    });
    this.ipc.handle("omp:targets:list", async (event, payload: unknown): Promise<TargetListResult> => {
      this.assertSender(event);
      decodeRequest("omp:targets:list", payload);
      return { targets: await this.runtime.manager.listTargets() };
    });
    this.ipc.handle("omp:targets:add", async (event, payload: unknown): Promise<{ target: unknown }> => {
      this.assertSender(event);
      const input = decodeRequest("omp:targets:add", payload).payload as TargetAddRequest;
      return { target: await this.runtime.manager.addRemoteTarget(input.target) };
    });
    this.ipc.handle("omp:targets:remove", async (event, payload: unknown): Promise<TargetRemoveResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:targets:remove", payload).payload as TargetRequest;
      await this.runtime.manager.removeTarget(input.targetId);
      return { targetId: input.targetId, removed: true };
    });
    this.ipc.handle("omp:profiles:list", async (event, payload: unknown): Promise<LocalProfileListResult> => {
      this.assertSender(event);
      decodeRequest("omp:profiles:list", payload);
      const profiles = await this.localProfiles().list();
      return { profiles: profiles.map((profile) => this.boundedProfile(profile)) };
    });
    this.ipc.handle("omp:profiles:add", async (event, payload: unknown): Promise<LocalProfileResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:profiles:add", payload).payload as LocalProfileAddRequest;
      return { profile: this.boundedProfile(await this.localProfiles().add(input.profile)) };
    });
    this.ipc.handle("omp:profiles:update", async (event, payload: unknown): Promise<LocalProfileResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:profiles:update", payload).payload as LocalProfileUpdateRequest;
      return { profile: this.boundedProfile(await this.localProfiles().update(input)) };
    });
    this.ipc.handle("omp:profiles:remove", async (event, payload: unknown): Promise<LocalProfileRemoveResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:profiles:remove", payload).payload as LocalProfileRequest;
      await this.localProfiles().remove(input.profileId);
      return { profileId: input.profileId, removed: true };
    });
    this.ipc.handle("omp:profiles:status", async (event, payload: unknown): Promise<LocalProfileResult> => {
      this.assertSender(event);
      const input = decodeRequest("omp:profiles:status", payload).payload as LocalProfileRequest;
      return { profile: this.boundedProfile(await this.localProfiles().status(input.profileId)) };
    });
    for (const action of ["start", "stop", "restart"] as const) {
      this.ipc.handle(`omp:profiles:${action}`, async (event, payload: unknown): Promise<LocalProfileResult> => {
        this.assertSender(event);
        const input = decodeRequest(`omp:profiles:${action}`, payload).payload as LocalProfileRequest;
        return {
          profile: this.boundedProfile(await this.localProfiles().action(input.profileId, action)),
        };
      });
    }
    this.ipc.handle("omp:service:inspect", async (event, payload: unknown): Promise<ServiceInspection> => {
      this.assertSender(event);
      decodeRequest("omp:service:inspect", payload);
      return this.inspectService();
    });
    for (const action of ["install", "start", "stop", "restart", "uninstall"] as const) {
      this.ipc.handle(`omp:service:${action}`, async (event, payload: unknown): Promise<ServiceActionResult> => {
        this.assertSender(event);
        decodeRequest(`omp:service:${action}`, payload);
        await this.runServiceAction(action);
        return { completed: true };
      });
    }
    this.ipc.handle("app:update:get-state", (event, payload: unknown): DesktopUpdateState => {
      this.assertSender(event);
      decodeRequest("app:update:get-state", payload);
      return decodeDesktopUpdateState(this.updateController().getState());
    });
    this.ipc.handle("app:update:check", async (event, payload: unknown): Promise<DesktopUpdateState> => {
      this.assertSender(event);
      decodeRequest("app:update:check", payload);
      return decodeDesktopUpdateState(await this.updateController().checkForUpdate(true));
    });
    this.ipc.handle("app:update:download", async (event, payload: unknown): Promise<DesktopUpdateState> => {
      this.assertSender(event);
      decodeRequest("app:update:download", payload);
      return decodeDesktopUpdateState(await this.updateController().downloadUpdate());
    });
    this.ipc.handle("app:update:restart", (event, payload: unknown): DesktopUpdateState => {
      this.assertSender(event);
      decodeRequest("app:update:restart", payload);
      return decodeDesktopUpdateState(this.updateController().restartToUpdate());
    });
    this.ipc.handle("app:update:renderer-ready", (event, payload: unknown): DesktopUpdateRendererReadyResult => {
      this.assertSender(event);
      decodeRequest("app:update:renderer-ready", payload);
      return decodeDesktopUpdateRendererReadyResult({
        openSettings: this.runtime.drainPendingUpdateOpen?.() ?? false,
      });
    });
    this.ipc.handle("app:projection-cache:load", async (event, payload: unknown): Promise<ProjectionCacheLoadResult> => {
      this.assertSender(event);
      decodeRequest("app:projection-cache:load", payload);
      const result = await (this.runtime.projectionCache?.load() ?? { available: false, value: null });
      return decodeProjectionCacheLoadResult(result);
    });
    this.ipc.handle("app:projection-cache:save", async (event, payload: unknown): Promise<ProjectionCacheSaveResult> => {
      this.assertSender(event);
      const input = decodeRequest("app:projection-cache:save", payload).payload as ProjectionCacheSaveRequest;
      const result = await (this.runtime.projectionCache?.save(input.value) ?? { saved: false });
      return decodeProjectionCacheSaveResult(result);
    });
    this.updateUnsubscribe = this.runtime.updateController?.subscribe((state) => {
      this.emit("app:update:state", state);
    });
  }
  uninstall(): void {
    this.updateUnsubscribe?.();
    this.updateUnsubscribe = undefined;
    for (const channel of [
      "omp:bootstrap", "omp:connect", "omp:disconnect", "omp:command", "omp:confirm",
      "omp:terminal:input", "omp:terminal:resize", "omp:terminal:close", "omp:pair",
      "omp:speech:speak", "omp:speech:stop",
      "omp:pair-links:drain", "omp:targets:list", "omp:targets:add", "omp:targets:remove",
      "omp:profiles:list", "omp:profiles:add", "omp:profiles:update", "omp:profiles:remove",
      "omp:profiles:status", "omp:profiles:start", "omp:profiles:stop", "omp:profiles:restart",
      "omp:service:inspect", "omp:service:install", "omp:service:start", "omp:service:stop",
      "omp:service:restart", "omp:service:uninstall",
      "app:update:get-state", "app:update:check", "app:update:download", "app:update:restart",
      "app:update:renderer-ready",
      "app:projection-cache:load", "app:projection-cache:save",
    ] as const) this.ipc.removeHandler(channel);
    this.installed = false;
  }
  emitServerEvent(targetId: string, event: RendererServerEvent): void {
    this.emit("omp:server-event", { targetId, event });
  }
  emitConnectionState(event: ConnectionStateEvent): void {
    this.emit("omp:connection-state", event);
  }
  emitRuntimeError(event: RuntimeErrorEvent): void {
    this.emit("omp:runtime-error", event);
  }
  emitPairLink(event: PairLinkEvent): void {
    this.emit("omp:pair-link", event);
  }
  emitOpenUpdateSettings(): void {
    this.emit("app:update:open", { source: "menu" });
  }

  private assertSender(event: IpcMainInvokeEvent): void {
    if (!validEvent(event, this.runtime)) throw new Error("untrusted desktop sender");
  }
  private inspectService(recover = true): Promise<ServiceInspection> {
    if (this.serviceInspectionPromise !== undefined) return this.serviceInspectionPromise;
    const inspection = this.enqueueService(() => this.inspectServiceOnce(recover));
    this.serviceInspectionPromise = inspection;
    const clearInspection = (): void => {
      if (this.serviceInspectionPromise === inspection) this.serviceInspectionPromise = undefined;
    };
    void inspection.then(clearInspection, clearInspection);
    return inspection;
  }
  private async inspectServiceOnce(recover: boolean): Promise<ServiceInspection> {
    const manager = recover ? await this.acquireServiceManager() : this.currentServiceManager();
    if (manager === undefined) return this.unavailableInspection();
    return this.boundedInspection(await manager.inspect());
  }
  private currentServiceManager(): ServiceManager | undefined {
    return this.runtime.getServiceManager?.() ?? this.runtime.serviceManager;
  }
  private acquireServiceManager(): Promise<ServiceManager | undefined> {
    const current = this.currentServiceManager();
    if (current !== undefined) return Promise.resolve(current);
    return this.runtime.acquireServiceManager?.() ?? Promise.resolve(undefined);
  }
  private unavailableInspection(): ServiceInspection {
    const raw = this.runtime.getServiceAvailabilityIssue?.() ?? {
      code: "service_unavailable" as const,
      message: "The local OMP service is unavailable. Choose Check again to retry.",
    };
    const code = ["omp_incompatible", "omp_not_found", "service_unavailable"].includes(raw.code)
      ? raw.code
      : "service_unavailable";
    return {
      definition: "missing",
      service: "unknown",
      diagnostics: "",
      issue: { code, message: boundedError(new Error(raw.message)).message.slice(0, 512) },
    };
  }
  private runServiceAction(action: "install" | "start" | "stop" | "restart" | "uninstall"): Promise<void> {
    // A write begins a new inspection epoch. Any read requested from this
    // point must run after the write instead of reusing a pre-write snapshot.
    this.serviceInspectionPromise = undefined;
    const operation = async (): Promise<void> => {
      const manager = await this.acquireServiceManager();
      if (manager === undefined) throw new Error(this.unavailableInspection().issue?.message ?? "appserver service is unavailable");
      await manager[action]();
    };
    return this.enqueueService(operation);
  }
  private enqueueService<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serviceQueue.tail.then(operation, operation);
    this.serviceQueue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private updateController(): NonNullable<IpcRuntime["updateController"]> {
    if (this.runtime.updateController === undefined) {
      throw new Error("Desktop updates are unavailable in this runtime");
    }
    return this.runtime.updateController;
  }
  private localProfiles(): LocalProfileRuntime {
    if (this.runtime.profileRuntime === undefined)
      throw new Error("Local OMP profiles are unavailable in this runtime");
    return this.runtime.profileRuntime;
  }
  private boundedInspection(inspection: ServiceInspection): ServiceInspection {
    if (
      !["missing", "current", "drifted"].includes(inspection.definition) ||
      !["stopped", "starting", "running", "failed", "unknown"].includes(inspection.service) ||
      typeof inspection.diagnostics !== "string"
    )
      throw new Error("invalid service inspection");
    const issue = inspection.issue === undefined
      ? undefined
      : {
          code: ["omp_incompatible", "omp_not_found", "service_unavailable"].includes(
            inspection.issue.code,
          )
            ? inspection.issue.code
            : "service_unavailable" as const,
          message: boundedError(new Error(inspection.issue.message)).message.slice(0, 512),
        };
    return {
      definition: inspection.definition,
      service: inspection.service,
      diagnostics: boundedError(new Error(inspection.diagnostics)).message.slice(0, 512),
      ...(issue === undefined ? {} : { issue }),
    };
  }
  private boundedProfile(profile: LocalProfile): LocalProfile {
    const profileId = decodeLocalProfileId(profile.profileId);
    const targetId = profileId === "default" ? "local" : `local:${profileId}`;
    if (
      typeof profile.label !== "string" ||
      profile.label.length === 0 ||
      profile.label.length > 128 ||
      profile.label.trim() !== profile.label ||
      [...profile.label].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
      }) ||
      profile.targetId !== targetId ||
      typeof profile.autoStart !== "boolean" ||
      profile.isDefault !== (profileId === "default")
    ) throw new Error("invalid local profile result");
    return Object.freeze({
      profileId,
      label: profile.label,
      targetId,
      autoStart: profile.autoStart,
      isDefault: profile.isDefault,
      service: this.boundedInspection(profile.service),
    });
  }
  private emit(channel: DesktopEventChannel, payload: unknown): void {
    const decoded = decodeDesktopEvent({ channel, payload });
    if (this.runtime.window.isDestroyed() || this.runtime.window.webContents.isDestroyed()) return;
    this.runtime.window.webContents.send(channel, decoded.payload);
  }
}

export function runtimeError(error: unknown, targetId?: string): RuntimeErrorEvent {
  const safe = boundedError(error);
  return { ...(targetId === undefined ? {} : { targetId }), code: safe.code, message: safe.message };
}

void runtimeError;
