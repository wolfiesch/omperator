import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema.ts";

export type { components, operations, paths } from "./generated/schema.ts";

type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";
type EmptyHeaders = Readonly<Record<string, never>>;
type WithoutInjectedVersion<Headers> = Omit<Headers, "T4-API-Version">;
type ClientParameters<Parameters> = Parameters extends { header: infer Headers }
  ? Omit<Parameters, "header"> & (keyof WithoutInjectedVersion<Headers> extends never
    ? { readonly header?: EmptyHeaders }
    : { readonly header: WithoutInjectedVersion<Headers> })
  : Parameters;
type ClientOperation<Operation> = Operation extends { parameters: infer Parameters }
  ? Omit<Operation, "parameters"> & { readonly parameters: ClientParameters<Parameters> }
  : Operation;
type ClientPath<Path> = {
  readonly [Key in keyof Path]: Key extends HttpMethod ? ClientOperation<Path[Key]> : Path[Key];
};

/** Generated API paths with the SDK-owned version header removed from caller input. */
export type T4ClientPaths = { readonly [Path in keyof paths]: ClientPath<paths[Path]> };

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9._~-]+$/u;
const SELECTED_VERSION_MAX_LENGTH = 16;
const INVALID_RETRY_AFTER = Symbol("invalid Retry-After");
const HTTP_MONTHS: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};
const HTTP_WEEKDAYS: Readonly<Record<string, number>> = {
  Sun: 0, Sunday: 0, Mon: 1, Monday: 1, Tue: 2, Tuesday: 2,
  Wed: 3, Wednesday: 3, Thu: 4, Thursday: 4, Fri: 5, Friday: 5,
  Sat: 6, Saturday: 6,
};
const SELECTED_VERSION_PATTERN = /^1\.0$/u;
const ERROR_CODES = {
  invalid_request: true, unauthenticated: true, forbidden: true, not_found: true,
  idempotency_key_required: true, idempotency_conflict: true, revision_conflict: true,
  incompatible_version: true, cursor_expired: true, unavailable: true, indeterminate: true,
  invalid_origin: true, https_required: true,
} as const satisfies Record<components["schemas"]["ApiError"]["code"], true>;
const ERROR_FIELDS: Record<string, true> = {
  code: true, message: true, requestId: true, retryable: true,
  violations: true, supportedMajors: true, resync: true,
};
const ERROR_CODES_BY_STATUS: Readonly<Record<number, Readonly<Record<string, true>>>> = {
  400: { invalid_request: true, idempotency_key_required: true, invalid_origin: true, https_required: true },
  401: { unauthenticated: true },
  403: { forbidden: true },
  404: { not_found: true },
  406: { incompatible_version: true },
  409: { idempotency_conflict: true, revision_conflict: true },
  410: { cursor_expired: true },
  422: { invalid_request: true },
  503: { unavailable: true, indeterminate: true },
};
const WORKSPACE_STATES = {
  accepted: true, provisioning: true, ready: true, deleting: true,
  deleted: true, failed: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["WorkspaceState"], true>;
const SESSION_STATES = {
  accepted: true, provisioning: true, ready: true, cancelling: true,
  cancelled: true, failed: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["SessionState"], true>;
const COMMAND_STATES = {
  accepted: true, projected: true, dispatching: true, running: true, succeeded: true, failed: true,
  cancelling: true, cancelled: true, rejected: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["CommandState"], true>;

type ApiError = components["schemas"]["ApiError"];
type Resync = components["schemas"]["Resync"];
type WatchEvent = components["schemas"]["WatchEvent"];

export interface T4ApiClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly majorVersion: number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WatchSessionOptions {
  readonly cursor?: components["schemas"]["Cursor"];
  readonly maxEvents?: number;
  readonly heartbeatSeconds?: number;
  readonly signal?: AbortSignal;
  readonly maxReconnectAttempts?: number;
  readonly retryBackoffMs?: number;
}

export interface T4ApiClient {
  /**
   * Low-level generated client. Event-stream calls must pass `parseAs: "stream"`;
   * use `watchSession` for bounded, validated event decoding and reconnects.
   */
  readonly http: Readonly<Omit<Client<T4ClientPaths>, "use" | "eject">>;
  watchSession(sessionId: string, options?: WatchSessionOptions): AsyncGenerator<WatchEvent, void, undefined>;
}

export class T4ApiError extends Error {
  readonly code: ApiError["code"];
  readonly status: number;
  readonly requestId: string;
  readonly retryable: boolean;
  readonly violations?: ApiError["violations"];
  readonly supportedMajors?: ApiError["supportedMajors"];
  readonly resync?: Resync;
  readonly retryAfterMs?: number;

  constructor(status: number, error: ApiError, options?: ErrorOptions & { readonly retryAfterMs?: number }) {
    super(error.message, options);
    this.name = "T4ApiError";
    this.code = error.code;
    this.status = status;
    this.requestId = error.requestId;
    this.retryable = error.retryable;
    if (error.violations !== undefined) this.violations = error.violations;
    if (error.supportedMajors !== undefined) this.supportedMajors = error.supportedMajors;
    if (error.resync !== undefined) this.resync = error.resync;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError("T4 API baseUrl must be an absolute HTTPS URL", { cause: error });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("T4 API baseUrl must be a credential-free HTTPS URL without query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function requiredCredential(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_CREDENTIAL_LENGTH ||
    !/^[A-Za-z0-9._~+/-]+=*$/u.test(value)
  ) {
    throw new TypeError("credential must be an opaque bearer token of at most 4096 characters");
  }
  return value;
}

function requiredMajor(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1 || value > 9999) {
    throw new TypeError("majorVersion must be an integer between 1 and 9999");
  }
  return String(value);
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function requiredSessionId(value: string): string {
  if (value.length < 1 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value)) {
    throw new TypeError("sessionId is invalid");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validViolation(value: unknown): boolean {
  const violation = record(value);
  return violation !== undefined &&
    Object.keys(violation).every((key) => key === "field" || key === "rule" || key === "message") &&
    typeof violation.field === "string" && violation.field !== "" && hasAtMostCodePoints(violation.field, 256) &&
    typeof violation.rule === "string" && hasAtMostCodePoints(violation.rule, 64) && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(violation.rule) &&
    typeof violation.message === "string" && violation.message !== "" && hasAtMostCodePoints(violation.message, 512);
}

function validResync(value: unknown, expectedSessionId?: string): value is Resync {
  const resync = record(value);
  if (resync === undefined || Object.keys(resync).some((key) => key !== "snapshotUrl" && key !== "cursor") || typeof resync.snapshotUrl !== "string") return false;
  const snapshot = /^v1\/sessions\/([^/]+)\/snapshot$/u.exec(resync.snapshotUrl);
  return hasAtMostCodePoints(resync.snapshotUrl, 149) && snapshot !== null && validResourceId(snapshot[1]) &&
    (expectedSessionId === undefined || snapshot[1] === expectedSessionId) &&
    typeof resync.cursor === "string" && hasAtMostCodePoints(resync.cursor, 512) && CURSOR_PATTERN.test(resync.cursor);
}

function apiError(value: unknown, status: number, expectedSessionId?: string): ApiError | undefined {
  const envelope = record(value);
  const error = record(envelope?.error);
  if (
    envelope === undefined || Object.keys(envelope).some((key) => key !== "error") ||
    error === undefined || Object.keys(error).some((key) => ERROR_FIELDS[key] !== true) ||
    typeof error.code !== "string" || ERROR_CODES[error.code as ApiError["code"]] !== true ||
    ERROR_CODES_BY_STATUS[status]?.[error.code] !== true ||
    typeof error.message !== "string" || error.message === "" || !hasAtMostCodePoints(error.message, 1024) ||
    typeof error.requestId !== "string" || error.requestId === "" || !hasAtMostCodePoints(error.requestId, 128) ||
    typeof error.retryable !== "boolean" ||
    (error.violations !== undefined && (!Array.isArray(error.violations) || error.violations.length > 64 || !error.violations.every(validViolation))) ||
    (error.supportedMajors !== undefined && (!Array.isArray(error.supportedMajors) || error.supportedMajors.length > 8 || !hasUniqueItems(error.supportedMajors) || !error.supportedMajors.every((major) => Number.isSafeInteger(major) && Number(major) >= 1))) ||
    (error.resync !== undefined && !validResync(error.resync)) ||
    (status === 406 && (error.code !== "incompatible_version" || !Array.isArray(error.supportedMajors) || error.supportedMajors.length < 1)) ||
    (status === 410 && (error.code !== "cursor_expired" || !validResync(error.resync, expectedSessionId))) ||
    (status === 422 && (error.code !== "invalid_request" || !Array.isArray(error.violations) || error.violations.length < 1))
  ) return undefined;
  return error as ApiError;
}

async function boundedResponseText(response: Response, maximumBytes = MAX_ERROR_BYTES): Promise<string | undefined> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
}

function matchingHttpDate(
  timestamp: number,
  parts: RegExpExecArray,
  indexes: { readonly weekday: number; readonly day: number; readonly alternateDay?: number; readonly month: number; readonly year: number; readonly hour: number; readonly minute: number; readonly second: number },
  expectedYear = Number(parts[indexes.year]),
): boolean {
  const date = new Date(timestamp);
  return date.getUTCDay() === HTTP_WEEKDAYS[parts[indexes.weekday]!] &&
    date.getUTCDate() === Number(parts[indexes.day] ?? parts[indexes.alternateDay ?? indexes.day]) &&
    date.getUTCMonth() === HTTP_MONTHS[parts[indexes.month]!] &&
    date.getUTCFullYear() === expectedYear &&
    date.getUTCHours() === Number(parts[indexes.hour]) &&
    date.getUTCMinutes() === Number(parts[indexes.minute]) &&
    date.getUTCSeconds() === Number(parts[indexes.second]);
}

function httpDateTimestamp(value: string): number | undefined {
  const imf = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u.exec(value);
  if (imf !== null) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && matchingHttpDate(timestamp, imf, { weekday: 1, day: 2, month: 3, year: 4, hour: 5, minute: 6, second: 7 }) ? timestamp : undefined;
  }
  const rfc850 = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([0-9]{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/u.exec(value);
  if (rfc850 !== null) {
    const now = new Date(Date.now());
    let year = Math.floor(now.getUTCFullYear() / 100) * 100 + Number(rfc850[4]);
    const date = new Date(0);
    date.setUTCFullYear(year, HTTP_MONTHS[rfc850[3]!]!, Number(rfc850[2]));
    date.setUTCHours(Number(rfc850[5]), Number(rfc850[6]), Number(rfc850[7]), 0);
    const fiftyYearsFromNow = new Date(now.getTime());
    fiftyYearsFromNow.setUTCFullYear(now.getUTCFullYear() + 50);
    if (date.getTime() > fiftyYearsFromNow.getTime()) {
      year -= 100;
      date.setUTCFullYear(year);
    }
    const timestamp = date.getTime();
    return matchingHttpDate(timestamp, rfc850, { weekday: 1, day: 2, month: 3, year: 4, hour: 5, minute: 6, second: 7 }, year) ? timestamp : undefined;
  }
  const asctime = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:([0-9]{2})| ([0-9])) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/u.exec(value);
  if (asctime === null) return undefined;
  const date = new Date(0);
  date.setUTCFullYear(Number(asctime[8]), HTTP_MONTHS[asctime[2]!]!, Number(asctime[3] ?? asctime[4]));
  date.setUTCHours(Number(asctime[5]), Number(asctime[6]), Number(asctime[7]), 0);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) && matchingHttpDate(timestamp, asctime, { weekday: 1, day: 3, alternateDay: 4, month: 2, year: 8, hour: 5, minute: 6, second: 7 }) ? timestamp : undefined;
}

function retryAfterMilliseconds(response: Response): number | undefined | typeof INVALID_RETRY_AFTER {
  const header = response.headers.get("Retry-After");
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "" || !hasAtMostCodePoints(value, 128)) return INVALID_RETRY_AFTER;
  if (/^[0-9]+$/u.test(value)) return Math.min(30_000, Number(value) * 1000);
  const timestamp = httpDateTimestamp(value);
  if (timestamp === undefined) return INVALID_RETRY_AFTER;
  return Math.min(30_000, Math.max(0, timestamp - Date.now()));
}


function protocolError(status: number, message: string): T4ApiError {
  return new T4ApiError(status === 503 ? 502 : status, {
    code: "indeterminate",
    message,
    requestId: "unavailable",
    retryable: false,
  });
}

async function parsedError(response: Response, expectedSessionId?: string): Promise<T4ApiError | undefined> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const text = await boundedResponseText(response);
  if (text === undefined) return undefined;
  try {
    const decoded = apiError(JSON.parse(text), response.status, expectedSessionId);
    if (decoded === undefined) return undefined;
    const retryAfterMs = retryAfterMilliseconds(response);
    if (retryAfterMs === INVALID_RETRY_AFTER) return undefined;
    return retryAfterMs === undefined
      ? new T4ApiError(response.status, decoded)
      : new T4ApiError(response.status, decoded, { retryAfterMs });
  } catch {
    return undefined;
  }
}


function hasOnlyKeys(value: Record<string, unknown>, keys: Readonly<Record<string, true>>): boolean {
  return Object.keys(value).every((key) => keys[key] === true);
}

function hasUniqueItems(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    for (let prior = 0; prior < index; prior += 1) {
      if (value[index] === value[prior]) return false;
    }
  }
  return true;
}

function validResourceId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && hasAtMostCodePoints(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(value);
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function validCursor(value: unknown): value is string {
  return typeof value === "string" && value !== "" && hasAtMostCodePoints(value, 512) && CURSOR_PATTERN.test(value);
}

function validLabels(value: unknown): boolean {
  if (value === undefined) return true;
  const labels = record(value);
  return labels !== undefined && Object.keys(labels).length <= 32 && Object.entries(labels).every(([key, item]) =>
    /^[a-z][a-z0-9.-]{0,62}$/u.test(key) && typeof item === "string" && hasAtMostCodePoints(item, 128));
}

function validWorkspace(value: unknown): boolean {
  const item = record(value);
  return item !== undefined && hasOnlyKeys(item, { id: true, name: true, state: true, revision: true, labels: true }) &&
    validResourceId(item.id) && typeof item.name === "string" && item.name !== "" && hasAtMostCodePoints(item.name, 128) &&
    typeof item.state === "string" && WORKSPACE_STATES[item.state as components["schemas"]["WorkspaceState"]] === true &&
    Number.isSafeInteger(item.revision) && Number(item.revision) >= 1 && validLabels(item.labels);
}

function validSession(value: unknown): boolean {
  const item = record(value);
  return item !== undefined && hasOnlyKeys(item, { id: true, workspaceId: true, title: true, state: true, revision: true, labels: true }) &&
    validResourceId(item.id) && validResourceId(item.workspaceId) && typeof item.title === "string" && item.title !== "" && hasAtMostCodePoints(item.title, 128) &&
    typeof item.state === "string" && SESSION_STATES[item.state as components["schemas"]["SessionState"]] === true &&
    Number.isSafeInteger(item.revision) && Number(item.revision) >= 1 && validLabels(item.labels);
}

function validCommandResult(value: unknown): boolean {
  const item = record(value);
  return item !== undefined && hasOnlyKeys(item, { commandId: true, state: true }) && validResourceId(item.commandId) &&
    typeof item.state === "string" && COMMAND_STATES[item.state as components["schemas"]["CommandState"]] === true;
}

function validCapabilityDeprecation(value: unknown): boolean {
  if (value === undefined) return true;
  const deprecation = record(value);
  return deprecation !== undefined && hasOnlyKeys(deprecation, { message: true, sinceVersion: true, sunsetAt: true, replacement: true }) &&
    typeof deprecation.message === "string" && deprecation.message !== "" && hasAtMostCodePoints(deprecation.message, 1024) &&
    (deprecation.sinceVersion === undefined || (typeof deprecation.sinceVersion === "string" && deprecation.sinceVersion !== "" && hasAtMostCodePoints(deprecation.sinceVersion, 128))) &&
    (deprecation.sunsetAt === undefined || (typeof deprecation.sunsetAt === "string" && validRfc3339DateTime(deprecation.sunsetAt))) &&
    (deprecation.replacement === undefined || (typeof deprecation.replacement === "string" && /^[a-z][a-z0-9.-]{0,127}$/u.test(deprecation.replacement)));
}

function validCapabilityStatus(value: unknown): boolean {
  const status = record(value);
  return status !== undefined && hasOnlyKeys(status, { supported: true, enabled: true, authorized: true, available: true, deprecation: true }) &&
    typeof status.supported === "boolean" && typeof status.enabled === "boolean" &&
    typeof status.authorized === "boolean" && typeof status.available === "boolean" && validCapabilityDeprecation(status.deprecation);
}

function validDiscovery(value: unknown): boolean {
  const discovery = record(value);
  const serverBuild = record(discovery?.serverBuild);
  const capabilities = record(discovery?.capabilities);
  const limits = record(discovery?.limits);
  return discovery !== undefined && hasOnlyKeys(discovery, { apiVersion: true, serverBuild: true, supportedMajors: true, capabilities: true, limits: true }) &&
    typeof discovery.apiVersion === "string" && /^1\.[0-9]+$/u.test(discovery.apiVersion) &&
    serverBuild !== undefined && hasOnlyKeys(serverBuild, { version: true, revision: true }) &&
    typeof serverBuild.version === "string" && serverBuild.version !== "" && hasAtMostCodePoints(serverBuild.version, 128) &&
    typeof serverBuild.revision === "string" && serverBuild.revision !== "" && hasAtMostCodePoints(serverBuild.revision, 128) &&
    Array.isArray(discovery.supportedMajors) && discovery.supportedMajors.length >= 1 && discovery.supportedMajors.length <= 8 && hasUniqueItems(discovery.supportedMajors) && discovery.supportedMajors.every((major) => Number.isSafeInteger(major) && Number(major) >= 1) &&
    capabilities !== undefined && Object.keys(capabilities).length <= 128 && Object.entries(capabilities).every(([id, status]) => /^[a-z][a-z0-9.-]{0,127}$/u.test(id) && validCapabilityStatus(status)) &&
    limits !== undefined && hasOnlyKeys(limits, { pageSizeDefault: true, pageSizeMax: true, commandBytesMax: true, commandRequestBytesMax: true, commandMetadataValueBytesMax: true, watchEventsDefault: true, watchEventsMax: true, heartbeatSeconds: true }) &&
    [limits.pageSizeDefault, limits.pageSizeMax, limits.commandBytesMax, limits.commandRequestBytesMax, limits.commandMetadataValueBytesMax, limits.watchEventsDefault, limits.watchEventsMax, limits.heartbeatSeconds].every((limit) => Number.isSafeInteger(limit) && Number(limit) >= 1) &&
    Number(limits.pageSizeDefault) <= Number(limits.pageSizeMax) && Number(limits.watchEventsDefault) <= Number(limits.watchEventsMax) && Number(limits.commandBytesMax) <= Number(limits.commandRequestBytesMax) && Number(limits.commandMetadataValueBytesMax) <= Number(limits.commandRequestBytesMax) &&
    Number(limits.pageSizeMax) <= 100 && Number(limits.commandBytesMax) <= 262144 && Number(limits.commandRequestBytesMax) <= 1048576 && Number(limits.commandMetadataValueBytesMax) <= 262144 && Number(limits.watchEventsMax) <= 1000 && Number(limits.heartbeatSeconds) >= 5 && Number(limits.heartbeatSeconds) <= 60;
}

function validSnapshot(value: unknown): boolean {
  const snapshot = record(value);
  return snapshot !== undefined && hasOnlyKeys(snapshot, { sessionId: true, cursor: true, state: true, entries: true }) &&
    validResourceId(snapshot.sessionId) && validCursor(snapshot.cursor) &&
    typeof snapshot.state === "string" && SESSION_STATES[snapshot.state as components["schemas"]["SessionState"]] === true &&
    Array.isArray(snapshot.entries) && snapshot.entries.length <= 1000 && snapshot.entries.every((value) => {
      const entry = record(value);
      return entry !== undefined && hasOnlyKeys(entry, { sequence: true, kind: true, text: true }) &&
        Number.isSafeInteger(entry.sequence) && Number(entry.sequence) >= 0 &&
        (entry.kind === "input" || entry.kind === "output" || entry.kind === "status") &&
        typeof entry.text === "string" && hasAtMostCodePoints(entry.text, 1_048_576);
    });
}

type SuccessValidator = ((value: unknown) => boolean) | "empty" | "event-stream";

interface ResponseContract {
  readonly success: Readonly<Record<number, SuccessValidator>>;
  readonly errors: readonly number[];
  readonly replaySuccess?: readonly number[];
}

const DISCOVERY_RESPONSE: ResponseContract = { success: { 200: validDiscovery }, errors: [401, 403, 406, 503] };
const WORKSPACE_LIST_RESPONSE: ResponseContract = { success: { 200: validWorkspacePage }, errors: [400, 401, 403, 406, 422, 503] };
const WORKSPACE_CREATE_RESPONSE: ResponseContract = { success: { 200: validWorkspace, 202: validWorkspace }, errors: [400, 401, 403, 406, 409, 422, 503], replaySuccess: [200, 202] };
const WORKSPACE_GET_RESPONSE: ResponseContract = { success: { 200: validWorkspace }, errors: [401, 403, 404, 406, 503] };
const WORKSPACE_MUTATE_RESPONSE: ResponseContract = { success: { 200: validWorkspace }, errors: [400, 401, 403, 404, 406, 409, 422, 503], replaySuccess: [200] };
const DELETE_RESPONSE: ResponseContract = { success: { 204: "empty" }, errors: [400, 401, 403, 404, 406, 409, 503], replaySuccess: [204] };
const SESSION_LIST_RESPONSE: ResponseContract = { success: { 200: validSessionPage }, errors: [401, 403, 404, 406, 422, 503] };
const SESSION_CREATE_RESPONSE: ResponseContract = { success: { 200: validSession, 202: validSession }, errors: [400, 401, 403, 404, 406, 409, 422, 503], replaySuccess: [200, 202] };
const SESSION_GET_RESPONSE: ResponseContract = { success: { 200: validSession }, errors: [401, 403, 404, 406, 503] };
const SESSION_MUTATE_RESPONSE: ResponseContract = { success: { 200: validSession }, errors: [400, 401, 403, 404, 406, 409, 422, 503], replaySuccess: [200] };
const SESSION_CANCEL_RESPONSE: ResponseContract = { success: { 200: validSession, 202: validSession }, errors: [400, 401, 403, 404, 406, 409, 503], replaySuccess: [200, 202] };
const COMMAND_RESPONSE: ResponseContract = { success: { 200: validCommandResult, 202: validCommandResult }, errors: [400, 401, 403, 404, 406, 409, 422, 503], replaySuccess: [200, 202] };
const SNAPSHOT_RESPONSE: ResponseContract = { success: { 200: validSnapshot }, errors: [401, 403, 404, 406, 503] };
const EVENTS_RESPONSE: ResponseContract = { success: { 200: "event-stream" }, errors: [400, 401, 403, 404, 406, 410, 422, 503] };

function validWorkspacePage(value: unknown): boolean {
  const page = record(value);
  return page !== undefined && hasOnlyKeys(page, { items: true, nextCursor: true }) &&
    Array.isArray(page.items) && page.items.length <= 100 && page.items.every(validWorkspace) &&
    (page.nextCursor === undefined || validCursor(page.nextCursor));
}

function validSessionPage(value: unknown): boolean {
  const page = record(value);
  return page !== undefined && hasOnlyKeys(page, { items: true, nextCursor: true }) &&
    Array.isArray(page.items) && page.items.length <= 100 && page.items.every(validSession) &&
    (page.nextCursor === undefined || validCursor(page.nextCursor));
}

function relativeApiPath(request: Request, baseUrl: string): string | undefined {
  const requestUrl = new URL(request.url);
  const base = new URL(baseUrl);
  if (requestUrl.origin !== base.origin) return undefined;
  const prefix = base.pathname === "/" ? "" : base.pathname;
  if (prefix === "") return requestUrl.pathname;
  if (!requestUrl.pathname.startsWith(`${prefix}/`)) return undefined;
  return requestUrl.pathname.slice(prefix.length);
}

function responseContract(method: string, path: string): ResponseContract | undefined {
  if (path === "/v1" && method === "GET") return DISCOVERY_RESPONSE;
  if (path === "/v1/workspaces") {
    if (method === "GET") return WORKSPACE_LIST_RESPONSE;
    if (method === "POST") return WORKSPACE_CREATE_RESPONSE;
    return undefined;
  }
  if (/^\/v1\/workspaces\/[A-Za-z0-9._~-]+$/u.test(path)) {
    if (method === "GET") return WORKSPACE_GET_RESPONSE;
    if (method === "PATCH") return WORKSPACE_MUTATE_RESPONSE;
    if (method === "DELETE") return DELETE_RESPONSE;
    return undefined;
  }
  if (/^\/v1\/workspaces\/[A-Za-z0-9._~-]+\/sessions$/u.test(path)) {
    if (method === "GET") return SESSION_LIST_RESPONSE;
    if (method === "POST") return SESSION_CREATE_RESPONSE;
    return undefined;
  }
  if (/^\/v1\/sessions\/[A-Za-z0-9._~-]+$/u.test(path)) {
    if (method === "GET") return SESSION_GET_RESPONSE;
    if (method === "PATCH") return SESSION_MUTATE_RESPONSE;
    if (method === "DELETE") return DELETE_RESPONSE;
    return undefined;
  }
  if (/^\/v1\/sessions\/[A-Za-z0-9._~-]+\/cancel$/u.test(path) && method === "POST") return SESSION_CANCEL_RESPONSE;
  if (/^\/v1\/sessions\/[A-Za-z0-9._~-]+\/commands$/u.test(path) && method === "POST") return COMMAND_RESPONSE;
  if (/^\/v1\/sessions\/[A-Za-z0-9._~-]+\/snapshot$/u.test(path) && method === "GET") return SNAPSHOT_RESPONSE;
  if (/^\/v1\/sessions\/[A-Za-z0-9._~-]+\/events$/u.test(path) && method === "GET") return EVENTS_RESPONSE;
  return undefined;
}

function validPathBoundResponse(method: string, path: string, value: unknown): boolean {
  const workspace = /^\/v1\/workspaces\/([^/]+)$/u.exec(path);
  if (workspace !== null && (method === "GET" || method === "PATCH")) {
    return record(value)?.id === workspace[1];
  }
  const sessions = /^\/v1\/workspaces\/([^/]+)\/sessions$/u.exec(path);
  if (sessions !== null) {
    if (method === "POST") return record(value)?.workspaceId === sessions[1];
    if (method === "GET") {
      const items = record(value)?.items;
      return Array.isArray(items) && items.every((item) => record(item)?.workspaceId === sessions[1]);
    }
  }
  const session = /^\/v1\/sessions\/([^/]+)$/u.exec(path);
  if (session !== null && (method === "GET" || method === "PATCH")) {
    return record(value)?.id === session[1];
  }
  const cancellation = /^\/v1\/sessions\/([^/]+)\/cancel$/u.exec(path);
  if (cancellation !== null && method === "POST") return record(value)?.id === cancellation[1];
  const snapshot = /^\/v1\/sessions\/([^/]+)\/snapshot$/u.exec(path);
  if (snapshot !== null && method === "GET") return record(value)?.sessionId === snapshot[1];
  return true;
}

function validSelectedVersion(response: Response, expectedMajor?: string): boolean {
  const selected = response.headers.get("T4-API-Version");
  return selected !== null && selected.length <= SELECTED_VERSION_MAX_LENGTH && SELECTED_VERSION_PATTERN.test(selected) &&
    (expectedMajor === undefined || selected.startsWith(`${expectedMajor}.`));
}

function validBearerChallenge(response: Response): boolean {
  return response.headers.get("WWW-Authenticate") === 'Bearer realm="t4"';
}

function validReplayHeader(response: Response): boolean {
  const replayed = response.headers.get("Idempotency-Replayed");
  return replayed === "true" || replayed === "false";
}


async function validateResponse(request: Request, response: Response, baseUrl: string): Promise<void> {
  const path = relativeApiPath(request, baseUrl);
  const contract = path === undefined ? undefined : responseContract(request.method, path);
  if (contract === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned a response for an undeclared route");
  }
  if (!response.ok) {
    if (!contract.errors.includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned an undeclared error status");
    }
    if ((response.status === 401 && (response.headers.has("T4-API-Version") || !validBearerChallenge(response))) ||
      (response.status !== 401 && !validSelectedVersion(response))) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned an invalid selected-version header");
    }
    const watchedSession = path === undefined ? undefined : /^\/v1\/sessions\/([^/]+)\/events$/u.exec(path)?.[1];
    if (await parsedError(response.clone(), watchedSession) === undefined) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned an invalid or oversized error envelope");
    }
    return;
  }
  const validator = contract.success[response.status];
  if (validator === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned an undeclared success status");
  }
  if (!validSelectedVersion(response, request.headers.get("T4-API-Version") ?? "")) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned a missing or invalid selected version");
  }
  if (contract.replaySuccess?.includes(response.status) === true && !validReplayHeader(response)) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned a missing or invalid replay header");
  }
  if (contract.replaySuccess?.includes(response.status) === true && !validCursor(response.headers.get("T4-Event-Cursor"))) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned a missing or invalid durable event cursor");
  }
  if (validator === "empty") {
    if (response.body !== null || response.headers.has("content-type")) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned content for a bodyless response");
    }
    return;
  }
  if (validator === "event-stream") {
    if (response.headers.get("Cache-Control") !== "no-store") {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API watch did not return Cache-Control: no-store");
    }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned an undeclared success media type");
    }
    return;
  }
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned an undeclared success media type");
  }
  const text = await boundedResponseText(response.clone(), MAX_JSON_RESPONSE_BYTES);
  let value: unknown;
  try { value = text === undefined ? undefined : JSON.parse(text); } catch { value = undefined; }
  if (text === undefined || !validator(value) || !validPathBoundResponse(request.method, path!, value)) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned an invalid or oversized JSON response");
  }
}

function isKnownUtcLeapSecondDate(year: number, month: number, day: number): boolean {
  // Update this IERS insertion-date table when a new UTC leap second is announced.
  switch (year * 10_000 + month * 100 + day) {
    case 19720630: case 19721231: case 19731231: case 19741231: case 19751231:
    case 19761231: case 19771231: case 19781231: case 19791231: case 19810630:
    case 19820630: case 19830630: case 19850630: case 19871231: case 19891231:
    case 19901231: case 19920630: case 19930630: case 19940630: case 19951231:
    case 19970630: case 19981231: case 20051231: case 20081231: case 20120630:
    case 20150630: case 20161231:
      return true;
    default:
      return false;
  }
}

function validRfc3339DateTime(value: string): boolean {
  if (!hasAtMostCodePoints(value, 64)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/iu.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 60) return false;
  let maximumDay = 31;
  if (month === 2) maximumDay = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  else if (month === 4 || month === 6 || month === 9 || month === 11) maximumDay = 30;
  if (day < 1 || day > maximumDay) return false;
  let offsetMinutes = 0;
  if (match[7] !== undefined) {
    const offsetHour = Number(match[8]);
    const offsetMinute = Number(match[9]);
    if (offsetHour > 23 || offsetMinute > 59) return false;
    offsetMinutes = (match[7] === "+" ? 1 : -1) * (offsetHour * 60 + offsetMinute);
  }
  if (second < 60) return true;
  const utc = new Date(0);
  utc.setUTCFullYear(year, month - 1, day);
  utc.setUTCHours(hour, minute - offsetMinutes, 0, 0);
  return utc.getUTCHours() === 23 && utc.getUTCMinutes() === 59 &&
    isKnownUtcLeapSecondDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

function watchEvent(value: unknown, eventId: string | undefined): WatchEvent {
  const event = record(value);
  if (
    event === undefined ||
    typeof event.type !== "string" ||
    typeof event.cursor !== "string" ||
    event.cursor === "" ||
    !hasAtMostCodePoints(event.cursor, 512) ||
    !CURSOR_PATTERN.test(event.cursor) ||
    (eventId !== undefined && eventId !== event.cursor)
  ) throw protocolError(502, "T4 API returned an invalid watch event");
  if (
    event.type === "heartbeat" &&
    hasOnlyKeys(event, { type: true, cursor: true, observedAt: true }) &&
    typeof event.observedAt === "string" && validRfc3339DateTime(event.observedAt)
  ) return event as WatchEvent;
  if (
    event.type === "session" &&
    hasOnlyKeys(event, { type: true, cursor: true, state: true, revision: true }) &&
    typeof event.state === "string" &&
    SESSION_STATES[event.state as components["schemas"]["SessionState"]] === true &&
    Number.isSafeInteger(event.revision) && Number(event.revision) >= 1
  ) return event as WatchEvent;
  if (
    event.type === "command" &&
    hasOnlyKeys(event, { type: true, cursor: true, commandId: true, state: true }) &&
    typeof event.commandId === "string" &&
    event.commandId !== "" && hasAtMostCodePoints(event.commandId, 128) &&
    /^[A-Za-z0-9][A-Za-z0-9._~-]*$/u.test(event.commandId) &&
    typeof event.state === "string" &&
    COMMAND_STATES[event.state as components["schemas"]["CommandState"]] === true
  ) return event as WatchEvent;
  throw protocolError(502, "T4 API returned an invalid watch event");
}

function decodeSseFrame(frame: string): WatchEvent | undefined {
  let eventId: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r\n|\r|\n/u)) {
    const line = rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") eventId = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  try {
    return watchEvent(JSON.parse(data.join("\n")), eventId);
  } catch (error) {
    if (error instanceof T4ApiError) throw error;
    throw protocolError(502, "T4 API returned malformed SSE data");
  }
}

class SseFrameParser {
  readonly #buffer = new Uint8Array(MAX_EVENT_BYTES + 4);
  #length = 0;
  #lineStart = 0;
  #pendingCarriageReturn = -1;

  push(chunk: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const byte of chunk) this.#pushByte(byte, frames);
    return frames;
  }

  finish(): Uint8Array[] {
    const frames: Uint8Array[] = [];
    if (this.#pendingCarriageReturn >= 0) {
      this.#finishLine(this.#pendingCarriageReturn, frames);
      this.#pendingCarriageReturn = -1;
    }
    if (this.#length > MAX_EVENT_BYTES) this.#oversized();
    this.#reset();
    return frames;
  }

  #pushByte(byte: number, frames: Uint8Array[]): void {
    if (this.#pendingCarriageReturn >= 0) {
      if (byte === 10) {
        this.#append(byte);
        this.#finishLine(this.#pendingCarriageReturn, frames);
        this.#pendingCarriageReturn = -1;
        return;
      }
      this.#finishLine(this.#pendingCarriageReturn, frames);
      this.#pendingCarriageReturn = -1;
    }
    this.#append(byte);
    if (byte === 13) this.#pendingCarriageReturn = this.#length - 1;
    else if (byte === 10) this.#finishLine(this.#length - 1, frames);
  }

  #append(byte: number): void {
    if (this.#length >= this.#buffer.byteLength) this.#oversized();
    this.#buffer[this.#length++] = byte;
  }

  #finishLine(newlineStart: number, frames: Uint8Array[]): void {
    if (newlineStart === this.#lineStart) {
      if (this.#lineStart > MAX_EVENT_BYTES) this.#oversized();
      frames.push(this.#buffer.slice(0, this.#lineStart));
      this.#reset();
      return;
    }
    this.#lineStart = this.#length;
    if (this.#lineStart > MAX_EVENT_BYTES) this.#oversized();
  }

  #reset(): void {
    this.#length = 0;
    this.#lineStart = 0;
  }

  #oversized(): never {
    throw protocolError(502, "T4 API watch event exceeds the client bound");
  }
}

function decodedFrames(parser: SseFrameParser, chunk: Uint8Array | undefined): WatchEvent[] {
  const frames = chunk === undefined ? parser.finish() : parser.push(chunk);
  return frames.flatMap((bytes) => {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
      throw protocolError(502, "T4 API returned malformed SSE data");
    }
    const event = decodeSseFrame(text);
    return event === undefined ? [] : [event];
  });
}

async function retryDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (milliseconds === 0) return true;
  return await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const remaining = Math.max(0, deadline - Date.now());
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      callback();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    const timeout = setTimeout(
      () => finish(() => reject(new TypeError("T4 API watch exceeded its heartbeat inactivity deadline"))),
      remaining,
    );
    signal.addEventListener("abort", aborted, { once: true });
    reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function* watch(
  baseUrl: string,
  credential: string,
  majorVersion: string,
  fetchImpl: typeof globalThis.fetch,
  sessionIdValue: string,
  options: WatchSessionOptions,
): AsyncGenerator<WatchEvent, void, undefined> {
  const sessionId = requiredSessionId(sessionIdValue);
  const maxEvents = boundedInteger(options.maxEvents, 1, 1, 1000, "maxEvents");
  const heartbeatSeconds = boundedInteger(options.heartbeatSeconds, 15, 5, 60, "heartbeatSeconds");
  const maxReconnectAttempts = boundedInteger(options.maxReconnectAttempts, 3, 0, 10, "maxReconnectAttempts");
  const retryBackoffMs = boundedInteger(options.retryBackoffMs, 250, 0, 30_000, "retryBackoffMs");
  if (options.cursor !== undefined && (options.cursor.length < 1 || options.cursor.length > 512 || !CURSOR_PATTERN.test(options.cursor))) {
    throw new TypeError("cursor must be a header-safe token containing between 1 and 512 characters");
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  let delivered = 0;
  let reconnectAttempts = 0;
  let cursor = options.cursor;
  const deliveredCursors = new Set<string>();
  if (cursor !== undefined) deliveredCursors.add(cursor);
  try {
    while (delivered < maxEvents && !controller.signal.aborted) {
      const deliveredAtAttemptStart = delivered;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let transientFailure: unknown;
      let retryAfterMs = 0;
      try {
        const url = new URL(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/events`);
        url.searchParams.set("maxEvents", String(maxEvents - delivered));
        url.searchParams.set("heartbeatSeconds", String(heartbeatSeconds));
        if (cursor !== undefined) url.searchParams.set("cursor", cursor);
        const headers = new Headers({
          Accept: "text/event-stream",
          Authorization: `Bearer ${credential}`,
          "Cache-Control": "no-store",
          "T4-API-Version": majorVersion,
        });
        if (cursor !== undefined) headers.set("Last-Event-ID", cursor);
        const response = await fetchImpl(url, { method: "GET", headers, signal: controller.signal });
        if (!response.ok) {
          if (!EVENTS_RESPONSE.errors.includes(response.status)) {
            void response.body?.cancel().catch(() => {});
            throw protocolError(502, "T4 API returned an undeclared watch error status");
          }
          if ((response.status === 401 && (response.headers.has("T4-API-Version") || !validBearerChallenge(response))) ||
            (response.status !== 401 && !validSelectedVersion(response))) {
            void response.body?.cancel().catch(() => {});
            throw protocolError(502, "T4 API returned an invalid selected-version header");
          }
          const error = await parsedError(response, sessionId);
          throw error ?? protocolError(502, "T4 API returned an invalid or oversized error envelope");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API returned an undeclared watch success status");
        }
        if (!validSelectedVersion(response, majorVersion)) {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API returned a missing or invalid selected version");
        }
        if (response.headers.get("Cache-Control") !== "no-store") {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API watch did not return Cache-Control: no-store");
        }
        if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API watch did not return text/event-stream");
        }
        if (response.body === null) throw protocolError(502, "T4 API watch response body is unavailable");
        reader = response.body.getReader();
        const parser = new SseFrameParser();
        let inactivityDeadline = Date.now() + heartbeatSeconds * 2_000;
        while (delivered < maxEvents && !controller.signal.aborted) {
          const chunk = await readBeforeDeadline(reader, inactivityDeadline, controller.signal);
          const events = chunk.done ? decodedFrames(parser, undefined) : decodedFrames(parser, chunk.value);
          if (events.length > 0) inactivityDeadline = Date.now() + heartbeatSeconds * 2_000;
          for (const event of events) {
            if (event.type === "heartbeat") {
              if (cursor === undefined) {
                cursor = event.cursor;
                deliveredCursors.add(event.cursor);
              } else if (event.cursor !== cursor) {
                throw protocolError(502, "T4 API watch heartbeat advanced the durable event cursor");
              }
            } else {
              if (deliveredCursors.has(event.cursor)) throw protocolError(502, "T4 API watch repeated a durable event cursor");
              deliveredCursors.add(event.cursor);
              cursor = event.cursor;
            }
            delivered += 1;
            reconnectAttempts = 0;
            yield event;
            if (delivered >= maxEvents || controller.signal.aborted) break;
          }
          if (chunk.done) break;
        }
        if (delivered >= maxEvents || controller.signal.aborted) return;
        transientFailure = new TypeError("T4 API watch ended before the requested event bound");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof T4ApiError) {
          const reconnectable = error.retryable && error.status === 503 && (error.code === "unavailable" || error.code === "indeterminate");
          if (!reconnectable) throw error;
          retryAfterMs = error.retryAfterMs ?? 0;
        }
        transientFailure = error;
      } finally {
        if (reader !== undefined) {
          try { await reader.cancel(); } catch { /* cancellation is best effort */ }
          reader.releaseLock();
        }
      }
      const madeProgress = delivered > deliveredAtAttemptStart;
      if (!madeProgress && reconnectAttempts >= maxReconnectAttempts) {
        throw new T4ApiError(502, { code: "indeterminate", message: "T4 API watch reconnect attempts exhausted", requestId: "unavailable", retryable: true }, { cause: transientFailure });
      }
      const delay = Math.min(30_000, Math.max(retryAfterMs, retryBackoffMs * (2 ** reconnectAttempts)));
      if (!madeProgress) reconnectAttempts += 1;
      if (!await retryDelay(delay, controller.signal)) return;
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function createT4ApiClient(options: T4ApiClientOptions): T4ApiClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const credential = requiredCredential(options.credential);
  const majorVersion = requiredMajor(options.majorVersion);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
    const candidate = new Request(input, init);
    const path = relativeApiPath(candidate, baseUrl);
    const contract = path === undefined ? undefined : responseContract(candidate.method, path);
    if (contract === undefined) throw protocolError(502, "T4 API client refused an undeclared or cross-origin request");
    const headers = new Headers(candidate.headers);
    headers.set("Authorization", `Bearer ${credential}`);
    headers.set("T4-API-Version", majorVersion);
    headers.set("Accept", contract.success[200] === "event-stream" ? "text/event-stream" : "application/json");
    const request = new Request(candidate, { headers, redirect: "error" });
    const response = await fetchImpl(request);
    await validateResponse(request, response, baseUrl);
    return response;
  };
  const generated = createClient<T4ClientPaths>({ baseUrl, fetch: authenticatedFetch });
  const forbiddenOverrides = new Set([
    "baseUrl", "fetch", "headers", "middleware", "querySerializer", "bodySerializer",
    "pathSerializer", "Request", "method",
  ]);
  const safeInit = (init: unknown): unknown => {
    if (init === undefined) return undefined;
    if (init === null || typeof init !== "object" || Array.isArray(init)) {
      throw new TypeError("T4 API request options must be an object");
    }
    for (const key of Object.keys(init)) {
      if (forbiddenOverrides.has(key)) {
        throw new TypeError(`T4 API request option ${key} is SDK-owned`);
      }
    }
    return init;
  };
  const http = Object.freeze({
    request: (method: Parameters<typeof generated.request>[0], path: Parameters<typeof generated.request>[1], init?: unknown) =>
      generated.request(method, path, safeInit(init) as never),
    GET: (path: Parameters<typeof generated.GET>[0], init?: unknown) => generated.GET(path, safeInit(init) as never),
    PUT: (path: Parameters<typeof generated.PUT>[0], init?: unknown) => generated.PUT(path, safeInit(init) as never),
    POST: (path: Parameters<typeof generated.POST>[0], init?: unknown) => generated.POST(path, safeInit(init) as never),
    DELETE: (path: Parameters<typeof generated.DELETE>[0], init?: unknown) => generated.DELETE(path, safeInit(init) as never),
    OPTIONS: (path: Parameters<typeof generated.OPTIONS>[0], init?: unknown) => generated.OPTIONS(path, safeInit(init) as never),
    HEAD: (path: Parameters<typeof generated.HEAD>[0], init?: unknown) => generated.HEAD(path, safeInit(init) as never),
    PATCH: (path: Parameters<typeof generated.PATCH>[0], init?: unknown) => generated.PATCH(path, safeInit(init) as never),
    TRACE: (path: Parameters<typeof generated.TRACE>[0], init?: unknown) => generated.TRACE(path, safeInit(init) as never),
  }) as unknown as Readonly<Omit<Client<T4ClientPaths>, "use" | "eject">>;
  return Object.freeze({
    http,
    watchSession: (sessionId: string, watchOptions: WatchSessionOptions = {}) =>
      watch(baseUrl, credential, majorVersion, fetchImpl, sessionId, watchOptions),
  });
}
