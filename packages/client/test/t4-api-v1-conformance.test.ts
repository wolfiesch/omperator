import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { T4ApiError, createT4ApiClient, type components } from "@t4-code/t4-api-client";
import { T4ApiV1ConformanceService } from "./t4-api-v1-conformance-service.ts";

type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type RuntimeCreate = components["schemas"]["RuntimeCreate"];

const WORKSPACE_CREATE = {
  scopeId: "scope-a",
  displayName: "Primary workspace",
  capacityBytes: 1_073_741_824,
  retention: "Retain",
} as const satisfies WorkspaceCreate;

const RUNTIME_CREATE = {
  scopeId: "scope-a",
  workspaceId: "workspace-1",
  displayName: "Primary runtime",
  hostProfileId: "host-default",
  desiredState: "Running",
  browserPolicy: "Allowed",
  idlePolicy: { enabled: true, idleSeconds: 300 },
} as const satisfies RuntimeCreate;

function clientFor(service: T4ApiV1ConformanceService, credential = "token-a") {
  return createT4ApiClient({ baseUrl: service.origin, credential, fetch: service.fetch });
}

function requireData<T>(result: { readonly data?: T; readonly error?: unknown }): T {
  expect(result.error).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data!;
}

async function putWorkspace(service: T4ApiV1ConformanceService, id = "workspace-1") {
  return await clientFor(service).http.PUT("/v1/workspaces/{workspaceId}", {
    params: { path: { workspaceId: id }, header: { "If-None-Match": "*" } },
    body: WORKSPACE_CREATE,
  });
}

async function putRuntime(service: T4ApiV1ConformanceService, id = "runtime-1") {
  return await clientFor(service).http.PUT("/v1/runtimes/{runtimeId}", {
    params: { path: { runtimeId: id }, header: { "If-None-Match": "*" } },
    body: RUNTIME_CREATE,
  });
}

describe("Portable Agent Platform v1 conformance", () => {
  it("publishes only the exact lifecycle and discovery OpenAPI surface", () => {
    const document = JSON.parse(readFileSync(new URL("../../t4-api-contract/openapi.json", import.meta.url), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    expect(Object.keys(document.paths).sort()).toEqual([
      "/.well-known/omperator",
      "/v1/capabilities",
      "/v1/events",
      "/v1/runtimes",
      "/v1/runtimes/{runtimeId}",
      "/v1/runtimes/{runtimeId}/connections",
      "/v1/runtimes/{runtimeId}:sleep",
      "/v1/runtimes/{runtimeId}:wake",
      "/v1/scopes",
      "/v1/version",
      "/v1/workspaces",
      "/v1/workspaces/{workspaceId}",
    ]);
    const operations = Object.fromEntries(Object.entries(document.paths).map(([path, item]) => [path, Object.keys(item).filter((key) => ["get", "put", "post", "patch", "delete"].includes(key)).sort()]));
    expect(operations).toEqual({
      "/.well-known/omperator": ["get"],
      "/v1/capabilities": ["get"],
      "/v1/events": ["get"],
      "/v1/runtimes": ["get"],
      "/v1/runtimes/{runtimeId}": ["delete", "get", "patch", "put"],
      "/v1/runtimes/{runtimeId}/connections": ["get"],
      "/v1/runtimes/{runtimeId}:sleep": ["post"],
      "/v1/runtimes/{runtimeId}:wake": ["post"],
      "/v1/scopes": ["get"],
      "/v1/version": ["get"],
      "/v1/workspaces": ["get"],
      "/v1/workspaces/{workspaceId}": ["delete", "get", "patch", "put"],
    });
  });

  it("keeps discovery unauthenticated and bounded while owning v1 authentication and transport", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = clientFor(service);
    const discovery = requireData(await client.http.GET("/.well-known/omperator"));
    expect(discovery).toMatchObject({
      service: "omperator",
      apiVersion: "v1",
      restBaseUrl: `${service.origin}/v1`,
      ompAppWebSocketUrl: "wss://t4-api.conformance.test/v1/ws",
      cmuxWebSocketTemplate: "wss://t4-api.conformance.test/v1/cmux/{runtimeId}",
    });
    expect(service.calls[0]).toMatchObject({ path: "/.well-known/omperator", authorization: null });

    requireData(await client.http.GET("/v1/version"));
    expect(service.calls[1]?.authorization).toBe("Bearer token-a");
    expect(() => client.http.GET("/v1/version", { headers: { Authorization: "Bearer stolen" } } as never)).toThrow(/SDK-owned/u);
    await expect(client.http.request("get", "/v1/not-declared" as never)).rejects.toThrow(/undeclared/u);

    const oversized = clientFor(new T4ApiV1ConformanceService({ responseOverride: (request, response) => request.url.endsWith("/.well-known/omperator")
      ? new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "16777217", "Cache-Control": "no-store" } })
      : response }));
    await expect(oversized.http.GET("/.well-known/omperator")).rejects.toThrow(/invalid or oversized/u);

    const credentialDiscovery = clientFor(new T4ApiV1ConformanceService({
      responseOverride: (request, response) => request.url.endsWith("/.well-known/omperator")
        ? new Response(JSON.stringify({
          service: "omperator",
          apiVersion: "v1",
          restBaseUrl: "https://user:token@t4-api.conformance.test/v1",
          protocols: { machineProvider: ["machine-provider-v1"], cmux: [10], application: ["omp-app/1"] },
        }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
        : response,
    }));
    await expect(credentialDiscovery.http.GET("/.well-known/omperator")).rejects.toThrow(/invalid or oversized JSON/u);
  });


  it("retains minimum capabilities and scopes pagination is principal-bound", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = clientFor(service);
    const capabilities = requireData(await client.http.GET("/v1/capabilities"));
    expect(capabilities.features).toEqual({ browser: true, directCmuxWebSocket: true, restLifecycle: true, scaleToZero: true, sshProvider: true });
    expect(capabilities.limits.eventRetentionSeconds).toBeGreaterThanOrEqual(60);
    expect(capabilities.limits.idempotencyRetentionSeconds).toBeGreaterThanOrEqual(86_400);
    expect(capabilities.protocols.machineProvider).toEqual({ versions: [1], capabilities: ["machine-lifecycle-v1"] });

    const first = requireData(await client.http.GET("/v1/scopes", { params: { query: { limit: 1 } } }));
    expect(first.items.map((scope) => scope.id)).toEqual(["scope-a"]);
    expect(first.nextCursor).toBeDefined();
    const cursor = first.nextCursor!;
    const second = requireData(await client.http.GET("/v1/scopes", { params: { query: { limit: 1, cursor } } }));
    expect(second.items.map((scope) => scope.id)).toEqual(["scope-team"]);
    const foreign = await clientFor(service, "token-b").http.GET("/v1/scopes", { params: { query: { cursor } } });
    expect(foreign.error).toMatchObject({ status: 400, code: "invalid_cursor", retryable: false });
  });

  it("supports workspace explicit-ID retry, body conflict, filtering, opaque CAS, and delete", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = clientFor(service);
    const createdResult = await putWorkspace(service);
    const created = requireData(createdResult);
    expect(createdResult.response.status).toBe(201);
    expect(createdResult.response.headers.get("Location")).toBe("/v1/workspaces/workspace-1");
    const firstEtag = createdResult.response.headers.get("ETag")!;
    expect(firstEtag).toMatch(/^"rev:[a-z0-9]+"$/u);
    expect(typeof created.revision).toBe("string");

    const retry = await putWorkspace(service);
    expect(retry.response.status).toBe(200);
    expect(requireData(retry)).toEqual(created);
    const conflict = await client.http.PUT("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "workspace-1" }, header: { "If-None-Match": "*" } },
      body: { ...WORKSPACE_CREATE, displayName: "Different" },
    });
    expect(conflict.error).toMatchObject({ status: 409, code: "resource_conflict" });

    const stale = await client.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "workspace-1" }, header: { "If-Match": '"rev:stale"' } },
      body: { displayName: "Renamed" },
    });
    expect(stale.error).toMatchObject({ status: 412, code: "revision_mismatch", currentRevision: created.revision });
    const patchedResult = await client.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "workspace-1" }, header: { "If-Match": firstEtag } },
      body: { displayName: "Renamed" },
    });
    const patched = requireData(patchedResult);
    expect(patched.displayName).toBe("Renamed");
    expect(patched.revision).not.toBe(created.revision);

    const page = requireData(await client.http.GET("/v1/workspaces", { params: { query: { scopeId: "scope-a", phase: "Ready", limit: 10 } } }));
    expect(page.items.map((workspace) => workspace.id)).toEqual(["workspace-1"]);
    const fetched = requireData(await client.http.GET("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: "workspace-1" } } }));
    expect(fetched).toEqual(patched);
    const deleted = await client.http.DELETE("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: "workspace-1" }, header: { "If-Match": patchedResult.response.headers.get("ETag")! } } });
    expect(deleted.response.status).toBe(204);
  });

  it("supports runtime create/filter/CAS plus wake and sleep idempotency", async () => {
    const service = new T4ApiV1ConformanceService();
    await putWorkspace(service);
    const client = clientFor(service);
    const createdResult = await putRuntime(service);
    const created = requireData(createdResult);
    const createdEtag = createdResult.response.headers.get("ETag")!;
    expect(created).toMatchObject({ id: "runtime-1", phase: "Ready", desiredState: "Running", generation: "gen-1" });
    expect((await putRuntime(service)).response.status).toBe(200);

    const incompatible = await client.http.PUT("/v1/runtimes/{runtimeId}", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-None-Match": "*" } }, body: { ...RUNTIME_CREATE, displayName: "Different" },
    });
    expect(incompatible.error).toMatchObject({ status: 409, code: "resource_conflict" });

    const unknownField = await client.http.PUT("/v1/runtimes/{runtimeId}", {
      params: { path: { runtimeId: "runtime-unknown-field" }, header: { "If-None-Match": "*" } },
      body: { ...RUNTIME_CREATE, command: "omp --resume" } as never,
    });
    expect(unknownField.error).toMatchObject({ status: 422, code: "invalid_request" });
    const ambiguousIdle = await client.http.PUT("/v1/runtimes/{runtimeId}", {
      params: { path: { runtimeId: "runtime-ambiguous-idle" }, header: { "If-None-Match": "*" } },
      body: { ...RUNTIME_CREATE, idlePolicy: { enabled: true } } as never,
    });
    expect(ambiguousIdle.error).toMatchObject({ status: 422, code: "invalid_request" });
    const stale = await client.http.PATCH("/v1/runtimes/{runtimeId}", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": '"stale"' } }, body: { displayName: "Renamed runtime" },
    });
    expect(stale.error).toMatchObject({ status: 412, code: "revision_mismatch", currentRevision: created.revision });

    const sleep = await client.http.POST("/v1/runtimes/{runtimeId}:sleep", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": createdEtag, "Idempotency-Key": "sleep-runtime-0001" } },
    });
    const sleeping = requireData(sleep);
    expect(sleeping).toMatchObject({ desiredState: "Sleeping", phase: "Sleeping" });
    const sleepRetry = await client.http.POST("/v1/runtimes/{runtimeId}:sleep", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": createdEtag, "Idempotency-Key": "sleep-runtime-0001" } },
    });
    expect(requireData(sleepRetry)).toEqual(sleeping);
    const changedIdentity = await client.http.POST("/v1/runtimes/{runtimeId}:wake", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": sleep.response.headers.get("ETag")!, "Idempotency-Key": "sleep-runtime-0001" } },
    });
    expect(changedIdentity.error).toMatchObject({ status: 409, code: "idempotency_conflict" });
    const wake = await client.http.POST("/v1/runtimes/{runtimeId}:wake", {
      params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": sleep.response.headers.get("ETag")!, "Idempotency-Key": "wake-runtime-00001" } },
    });
    expect(requireData(wake).phase).toBe("Ready");

    const runtimePage = requireData(await client.http.GET("/v1/runtimes", { params: { query: { scopeId: "scope-a", workspaceId: "workspace-1", desiredState: "Running", limit: 10 } } }));
    expect(runtimePage.items.map((runtime) => runtime.id)).toEqual(["runtime-1"]);
    requireData(await client.http.GET("/v1/runtimes/{runtimeId}", { params: { path: { runtimeId: "runtime-1" } } }));
    const currentEtag = (await client.http.GET("/v1/runtimes/{runtimeId}", { params: { path: { runtimeId: "runtime-1" } } })).response.headers.get("ETag")!;
    const deleted = await client.http.DELETE("/v1/runtimes/{runtimeId}", { params: { path: { runtimeId: "runtime-1" }, header: { "If-Match": currentEtag } } });
    expect(deleted.response.status).toBe(204);
  });

  it("returns current authorized connection routes without credential material", async () => {
    const service = new T4ApiV1ConformanceService();
    await putWorkspace(service);
    await putRuntime(service);
    const result = await clientFor(service).http.GET("/v1/runtimes/{runtimeId}/connections", { params: { path: { runtimeId: "runtime-1" } } });
    const descriptor = requireData(result);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.response.headers.get("ETag")).toMatch(/^"rev:/u);
    expect(descriptor.generation).toBe("gen-1");
    expect(descriptor.routes).toEqual([
      { kind: "machine-provider-ssh", providerVersion: 1, host: "runtime.t4-api.conformance.test", port: 22, user: "agent" },
      { kind: "omp-app-websocket", protocol: "omp-app/1", url: "wss://t4-api.conformance.test/v1/ws" },
      { kind: "cmux-websocket", protocol: 10, url: "wss://t4-api.conformance.test/v1/cmux/runtime-1" },
    ]);
    expect(JSON.stringify(descriptor)).not.toMatch(/token|credential|password|secret|authorization/iu);

    for (const unsafeRoute of [
      { kind: "omp-app-websocket", protocol: "omp-app/1", url: "wss://user:token@t4-api.conformance.test/v1/ws" },
      { kind: "cmux-websocket", protocol: 10, url: "wss://t4-api.conformance.test/v1/cmux/runtime-1", token: "leaked" },
      { kind: "machine-provider-ssh", providerVersion: 1, host: "runtime.t4-api.conformance.test\nAuthorization: leaked", port: 22, user: "agent" },
      { kind: "machine-provider-ssh", providerVersion: 1, host: "runtime.t4-api.conformance.test", port: 22, user: "agent\nleaked" },
    ]) {
      const unsafeService = new T4ApiV1ConformanceService({
        responseOverride: (request, response) => request.url.endsWith("/connections")
          ? new Response(JSON.stringify({
            runtimeId: "runtime-1",
            generation: "gen-1",
            expiresAt: "2026-07-28T12:05:00.000Z",
            routes: [unsafeRoute],
          }), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ETag: '"rev:1"' } })
          : response,
      });
      await putWorkspace(unsafeService);
      await putRuntime(unsafeService);
      await expect(clientFor(unsafeService).http.GET("/v1/runtimes/{runtimeId}/connections", {
        params: { path: { runtimeId: "runtime-1" } },
      })).rejects.toThrow(/invalid or oversized JSON/u);
    }
  });


  it("decodes RFC 9457 Problem Details and rejects old or malformed envelopes", async () => {
    const service = new T4ApiV1ConformanceService();
    const result = await clientFor(service).http.GET("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: "missing" } } });
    expect(result.response.headers.get("Content-Type")).toBe("application/problem+json");
    expect(result.error).toEqual(expect.objectContaining({
      type: "https://omperator.dev/problems/not_found",
      title: "Not Found",
      status: 404,
      detail: "Workspace not found",
      instance: "/v1/workspaces/missing",
      code: "not_found",
      retryable: false,
    }));

    const malformed = clientFor(new T4ApiV1ConformanceService({ invalidPayload: "problem" }));
    await expect(malformed.http.GET("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: "missing" } } })).rejects.toThrow(/Problem Details/u);
  });

  it("streams only correlated invalidation/reset events across UTF-8 framing and reconnect", async () => {
    const service = new T4ApiV1ConformanceService({ eventStream: "bytewise" });
    await putWorkspace(service);
    await putRuntime(service);
    const events: components["schemas"]["InvalidationEvent"][] = [];
    for await (const event of clientFor(service).watchEvents({ scopeId: "scope-a", maxEvents: 2, retryBackoffMs: 0 })) {
      expect(event.event).toBe("invalidation");
      events.push(event as components["schemas"]["InvalidationEvent"]);
    }
    expect(events.map((event) => event.resourceKind)).toEqual(["workspace", "runtime"]);
    expect(service.watchCursors[0]).toEqual({ scopeId: "scope-a", lastEventId: null });

    const resetService = new T4ApiV1ConformanceService();
    const reset = [];
    for await (const event of clientFor(resetService).watchEvents({ lastEventId: "expired-event", maxEvents: 1, retryBackoffMs: 0 })) reset.push(event);
    expect(reset).toEqual([expect.objectContaining({ event: "reset", reason: "cursor_expired" })]);

    const freshService = new T4ApiV1ConformanceService();
    const freshResponse = await freshService.fetch(`${freshService.origin}/v1/events`, { headers: { Authorization: "Bearer token-a" } });
    expect(freshResponse.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await freshResponse.text()).toBe("");
    expect(freshService.watchCursors).toEqual([{ scopeId: null, lastEventId: null }]);

    const reconnectService = new T4ApiV1ConformanceService({ eventStream: "reconnect" });
    await putWorkspace(reconnectService);
    await putRuntime(reconnectService);
    const reconnected = [];
    for await (const event of clientFor(reconnectService).watchEvents({ maxEvents: 2, retryBackoffMs: 0 })) reconnected.push(event.eventId);
    expect(new Set(reconnected).size).toBe(2);
    expect(reconnectService.watchCursors).toEqual([
      { scopeId: null, lastEventId: null },

      { scopeId: null, lastEventId: reconnected[0] },
    ]);
  });

  it("fails closed on malformed payloads, event kinds, oversized frames, statuses, media, and redirects", async () => {
    await expect(clientFor(new T4ApiV1ConformanceService({ invalidPayload: "workspace" })).http.PUT("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "workspace-1" }, header: { "If-None-Match": "*" } }, body: WORKSPACE_CREATE,
    })).rejects.toThrow(/invalid or oversized JSON/u);

    await expect(clientFor(new T4ApiV1ConformanceService({ invalidPayload: "capabilities" })).http.GET("/v1/capabilities"))
      .rejects.toThrow(/invalid or oversized JSON/u);
    await expect(clientFor(new T4ApiV1ConformanceService({ invalidPayload: "page" })).http.GET("/v1/scopes"))
      .rejects.toThrow(/invalid or oversized JSON/u);
    const boundedRuntimeService = new T4ApiV1ConformanceService({ invalidPayload: "runtime-bounds" });
    await putWorkspace(boundedRuntimeService);
    await expect(putRuntime(boundedRuntimeService)).rejects.toThrow(/invalid or oversized JSON/u);

    const mismatchedEtagService = new T4ApiV1ConformanceService({
      responseOverride: (request, response) => {
        if (request.method !== "GET" || !request.url.endsWith("/v1/workspaces/workspace-1")) return response;
        const headers = new Headers(response.headers);
        headers.set("ETag", "\"rev:other\"");
        return new Response(response.body, { status: response.status, headers });
      },
    });
    await putWorkspace(mismatchedEtagService);
    await expect(clientFor(mismatchedEtagService).http.GET("/v1/workspaces/{workspaceId}", {
      params: { path: { workspaceId: "workspace-1" } },
    })).rejects.toThrow(/does not match its revision/u);

    for (const eventStream of ["malformed", "oversized"] as const) {
      const iterator = clientFor(new T4ApiV1ConformanceService({ eventStream })).watchEvents({ maxEvents: 1, maxReconnectAttempts: 0 })[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toThrow(eventStream === "malformed" ? /malformed/u : /exceeds the client bound/u);
    }

    const undeclaredStatus = clientFor(new T4ApiV1ConformanceService({ responseOverride: (_request, response) => response.ok ? new Response(null, { status: 206 }) : response }));
    await expect(undeclaredStatus.http.GET("/v1/version")).rejects.toThrow(/undeclared success status/u);
    const wrongMedia = clientFor(new T4ApiV1ConformanceService({ responseOverride: (_request, response) => new Response(response.body, { status: response.status, headers: { ...Object.fromEntries(response.headers), "Content-Type": "text/plain" } }) }));
    await expect(wrongMedia.http.GET("/v1/version")).rejects.toThrow(/media type/u);
    const redirect = clientFor(new T4ApiV1ConformanceService({ responseOverride: () => new Response(null, { status: 302, headers: { Location: "https://other.test/v1/version" } }) }));
    await expect(redirect.http.GET("/v1/version")).rejects.toThrow(/undeclared error status|redirect/u);
  });

  it("exposes typed T4ApiError Problem fields for watch failures", async () => {
    const iterator = clientFor(new T4ApiV1ConformanceService(), "invalid-token").watchEvents({ maxEvents: 1 })[Symbol.asyncIterator]();
    const error = await iterator.next().then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(T4ApiError);
    expect(error).toMatchObject({ status: 401, code: "unauthenticated", retryable: false, title: "Unauthenticated" });
    expect((error as T4ApiError).message).toBe("A bearer credential is required");
  });
});
