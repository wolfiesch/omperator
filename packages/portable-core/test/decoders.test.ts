import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  PortableDecodeError,
  decodeCapabilities,
  decodeCondition,
  decodeGeneration,
  decodeProblemDetails,
  decodePageCursor,
  decodeRevision,
  decodeRuntime,
  decodeRuntimeCreate,
  decodeRuntimePage,
  decodeRuntimePatch,
  decodeScopePage,
  decodeTimestamp,
  decodeWorkspace,
  decodeWorkspaceCreate,
  decodeWorkspacePage,
  decodeWorkspacePatch,
  type Decoder,
} from "../src/index.ts";

interface ExampleSchema {
  readonly examples?: readonly unknown[];
}

interface OpenApiFixture {
  readonly components: {
    readonly schemas: Readonly<Record<string, ExampleSchema>>;
    readonly requestBodies: Readonly<Record<string, {
      readonly content: Readonly<Record<string, { readonly example?: unknown }>>;
    }>>;
  };
}

const openapi = JSON.parse(readFileSync(new URL("../../t4-api-contract/openapi.json", import.meta.url), "utf8")) as OpenApiFixture;
const schemaDecoders: Readonly<Record<string, Decoder<unknown>>> = {
  Capabilities: decodeCapabilities,
  Workspace: decodeWorkspace,
  WorkspaceCreate: decodeWorkspaceCreate,
  WorkspacePatch: decodeWorkspacePatch,
  Runtime: decodeRuntime,
  RuntimeCreate: decodeRuntimeCreate,
  RuntimePatch: decodeRuntimePatch,
  Problem: decodeProblemDetails,
};

function schemaExample(name: string): Record<string, unknown> {
  const example = openapi.components.schemas[name]?.examples?.[0];
  if (example === null || typeof example !== "object" || Array.isArray(example)) throw new TypeError(`missing ${name} example`);
  return structuredClone(example) as Record<string, unknown>;
}

function rejectsAt(decoder: Decoder<unknown>, value: unknown, path: readonly (string | number)[]): void {
  try {
    decoder(value);
    throw new Error("decoder unexpectedly accepted fixture");
  } catch (error) {
    expect(error).toBeInstanceOf(PortableDecodeError);
    expect((error as PortableDecodeError).path).toEqual(path);
  }
}

describe("OpenAPI examples", () => {
  it("decodes every example on a portable-core-owned schema without copying it", () => {
    for (const [name, decoder] of Object.entries(schemaDecoders)) {
      const examples = openapi.components.schemas[name]?.examples ?? [];
      expect(examples.length, `${name} must retain an executable example`).toBeGreaterThan(0);
      for (const example of examples) expect(decoder(example)).toBe(example);
    }
  });

  it("decodes every corresponding request-body example", () => {
    for (const name of ["WorkspaceCreate", "WorkspacePatch", "RuntimeCreate", "RuntimePatch"] as const) {
      const body = openapi.components.requestBodies[name];
      const examples = Object.values(body!.content).flatMap((media) => media.example === undefined ? [] : [media.example]);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) expect(schemaDecoders[name]!(example)).toBe(example);
    }
  });
});

describe("additive response decoding", () => {
  it("retains top-level and nested response extensions while validating known fields", () => {
    const workspace = schemaExample("Workspace");
    workspace.future = { enabled: true };
    const conditions = workspace.conditions as Array<Record<string, unknown>>;
    conditions[0]!.futureReason = "provider-specific";
    expect(decodeWorkspace(workspace)).toBe(workspace);
    expect(decodeWorkspace(workspace).future).toEqual({ enabled: true });
    expect(decodeWorkspace(workspace).conditions[0]!.futureReason).toBe("provider-specific");

    const capabilities = schemaExample("Capabilities");
    capabilities.future = true;
    (capabilities.protocols as Record<string, unknown>).futureProtocol = { versions: [2] };
    ((capabilities.limits as Record<string, unknown>)).futureLimit = 3;
    ((capabilities.features as Record<string, unknown>)).futureFeature = false;
    expect(decodeCapabilities(capabilities)).toBe(capabilities);
  });

  it("rejects an invalid known field even when extensions are present", () => {
    const runtime = schemaExample("Runtime");
    runtime.future = "retained";
    runtime.phase = "UnknownFuturePhase";
    rejectsAt(decodeRuntime, runtime, ["phase"]);
  });

  it("preserves additive page fields and validates every item", () => {
    const workspace = schemaExample("Workspace");
    const page = { items: [workspace], nextCursor: "next_1==", totalEstimate: 42 };
    expect(decodeWorkspacePage(page)).toBe(page);

    const runtimePage = { items: [schemaExample("Runtime")] };
    const cursor = { nextCursor: "opaque_2=", future: true };
    expect(decodePageCursor(cursor)).toBe(cursor);
    rejectsAt(decodePageCursor, { nextCursor: "not/a/cursor" }, ["nextCursor"]);
    expect(decodeRuntimePage(runtimePage)).toBe(runtimePage);
    (workspace.conditions as unknown[]).push({});
    rejectsAt(decodeWorkspacePage, page, ["items", 0, "conditions", 1, "type"]);
  });
});

describe("closed request decoding", () => {
  it("rejects unknown keys and empty patches", () => {
    rejectsAt(decodeWorkspaceCreate, { ...schemaExample("WorkspaceCreate"), future: true }, ["future"]);
    rejectsAt(decodeRuntimeCreate, { ...schemaExample("RuntimeCreate"), future: true }, ["future"]);
    rejectsAt(decodeWorkspacePatch, {}, []);
    rejectsAt(decodeRuntimePatch, {}, []);
  });

  it("enforces both exact IdlePolicy variants", () => {
    const runtime = schemaExample("RuntimeCreate");
    runtime.idlePolicy = { enabled: false, idleSeconds: 60 };
    rejectsAt(decodeRuntimeCreate, runtime, ["idlePolicy", "idleSeconds"]);

    runtime.idlePolicy = { enabled: true };
    rejectsAt(decodeRuntimeCreate, runtime, ["idlePolicy", "idleSeconds"]);

    runtime.idlePolicy = { enabled: true, idleSeconds: 59 };
    rejectsAt(decodeRuntimeCreate, runtime, ["idlePolicy", "idleSeconds"]);

    runtime.idlePolicy = { enabled: true, idleSeconds: 2_592_000 };
    expect(decodeRuntimeCreate(runtime)).toBe(runtime);
  });
});

describe("schema bounds", () => {
  it("enforces identifier, revision, generation, code, message, and enum bounds", () => {
    rejectsAt(decodeRevision, "bad revision", []);
    rejectsAt(decodeRevision, `r${"x".repeat(128)}`, []);
    rejectsAt(decodeGeneration, `g${"x".repeat(64)}`, []);

    const create = schemaExample("WorkspaceCreate");
    create.displayName = "😀".repeat(128);
    expect(decodeWorkspaceCreate(create)).toBe(create);
    create.displayName = "😀".repeat(129);
    rejectsAt(decodeWorkspaceCreate, create, ["displayName"]);
    rejectsAt(decodeCondition, {
      type: "1invalid",
      status: "True",
      reason: "Ready",
      lastTransitionTime: "2026-07-28T12:00:00Z",
    }, ["type"]);
    rejectsAt(decodeCondition, {
      type: "Ready",
      status: "true",
      reason: "Ready",
      lastTransitionTime: "2026-07-28T12:00:00Z",
    }, ["status"]);
    rejectsAt(decodeCondition, {
      type: "Ready",
      status: "True",
      reason: "Ready",
      message: "",
      lastTransitionTime: "2026-07-28T12:00:00Z",
    }, ["message"]);
  });

  it("rejects over-cardinality and duplicate unique arrays", () => {
    const runtime = schemaExample("Runtime");
    runtime.capabilities = Array.from({ length: 65 }, (_, index) => `capability-${index}`);
    rejectsAt(decodeRuntime, runtime, ["capabilities"]);

    runtime.capabilities = ["cmux", "cmux"];
    rejectsAt(decodeRuntime, runtime, ["capabilities", 1]);

    const capabilities = schemaExample("Capabilities");
    ((capabilities.protocols as Record<string, unknown>).machineProvider as Record<string, unknown>).capabilities = ["lifecycle", "lifecycle"];
    rejectsAt(decodeCapabilities, capabilities, ["protocols", "machineProvider", "capabilities", 1]);

    const page = { items: Array.from({ length: 201 }, () => ({ id: "scope", displayName: "scope", kind: "Personal", revision: "r1" })) };
    rejectsAt(decodeScopePage, page, ["items"]);
  });

  it("rejects sparse arrays at the missing item path", () => {
    const sparseItems: unknown[] = [];
    sparseItems.length = 1;
    rejectsAt(decodeScopePage, { items: sparseItems }, ["items", 0]);

    const workspace = schemaExample("Workspace");
    workspace.conditions = sparseItems;
    rejectsAt(decodeWorkspace, workspace, ["conditions", 0]);

    const runtime = schemaExample("Runtime");
    runtime.capabilities = sparseItems;
    rejectsAt(decodeRuntime, runtime, ["capabilities", 0]);
  });

  it("rejects unsafe and out-of-range integers", () => {
    const workspace = schemaExample("Workspace");
    workspace.capacityBytes = Number.MAX_SAFE_INTEGER + 1;
    rejectsAt(decodeWorkspace, workspace, ["capacityBytes"]);

    workspace.capacityBytes = 1_048_575;
    rejectsAt(decodeWorkspace, workspace, ["capacityBytes"]);

    const capabilities = schemaExample("Capabilities");
    (capabilities.limits as Record<string, unknown>).maxPageSize = 1.5;
    rejectsAt(decodeCapabilities, capabilities, ["limits", "maxPageSize"]);
  });

  it("accepts calendar-valid RFC3339 timestamps and rejects impossible dates or leap seconds", () => {
    expect(decodeTimestamp("2016-12-31T23:59:60Z")).toBe("2016-12-31T23:59:60Z");
    expect(decodeTimestamp("2017-01-01T00:59:60+01:00")).toBe("2017-01-01T00:59:60+01:00");
    rejectsAt(decodeTimestamp, "2016-12-31T22:59:60Z", []);
    rejectsAt(decodeTimestamp, "2015-12-31T23:59:60Z", []);
    rejectsAt(decodeTimestamp, "2023-02-29T12:00:00Z", []);
    rejectsAt(decodeTimestamp, "2026-04-31T12:00:00Z", []);
    rejectsAt(decodeTimestamp, "2026-01-01T24:00:00Z", []);
    rejectsAt(decodeTimestamp, "2026-01-01", []);
  });
});

describe("RFC 9457 Problem Details", () => {
  it("retains extension members and enforces known members", () => {
    const problem = schemaExample("Problem");
    problem.providerHint = { opaque: true };
    expect(decodeProblemDetails(problem)).toBe(problem);

    problem.status = 600;
    rejectsAt(decodeProblemDetails, problem, ["status"]);
  });

  it("validates URI, URI-reference, code, revision, and integer members", () => {
    const problem = schemaExample("Problem");
    problem.type = "/relative-type";
    rejectsAt(decodeProblemDetails, problem, ["type"]);

    problem.type = "https://omperator.dev/problems/example";
    problem.instance = "bad instance";
    rejectsAt(decodeProblemDetails, problem, ["instance"]);

    problem.instance = "/requests/1";
    problem.code = "Invalid-Code";
    rejectsAt(decodeProblemDetails, problem, ["code"]);

    problem.code = "invalid_code";
    problem.retryAfterMs = Number.MAX_SAFE_INTEGER + 1;
    rejectsAt(decodeProblemDetails, problem, ["retryAfterMs"]);
  });
});
