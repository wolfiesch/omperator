import type {
  BootstrapResult,
  CommandRequest,
  CommandResult,
  ConfirmRequest,
  ConfirmResult,
  ConnectionStateEvent,
  ConnectResult,
  DisconnectResult,
  LocalProfileAddRequest,
  LocalProfileListResult,
  LocalProfileRemoveResult,
  LocalProfileRequest,
  LocalProfileResult,
  LocalProfileUpdateRequest,
  DesktopTarget,
  DesktopUpdateOpenEvent,
  DesktopUpdateRendererReadyResult,
  DesktopUpdateState,
  PairLinkEvent,
  PairRequest,
  PairResult,
  PairLinksDrainResult,
  PhoneSetupState,
  RendererServerEventEnvelope,
  RendererServerEvent,
  RuntimeErrorEvent,
  ServiceActionResult,
  ServiceInspection,
  TargetAddRequest,
  TargetAddResult,
  TargetListResult,
  TargetRemoveResult,
  TargetRequest,
  TerminalCloseRequest,
  TerminalInputRequest,
  TerminalResizeRequest,
  TerminalResult,
  SpeechRequest,
  SpeechResult,
  ProjectionCacheLoadResult,
  ProjectionCacheSaveRequest,
  ProjectionCacheSaveResult,
} from "@t4-code/protocol/desktop-ipc";
import type { CatalogFrame, SettingsFrame } from "@t4-code/protocol";
import { ImmutableMap } from "./immutable-map.ts";
import type { ProjectionOptions, ProjectionSnapshot, ProjectionStore } from "./projection.ts";
import type { RuntimeIntegrationDescriptor } from "./runtime-integration.ts";

export interface DesktopShellPort {
  readonly kind: "desktop";
  readonly platform: "linux" | "darwin";
  /** Local source option; absent means cluster.operator is not requested or projected. */
  readonly clusterOperatorEnabled?: boolean;
  readonly bootstrap: () => Promise<BootstrapResult>;
  readonly connect: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnect: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly command: (request: CommandRequest) => Promise<CommandResult>;
  readonly confirm: (request: ConfirmRequest) => Promise<ConfirmResult>;
  readonly terminalInput: (request: TerminalInputRequest) => Promise<TerminalResult>;
  readonly terminalResize: (request: TerminalResizeRequest) => Promise<TerminalResult>;
  readonly speakText?: (request: SpeechRequest) => Promise<SpeechResult>;
  readonly stopSpeaking?: () => Promise<SpeechResult>;
  readonly terminalClose: (request: TerminalCloseRequest) => Promise<TerminalResult>;
  readonly pair: (request: PairRequest) => Promise<PairResult>;
  readonly drainPairLinks?: () => Promise<PairLinksDrainResult>;
  readonly serviceInspect?: () => Promise<ServiceInspection>;
  readonly serviceInstall?: () => Promise<ServiceActionResult>;
  readonly serviceStart?: () => Promise<ServiceActionResult>;
  readonly serviceStop?: () => Promise<ServiceActionResult>;
  readonly serviceRestart?: () => Promise<ServiceActionResult>;
  readonly serviceUninstall?: () => Promise<ServiceActionResult>;
  readonly listProfiles?: () => Promise<LocalProfileListResult>;
  readonly addProfile?: (request: LocalProfileAddRequest) => Promise<LocalProfileResult>;
  readonly updateProfile?: (request: LocalProfileUpdateRequest) => Promise<LocalProfileResult>;
  readonly removeProfile?: (request: LocalProfileRequest) => Promise<LocalProfileRemoveResult>;
  readonly profileStatus?: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileStart?: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileStop?: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly profileRestart?: (request: LocalProfileRequest) => Promise<LocalProfileResult>;
  readonly getUpdateState?: () => Promise<DesktopUpdateState>;
  readonly checkForUpdate?: () => Promise<DesktopUpdateState>;
  readonly downloadUpdate?: () => Promise<DesktopUpdateState>;
  readonly restartToUpdate?: () => Promise<DesktopUpdateState>;
  readonly updateRendererReady?: () => Promise<DesktopUpdateRendererReadyResult>;
  readonly loadProjectionCache?: () => Promise<ProjectionCacheLoadResult>;
  readonly saveProjectionCache?: (request: ProjectionCacheSaveRequest) => Promise<ProjectionCacheSaveResult>;
  readonly inspectPhoneSetup?: () => Promise<PhoneSetupState>;
  readonly configurePhoneSetup?: () => Promise<PhoneSetupState>;
  readonly listTargets: () => Promise<TargetListResult>;
  readonly addTarget: (request: TargetAddRequest) => Promise<TargetAddResult>;
  readonly removeTarget: (request: TargetRequest) => Promise<TargetRemoveResult>;
  readonly connectTarget: (request: TargetRequest) => Promise<ConnectResult>;
  readonly disconnectTarget: (request: TargetRequest) => Promise<DisconnectResult>;
  readonly onServerEvent: (listener: (event: RendererServerEventEnvelope) => void) => () => void;
  readonly onConnectionState: (listener: (event: ConnectionStateEvent) => void) => () => void;
  readonly onRuntimeError: (listener: (event: RuntimeErrorEvent) => void) => () => void;
  /** Existing browser/native lifecycle funnel; does not install a second listener set. */
  readonly onWake?: (listener: () => void) => () => void;
  readonly onPairLink?: (listener: (event: PairLinkEvent) => void) => () => void;
  readonly onUpdateState?: (listener: (state: DesktopUpdateState) => void) => () => void;
  readonly onOpenUpdateSettings?: (listener: (event: DesktopUpdateOpenEvent) => void) => () => void;
}

export type DesktopRuntimeStartState = "idle" | "starting" | "started" | "stopped" | "error";

export type DesktopWelcomePayload = Extract<
  RendererServerEvent,
  { kind: "welcome" }
>["payload"];

export interface DesktopHostMetadata {
  readonly targetId: string;
  readonly hostId: string;
  readonly ompVersion: string;
  readonly ompBuild: string;
  readonly appserverVersion: string;
  readonly appserverBuild: string;
  readonly epoch: string;
  readonly grantedCapabilities: readonly string[];
  readonly grantedFeatures: readonly string[];
  readonly negotiatedLimits: Readonly<Record<string, unknown>>;
  readonly authentication: DesktopWelcomePayload["authentication"];
  readonly resumed: boolean;
}

export interface DesktopRuntimeErrorEntry {
  readonly targetId?: string;
  readonly code: RuntimeErrorEvent["code"];
  readonly message: string;
  readonly at: number;
}

export interface DesktopServerEventFilter {
  readonly targetId: string;
  readonly hostId?: string;
  readonly sessionId?: string;
  readonly kinds?: readonly string[];
}

export type DesktopServerEventSubscription = (event: RendererServerEventEnvelope) => void;

export interface DesktopRuntimeSnapshot {
  readonly version: 1;
  readonly integration: RuntimeIntegrationDescriptor;
  readonly platform: "linux" | "darwin";
  readonly desktopVersion: string;
  readonly startState: DesktopRuntimeStartState;
  readonly targets: ReadonlyMap<string, DesktopTarget>;
  readonly connections: ReadonlyMap<string, DesktopTarget["state"]>;
  readonly targetHosts: ReadonlyMap<string, string>;
  readonly hosts: ReadonlyMap<string, DesktopHostMetadata>;
  readonly catalogs: ReadonlyMap<string, CatalogFrame>;
  readonly settings: ReadonlyMap<string, SettingsFrame>;
  readonly projection: ProjectionSnapshot;
  /** Local opt-in. Missing remains false for older renderer snapshots. */
  readonly clusterOperatorEnabled?: boolean;
  readonly runtimeErrors: readonly DesktopRuntimeErrorEntry[];
}

export type DesktopRuntimeSnapshotListener = (snapshot: DesktopRuntimeSnapshot) => void;

export interface DesktopRuntimeTimerScheduler {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface DesktopRuntimeOptions {
  readonly shell: DesktopShellPort;
  /** Requests and projects cluster.operator only when explicitly true. */
  readonly clusterOperatorEnabled?: boolean;
  readonly projection?: ProjectionStore;
  readonly projectionOptions?: ProjectionOptions;
  readonly clock?: { now(): number };
  readonly maxRuntimeErrors?: number;
  readonly timers?: DesktopRuntimeTimerScheduler;
}

export interface DesktopControllerLease {
  readonly targetId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly expectedRevision: string;
  readonly leaseId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly expiresAtIso?: string;
  readonly needsRenewal: (now?: number) => boolean;
}

export type DesktopControllerLeaseAcquireResult =
  | { readonly required: false }
  | ({ readonly required: true } & DesktopControllerLease);
export type DesktopControllerLeaseResult = DesktopControllerLeaseAcquireResult;

export interface DesktopControllerLeaseOperationResult {
  readonly required: boolean;
  readonly accepted: boolean;
  readonly leaseId?: string;
  readonly released?: boolean;
  readonly expiresAt?: string;
  readonly cursor?: string;
}

export interface DesktopControllerLeaseOptions {
  readonly ownerId?: string;
  readonly fallbackTtlMs?: number;
}

export function freezeClone<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => freezeClone(item, depth + 1))) as T;
  const source = value as unknown as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) output[key] = freezeClone(item, depth + 1);
  return Object.freeze(output) as T;
}

export function mapValue<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new ImmutableMap(entries);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function redactedMessage(message: string, maxLength = 512): string {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0
    ? Math.min(maxLength, 2_048)
    : 512;
  const redacted = message
    // Error strings are display-only. For ambiguous URLs and unquoted paths,
    // redact the rest of the logical field instead of risking a spaced suffix.
    .replace(/\b(?:https?|wss?|file):\/\/[^\r\n,;]*/giu, "[redacted]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/giu, "[redacted]")
    .replace(
      /(["']?)(authorization|access[_-]?token|client[_-]?secret|api[_-]?key|token|secret|password|credential)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;}\]]+|[^\s,;}\]]+)/giu,
      "$2=[redacted]",
    )
    .replace(
      /(?:~\/|\/(?:Users|home|tmp|var|private|etc|opt|srv|mnt|run|usr|Library|Applications|Volumes|dev|proc|sys)(?:\/|$))[^\r\n,;]*/gu,
      "[redacted]",
    );
  let firstControl = -1;
  for (let index = 0; index < redacted.length; index += 1) {
    const code = redacted.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      firstControl = index;
      break;
    }
  }
  if (firstControl >= 0) {
    let sanitized = redacted.slice(0, firstControl);
    for (let index = firstControl; index < redacted.length; index += 1) {
      const code = redacted.charCodeAt(index);
      sanitized += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : redacted[index];
    }
    return sanitized.slice(0, limit);
  }
  return redacted.slice(0, limit);
}

export function targetCopy(target: DesktopTarget): DesktopTarget {
  return freezeClone({
    ...target,
    ...(target.mode === undefined ? {} : { mode: target.mode }),
    ...(target.status === undefined ? {} : { status: target.status }),
  });
}

export function hostMetadata(targetId: string, frame: DesktopWelcomePayload): DesktopHostMetadata {
  return freezeClone({
    targetId,
    hostId: String(frame.hostId),
    ompVersion: frame.ompVersion,
    ompBuild: frame.ompBuild,
    appserverVersion: frame.appserverVersion,
    appserverBuild: frame.appserverBuild,
    epoch: frame.epoch,
    grantedCapabilities: [...frame.grantedCapabilities],
    grantedFeatures: [...frame.grantedFeatures],
    negotiatedLimits: { ...frame.negotiatedLimits },
    authentication: frame.authentication,
    resumed: frame.resumed,
  });
}

export class DesktopRuntimeError extends Error {
  readonly code: "bootstrap" | "protocol" | "stopped" | "command" | "outcome_unknown" | "stale";

  constructor(code: "bootstrap" | "protocol" | "stopped" | "command" | "outcome_unknown" | "stale", message: string) {
    super(redactedMessage(message));
    this.name = "DesktopRuntimeError";
    this.code = code;
    Object.defineProperty(this, "stack", { configurable: true, enumerable: false, value: undefined, writable: false });
  }
}
