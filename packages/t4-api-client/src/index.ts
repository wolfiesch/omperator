import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema.ts";

export type { components, operations, paths } from "./generated/schema.ts";

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const CURSOR_PATTERN = /^[A-Za-z0-9._~-]+$/u;
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
const OPERATION_STATES = {
  accepted: true, rejected: true, conflict: true, unavailable: true, indeterminate: true,
} as const satisfies Record<components["schemas"]["OperationState"], true>;

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
  readonly http: Client<paths>;
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

function validResync(value: unknown): value is Resync {
  const resync = record(value);
  return resync !== undefined && Object.keys(resync).every((key) => key === "snapshotUrl" || key === "cursor") &&
    typeof resync.snapshotUrl === "string" && hasAtMostCodePoints(resync.snapshotUrl, 512) && /^\/v1\/sessions\/[A-Za-z0-9._~-]+\/snapshot$/u.test(resync.snapshotUrl) &&
    typeof resync.cursor === "string" && hasAtMostCodePoints(resync.cursor, 512) && CURSOR_PATTERN.test(resync.cursor);
}

function apiError(value: unknown, status: number): ApiError | undefined {
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
    (error.supportedMajors !== undefined && (!Array.isArray(error.supportedMajors) || error.supportedMajors.length > 8 || !error.supportedMajors.every((major) => Number.isSafeInteger(major) && Number(major) >= 1))) ||
    (error.resync !== undefined && !validResync(error.resync)) ||
    (status === 406 && (error.code !== "incompatible_version" || !Array.isArray(error.supportedMajors) || error.supportedMajors.length < 1)) ||
    (status === 410 && (error.code !== "cursor_expired" || !validResync(error.resync))) ||
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

function retryAfterMilliseconds(response: Response): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^[0-9]+$/u.test(value)) return Math.min(30_000, Number(value) * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
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

async function parsedError(response: Response): Promise<T4ApiError | undefined> {
  if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  const text = await boundedResponseText(response);
  if (text === undefined) return undefined;
  try {
    const decoded = apiError(JSON.parse(text), response.status);
    if (decoded === undefined) return undefined;
    const retryAfterMs = retryAfterMilliseconds(response);
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
    typeof item.state === "string" && OPERATION_STATES[item.state as components["schemas"]["OperationState"]] === true;
}

function validDiscovery(value: unknown): boolean {
  const discovery = record(value);
  const limits = record(discovery?.limits);
  return discovery !== undefined && hasOnlyKeys(discovery, { apiVersion: true, supportedMajors: true, capabilities: true, limits: true }) &&
    typeof discovery.apiVersion === "string" && /^1\.[0-9]+$/u.test(discovery.apiVersion) &&
    Array.isArray(discovery.supportedMajors) && discovery.supportedMajors.length >= 1 && discovery.supportedMajors.length <= 8 && discovery.supportedMajors.every((major) => Number.isSafeInteger(major) && Number(major) >= 1) &&
    Array.isArray(discovery.capabilities) && discovery.capabilities.length <= 128 && discovery.capabilities.every((capability) => typeof capability === "string" && /^[a-z][a-z0-9.-]{0,127}$/u.test(capability)) &&
    limits !== undefined && hasOnlyKeys(limits, { pageSizeDefault: true, pageSizeMax: true, commandBytesMax: true, commandRequestBytesMax: true, commandMetadataValueBytesMax: true, watchEventsMax: true, heartbeatSeconds: true }) &&
    [limits.pageSizeDefault, limits.pageSizeMax, limits.commandBytesMax, limits.commandRequestBytesMax, limits.commandMetadataValueBytesMax, limits.watchEventsMax, limits.heartbeatSeconds].every((limit) => Number.isSafeInteger(limit) && Number(limit) >= 1) &&
    Number(limits.pageSizeDefault) <= Number(limits.pageSizeMax) && Number(limits.commandBytesMax) <= Number(limits.commandRequestBytesMax) && Number(limits.commandMetadataValueBytesMax) <= Number(limits.commandRequestBytesMax) &&
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
}

const DISCOVERY_RESPONSE: ResponseContract = { success: { 200: validDiscovery }, errors: [401, 403, 406, 503] };
const WORKSPACE_LIST_RESPONSE: ResponseContract = { success: { 200: validWorkspacePage }, errors: [400, 401, 403, 406, 422, 503] };
const WORKSPACE_CREATE_RESPONSE: ResponseContract = { success: { 200: validWorkspace, 202: validWorkspace }, errors: [400, 401, 403, 406, 409, 422, 503] };
const WORKSPACE_GET_RESPONSE: ResponseContract = { success: { 200: validWorkspace }, errors: [401, 403, 404, 406, 503] };
const WORKSPACE_MUTATE_RESPONSE: ResponseContract = { success: { 200: validWorkspace }, errors: [400, 401, 403, 404, 406, 409, 422, 503] };
const DELETE_RESPONSE: ResponseContract = { success: { 204: "empty" }, errors: [400, 401, 403, 404, 406, 409, 503] };
const SESSION_LIST_RESPONSE: ResponseContract = { success: { 200: validSessionPage }, errors: [401, 403, 404, 406, 422, 503] };
const SESSION_CREATE_RESPONSE: ResponseContract = { success: { 200: validSession, 202: validSession }, errors: [400, 401, 403, 404, 406, 409, 422, 503] };
const SESSION_GET_RESPONSE: ResponseContract = { success: { 200: validSession }, errors: [401, 403, 404, 406, 503] };
const SESSION_MUTATE_RESPONSE: ResponseContract = { success: { 200: validSession }, errors: [400, 401, 403, 404, 406, 409, 422, 503] };
const SESSION_CANCEL_RESPONSE: ResponseContract = { success: { 200: validSession, 202: validSession }, errors: [400, 401, 403, 404, 406, 409, 503] };
const COMMAND_RESPONSE: ResponseContract = { success: { 200: validCommandResult, 202: validCommandResult }, errors: [400, 401, 403, 404, 406, 409, 422, 503] };
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

async function validateResponse(request: Request, response: Response, baseUrl: string): Promise<void> {
  const path = relativeApiPath(request, baseUrl);
  const contract = path === undefined ? undefined : responseContract(request.method, path);
  if (contract === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(response.ok ? 502 : response.status, "T4 API returned a response for an undeclared route");
  }
  if (!response.ok) {
    if (!contract.errors.includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(response.status, "T4 API returned an undeclared error status");
    }
    if (await parsedError(response.clone()) === undefined) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(response.status, "T4 API returned an invalid or oversized error envelope");
    }
    return;
  }
  const validator = contract.success[response.status];
  if (validator === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned an undeclared success status");
  }
  if (validator === "empty") {
    if (response.body !== null || response.headers.has("content-type")) {
      void response.body?.cancel().catch(() => {});
      throw protocolError(502, "T4 API returned content for a bodyless response");
    }
    return;
  }
  if (validator === "event-stream") {
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
  if (text === undefined || !validator(value)) {
    void response.body?.cancel().catch(() => {});
    throw protocolError(502, "T4 API returned an invalid or oversized JSON response");
  }
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
    typeof event.observedAt === "string" && hasAtMostCodePoints(event.observedAt, 64) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(event.observedAt) &&
    Number.isFinite(Date.parse(event.observedAt))
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
    OPERATION_STATES[event.state as components["schemas"]["OperationState"]] === true
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
    if (this.#length > 0) {
      if (this.#length > MAX_EVENT_BYTES) this.#oversized();
      frames.push(this.#buffer.slice(0, this.#length));
      this.#reset();
    }
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

async function* watch(
  baseUrl: string,
  credential: string,
  majorVersion: string,
  fetchImpl: typeof globalThis.fetch,
  sessionIdValue: string,
  options: WatchSessionOptions,
): AsyncGenerator<WatchEvent, void, undefined> {
  const sessionId = requiredSessionId(sessionIdValue);
  const maxEvents = boundedInteger(options.maxEvents, 100, 1, 1000, "maxEvents");
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
          const error = await parsedError(response);
          throw error ?? protocolError(502, "T4 API returned an invalid or oversized error envelope");
        }
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API returned an undeclared watch success status");
        }
        if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream") {
          void response.body?.cancel().catch(() => {});
          throw protocolError(502, "T4 API watch did not return text/event-stream");
        }
        if (response.body === null) throw protocolError(502, "T4 API watch response body is unavailable");
        reader = response.body.getReader();
        const parser = new SseFrameParser();
        while (delivered < maxEvents && !controller.signal.aborted) {
          const chunk = await reader.read();
          const events = chunk.done ? decodedFrames(parser, undefined) : decodedFrames(parser, chunk.value);
          for (const event of events) {
            cursor = event.cursor;
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
    const request = new Request(input, init);
    request.headers.set("Authorization", `Bearer ${credential}`);
    request.headers.set("T4-API-Version", majorVersion);
    request.headers.set("Accept", "application/json");
    const response = await fetchImpl(request);
    await validateResponse(request, response, baseUrl);
    return response;
  };
  const http = createClient<paths>({ baseUrl, fetch: authenticatedFetch });
  return Object.freeze({
    http,
    watchSession: (sessionId: string, watchOptions: WatchSessionOptions = {}) =>
      watch(baseUrl, credential, majorVersion, fetchImpl, sessionId, watchOptions),
  });
}
