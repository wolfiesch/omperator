import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  T4ApiError,
  createT4ApiClient,
  type components,
} from "@t4-code/t4-api-client";
import { T4ApiV1ConformanceService, canonicalJson } from "./t4-api-v1-conformance-service.ts";

type WorkspaceCreate = components["schemas"]["WorkspaceCreate"];
type SessionCreate = components["schemas"]["SessionCreate"];
type CommandCreate = components["schemas"]["CommandCreate"];

type WatchEvent = components["schemas"]["WatchEvent"];

function exhaustWatchEvent(event: WatchEvent): string {
  switch (event.type) {
    case "heartbeat": return event.observedAt;
    case "session": return `${event.state}:${event.revision}`;
    case "command": return `${event.commandId}:${event.state}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

const VERSION_HEADERS = {} as const;

const COMMAND_STATES = [
  "accepted", "projected", "dispatching", "running", "succeeded", "failed",
  "cancelling", "cancelled", "rejected", "unavailable", "indeterminate",
] as const satisfies readonly components["schemas"]["CommandState"][];
const DISCOVERY = {
  apiVersion: "1.0",
  serverBuild: { version: "0.1.30", revision: "fixture-revision-1" },
  supportedMajors: [1],
  capabilities: {
    "workspace.lifecycle": { supported: true, enabled: true, authorized: true, available: true },
    "optional.preview": {
      supported: true, enabled: false, authorized: false, available: false,
      deprecation: { message: "Use workspace.lifecycle", sinceVersion: "1.0", sunsetAt: "2027-01-01T00:00:00Z", replacement: "workspace.lifecycle" },
    },
  },
  limits: { pageSizeDefault: 1, pageSizeMax: 1, commandBytesMax: 1, commandRequestBytesMax: 1, commandMetadataValueBytesMax: 1, watchEventsDefault: 1, watchEventsMax: 1, heartbeatSeconds: 5 },
} as const;

function withSelectedVersion(init: ResponseInit = {}): ResponseInit {
  const headers = new Headers(init.headers);
  if (init.status !== 401 && !headers.has("T4-API-Version")) headers.set("T4-API-Version", "1.0");
  if (headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream" && !headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  return { ...init, headers };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, withSelectedVersion(init));
}

function apiResponse(body?: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, withSelectedVersion(init));
}

function idempotencyHeaders(key: string): Readonly<{ "Idempotency-Key": string }> {
  return { "Idempotency-Key": key };
}

function mutationHeaders(revision: number, key: string): Readonly<{ "T4-If-Revision": string; "Idempotency-Key": string }> {
  return { "T4-If-Revision": String(revision), "Idempotency-Key": key };
}

function requireEventCursor(response: Response): string {
  const cursor = response.headers.get("T4-Event-Cursor");
  expect(cursor).toMatch(/^[A-Za-z0-9._~-]+$/u);
  return cursor ?? "";
}

function requireData<T>(result: { data?: T; error?: unknown }): T {
  expect(result.error).toBeUndefined();
  expect(result.data).toBeDefined();
  return result.data!;
}

async function seededClient(service: T4ApiV1ConformanceService, key: string) {
  const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
  requireData(await client.http.POST("/v1/workspaces", {
    body: { name: "workspace" }, params: { header: idempotencyHeaders(`workspace-${key}-0001`) },
  }));
  requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
    body: { title: "agent" }, params: { header: idempotencyHeaders(`session-${key}-00001`), path: { workspaceId: "ws-1" } },
  }));
  return client;
}

describe("generated T4 API v1 client conformance", () => {
  it("negotiates truthful discovery metadata and rejects an incompatible major", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const discovery = requireData(await client.http.GET("/v1", { params: { header: VERSION_HEADERS } }));
    expect(discovery).toMatchObject({
      apiVersion: "1.0",
      serverBuild: { version: "0.1.30", revision: "fixture-revision-1" },
      supportedMajors: [1],
      capabilities: {
        "workspace.lifecycle": { supported: true, enabled: true, authorized: true, available: true },
        "optional.preview": { supported: true, enabled: false, authorized: false, available: false },
      },
      limits: { pageSizeMax: 3, commandBytesMax: 32, watchEventsMax: 4, heartbeatSeconds: 15 },
    });

    const incompatible = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 2, fetch: service.fetch });
    const rejected = await incompatible.http.GET("/v1", { params: { header: VERSION_HEADERS } });
    expect(rejected.response.status).toBe(406);
    expect(rejected.error).toMatchObject({ error: { code: "incompatible_version", retryable: false, supportedMajors: [1] } });

    const silentDowngrade = createT4ApiClient({
      baseUrl: "https://silent-downgrade.test", credential: "token-a", majorVersion: 2,
      fetch: async () => jsonResponse(DISCOVERY),
    });
    await expect(silentDowngrade.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({
      code: "indeterminate", status: 502, retryable: false,
    });

    const unauthenticated = await service.fetch(`${service.origin}/v1`, { headers: { "T4-API-Version": "1" } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.has("T4-API-Version")).toBe(false);
    expect(await unauthenticated.json()).toMatchObject({ error: { code: "unauthenticated", retryable: false } });

    const denied = createT4ApiClient({ baseUrl: service.origin, credential: "token-denied", majorVersion: 1, fetch: service.fetch });
    const forbidden = await denied.http.GET("/v1", { params: { header: VERSION_HEADERS } });
    expect(forbidden.response.status).toBe(403);
    expect(forbidden.error).toMatchObject({ error: { code: "forbidden" } });
    expect(discovery.limits).toMatchObject({ commandBytesMax: 32, commandRequestBytesMax: 256, commandMetadataValueBytesMax: 32 });
  });

  it("keeps transport, routing, serializers, and middleware under SDK ownership", async () => {
    let transportCalls = 0;
    const client = createT4ApiClient({
      baseUrl: "https://sdk-owned.test",
      credential: "token-a",
      majorVersion: 1,
      fetch: async () => {
        transportCalls += 1;
        return jsonResponse(DISCOVERY);
      },
    });
    const get = client.http.GET as unknown as (
      path: string,
      init: Record<string, unknown>,
    ) => Promise<unknown>;
    for (const [key, value] of [
      ["baseUrl", "https://exfiltration.test"],
      ["fetch", async () => jsonResponse(DISCOVERY)],
      ["headers", { Authorization: "Bearer attacker" }],
      ["middleware", [{ onRequest: () => jsonResponse(DISCOVERY) }]],
      ["querySerializer", () => ""],
      ["bodySerializer", () => "{}"],
      ["pathSerializer", () => "/v1"],
      ["Request", Request],
      ["method", "POST"],
    ] as const) {
      expect(() => get("/v1", { [key]: value, params: { header: VERSION_HEADERS } })).toThrow(
        `T4 API request option ${key} is SDK-owned`,
      );
    }
    expect(transportCalls).toBe(0);
    expect("use" in client.http).toBe(false);
    expect("eject" in client.http).toBe(false);
  });

  it("uses a watch default that fits every advertised positive service bound", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({
      baseUrl: service.origin,
      credential: "token-a",
      majorVersion: 1,
      fetch: service.fetch,
    });
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" },
      params: { header: idempotencyHeaders("workspace-watch-default") },
    }));
    requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "agent" },
      params: {
        header: idempotencyHeaders("session-watch-default"),
        path: { workspaceId: "ws-1" },
      },
    }));
    const stream = client.watchSession("ses-1", { maxReconnectAttempts: 0 });
    await expect(stream.next()).resolves.toMatchObject({ done: false });
    await stream.return(undefined);
    expect(service.watchQueries.at(-1)).toEqual({ maxEvents: "1", heartbeatSeconds: "15" });
  });

  it("binds successful resource identities to the requested route", async () => {
    const workspace = { id: "ws-other", name: "workspace", state: "ready", revision: 1 };
    const session = { id: "ses-other", workspaceId: "ws-other", title: "agent", state: "ready", revision: 1 };
    const cases = [
      ["/v1/workspaces/{workspaceId}", { params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } } }, workspace],
      ["/v1/workspaces/{workspaceId}/sessions", { params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } } }, { items: [session] }],
      ["/v1/sessions/{sessionId}", { params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } } }, session],
      ["/v1/sessions/{sessionId}/snapshot", { params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } } }, { sessionId: "ses-other", cursor: "cursor-1", state: "ready", entries: [] }],
    ] as const;
    for (const [path, init, body] of cases) {
      const client = createT4ApiClient({
        baseUrl: "https://identity-binding.test",
        credential: "token-a",
        majorVersion: 1,
        fetch: async () => jsonResponse(body),
      });
      const get = client.http.GET as unknown as (route: string, options: unknown) => Promise<unknown>;
      await expect(get(path, init)).rejects.toMatchObject({ status: 502, code: "indeterminate" });
    }
    const sessionClient = createT4ApiClient({
      baseUrl: "https://identity-binding.test",
      credential: "token-a",
      majorVersion: 1,
      fetch: async () => jsonResponse(session, {
        status: 202,
        headers: { "Idempotency-Replayed": "false", "T4-Event-Cursor": "event-1" },
      }),
    });
    await expect(sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "agent" },
      params: {
        header: idempotencyHeaders("identity-session-create"),
        path: { workspaceId: "ws-1" },
      },
    })).rejects.toMatchObject({ status: 502, code: "indeterminate" });
    await expect(sessionClient.http.POST("/v1/sessions/{sessionId}/cancel", {
      params: {
        header: idempotencyHeaders("identity-session-cancel"),
        path: { sessionId: "ses-1" },
      },
    })).rejects.toMatchObject({ status: 502, code: "indeterminate" });
  });

  it("creates, canonically replays, conflicts, mutates, paginates, isolates, and deletes workspaces", async () => {
    const service = new T4ApiV1ConformanceService();
    const owner = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const other = createT4ApiClient({ baseUrl: service.origin, credential: "token-b", majorVersion: 1, fetch: service.fetch });
    const body = { name: "primary", labels: { beta: "2", alpha: "1" } } satisfies WorkspaceCreate;
    const first = await owner.http.POST("/v1/workspaces", {
      body,
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(first.response.status).toBe(202);
    const workspace = requireData(first);
    expect(workspace).toMatchObject({ id: "ws-1", state: "accepted", revision: 1 });
    expect(workspace).not.toHaveProperty("tenant");

    const replay = await owner.http.POST("/v1/workspaces", {
      body: { labels: { alpha: "1", beta: "2" }, name: "primary" },
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(replay.response.status).toBe(200);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(replay.data).toEqual(workspace);
    const conflict = await owner.http.POST("/v1/workspaces", {
      body: { name: "different" },
      params: { header: idempotencyHeaders("workspace-create-0001") },
    });
    expect(conflict.response.status).toBe(409);
    expect(conflict.error).toMatchObject({ error: { code: "idempotency_conflict", retryable: false } });

    const omitted = await owner.http.POST("/v1/workspaces", {
      body: { name: "primary" }, params: { header: idempotencyHeaders("workspace-omitted-0001") },
    });
    expect(omitted.response.status).toBe(202);
    const explicitEmpty = await owner.http.POST("/v1/workspaces", {
      body: { name: "primary", labels: {} }, params: { header: idempotencyHeaders("workspace-omitted-0001") },
    });
    expect(explicitEmpty.response.status).toBe(409);
    expect(canonicalJson({ z: [1, 2], a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":[1,2]}');
    expect(canonicalJson({ z: [1, 2] })).not.toBe(canonicalJson({ z: [2, 1] }));
    for (const loneSurrogate of [String.fromCharCode(0xd800), String.fromCharCode(0xdc00)]) {
      expect(() => canonicalJson(loneSurrogate)).toThrow(TypeError);
      expect(() => canonicalJson({ [loneSurrogate]: "value" })).toThrow(TypeError);
    }

    for (const name of ["second", "third", "fourth"]) {
      requireData(await owner.http.POST("/v1/workspaces", {
        body: { name },
        params: { header: idempotencyHeaders(`workspace-${name}-0001`) },
      }));
    }
    const pageOne = requireData(await owner.http.GET("/v1/workspaces", {
      params: { header: VERSION_HEADERS, query: { pageSize: 3 } },
    }));
    expect(pageOne.items).toHaveLength(3);
    expect(pageOne.nextCursor).toMatch(/^[A-Za-z0-9._~-]+$/u);
    const pageTwo = requireData(await owner.http.GET("/v1/workspaces", {
      params: { header: VERSION_HEADERS, query: { pageSize: 3, cursor: pageOne.nextCursor! } },
    }));
    expect(pageTwo.items).toHaveLength(2);
    expect(pageTwo.nextCursor).toBeUndefined();

    const isolated = await other.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } },
    });
    expect(isolated.response.status).toBe(404);
    expect(isolated.error).toMatchObject({ error: { code: "not_found" } });
    const invalid = await owner.http.POST("/v1/workspaces", {
      body: { name: "x".repeat(129) },
      params: { header: idempotencyHeaders("workspace-invalid-0001") },
    });
    expect(invalid.response.status).toBe(422);
    expect(invalid.error).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "name", rule: "length" }] } });

    const updated = requireData(await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-patch-0001"), path: { workspaceId: "ws-1" } },
      body: { name: "renamed" },
    }));
    expect(updated).toMatchObject({ name: "renamed", revision: 2 });
    const updatedReplay = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-patch-0001"), path: { workspaceId: "ws-1" } }, body: { name: "renamed" },
    });
    expect(updatedReplay.response.status).toBe(200);
    expect(updatedReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(updatedReplay.data).toEqual(updated);
    const stale = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-patch-0002"), path: { workspaceId: "ws-1" } },
      body: { name: "stale" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });
    const targetOne = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(2, "workspace-shared-0001"), path: { workspaceId: "ws-1" } }, body: { name: "target" },
    });
    const targetTwo = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "workspace-shared-0001"), path: { workspaceId: "ws-2" } }, body: { name: "target" },
    });
    expect(targetOne.response.status).toBe(200);
    expect(targetTwo.response.status).toBe(200);
    const changedPrecondition = await owner.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(3, "workspace-shared-0001"), path: { workspaceId: "ws-1" } }, body: { name: "target" },
    });
    expect(changedPrecondition.response.status).toBe(409);
    expect(changedPrecondition.error).toMatchObject({ error: { code: "idempotency_conflict" } });
    expect((await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-0001"), path: { workspaceId: "ws-1" } },
    })).response.status).toBe(204);
    service.expectNoCredentialLeak();
  });

  it("replays successful workspace deletion only within the original principal and request scope", async () => {
    const service = new T4ApiV1ConformanceService();
    const owner = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const other = createT4ApiClient({ baseUrl: service.origin, credential: "token-b", majorVersion: 1, fetch: service.fetch });
    requireData(await owner.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("workspace-delete-setup") },
    }));
    const first = await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-replay"), path: { workspaceId: "ws-1" } },
    });
    const replay = await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-replay"), path: { workspaceId: "ws-1" } },
    });
    expect(first.response.status).toBe(204);
    expect(first.response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(replay.response.status).toBe(204);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await owner.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-fresh"), path: { workspaceId: "ws-1" } },
    })).response.status).toBe(404);
    expect((await other.http.DELETE("/v1/workspaces/{workspaceId}", {
      params: { header: idempotencyHeaders("workspace-delete-replay"), path: { workspaceId: "ws-1" } },
    })).response.status).toBe(404);
  });

  it("spawns, paginates, and mutates sessions, then submits idempotent stable command states", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("workspace-setup-0001") },
    }));
    const body = { title: "agent" } satisfies SessionCreate;
    const first = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-spawn-0001"), path: { workspaceId: "ws-1" } },
      body,
    });
    expect(first.response.status).toBe(202);
    const session = requireData(first);
    const replay = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-spawn-0001"), path: { workspaceId: "ws-1" } },
      body,
    });
    expect(replay.data).toEqual(session);
    for (const [key, title] of [["session-spawn-0002", "agent-two"], ["session-spawn-0003", "agent-three"]] as const) {
      requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        params: { header: idempotencyHeaders(key), path: { workspaceId: "ws-1" } }, body: { title },
      }));
    }
    const sessionPageOne = requireData(await client.http.GET("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" }, query: { pageSize: 2 } },
    }));
    expect(sessionPageOne.items).toHaveLength(2);
    expect(sessionPageOne.nextCursor).toMatch(/^[A-Za-z0-9._~-]+$/u);
    const sessionPageTwo = requireData(await client.http.GET("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" }, query: { pageSize: 2, cursor: sessionPageOne.nextCursor! } },
    }));
    expect(sessionPageTwo.items).toHaveLength(1);

    const mutated = requireData(await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "session-patch-0001"), path: { sessionId: "ses-1" } }, body: { title: "renamed-agent" },
    }));
    expect(mutated).toMatchObject({ title: "renamed-agent", revision: 2 });
    const mutatedReplay = await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "session-patch-0001"), path: { sessionId: "ses-1" } }, body: { title: "renamed-agent" },
    });
    expect(mutatedReplay.response.status).toBe(200);
    expect(mutatedReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mutatedReplay.data).toEqual(mutated);
    const stale = await client.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "session-patch-0002"), path: { sessionId: "ses-1" } }, body: { title: "stale-agent" },
    });
    expect(stale.response.status).toBe(409);
    expect(stale.error).toMatchObject({ error: { code: "revision_conflict" } });

    for (const state of COMMAND_STATES) {
      const command = { command: state, metadata: {} } satisfies CommandCreate;
      const result = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { header: idempotencyHeaders(`command-${state}-0001`), path: { sessionId: "ses-1" } }, body: command,
      });
      expect(requireData(result).state).toBe(state);
      const commandReplay = await client.http.POST("/v1/sessions/{sessionId}/commands", {
        params: { header: idempotencyHeaders(`command-${state}-0001`), path: { sessionId: "ses-1" } }, body: command,
      });
      expect(commandReplay.data).toEqual(result.data);
      expect(commandReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    }
    const oversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-oversized-0001"), path: { sessionId: "ses-1" } },
      body: { command: "a".repeat(33), metadata: {} },
    });
    expect(oversized.response.status).toBe(422);
    expect(oversized.error).toMatchObject({ error: { violations: [{ field: "command", rule: "maxBytes" }] } });
    const multibyteOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-multibyte-0001"), path: { sessionId: "ses-1" } },
      body: { command: "é".repeat(17), metadata: {} },
    });
    expect(multibyteOversized.response.status).toBe(422);
    const metadataOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-metadata-0001"), path: { sessionId: "ses-1" } },
      body: { command: "ok", metadata: { source: "é".repeat(17) } },
    });
    expect(metadataOversized.response.status).toBe(422);
    const requestOversized = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-request-0001"), path: { sessionId: "ses-1" } },
      body: { command: "ok", metadata: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`field-${index}`, "x".repeat(32)])) },
    });
    expect(requestOversized.response.status).toBe(422);
    const defaultedMetadata = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-default-0001"), path: { sessionId: "ses-1" } }, body: { command: "ok" },
    });
    const explicitMetadata = await client.http.POST("/v1/sessions/{sessionId}/commands", {
      params: { header: idempotencyHeaders("command-default-0001"), path: { sessionId: "ses-1" } }, body: { command: "ok", metadata: {} },
    });
    expect(explicitMetadata.data).toEqual(defaultedMetadata.data);
    const cancelled = await client.http.POST("/v1/sessions/{sessionId}/cancel", {
      params: { header: idempotencyHeaders("session-cancel-0001"), path: { sessionId: "ses-1" } },
    });
    expect(cancelled.response.status).toBe(202);
    expect(cancelled.data).toMatchObject({ state: "cancelled" });
  });

  it("returns one durable event cursor for each committed mutation and its replay", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });

    const workspaceFirst = await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("cursor-workspace-create") },
    });
    const workspaceReplay = await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("cursor-workspace-create") },
    });
    expect(requireEventCursor(workspaceReplay.response)).toBe(requireEventCursor(workspaceFirst.response));

    const workspacePatchFirst = await client.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "renamed" }, params: { header: mutationHeaders(1, "cursor-workspace-patch"), path: { workspaceId: "ws-1" } },
    });
    const workspacePatchReplay = await client.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "renamed" }, params: { header: mutationHeaders(1, "cursor-workspace-patch"), path: { workspaceId: "ws-1" } },
    });
    expect(requireEventCursor(workspacePatchReplay.response)).toBe(requireEventCursor(workspacePatchFirst.response));

    const sessionFirst = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "session" }, params: { header: idempotencyHeaders("cursor-session-create"), path: { workspaceId: "ws-1" } },
    });
    const sessionReplay = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "session" }, params: { header: idempotencyHeaders("cursor-session-create"), path: { workspaceId: "ws-1" } },
    });
    expect(requireEventCursor(sessionReplay.response)).toBe(requireEventCursor(sessionFirst.response));

    const sessionPatchFirst = await client.http.PATCH("/v1/sessions/{sessionId}", {
      body: { title: "retitled" }, params: { header: mutationHeaders(1, "cursor-session-patch"), path: { sessionId: "ses-1" } },
    });
    const sessionPatchReplay = await client.http.PATCH("/v1/sessions/{sessionId}", {
      body: { title: "retitled" }, params: { header: mutationHeaders(1, "cursor-session-patch"), path: { sessionId: "ses-1" } },
    });
    expect(requireEventCursor(sessionPatchReplay.response)).toBe(requireEventCursor(sessionPatchFirst.response));

    for (const [operation, invoke] of [
      ["cancel", () => client.http.POST("/v1/sessions/{sessionId}/cancel", { params: { header: idempotencyHeaders("cursor-session-cancel"), path: { sessionId: "ses-1" } } })],
      ["command", () => client.http.POST("/v1/sessions/{sessionId}/commands", { body: { command: "run" }, params: { header: idempotencyHeaders("cursor-session-command"), path: { sessionId: "ses-1" } } })],
      ["delete", () => client.http.DELETE("/v1/sessions/{sessionId}", { params: { header: idempotencyHeaders("cursor-session-delete"), path: { sessionId: "ses-1" } } })],
    ] as const) {
      const first = await invoke();
      const replay = await invoke();
      expect(requireEventCursor(replay.response), operation).toBe(requireEventCursor(first.response));
    }
  });

  it("replays successful session deletion only within the original principal and request scope", async () => {
    const service = new T4ApiV1ConformanceService();
    const owner = await seededClient(service, "delete-replay");
    const other = createT4ApiClient({ baseUrl: service.origin, credential: "token-b", majorVersion: 1, fetch: service.fetch });
    const first = await owner.http.DELETE("/v1/sessions/{sessionId}", {
      params: { header: idempotencyHeaders("session-delete-replay"), path: { sessionId: "ses-1" } },
    });
    const replay = await owner.http.DELETE("/v1/sessions/{sessionId}", {
      params: { header: idempotencyHeaders("session-delete-replay"), path: { sessionId: "ses-1" } },
    });
    expect(first.response.status).toBe(204);
    expect(first.response.headers.get("Idempotency-Replayed")).toBe("false");
    expect(replay.response.status).toBe(204);
    expect(replay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await owner.http.DELETE("/v1/sessions/{sessionId}", {
      params: { header: idempotencyHeaders("session-delete-fresh"), path: { sessionId: "ses-1" } },
    })).response.status).toBe(404);
    expect((await other.http.DELETE("/v1/sessions/{sessionId}", {
      params: { header: idempotencyHeaders("session-delete-replay"), path: { sessionId: "ses-1" } },
    })).response.status).toBe(404);
  });

  it("validates mutations before state changes and idempotency recording", async () => {
    const workspaceService = new T4ApiV1ConformanceService();
    const workspaceClient = createT4ApiClient({ baseUrl: workspaceService.origin, credential: "token-a", majorVersion: 1, fetch: workspaceService.fetch });
    requireData(await workspaceClient.http.POST("/v1/workspaces", {
      body: { name: "original" }, params: { header: idempotencyHeaders("mutation-workspace-setup") },
    }));
    const invalidWorkspaceBodies = [
      {}, { unknown: true }, { name: 42 }, { name: "" }, { name: "😀".repeat(129) },
      { labels: { Invalid: "value" } }, { labels: { valid: "😀".repeat(129) } },
    ];
    for (const [index, body] of invalidWorkspaceBodies.entries()) {
      const result = await workspaceClient.http.PATCH("/v1/workspaces/{workspaceId}", {
        params: { header: mutationHeaders(1, `invalid-workspace-${index}`), path: { workspaceId: "ws-1" } }, body: body as never,
      });
      expect(result.response.status).toBe(422);
      expect(result.error).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(requireData(await workspaceClient.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "ws-1" } },
    }))).toMatchObject({ name: "original", revision: 1 });
    expect((await workspaceClient.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "invalid-workspace-0"), path: { workspaceId: "ws-1" } }, body: { name: "valid" },
    })).response.status).toBe(200);

    const sessionService = new T4ApiV1ConformanceService();
    const sessionClient = await seededClient(sessionService, "mutation-validation");
    const invalidSessionBodies = [
      {}, { unknown: true }, { title: 42 }, { title: "" }, { title: "😀".repeat(129) },
      { labels: { Invalid: "value" } }, { labels: { valid: "😀".repeat(129) } },
    ];
    for (const [index, body] of invalidSessionBodies.entries()) {
      const result = await sessionClient.http.PATCH("/v1/sessions/{sessionId}", {
        params: { header: mutationHeaders(1, `invalid-session-${index}`), path: { sessionId: "ses-1" } }, body: body as never,
      });
      expect(result.response.status).toBe(422);
      expect(result.error).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(requireData(await sessionClient.http.GET("/v1/sessions/{sessionId}", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    }))).toMatchObject({ title: "agent", revision: 1 });
    expect((await sessionClient.http.PATCH("/v1/sessions/{sessionId}", {
      params: { header: mutationHeaders(1, "invalid-session-0"), path: { sessionId: "ses-1" } }, body: { title: "valid" },
    })).response.status).toBe(200);
  });

  it("replays exact PATCH results after an intervening revision", async () => {
    const workspaceService = new T4ApiV1ConformanceService();
    const workspaceClient = createT4ApiClient({ baseUrl: workspaceService.origin, credential: "token-a", majorVersion: 1, fetch: workspaceService.fetch });
    requireData(await workspaceClient.http.POST("/v1/workspaces", {
      body: { name: "original" }, params: { header: idempotencyHeaders("workspace-replay-setup") },
    }));
    const originalWorkspace = requireData(await workspaceClient.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "first" }, params: { header: mutationHeaders(1, "workspace-replay-original"), path: { workspaceId: "ws-1" } },
    }));
    requireData(await workspaceClient.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "second" }, params: { header: mutationHeaders(2, "workspace-replay-intervening"), path: { workspaceId: "ws-1" } },
    }));
    const workspaceReplay = await workspaceClient.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "first" }, params: { header: mutationHeaders(1, "workspace-replay-original"), path: { workspaceId: "ws-1" } },
    });
    expect(workspaceReplay.response.status).toBe(200);
    expect(workspaceReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(workspaceReplay.data).toEqual(originalWorkspace);

    const sessionService = new T4ApiV1ConformanceService();
    const sessionClient = await seededClient(sessionService, "patch-replay-intervening");
    const originalSession = requireData(await sessionClient.http.PATCH("/v1/sessions/{sessionId}", {
      body: { title: "first" }, params: { header: mutationHeaders(1, "session-replay-original"), path: { sessionId: "ses-1" } },
    }));
    requireData(await sessionClient.http.PATCH("/v1/sessions/{sessionId}", {
      body: { title: "second" }, params: { header: mutationHeaders(2, "session-replay-intervening"), path: { sessionId: "ses-1" } },
    }));
    const sessionReplay = await sessionClient.http.PATCH("/v1/sessions/{sessionId}", {
      body: { title: "first" }, params: { header: mutationHeaders(1, "session-replay-original"), path: { sessionId: "ses-1" } },
    });
    expect(sessionReplay.response.status).toBe(200);
    expect(sessionReplay.response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(sessionReplay.data).toEqual(originalSession);
  });

  it("validates creates before idempotency and round-trips valid labels", async () => {
    const invalidLabels = [
      null, [], Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key-${index}`, "value"])),
      { Invalid: "value" }, { valid: 1 }, { valid: "😀".repeat(129) },
    ];
    const workspaceService = new T4ApiV1ConformanceService();
    const workspaceClient = createT4ApiClient({ baseUrl: workspaceService.origin, credential: "token-a", majorVersion: 1, fetch: workspaceService.fetch });
    const workspaceBodies: unknown[] = [{ name: "workspace", unknown: true }, ...invalidLabels.map((labels) => ({ name: "workspace", labels }))];
    for (const [index, body] of workspaceBodies.entries()) {
      const key = `invalid-workspace-create-${index}`;
      const invalid = await workspaceClient.http.POST("/v1/workspaces", { body: body as never, params: { header: idempotencyHeaders(key) } });
      expect(invalid.response.status).toBe(422);
      expect(invalid.error).toMatchObject({ error: { code: "invalid_request" } });
      expect((await workspaceClient.http.POST("/v1/workspaces", {
        body: { name: `valid-${index}` }, params: { header: idempotencyHeaders(key) },
      })).response.status).toBe(202);
    }
    const workspaceLabels = { team: "😀".repeat(128) };
    expect(requireData(await workspaceClient.http.POST("/v1/workspaces", {
      body: { name: "labelled", labels: workspaceLabels }, params: { header: idempotencyHeaders("valid-workspace-labels") },
    }))).toMatchObject({ labels: workspaceLabels });

    const sessionService = new T4ApiV1ConformanceService();
    const sessionClient = createT4ApiClient({ baseUrl: sessionService.origin, credential: "token-a", majorVersion: 1, fetch: sessionService.fetch });
    requireData(await sessionClient.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("session-create-workspace") },
    }));
    const sessionBodies: unknown[] = [{ title: "session", unknown: true }, ...invalidLabels.map((labels) => ({ title: "session", labels }))];
    for (const [index, body] of sessionBodies.entries()) {
      const key = `invalid-session-create-${index}`;
      const invalid = await sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        body: body as never, params: { header: idempotencyHeaders(key), path: { workspaceId: "ws-1" } },
      });
      expect(invalid.response.status).toBe(422);
      expect(invalid.error).toMatchObject({ error: { code: "invalid_request" } });
      expect((await sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        body: { title: `valid-${index}` }, params: { header: idempotencyHeaders(key), path: { workspaceId: "ws-1" } },
      })).response.status).toBe(202);
    }
    const sessionLabels = { team: "😀".repeat(128) };
    expect(requireData(await sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "labelled", labels: sessionLabels }, params: { header: idempotencyHeaders("valid-session-labels"), path: { workspaceId: "ws-1" } },
    }))).toMatchObject({ labels: sessionLabels });

    const commandClient = await seededClient(new T4ApiV1ConformanceService(), "command-create-validation");
    const invalidCommand = await commandClient.http.POST("/v1/sessions/{sessionId}/commands", {
      body: { command: "ok", unknown: true } as never,
      params: { header: idempotencyHeaders("invalid-command-create"), path: { sessionId: "ses-1" } },
    });
    expect(invalidCommand.response.status).toBe(422);
    expect((await commandClient.http.POST("/v1/sessions/{sessionId}/commands", {
      body: { command: "ok" }, params: { header: idempotencyHeaders("invalid-command-create"), path: { sessionId: "ses-1" } },
    })).response.status).toBe(202);
  });

  it("rejects lone UTF-16 surrogates before idempotency lookup or mutation", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = await seededClient(service, "unicode-identity");
    const loneHigh = String.fromCharCode(0xd800);
    const loneLow = String.fromCharCode(0xdc00);
    const invalidRequests = [
      client.http.POST("/v1/workspaces", {
        body: { name: loneHigh } as never,
        params: { header: idempotencyHeaders("unicode-workspace-name-0001") },
      }),
      client.http.POST("/v1/workspaces", {
        body: { name: "workspace", labels: { team: loneLow } } as never,
        params: { header: idempotencyHeaders("unicode-workspace-label-0001") },
      }),
      client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        body: { title: loneHigh } as never,
        params: { header: idempotencyHeaders("unicode-session-title-0001"), path: { workspaceId: "ws-1" } },
      }),
      client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        body: { title: "session", labels: { team: loneLow } } as never,
        params: { header: idempotencyHeaders("unicode-session-label-0001"), path: { workspaceId: "ws-1" } },
      }),
      client.http.POST("/v1/sessions/{sessionId}/commands", {
        body: { command: loneHigh } as never,
        params: { header: idempotencyHeaders("unicode-command-text-0001"), path: { sessionId: "ses-1" } },
      }),
      client.http.POST("/v1/sessions/{sessionId}/commands", {
        body: { command: "ok", metadata: { note: loneLow } } as never,
        params: { header: idempotencyHeaders("unicode-command-metadata-0001"), path: { sessionId: "ses-1" } },
      }),
    ];
    for (const request of invalidRequests) {
      const response = await request;
      expect(response.response.status).toBe(422);
      expect(response.error).toMatchObject({ error: {
        code: "invalid_request",
        violations: [{ field: "body", rule: "wellFormedUnicode" }],
      } });
    }
  });

  it("rejects undeclared JSON request media before mutation and idempotency", async () => {
    for (const contentType of [undefined, "text/plain"]) {
      const mediaName = contentType === undefined ? "missing" : "plain";
      const service = new T4ApiV1ConformanceService();
      await seededClient(service, `request-media-${mediaName}`);
      const cases = [
        ["POST", "/v1/workspaces", '{"name":"media-workspace"}', {}, 202, { id: "ws-2" }],
        ["POST", "/v1/workspaces/ws-1/sessions", '{"title":"media-session"}', {}, 202, { id: "ses-2" }],
        ["PATCH", "/v1/workspaces/ws-1", '{"name":"renamed"}', { "T4-If-Revision": "1" }, 200, { revision: 2 }],
        ["PATCH", "/v1/sessions/ses-1", '{"title":"retitled"}', { "T4-If-Revision": "1" }, 200, { revision: 2 }],
        ["POST", "/v1/sessions/ses-1/commands", '{"command":"ok"}', {}, 202, { commandId: "cmd-1" }],
      ] as const;
      for (const [index, [method, path, body, routeHeaders, successStatus, successBody]] of cases.entries()) {
        const key = `request-media-${mediaName}-${index}`;
        const headers = { Authorization: "Bearer token-a", "T4-API-Version": "1", "Idempotency-Key": key, ...routeHeaders };
        const invalid = await service.fetch(`${service.origin}${path}`, {
          method, headers: { ...headers, ...(contentType === undefined ? {} : { "Content-Type": contentType }) }, body,
        });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: { code: "invalid_request" } });
        const valid = await service.fetch(`${service.origin}${path}`, {
          method, headers: { ...headers, "Content-Type": "Application/JSON; Charset=UTF-8" }, body,
        });
        expect(valid.status).toBe(successStatus);
        expect(valid.headers.get("Idempotency-Replayed")).toBe("false");
        expect(await valid.json()).toMatchObject(successBody);
      }
    }
  });

  it("validates T4-If-Revision syntax before PATCH idempotency lookup", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    for (const [index, path] of ["/v1/workspaces/missing", "/v1/sessions/missing"].entries()) {
      for (const ifMatch of [undefined, "invalid"]) {
        const response = await service.fetch(`${service.origin}${path}`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer token-a", "T4-API-Version": "1", "Idempotency-Key": `missing-if-match-${index}-${ifMatch ?? "absent"}`, "Content-Type": "application/json",
            ...(ifMatch === undefined ? {} : { "T4-If-Revision": ifMatch }),
          },
          body: path.includes("workspaces") ? '{"name":"updated"}' : '{"title":"updated"}',
        });
        expect(response.status).toBe(400);
        expect((await response.json()) as unknown).toMatchObject({ error: { code: "invalid_request" } });
      }
    }
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("if-match-workspace-setup") },
    }));
    for (const [index, ifMatch] of [undefined, "", "0", "01", "abc", "1.0", "11111111111111111111"].entries()) {
      const key = `invalid-if-match-${index}`;
      const response = await service.fetch(`${service.origin}/v1/workspaces/ws-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-a", "T4-API-Version": "1", "Idempotency-Key": key, "Content-Type": "application/json",
          ...(ifMatch === undefined ? {} : { "T4-If-Revision": ifMatch }),
        },
        body: '{"name":"updated"}',
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as unknown).toMatchObject({ error: { code: "invalid_request" } });
    }
    const first = await client.http.PATCH("/v1/workspaces/{workspaceId}", {
      body: { name: "updated" }, params: { header: mutationHeaders(1, "if-match-replay-order"), path: { workspaceId: "ws-1" } },
    });
    expect(first.response.status).toBe(200);
    const missingOnReplay = await service.fetch(`${service.origin}/v1/workspaces/ws-1`, {
      method: "PATCH",
      headers: { Authorization: "Bearer token-a", "T4-API-Version": "1", "Idempotency-Key": "if-match-replay-order", "Content-Type": "application/json" },
      body: '{"name":"updated"}',
    });
    expect(missingOnReplay.status).toBe(400);
  });

  it("rejects duplicate JSON members before idempotency is recorded", async () => {
    for (const [index, body] of [
      '{"name":"first","name":"second"}',
      '{"name":"workspace","labels":{"team":"one","team":"two"}}',
    ].entries()) {
      const service = new T4ApiV1ConformanceService();
      const key = `duplicate-json-${index}-0000`;
      const headers = {
        Authorization: "Bearer token-a",
        "T4-API-Version": "1",
        "Idempotency-Key": key,
        "Content-Type": "application/json",
      };
      const rejected = await service.fetch(`${service.origin}/v1/workspaces`, {
        method: "POST", headers, body,
      });
      expect(rejected.status).toBe(400);
      const accepted = await service.fetch(`${service.origin}/v1/workspaces`, {
        method: "POST", headers, body: '{"name":"workspace"}',
      });
      expect(accepted.status).toBe(202);
      expect(accepted.headers.get("Idempotency-Replayed")).toBe("false");
    }

    const commandService = new T4ApiV1ConformanceService();
    await seededClient(commandService, "duplicate-command");
    for (const [index, body] of [
      '{"command":"first","command":"second"}',
      '{"command":"run","metadata":{"attempt":1,"attempt":2}}',
    ].entries()) {
      const response = await commandService.fetch(`${commandService.origin}/v1/sessions/ses-1/commands`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-a",
          "T4-API-Version": "1",
          "Idempotency-Key": `duplicate-command-${index}-0000`,
          "Content-Type": "application/json",
        },
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  it("commits concurrent revision mutations with one atomic compare-and-swap", async () => {
    for (const kind of ["workspace", "session"] as const) {
      const service = new T4ApiV1ConformanceService();
      await seededClient(service, `cas-${kind}`);
      const path = kind === "workspace" ? "/v1/workspaces/ws-1" : "/v1/sessions/ses-1";
      const field = kind === "workspace" ? "name" : "title";
      const streams = [new TransformStream<Uint8Array>(), new TransformStream<Uint8Array>()];
      const requests = streams.map((stream, index) => service.fetch(`${service.origin}${path}`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-a",
          "T4-API-Version": "1",
          "T4-If-Revision": "1",
          "Idempotency-Key": `concurrent-${kind}-${index}-0000`,
          "Content-Type": "application/json",
        },
        body: stream.readable,
        duplex: "half",
      } as RequestInit & { duplex: "half" }));
      await Promise.all(streams.map(async (stream, index) => {
        const writer = stream.writable.getWriter();
        await writer.write(new TextEncoder().encode(JSON.stringify({ [field]: `value-${index}` })));
        await writer.close();
      }));
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const current = await service.fetch(`${service.origin}${path}`, {
        headers: { Authorization: "Bearer token-a", "T4-API-Version": "1" },
      });
      expect(await current.json()).toMatchObject({ revision: 2 });
    }

    for (const kind of ["workspace", "session"] as const) {
      const service = new T4ApiV1ConformanceService();
      await seededClient(service, `delete-race-${kind}`);
      const path = kind === "workspace" ? "/v1/workspaces/ws-1" : "/v1/sessions/ses-1";
      const field = kind === "workspace" ? "name" : "title";
      const stream = new TransformStream<Uint8Array>();
      const patch = service.fetch(`${service.origin}${path}`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-a",
          "T4-API-Version": "1",
          "T4-If-Revision": "1",
          "Idempotency-Key": `delete-race-patch-${kind}`,
          "Content-Type": "application/json",
        },
        body: stream.readable,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const deletion = await service.fetch(`${service.origin}${path}`, {
        method: "DELETE",
        headers: {
          Authorization: "Bearer token-a",
          "T4-API-Version": "1",
          "Idempotency-Key": `delete-race-delete-${kind}`,
        },
      });
      expect(deletion.status).toBe(204);
      const writer = stream.writable.getWriter();
      await writer.write(new TextEncoder().encode(JSON.stringify({ [field]: "resurrected" })));
      await writer.close();
      expect((await patch).status).toBe(404);
      const current = await service.fetch(`${service.origin}${path}`, {
        headers: { Authorization: "Bearer token-a", "T4-API-Version": "1" },
      });
      expect(current.status).toBe(404);
    }
  });

  it("rejects an invalid declared watch cache header", async () => {
    let cacheBodyCancelled = false;
    const cacheClient = createT4ApiClient({
      baseUrl: "https://watch-cache.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"heartbeat","cursor":"cache","observedAt":"2026-07-21T00:00:00Z"}\n\n')); },
        cancel() { cacheBodyCancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "max-age=3600" } }),
    });
    await expect(cacheClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ status: 502, retryable: false });
    expect(cacheBodyCancelled).toBe(true);
  });

  it("reconnects instead of hanging on a half-open watch past the heartbeat deadline", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const client = createT4ApiClient({
        baseUrl: "https://half-open-watch.test",
        credential: "token-a",
        majorVersion: 1,
        fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
          cancel() { cancelled = true; },
        }), { headers: { "Content-Type": "text/event-stream" } }),
      });
      const pending = client.watchSession("ses-1", {
        maxEvents: 1,
        heartbeatSeconds: 5,
        maxReconnectAttempts: 0,
      }).next();
      const rejected = expect(pending).rejects.toMatchObject({ status: 502, code: "indeterminate" });
      await vi.advanceTimersByTimeAsync(10_001);
      await rejected;
      expect(cancelled).toBe(true);

      let commentsCancelled = false;
      let commentInterval: ReturnType<typeof setInterval> | undefined;
      const comments = createT4ApiClient({
        baseUrl: "https://comment-watch.test",
        credential: "token-a",
        majorVersion: 1,
        fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
          start(stream) {
            commentInterval = setInterval(
              () => stream.enqueue(new TextEncoder().encode(": keepalive\n\n")),
              4_000,
            );
          },
          cancel() {
            if (commentInterval !== undefined) clearInterval(commentInterval);
            commentsCancelled = true;
          },
        }), { headers: { "Content-Type": "text/event-stream" } }),
      });
      const commentPending = comments.watchSession("ses-1", {
        maxEvents: 1,
        heartbeatSeconds: 5,
        maxReconnectAttempts: 0,
      }).next();
      const commentRejected = expect(commentPending).rejects.toMatchObject({
        status: 502, code: "indeterminate",
      });
      await vi.advanceTimersByTimeAsync(10_001);
      await commentRejected;
      expect(commentsCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires no-store through the exported HTTP watch operation", async () => {
    for (const cacheControl of [undefined, "max-age=3600"]) {
      const client = createT4ApiClient({
        baseUrl: "https://raw-watch-cache.test", credential: "token-a", majorVersion: 1,
        fetch: async () => new Response('data: {"type":"heartbeat","cursor":"raw","observedAt":"2026-07-21T00:00:00Z"}\n\n', { headers: {
          "Content-Type": "text/event-stream", "T4-API-Version": "1.0", ...(cacheControl === undefined ? {} : { "Cache-Control": cacheControl }),
        } }),
      });
      await expect(client.http.GET("/v1/sessions/{sessionId}/events", {
        params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" }, query: { maxEvents: 1, heartbeatSeconds: 5 } },
      })).rejects.toMatchObject({ status: 502, retryable: false });
    }
  });

  it("rejects invalid RFC 3339 calendar timestamps", async () => {

    for (const observedAt of [
      "2026-02-31T00:00:00Z", "2026-13-01T00:00:00Z", "2025-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+01:60",
      "2026-06-30T23:59:60Z", "2026-12-31T23:59:60Z", "2026-06-30T15:59:60-08:00",
    ]) {
      const calendarClient = createT4ApiClient({
        baseUrl: "https://watch-calendar.test", credential: "token-a", majorVersion: 1,
        fetch: async () => apiResponse(`data: {"type":"heartbeat","cursor":"calendar","observedAt":"${observedAt}"}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      });
      await expect(calendarClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ status: 502, retryable: false });
    }
  });

  it("accepts an RFC 3339 leap second after applying its offset", async () => {
    const client = createT4ApiClient({
      baseUrl: "https://watch-leap-second.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse('data: {"type":"heartbeat","cursor":"leap","observedAt":"1990-12-31T15:59:60-08:00"}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).resolves.toMatchObject({ value: { cursor: "leap" } });
  });

  it("accepts lowercase RFC 3339 delimiters", async () => {
    const client = createT4ApiClient({
      baseUrl: "https://watch-lowercase-time.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse('data: {"type":"heartbeat","cursor":"lowercase","observedAt":"2026-07-21t00:00:00z"}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).resolves.toMatchObject({ value: { cursor: "lowercase" } });
  });

  it("uses typed low-level stream parsing and the SSE Accept header", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = await seededClient(service, "raw-stream");
    const wrongAccept = await service.fetch(`${service.origin}/v1/sessions/ses-1/events?maxEvents=1&heartbeatSeconds=5`, {
      headers: { Authorization: "Bearer token-a", "T4-API-Version": "1", Accept: "application/json" },
    });
    expect(wrongAccept.status).toBe(406);
    const streamed = await client.http.GET("/v1/sessions/{sessionId}/events", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" }, query: { maxEvents: 1, heartbeatSeconds: 5 } },
      parseAs: "stream",
    });
    expect(streamed.response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(streamed.response.headers.get("Cache-Control")).toBe("no-store");
    expect(streamed.data).toBeInstanceOf(ReadableStream);
    await streamed.data?.cancel();
  });

  it("rejects malformed present Retry-After on ordinary and watch 503 responses", async () => {
    for (const retryAfter of ["", "not-a-date", "-1", "x".repeat(129)]) {
      const body = { error: { code: "unavailable", message: "later", requestId: "r", retryable: true } };
      const ordinary = createT4ApiClient({
        baseUrl: "https://ordinary-retry-after.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse(body, { status: 503, headers: { "Retry-After": retryAfter } }),
      });
      await expect(ordinary.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ status: 502, retryable: false });

      const watch = createT4ApiClient({
        baseUrl: "https://watch-retry-after.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse(body, { status: 503, headers: { "Retry-After": retryAfter } }),
      });
      await expect(watch.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0, retryBackoffMs: 0 }).next()).rejects.toMatchObject({ status: 502, retryable: false });
    }
  });

  it("accepts every RFC 9110 HTTP-date form in Retry-After without dropping its delay", async () => {
    for (const retryAfter of [
      "Sun, 06 Nov 1994 08:49:37 GMT",
      "Sunday, 06-Nov-94 08:49:37 GMT",
      "Sun Nov  6 08:49:37 1994",
    ]) {
      const client = createT4ApiClient({
        baseUrl: "https://http-date-retry-after.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse({ error: { code: "unavailable", message: "later", requestId: "r", retryable: true } }, { status: 503, headers: { "Retry-After": retryAfter } }),
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
        status: 502, cause: { status: 503, retryAfterMs: 0 },
      });
    }
  });

  it("resolves RFC 850 two-digit years relative to the current year", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
      const client = createT4ApiClient({
        baseUrl: "https://rfc850-year.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse({ error: { code: "unavailable", message: "later", requestId: "r", retryable: true } }, { status: 503, headers: { "Retry-After": "Saturday, 01-Jan-50 00:00:00 GMT" } }),
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
        status: 502, cause: { status: 503, retryAfterMs: 30_000 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the RFC 850 pivot to the complete timestamp", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-21T00:00:00Z"));
      const client = createT4ApiClient({
        baseUrl: "https://rfc850-boundary.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse({ error: { code: "unavailable", message: "later", requestId: "r", retryable: true } }, { status: 503, headers: { "Retry-After": "Friday, 31-Dec-76 00:00:00 GMT" } }),
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
        status: 502, cause: { status: 503, retryAfterMs: 0 },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a snapshot and watches bounded SSE with heartbeat, reconnect, cancellation, and typed resync", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    requireData(await client.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("workspace-watch-0001") },
    }));
    requireData(await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      params: { header: idempotencyHeaders("session-watch-0001"), path: { workspaceId: "ws-1" } }, body: { title: "agent" },
    }));
    const snapshot = requireData(await client.http.GET("/v1/sessions/{sessionId}/snapshot", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    }));
    expect(snapshot).toMatchObject({ sessionId: "ses-1", cursor: "cursor-2", entries: [{ sequence: 2 }] });

    const received: Array<components["schemas"]["WatchEvent"]> = [];
    for await (const event of client.watchSession("ses-1", { cursor: snapshot.cursor, maxEvents: 3, heartbeatSeconds: 20, maxReconnectAttempts: 2, retryBackoffMs: 0 })) {
      received.push(event);
    }
    expect(received).toEqual([
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-2" }),
      expect.objectContaining({ type: "session", cursor: "cursor-4", state: "accepted" }),
      expect.objectContaining({ type: "heartbeat", cursor: "cursor-4" }),
    ]);
    expect(received.map(exhaustWatchEvent)).toEqual(["2026-07-21T00:00:00Z", "accepted:2", "2026-07-21T00:00:15Z"]);
    expect(service.watchCursors[0]).toEqual({ query: "cursor-2", header: "cursor-2" });
    expect(service.watchCursors[1]).toEqual({ query: "cursor-4", header: "cursor-4" });
    expect(service.watchQueries.slice(0, 2)).toEqual([
      { maxEvents: "3", heartbeatSeconds: "20" },
      { maxEvents: "1", heartbeatSeconds: "20" },
    ]);

    await expect(async () => {
      for await (const _event of client.watchSession("ses-1", { cursor: "expired", maxEvents: 1 })) {
        throw new Error("expired cursor unexpectedly produced an event");
      }
    }).rejects.toMatchObject({
      name: "T4ApiError",
      code: "cursor_expired",
      status: 410,
      resync: { snapshotUrl: "v1/sessions/ses-1/snapshot", cursor: "cursor-2" },
    } satisfies Partial<T4ApiError>);
  });

  it("enforces the ResourceId bound in cursor-expired resync snapshot URLs", async () => {
    const resourceId128 = `s${"a".repeat(127)}`;
    const resourceId129 = `s${"a".repeat(128)}`;
    const cursorExpired = (sessionId: string) => ({ error: {
      code: "cursor_expired", message: "expired", requestId: "r", retryable: false,
      resync: { snapshotUrl: `v1/sessions/${sessionId}/snapshot`, cursor: "cursor-1" },
    } });

    for (const [watchedSessionId, responseSessionId, expected] of [
      [resourceId128, resourceId128, "cursor_expired"],
      ["ses-1", resourceId129, "indeterminate"],
    ] as const) {
      const client = createT4ApiClient({
        baseUrl: "https://resync-bound.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse(cursorExpired(responseSessionId), { status: 410 }),
      });
      await expect(client.watchSession(watchedSessionId, { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
        code: expected, status: expected === "cursor_expired" ? 410 : 502,
      });
    }

    const mismatched = createT4ApiClient({
      baseUrl: "https://resync-session.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse(cursorExpired("ses-other"), { status: 410 }),
    });
    await expect(mismatched.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
      code: "indeterminate", status: 502,
    });

    const contract = JSON.parse(readFileSync(new URL("../../t4-api-contract/openapi.json", import.meta.url), "utf8")) as {
      components: { schemas: { Resync: { properties: { snapshotUrl: { pattern: string; maxLength: number } } } } };
    };
    const snapshotUrlSchema = contract.components.schemas.Resync.properties.snapshotUrl;
    const pattern = new RegExp(snapshotUrlSchema.pattern, "u");
    expect(pattern.test(`v1/sessions/${resourceId128}/snapshot`)).toBe(true);
    expect(pattern.test(`v1/sessions/${resourceId129}/snapshot`)).toBe(false);
    expect(`v1/sessions/${resourceId128}/snapshot`.length).toBeLessThanOrEqual(snapshotUrlSchema.maxLength);
  });

  it("accepts every command lifecycle watch state and rejects removed states", async () => {
    for (const [index, state] of COMMAND_STATES.entries()) {
      const cursor = `command-state-${index}`;
      const client = createT4ApiClient({
        baseUrl: "https://command-states.test", credential: "token-a", majorVersion: 1,
        fetch: async () => apiResponse(`data: ${JSON.stringify({ type: "command", cursor, commandId: "cmd-1", state })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }),
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).resolves.toMatchObject({ value: { state } });
    }

    const removed = createT4ApiClient({
      baseUrl: "https://removed-command-state.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse('data: {"type":"command","cursor":"removed-1","commandId":"cmd-1","state":"conflict"}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(removed.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
  });

  it("rejects malformed mutation idempotency and watch query contracts", async () => {
    const service = new T4ApiV1ConformanceService();
    const baseHeaders = { Authorization: "Bearer token-a", "T4-API-Version": "1", "Content-Type": "application/json" };
    const created = await service.fetch(`${service.origin}/v1/workspaces`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "workspace-raw-0001" }, body: '{"name":"workspace"}' });
    expect(created.status).toBe(202);
    const missingSpawn = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: baseHeaders, body: '{"title":"agent"}' });
    expect(missingSpawn.status).toBe(400);
    expect(await missingSpawn.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    const invalidSpawn = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "short" }, body: '{"title":"agent"}' });
    expect(invalidSpawn.status).toBe(400);
    const spawned = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, { method: "POST", headers: { ...baseHeaders, "Idempotency-Key": "session-raw-00001" }, body: '{"title":"agent"}' });
    expect(spawned.status).toBe(202);
    for (const [method, path, body] of [
      ["PATCH", "/v1/workspaces/ws-1", '{"name":"x"}'],
      ["DELETE", "/v1/workspaces/ws-1", undefined],
      ["PATCH", "/v1/sessions/ses-1", '{"title":"x"}'],
      ["DELETE", "/v1/sessions/ses-1", undefined],
      ["POST", "/v1/sessions/ses-1/cancel", undefined],
      ["POST", "/v1/sessions/ses-1/commands", '{"command":"ok"}'],
    ] as const) {
      const response = await service.fetch(`${service.origin}${path}`, { method, headers: { ...baseHeaders, "T4-If-Revision": "1" }, ...(body === undefined ? {} : { body }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    }
    for (const [method, path, headers] of [
      ["POST", "/v1/workspaces", { ...baseHeaders, "Idempotency-Key": "malformed-workspace-01" }],
      ["PATCH", "/v1/workspaces/ws-1", { ...baseHeaders, "T4-If-Revision": "1", "Idempotency-Key": "malformed-workspace-02" }],
      ["POST", "/v1/workspaces/ws-1/sessions", { ...baseHeaders, "Idempotency-Key": "malformed-session-0001" }],
      ["PATCH", "/v1/sessions/ses-1", { ...baseHeaders, "T4-If-Revision": "1", "Idempotency-Key": "malformed-session-0002" }],
    ] as const) {
      const response = await service.fetch(`${service.origin}${path}`, { method, headers, body: "{" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    for (const query of ["maxEvents=0", "maxEvents=5", "heartbeatSeconds=4", "heartbeatSeconds=61"]) {
      const response = await service.fetch(`${service.origin}/v1/sessions/ses-1/events?${query}`, { headers: { ...baseHeaders, Accept: "text/event-stream" } });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", violations: expect.any(Array) } });
    }
  });

  it("rejects malformed workspace and session pagination cursors", async () => {
    const service = new T4ApiV1ConformanceService();
    const headers = { Authorization: "Bearer token-a", "T4-API-Version": "1", "Content-Type": "application/json" };
    expect((await service.fetch(`${service.origin}/v1/workspaces`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "pagination-workspace" }, body: '{"name":"workspace"}',
    })).status).toBe(202);
    expect((await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, {
      method: "POST", headers: { ...headers, "Idempotency-Key": "pagination-session-1" }, body: '{"title":"session"}',
    })).status).toBe(202);

    for (const path of ["/v1/workspaces", "/v1/workspaces/ws-1/sessions"]) {
      for (const cursor of ["foo", "page--1", "page-01", "page-9007199254740992"]) {
        const response = await service.fetch(`${service.origin}${path}?cursor=${encodeURIComponent(cursor)}`, { headers });
        expect(response.status, `${path} accepted ${cursor}`).toBe(422);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "cursor", rule: "format" }] } });
      }
    }
  });

  it("accepts only pagination cursors issued for the principal and collection", async () => {
    const service = new T4ApiV1ConformanceService();
    const headers = { Authorization: "Bearer token-a", "T4-API-Version": "1", "Content-Type": "application/json" };
    for (const [key, name] of [["issued-workspace-1", "one"], ["issued-workspace-2", "two"], ["issued-workspace-3", "three"]]) {
      expect((await service.fetch(`${service.origin}/v1/workspaces`, {
        method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ name }),
      })).status).toBe(202);
    }
    for (const [key, title] of [["issued-session-01", "one"], ["issued-session-02", "two"]]) {
      expect((await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions`, {
        method: "POST", headers: { ...headers, "Idempotency-Key": key }, body: JSON.stringify({ title }),
      })).status).toBe(202);
    }

    const workspacePage = await service.fetch(`${service.origin}/v1/workspaces?pageSize=1`, { headers });
    const workspaceCursor = (await workspacePage.json() as { nextCursor: string }).nextCursor;
    expect((await service.fetch(`${service.origin}/v1/workspaces?pageSize=1&cursor=${workspaceCursor}`, { headers })).status).toBe(200);
    const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const signatureSegment = workspaceCursor.split(".").at(-1)!;
    const encodedRemainder = signatureSegment.length % 4;
    const unusedBits = encodedRemainder === 2 ? 4 : encodedRemainder === 3 ? 2 : 0;
    const terminalIndex = base64UrlAlphabet.indexOf(signatureSegment.at(-1)!);
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    const aliasMask = (1 << unusedBits) - 1;
    expect(terminalIndex & aliasMask).toBe(0);
    const signatureAliases = base64UrlAlphabet.slice(
      terminalIndex & ~aliasMask,
      (terminalIndex & ~aliasMask) + aliasMask + 1,
    ).replace(signatureSegment.at(-1)!, "");
    expect(signatureAliases.length).toBeGreaterThan(0);
    expect(signatureAliases).toHaveLength(3);
    for (const signatureAlias of signatureAliases) {
      const noncanonicalCursor = `${workspaceCursor.slice(0, -1)}${signatureAlias}`;
      const noncanonical = await service.fetch(`${service.origin}/v1/workspaces?pageSize=1&cursor=${noncanonicalCursor}`, { headers });
      expect(noncanonical.status).toBe(422);
      expect(await noncanonical.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    const sessionPage = await service.fetch(`${service.origin}/v1/workspaces/ws-1/sessions?pageSize=1`, { headers });
    const sessionCursor = (await sessionPage.json() as { nextCursor: string }).nextCursor;

    for (const [path, cursor, authorization] of [
      ["/v1/workspaces", "page-999", "Bearer token-a"],
      ["/v1/workspaces/ws-1/sessions", "page-999", "Bearer token-a"],
      ["/v1/workspaces/ws-1/sessions", workspaceCursor, "Bearer token-a"],
      ["/v1/workspaces", sessionCursor, "Bearer token-a"],
      ["/v1/workspaces", workspaceCursor, "Bearer token-b"],
    ]) {
      const response = await service.fetch(`${service.origin}${path}?pageSize=1&cursor=${cursor}`, { headers: { ...headers, Authorization: authorization } });
      expect(response.status, `${path} accepted unissued cursor ${cursor}`).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "cursor", rule: "issued" }] } });
    }

    const laterWorkspacePage = await service.fetch(`${service.origin}/v1/workspaces?pageSize=2`, { headers });
    const staleWorkspaceCursor = (await laterWorkspacePage.json() as { nextCursor: string }).nextCursor;
    expect((await service.fetch(`${service.origin}/v1/workspaces/ws-3`, {
      method: "DELETE", headers: { ...headers, "Idempotency-Key": "shrink-workspace-3" },
    })).status).toBe(204);
    expect((await service.fetch(`${service.origin}/v1/sessions/ses-2`, {
      method: "DELETE", headers: { ...headers, "Idempotency-Key": "shrink-session-02" },
    })).status).toBe(204);
    for (const [path, cursor] of [
      ["/v1/workspaces", staleWorkspaceCursor],
      ["/v1/workspaces/ws-1/sessions", sessionCursor],
    ]) {
      const response = await service.fetch(`${service.origin}${path}?pageSize=1&cursor=${cursor}`, { headers });
      expect(response.status, `${path} accepted a cursor past the shrunken collection`).toBe(422);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", violations: [{ field: "cursor", rule: "issued" }] } });
    }
  });

  it("parses service frames incrementally across split UTF-8 and per-frame bounds", async () => {
    const bytewiseService = new T4ApiV1ConformanceService({ watchTransport: "bytewise" });
    const bytewiseClient = await seededClient(bytewiseService, "bytewise");
    const event = await bytewiseClient.watchSession("ses-1", { maxEvents: 1, heartbeatSeconds: 20, maxReconnectAttempts: 0 }).next();
    expect(event.value).toMatchObject({ type: "heartbeat", cursor: "cursor-3" });
    expect(bytewiseService.watchQueries[0]).toEqual({ maxEvents: "1", heartbeatSeconds: "20" });

    const manyService = new T4ApiV1ConformanceService({ watchTransport: "many-small" });
    const manyClient = await seededClient(manyService, "many-small");
    let count = 0;
    for await (const _event of manyClient.watchSession("ses-1", { maxEvents: 1000, maxReconnectAttempts: 0 })) count += 1;
    expect(count).toBe(1000);

    const oversizedService = new T4ApiV1ConformanceService({ watchTransport: "oversized" });
    const oversizedClient = await seededClient(oversizedService, "oversized");
    await expect(oversizedClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    let ongoingOversizedCancelled = false;
    const ongoingOversizedClient = createT4ApiClient({
      baseUrl: "https://ongoing-oversized-event.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(600 * 1024)); },
        cancel() { ongoingOversizedCancelled = true; },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(ongoingOversizedClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
      code: "indeterminate", status: 502, retryable: false,
    });
    expect(ongoingOversizedCancelled).toBe(true);
  });

  it("fails closed on unknown watch fields and incomplete typed errors", async () => {
    const eventFetch: typeof globalThis.fetch = async () => apiResponse('data: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z","unknown":true}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    const eventClient = createT4ApiClient({ baseUrl: "https://unknown.test", credential: "token-a", majorVersion: 1, fetch: eventFetch });
    await expect(eventClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
    for (const [status, code] of [[410, "cursor_expired"], [406, "incompatible_version"], [422, "invalid_request"]] as const) {
      const fetch: typeof globalThis.fetch = async () => jsonResponse({ error: { code, message: "incomplete", requestId: "r", retryable: false } }, { status });
      const client = createT4ApiClient({ baseUrl: "https://errors.test", credential: "token-a", majorVersion: 1, fetch });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
    }
    for (const [status, code] of [[401, "not_found"], [403, "unauthenticated"], [404, "forbidden"], [409, "unavailable"], [503, "revision_conflict"]] as const) {
      const fetch: typeof globalThis.fetch = async () => jsonResponse({ error: { code, message: "wrong status class", requestId: "r", retryable: false } }, { status });
      const client = createT4ApiClient({ baseUrl: "https://status-errors.test", credential: "token-a", majorVersion: 1, fetch });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
    }
  });

  it("fails closed on malformed, oversized, status-inconsistent, and unknown-field HTTP errors", async () => {
    const validErrors = [
      [400, { error: { code: "invalid_request", message: "bad", requestId: "r", retryable: false } }],
      [401, { error: { code: "unauthenticated", message: "bad", requestId: "r", retryable: false } }],
      [403, { error: { code: "forbidden", message: "bad", requestId: "r", retryable: false } }],
      [404, { error: { code: "not_found", message: "bad", requestId: "r", retryable: false } }],
      [406, { error: { code: "incompatible_version", message: "bad", requestId: "r", retryable: false, supportedMajors: [1] } }],
      [409, { error: { code: "revision_conflict", message: "bad", requestId: "r", retryable: false } }],
      [422, { error: { code: "invalid_request", message: "bad", requestId: "r", retryable: false, violations: [{ field: "name", rule: "length", message: "bad" }] } }],
      [503, { error: { code: "unavailable", message: "bad", requestId: "r", retryable: true } }],
    ] as const;
    for (const [status, body] of validErrors) {
      const fetch: typeof globalThis.fetch = async () => jsonResponse({ error: { ...body.error, unknown: true } }, { status });
      const client = createT4ApiClient({ baseUrl: "https://ordinary-errors.test", credential: "token-a", majorVersion: 1, fetch });
      await expect(client.http.POST("/v1/workspaces", {
        body: { name: "workspace" }, params: { header: idempotencyHeaders("ordinary-errors-0001") },
      })).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
    }

    const malformedClient = createT4ApiClient({
      baseUrl: "https://malformed-error.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse("{", { status: 404, headers: { "Content-Type": "application/json" } }),
    });
    await expect(malformedClient.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "missing" } },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });

    const oversizedClient = createT4ApiClient({
      baseUrl: "https://oversized-error.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse("x".repeat(1024 * 1024 + 1), { status: 404, headers: { "Content-Type": "application/json" } }),
    });
    await expect(oversizedClient.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "missing" } },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });

    const streamedChunk = new Uint8Array(600 * 1024);
    for (const contentType of ["application/json", "text/plain"]) {
      let cancelled = false;
      const streamedClient = createT4ApiClient({
        baseUrl: "https://streamed-error.test", credential: "token-a", majorVersion: 1,
        fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(streamedChunk); },
          cancel() { cancelled = true; },
        }), { status: 404, headers: { "Content-Type": contentType } }),
      });
      await expect(streamedClient.http.GET("/v1/workspaces/{workspaceId}", {
        params: { header: VERSION_HEADERS, path: { workspaceId: "missing" } },
      })).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
      expect(cancelled).toBe(true);
    }

    const statusClient = createT4ApiClient({
      baseUrl: "https://undeclared-error.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse(validErrors[3][1], { status: 404 }),
    });
    await expect(statusClient.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
  });

  it("validates successful JSON routes relative to the base path and rejects undeclared media and statuses", async () => {
    const discovery = DISCOVERY;
    const prefixed = createT4ApiClient({
      baseUrl: "https://prefixed.test/api", credential: "token-a", majorVersion: 1,
      fetch: async (input) => {
        expect(new Request(input).url).toBe("https://prefixed.test/api/v1");
        return jsonResponse({ ...discovery, unknown: true });
      },
    });
    await expect(prefixed.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    const invalidSnapshot = createT4ApiClient({
      baseUrl: "https://snapshot.test/api", credential: "token-a", majorVersion: 1,
      fetch: async (input) => {
        expect(new URL(new Request(input).url).pathname).toBe("/api/v1/sessions/ses-1/snapshot");
        return jsonResponse({ sessionId: "ses-1", cursor: "cursor-1", state: "ready", entries: [], unknown: true });
      },
    });
    await expect(invalidSnapshot.http.GET("/v1/sessions/{sessionId}/snapshot", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    const astralText = "😀".repeat(524_289);
    const unicodeSnapshot = createT4ApiClient({
      baseUrl: "https://unicode-snapshot.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse({ sessionId: "ses-1", cursor: "cursor-1", state: "ready", entries: [{ sequence: 0, kind: "output", text: astralText }] }),
    });
    const unicode = requireData(await unicodeSnapshot.http.GET("/v1/sessions/{sessionId}/snapshot", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    }));
    expect(unicode.entries[0]?.text).toBe(astralText);

    const astral128 = "😀".repeat(128);
    const unicodeWorkspace = createT4ApiClient({
      baseUrl: "https://unicode-workspace.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse({ id: "wsp-1", name: astral128, state: "ready", revision: 1, labels: { team: astral128 } }),
    });
    const workspace = requireData(await unicodeWorkspace.http.GET("/v1/workspaces/{workspaceId}", {
      params: { header: VERSION_HEADERS, path: { workspaceId: "wsp-1" } },
    }));
    expect(workspace).toMatchObject({ name: astral128, labels: { team: astral128 } });

    const unicodeSession = createT4ApiClient({
      baseUrl: "https://unicode-session.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse({ id: "ses-1", workspaceId: "wsp-1", title: astral128, state: "ready", revision: 1, labels: { team: astral128 } }),
    });
    const session = requireData(await unicodeSession.http.GET("/v1/sessions/{sessionId}", {
      params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
    }));
    expect(session).toMatchObject({ title: astral128, labels: { team: astral128 } });

    const errorMessage = "😀".repeat(1024);
    const errorRequestId = "😀".repeat(128);
    const violationField = "😀".repeat(256);
    const violationMessage = "😀".repeat(512);
    const unicodeError = createT4ApiClient({
      baseUrl: "https://unicode-error.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse({ error: {
        code: "invalid_request", message: errorMessage, requestId: errorRequestId, retryable: false,
        violations: [{ field: violationField, rule: "range", message: violationMessage }],
      } }, { status: 422 }),
    });
    await expect(unicodeError.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
      code: "invalid_request", status: 422, message: errorMessage, requestId: errorRequestId,
      violations: [{ field: violationField, rule: "range", message: violationMessage }],
    });

    for (const response of [
      apiResponse(JSON.stringify(discovery), { status: 200, headers: { "Content-Type": "text/plain" } }),
      jsonResponse(discovery, { status: 201 }),
    ]) {
      const client = createT4ApiClient({ baseUrl: "https://dispatch.test", credential: "token-a", majorVersion: 1, fetch: async () => response.clone() });
      await expect(client.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ code: "indeterminate", status: 502 });
    }

    const unknownRoute = createT4ApiClient({
      baseUrl: "https://dispatch.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse(discovery),
    });
    await expect(unknownRoute.http.GET("/v1/undeclared" as "/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ code: "indeterminate", status: 502 });
  });

  it("accepts only the exact watch status matrix under a prefixed base path", async () => {
    const prefixed = createT4ApiClient({
      baseUrl: "https://watch-status.test/api", credential: "token-a", majorVersion: 1,
      fetch: async (input) => {
        expect(new URL(new Request(input).url).pathname).toBe("/api/v1/sessions/ses-1/events");
        return apiResponse('data: {"type":"heartbeat","cursor":"prefixed-1","observedAt":"2026-07-21T00:00:00Z"}\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    await expect(prefixed.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).resolves.toMatchObject({ value: { cursor: "prefixed-1" } });

    const prefixedExpired = createT4ApiClient({
      baseUrl: "https://watch-status.test/api", credential: "token-a", majorVersion: 1,
      fetch: async (input) => {
        expect(new URL(new Request(input).url).pathname).toBe("/api/v1/sessions/ses-1/events");
        return jsonResponse({ error: {
          code: "cursor_expired", message: "bad", requestId: "r", retryable: false,
          resync: { snapshotUrl: "v1/sessions/ses-1/snapshot", cursor: "cursor-1" },
        } }, { status: 410 });
      },
    });
    await expect(prefixedExpired.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
      status: 410,
      resync: { snapshotUrl: "v1/sessions/ses-1/snapshot", cursor: "cursor-1" },
    });
    expect(new URL("v1/sessions/ses-1/snapshot", "https://watch-status.test/api/").pathname).toBe("/api/v1/sessions/ses-1/snapshot");

    const declared = [
      [400, { error: { code: "invalid_request", message: "bad", requestId: "r", retryable: false } }],
      [401, { error: { code: "unauthenticated", message: "bad", requestId: "r", retryable: false } }],
      [403, { error: { code: "forbidden", message: "bad", requestId: "r", retryable: false } }],
      [404, { error: { code: "not_found", message: "bad", requestId: "r", retryable: false } }],
      [406, { error: { code: "incompatible_version", message: "bad", requestId: "r", retryable: false, supportedMajors: [1] } }],
      [410, { error: { code: "cursor_expired", message: "bad", requestId: "r", retryable: false, resync: { snapshotUrl: "v1/sessions/ses-1/snapshot", cursor: "cursor-1" } } }],
      [422, { error: { code: "invalid_request", message: "bad", requestId: "r", retryable: false, violations: [{ field: "maxEvents", rule: "range", message: "bad" }] } }],
      [503, { error: { code: "unavailable", message: "bad", requestId: "r", retryable: false } }],
    ] as const;
    for (const [status, body] of declared) {
      const client = createT4ApiClient({ baseUrl: "https://watch-status.test", credential: "token-a", majorVersion: 1, fetch: async () => jsonResponse(body, {
        status,
        ...(status === 401 ? { headers: { "WWW-Authenticate": 'Bearer realm="t4"' } } : {}),
      }) });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ status, code: body.error.code });
    }

    for (const response of [
      apiResponse('data: {"type":"heartbeat","cursor":"wrong-media-1","observedAt":"2026-07-21T00:00:00Z"}\n\n', { status: 200, headers: { "Content-Type": "application/json" } }),
      apiResponse('data: {"type":"heartbeat","cursor":"wrong-1","observedAt":"2026-07-21T00:00:00Z"}\n\n', { status: 201, headers: { "Content-Type": "text/event-stream" } }),
      apiResponse(null, { status: 204, headers: { "Content-Type": "text/event-stream" } }),
      jsonResponse({ error: { code: "revision_conflict", message: "bad", requestId: "r", retryable: false } }, { status: 409 }),
    ]) {
      let attempts = 0;
      const client = createT4ApiClient({
        baseUrl: "https://watch-status.test", credential: "token-a", majorVersion: 1,
        fetch: async () => { attempts += 1; return response.clone(); },
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 3, retryBackoffMs: 0 }).next()).rejects.toMatchObject({
        status: 502, code: "indeterminate", retryable: false,
      });
      expect(attempts).toBe(1);
    }
  });

  it("declares truthful discovery and required public response headers while preserving the 401 exception", () => {
    const contract = JSON.parse(readFileSync(new URL("../../t4-api-contract/openapi.json", import.meta.url), "utf8")) as {
      paths: Record<string, { patch?: { responses: Record<string, { $ref?: string }> }; get?: { responses: Record<string, { headers?: Record<string, { required?: boolean }> }> } }>;
      components: {
        headers: Record<string, { required?: boolean }>;
        responses: Record<string, { headers?: Record<string, { $ref?: string }> }>;
        schemas: Record<string, { required?: string[]; maxProperties?: number; propertyNames?: { pattern?: string; maxLength?: number }; additionalProperties?: boolean | { $ref?: string }; properties?: Record<string, { $ref?: string }> }>;
      };
    };
    expect(contract.paths["/v1/workspaces/{workspaceId}"]?.patch?.responses["200"]?.$ref).toBe("#/components/responses/WorkspaceReplay");
    expect(contract.paths["/v1/sessions/{sessionId}"]?.patch?.responses["200"]?.$ref).toBe("#/components/responses/SessionReplay");
    expect(contract.components.headers.SelectedVersion?.required).toBe(true);
    expect(contract.components.headers.IdempotencyReplayed?.required).toBe(true);
    expect(contract.components.headers.EventCursor?.required).toBe(true);
    for (const response of ["WorkspaceAccepted", "WorkspaceReplay", "SessionAccepted", "SessionReplay", "CommandAccepted", "CommandReplay", "Deleted"]) {
      expect(contract.components.responses[response]?.headers?.["T4-Event-Cursor"]?.$ref).toBe("#/components/headers/EventCursor");
    }
    expect(contract.paths["/v1/sessions/{sessionId}/events"]?.get?.responses["200"]?.headers?.["Cache-Control"]?.required).toBe(true);
    expect(contract.components.responses.Error401?.headers?.["T4-API-Version"]).toBeUndefined();

    const discovery = contract.components.schemas.Discovery!;
    expect(discovery.required).toContain("serverBuild");
    expect(discovery.properties?.capabilities).toEqual({ $ref: "#/components/schemas/Capabilities" });
    expect(contract.components.schemas.Capabilities).toMatchObject({
      maxProperties: 128,
      propertyNames: { pattern: "^[a-z][a-z0-9.-]*$", maxLength: 128 },
      additionalProperties: { $ref: "#/components/schemas/CapabilityStatus" },
    });
    expect(contract.components.schemas.CapabilityStatus).toMatchObject({
      additionalProperties: false,
      required: ["supported", "enabled", "authorized", "available"],
    });
  });

  it("treats malformed and oversized watch 503 envelopes as terminal protocol errors", async () => {
    for (const body of ["{", "x".repeat(1024 * 1024 + 1)]) {
      let attempts = 0;
      const client = createT4ApiClient({
        baseUrl: "https://invalid-503.test", credential: "token-a", majorVersion: 1,
        fetch: async () => {
          attempts += 1;
          return apiResponse(body, { status: 503, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
        },
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 3, retryBackoffMs: 0 }).next()).rejects.toMatchObject({
        code: "indeterminate", status: 502, retryable: false,
      });
      expect(attempts).toBe(1);
    }

    let oversizedCancelled = false;
    const oversizedChunk = new Uint8Array(600 * 1024);
    const streamedOversizedClient = createT4ApiClient({
      baseUrl: "https://streamed-invalid-503.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(oversizedChunk); },
        cancel() { oversizedCancelled = true; },
      }), { status: 503, headers: { "Content-Type": "application/json" } }),
    });
    await expect(streamedOversizedClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 3, retryBackoffMs: 0 }).next()).rejects.toMatchObject({
      code: "indeterminate", status: 502, retryable: false,
    });
    expect(oversizedCancelled).toBe(true);

    let nonJsonCancelled = false;
    const nonJsonClient = createT4ApiClient({
      baseUrl: "https://invalid-503-media.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024)); },
        cancel() { nonJsonCancelled = true; },
      }), { status: 503, headers: { "Content-Type": "text/plain" } }),
    });
    await expect(nonJsonClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 3, retryBackoffMs: 0 }).next()).rejects.toMatchObject({
      code: "indeterminate", status: 502, retryable: false,
    });
    expect(nonJsonCancelled).toBe(true);
  });

  it("rejects unknown fields in every public JSON response family", async () => {
    const discoveryService = new T4ApiV1ConformanceService({ invalidPayload: "discovery" });
    const discoveryClient = createT4ApiClient({ baseUrl: discoveryService.origin, credential: "token-a", majorVersion: 1, fetch: discoveryService.fetch });
    await expect(discoveryClient.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    const workspaceService = new T4ApiV1ConformanceService({ invalidPayload: "workspace" });
    const workspaceClient = createT4ApiClient({ baseUrl: workspaceService.origin, credential: "token-a", majorVersion: 1, fetch: workspaceService.fetch });
    await expect(workspaceClient.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("invalid-workspace-0001") },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    const sessionService = new T4ApiV1ConformanceService({ invalidPayload: "session" });
    const sessionClient = createT4ApiClient({ baseUrl: sessionService.origin, credential: "token-a", majorVersion: 1, fetch: sessionService.fetch });
    requireData(await sessionClient.http.POST("/v1/workspaces", {
      body: { name: "workspace" }, params: { header: idempotencyHeaders("invalid-session-work-01") },
    }));
    await expect(sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: "agent" }, params: { header: idempotencyHeaders("invalid-session-00001"), path: { workspaceId: "ws-1" } },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502 });

    const commandService = new T4ApiV1ConformanceService({ invalidPayload: "command" });
    const commandClient = await seededClient(commandService, "invalid-command");
    await expect(commandClient.http.POST("/v1/sessions/{sessionId}/commands", {
      body: { command: "ok", metadata: {} }, params: { header: idempotencyHeaders("invalid-command-0001"), path: { sessionId: "ses-1" } },
    })).rejects.toMatchObject({ code: "indeterminate", status: 502 });
  });

  it("requires declared selected-version and replay response headers", async () => {
    const discovery = DISCOVERY;
    for (const selectedVersion of [undefined, "1", "2.0", `1.${"0".repeat(15)}`]) {
      const client = createT4ApiClient({
        baseUrl: "https://response-version.test", credential: "token-a", majorVersion: 1,
        fetch: async () => Response.json(discovery, selectedVersion === undefined ? {} : { headers: { "T4-API-Version": selectedVersion } }),
      });
      await expect(client.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ status: 502, code: "indeterminate", retryable: false });
    }

    const unauthenticated = createT4ApiClient({
      baseUrl: "https://response-version.test", credential: "token-a", majorVersion: 1,
      fetch: async () => Response.json({ error: { code: "unauthenticated", message: "bad", requestId: "r", retryable: false } }, {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="t4"' },
      }),
    });
    expect((await unauthenticated.http.GET("/v1", { params: { header: VERSION_HEADERS } })).response.status).toBe(401);

    for (const challenge of [undefined, 'Basic realm="t4"']) {
      const invalidChallenge = createT4ApiClient({
        baseUrl: "https://response-version.test",
        credential: "token-a",
        majorVersion: 1,
        fetch: async () => Response.json(
          { error: { code: "unauthenticated", message: "bad", requestId: "r", retryable: false } },
          { status: 401, ...(challenge === undefined ? {} : { headers: { "WWW-Authenticate": challenge } }) },
        ),
      });
      await expect(invalidChallenge.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({
        status: 502, code: "indeterminate",
      });
    }

    const invalidUnauthenticated = createT4ApiClient({
      baseUrl: "https://response-version.test", credential: "token-a", majorVersion: 1,
      fetch: async () => Response.json(
        { error: { code: "unauthenticated", message: "bad", requestId: "r", retryable: false } },
        { status: 401, headers: { "T4-API-Version": "1.0" } },
      ),
    });
    await expect(invalidUnauthenticated.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({
      status: 502, code: "indeterminate",
    });

    const workspace = { id: "wsp-1", name: "workspace", state: "ready", revision: 1 };
    const missingReplay = createT4ApiClient({
      baseUrl: "https://response-replay.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse(workspace, { headers: { "T4-API-Version": "1.0" } }),
    });
    await expect(missingReplay.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "response-replay-patch"), path: { workspaceId: "wsp-1" } }, body: { name: "workspace" },
    })).rejects.toMatchObject({ status: 502, retryable: false });

    const missingEventCursor = createT4ApiClient({
      baseUrl: "https://response-event-cursor.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse(workspace, { headers: { "T4-API-Version": "1.0", "Idempotency-Replayed": "false" } }),
    });
    await expect(missingEventCursor.http.PATCH("/v1/workspaces/{workspaceId}", {
      params: { header: mutationHeaders(1, "response-event-cursor"), path: { workspaceId: "wsp-1" } }, body: { name: "workspace" },
    })).rejects.toMatchObject({ status: 502, retryable: false });

    for (const replayed of [undefined, "TRUE", "0"]) {
      const client = createT4ApiClient({
        baseUrl: "https://delete-replay-header.test", credential: "token-a", majorVersion: 1,
        fetch: async () => apiResponse(null, { status: 204, headers: {
          "T4-API-Version": "1.0", ...(replayed === undefined ? {} : { "Idempotency-Replayed": replayed }),
        } }),
      });
      await expect(client.http.DELETE("/v1/workspaces/{workspaceId}", {
        params: { header: idempotencyHeaders("response-delete-key"), path: { workspaceId: "wsp-1" } },
      })).rejects.toMatchObject({ status: 502, retryable: false });
    }

    const missingWatchVersion = createT4ApiClient({
      baseUrl: "https://watch-response-version.test", credential: "token-a", majorVersion: 1,
      fetch: async () => new Response('data: {"type":"heartbeat","cursor":"c1","observedAt":"2026-07-21T00:00:00Z"}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(missingWatchVersion.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({ status: 502, retryable: false });

    const missingWatchErrorVersion = createT4ApiClient({
      baseUrl: "https://watch-error-version.test", credential: "token-a", majorVersion: 1,
      fetch: async () => Response.json({ error: { code: "unavailable", message: "later", requestId: "r", retryable: true } }, { status: 503 }),
    });
    await expect(missingWatchErrorVersion.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 0, retryBackoffMs: 0 }).next()).rejects.toMatchObject({ status: 502, retryable: false });
  });

  it("aligns the snapshot aggregate schema bound with high-level response validation", async () => {
    const contract = JSON.parse(readFileSync(new URL("../../t4-api-contract/openapi.json", import.meta.url), "utf8")) as {
      components: { schemas: { SessionSnapshot: { "x-t4-maxUtf8Bytes"?: number } } };
    };
    expect(contract.components.schemas.SessionSnapshot["x-t4-maxUtf8Bytes"]).toBe(16 * 1024 * 1024);

    for (const boundary of ["exact", "over"] as const) {
      const service = new T4ApiV1ConformanceService({ snapshotBoundary: boundary });
      const client = await seededClient(service, `snapshot-${boundary}`);
      const response = client.http.GET("/v1/sessions/{sessionId}/snapshot", {
        params: { header: VERSION_HEADERS, path: { sessionId: "ses-1" } },
      });
      if (boundary === "exact") {
        const snapshot = requireData(await response);
        expect(snapshot.entries).toHaveLength(4);
        expect(snapshot.entries[0]?.text).toContain("💚");
      } else {
        await expect(response).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
      }
    }
  });

  it("rejects duplicate durable cursors within one SSE stream and after reconnect", async () => {
    const event = 'data: {"type":"session","cursor":"duplicate-1","state":"ready","revision":1}\n\n';
    for (const delivery of ["same-stream", "reconnect"] as const) {
      let attempts = 0;
      const client = createT4ApiClient({
        baseUrl: `https://duplicate-${delivery}.test`, credential: "token-a", majorVersion: 1,
        fetch: async () => {
          attempts += 1;
          return apiResponse(delivery === "same-stream" ? `${event}${event}` : event, { headers: { "Content-Type": "text/event-stream" } });
        },
      });
      const stream = client.watchSession("ses-1", { maxEvents: 2, maxReconnectAttempts: 1, retryBackoffMs: 0 });
      await expect(stream.next()).resolves.toMatchObject({ value: { cursor: "duplicate-1" }, done: false });
      await expect(stream.next()).rejects.toMatchObject({ code: "indeterminate", status: 502, retryable: false });
      expect(attempts).toBe(delivery === "same-stream" ? 1 : 2);
    }
  });

  it("accepts current-cursor heartbeats without allowing them to advance the durable cursor", async () => {
    const heartbeat = (cursor: string) => `data: ${JSON.stringify({ type: "heartbeat", cursor, observedAt: "2026-07-21T00:00:00Z" })}\n\n`;
    const startingRequests: Array<{ query: string | null; header: string | null }> = [];
    const starting = createT4ApiClient({
      baseUrl: "https://starting-heartbeat.test", credential: "token-a", majorVersion: 1,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        startingRequests.push({ query: new URL(request.url).searchParams.get("cursor"), header: request.headers.get("Last-Event-ID") });
        return apiResponse(heartbeat("duplicate-1"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    await expect(starting.watchSession("ses-1", { cursor: "duplicate-1", maxEvents: 1, maxReconnectAttempts: 0 }).next()).resolves.toMatchObject({
      value: { type: "heartbeat", cursor: "duplicate-1" }, done: false,
    });
    expect(startingRequests).toEqual([{ query: "duplicate-1", header: "duplicate-1" }]);

    const reconnectRequests: Array<{ query: string | null; header: string | null }> = [];
    const reconnecting = createT4ApiClient({
      baseUrl: "https://reconnect-heartbeat.test", credential: "token-a", majorVersion: 1,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        reconnectRequests.push({ query: new URL(request.url).searchParams.get("cursor"), header: request.headers.get("Last-Event-ID") });
        return apiResponse(heartbeat("duplicate-1"), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const liveness: WatchEvent[] = [];
    for await (const event of reconnecting.watchSession("ses-1", { maxEvents: 2, maxReconnectAttempts: 1, retryBackoffMs: 0 })) liveness.push(event);
    expect(liveness.map((event) => event.cursor)).toEqual(["duplicate-1", "duplicate-1"]);
    expect(reconnectRequests).toEqual([{ query: null, header: null }, { query: "duplicate-1", header: "duplicate-1" }]);

    const advancing = createT4ApiClient({
      baseUrl: "https://advancing-heartbeat.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(heartbeat("different-2"), { headers: { "Content-Type": "text/event-stream" } }),
    });
    await expect(advancing.watchSession("ses-1", { cursor: "duplicate-1", maxEvents: 1, maxReconnectAttempts: 0 }).next()).rejects.toMatchObject({
      code: "indeterminate", status: 502, retryable: false,
    });
  });

  it("rejects duplicate version entries and malformed capability maps", async () => {
    const status = { supported: true, enabled: true, authorized: true, available: true };
    for (const discovery of [
      { ...DISCOVERY, supportedMajors: [1, 1] },
      { ...DISCOVERY, capabilities: { Invalid: status } },
      { ...DISCOVERY, capabilities: { "session.watch.sse": { ...status, unknown: true } } },
    ]) {
      const client = createT4ApiClient({
        baseUrl: "https://invalid-discovery.test", credential: "token-a", majorVersion: 1,
        fetch: async () => jsonResponse(discovery, { headers: { "T4-API-Version": "1.0" } }),
      });
      await expect(client.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ status: 502, retryable: false });
    }
    const duplicateError = createT4ApiClient({
      baseUrl: "https://duplicate-error.test", credential: "token-a", majorVersion: 1,
      fetch: async () => jsonResponse({ error: {
        code: "incompatible_version", message: "bad", requestId: "r", retryable: false, supportedMajors: [1, 1],
      } }, { status: 406, headers: { "T4-API-Version": "1.0" } }),
    });
    await expect(duplicateError.http.GET("/v1", { params: { header: VERSION_HEADERS } })).rejects.toMatchObject({ status: 502, code: "indeterminate", retryable: false });
  });

  it("discards unterminated SSE data at EOF before reconnecting", async () => {
    for (const unterminated of [
      'data: {"type":"heartbeat","cursor":"unterminated","observedAt":"2026-07-21T00:00:00Z"}',
      "data: {not-json",
    ]) {
      let attempts = 0;
      const client = createT4ApiClient({
        baseUrl: "https://unterminated-sse.test", credential: "token-a", majorVersion: 1,
        fetch: async () => {
          attempts += 1;
          const body = attempts === 1
            ? unterminated
            : 'data: {"type":"heartbeat","cursor":"complete","observedAt":"2026-07-21T00:00:00Z"}\n\n';
          return apiResponse(body, { headers: { "Content-Type": "text/event-stream", "T4-API-Version": "1.0" } });
        },
      });
      await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 1, retryBackoffMs: 0 }).next()).resolves.toMatchObject({ value: { cursor: "complete" } });
      expect(attempts).toBe(2);
    }
  });

  it("accepts exact code-point request lengths and rejects one more", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    const exact = "😀".repeat(128);
    const workspace = await client.http.POST("/v1/workspaces", {
      body: { name: exact }, params: { header: idempotencyHeaders("unicode-workspace-exact") },
    });
    expect(workspace.response.status).toBe(202);
    expect((await client.http.POST("/v1/workspaces", {
      body: { name: `${exact}😀` }, params: { header: idempotencyHeaders("unicode-workspace-over") },
    })).response.status).toBe(422);
    const session = await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: exact }, params: { header: idempotencyHeaders("unicode-session-exact"), path: { workspaceId: requireData(workspace).id } },
    });
    expect(session.response.status).toBe(202);
    expect((await client.http.POST("/v1/workspaces/{workspaceId}/sessions", {
      body: { title: `${exact}😀` }, params: { header: idempotencyHeaders("unicode-session-over"), path: { workspaceId: requireData(workspace).id } },
    })).response.status).toBe(422);
  });

  it("fails terminally and cancels an invalid UTF-8 SSE body", async () => {
    let cancelled = false;
    const client = createT4ApiClient({
      baseUrl: "https://invalid-utf8-sse.test", credential: "token-a", majorVersion: 1,
      fetch: async () => apiResponse(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([100, 97, 116, 97, 58, 32, 195, 40, 10, 10])); },
        cancel() { cancelled = true; },
      }), { headers: { "Content-Type": "text/event-stream", "T4-API-Version": "1.0" } }),
    });
    await expect(client.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 3 }).next()).rejects.toMatchObject({ status: 502, code: "indeterminate", retryable: false });
    expect(cancelled).toBe(true);
  });

  it("scopes one DELETE key independently by live target ID", async () => {
    const service = new T4ApiV1ConformanceService();
    const client = createT4ApiClient({ baseUrl: service.origin, credential: "token-a", majorVersion: 1, fetch: service.fetch });
    for (const [key, name] of [["delete-target-workspace-a", "first"], ["delete-target-workspace-b", "second"]] as const) {
      requireData(await client.http.POST("/v1/workspaces", { body: { name }, params: { header: idempotencyHeaders(key) } }));
    }
    for (const workspaceId of ["ws-1", "ws-2"] as const) {
      expect((await client.http.DELETE("/v1/workspaces/{workspaceId}", {
        params: { header: idempotencyHeaders("delete-shared-workspace"), path: { workspaceId } },
      })).response.status).toBe(204);
    }

    const sessionService = new T4ApiV1ConformanceService();
    const sessionClient = createT4ApiClient({ baseUrl: sessionService.origin, credential: "token-a", majorVersion: 1, fetch: sessionService.fetch });
    requireData(await sessionClient.http.POST("/v1/workspaces", { body: { name: "workspace" }, params: { header: idempotencyHeaders("delete-session-workspace") } }));
    for (const [key, title] of [["delete-target-session-a", "first"], ["delete-target-session-b", "second"]] as const) {
      requireData(await sessionClient.http.POST("/v1/workspaces/{workspaceId}/sessions", {
        body: { title }, params: { header: idempotencyHeaders(key), path: { workspaceId: "ws-1" } },
      }));
    }
    for (const sessionId of ["ses-1", "ses-2"] as const) {
      expect((await sessionClient.http.DELETE("/v1/sessions/{sessionId}", {
        params: { header: idempotencyHeaders("delete-shared-session"), path: { sessionId } },
      })).response.status).toBe(204);
    }
  });

  it("bounds automatic EOF retry and supports explicit abort", async () => {
    let attempts = 0;
    const eofFetch: typeof globalThis.fetch = async () => {
      attempts += 1;
      return apiResponse(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    };
    const eofClient = createT4ApiClient({ baseUrl: "https://eof.test", credential: "token-a", majorVersion: 1, fetch: eofFetch });
    await expect(eofClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 2, retryBackoffMs: 0 }).next()).rejects.toMatchObject({ code: "indeterminate", status: 502 });
    expect(attempts).toBe(3);

    const reconnectHeaders: Array<string | null> = [];
    let networkAttempt = 0;
    const networkFetch: typeof globalThis.fetch = async (_input, init) => {
      reconnectHeaders.push(new Headers(init?.headers).get("Last-Event-ID"));
      networkAttempt += 1;
      if (networkAttempt === 1) {
        let sent = false;
        return apiResponse(new ReadableStream<Uint8Array>({
          pull(stream) {
            if (sent) stream.error(new TypeError("transient network loss"));
            else {
              sent = true;
              stream.enqueue(new TextEncoder().encode('data: {"type":"heartbeat","cursor":"network-1","observedAt":"2026-07-21T00:00:00Z"}\n\n'));
            }
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      return apiResponse('data: {"type":"session","cursor":"network-2","state":"ready","revision":2}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const networkClient = createT4ApiClient({ baseUrl: "https://network.test", credential: "token-a", majorVersion: 1, fetch: networkFetch });
    const networkEvents: WatchEvent[] = [];
    for await (const event of networkClient.watchSession("ses-1", { maxEvents: 2, maxReconnectAttempts: 1, retryBackoffMs: 0 })) networkEvents.push(event);
    expect(networkEvents.map((event) => event.cursor)).toEqual(["network-1", "network-2"]);
    expect(reconnectHeaders).toEqual([null, "network-1"]);

    let retryableAttempts = 0;
    const retryableFetch: typeof globalThis.fetch = async () => {
      retryableAttempts += 1;
      if (retryableAttempts === 1) return jsonResponse({ error: { code: "unavailable", message: "retry", requestId: "r", retryable: true } }, { status: 503, headers: { "Retry-After": "0" } });
      return apiResponse('data: {"type":"heartbeat","cursor":"retry-1","observedAt":"2026-07-21T00:00:00Z"}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    };
    const retryableClient = createT4ApiClient({ baseUrl: "https://retryable.test", credential: "token-a", majorVersion: 1, fetch: retryableFetch });
    expect((await retryableClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 1, retryBackoffMs: 0 }).next()).value).toMatchObject({ cursor: "retry-1" });
    expect(retryableAttempts).toBe(2);

    let progressAttempts = 0;
    const progressFetch: typeof globalThis.fetch = async () => {
      progressAttempts += 1;
      if (progressAttempts === 2 || progressAttempts === 4) {
        const cursor = progressAttempts === 2 ? "progress-1" : "progress-2";
        return apiResponse(`data: {"type":"session","cursor":"${cursor}","state":"ready","revision":${progressAttempts / 2}}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
      }
      return apiResponse(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
    };
    const progressClient = createT4ApiClient({ baseUrl: "https://progress.test", credential: "token-a", majorVersion: 1, fetch: progressFetch });
    const progressEvents: WatchEvent[] = [];
    for await (const event of progressClient.watchSession("ses-1", { maxEvents: 2, maxReconnectAttempts: 1, retryBackoffMs: 0 })) progressEvents.push(event);
    expect(progressEvents.map((event) => event.cursor)).toEqual(["progress-1", "progress-2"]);
    expect(progressAttempts).toBe(4);

    vi.useFakeTimers();
    try {
      const retryAfterController = new AbortController();
      let retryAfterAttempts = 0;
      const retryAfterFetch: typeof globalThis.fetch = async () => {
        retryAfterAttempts += 1;
        return jsonResponse({ error: { code: "unavailable", message: "later", requestId: "r", retryable: true } }, { status: 503, headers: { "Retry-After": "30" } });
      };
      const retryAfterClient = createT4ApiClient({ baseUrl: "https://retry-after.test", credential: "token-a", majorVersion: 1, fetch: retryAfterFetch });
      const retryAfterPending = retryAfterClient.watchSession("ses-1", { maxEvents: 1, maxReconnectAttempts: 2, retryBackoffMs: 0, signal: retryAfterController.signal }).next();
      const retryAfterAssertion = expect(retryAfterPending).resolves.toMatchObject({ done: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(retryAfterAttempts).toBe(1);
      retryAfterController.abort();
      await retryAfterAssertion;
    } finally {
      vi.useRealTimers();
    }

    const controller = new AbortController();
    const abortFetch: typeof globalThis.fetch = async (_input, init) => apiResponse(new ReadableStream<Uint8Array>({
      start(stream) { init?.signal?.addEventListener("abort", () => stream.close(), { once: true }); },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const abortClient = createT4ApiClient({ baseUrl: "https://abort.test", credential: "token-a", majorVersion: 1, fetch: abortFetch });
    const pending = abortClient.watchSession("ses-1", { signal: controller.signal }).next();
    controller.abort("done");
    await expect(pending).resolves.toMatchObject({ done: true });
  });
});
