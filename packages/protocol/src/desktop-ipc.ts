import {
  PROTOCOL_VERSION,
  decodeCommand,
  decodeConfirm,
  decodeTerminalClient,
  inputObject,
  isSecretLikeKey,
  object,
  controlFree,
  utf8ByteLength,
  type CommandFrame,
  type CommandId,
  type ConfirmationId,
  type HostId,
  type ResultError,
  type ServerFrame,
  type SessionId,
  type TerminalId,
} from "@oh-my-pi/app-wire";
import {
  ompServerEventFromFrame,
  type PublicOmpServerEvent,
} from "./server-event.ts";
import {
  decodeDesktopUpdateState,
  type DesktopUpdateState,
} from "./app-update.ts";
import { decodePairLinkEvent, type PairLinkEvent } from "./pair-link.ts";

export { decodeDesktopUpdateState } from "./app-update.ts";
export type { DesktopUpdatePhase, DesktopUpdateState } from "./app-update.ts";
export type { PairLinkEvent } from "./pair-link.ts";

export const DESKTOP_IPC_VERSION = PROTOCOL_VERSION;
export type RendererServerFrame = Exclude<ServerFrame, { type: "pair.ok" }>;
export type RendererServerEvent = PublicOmpServerEvent;

export function rendererServerEventFromFrame(frame: RendererServerFrame): RendererServerEvent {
  return ompServerEventFromFrame(frame);
}
export const DESKTOP_IPC_CHANNELS = [
  "omp:targets:list",
  "omp:targets:add",
  "omp:targets:remove",
  "omp:profiles:list",
  "omp:profiles:add",
  "omp:profiles:update",
  "omp:profiles:remove",
  "omp:profiles:status",
  "omp:profiles:start",
  "omp:profiles:stop",
  "omp:profiles:restart",
  "omp:command",
  "omp:confirm",
  "omp:terminal:input",
  "omp:terminal:resize",
  "omp:terminal:close",
  "omp:bootstrap",
  "omp:connect",
  "omp:disconnect",
  "omp:pair",
  "omp:pair-links:drain",
  "omp:service:inspect",
  "omp:service:install",
  "omp:service:start",
  "omp:service:stop",
  "omp:service:restart",
  "omp:service:uninstall",
  "app:update:get-state",
  "app:update:check",
  "app:update:download",
  "omp:speech:speak",
  "omp:speech:stop",
  "app:update:restart",
  "app:update:renderer-ready",
  "app:projection-cache:load",
  "app:projection-cache:save",
] as const;
export type DesktopInvokeChannel = (typeof DESKTOP_IPC_CHANNELS)[number];
export const DESKTOP_IPC_EVENTS = [
  "omp:server-event",
  "omp:connection-state",
  "omp:runtime-error",
  "omp:pair-link",
  "app:update:state",
  "app:update:open",
] as const;
export type DesktopEventChannel = (typeof DESKTOP_IPC_EVENTS)[number];
export type DesktopPlatform = "linux" | "darwin";
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "pairing-required"
  | "error";
export type RuntimeErrorCode = "transport" | "protocol" | "internal";
export interface BootstrapRequest {}
export type ServiceAvailabilityIssue =
  | { readonly code: "omp_incompatible"; readonly message: string }
  | { readonly code: "omp_not_found"; readonly message: string }
  | { readonly code: "service_unavailable"; readonly message: string };
export interface ServiceInspection {
  definition: "missing" | "current" | "drifted";
  service: "stopped" | "starting" | "running" | "failed" | "unknown";
  diagnostics: string;
  /** Structured desktop discovery/preparation state; absent for a real inspection. */
  issue?: ServiceAvailabilityIssue;
}
export type ServiceAction = "install" | "start" | "stop" | "restart" | "uninstall";
export interface ServiceActionRequest {}
export interface ServiceActionResult {
  completed: true;
}
export interface LocalProfile {
  readonly profileId: string;
  readonly label: string;
  readonly targetId: string;
  readonly autoStart: boolean;
  readonly isDefault: boolean;
  readonly service: ServiceInspection;
}
export interface LocalProfileListRequest {}
export interface LocalProfileListResult {
  readonly profiles: readonly LocalProfile[];
}
export interface LocalProfileAddRequest {
  readonly profile: {
    readonly profileId: string;
    readonly label?: string;
    readonly autoStart?: boolean;
  };
}
export interface LocalProfileUpdateRequest {
  readonly profileId: string;
  readonly changes: {
    readonly label?: string;
    readonly autoStart?: boolean;
  };
}
export interface LocalProfileRequest {
  readonly profileId: string;
}
export interface LocalProfileResult {
  readonly profile: LocalProfile;
}
export interface LocalProfileRemoveResult {
  readonly profileId: string;
  readonly removed: true;
}
export interface BootstrapResult {
  platform: DesktopPlatform;
  version: typeof PROTOCOL_VERSION;
  connected: boolean;
  service?: ServiceInspection;
}
export interface PairLinksDrainRequest {}
export interface PairLinksDrainResult {
  links: readonly PairLinkEvent[];
}
export interface DesktopTarget {
  targetId: string;
  label: string;
  kind: "local" | "remote";
  state: ConnectionState;
  paired: boolean;
  mode?: "direct" | "serve";
  status?: "unknown" | "online" | "offline" | "revoked";
}
export interface TargetListRequest {}
export interface TargetListResult {
  targets: readonly DesktopTarget[];
}
export interface TargetAddRequest {
  target: {
    targetId: string;
    label: string;
    mode: "direct" | "serve";
    address: string;
    port: number;
    expectedHostId?: string;
    requestedCapabilities: readonly string[];
    grantedCapabilities: readonly string[];
    status: "unknown" | "online" | "offline" | "revoked";
    deviceId?: string;
    lastSeen?: number;
    autoConnect?: boolean;
  };
}
export interface TargetAddResult {
  target: DesktopTarget;
}
export interface TargetRemoveResult {
  targetId: string;
  removed: boolean;
}
export interface PairStatusResult {
  targetId: string;
  state: ConnectionState;
  paired: boolean;
}
export interface TargetRequest {
  targetId: string;
}
export interface ConnectResult {
  targetId: string;
  state: "connecting" | "connected";
}
export interface DisconnectResult {
  targetId: string;
  state: "disconnected";
}
export interface PairRequest {
  targetId: string;
  code: string;
}
export interface PairResult {
  targetId: string;
  paired: boolean;
}
export type CommandIntent = Omit<CommandFrame, "v" | "type" | "requestId" | "commandId">;
export interface CommandRequest {
  targetId: string;
  intent: CommandIntent;
}
export interface CommandResultError {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
export interface CommandResult {
  targetId: string;
  requestId: string;
  commandId: string;
  accepted: boolean;
  result?: unknown;
  error?: CommandResultError;
}
export interface ConfirmRequest {
  targetId: string;
  confirmationId: ConfirmationId;
  commandId: CommandId;
  hostId: HostId;
  sessionId?: SessionId;
  decision: "approve" | "deny";
}
export interface ConfirmResult {
  targetId: string;
  requestId: string;
  confirmationId: ConfirmationId;
  commandId: CommandId;
  accepted: boolean;
}
export interface TerminalInputRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  data: string;
  encoding?: "utf8" | "base64";
}
export interface TerminalResizeRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  cols: number;
  rows: number;
}
export interface TerminalCloseRequest {
  targetId: string;
  hostId: HostId;
  sessionId: SessionId;
  terminalId: TerminalId;
  reason?: string;
}
export interface TerminalResult {
  targetId: string;
  accepted: boolean;
}
export const MAX_SPEECH_TEXT_BYTES = 64 * 1024;
export interface SpeechRequest {
  readonly text: string;
}
export interface SpeechResult {
  readonly accepted: boolean;
  readonly error?: string;
}

export const MAX_PROJECTION_CACHE_BYTES = 2 * 1024 * 1024;
export interface ProjectionCacheLoadRequest {}
export interface ProjectionCacheLoadResult {
  readonly available: boolean;
  readonly value: string | null;
}
export interface ProjectionCacheSaveRequest {
  readonly value: string;
}
export interface ProjectionCacheSaveResult {
  readonly saved: boolean;
}
export interface DesktopUpdateRequest {}
export interface DesktopUpdateRendererReadyResult {
  readonly openSettings: boolean;
}
export interface DesktopUpdateOpenEvent {
  readonly source: "menu";
}

const MAX_COMMAND_ERROR_CODE_BYTES = 128;
const MAX_COMMAND_ERROR_MESSAGE_BYTES = 1_024;
const MAX_COMMAND_ERROR_DETAILS_BYTES = 8_192;
const MAX_COMMAND_ERROR_DETAIL_STRING_BYTES = 1_024;
const MAX_COMMAND_ERROR_DETAIL_DEPTH = 4;
const MAX_COMMAND_ERROR_DETAIL_NODES = 64;
const MAX_COMMAND_ERROR_DETAIL_KEYS = 16;
const MAX_COMMAND_ERROR_DETAIL_ITEMS = 16;

function boundedDisplayText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  let printable = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    printable +=
      codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
        ? " "
        : character;
  }
  try {
    if (utf8ByteLength(printable) <= maxBytes) return printable;
  } catch {
    return undefined;
  }
  let output = "";
  for (const character of printable) {
    const next = `${output}${character}`;
    try {
      if (utf8ByteLength(next) > maxBytes) break;
    } catch {
      break;
    }
    output = next;
  }
  return output.length === 0 ? undefined : output;
}

function redactedDisplayText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const redacted = value
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
  return boundedDisplayText(redacted, maxBytes);
}

interface DetailBudget {
  nodes: number;
}

function commandErrorDetailValue(value: unknown, depth: number, budget: DetailBudget): unknown {
  budget.nodes += 1;
  if (budget.nodes > MAX_COMMAND_ERROR_DETAIL_NODES || depth > MAX_COMMAND_ERROR_DETAIL_DEPTH) {
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return redactedDisplayText(value, MAX_COMMAND_ERROR_DETAIL_STRING_BYTES);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value.slice(0, MAX_COMMAND_ERROR_DETAIL_ITEMS)) {
      const safe = commandErrorDetailValue(item, depth + 1, budget);
      if (safe !== undefined) items.push(safe);
    }
    return items;
  }
  if (typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_COMMAND_ERROR_DETAIL_KEYS)) {
    if (isSecretLikeKey(key)) continue;
    const safeKey = boundedDisplayText(key, 128);
    if (safeKey === undefined) continue;
    const safe = commandErrorDetailValue(item, depth + 1, budget);
    if (safe !== undefined) output[safeKey] = safe;
  }
  return output;
}

/** Copy a decoded app-wire error across desktop IPC with bounded, non-secret details. */
export function commandResultError(error: ResultError | undefined): CommandResultError | undefined {
  if (error === undefined) return undefined;
  const code = boundedDisplayText(error.code, MAX_COMMAND_ERROR_CODE_BYTES);
  const message = redactedDisplayText(error.message, MAX_COMMAND_ERROR_MESSAGE_BYTES);
  if (code === undefined || message === undefined) return undefined;
  const details = commandErrorDetailValue(error.details, 0, { nodes: 0 });
  let boundedDetails: Readonly<Record<string, unknown>> | undefined;
  if (
    details !== undefined &&
    details !== null &&
    typeof details === "object" &&
    !Array.isArray(details)
  ) {
    try {
      const selected: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(details)) {
        selected[key] = value;
        if (utf8ByteLength(JSON.stringify(selected)) > MAX_COMMAND_ERROR_DETAILS_BYTES) {
          delete selected[key];
        }
      }
      boundedDetails = Object.freeze(selected);
    } catch {
      // A malformed future detail value must not break the command response.
    }
  }
  return Object.freeze({
    code,
    message,
    ...(boundedDetails === undefined || Object.keys(boundedDetails).length === 0
      ? {}
      : { details: boundedDetails }),
  });
}

export interface ConnectionStateEvent {
  targetId: string;
  state: ConnectionState;
}
export interface RuntimeErrorEvent {
  targetId?: string;
  code: RuntimeErrorCode;
  message: string;
}
export interface DesktopInvokeRequestMap {
  "omp:targets:list": TargetListRequest;
  "omp:targets:add": TargetAddRequest;
  "omp:targets:remove": TargetRequest;
  "omp:profiles:list": LocalProfileListRequest;
  "omp:profiles:add": LocalProfileAddRequest;
  "omp:profiles:update": LocalProfileUpdateRequest;
  "omp:profiles:remove": LocalProfileRequest;
  "omp:profiles:status": LocalProfileRequest;
  "omp:profiles:start": LocalProfileRequest;
  "omp:profiles:stop": LocalProfileRequest;
  "omp:profiles:restart": LocalProfileRequest;
  "omp:command": CommandRequest;
  "omp:confirm": ConfirmRequest;
  "omp:terminal:input": TerminalInputRequest;
  "omp:terminal:resize": TerminalResizeRequest;
  "omp:terminal:close": TerminalCloseRequest;
  "omp:bootstrap": BootstrapRequest;
  "omp:connect": TargetRequest;
  "omp:disconnect": TargetRequest;
  "omp:pair": PairRequest;
  "omp:pair-links:drain": PairLinksDrainRequest;
  "omp:service:inspect": ServiceActionRequest;
  "omp:speech:speak": SpeechRequest;
  "omp:speech:stop": {};
  "omp:service:install": ServiceActionRequest;
  "omp:service:start": ServiceActionRequest;
  "omp:service:stop": ServiceActionRequest;
  "omp:service:restart": ServiceActionRequest;
  "omp:service:uninstall": ServiceActionRequest;
  "app:update:get-state": DesktopUpdateRequest;
  "app:update:check": DesktopUpdateRequest;
  "app:update:download": DesktopUpdateRequest;
  "app:update:restart": DesktopUpdateRequest;
  "app:update:renderer-ready": DesktopUpdateRequest;
  "app:projection-cache:load": ProjectionCacheLoadRequest;
  "app:projection-cache:save": ProjectionCacheSaveRequest;
}
export interface DesktopInvokeResponseMap {
  "omp:targets:list": TargetListResult;
  "omp:targets:add": TargetAddResult;
  "omp:targets:remove": TargetRemoveResult;
  "omp:profiles:list": LocalProfileListResult;
  "omp:profiles:add": LocalProfileResult;
  "omp:profiles:update": LocalProfileResult;
  "omp:profiles:remove": LocalProfileRemoveResult;
  "omp:profiles:status": LocalProfileResult;
  "omp:profiles:start": LocalProfileResult;
  "omp:profiles:stop": LocalProfileResult;
  "omp:profiles:restart": LocalProfileResult;
  "omp:command": CommandResult;
  "omp:confirm": ConfirmResult;
  "omp:terminal:input": TerminalResult;
  "omp:terminal:resize": TerminalResult;
  "omp:terminal:close": TerminalResult;
  "omp:bootstrap": BootstrapResult;
  "omp:connect": ConnectResult;
  "omp:disconnect": DisconnectResult;
  "omp:pair": PairResult;
  "omp:pair-links:drain": PairLinksDrainResult;
  "omp:service:inspect": ServiceInspection;
  "omp:service:install": ServiceActionResult;
  "omp:service:start": ServiceActionResult;
  "omp:service:stop": ServiceActionResult;
  "omp:service:restart": ServiceActionResult;
  "omp:service:uninstall": ServiceActionResult;
  "omp:speech:speak": SpeechResult;
  "omp:speech:stop": SpeechResult;
  "app:update:get-state": DesktopUpdateState;
  "app:update:check": DesktopUpdateState;
  "app:update:download": DesktopUpdateState;
  "app:update:restart": DesktopUpdateState;
  "app:update:renderer-ready": DesktopUpdateRendererReadyResult;
  "app:projection-cache:load": ProjectionCacheLoadResult;
  "app:projection-cache:save": ProjectionCacheSaveResult;
}
export interface RendererServerEventEnvelope {
  targetId: string;
  event: RendererServerEvent;
}
export interface DesktopEventPayloadMap {
  "omp:server-event": RendererServerEventEnvelope;
  "omp:connection-state": ConnectionStateEvent;
  "omp:runtime-error": RuntimeErrorEvent;
  "omp:pair-link": PairLinkEvent;
  "app:update:state": DesktopUpdateState;
  "app:update:open": DesktopUpdateOpenEvent;
}
export type DesktopInvokeRequest<C extends DesktopInvokeChannel = DesktopInvokeChannel> = {
  channel: C;
  payload: DesktopInvokeRequestMap[C];
};
export type DesktopEvent<C extends DesktopEventChannel = DesktopEventChannel> = {
  channel: C;
  payload: DesktopEventPayloadMap[C];
};

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`unknown key: ${key}`);
}
function target(value: unknown): string {
  const s = controlFree(value, "targetId", 128);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(s)) return s;
  if (s.startsWith("local:") && s !== "local:default") {
    profileId(s.slice("local:".length));
    return s;
  }
  throw new Error("invalid targetId");
}
function remoteTarget(value: unknown): string {
  const id = target(value);
  if (id === "local" || id.startsWith("local:")) throw new Error("reserved targetId");
  return id;
}
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const WINDOWS_RESERVED_PROFILE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;
export function decodeLocalProfileId(value: unknown): string {
  const id = controlFree(value, "profileId", 64);
  if (
    id === "." ||
    id === ".." ||
    id.endsWith(".") ||
    !PROFILE_NAME.test(id) ||
    WINDOWS_RESERVED_PROFILE.test(id)
  )
    throw new Error("invalid profileId");
  return id;
}
function profileId(value: unknown): string {
  return decodeLocalProfileId(value);
}
function profileLabel(value: unknown): string {
  const label = controlFree(value, "profile label", 128).trim();
  if (label.length === 0) throw new Error("invalid profile label");
  return label;
}
function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`invalid ${name}`);
  return value;
}
function localProfileInput(value: unknown): LocalProfileAddRequest["profile"] {
  const item = object(value, "profile");
  exact(item, ["profileId", "label", "autoStart"]);
  const label = item.label === undefined ? undefined : profileLabel(item.label);
  const autoStart = optionalBoolean(item.autoStart, "autoStart");
  return {
    profileId: profileId(item.profileId),
    ...(label === undefined ? {} : { label }),
    ...(autoStart === undefined ? {} : { autoStart }),
  };
}
function localProfileChanges(value: unknown): LocalProfileUpdateRequest["changes"] {
  const item = object(value, "profile changes");
  exact(item, ["label", "autoStart"]);
  const label = item.label === undefined ? undefined : profileLabel(item.label);
  const autoStart = optionalBoolean(item.autoStart, "autoStart");
  if (label === undefined && autoStart === undefined) throw new Error("profile changes are empty");
  return {
    ...(label === undefined ? {} : { label }),
    ...(autoStart === undefined ? {} : { autoStart }),
  };
}
function state(value: unknown): ConnectionState {
  if (
    !["disconnected", "connecting", "connected", "pairing-required", "error"].includes(
      value as string,
    )
  )
    throw new Error("invalid state");
  return value as ConnectionState;
}

export function decodeDesktopUpdateRendererReadyResult(
  value: unknown,
): DesktopUpdateRendererReadyResult {
  const item = object(value, "desktop update renderer-ready result");
  exact(item, ["openSettings"]);
  if (typeof item.openSettings !== "boolean") {
    throw new Error("invalid desktop update renderer-ready result");
  }
  return Object.freeze({ openSettings: item.openSettings });
}
function targetRecord(value: unknown): TargetAddRequest["target"] {
  const item = object(value, "target");
  exact(item, [
    "targetId",
    "label",
    "mode",
    "address",
    "port",
    "expectedHostId",
    "requestedCapabilities",
    "grantedCapabilities",
    "status",
    "deviceId",
    "lastSeen",
    "autoConnect",
  ]);
  const mode = item.mode;
  if (mode !== "direct" && mode !== "serve") throw new Error("invalid target mode");
  const status = item.status;
  if (status !== "unknown" && status !== "online" && status !== "offline" && status !== "revoked")
    throw new Error("invalid target status");
  if (
    !Array.isArray(item.requestedCapabilities) ||
    !Array.isArray(item.grantedCapabilities) ||
    item.requestedCapabilities.length > 32 ||
    item.grantedCapabilities.length > 32
  )
    throw new Error("invalid target capabilities");
  const requestedCapabilities = item.requestedCapabilities.map((value) =>
    controlFree(value, "capability", 96),
  );
  const grantedCapabilities = item.grantedCapabilities.map((value) =>
    controlFree(value, "capability", 96),
  );
  const port = item.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("invalid target port");
  const label = controlFree(item.label, "label", 128);
  const address = controlFree(item.address, "address", 2048);
  if (
    item.lastSeen !== undefined &&
    (typeof item.lastSeen !== "number" || !Number.isFinite(item.lastSeen) || item.lastSeen < 0)
  )
    throw new Error("invalid target lastSeen");
  if (item.autoConnect !== undefined && typeof item.autoConnect !== "boolean")
    throw new Error("invalid autoConnect");
  return {
    targetId: remoteTarget(item.targetId),
    label,
    mode,
    address,
    port,
    requestedCapabilities,
    grantedCapabilities,
    status,
    ...(item.expectedHostId === undefined
      ? {}
      : { expectedHostId: controlFree(item.expectedHostId, "expectedHostId") }),
    ...(item.deviceId === undefined ? {} : { deviceId: controlFree(item.deviceId, "deviceId") }),
    ...(item.lastSeen === undefined ? {} : { lastSeen: item.lastSeen }),
    ...(item.autoConnect === undefined ? {} : { autoConnect: item.autoConnect }),
  };
}
function decodeConfirmRequest(payload: Record<string, unknown>): ConfirmRequest {
  exact(payload, ["targetId", "confirmationId", "commandId", "hostId", "sessionId", "decision"]);
  const decoded = decodeConfirm({
    v: PROTOCOL_VERSION,
    type: "confirm",
    requestId: "desktop-confirm",
    confirmationId: payload.confirmationId,
    commandId: payload.commandId,
    hostId: payload.hostId,
    ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
    decision: payload.decision,
  });
  return {
    targetId: target(payload.targetId),
    confirmationId: decoded.confirmationId,
    commandId: decoded.commandId,
    hostId: decoded.hostId,
    ...(decoded.sessionId === undefined ? {} : { sessionId: decoded.sessionId }),
    decision: decoded.decision,
  };
}
function decodeTerminalRequest(
  channel: "omp:terminal:input" | "omp:terminal:resize" | "omp:terminal:close",
  payload: Record<string, unknown>,
): TerminalInputRequest | TerminalResizeRequest | TerminalCloseRequest {
  const type =
    channel === "omp:terminal:input"
      ? "terminal.input"
      : channel === "omp:terminal:resize"
        ? "terminal.resize"
        : "terminal.close";
  exact(
    payload,
    channel === "omp:terminal:input"
      ? ["targetId", "hostId", "sessionId", "terminalId", "data", "encoding"]
      : channel === "omp:terminal:resize"
        ? ["targetId", "hostId", "sessionId", "terminalId", "cols", "rows"]
        : ["targetId", "hostId", "sessionId", "terminalId", "reason"],
  );
  const decoded = decodeTerminalClient({
    v: PROTOCOL_VERSION,
    type,
    hostId: payload.hostId,
    sessionId: payload.sessionId,
    terminalId: payload.terminalId,
    ...(type === "terminal.input"
      ? {
          data: payload.data,
          ...(payload.encoding === undefined ? {} : { encoding: payload.encoding }),
        }
      : {}),
    ...(type === "terminal.resize" ? { cols: payload.cols, rows: payload.rows } : {}),
    ...(type === "terminal.close" && payload.reason !== undefined
      ? { reason: payload.reason }
      : {}),
  });
  const common = {
    targetId: target(payload.targetId),
    hostId: decoded.hostId,
    sessionId: decoded.sessionId,
    terminalId: decoded.terminalId,
  };
  if (decoded.type === "terminal.input")
    return {
      ...common,
      data: decoded.data,
      ...(decoded.encoding === undefined ? {} : { encoding: decoded.encoding }),
    };
  if (decoded.type === "terminal.resize")
    return { ...common, cols: decoded.cols, rows: decoded.rows };
  return { ...common, ...(decoded.reason === undefined ? {} : { reason: decoded.reason }) };
}

export function decodeSpeechText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid speech text");
  if (utf8ByteLength(value) > MAX_SPEECH_TEXT_BYTES) throw new Error("speech text is too long");
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      throw new Error("speech text contains unsupported control characters");
    }
  }
  return value;
}
function projectionCacheSerialized(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > MAX_PROJECTION_CACHE_BYTES)
    throw new Error("invalid projection cache value");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid projection cache value");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid projection cache value");
  const root = object(parsed, "projection cache");
  const data = root.data;
  if (
    root.kind !== "t4-code-projection" ||
    root.version !== 1 ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  )
    throw new Error("invalid projection cache value");
  return value;
}
export function decodeProjectionCacheLoadResult(value: unknown): ProjectionCacheLoadResult {
  const result = object(value, "projection cache load result");
  exact(result, ["available", "value"]);
  const available = result.available;
  const cacheValue = result.value;
  if (typeof available !== "boolean" || (cacheValue !== null && typeof cacheValue !== "string"))
    throw new Error("invalid projection cache load result");
  if (cacheValue !== null) projectionCacheSerialized(cacheValue);
  if (!available && cacheValue !== null) throw new Error("invalid projection cache load result");
  return Object.freeze({ available, value: cacheValue });
}
export function decodeProjectionCacheSaveResult(value: unknown): ProjectionCacheSaveResult {
  const result = object(value, "projection cache save result");
  exact(result, ["saved"]);
  const saved = result.saved;
  if (typeof saved !== "boolean") throw new Error("invalid projection cache save result");
  return Object.freeze({ saved });
}
export function decodeProjectionCacheSaveRequestValue(value: unknown): string {
  return projectionCacheSerialized(value);
}
export function decodeDesktopInvokeRequest(input: unknown): DesktopInvokeRequest {
  const frame = inputObject(input);
  exact(frame, ["channel", "payload"]);
  if (!(DESKTOP_IPC_CHANNELS as readonly string[]).includes(frame.channel as string))
    throw new Error("unknown channel");
  const channel = frame.channel as DesktopInvokeChannel;
  const payload = object(frame.payload, "payload");
  switch (channel) {
    case "omp:targets:list":
    case "omp:profiles:list":
      exact(payload, []);
      return { channel, payload: {} };
    case "omp:targets:add":
      exact(payload, ["target"]);
      return { channel, payload: { target: targetRecord(payload.target) } };
    case "omp:targets:remove":
    case "omp:connect":
    case "omp:disconnect":
      exact(payload, ["targetId"]);
      return { channel, payload: { targetId: target(payload.targetId) } };
    case "omp:profiles:add":
      exact(payload, ["profile"]);
      return { channel, payload: { profile: localProfileInput(payload.profile) } };
    case "omp:profiles:update":
      exact(payload, ["profileId", "changes"]);
      return {
        channel,
        payload: {
          profileId: profileId(payload.profileId),
          changes: localProfileChanges(payload.changes),
        },
      };
    case "omp:profiles:remove":
    case "omp:profiles:status":
    case "omp:profiles:start":
    case "omp:profiles:stop":
    case "omp:profiles:restart":
      exact(payload, ["profileId"]);
      return { channel, payload: { profileId: profileId(payload.profileId) } };
    case "omp:pair":
      exact(payload, ["targetId", "code"]);
      {
        const code = controlFree(payload.code, "code", 6);
        if (!/^\d{6}$/u.test(code)) throw new Error("invalid pairing code");
        return { channel, payload: { targetId: target(payload.targetId), code } };
      }
    case "omp:speech:speak":
      exact(payload, ["text"]);
      return { channel, payload: { text: decodeSpeechText(payload.text) } };
    case "omp:speech:stop":
      exact(payload, []);
      return { channel, payload: {} };
    case "omp:bootstrap":
    case "omp:pair-links:drain":
    case "omp:service:inspect":
    case "omp:service:install":
    case "omp:service:start":
    case "omp:service:stop":
    case "omp:service:restart":
    case "omp:service:uninstall":
    case "app:update:get-state":
    case "app:update:check":
    case "app:update:download":
    case "app:update:restart":
    case "app:update:renderer-ready":
      exact(payload, []);
      return { channel, payload: {} };
    case "app:projection-cache:load":
      exact(payload, []);
      return { channel, payload: {} };
    case "app:projection-cache:save":
      exact(payload, ["value"]);
      return { channel, payload: { value: projectionCacheSerialized(payload.value) } };
    case "omp:command":
      exact(payload, ["targetId", "intent"]);
      {
        const intent = object(payload.intent, "intent");
        exact(intent, [
          "hostId",
          "sessionId",
          "command",
          "expectedRevision",
          "confirmationId",
          "args",
        ]);
        const command = decodeCommand({
          v: PROTOCOL_VERSION,
          type: "command",
          requestId: "desktop-request",
          commandId: "desktop-command",
          ...intent,
        });
        const { v, type, requestId, commandId, ...clean } = command;
        void v;
        void type;
        void requestId;
        void commandId;
        return { channel, payload: { targetId: target(payload.targetId), intent: clean } };
      }
    case "omp:confirm":
      return { channel, payload: decodeConfirmRequest(payload) };
    case "omp:terminal:input":
    case "omp:terminal:resize":
    case "omp:terminal:close":
      return { channel, payload: decodeTerminalRequest(channel, payload) };
  }
  throw new Error("unsupported desktop channel");
}
export function decodeDesktopEvent(input: unknown): DesktopEvent {
  const frame = inputObject(input);
  exact(frame, ["channel", "payload"]);
  if (!(DESKTOP_IPC_EVENTS as readonly string[]).includes(frame.channel as string))
    throw new Error("unknown channel");
  const channel = frame.channel as DesktopEventChannel;
  const payload = object(frame.payload, "payload");
  if (channel === "omp:server-event") {
    exact(payload, ["targetId", "event"]);
    const rawEvent = object(payload.event, "event");
    exact(rawEvent, ["kind", "payload"]);
    const eventPayload = object(rawEvent.payload, "event.payload");
    if ("v" in eventPayload || "type" in eventPayload) {
      throw new Error("wire envelope fields cannot cross renderer IPC");
    }
    const kind = controlFree(rawEvent.kind, "event.kind", 128);
    if (kind === "pair.ok")
      throw new Error("pair credentials cannot cross renderer IPC");
    const event = Object.freeze({
      kind,
      payload: Object.freeze(eventPayload),
    }) as RendererServerEvent;
    return {
      channel,
      payload: {
        targetId: target(payload.targetId),
        event,
      },
    };
  }
  if (channel === "omp:connection-state") {
    exact(payload, ["targetId", "state"]);
    return {
      channel,
      payload: { targetId: target(payload.targetId), state: state(payload.state) },
    };
  }
  if (channel === "omp:pair-link") return { channel, payload: decodePairLinkEvent(payload) };
  if (channel === "app:update:state") {
    return { channel, payload: decodeDesktopUpdateState(payload) };
  }
  if (channel === "app:update:open") {
    exact(payload, ["source"]);
    if (payload.source !== "menu") throw new Error("invalid desktop update open source");
    return { channel, payload: Object.freeze({ source: "menu" as const }) };
  }
  exact(payload, ["targetId", "code", "message"]);
  if (!["transport", "protocol", "internal"].includes(payload.code as string))
    throw new Error("invalid error code");
  const error = {
    code: payload.code as RuntimeErrorCode,
    message: controlFree(payload.message, "message", 2048),
    ...(payload.targetId === undefined ? {} : { targetId: target(payload.targetId) }),
  };
  return { channel, payload: error };
}
export const isDesktopInvokeRequest = (v: unknown): v is DesktopInvokeRequest => {
  try {
    decodeDesktopInvokeRequest(v);
    return true;
  } catch {
    return false;
  }
};
export const isDesktopEvent = (v: unknown): v is DesktopEvent => {
  try {
    decodeDesktopEvent(v);
    return true;
  } catch {
    return false;
  }
};
