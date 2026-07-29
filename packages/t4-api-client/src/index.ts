import {
  decodeCapabilities,
  decodeProblemDetails,
  decodeGeneration,
  decodeOpaqueId,
  decodePhase,
  decodeRevision,
  decodeRuntime,
  decodeRuntimePage,
  decodeScopePage,
  decodeTimestamp,
  decodeWorkspace,
  decodeWorkspacePage,
  type Decoder,
} from "@t4-code/portable-core";

import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "./generated/schema.ts";

export type { components, operations, paths } from "./generated/schema.ts";

export type T4ClientPaths = paths;
export type LifecycleEvent = components["schemas"]["InvalidationEvent"] | components["schemas"]["ResetEvent"];

const MAX_CREDENTIAL_LENGTH = 4096;
const MAX_ERROR_BYTES = 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const PUBLIC_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/u;
const SSH_USER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ETAG = /^"[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}"$/u;
const RESOURCE_KINDS = ["scope", "workspace", "runtime"] as const;

export interface T4ApiClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WatchEventsOptions {
  readonly scopeId?: string;
  readonly lastEventId?: string;
  readonly signal?: AbortSignal;
  readonly maxEvents?: number;
  readonly maxReconnectAttempts?: number;
  readonly retryBackoffMs?: number;
  readonly inactivityTimeoutMs?: number;
}

export interface T4ApiClient {
  readonly http: Readonly<Omit<Client<T4ClientPaths>, "use" | "eject">>;
  readonly watchEvents: (options?: WatchEventsOptions) => AsyncGenerator<LifecycleEvent, void, undefined>;
}

type Problem = components["schemas"]["Problem"];

interface ProblemInput {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | null;
  readonly currentRevision?: string | null;
}

export class T4ApiError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly currentRevision: string | undefined;

  constructor(problem: ProblemInput, options?: ErrorOptions) {
    super(problem.detail, options);
    this.name = "T4ApiError";
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.code = problem.code;
    this.retryable = problem.retryable;
    this.retryAfterMs = problem.retryAfterMs ?? undefined;
    this.currentRevision = problem.currentRevision ?? undefined;
  }
}

function protocolError(message: string, cause?: unknown): T4ApiError {
  return new T4ApiError({
    type: "about:blank",
    title: "Bad Gateway",
    status: 502,
    detail: message,
    instance: "/",
    code: "invalid_upstream_response",
    retryable: false,
  }, cause === undefined ? undefined : { cause });
}

function normalizedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("baseUrl must be an absolute HTTPS URL"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("baseUrl must be an absolute HTTPS URL without credentials, query, or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.href.replace(/\/$/u, "");
}

function requiredCredential(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CREDENTIAL_LENGTH || /\p{Cc}/u.test(value)) {
    throw new TypeError("credential must be a non-empty bounded header value");
  }
  return value;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new TypeError(`${label} is out of range`);
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validPublicUrl(value: unknown, protocol: "https:" | "wss:", pathname: string): boolean {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith(`${protocol}//`)) return false;
  try {
    const url = new URL(value);
    return url.protocol === protocol && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname === pathname;
  } catch {
    return false;
  }
}

function validDiscoveryProtocols(value: unknown): boolean {
  const protocols = record(value);
  return protocols !== undefined && hasOnlyKeys(protocols, ["machineProvider", "cmux", "application"]) &&
    Array.isArray(protocols.machineProvider) && protocols.machineProvider.length === 1 && protocols.machineProvider[0] === "machine-provider-v1" &&
    Array.isArray(protocols.cmux) && protocols.cmux.length === 1 && protocols.cmux[0] === 10 &&
    Array.isArray(protocols.application) && protocols.application.length === 1 && protocols.application[0] === "omp-app/1";
}

function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string | undefined> {
  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null && /^(?:0|[1-9]\d*)$/u.test(contentLength) && BigInt(contentLength) > BigInt(maximumBytes)) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximumBytes) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    return undefined;
  } finally {
    try { await reader.cancel(); } catch { /* best effort */ }
    reader.releaseLock();
  }
}

function validDecoded<T>(value: unknown, decoder: Decoder<T>): value is T {
  try {
    decoder(value);
    return true;
  } catch {
    return false;
  }
}

function validTimestamp(value: unknown): value is string {
  return validDecoded(value, decodeTimestamp);
}

function validProblem(value: unknown, status: number): value is Problem {
  try {
    return decodeProblemDetails(value).status === status;
  } catch {
    return false;
  }
}

async function parsedProblem(response: Response): Promise<T4ApiError | undefined> {
  if (mediaType(response) !== "application/problem+json") return undefined;
  const text = await boundedResponseText(response, MAX_ERROR_BYTES);
  let value: unknown;
  try { value = text === undefined ? undefined : JSON.parse(text); } catch { return undefined; }
  return validProblem(value, response.status) ? new T4ApiError(value) : undefined;
}


function validDiscovery(value: unknown): boolean {
  const item = record(value);
  if (item === undefined || !hasOnlyKeys(item, ["service", "apiVersion", "restBaseUrl", "ompAppWebSocketUrl", "cmuxWebSocketTemplate", "ssh", "protocols"]) ||
    item.service !== "omperator" || item.apiVersion !== "v1" || !validPublicUrl(item.restBaseUrl, "https:", "/v1") || !validDiscoveryProtocols(item.protocols)) return false;
  if (item.ompAppWebSocketUrl !== undefined && !validPublicUrl(item.ompAppWebSocketUrl, "wss:", "/v1/ws")) return false;
  if (item.cmuxWebSocketTemplate !== undefined) {
    if (typeof item.cmuxWebSocketTemplate !== "string" || item.cmuxWebSocketTemplate.split("{runtimeId}").length !== 2 ||
      !validPublicUrl(item.cmuxWebSocketTemplate.replace("{runtimeId}", "runtime-template"), "wss:", "/v1/cmux/runtime-template")) return false;
  }
  if (item.ssh === undefined) return true;
  const ssh = record(item.ssh);
  return ssh !== undefined && hasOnlyKeys(ssh, ["host", "port"]) && typeof ssh.host === "string" && PUBLIC_HOST.test(ssh.host) &&
    Number.isInteger(ssh.port) && Number(ssh.port) >= 1 && Number(ssh.port) <= 65_535;
}

function validCapabilities(value: unknown): boolean {
  return validDecoded(value, decodeCapabilities);
}

function validVersion(value: unknown): boolean {
  const item = record(value);
  const build = record(item?.build);
  return item?.apiVersion === "v1" && build !== undefined && typeof build.version === "string" && build.version.length >= 1 && build.version.length <= 64 &&
    typeof build.revision === "string" && build.revision.length >= 1 && build.revision.length <= 128 && validTimestamp(build.builtAt) &&
    validDiscoveryProtocols(item.protocols);
}

function validConnections(value: unknown): boolean {
  const item = record(value);
  if (item === undefined || !hasOnlyKeys(item, ["runtimeId", "generation", "expiresAt", "routes"]) ||
    !validDecoded(item.runtimeId, decodeOpaqueId) || !validDecoded(item.generation, decodeGeneration) ||
    !Array.isArray(item.routes) || item.routes.length > 3 || !validTimestamp(item.expiresAt)) return false;
  const kinds = new Set<string>();
  return item.routes.every((routeValue) => {
    const route = record(routeValue);
    if (route === undefined || typeof route.kind !== "string" || kinds.has(route.kind)) return false;
    kinds.add(route.kind);
    if (route.kind === "machine-provider-ssh") {
      return hasOnlyKeys(route, ["kind", "host", "port", "user", "providerVersion"]) && route.providerVersion === 1 &&
        typeof route.host === "string" && PUBLIC_HOST.test(route.host) && typeof route.user === "string" && SSH_USER.test(route.user) &&
        Number.isInteger(route.port) && Number(route.port) >= 1 && Number(route.port) <= 65_535;
    }
    if (route.kind === "omp-app-websocket") {
      return hasOnlyKeys(route, ["kind", "url", "protocol"]) && route.protocol === "omp-app/1" && validPublicUrl(route.url, "wss:", "/v1/ws");
    }
    return route.kind === "cmux-websocket" && hasOnlyKeys(route, ["kind", "url", "protocol"]) && route.protocol === 10 &&
      validPublicUrl(route.url, "wss:", `/v1/cmux/${item.runtimeId}`);
  });
}

type Validator = (value: unknown) => boolean;
interface ResponseContract {
  readonly success: Readonly<Record<number, Validator | "empty" | "event-stream">>;
  readonly errors: readonly number[];
  readonly etag?: boolean | readonly number[];
  readonly location?: readonly number[];
  readonly noStore?: boolean;
}

const PROBLEM_COMMON = [400, 401, 403, 404, 409, 412, 422, 503] as const;
const PUT_ERRORS = [400, 401, 403, 409, 412, 422, 503] as const;
const WORKSPACE: Validator = (value) => validDecoded(value, decodeWorkspace);
const RUNTIME: Validator = (value) => validDecoded(value, decodeRuntime);
const SCOPE_PAGE: Validator = (value) => validDecoded(value, decodeScopePage);
const WORKSPACE_PAGE: Validator = (value) => validDecoded(value, decodeWorkspacePage);
const RUNTIME_PAGE: Validator = (value) => validDecoded(value, decodeRuntimePage);
const ROUTES: ReadonlyArray<{ method: string; pattern: RegExp; contract: ResponseContract }> = [
  { method: "GET", pattern: /^\/\.well-known\/omperator$/u, contract: { success: { 200: validDiscovery }, errors: [503], noStore: true } },
  { method: "GET", pattern: /^\/v1\/version$/u, contract: { success: { 200: validVersion }, errors: [401, 503] } },
  { method: "GET", pattern: /^\/v1\/capabilities$/u, contract: { success: { 200: validCapabilities }, errors: [401, 503] } },
  { method: "GET", pattern: /^\/v1\/scopes$/u, contract: { success: { 200: SCOPE_PAGE }, errors: [400, 401, 503] } },
  { method: "GET", pattern: /^\/v1\/workspaces$/u, contract: { success: { 200: WORKSPACE_PAGE }, errors: [400, 401, 503] } },
  { method: "GET", pattern: /^\/v1\/workspaces\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: WORKSPACE }, errors: [401, 404, 503], etag: true } },
  { method: "PUT", pattern: /^\/v1\/workspaces\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: WORKSPACE, 201: WORKSPACE, 202: WORKSPACE }, errors: PUT_ERRORS, etag: true, location: [201, 202] } },
  { method: "PATCH", pattern: /^\/v1\/workspaces\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: WORKSPACE, 202: WORKSPACE }, errors: PROBLEM_COMMON, etag: true, location: [202] } },
  { method: "DELETE", pattern: /^\/v1\/workspaces\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 202: WORKSPACE, 204: "empty" }, errors: [401, 403, 404, 409, 412, 503], etag: [202], location: [202] } },
  { method: "GET", pattern: /^\/v1\/runtimes$/u, contract: { success: { 200: RUNTIME_PAGE }, errors: [400, 401, 503] } },
  { method: "GET", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: RUNTIME }, errors: [401, 404, 503], etag: true } },
  { method: "PUT", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: RUNTIME, 201: RUNTIME, 202: RUNTIME }, errors: PUT_ERRORS, etag: true, location: [201, 202] } },
  { method: "PATCH", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 200: RUNTIME, 202: RUNTIME }, errors: PROBLEM_COMMON, etag: true, location: [202] } },
  { method: "DELETE", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u, contract: { success: { 202: RUNTIME, 204: "empty" }, errors: [401, 403, 404, 409, 412, 503], etag: [202], location: [202] } },
  { method: "POST", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}:(?:sleep|wake)$/u, contract: { success: { 200: RUNTIME, 202: RUNTIME }, errors: [401, 403, 404, 409, 412, 503], etag: true, location: [202] } },
  { method: "GET", pattern: /^\/v1\/runtimes\/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}\/connections$/u, contract: { success: { 200: validConnections }, errors: [401, 403, 404, 409, 503], etag: true, noStore: true } },
  { method: "GET", pattern: /^\/v1\/events$/u, contract: { success: { 200: "event-stream" }, errors: [400, 401, 503], noStore: true } },
];

function relativeApiPath(request: Request, baseUrl: string): string | undefined {
  const requestUrl = new URL(request.url);
  const base = new URL(baseUrl);
  if (requestUrl.origin !== base.origin) return undefined;
  const prefix = base.pathname === "/" ? "" : base.pathname;
  if (prefix !== "" && !requestUrl.pathname.startsWith(`${prefix}/`)) return undefined;
  return prefix === "" ? requestUrl.pathname : requestUrl.pathname.slice(prefix.length);
}

function responseContract(method: string, path: string): ResponseContract | undefined {
  return ROUTES.find((route) => route.method === method && route.pattern.test(path))?.contract;
}

function validLocation(response: Response, path: string): boolean {
  const location = response.headers.get("Location");
  const resourcePath = path.replace(/:(?:sleep|wake)$/u, "");
  return location === resourcePath && location.length <= 256;
}

function validPathBinding(path: string, value: unknown): boolean {
  const resource = /^\/v1\/(workspaces|runtimes)\/([^/:]+)(?::(?:sleep|wake)|\/connections)?$/u.exec(path);
  if (resource === null) return true;
  const item = record(value);
  return item?.id === resource[2] || item?.runtimeId === resource[2];
}

async function validateResponse(request: Request, response: Response, baseUrl: string): Promise<void> {
  const path = relativeApiPath(request, baseUrl);
  const contract = path === undefined ? undefined : responseContract(request.method, path);
  const fail = (message: string): never => {
    void response.body?.cancel().catch(() => {});
    throw protocolError(message);
  };
  if (contract === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError("T4 API returned a response for an undeclared route");
  }
  if (response.redirected) fail("T4 API client refused a redirected response");
  if (!response.ok) {
    if (!contract.errors.includes(response.status)) fail("T4 API returned an undeclared error status");
    if (response.status === 401 && response.headers.get("WWW-Authenticate") !== "Bearer") fail("T4 API returned an invalid authentication challenge");
    if (await parsedProblem(response.clone()) === undefined) fail("T4 API returned invalid or oversized Problem Details");
    return;
  }
  const validator = contract.success[response.status];
  if (validator === undefined) {
    void response.body?.cancel().catch(() => {});
    throw protocolError("T4 API returned an undeclared success status");
  }
  if (contract.noStore === true && response.headers.get("Cache-Control") !== "no-store") fail("T4 API response must use Cache-Control: no-store");
  const requiresEtag = contract.etag === true || (Array.isArray(contract.etag) && contract.etag.includes(response.status));
  if (requiresEtag && !ETAG.test(response.headers.get("ETag") ?? "")) fail("T4 API response has a missing or invalid ETag");
  if (contract.location?.includes(response.status) === true && !validLocation(response, path!)) fail("T4 API response has a missing or invalid Location");
  if (validator === "empty") {
    if (response.body !== null || response.headers.has("content-type")) fail("T4 API returned content for a bodyless response");
    return;
  }
  if (validator === "event-stream") {
    if (mediaType(response) !== "text/event-stream") fail("T4 API returned an undeclared event-stream media type");
    return;
  }
  if (mediaType(response) !== "application/json") fail("T4 API returned an undeclared success media type");
  const text = await boundedResponseText(response.clone(), MAX_JSON_RESPONSE_BYTES);
  let value: unknown;
  try { value = text === undefined ? undefined : JSON.parse(text); } catch { value = undefined; }
  if (text === undefined || !validator(value) || !validPathBinding(path!, value)) fail("T4 API returned invalid or oversized JSON");
  const revisionValue = record(value)?.revision;
  if (requiresEtag && typeof revisionValue === "string" && response.headers.get("ETag") !== `"${revisionValue}"`) {
    fail("T4 API response ETag does not match its revision");
  }
}

function lifecycleEvent(value: unknown, sseEvent: string | undefined, sseId: string | undefined): LifecycleEvent {
  const item = record(value);
  if (item === undefined || (sseEvent !== "invalidation" && sseEvent !== "reset") || item.event !== sseEvent || typeof item.eventId !== "string" ||
    !EVENT_ID.test(item.eventId) || item.eventId !== sseId || !validTimestamp(item.timestamp)) throw protocolError("T4 API returned malformed lifecycle event data");
  if (sseEvent === "reset") {
    if (item.reason !== "cursor_expired") throw protocolError("T4 API returned malformed reset event data");
    return item as unknown as components["schemas"]["ResetEvent"];
  }
  if (typeof item.resourceKind !== "string" || !RESOURCE_KINDS.includes(item.resourceKind as typeof RESOURCE_KINDS[number]) ||
    !validDecoded(item.resourceId, decodeOpaqueId) || !validDecoded(item.scopeId, decodeOpaqueId) ||
    !validDecoded(item.revision, decodeRevision) || !validDecoded(item.phase, decodePhase)) {
    throw protocolError("T4 API returned malformed invalidation event data");
  }
  return item as unknown as components["schemas"]["InvalidationEvent"];
}

function decodeSseFrame(frame: string): LifecycleEvent | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r\n|\r|\n/u)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      if (value.includes("\u0000")) throw protocolError("T4 API returned malformed SSE event ID");
      id = value;
    } else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  let value: unknown;
  try { value = JSON.parse(data.join("\n")); } catch { throw protocolError("T4 API returned malformed SSE JSON"); }
  return lifecycleEvent(value, event, id);
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
    if (this.#pendingCarriageReturn >= 0) this.#finishLine(this.#pendingCarriageReturn, []);
    if (this.#length > MAX_EVENT_BYTES) this.#oversized();
    this.#reset();
    return [];
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
    } else {
      this.#lineStart = this.#length;
      if (this.#lineStart > MAX_EVENT_BYTES) this.#oversized();
    }
  }

  #reset(): void { this.#length = 0; this.#lineStart = 0; }
  #oversized(): never { throw protocolError("T4 API lifecycle event exceeds the client bound"); }
}

function decodedFrames(parser: SseFrameParser, chunk?: Uint8Array): LifecycleEvent[] {
  const frames = chunk === undefined ? parser.finish() : parser.push(chunk);
  return frames.flatMap((bytes) => {
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw protocolError("T4 API returned malformed SSE UTF-8"); }
    const event = decodeSseFrame(text);
    return event === undefined ? [] : [event];
  });
}

async function retryDelay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (milliseconds === 0) return true;
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(true); }, milliseconds);
    const abort = (): void => { clearTimeout(timeout); resolve(false); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readWithDeadline(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(signal.reason));
    const timeout = setTimeout(() => finish(() => reject(new TypeError("T4 API event stream exceeded its inactivity deadline"))), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then((result) => finish(() => resolve(result)), (error: unknown) => finish(() => reject(error)));
  });
}

async function* watchEvents(baseUrl: string, credential: string, fetchImpl: typeof globalThis.fetch, options: WatchEventsOptions): AsyncGenerator<LifecycleEvent, void, undefined> {
  const maxEvents = boundedInteger(options.maxEvents, 100, 1, 10_000, "maxEvents");
  const maxReconnectAttempts = boundedInteger(options.maxReconnectAttempts, 3, 0, 10, "maxReconnectAttempts");
  const retryBackoffMs = boundedInteger(options.retryBackoffMs, 250, 0, 30_000, "retryBackoffMs");
  const inactivityTimeoutMs = boundedInteger(options.inactivityTimeoutMs, 30_000, 1_000, 300_000, "inactivityTimeoutMs");
  if (options.scopeId !== undefined && !validDecoded(options.scopeId, decodeOpaqueId)) throw new TypeError("scopeId is invalid");
  if (options.lastEventId !== undefined && !EVENT_ID.test(options.lastEventId)) throw new TypeError("lastEventId is invalid");
  const controller = new AbortController();
  const abort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
  let delivered = 0;
  let lastEventId = options.lastEventId;
  let reconnects = 0;
  const seen = new Set<string>(lastEventId === undefined ? [] : [lastEventId]);
  try {
    while (delivered < maxEvents && !controller.signal.aborted) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let failure: unknown;
      let retryAfterMs = 0;
      const before = delivered;
      try {
        const url = new URL(`${baseUrl}/v1/events`);
        if (options.scopeId !== undefined) url.searchParams.set("scopeId", options.scopeId);
        const headers = new Headers({ Accept: "text/event-stream", Authorization: `Bearer ${credential}` });
        if (lastEventId !== undefined) headers.set("Last-Event-ID", lastEventId);
        const request = new Request(url, { method: "GET", headers, redirect: "error", signal: controller.signal });
        const response = await fetchImpl(request);
        await validateResponse(request, response, baseUrl);
        if (!response.ok) {
          const error = await parsedProblem(response);
          throw error ?? protocolError("T4 API returned invalid Problem Details");
        }
        if (response.body === null) throw protocolError("T4 API event stream body is unavailable");
        reader = response.body.getReader();
        const parser = new SseFrameParser();
        while (delivered < maxEvents && !controller.signal.aborted) {
          const chunk = await readWithDeadline(reader, inactivityTimeoutMs, controller.signal);
          const events = chunk.done ? decodedFrames(parser) : decodedFrames(parser, chunk.value);
          for (const event of events) {
            if (seen.has(event.eventId)) throw protocolError("T4 API repeated a lifecycle event ID");
            seen.add(event.eventId);
            lastEventId = event.eventId;
            reconnects = 0;
            delivered += 1;
            yield event;
            if (delivered >= maxEvents) return;
          }
          if (chunk.done) break;
        }
        failure = new TypeError("T4 API event stream ended before the requested bound");
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof T4ApiError) {
          if (!error.retryable || error.status !== 503) throw error;
          retryAfterMs = error.retryAfterMs ?? 0;
        }
        failure = error;
      } finally {
        if (reader !== undefined) {
          try { await reader.cancel(); } catch { /* best effort */ }
          reader.releaseLock();
        }
      }
      if (delivered === before && reconnects >= maxReconnectAttempts) throw protocolError("T4 API event reconnect attempts exhausted", failure);
      const delay = Math.min(30_000, Math.max(retryAfterMs, retryBackoffMs * (2 ** reconnects)));
      if (delivered === before) reconnects += 1;
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
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const protectedFetch: typeof globalThis.fetch = async (input, init) => {
    const candidate = new Request(input, init);
    const path = relativeApiPath(candidate, baseUrl);
    const contract = path === undefined ? undefined : responseContract(candidate.method, path);
    if (contract === undefined) throw protocolError("T4 API client refused an undeclared or cross-origin request");
    const headers = new Headers(candidate.headers);
    if (path === "/.well-known/omperator") headers.delete("Authorization");
    else headers.set("Authorization", `Bearer ${credential}`);
    headers.set("Accept", contract.success[200] === "event-stream" ? "text/event-stream" : "application/json");
    const request = new Request(candidate, { headers, redirect: "error" });
    const response = await fetchImpl(request);
    await validateResponse(request, response, baseUrl);
    return response;
  };
  const generated = createClient<T4ClientPaths>({ baseUrl, fetch: protectedFetch });
  const forbiddenOverrides = new Set(["baseUrl", "fetch", "headers", "middleware", "querySerializer", "bodySerializer", "pathSerializer", "Request", "method"]);
  const safeInit = (init: unknown): unknown => {
    if (init === undefined) return undefined;
    if (init === null || typeof init !== "object" || Array.isArray(init)) throw new TypeError("T4 API request options must be an object");
    for (const key of Object.keys(init)) if (forbiddenOverrides.has(key)) throw new TypeError(`T4 API request option ${key} is SDK-owned`);
    return init;
  };
  const http = Object.freeze({
    request: (method: Parameters<typeof generated.request>[0], path: Parameters<typeof generated.request>[1], init?: unknown) => generated.request(method, path, safeInit(init) as never),
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
    watchEvents: (watchOptions: WatchEventsOptions = {}) => watchEvents(baseUrl, credential, fetchImpl, watchOptions),
  });
}
