import { contextBridge, ipcRenderer } from "electron";
import {
  decodeDesktopEvent,
  decodeDesktopUpdateRendererReadyResult,
  decodeDesktopUpdateState,
  decodeProjectionCacheLoadResult,
  decodeProjectionCacheSaveResult,
  decodePhoneSetupState,
  type BootstrapResult,
  type CommandRequest,
  type CommandResult,
  type ConfirmRequest,
  type ConfirmResult,
  type ConnectionStateEvent,
  type ConnectResult,
  type DisconnectResult,
  type LocalProfileAddRequest,
  type LocalProfileListResult,
  type LocalProfileRemoveResult,
  type LocalProfileRequest,
  type LocalProfileResult,
  type LocalProfileUpdateRequest,
  type DesktopUpdateOpenEvent,
  type DesktopUpdateRendererReadyResult,
  type DesktopUpdateState,
  type PairLinkEvent,
  type PairLinksDrainResult,
  type PairRequest,
  type PairResult,
  type PhoneSetupState,
  type RendererServerEventEnvelope,
  type RuntimeErrorEvent,
  type ServiceActionResult,
  type ServiceInspection,
  type TargetAddRequest,
  type TargetAddResult,
  type TargetListResult,
  type TargetRemoveResult,
  type TargetRequest,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalResizeRequest,
  type TerminalResult,
  type SpeechRequest,
  type SpeechResult,
  type ProjectionCacheLoadResult,
  type ProjectionCacheSaveRequest,
  type ProjectionCacheSaveResult,
} from "@t4-code/protocol/desktop-ipc";
import { BROWSER_CHANNELS, decodeBrowserCall, decodeBrowserEvent, decodeBrowserResult, type BrowserCall, type BrowserCallResult, type BrowserEvent } from "@t4-code/protocol/browser-ipc";
import type { BrowserShellPort } from "@t4-code/client";
import { desktopClusterOperatorEnabled } from "./cluster-operator-flag.ts";
 
export interface OmpShellBridge {
  readonly kind: "desktop";
  readonly platform: "linux" | "darwin";
  readonly clusterOperatorEnabled?: true;
  readonly bootstrap: () => Promise<BootstrapResult>;
  readonly confirm: (request: ConfirmRequest) => Promise<ConfirmResult>;
  readonly terminalInput: (request: TerminalInputRequest) => Promise<TerminalResult>;
  readonly speakText: (request: SpeechRequest) => Promise<SpeechResult>;
  readonly stopSpeaking: () => Promise<SpeechResult>;
  readonly terminalResize: (request: TerminalResizeRequest) => Promise<TerminalResult>;
  readonly terminalClose: (request: TerminalCloseRequest) => Promise<TerminalResult>;
  readonly connect: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnect: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly command: (request: CommandRequest) => Promise<CommandResult>;
  readonly pair: (request: PairRequest) => Promise<PairResult>;
  readonly drainPairLinks: () => Promise<PairLinksDrainResult>;
  readonly serviceInspect: () => Promise<ServiceInspection>;
  readonly serviceInstall: () => Promise<ServiceActionResult>;
  readonly serviceStart: () => Promise<ServiceActionResult>;
  readonly serviceStop: () => Promise<ServiceActionResult>;
  readonly serviceRestart: () => Promise<ServiceActionResult>;
  readonly serviceUninstall: () => Promise<ServiceActionResult>;
  readonly loadProjectionCache: () => Promise<ProjectionCacheLoadResult>;
  readonly saveProjectionCache: (request: ProjectionCacheSaveRequest) => Promise<ProjectionCacheSaveResult>;
  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly checkForUpdate: () => Promise<DesktopUpdateState>;
  readonly downloadUpdate: () => Promise<DesktopUpdateState>;
  readonly restartToUpdate: () => Promise<DesktopUpdateState>;
  readonly updateRendererReady: () => Promise<DesktopUpdateRendererReadyResult>;
  readonly listTargets: () => Promise<TargetListResult>;
  readonly addTarget: (request: TargetAddRequest) => Promise<TargetAddResult>;
  readonly removeTarget: (request: TargetRequest) => Promise<TargetRemoveResult>;
  readonly connectTarget: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnectTarget: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly listProfiles: () => Promise<LocalProfileListResult>;
  readonly addProfile: (request: LocalProfileAddRequest) => Promise<LocalProfileResult>;
  readonly updateProfile: (request: LocalProfileUpdateRequest) => Promise<LocalProfileResult>;
  readonly removeProfile: (request: LocalProfileRequest) => Promise<LocalProfileRemoveResult>;
  readonly profileStatus: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileStart: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileStop: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileRestart: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly inspectPhoneSetup: () => Promise<PhoneSetupState>;
  readonly configurePhoneSetup: () => Promise<PhoneSetupState>;
  readonly onServerEvent: (listener: (event: RendererServerEventEnvelope) => void) => () => void;
  readonly onConnectionState: (listener: (event: ConnectionStateEvent) => void) => () => void;
  readonly onRuntimeError: (listener: (event: RuntimeErrorEvent) => void) => () => void;
  readonly onPairLink: (listener: (event: PairLinkEvent) => void) => () => void;

  readonly onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  readonly onOpenUpdateSettings: (listener: (event: DesktopUpdateOpenEvent) => void) => () => void;
}

function invoke<C extends "omp:bootstrap" | "omp:connect" | "omp:disconnect" | "omp:command" | "omp:confirm" | "omp:terminal:input" | "omp:terminal:resize" | "omp:terminal:close" | "omp:pair" | "omp:pair-links:drain" | "omp:speech:speak" | "omp:speech:stop" | "omp:service:inspect" | "omp:service:install" | "omp:service:start" | "omp:service:stop" | "omp:service:restart" | "omp:service:uninstall" | "omp:targets:list" | "omp:targets:add" | "omp:targets:remove" | "omp:profiles:list" | "omp:profiles:add" | "omp:profiles:update" | "omp:profiles:remove" | "omp:profiles:status" | "omp:profiles:start" | "omp:profiles:stop" | "omp:profiles:restart" | "app:update:get-state" | "app:update:check" | "app:update:download" | "app:update:restart" | "app:update:renderer-ready" | "app:phone-setup:inspect" | "app:phone-setup:configure", R>(channel: C, payload: unknown): Promise<R> {
  return ipcRenderer.invoke(channel, { channel, payload }) as Promise<R>;
}

function invokeProjectionCache<R>(
  channel: "app:projection-cache:load" | "app:projection-cache:save",
  payload: unknown,
): Promise<R> {
  return ipcRenderer.invoke(channel, { channel, payload }) as Promise<R>;
}

type SubscriptionPayload<C> = C extends "omp:server-event"
  ? RendererServerEventEnvelope
  : C extends "omp:connection-state"
    ? ConnectionStateEvent
    : C extends "omp:runtime-error"
      ? RuntimeErrorEvent
      : C extends "omp:pair-link"
        ? PairLinkEvent
        : C extends "app:update:state"
          ? DesktopUpdateState
          : DesktopUpdateOpenEvent;

function subscribe<C extends "omp:server-event" | "omp:connection-state" | "omp:runtime-error" | "omp:pair-link" | "app:update:state" | "app:update:open">(
  channel: C,
  listener: (payload: SubscriptionPayload<C>) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
    try {
      const decoded = decodeDesktopEvent({ channel, payload: value });
      listener(decoded.payload as SubscriptionPayload<C>);
    } catch {
      // Invalid renderer events are dropped at the preload boundary.
    }
  };
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function createBrowserBridge(): BrowserShellPort {
  return {
    kind: "desktop-browser",
    call: async (request: BrowserCall): Promise<BrowserCallResult> => {
      const call = decodeBrowserCall(request);
      const result = await ipcRenderer.invoke(BROWSER_CHANNELS[0], {
        channel: BROWSER_CHANNELS[0],
        payload: call,
      });
      return decodeBrowserResult(call.method, result) as BrowserCallResult;
    },
    subscribe: (listener: (event: BrowserEvent) => void): (() => void) => {
      const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
        try {
          listener(decodeBrowserEvent(value));
        } catch {
          // Invalid browser events are dropped at the preload boundary.
        }
      };
      ipcRenderer.on(BROWSER_CHANNELS[1], wrapped);
      return () => ipcRenderer.removeListener(BROWSER_CHANNELS[1], wrapped);
    },
  };
}

const bridge: OmpShellBridge = {
  kind: "desktop",
  platform: process.platform === "darwin" ? "darwin" : "linux",
  ...(desktopClusterOperatorEnabled() ? { clusterOperatorEnabled: true as const } : {}),
  speakText: (request) => invoke("omp:speech:speak", request),
  stopSpeaking: () => invoke("omp:speech:stop", {}),
  bootstrap: () => invoke("omp:bootstrap", {}),
  connect: (request) => invoke("omp:connect", request),
  confirm: (request) => invoke("omp:confirm", request),
  terminalInput: (request) => invoke("omp:terminal:input", request),
  terminalResize: (request) => invoke("omp:terminal:resize", request),
  terminalClose: (request) => invoke("omp:terminal:close", request),
  disconnect: (request) => invoke("omp:disconnect", request),
  command: (request) => invoke("omp:command", request),
  pair: (request) => invoke("omp:pair", request),
  drainPairLinks: () => invoke("omp:pair-links:drain", {}),
  serviceInspect: () => invoke("omp:service:inspect", {}),
  serviceInstall: () => invoke("omp:service:install", {}),
  serviceStart: () => invoke("omp:service:start", {}),
  serviceStop: () => invoke("omp:service:stop", {}),
  serviceRestart: () => invoke("omp:service:restart", {}),
  serviceUninstall: () => invoke("omp:service:uninstall", {}),
  getUpdateState: () => invoke<"app:update:get-state", unknown>("app:update:get-state", {}).then(decodeDesktopUpdateState),
  checkForUpdate: () => invoke<"app:update:check", unknown>("app:update:check", {}).then(decodeDesktopUpdateState),
  downloadUpdate: () => invoke<"app:update:download", unknown>("app:update:download", {}).then(decodeDesktopUpdateState),
  restartToUpdate: () => invoke<"app:update:restart", unknown>("app:update:restart", {}).then(decodeDesktopUpdateState),
  updateRendererReady: () => invoke<"app:update:renderer-ready", unknown>("app:update:renderer-ready", {}).then(decodeDesktopUpdateRendererReadyResult),
  loadProjectionCache: () =>
    invokeProjectionCache<unknown>("app:projection-cache:load", {}).then(decodeProjectionCacheLoadResult),
  saveProjectionCache: (request) =>
    invokeProjectionCache<unknown>("app:projection-cache:save", request).then(decodeProjectionCacheSaveResult),
  listTargets: () => invoke("omp:targets:list", {}),
  addTarget: (request) => invoke("omp:targets:add", request),
  removeTarget: (request) => invoke("omp:targets:remove", request),
  connectTarget: (request) => invoke("omp:connect", request),
  disconnectTarget: (request) => invoke("omp:disconnect", request),
  listProfiles: () => invoke("omp:profiles:list", {}),
  addProfile: (request) => invoke("omp:profiles:add", request),
  updateProfile: (request) => invoke("omp:profiles:update", request),
  removeProfile: (request) => invoke("omp:profiles:remove", request),
  profileStatus: (request) => invoke("omp:profiles:status", request),
  profileStart: (request) => invoke("omp:profiles:start", request),
  profileStop: (request) => invoke("omp:profiles:stop", request),
  profileRestart: (request) => invoke("omp:profiles:restart", request),
  inspectPhoneSetup: () => invoke<"app:phone-setup:inspect", unknown>("app:phone-setup:inspect", {}).then(decodePhoneSetupState),
  configurePhoneSetup: () => invoke<"app:phone-setup:configure", unknown>("app:phone-setup:configure", {}).then(decodePhoneSetupState),
  onServerEvent: (listener) => subscribe("omp:server-event", listener),
  onConnectionState: (listener) => subscribe("omp:connection-state", listener),
  onRuntimeError: (listener) => subscribe("omp:runtime-error", listener),
  onPairLink: (listener) => subscribe("omp:pair-link", listener),
  onUpdateState: (listener) => subscribe("app:update:state", listener),
  onOpenUpdateSettings: (listener) => subscribe("app:update:open", listener),
};

contextBridge.exposeInMainWorld("ompShell", bridge);
contextBridge.exposeInMainWorld("t4Browser", createBrowserBridge());
