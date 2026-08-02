import type { components, T4Fetch } from "../../t4-api-client/src/index.ts";

type Scope = components["schemas"]["Scope"];
type Workspace = components["schemas"]["Workspace"];
type Runtime = components["schemas"]["Runtime"];
type LifecycleEvent = components["schemas"]["InvalidationEvent"] | components["schemas"]["ResetEvent"];

type Principal = "principal-a" | "principal-b";
type Stored<T> = { readonly principal: Principal; value: T; readonly createIdentity: string };
type ActionReplay = { readonly identity: string; readonly value: Runtime; readonly etag: string };

const encoder = new TextEncoder();
const NOW = "2026-07-28T12:00:00.000Z";
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

export interface T4ApiV1ConformanceOptions {
  readonly origin?: string;
  readonly features?: Partial<{
    readonly browser: boolean;
    readonly directCmuxWebSocket: boolean;
    readonly restLifecycle: boolean;
    readonly scaleToZero: boolean;
    readonly sshProvider: boolean;
  }>;
  readonly invalidPayload?: "discovery" | "workspace" | "runtime" | "runtime-bounds" | "capabilities" | "page" | "connections" | "problem";
  readonly eventStream?: "normal" | "bytewise" | "malformed" | "oversized" | "reconnect";
  readonly responseOverride?: (request: Request, response: Response) => Response;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function problem(status: number, code: string, detail: string, instance: string, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    type: `https://omperator.dev/problems/${code}`,
    title: code.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" "),
    status,
    detail,
    instance,
    code,
    retryable: status === 503,
    ...extra,
  }), { status, headers: { "Content-Type": "application/problem+json", ...(status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) } });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function etag(revision: string): string { return `"${revision}"`; }

function revision(sequence: number): string { return `rev:${sequence.toString(36)}`; }

function visible<T>(stored: Stored<T> | undefined, principal: Principal): T | undefined {
  return stored?.principal === principal ? stored.value : undefined;
}

function parseJson(request: Request): Promise<Record<string, unknown> | undefined> {
  const media = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (media !== "application/json" && media !== "application/merge-patch+json") return Promise.resolve(undefined);
  return request.json().then((value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined, () => undefined);
}

function validWorkspaceCreate(body: Record<string, unknown> | undefined): body is components["schemas"]["WorkspaceCreate"] {
  return body !== undefined && Object.keys(body).every((key) => ["scopeId", "displayName", "capacityBytes", "retention"].includes(key)) &&
    typeof body.scopeId === "string" && typeof body.displayName === "string" && body.displayName.length > 0 && body.displayName.length <= 128 &&
    Number.isSafeInteger(body.capacityBytes) && Number(body.capacityBytes) >= 1_073_741_824 && Number(body.capacityBytes) <= 10_995_116_277_760 &&
    (body.retention === "Retain" || body.retention === "Delete");
}

function validIdlePolicy(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const keys = Object.keys(policy);
  if (policy.enabled === false) return keys.length === 1 && keys[0] === "enabled";
  return policy.enabled === true && keys.length === 2 && keys.includes("enabled") && keys.includes("idleSeconds") &&
    Number.isInteger(policy.idleSeconds) && Number(policy.idleSeconds) >= 60 && Number(policy.idleSeconds) <= 2_592_000;
}

function validRuntimeCreate(body: Record<string, unknown> | undefined): body is components["schemas"]["RuntimeCreate"] {
  return body !== undefined && Object.keys(body).every((key) => ["scopeId", "workspaceId", "displayName", "hostProfileId", "desiredState", "browserPolicy", "idlePolicy"].includes(key)) &&
    typeof body.scopeId === "string" && OPAQUE_ID.test(body.scopeId) && typeof body.workspaceId === "string" && OPAQUE_ID.test(body.workspaceId) &&
    typeof body.displayName === "string" && body.displayName.length >= 1 && body.displayName.length <= 128 &&
    typeof body.hostProfileId === "string" && OPAQUE_ID.test(body.hostProfileId) &&
    (body.desiredState === "Running" || body.desiredState === "Sleeping" || body.desiredState === "Stopped") &&
    (body.browserPolicy === "Allowed" || body.browserPolicy === "Disabled") &&
    (body.idlePolicy === undefined || validIdlePolicy(body.idlePolicy));
}

export class T4ApiV1ConformanceService {
  readonly origin: string;
  readonly calls: Array<{ readonly method: string; readonly path: string; readonly authorization: string | null; readonly headers: Headers }> = [];
  readonly watchCursors: Array<{ readonly scopeId: string | null; readonly lastEventId: string | null }> = [];
  readonly abortedWatches: string[] = [];

  readonly #scopes = new Map<Principal, Scope[]>([
    ["principal-a", [
      { id: "scope-a", displayName: "Personal", kind: "Personal", revision: "scope:a:1" },
      { id: "scope-team", displayName: "Team", kind: "Team", revision: "scope:team:1" },
    ]],
    ["principal-b", [{ id: "scope-b", displayName: "Other", kind: "Personal", revision: "scope:b:1" }]],
  ]);
  readonly #workspaces = new Map<string, Stored<Workspace>>();
  readonly #runtimes = new Map<string, Stored<Runtime>>();
  readonly #actions = new Map<string, ActionReplay>();
  readonly #journal: LifecycleEvent[] = [];
  #revisionSequence = 0;
  #eventSequence = 0;
  #streamSequence = 0;
  readonly #features: {
    readonly browser: boolean;
    readonly directCmuxWebSocket: boolean;
    readonly restLifecycle: boolean;
    readonly scaleToZero: boolean;
    readonly sshProvider: boolean;
  };

  constructor(readonly options: T4ApiV1ConformanceOptions = {}) {
    const origin = new URL(options.origin ?? "https://t4-api.conformance.test");
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new TypeError("conformance origin must be an HTTPS origin");
    }
    this.origin = origin.origin;
    this.#features = Object.freeze({
      browser: true,
      directCmuxWebSocket: true,
      restLifecycle: true,
      scaleToZero: true,
      sshProvider: true,
      ...options.features,
    });
  }

  readonly fetch: T4Fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    this.calls.push({ method: request.method, path: url.pathname, authorization: headers.get("Authorization"), headers });
    let response = await this.#route(request, url);
    if (this.options.responseOverride !== undefined) response = this.options.responseOverride(request, response);
    return response;
  };

  async #route(request: Request, url: URL): Promise<Response> {
    if (url.origin !== this.origin || url.protocol !== "https:") return problem(400, "invalid_origin", "The API origin is fixed", url.pathname);
    if (request.method === "GET" && url.pathname === "/.well-known/omperator") {
      if (request.headers.has("Authorization")) return problem(400, "credential_disclosure", "Discovery must not receive credentials", url.pathname);
      const authority = new URL(this.origin);
      const payload = {
        service: "omperator",
        apiVersion: "v1",
        restBaseUrl: `${this.origin}/v1`,
        ompAppWebSocketUrl: `wss://${authority.host}/v1/ws`,
        ...(this.#features.directCmuxWebSocket ? { cmuxWebSocketTemplate: `wss://${authority.host}/v1/cmux/{runtimeId}` } : {}),
        ...(this.#features.sshProvider ? { ssh: { host: `ssh.${authority.hostname}`, port: 22 } } : {}),
        protocols: { application: ["omp-app/1"], cmux: [10], machineProvider: ["machine-provider-v1"] },
      };
      return json(200, this.options.invalidPayload === "discovery" ? { ...payload, service: "other" } : payload, { "Cache-Control": "no-store" });
    }

    const authorization = request.headers.get("Authorization");
    if (authorization !== "Bearer token-a" && authorization !== "Bearer token-b") return this.#problem(401, "unauthenticated", "A bearer credential is required", url.pathname);
    const principal: Principal = authorization === "Bearer token-a" ? "principal-a" : "principal-b";

    if (request.method === "GET" && url.pathname === "/v1/version") {
      return json(200, {
        apiVersion: "v1",
        build: { version: "1.0.0", revision: "fixture-build-1", builtAt: NOW },
        protocols: { application: ["omp-app/1"], cmux: [10], machineProvider: ["machine-provider-v1"] },
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/capabilities") {
      const payload = {
        apiVersion: "v1",
        features: this.#features,
        limits: { eventRetentionSeconds: 3600, idempotencyRetentionSeconds: 86_400, maxActiveRuntimes: 8, maxPageSize: 100, maxRetainedRuntimes: 64 },
        protocols: {
          machineProvider: { versions: [1], capabilities: ["machine-lifecycle-v1"] },
          ompApp: { versions: [1] },
          cmux: { versions: [10] },
        },
      };
      return json(200, this.options.invalidPayload === "capabilities" ? { ...payload, limits: { ...payload.limits, maxPageSize: 201 } } : payload);
    }
    if (request.method === "GET" && url.pathname === "/v1/scopes") return this.#page(url, principal, "scopes", this.#scopes.get(principal) ?? []);
    if (request.method === "GET" && url.pathname === "/v1/workspaces") {
      const values = [...this.#workspaces.values()].filter((item) => item.principal === principal).map((item) => item.value)
        .filter((item) => url.searchParams.get("scopeId") === null || item.scopeId === url.searchParams.get("scopeId"))
        .filter((item) => url.searchParams.get("phase") === null || item.phase === url.searchParams.get("phase"));
      return this.#page(url, principal, "workspaces", values);
    }
    if (request.method === "GET" && url.pathname === "/v1/runtimes") {
      const values = [...this.#runtimes.values()].filter((item) => item.principal === principal).map((item) => item.value)
        .filter((item) => url.searchParams.get("scopeId") === null || item.scopeId === url.searchParams.get("scopeId"))
        .filter((item) => url.searchParams.get("workspaceId") === null || item.workspaceId === url.searchParams.get("workspaceId"))
        .filter((item) => url.searchParams.get("phase") === null || item.phase === url.searchParams.get("phase"))
        .filter((item) => url.searchParams.get("desiredState") === null || item.desiredState === url.searchParams.get("desiredState"));
      return this.#page(url, principal, "runtimes", values);
    }
    if (request.method === "GET" && url.pathname === "/v1/events") return this.#events(request, url, principal);

    const connectionMatch = /^\/v1\/runtimes\/([^/]+)\/connections$/u.exec(url.pathname);
    if (connectionMatch !== null && request.method === "GET") {
      const id = decodeURIComponent(connectionMatch[1]!);
      const runtime = visible(this.#runtimes.get(this.#resourceKey(principal, id)), principal);
      if (runtime === undefined) return this.#problem(404, "not_found", "Runtime not found", url.pathname);
      if (runtime.phase !== "Ready") return this.#problem(409, "runtime_not_ready", "Runtime has no active routes", url.pathname, { currentRevision: runtime.revision });
      const authority = new URL(this.origin);
      const descriptor = {
        runtimeId: id,
        generation: runtime.generation,
        expiresAt: "2026-07-28T12:05:00.000Z",
        routes: [
          ...(this.#features.sshProvider ? [{ kind: "machine-provider-ssh" as const, providerVersion: 1 as const, host: `runtime.${authority.hostname}`, port: 22, user: "agent" }] : []),
          { kind: "omp-app-websocket" as const, protocol: "omp-app/1" as const, url: `wss://${authority.host}/v1/ws` },
          ...(this.#features.directCmuxWebSocket ? [{ kind: "cmux-websocket" as const, protocol: 10 as const, url: `wss://${authority.host}/v1/cmux/${id}` }] : []),
        ],
      };
      return json(200, this.options.invalidPayload === "connections" ? { ...descriptor, routes: [{ kind: "secret", token: "bad" }] } : descriptor, { ETag: etag(runtime.revision), "Cache-Control": "no-store" });
    }

    const actionMatch = /^\/v1\/runtimes\/([^/]+):(wake|sleep)$/u.exec(url.pathname);
    if (actionMatch !== null && request.method === "POST") return this.#action(request, url.pathname, principal, decodeURIComponent(actionMatch[1]!), actionMatch[2] as "wake" | "sleep");

    const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/u.exec(url.pathname);
    if (workspaceMatch !== null) return this.#workspace(request, url.pathname, principal, decodeURIComponent(workspaceMatch[1]!));
    const runtimeMatch = /^\/v1\/runtimes\/([^/]+)$/u.exec(url.pathname);
    if (runtimeMatch !== null) return this.#runtime(request, url.pathname, principal, decodeURIComponent(runtimeMatch[1]!));
    return this.#problem(404, "not_found", "Route not found", url.pathname);
  }

  async #workspace(request: Request, path: string, principal: Principal, id: string): Promise<Response> {
    const stored = this.#workspaces.get(this.#resourceKey(principal, id));
    const current = visible(stored, principal);
    if (request.method === "GET") return current === undefined ? this.#problem(404, "not_found", "Workspace not found", path) : json(200, this.#payload("workspace", current), { ETag: etag(current.revision) });
    if (request.method === "PUT") {
      if (request.headers.get("If-None-Match") !== "*") return this.#problem(412, "precondition_failed", "If-None-Match: * is required", path, current === undefined ? {} : { currentRevision: current.revision });
      const body = await parseJson(request);
      if (!validWorkspaceCreate(body) || !this.#scopeVisible(principal, body.scopeId)) return this.#problem(422, "invalid_request", "WorkspaceCreate is invalid", path);
      const identity = canonical(body);
      if (stored !== undefined) {
        if (stored.principal === principal && stored.createIdentity === identity) return json(200, stored.value, { ETag: etag(stored.value.revision) });
        return this.#problem(409, "resource_conflict", "Workspace ID already has a different request identity", path);
      }
      const value: Workspace = {
        id, scopeId: body.scopeId, displayName: body.displayName, capacityBytes: body.capacityBytes, retention: body.retention,
        phase: "Ready", attachmentCount: 0, revision: this.#nextRevision(), conditions: [], createdAt: NOW, updatedAt: NOW,
      };
      this.#workspaces.set(this.#resourceKey(principal, id), { principal, value, createIdentity: identity });
      this.#append("workspace", value.id, value.scopeId, value.revision, value.phase);
      return json(201, this.#payload("workspace", value), { ETag: etag(value.revision), Location: path });
    }
    if (current === undefined) return this.#problem(404, "not_found", "Workspace not found", path);
    const precondition = this.#matchRevision(request, path, current.revision);
    if (precondition !== undefined) return precondition;
    if (request.method === "PATCH") {
      const body = await parseJson(request);
      if (body === undefined || Object.keys(body).length === 0 || Object.keys(body).some((key) => key !== "displayName" && key !== "retention") ||
        (body.displayName !== undefined && (typeof body.displayName !== "string" || body.displayName.length === 0)) ||
        (body.retention !== undefined && body.retention !== "Retain" && body.retention !== "Delete")) return this.#problem(422, "invalid_request", "WorkspacePatch is invalid", path);
      const updated: Workspace = { ...current, ...body, revision: this.#nextRevision(), updatedAt: NOW } as Workspace;
      stored!.value = updated;
      this.#append("workspace", id, updated.scopeId, updated.revision, updated.phase);
      return json(200, this.#payload("workspace", updated), { ETag: etag(updated.revision) });
    }
    if (request.method === "DELETE") {
      if ([...this.#runtimes.values()].some((item) => item.principal === principal && item.value.workspaceId === id)) return this.#problem(409, "resource_conflict", "Workspace still has runtimes", path, { currentRevision: current.revision });
      this.#workspaces.delete(this.#resourceKey(principal, id));
      this.#append("workspace", id, current.scopeId, this.#nextRevision(), "Deleting");
      return new Response(null, { status: 204 });
    }
    return this.#problem(404, "not_found", "Route not found", path);
  }

  async #runtime(request: Request, path: string, principal: Principal, id: string): Promise<Response> {
    const stored = this.#runtimes.get(this.#resourceKey(principal, id));
    const current = visible(stored, principal);
    if (request.method === "GET") return current === undefined ? this.#problem(404, "not_found", "Runtime not found", path) : json(200, this.#payload("runtime", current), { ETag: etag(current.revision) });
    if (request.method === "PUT") {
      if (request.headers.get("If-None-Match") !== "*") return this.#problem(412, "precondition_failed", "If-None-Match: * is required", path, current === undefined ? {} : { currentRevision: current.revision });
      const body = await parseJson(request);
      if (!validRuntimeCreate(body) || !this.#scopeVisible(principal, body.scopeId) || visible(this.#workspaces.get(this.#resourceKey(principal, body.workspaceId)), principal)?.scopeId !== body.scopeId) return this.#problem(422, "invalid_request", "RuntimeCreate is invalid", path);
      const identity = canonical(body);
      if (stored !== undefined) {
        if (stored.principal === principal && stored.createIdentity === identity) return json(200, stored.value, { ETag: etag(stored.value.revision) });
        return this.#problem(409, "resource_conflict", "Runtime ID already has a different request identity", path);
      }
      const phase = body.desiredState === "Sleeping" ? "Sleeping" : body.desiredState === "Stopped" ? "Stopped" : "Ready";
      const value: Runtime = {
        id, scopeId: body.scopeId, workspaceId: body.workspaceId, displayName: body.displayName, hostProfileId: body.hostProfileId,
        desiredState: body.desiredState, phase, generation: "gen-1", revision: this.#nextRevision(),
        capabilities: this.#features.browser ? ["terminal", "browser"] : ["terminal"],
        conditions: [], createdAt: NOW, updatedAt: NOW,
      };
      this.#runtimes.set(this.#resourceKey(principal, id), { principal, value, createIdentity: identity });
      this.#append("runtime", id, value.scopeId, value.revision, value.phase);
      return json(201, this.#payload("runtime", value), { ETag: etag(value.revision), Location: path });
    }
    if (current === undefined) return this.#problem(404, "not_found", "Runtime not found", path);
    const precondition = this.#matchRevision(request, path, current.revision);
    if (precondition !== undefined) return precondition;
    if (request.method === "PATCH") {
      const body = await parseJson(request);
      if (body === undefined || Object.keys(body).length === 0 || Object.keys(body).some((key) => !["displayName", "desiredState", "browserPolicy", "idlePolicy"].includes(key)) ||
        (body.displayName !== undefined && (typeof body.displayName !== "string" || body.displayName.length < 1 || body.displayName.length > 128)) ||
        (body.desiredState !== undefined && body.desiredState !== "Running" && body.desiredState !== "Sleeping" && body.desiredState !== "Stopped") ||
        (body.browserPolicy !== undefined && body.browserPolicy !== "Allowed" && body.browserPolicy !== "Disabled") ||
        (body.idlePolicy !== undefined && !validIdlePolicy(body.idlePolicy))) return this.#problem(422, "invalid_request", "RuntimePatch is invalid", path);
      const desiredState = (body.desiredState ?? current.desiredState) as Runtime["desiredState"];
      const updated: Runtime = { ...current, ...body, desiredState, phase: desiredState === "Running" ? "Ready" : desiredState === "Sleeping" ? "Sleeping" : "Stopped", revision: this.#nextRevision(), updatedAt: NOW } as Runtime;
      stored!.value = updated;
      this.#append("runtime", id, updated.scopeId, updated.revision, updated.phase);
      return json(200, this.#payload("runtime", updated), { ETag: etag(updated.revision) });
    }
    if (request.method === "DELETE") {
      this.#runtimes.delete(this.#resourceKey(principal, id));
      this.#append("runtime", id, current.scopeId, this.#nextRevision(), "Deleting");
      return new Response(null, { status: 204 });
    }
    return this.#problem(404, "not_found", "Route not found", path);
  }

  #action(request: Request, path: string, principal: Principal, id: string, action: "wake" | "sleep"): Response {
    const stored = this.#runtimes.get(this.#resourceKey(principal, id));
    const current = visible(stored, principal);
    if (current === undefined) return this.#problem(404, "not_found", "Runtime not found", path);
    const key = request.headers.get("Idempotency-Key");
    if (key === null || !/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/u.test(key)) return this.#problem(400, "idempotency_key_required", "A valid Idempotency-Key is required", path);
    const identity = canonical({ scopeId: current.scopeId, method: request.method, path, body: null });
    const ledgerKey = `${principal}:${key}`;
    const replay = this.#actions.get(ledgerKey);
    if (replay !== undefined) return replay.identity === identity ? json(200, replay.value, { ETag: replay.etag }) : this.#problem(409, "idempotency_conflict", "Idempotency key request identity changed", path);
    const precondition = this.#matchRevision(request, path, current.revision);
    if (precondition !== undefined) return precondition;
    const updated: Runtime = { ...current, desiredState: action === "wake" ? "Running" : "Sleeping", phase: action === "wake" ? "Ready" : "Sleeping", revision: this.#nextRevision(), generation: `gen-${this.#revisionSequence}`, updatedAt: NOW };
    stored!.value = updated;
    const responseEtag = etag(updated.revision);
    this.#actions.set(ledgerKey, { identity, value: updated, etag: responseEtag });
    this.#append("runtime", id, updated.scopeId, updated.revision, updated.phase);
    return json(200, this.#payload("runtime", updated), { ETag: responseEtag });
  }

  #events(request: Request, url: URL, principal: Principal): Response {
    const scopeId = url.searchParams.get("scopeId");
    if (scopeId !== null && !this.#scopeVisible(principal, scopeId)) return this.#problem(403, "forbidden", "Scope is not authorized", url.pathname);
    const lastEventId = request.headers.get("Last-Event-ID");
    this.watchCursors.push({ scopeId, lastEventId });
    let events = this.#journal.filter((event) => event.event === "reset" || this.#scopeVisible(principal, event.scopeId));
    if (scopeId !== null) events = events.filter((event) => event.event === "reset" || event.scopeId === scopeId);
    if (lastEventId !== null) {
      const index = events.findIndex((event) => event.eventId === lastEventId);
      events = index < 0 ? [{ event: "reset", eventId: this.#nextEventId(), reason: "cursor_expired", timestamp: NOW }] : events.slice(index + 1);
    }
    this.#streamSequence += 1;
    if (this.options.eventStream === "reconnect" && this.#streamSequence === 1) events = events.slice(0, 1);
    let payload = events.map((event) => `id: ${event.eventId}\r\nevent: ${event.event}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
    if (this.options.eventStream === "malformed") payload = `id: bad-1\nevent: heartbeat\ndata: {"event":"heartbeat","eventId":"bad-1"}\n\n`;
    if (this.options.eventStream === "oversized") payload = `: ${"x".repeat(1024 * 1024 + 8)}\n\n`;
    const bytes = encoder.encode(payload);
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.options.eventStream === "bytewise") for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        else {
          const split = Math.max(1, bytes.byteLength - 3);
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
        }
        controller.close();
        request.signal.addEventListener("abort", () => this.abortedWatches.push(lastEventId ?? "initial"), { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  }

  #page<T>(url: URL, principal: Principal, collection: string, items: readonly T[]): Response {
    const limit = Number(url.searchParams.get("limit") ?? "2");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return this.#problem(400, "invalid_request", "limit is outside capabilities", url.pathname);
    const cursor = url.searchParams.get("cursor");
    const match = cursor === null ? null : /^([A-Za-z0-9-]+)_([0-9]+)$/u.exec(cursor);
    if (cursor !== null && (match === null || match[1] !== `${principal}-${collection}`)) return this.#problem(400, "invalid_cursor", "cursor is not valid for this principal and collection", url.pathname);
    const start = match === null ? 0 : Number(match[2]);
    if (this.options.invalidPayload === "page") return json(200, { items: Array.from({ length: 201 }, () => items[0]) });
    const page = items.slice(start, start + limit);
    const next = start + page.length < items.length ? `${principal}-${collection}_${start + page.length}` : undefined;
    return json(200, { items: page, ...(next === undefined ? {} : { nextCursor: next }) });
  }

  #matchRevision(request: Request, path: string, revisionValue: string): Response | undefined {
    return request.headers.get("If-Match") === etag(revisionValue) ? undefined : this.#problem(412, "revision_mismatch", "If-Match does not match the current revision", path, { currentRevision: revisionValue });
  }

  #scopeVisible(principal: Principal, scopeId: string): boolean { return this.#scopes.get(principal)?.some((scope) => scope.id === scopeId) === true; }
  #nextRevision(): string { this.#revisionSequence += 1; return revision(this.#revisionSequence); }
  #nextEventId(): string { this.#eventSequence += 1; return `event-${this.#eventSequence}`; }

  #append(resourceKind: "workspace" | "runtime", resourceId: string, scopeId: string, revisionValue: string, phase: Workspace["phase"]): void {
    this.#journal.push({ event: "invalidation", eventId: this.#nextEventId(), resourceKind, resourceId, scopeId, revision: revisionValue, phase, timestamp: NOW });
    if (this.#journal.length > 64) this.#journal.shift();
  }

  #payload(kind: "workspace" | "runtime", value: Workspace | Runtime): Workspace | Runtime | Record<string, unknown> {
    if (this.options.invalidPayload === kind) return { ...value, revision: 1 };
    if (kind === "runtime" && this.options.invalidPayload === "runtime-bounds") {
      return { ...value, capabilities: Array.from({ length: 65 }, (_, index) => `capability-${index}`) };
    }
    return value;
  }
  #resourceKey(principal: Principal, id: string): string { return `${principal}:${id}`; }

  #problem(status: number, code: string, detail: string, instance: string, extra: Record<string, unknown> = {}): Response {
    if (this.options.invalidPayload === "problem") return new Response(JSON.stringify({ code, detail }), { status, headers: { "Content-Type": "application/problem+json" } });
    return problem(status, code, detail, instance, extra);
  }
}
