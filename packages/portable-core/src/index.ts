export type DecodePathSegment = string | number;
export type DecodePath = readonly DecodePathSegment[];

function displayPath(path: DecodePath): string {
  return path.reduce<string>((result, segment) =>
    typeof segment === "number" ? `${result}[${segment}]` : `${result}.${segment}`, "$"
  );
}

export class PortableDecodeError extends TypeError {
  readonly path: DecodePath;
  readonly expected: string;
  readonly value: unknown;

  constructor(path: DecodePath, expected: string, value: unknown) {
    super(`${displayPath(path)}: expected ${expected}`);
    this.name = "PortableDecodeError";
    this.path = Object.freeze([...path]);
    this.expected = expected;
    this.value = value;
  }
}

export type Decoder<T> = (value: unknown) => T;
export type OpaqueId = string;
export type ScopeId = OpaqueId;
export type WorkspaceId = OpaqueId;
export type RuntimeId = OpaqueId;
export type HostProfileId = OpaqueId;
export type Revision = string;
export type Generation = string;
export type CapabilityCode = string;
export type Timestamp = string;
export type DesiredState = "Running" | "Sleeping" | "Stopped";
export type Phase = "Pending" | "Provisioning" | "Starting" | "Ready" | "Sleeping" | "Stopped" | "Deleting" | "Unavailable" | "Degraded" | "Failed";
export type ConditionStatus = "True" | "False" | "Unknown";
export type ScopeKind = "Personal" | "Team";
export type WorkspaceRetention = "Retain" | "Delete";
export type BrowserPolicy = "Allowed" | "Disabled";

export interface Condition {
  readonly [key: string]: unknown;
  readonly type: CapabilityCode;
  readonly status: ConditionStatus;
  readonly reason: CapabilityCode;
  readonly message?: string;
  readonly lastTransitionTime: Timestamp;
}

export interface MachineProviderCapabilities {
  readonly [key: string]: unknown;
  readonly versions: readonly [1];
  readonly capabilities: readonly CapabilityCode[];
}

export interface NumericProtocolCapabilities<Version extends 1 | 10> {
  readonly [key: string]: unknown;
  readonly versions: readonly [Version];
}

export interface CapabilitiesProtocols {
  readonly [key: string]: unknown;
  readonly machineProvider: MachineProviderCapabilities;
  readonly cmux: NumericProtocolCapabilities<10>;
  readonly ompApp: NumericProtocolCapabilities<1>;
}

export interface CapabilityLimits {
  readonly [key: string]: unknown;
  readonly maxActiveRuntimes: number;
  readonly maxRetainedRuntimes: number;
  readonly idempotencyRetentionSeconds: number;
  readonly eventRetentionSeconds: number;
  readonly maxPageSize: number;
}

export interface CapabilityFeatures {
  readonly [key: string]: unknown;
  readonly restLifecycle: boolean;
  readonly sshProvider: boolean;
  readonly directCmuxWebSocket: boolean;
  readonly browser: boolean;
  readonly scaleToZero: boolean;
}

export type StorageCapabilityState = "Supported" | "Unsupported" | "Unknown";

export interface StorageCapabilityObservation {
  readonly state: StorageCapabilityState;
  readonly reason?: string;
}

export interface StorageCapabilities {
  readonly workspaceReadWriteMany: StorageCapabilityObservation;
  readonly runtimeStateAccessModes: readonly ("ReadWriteOncePod" | "ReadWriteOnce")[];
  readonly runtimeStateReattach: StorageCapabilityObservation;
  readonly onlineExpansion: StorageCapabilityObservation;
  readonly volumeSnapshots: StorageCapabilityObservation;
  readonly snapshotDataSource: StorageCapabilityObservation;
  readonly observedAt: Timestamp;
}

export interface Capabilities {
  readonly [key: string]: unknown;
  readonly apiVersion: "v1";
  readonly protocols: CapabilitiesProtocols;
  readonly limits: CapabilityLimits;
  readonly features: CapabilityFeatures;
  readonly storage?: StorageCapabilities;
}

export interface Scope {
  readonly [key: string]: unknown;
  readonly id: ScopeId;
  readonly displayName: string;
  readonly kind: ScopeKind;
  readonly revision: Revision;
}

export interface Workspace {
  readonly [key: string]: unknown;
  readonly id: WorkspaceId;
  readonly scopeId: ScopeId;
  readonly displayName: string;
  readonly capacityBytes: number;
  readonly retention: WorkspaceRetention;
  readonly phase: Phase;
  readonly attachmentCount: number;
  readonly revision: Revision;
  readonly conditions: readonly Condition[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface Runtime {
  readonly [key: string]: unknown;
  readonly id: RuntimeId;
  readonly scopeId: ScopeId;
  readonly displayName: string;
  readonly workspaceId: WorkspaceId;
  readonly hostProfileId: HostProfileId;
  readonly desiredState: DesiredState;
  readonly phase: Phase;
  readonly generation: Generation;
  readonly revision: Revision;
  readonly capabilities: readonly CapabilityCode[];
  readonly conditions: readonly Condition[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface WorkspaceCreate {
  readonly scopeId: ScopeId;
  readonly displayName: string;
  readonly capacityBytes: number;
  readonly retention: WorkspaceRetention;
}

export interface WorkspacePatch {
  readonly displayName?: string;
  readonly retention?: WorkspaceRetention;
}

export interface IdlePolicyDisabled {
  readonly enabled: false;
}

export interface IdlePolicyEnabled {
  readonly enabled: true;
  readonly idleSeconds: number;
}

export type IdlePolicy = IdlePolicyDisabled | IdlePolicyEnabled;

export interface RuntimeResourceDemand {
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly gpuUnits: number;
}

export interface ScopeCreationRatePolicy {
  readonly windowSeconds: number;
  readonly burst: number;
  readonly maximumRetryAfterSeconds: number;
}

/** Operator-controlled, per-scope admission limits. Zero disables the corresponding capacity. */
export interface ScopeAdmissionPolicy {
  readonly maxActiveRuntimes: number;
  readonly maxRetainedRuntimes: number;
  readonly maxWorkspaceCapacityBytes: number;
  readonly maxCpuMillis: number;
  readonly maxMemoryBytes: number;
  readonly maxGpuUnits: number;
  readonly browserEnabled: boolean;
  readonly runtimeResources: RuntimeResourceDemand;
  readonly creationRate: ScopeCreationRatePolicy;
}

export type AdmissionDenialReason =
  | "active_runtime_limit"
  | "retained_runtime_limit"
  | "workspace_capacity_limit"
  | "cpu_limit"
  | "memory_limit"
  | "gpu_limit"
  | "browser_disabled"
  | "creation_rate_limit"
  | "admission_unavailable";

export interface RuntimeCreate {
  readonly scopeId: ScopeId;
  readonly displayName: string;
  readonly workspaceId: WorkspaceId;
  readonly hostProfileId: HostProfileId;
  readonly desiredState: DesiredState;
  readonly browserPolicy: BrowserPolicy;
  readonly idlePolicy?: IdlePolicy;
}

export interface RuntimePatch {
  readonly displayName?: string;
  readonly desiredState?: DesiredState;
  readonly browserPolicy?: BrowserPolicy;
  readonly idlePolicy?: IdlePolicy;
}

export interface PageCursor {
  readonly [key: string]: unknown;
  readonly nextCursor?: string;
}

export interface Page<T> extends PageCursor {
  readonly items: readonly T[];
}

export type ScopePage = Page<Scope>;
export type WorkspacePage = Page<Workspace>;
export type RuntimePage = Page<Runtime>;

export interface ProblemDetails {
  readonly [key: string]: unknown;
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly currentRevision?: Revision;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}$/u;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,63}$/u;
const CAPABILITY_CODE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const CURSOR = /^[A-Za-z0-9_-]+={0,2}$/u;
const PROBLEM_CODE = /^[a-z][a-z0-9_]{0,127}$/u;
const RFC3339 = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
const URI_REFERENCE = /^(?:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+$/u;
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]|%[0-9A-Fa-f]{2})*$/u;
const UTC_LEAP_SECOND_DATES: Readonly<Record<string, true>> = {
  "1972-06-30": true,
  "1972-12-31": true,
  "1973-12-31": true,
  "1974-12-31": true,
  "1975-12-31": true,
  "1976-12-31": true,
  "1977-12-31": true,
  "1978-12-31": true,
  "1979-12-31": true,
  "1981-06-30": true,
  "1982-06-30": true,
  "1983-06-30": true,
  "1985-06-30": true,
  "1987-12-31": true,
  "1989-12-31": true,
  "1990-12-31": true,
  "1992-06-30": true,
  "1993-06-30": true,
  "1994-06-30": true,
  "1995-12-31": true,
  "1997-06-30": true,
  "1998-12-31": true,
  "2005-12-31": true,
  "2008-12-31": true,
  "2012-06-30": true,
  "2015-06-30": true,
  "2016-12-31": true,
};
const DESIRED_STATES: Record<DesiredState, true> = { Running: true, Sleeping: true, Stopped: true };
const PHASES: Record<Phase, true> = {
  Pending: true,
  Provisioning: true,
  Starting: true,
  Ready: true,
  Sleeping: true,
  Stopped: true,
  Deleting: true,
  Unavailable: true,
  Degraded: true,
  Failed: true,
};
const CONDITION_STATUSES: Record<ConditionStatus, true> = { True: true, False: true, Unknown: true };
const SCOPE_KINDS: Record<ScopeKind, true> = { Personal: true, Team: true };
const WORKSPACE_RETENTIONS: Record<WorkspaceRetention, true> = { Retain: true, Delete: true };
const BROWSER_POLICIES: Record<BrowserPolicy, true> = { Allowed: true, Disabled: true };

function fail(path: DecodePath, expected: string, value: unknown): never {
  throw new PortableDecodeError(path, expected, value);
}

function record(value: unknown, path: DecodePath): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "an object", value);
  return value as Record<string, unknown>;
}

function own(item: Record<string, unknown>, key: string, path: DecodePath): unknown {
  if (!Object.prototype.hasOwnProperty.call(item, key)) fail([...path, key], "a required property", undefined);
  return item[key];
}

function exactKeys(item: Record<string, unknown>, allowed: readonly string[], path: DecodePath): void {
  for (const key of Object.keys(item)) if (!allowed.includes(key)) fail([...path, key], "no additional property", item[key]);
}

function unicodeLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) index += 1;
    }
    length += 1;
  }
  return length;
}

function text(value: unknown, minimum: number, maximum: number, path: DecodePath, pattern?: RegExp): string {
  if (typeof value !== "string") fail(path, `a string of length ${minimum}..${maximum}`, value);
  const length = unicodeLength(value);
  if (length < minimum || length > maximum || (pattern !== undefined && !pattern.test(value))) {
    fail(path, `a string of length ${minimum}..${maximum}${pattern === undefined ? "" : ` matching ${pattern}`}`, value);
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, path: DecodePath): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) fail(path, `a safe integer in ${minimum}..${maximum}`, value);
  return value as number;
}

function boolean(value: unknown, path: DecodePath): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean", value);
  return value;
}

function literal<T extends string | number | boolean>(value: unknown, expected: T, path: DecodePath): T {
  if (value !== expected) fail(path, JSON.stringify(expected), value);
  return expected;
}

function optional<T>(item: Record<string, unknown>, key: string, path: DecodePath, decode: (value: unknown, path: DecodePath) => T): T | undefined {
  return Object.prototype.hasOwnProperty.call(item, key) ? decode(item[key], [...path, key]) : undefined;
}

function array<T>(value: unknown, maximum: number, path: DecodePath, decode: (value: unknown, path: DecodePath) => T, unique = false): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, `an array with at most ${maximum} items`, value);
  const seen = unique ? new Set<unknown>() : undefined;
  for (let index = 0; index < value.length; index += 1) {
    const entry: unknown = value[index];
    decode(entry, [...path, index]);
    if (seen?.has(entry) === true) fail([...path, index], "a unique item", entry);
    seen?.add(entry);
  }
  return value as readonly T[];
}

function enumValue<T extends string>(value: unknown, values: Readonly<Record<string, true>>, path: DecodePath, name: string): T {
  if (typeof value !== "string" || values[value] !== true) fail(path, name, value);
  return value as T;
}

function decodeOpaqueIdAt(value: unknown, path: DecodePath): OpaqueId { return text(value, 1, 128, path, OPAQUE_ID); }
function decodeRevisionAt(value: unknown, path: DecodePath): Revision { return text(value, 1, 128, path, REVISION); }
function decodeGenerationAt(value: unknown, path: DecodePath): Generation { return text(value, 1, 64, path, GENERATION); }
function decodeCapabilityCodeAt(value: unknown, path: DecodePath): CapabilityCode { return text(value, 1, 128, path, CAPABILITY_CODE); }
function decodeDisplayNameAt(value: unknown, path: DecodePath): string { return text(value, 1, 128, path); }
function decodeDesiredStateAt(value: unknown, path: DecodePath): DesiredState { return enumValue(value, DESIRED_STATES, path, "DesiredState"); }
function decodePhaseAt(value: unknown, path: DecodePath): Phase { return enumValue(value, PHASES, path, "Phase"); }

function decodeTimestampAt(value: unknown, path: DecodePath): Timestamp {
  const result = text(value, 1, 64, path);
  const parts = RFC3339.exec(result);
  if (parts === null) fail(path, "a calendar-valid RFC3339 timestamp", value);
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) fail(path, "a calendar-valid RFC3339 timestamp", value);
  if (/:60(?=(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$)/u.test(result)) {
    const normalized = new Date(result.replace(":60", ":59"));
    const utcDate = Number.isFinite(normalized.getTime()) ? normalized.toISOString().slice(0, 10) : "";
    if (normalized.getUTCHours() !== 23 || normalized.getUTCMinutes() !== 59 || normalized.getUTCSeconds() !== 59 ||
      UTC_LEAP_SECOND_DATES[utcDate] !== true) fail(path, "a calendar-valid RFC3339 timestamp", value);
  }
  return result;
}

function decodeConditionAt(value: unknown, path: DecodePath): Condition {
  const item = record(value, path);
  decodeCapabilityCodeAt(own(item, "type", path), [...path, "type"]);
  enumValue(own(item, "status", path), CONDITION_STATUSES, [...path, "status"], "ConditionStatus");
  decodeCapabilityCodeAt(own(item, "reason", path), [...path, "reason"]);
  optional(item, "message", path, (entry, entryPath) => text(entry, 1, 1024, entryPath));
  decodeTimestampAt(own(item, "lastTransitionTime", path), [...path, "lastTransitionTime"]);
  return item as unknown as Condition;
}

function oneVersion(value: unknown, expected: 1 | 10, path: DecodePath): void {
  if (!Array.isArray(value) || value.length !== 1) fail(path, "an array containing exactly one protocol version", value);
  literal(value[0], expected, [...path, 0]);
}

function decodeStorageCapabilityObservationAt(value: unknown, path: DecodePath): StorageCapabilityObservation {
  const item = record(value, path);
  const state = own(item, "state", path);
  if (state !== "Supported" && state !== "Unsupported" && state !== "Unknown") fail([...path, "state"], "StorageCapabilityState", state);
  optional(item, "reason", path, (candidate, candidatePath) => text(candidate, 1, 64, candidatePath));
  return item as unknown as StorageCapabilityObservation;
}

function decodeRuntimeStateAccessModeAt(value: unknown, path: DecodePath): "ReadWriteOncePod" | "ReadWriteOnce" {
  if (value !== "ReadWriteOncePod" && value !== "ReadWriteOnce") fail(path, "a runtime-state access mode", value);
  return value;
}

function decodeStorageCapabilitiesAt(value: unknown, path: DecodePath): StorageCapabilities {
  const item = record(value, path);
  for (const key of ["workspaceReadWriteMany", "runtimeStateReattach", "onlineExpansion", "volumeSnapshots", "snapshotDataSource"] as const) {
    decodeStorageCapabilityObservationAt(own(item, key, path), [...path, key]);
  }
  array(own(item, "runtimeStateAccessModes", path), 2, [...path, "runtimeStateAccessModes"], decodeRuntimeStateAccessModeAt, true);
  decodeTimestampAt(own(item, "observedAt", path), [...path, "observedAt"]);
  return item as unknown as StorageCapabilities;
}

function decodeCapabilitiesAt(value: unknown, path: DecodePath): Capabilities {
  const item = record(value, path);
  literal(own(item, "apiVersion", path), "v1", [...path, "apiVersion"]);
  const protocols = record(own(item, "protocols", path), [...path, "protocols"]);
  const machineProvider = record(own(protocols, "machineProvider", [...path, "protocols"]), [...path, "protocols", "machineProvider"]);
  oneVersion(own(machineProvider, "versions", [...path, "protocols", "machineProvider"]), 1, [...path, "protocols", "machineProvider", "versions"]);
  array(own(machineProvider, "capabilities", [...path, "protocols", "machineProvider"]), 64, [...path, "protocols", "machineProvider", "capabilities"], decodeCapabilityCodeAt, true);
  const cmux = record(own(protocols, "cmux", [...path, "protocols"]), [...path, "protocols", "cmux"]);
  oneVersion(own(cmux, "versions", [...path, "protocols", "cmux"]), 10, [...path, "protocols", "cmux", "versions"]);
  const ompApp = record(own(protocols, "ompApp", [...path, "protocols"]), [...path, "protocols", "ompApp"]);
  oneVersion(own(ompApp, "versions", [...path, "protocols", "ompApp"]), 1, [...path, "protocols", "ompApp", "versions"]);
  const limits = record(own(item, "limits", path), [...path, "limits"]);
  integer(own(limits, "maxActiveRuntimes", [...path, "limits"]), 0, 100_000, [...path, "limits", "maxActiveRuntimes"]);
  integer(own(limits, "maxRetainedRuntimes", [...path, "limits"]), 0, 1_000_000, [...path, "limits", "maxRetainedRuntimes"]);
  integer(own(limits, "idempotencyRetentionSeconds", [...path, "limits"]), 86_400, 31_536_000, [...path, "limits", "idempotencyRetentionSeconds"]);
  integer(own(limits, "eventRetentionSeconds", [...path, "limits"]), 60, 2_592_000, [...path, "limits", "eventRetentionSeconds"]);
  integer(own(limits, "maxPageSize", [...path, "limits"]), 1, 200, [...path, "limits", "maxPageSize"]);
  const features = record(own(item, "features", path), [...path, "features"]);
  for (const key of ["restLifecycle", "sshProvider", "directCmuxWebSocket", "browser", "scaleToZero"] as const) boolean(own(features, key, [...path, "features"]), [...path, "features", key]);
  optional(item, "storage", path, decodeStorageCapabilitiesAt);
  return item as unknown as Capabilities;
}

function decodeScopeAt(value: unknown, path: DecodePath): Scope {
  const item = record(value, path);
  decodeOpaqueIdAt(own(item, "id", path), [...path, "id"]);
  decodeDisplayNameAt(own(item, "displayName", path), [...path, "displayName"]);
  enumValue(own(item, "kind", path), SCOPE_KINDS, [...path, "kind"], "ScopeKind");
  decodeRevisionAt(own(item, "revision", path), [...path, "revision"]);
  return item as unknown as Scope;
}

function decodeWorkspaceAt(value: unknown, path: DecodePath): Workspace {
  const item = record(value, path);
  decodeOpaqueIdAt(own(item, "id", path), [...path, "id"]);
  decodeOpaqueIdAt(own(item, "scopeId", path), [...path, "scopeId"]);
  decodeDisplayNameAt(own(item, "displayName", path), [...path, "displayName"]);
  integer(own(item, "capacityBytes", path), 1_048_576, 1_125_899_906_842_624, [...path, "capacityBytes"]);
  enumValue(own(item, "retention", path), WORKSPACE_RETENTIONS, [...path, "retention"], "WorkspaceRetention");
  decodePhaseAt(own(item, "phase", path), [...path, "phase"]);
  integer(own(item, "attachmentCount", path), 0, 100_000, [...path, "attachmentCount"]);
  decodeRevisionAt(own(item, "revision", path), [...path, "revision"]);
  array(own(item, "conditions", path), 64, [...path, "conditions"], decodeConditionAt);
  decodeTimestampAt(own(item, "createdAt", path), [...path, "createdAt"]);
  decodeTimestampAt(own(item, "updatedAt", path), [...path, "updatedAt"]);
  return item as unknown as Workspace;
}

function decodeRuntimeAt(value: unknown, path: DecodePath): Runtime {
  const item = record(value, path);
  decodeOpaqueIdAt(own(item, "id", path), [...path, "id"]);
  decodeOpaqueIdAt(own(item, "scopeId", path), [...path, "scopeId"]);
  decodeDisplayNameAt(own(item, "displayName", path), [...path, "displayName"]);
  decodeOpaqueIdAt(own(item, "workspaceId", path), [...path, "workspaceId"]);
  decodeOpaqueIdAt(own(item, "hostProfileId", path), [...path, "hostProfileId"]);
  decodeDesiredStateAt(own(item, "desiredState", path), [...path, "desiredState"]);
  decodePhaseAt(own(item, "phase", path), [...path, "phase"]);
  decodeGenerationAt(own(item, "generation", path), [...path, "generation"]);
  decodeRevisionAt(own(item, "revision", path), [...path, "revision"]);
  array(own(item, "capabilities", path), 64, [...path, "capabilities"], decodeCapabilityCodeAt, true);
  array(own(item, "conditions", path), 64, [...path, "conditions"], decodeConditionAt);
  decodeTimestampAt(own(item, "createdAt", path), [...path, "createdAt"]);
  decodeTimestampAt(own(item, "updatedAt", path), [...path, "updatedAt"]);
  return item as unknown as Runtime;
}

function decodeIdlePolicyAt(value: unknown, path: DecodePath): IdlePolicy {
  const item = record(value, path);
  const enabled = own(item, "enabled", path);
  if (enabled === false) {
    exactKeys(item, ["enabled"], path);
    return item as unknown as IdlePolicyDisabled;
  }
  if (enabled === true) {
    exactKeys(item, ["enabled", "idleSeconds"], path);
    integer(own(item, "idleSeconds", path), 60, 2_592_000, [...path, "idleSeconds"]);
    return item as unknown as IdlePolicyEnabled;
  }
  fail([...path, "enabled"], "true or false", enabled);
}

function decodeRuntimeResourceDemandAt(value: unknown, path: DecodePath): RuntimeResourceDemand {
  const item = record(value, path);
  exactKeys(item, ["cpuMillis", "memoryBytes", "gpuUnits"], path);
  integer(own(item, "cpuMillis", path), 0, 1_000_000_000, [...path, "cpuMillis"]);
  integer(own(item, "memoryBytes", path), 0, Number.MAX_SAFE_INTEGER, [...path, "memoryBytes"]);
  integer(own(item, "gpuUnits", path), 0, 1_000_000, [...path, "gpuUnits"]);
  return item as unknown as RuntimeResourceDemand;
}

function decodeScopeCreationRatePolicyAt(value: unknown, path: DecodePath): ScopeCreationRatePolicy {
  const item = record(value, path);
  exactKeys(item, ["windowSeconds", "burst", "maximumRetryAfterSeconds"], path);
  integer(own(item, "windowSeconds", path), 1, 86_400, [...path, "windowSeconds"]);
  integer(own(item, "burst", path), 1, 100_000, [...path, "burst"]);
  integer(own(item, "maximumRetryAfterSeconds", path), 1, 300, [...path, "maximumRetryAfterSeconds"]);
  return item as unknown as ScopeCreationRatePolicy;
}

function decodeScopeAdmissionPolicyAt(value: unknown, path: DecodePath): ScopeAdmissionPolicy {
  const item = record(value, path);
  exactKeys(item, [
    "maxActiveRuntimes", "maxRetainedRuntimes", "maxWorkspaceCapacityBytes",
    "maxCpuMillis", "maxMemoryBytes", "maxGpuUnits", "browserEnabled",
    "runtimeResources", "creationRate",
  ], path);
  integer(own(item, "maxActiveRuntimes", path), 0, 100_000, [...path, "maxActiveRuntimes"]);
  integer(own(item, "maxRetainedRuntimes", path), 0, 100_000, [...path, "maxRetainedRuntimes"]);
  integer(own(item, "maxWorkspaceCapacityBytes", path), 0, Number.MAX_SAFE_INTEGER, [...path, "maxWorkspaceCapacityBytes"]);
  integer(own(item, "maxCpuMillis", path), 0, 1_000_000_000, [...path, "maxCpuMillis"]);
  integer(own(item, "maxMemoryBytes", path), 0, Number.MAX_SAFE_INTEGER, [...path, "maxMemoryBytes"]);
  integer(own(item, "maxGpuUnits", path), 0, 1_000_000, [...path, "maxGpuUnits"]);
  boolean(own(item, "browserEnabled", path), [...path, "browserEnabled"]);
  decodeRuntimeResourceDemandAt(own(item, "runtimeResources", path), [...path, "runtimeResources"]);
  decodeScopeCreationRatePolicyAt(own(item, "creationRate", path), [...path, "creationRate"]);
  return item as unknown as ScopeAdmissionPolicy;
}

function decodePageCursorAt(value: unknown, path: DecodePath): PageCursor {
  const item = record(value, path);
  optional(item, "nextCursor", path, (entry, entryPath) => text(entry, 1, 512, entryPath, CURSOR));
  return item as unknown as PageCursor;
}

function decodePageAt<T>(value: unknown, path: DecodePath, decodeItem: (value: unknown, path: DecodePath) => T): Page<T> {
  const item = decodePageCursorAt(value, path) as unknown as Record<string, unknown>;
  array(own(item, "items", path), 200, [...path, "items"], decodeItem);
  return item as unknown as Page<T>;
}

function validUri(value: unknown, path: DecodePath, reference: boolean): string {
  const result = text(value, 1, 2048, path);
  const expected = reference ? "an RFC 3986 URI-reference" : "an absolute RFC 3986 URI";
  if (!(reference ? URI_REFERENCE : ABSOLUTE_URI).test(result)) fail(path, expected, value);
  try {
    if (reference) new URL(result, "https://portable.invalid/");
    else new URL(result);
  } catch {
    fail(path, expected, value);
  }
  return result;
}

export const decodeOpaqueId: Decoder<OpaqueId> = (value) => decodeOpaqueIdAt(value, []);
export const decodeRevision: Decoder<Revision> = (value) => decodeRevisionAt(value, []);
export const decodeGeneration: Decoder<Generation> = (value) => decodeGenerationAt(value, []);
export const decodeCapabilityCode: Decoder<CapabilityCode> = (value) => decodeCapabilityCodeAt(value, []);
export const decodeTimestamp: Decoder<Timestamp> = (value) => decodeTimestampAt(value, []);
export const decodeDesiredState: Decoder<DesiredState> = (value) => decodeDesiredStateAt(value, []);
export const decodePhase: Decoder<Phase> = (value) => decodePhaseAt(value, []);
export const decodeCondition: Decoder<Condition> = (value) => decodeConditionAt(value, []);
export const decodeCapabilities: Decoder<Capabilities> = (value) => decodeCapabilitiesAt(value, []);
export const decodeScope: Decoder<Scope> = (value) => decodeScopeAt(value, []);
export const decodeWorkspace: Decoder<Workspace> = (value) => decodeWorkspaceAt(value, []);
export const decodeRuntime: Decoder<Runtime> = (value) => decodeRuntimeAt(value, []);
export const decodeIdlePolicy: Decoder<IdlePolicy> = (value) => decodeIdlePolicyAt(value, []);
export const decodeRuntimeResourceDemand: Decoder<RuntimeResourceDemand> = (value) => decodeRuntimeResourceDemandAt(value, []);
export const decodeScopeCreationRatePolicy: Decoder<ScopeCreationRatePolicy> = (value) => decodeScopeCreationRatePolicyAt(value, []);
export const decodeScopeAdmissionPolicy: Decoder<ScopeAdmissionPolicy> = (value) => decodeScopeAdmissionPolicyAt(value, []);
export const decodePageCursor: Decoder<PageCursor> = (value) => decodePageCursorAt(value, []);
export const decodeScopePage: Decoder<ScopePage> = (value) => decodePageAt(value, [], decodeScopeAt);
export const decodeWorkspacePage: Decoder<WorkspacePage> = (value) => decodePageAt(value, [], decodeWorkspaceAt);
export const decodeRuntimePage: Decoder<RuntimePage> = (value) => decodePageAt(value, [], decodeRuntimeAt);

export const decodeWorkspaceCreate: Decoder<WorkspaceCreate> = (value) => {
  const path: DecodePath = [];
  const item = record(value, path);
  exactKeys(item, ["scopeId", "displayName", "capacityBytes", "retention"], path);
  decodeOpaqueIdAt(own(item, "scopeId", path), ["scopeId"]);
  decodeDisplayNameAt(own(item, "displayName", path), ["displayName"]);
  integer(own(item, "capacityBytes", path), 1_048_576, 1_125_899_906_842_624, ["capacityBytes"]);
  enumValue(own(item, "retention", path), WORKSPACE_RETENTIONS, ["retention"], "WorkspaceRetention");
  return item as unknown as WorkspaceCreate;
};

export const decodeWorkspacePatch: Decoder<WorkspacePatch> = (value) => {
  const path: DecodePath = [];
  const item = record(value, path);
  exactKeys(item, ["displayName", "retention"], path);
  if (Object.keys(item).length === 0) fail(path, "a non-empty WorkspacePatch", value);
  optional(item, "displayName", path, decodeDisplayNameAt);
  optional(item, "retention", path, (entry, entryPath) => enumValue(entry, WORKSPACE_RETENTIONS, entryPath, "WorkspaceRetention"));
  return item as WorkspacePatch;
};

export const decodeRuntimeCreate: Decoder<RuntimeCreate> = (value) => {
  const path: DecodePath = [];
  const item = record(value, path);
  exactKeys(item, ["scopeId", "displayName", "workspaceId", "hostProfileId", "desiredState", "browserPolicy", "idlePolicy"], path);
  decodeOpaqueIdAt(own(item, "scopeId", path), ["scopeId"]);
  decodeDisplayNameAt(own(item, "displayName", path), ["displayName"]);
  decodeOpaqueIdAt(own(item, "workspaceId", path), ["workspaceId"]);
  decodeOpaqueIdAt(own(item, "hostProfileId", path), ["hostProfileId"]);
  decodeDesiredStateAt(own(item, "desiredState", path), ["desiredState"]);
  enumValue(own(item, "browserPolicy", path), BROWSER_POLICIES, ["browserPolicy"], "BrowserPolicy");
  optional(item, "idlePolicy", path, decodeIdlePolicyAt);
  return item as unknown as RuntimeCreate;
};

export const decodeRuntimePatch: Decoder<RuntimePatch> = (value) => {
  const path: DecodePath = [];
  const item = record(value, path);
  exactKeys(item, ["displayName", "desiredState", "browserPolicy", "idlePolicy"], path);
  if (Object.keys(item).length === 0) fail(path, "a non-empty RuntimePatch", value);
  optional(item, "displayName", path, decodeDisplayNameAt);
  optional(item, "desiredState", path, decodeDesiredStateAt);
  optional(item, "browserPolicy", path, (entry, entryPath) => enumValue(entry, BROWSER_POLICIES, entryPath, "BrowserPolicy"));
  optional(item, "idlePolicy", path, decodeIdlePolicyAt);
  return item as RuntimePatch;
};

export const decodeProblemDetails: Decoder<ProblemDetails> = (value) => {
  const path: DecodePath = [];
  const item = record(value, path);
  validUri(own(item, "type", path), ["type"], false);
  text(own(item, "title", path), 1, 256, ["title"]);
  integer(own(item, "status", path), 400, 599, ["status"]);
  text(own(item, "detail", path), 1, 2048, ["detail"]);
  validUri(own(item, "instance", path), ["instance"], true);
  text(own(item, "code", path), 1, 128, ["code"], PROBLEM_CODE);
  boolean(own(item, "retryable", path), ["retryable"]);
  optional(item, "retryAfterMs", path, (entry, entryPath) => integer(entry, 0, 86_400_000, entryPath));
  optional(item, "currentRevision", path, decodeRevisionAt);
  return item as unknown as ProblemDetails;
};
