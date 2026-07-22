import { createHmac, timingSafeEqual } from "node:crypto";
import { expect } from "vite-plus/test";

const encoder = new TextEncoder();
const PAGE_CURSOR_SECRET = "t4-api-v1-conformance-page-cursor-secret-2026";
const COMMAND_BYTES_MAX = 32;
const COMMAND_REQUEST_BYTES_MAX = 256;
const METADATA_VALUE_BYTES_MAX = 32;

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}


function validLabels(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 32 && entries.every(([key, item]) =>
    /^[a-z][a-z0-9.-]{0,62}$/u.test(key) && typeof item === "string" && hasAtMostCodePoints(item, 128));
}

function createViolation(body: Record<string, unknown>, textField: "name" | "title"): { field: string; rule: string } | undefined {
  if (Object.keys(body).some((key) => key !== textField && key !== "labels")) return { field: "body", rule: "schema" };
  const text = body[textField];
  if (typeof text !== "string" || text === "" || !hasAtMostCodePoints(text, 128)) return { field: textField, rule: "length" };
  if (body.labels !== undefined && !validLabels(body.labels)) return { field: "labels", rule: "bounds" };
  return undefined;
}

function validMutation(body: Record<string, unknown>, textField: "name" | "title"): boolean {
  const keys = Object.keys(body);
  if (keys.length < 1 || keys.some((key) => key !== textField && key !== "labels")) return false;
  const text = body[textField];
  return (text === undefined || (typeof text === "string" && text !== "" && hasAtMostCodePoints(text, 128))) &&
    (body.labels === undefined || validLabels(body.labels));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "T4-API-Version": "1.0", ...headers } });
}

function problem(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return json(status, { error: { code, message, requestId: `req-${code}`, retryable: status >= 500, ...extra } });
}
const SNAPSHOT_BYTES_MAX = 16 * 1024 * 1024;

function snapshotResponseAtBytes(sessionId: unknown, state: unknown, targetBytes: number): Response {
  const entries = Array.from({ length: 4 }, (_, sequence) => ({ sequence, kind: "output", text: "" }));
  const snapshot = { sessionId, cursor: "cursor-2", state, entries };
  let remaining = targetBytes - encoder.encode(JSON.stringify(snapshot)).byteLength;
  for (const entry of entries) {
    const astralCodePoints = Math.min(1_048_576, Math.floor(remaining / 4));
    entry.text = "💚".repeat(astralCodePoints);
    remaining -= astralCodePoints * 4;
    if (remaining > 0 && remaining < 4) {
      entry.text += "x".repeat(remaining);
      remaining = 0;
    }
  }
  expect(remaining).toBe(0);
  const body = JSON.stringify(snapshot);
  expect(encoder.encode(body).byteLength).toBe(targetBytes);
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json", "T4-API-Version": "1.0" } });
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS only permits finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf16(left, right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("JCS identity requires a JSON value");
}

type PageCursorResult = { readonly offset: number } | { readonly error: "format" | "issued" };

function issuePageCursor(principal: string, collection: string, offset: number): string {
  const payload = Buffer.from(canonicalJson({ principal, collection, offset })).toString("base64url");
  const signature = createHmac("sha256", PAGE_CURSOR_SECRET).update(payload).digest("base64url");
  return `page.${payload}.${signature}`;
}

function decodePageCursor(value: string, principal: string, collection: string): PageCursorResult {
  if (value.length > 512) return { error: "format" };
  const legacy = /^page-(?:0|[1-9][0-9]*)$/u.exec(value);
  if (legacy !== null) return Number.isSafeInteger(Number(value.slice(5))) ? { error: "issued" } : { error: "format" };
  const match = /^page\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value);
  if (match === null) return { error: "format" };
  const expected = createHmac("sha256", PAGE_CURSOR_SECRET).update(match[1]!).digest();
  const signature = Buffer.from(match[2]!, "base64url");
  if (signature.toString("base64url") !== match[2]) return { error: "format" };
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) return { error: "issued" };
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); } catch { return { error: "format" }; }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return { error: "format" };
  const payload = decoded as Record<string, unknown>;
  if (Object.keys(payload).length !== 3 || !Object.hasOwn(payload, "principal") || !Object.hasOwn(payload, "collection") || !Object.hasOwn(payload, "offset") ||
    Buffer.from(canonicalJson(payload)).toString("base64url") !== match[1] ||
    typeof payload.principal !== "string" || typeof payload.collection !== "string" ||
    !Number.isSafeInteger(payload.offset) || Number(payload.offset) < 1) return { error: "format" };
  if (payload.principal !== principal || payload.collection !== collection) return { error: "issued" };
  return { offset: Number(payload.offset) };
}

interface ReplayRecord {
  readonly identity: string;
  readonly body: unknown;
  readonly replayStatus: number;
  readonly cursor: string;
}


export interface T4ApiV1ConformanceOptions {
  readonly invalidPayload?: "discovery" | "workspace" | "session" | "command";
  readonly snapshotBoundary?: "exact" | "over";
  readonly watchTransport?: "normal" | "bytewise" | "oversized" | "many-small";
}

export class T4ApiV1ConformanceService {
  readonly origin = "https://t4-api.conformance.test";
  readonly calls: Array<{ method: string; path: string; authorization: string | null }> = [];
  readonly abortedWatches: string[] = [];
  readonly watchCursors: Array<{ query: string | null; header: string | null }> = [];
  readonly watchQueries: Array<{ maxEvents: string | null; heartbeatSeconds: string | null }> = [];

  #workspaceSequence = 0;
  #sessionSequence = 0;
  #commandSequence = 0;
  #eventSequence = 0;
  readonly #workspaces = new Map<string, Record<string, unknown>>();
  readonly #sessions = new Map<string, Record<string, unknown>>();
  readonly #replays = new Map<string, ReplayRecord>();

  constructor(readonly options: T4ApiV1ConformanceOptions = {}) {}

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    this.calls.push({ method: request.method, path: url.pathname, authorization });
    if (url.origin !== this.origin) return problem(400, "invalid_origin", "HTTPS API origin is fixed for this client");
    if (url.protocol !== "https:") return problem(400, "https_required", "HTTPS is required");
    if (authorization !== "Bearer token-a" && authorization !== "Bearer token-b" && authorization !== "Bearer token-denied") {
      return problem(401, "unauthenticated", "A valid bearer credential is required");
    }
    if (request.headers.get("T4-API-Version") !== "1") {
      return problem(406, "incompatible_version", "No compatible T4 API major version", { supportedMajors: [1] });
    }
    if (authorization === "Bearer token-denied") return problem(403, "forbidden", "Credential lacks the required operation scope");
    const tenant = authorization === "Bearer token-a" ? "tenant-a" : "tenant-b";

    if (request.method === "GET" && url.pathname === "/v1") {
      return json(200, this.#payload("discovery", {
        apiVersion: "1.0",
        serverBuild: { version: "0.1.30", revision: "fixture-revision-1" },
        supportedMajors: [1],
        capabilities: {
          "workspace.lifecycle": { supported: true, enabled: true, authorized: true, available: true },
          "session.lifecycle": { supported: true, enabled: true, authorized: true, available: true },
          "session.commands": { supported: true, enabled: true, authorized: true, available: true },
          "session.watch.sse": { supported: true, enabled: true, authorized: true, available: true },
          "optional.preview": {
            supported: true, enabled: false, authorized: false, available: false,
            deprecation: { message: "Use workspace.lifecycle", sinceVersion: "1.0", sunsetAt: "2027-01-01T00:00:00Z", replacement: "workspace.lifecycle" },
          },
        },
        limits: {
          pageSizeDefault: 2,
          pageSizeMax: 3,
          commandBytesMax: COMMAND_BYTES_MAX,
          commandRequestBytesMax: COMMAND_REQUEST_BYTES_MAX,
          commandMetadataValueBytesMax: METADATA_VALUE_BYTES_MAX,
          watchEventsMax: this.options.watchTransport === "many-small" ? 1000 : 4,
          heartbeatSeconds: 15,
        },
      }));
    }

    if (request.method === "POST" && url.pathname === "/v1/workspaces") {
      const parsed = await this.#jsonBody(request);
      if (parsed instanceof Response) return parsed;
      const body = parsed;
      const violation = createViolation(body, "name");
      if (violation !== undefined) return this.#invalid(violation.field, violation.rule, "workspace create must match WorkspaceCreate");
      return this.#idempotent(request, tenant, "createWorkspace", [], body, 202, 200, () => {
        const id = `ws-${++this.#workspaceSequence}`;
        const workspace = { id, name: body.name, ...(body.labels === undefined ? {} : { labels: body.labels }), state: "accepted", revision: 1, tenant };
        this.#workspaces.set(id, workspace);
        return workspace;
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      const pageSize = Number(url.searchParams.get("pageSize") ?? "2");
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 3) return this.#invalid("pageSize", "range", "pageSize must be between 1 and 3");
      const collection = "workspaces";
      const cursor = url.searchParams.get("cursor");
      let start = 0;
      if (cursor !== null) {
        const decoded = decodePageCursor(cursor, tenant, collection);
        if ("error" in decoded) return this.#invalid("cursor", decoded.error, decoded.error === "format" ? "cursor must be a canonical bounded opaque token" : "cursor was not issued for this principal and collection");
        start = decoded.offset;
      }
      const visible = [...this.#workspaces.values()].filter((item) => item.tenant === tenant);
      if (cursor !== null && start >= visible.length) return this.#invalid("cursor", "issued", "cursor is outside the current collection");
      const items = visible.slice(start, start + pageSize).map(({ tenant: _tenant, ...item }) => item);
      const next = start + items.length < visible.length ? issuePageCursor(tenant, collection, start + items.length) : undefined;
      return json(200, { items, ...(next === undefined ? {} : { nextCursor: next }) });
    }

    const workspaceMatch = url.pathname.match(/^\/v1\/workspaces\/([^/]+)$/u);
    if (workspaceMatch) {
      const id = decodeURIComponent(workspaceMatch[1]!);
      if (request.method === "PATCH") {
        const ifMatch = request.headers.get("If-Match");
        if (ifMatch === null || !/^[1-9][0-9]{0,18}$/u.test(ifMatch)) return problem(400, "invalid_request", "If-Match is invalid");
      }
      const workspace = this.#workspaces.get(id);
      if (request.method === "DELETE") {
        return this.#idempotent(request, tenant, "deleteWorkspace", [id], null, 204, 204, () => {
          this.#workspaces.delete(id);
          return null;
        }, () => workspace?.tenant === tenant ? undefined : problem(404, "not_found", "Workspace not found"));
      }
      if (workspace?.tenant !== tenant) return problem(404, "not_found", "Workspace not found");
      if (request.method === "GET") return json(200, this.#payload("workspace", this.#visible(workspace)));
      if (request.method === "PATCH") {
        const parsed = await this.#jsonBody(request);
        if (parsed instanceof Response) return parsed;
        const body = parsed;
        if (!validMutation(body, "name")) return this.#invalid("body", "schema", "workspace mutation must match WorkspaceMutation");
        return this.#idempotent(request, tenant, "mutateWorkspace", [id], body, 200, 200, () => {
          const updated = { ...workspace, ...(body.name === undefined ? {} : { name: body.name }), ...(body.labels === undefined ? {} : { labels: body.labels }), revision: Number(workspace.revision) + 1 };
          this.#workspaces.set(id, updated);
          return updated;
        }, () => request.headers.get("If-Match") === String(workspace.revision) ? undefined : problem(409, "revision_conflict", "Workspace revision changed"));
      }
    }

    const sessionsPath = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/sessions$/u);
    if (sessionsPath) {
      const workspaceId = decodeURIComponent(sessionsPath[1]!);
      const workspace = this.#workspaces.get(workspaceId);
      if (workspace?.tenant !== tenant) return problem(404, "not_found", "Workspace not found");
      if (request.method === "POST") {
        const parsed = await this.#jsonBody(request);
        if (parsed instanceof Response) return parsed;
        const body = parsed;
        const violation = createViolation(body, "title");
        if (violation !== undefined) return this.#invalid(violation.field, violation.rule, "session create must match SessionCreate");
        return this.#idempotent(request, tenant, "spawnSession", [workspaceId], body, 202, 200, () => {
          const id = `ses-${++this.#sessionSequence}`;
          const session = { id, workspaceId, title: body.title, ...(body.labels === undefined ? {} : { labels: body.labels }), state: "accepted", revision: 1, tenant };
          this.#sessions.set(id, session);
          return session;
        });
      }
      if (request.method === "GET") {
        const pageSize = Number(url.searchParams.get("pageSize") ?? "2");
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 3) return this.#invalid("pageSize", "range", "pageSize must be between 1 and 3");
        const collection = `workspaces/${workspaceId}/sessions`;
        const cursor = url.searchParams.get("cursor");
        let start = 0;
        if (cursor !== null) {
          const decoded = decodePageCursor(cursor, tenant, collection);
          if ("error" in decoded) return this.#invalid("cursor", decoded.error, decoded.error === "format" ? "cursor must be a canonical bounded opaque token" : "cursor was not issued for this principal and collection");
          start = decoded.offset;
        }
        const visible = [...this.#sessions.values()].filter((item) => item.workspaceId === workspaceId && item.tenant === tenant);
        if (cursor !== null && start >= visible.length) return this.#invalid("cursor", "issued", "cursor is outside the current collection");
        const items = visible.slice(start, start + pageSize).map((item) => this.#visible(item));
        const next = start + items.length < visible.length ? issuePageCursor(tenant, collection, start + items.length) : undefined;
        return json(200, { items, ...(next === undefined ? {} : { nextCursor: next }) });
      }
    }

    const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/u);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]!);
      if (request.method === "PATCH") {
        const ifMatch = request.headers.get("If-Match");
        if (ifMatch === null || !/^[1-9][0-9]{0,18}$/u.test(ifMatch)) return problem(400, "invalid_request", "If-Match is invalid");
      }
      const session = this.#sessions.get(id);
      if (request.method === "DELETE") {
        return this.#idempotent(request, tenant, "deleteSession", [id], null, 204, 204, () => {
          this.#sessions.delete(id);
          return null;
        }, () => session?.tenant === tenant ? undefined : problem(404, "not_found", "Session not found"));
      }
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      if (request.method === "GET") return json(200, this.#payload("session", this.#visible(session)));
      if (request.method === "PATCH") {
        const parsed = await this.#jsonBody(request);
        if (parsed instanceof Response) return parsed;
        const body = parsed;
        if (!validMutation(body, "title")) return this.#invalid("body", "schema", "session mutation must match SessionMutation");
        return this.#idempotent(request, tenant, "mutateSession", [id], body, 200, 200, () => {
          const updated = { ...session, ...(body.title === undefined ? {} : { title: body.title }), ...(body.labels === undefined ? {} : { labels: body.labels }), revision: Number(session.revision) + 1 };
          this.#sessions.set(id, updated);
          return updated;
        }, () => request.headers.get("If-Match") === String(session.revision) ? undefined : problem(409, "revision_conflict", "Session revision changed"));
      }
    }

    const cancelMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/u);
    if (cancelMatch && request.method === "POST") {
      const id = decodeURIComponent(cancelMatch[1]!);
      const session = this.#sessions.get(id);
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      return this.#idempotent(request, tenant, "cancelSession", [id], null, 202, 200, () => {
        const cancelled = { ...session, state: "cancelled", revision: Number(session.revision) + 1 };
        this.#sessions.set(id, cancelled);
        return cancelled;
      });
    }

    const commandMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/commands$/u);
    if (commandMatch && request.method === "POST") {
      const id = decodeURIComponent(commandMatch[1]!);
      const session = this.#sessions.get(id);
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      const mediaError = this.#jsonMediaError(request);
      if (mediaError !== undefined) return mediaError;
      const text = await request.text();
      if (encoder.encode(text).byteLength > COMMAND_REQUEST_BYTES_MAX) return this.#invalid("body", "maxBytes", `request must not exceed ${COMMAND_REQUEST_BYTES_MAX} UTF-8 bytes`);
      let decoded: unknown;
      try { decoded = JSON.parse(text); } catch { return problem(400, "invalid_request", "Malformed JSON request"); }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return this.#invalid("body", "schema", "command create must match CommandCreate");
      const body = decoded as Record<string, unknown>;
      if (Object.keys(body).some((key) => key !== "command" && key !== "metadata")) return this.#invalid("body", "schema", "command create must match CommandCreate");
      if (typeof body.command !== "string" || body.command.length < 1 || encoder.encode(body.command).byteLength > COMMAND_BYTES_MAX) return this.#invalid("command", "maxBytes", `command must contain 1 to ${COMMAND_BYTES_MAX} UTF-8 bytes`);
      if (!this.#validMetadata(body.metadata)) return this.#invalid("metadata", "bounds", "metadata keys and values exceed the discovered bounds");
      const states: Record<string, true> = { accepted: true, projected: true, dispatching: true, running: true, succeeded: true, failed: true, cancelling: true, cancelled: true, rejected: true, unavailable: true, indeterminate: true };
      const state = states[body.command] === true ? body.command : "accepted";
      return this.#idempotent(request, tenant, "submitCommand", [id], { metadata: {}, ...body }, 202, 200, () => ({ commandId: `cmd-${++this.#commandSequence}`, state }));
    }

    const snapshotMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/snapshot$/u);
    if (snapshotMatch && request.method === "GET") {
      const session = this.#sessions.get(decodeURIComponent(snapshotMatch[1]!));
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      if (this.options.snapshotBoundary !== undefined) {
        return snapshotResponseAtBytes(session.id, session.state, SNAPSHOT_BYTES_MAX + (this.options.snapshotBoundary === "over" ? 1 : 0));
      }
      return json(200, { sessionId: session.id, cursor: "cursor-2", state: session.state, entries: [{ sequence: 2, kind: "output", text: "ready" }] });
    }

    const watchMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
    if (watchMatch && request.method === "GET") {
      if (request.headers.get("Accept") !== "text/event-stream") return problem(406, "incompatible_version", "Watch requests must accept text/event-stream", { supportedMajors: [1] });
      const id = decodeURIComponent(watchMatch[1]!);
      const session = this.#sessions.get(id);
      if (session?.tenant !== tenant) return problem(404, "not_found", "Session not found");
      const maxEvents = Number(url.searchParams.get("maxEvents") ?? "100");
      const heartbeat = Number(url.searchParams.get("heartbeatSeconds") ?? "15");
      this.watchQueries.push({ maxEvents: url.searchParams.get("maxEvents"), heartbeatSeconds: url.searchParams.get("heartbeatSeconds") });
      if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > (this.options.watchTransport === "many-small" ? 1000 : 4)) return this.#invalid("maxEvents", "range", "maxEvents exceeds the discovered bound");
      if (!Number.isInteger(heartbeat) || heartbeat < 5 || heartbeat > 60) return this.#invalid("heartbeatSeconds", "range", "heartbeatSeconds must be between 5 and 60");
      const queryCursor = url.searchParams.get("cursor");
      const headerCursor = request.headers.get("Last-Event-ID");
      this.watchCursors.push({ query: queryCursor, header: headerCursor });
      if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) return problem(400, "invalid_request", "Reconnect cursors disagree");
      const cursor = queryCursor ?? headerCursor;
      if (cursor === "expired") return problem(410, "cursor_expired", "Watch cursor is no longer retained", { resync: { snapshotUrl: `/v1/sessions/${id}/snapshot`, cursor: "cursor-2" } });
      const allFrames = cursor === "cursor-4"
        ? [`id: cursor-4\r\nevent: heartbeat\r\ndata: {"type":"heartbeat","cursor":"cursor-4","observedAt":"2026-07-21T00:00:15Z"}\r\n\r\n`]
        : cursor === "cursor-5"
          ? [`id: cursor-6\nevent: command\ndata: {"type":"command","cursor":"cursor-6","commandId":"cmd-1","state":"accepted"}\n\n`]
          : [
              `id: ${cursor ?? "cursor-3"}\r\nevent: heartbeat\r\ndata: {"type":"heartbeat","cursor":"${cursor ?? "cursor-3"}","observedAt":"2026-07-21T00:00:00Z"}\r\n\r\n`,
              `id: cursor-4\r\nevent: session\r\ndata: {"type":"session","cursor":"cursor-4","state":"accepted","revision":2}\r\n\r\n`,
            ];
      let payload: Uint8Array;
      if (this.options.watchTransport === "oversized") {
        payload = encoder.encode(`: ${"x".repeat(1024 * 1024)}\ndata: {"type":"heartbeat","cursor":"large-1","observedAt":"2026-07-21T00:00:00Z"}\n\n`);
      } else if (this.options.watchTransport === "many-small") {
        payload = encoder.encode(Array.from({ length: maxEvents }, () => `: ${"x".repeat(1010)}\ndata: {"type":"heartbeat","cursor":"bulk-0","observedAt":"2026-07-21T00:00:00Z"}\n\n`).join(""));
      } else {
        const prefix = this.options.watchTransport === "bytewise" ? ": 💚\n" : "";
        payload = encoder.encode(prefix + allFrames.slice(0, maxEvents).join(""));
      }
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          if (this.options.watchTransport === "bytewise") {
            for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
          } else {
            const split = Math.max(1, payload.byteLength - 3);
            controller.enqueue(payload.slice(0, split));
            controller.enqueue(payload.slice(split));
          }
          controller.close();
          request.signal.addEventListener("abort", () => this.abortedWatches.push(id), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "T4-API-Version": "1.0" } });
    }

    return problem(404, "not_found", "Resource not found");
  };

  expectNoCredentialLeak(): void {
    expect(this.calls.every((call) => call.authorization === "Bearer token-a" || call.authorization === "Bearer token-b" || call.authorization === "Bearer token-denied")).toBe(true);
  }

  #jsonMediaError(request: Request): Response | undefined {
    const mediaType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    return mediaType === "application/json" ? undefined : problem(400, "invalid_request", "Content-Type must be application/json");
  }

  async #jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
    const mediaError = this.#jsonMediaError(request);
    if (mediaError !== undefined) return mediaError;
    try {
      const value: unknown = await request.json();
      if (value === null || typeof value !== "object" || Array.isArray(value)) return problem(400, "invalid_request", "JSON request body must be an object");
      return value as Record<string, unknown>;
    } catch {
      return problem(400, "invalid_request", "Malformed JSON request");
    }
  }

  #payload(kind: T4ApiV1ConformanceOptions["invalidPayload"], value: Record<string, unknown>): Record<string, unknown> {
    return this.options.invalidPayload === kind ? { ...value, unknown: true } : value;
  }

  #invalid(field: string, rule: string, message: string): Response {
    return problem(422, "invalid_request", "Request validation failed", { violations: [{ field, rule, message }] });
  }

  #visible(value: Record<string, unknown>): Record<string, unknown> {
    const { tenant: _tenant, ...visible } = value;
    return visible;
  }

  #validMetadata(value: unknown): boolean {
    if (value === undefined) return true;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 32 && entries.every(([key, item]) =>
      /^[a-z][a-z0-9.-]{0,62}$/u.test(key) &&
      (item === null || typeof item === "boolean" ||
        (typeof item === "number" && Number.isSafeInteger(item)) ||
        (typeof item === "string" && encoder.encode(item).byteLength <= METADATA_VALUE_BYTES_MAX)));
  }


  #idempotent(
    request: Request,
    principal: string,
    operationId: string,
    targets: readonly string[],
    body: unknown,
    firstStatus: number,
    replayStatus: number,
    create: () => unknown,
    validate?: () => Response | undefined,
  ): Response {
    const key = request.headers.get("Idempotency-Key");
    if (key === null) return problem(400, "idempotency_key_required", "Idempotency-Key is required");
    if (!/^[A-Za-z0-9._~-]{16,128}$/u.test(key)) return problem(400, "invalid_request", "Idempotency-Key is invalid");
    const preconditions = request.headers.has("If-Match") ? { "if-match": request.headers.get("If-Match") } : {};
    const identity = canonicalJson({ operationId, targets, preconditions, body });
    const scope = canonicalJson({ principal, operationId, targets, key });
    const prior = this.#replays.get(scope);
    if (prior !== undefined) {
      if (prior.identity !== identity) return problem(409, "idempotency_conflict", "Idempotency key was reused with a different canonical request");
      const headers = { "T4-API-Version": "1.0", "Idempotency-Replayed": "true", "T4-Event-Cursor": prior.cursor };
      return prior.body === null
        ? new Response(null, { status: prior.replayStatus, headers })
        : json(prior.replayStatus, prior.body, headers);
    }
    const validation = validate?.();
    if (validation !== undefined) return validation;
    const created = create();
    const cursor = `event-${++this.#eventSequence}`;
    const visibleValue = created !== null && typeof created === "object" && !Array.isArray(created)
      ? this.#visible(created as Record<string, unknown>)
      : created;
    const responseKind = operationId === "submitCommand"
      ? "command"
      : operationId === "spawnSession" || operationId === "mutateSession" || operationId === "cancelSession"
        ? "session"
        : operationId === "createWorkspace" || operationId === "mutateWorkspace"
          ? "workspace"
          : undefined;
    const visible = visibleValue !== null && typeof visibleValue === "object" && !Array.isArray(visibleValue) && responseKind !== undefined
      ? this.#payload(responseKind, visibleValue as Record<string, unknown>)
      : visibleValue;
    this.#replays.set(scope, { identity, body: visible, replayStatus, cursor });
    const headers = { "Idempotency-Replayed": "false", "T4-Event-Cursor": cursor };
    return visible === null
      ? new Response(null, { status: firstStatus, headers: { "T4-API-Version": "1.0", ...headers } })
      : json(firstStatus, visible, headers);
  }
}
