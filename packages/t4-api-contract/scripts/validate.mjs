import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileErrors, validate } from "@readme/openapi-parser";

const source = new URL("../openapi.json", import.meta.url);
const document = JSON.parse(await readFile(source, "utf8"));
const validation = await validate(fileURLToPath(source));
if (!validation.valid || validation.warnings.length > 0) throw new Error(compileErrors(validation));

const fail = (message) => {
  throw new Error(`Portable Agent Platform v1 contract: ${message}`);
};
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const resolveRef = (value) => {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith("#/")) fail(`external reference is not permitted: ${value.$ref}`);
  return value.$ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((current, part) => current?.[part], document);
};
const operationParameters = (pathItem, operation) => [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map(resolveRef);
const requireHeaderParameter = (pathItem, operation, name) => {
  const parameter = operationParameters(pathItem, operation).find((candidate) => candidate?.in === "header" && candidate?.name.toLowerCase() === name.toLowerCase());
  if (!parameter?.required) fail(`${operation.operationId} must require ${name}`);
  return parameter;
};
const responseObject = (operation, status) => resolveRef(operation.responses?.[status]);
const headerObject = (response, name) => resolveRef(response?.headers?.[name]);

if (document.openapi !== "3.1.0") fail("OpenAPI version must be exactly 3.1.0");
if (!Array.isArray(document.servers) || document.servers.length === 0) fail("at least one server is required");
for (const server of document.servers) {
  if (new URL(server.url).protocol !== "https:") fail("server URLs must use HTTPS");
}
if (!same(document.security, [{ BearerAuth: [] }])) fail("bearer authentication must be the document default");
const bearer = document.components?.securitySchemes?.BearerAuth;
if (bearer?.type !== "http" || bearer?.scheme !== "bearer") fail("BearerAuth must be an HTTP bearer scheme");

const requiredSurface = {
  "/.well-known/omperator": ["get"],
  "/v1/version": ["get"],
  "/v1/capabilities": ["get"],
  "/v1/scopes": ["get"],
  "/v1/workspaces": ["get"],
  "/v1/workspaces/{workspaceId}": ["delete", "get", "patch", "put"],
  "/v1/runtimes": ["get"],
  "/v1/runtimes/{runtimeId}": ["delete", "get", "patch", "put"],
  "/v1/runtimes/{runtimeId}:wake": ["post"],
  "/v1/runtimes/{runtimeId}:sleep": ["post"],
  "/v1/runtimes/{runtimeId}/connections": ["get"],
  "/v1/events": ["get"]
};
if (!same(Object.keys(document.paths ?? {}).sort(), Object.keys(requiredSurface).sort())) fail("path set differs from the normative lifecycle/discovery surface");
const httpMethods = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);
for (const [path, expectedMethods] of Object.entries(requiredSurface)) {
  const actualMethods = Object.keys(document.paths[path]).filter((key) => httpMethods.has(key)).sort();
  if (!same(actualMethods, expectedMethods)) fail(`${path} has methods ${actualMethods.join(",")}, expected ${expectedMethods.join(",")}`);
}

for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const method of requiredSurface[path]) {
    const operation = pathItem[method];
    if (!operation.operationId || !operation.responses) fail(`${method.toUpperCase()} ${path} requires an operationId and responses`);
    const effectiveSecurity = operation.security ?? document.security;
    if (path === "/.well-known/omperator") {
      if (!same(effectiveSecurity, [])) fail("service discovery must be unauthenticated");
    } else if (!same(effectiveSecurity, [{ BearerAuth: [] }])) {
      fail(`${operation.operationId} must inherit or declare bearer authentication`);
    }
  }
}

for (const path of ["/v1/workspaces/{workspaceId}", "/v1/runtimes/{runtimeId}"]) {
  const pathItem = document.paths[path];
  const createPrecondition = requireHeaderParameter(pathItem, pathItem.put, "If-None-Match");
  if (createPrecondition.schema?.const !== "*") fail(`${pathItem.put.operationId} must require If-None-Match: *`);
  requireHeaderParameter(pathItem, pathItem.patch, "If-Match");
  requireHeaderParameter(pathItem, pathItem.delete, "If-Match");
}
for (const path of ["/v1/runtimes/{runtimeId}:wake", "/v1/runtimes/{runtimeId}:sleep"]) {
  const pathItem = document.paths[path];
  requireHeaderParameter(pathItem, pathItem.post, "If-Match");
  const key = requireHeaderParameter(pathItem, pathItem.post, "Idempotency-Key");
  if (key.schema?.minLength < 16 || key.schema?.maxLength > 128 || !key.schema?.pattern) fail(`${pathItem.post.operationId} requires a bounded opaque idempotency key`);
  if (pathItem.post.requestBody !== undefined) fail(`${pathItem.post.operationId} must not accept a request body`);
}
const entityTag = document.components.schemas.EntityTag;
const strongEntityTagPattern = "^\"[A-Za-z0-9][A-Za-z0-9:._~-]{0,127}\"$";
if (entityTag?.type !== "string" || entityTag?.minLength !== 3 || entityTag?.maxLength !== 130 || entityTag?.pattern !== strongEntityTagPattern) {
  fail("EntityTag must be a bounded strong quoted validator and must reject W/ weak tags");
}

const requestContracts = new Map([
  ["putWorkspace", ["application/json", "WorkspaceCreate"]],
  ["patchWorkspace", ["application/merge-patch+json", "WorkspacePatch"]],
  ["putRuntime", ["application/json", "RuntimeCreate"]],
  ["patchRuntime", ["application/merge-patch+json", "RuntimePatch"]]
]);
for (const pathItem of Object.values(document.paths)) {
  for (const method of Object.keys(pathItem).filter((key) => httpMethods.has(key))) {
    const operation = pathItem[method];
    const expected = requestContracts.get(operation.operationId);
    if (!expected) {
      if (operation.requestBody !== undefined) fail(`${operation.operationId} accepts a non-normative request body`);
      continue;
    }
    const requestBody = resolveRef(operation.requestBody);
    if (!requestBody?.required) fail(`${operation.operationId} request body must be required`);
    if (!same(Object.keys(requestBody.content ?? {}), [expected[0]])) fail(`${operation.operationId} must accept only ${expected[0]}`);
    const schema = resolveRef(requestBody.content[expected[0]].schema);
    if (schema !== document.components.schemas[expected[1]]) fail(`${operation.operationId} must use ${expected[1]}`);
  }
}

const requestFields = {
  WorkspaceCreate: ["capacityBytes", "displayName", "retention", "scopeId"],
  WorkspacePatch: ["displayName", "retention"],
  RuntimeCreate: ["browserPolicy", "desiredState", "displayName", "hostProfileId", "idlePolicy", "scopeId", "workspaceId"],
  RuntimePatch: ["browserPolicy", "desiredState", "displayName", "idlePolicy"]
};
const inspected = new Set();
const inspectBoundedRequestSchema = (schema, location) => {
  const resolved = resolveRef(schema);
  if (!resolved || inspected.has(resolved)) return;
  inspected.add(resolved);
  if (resolved.type === "object") {
    if (resolved.additionalProperties !== false) fail(`${location} must reject unknown fields`);
    for (const [name, property] of Object.entries(resolved.properties ?? {})) inspectBoundedRequestSchema(property, `${location}.${name}`);
    return;
  }
  if (resolved.type === "array") {
    if (!Number.isInteger(resolved.maxItems)) fail(`${location} array must have maxItems`);
    inspectBoundedRequestSchema(resolved.items, `${location}[]`);
    return;
  }
  if (resolved.type === "string" && (!Number.isInteger(resolved.maxLength) || resolved.maxLength < 1)) fail(`${location} string must have maxLength`);
  if ((resolved.type === "integer" || resolved.type === "number") && (!Number.isFinite(resolved.minimum) || !Number.isFinite(resolved.maximum))) fail(`${location} number must have minimum and maximum`);
};
for (const [name, allowedFields] of Object.entries(requestFields)) {
  const schema = document.components.schemas[name];
  if (!schema || !same(Object.keys(schema.properties ?? {}).sort(), allowedFields)) fail(`${name} has a non-normative field set`);
  inspectBoundedRequestSchema(schema, name);
}

const lifecycleResponseNames = new Set(["WorkspaceResponse", "WorkspaceCreatedResponse", "WorkspaceAcceptedResponse", "RuntimeResponse", "RuntimeCreatedResponse", "RuntimeAcceptedResponse"]);
for (const [name, unresolvedResponse] of Object.entries(document.components.responses ?? {})) {
  const response = resolveRef(unresolvedResponse);
  if (name.endsWith("Response") && (name === "ProblemResponse" || name === "UnauthorizedResponse")) {
    if (!same(Object.keys(response.content ?? {}), ["application/problem+json"])) fail(`${name} must use only application/problem+json`);
  }
  if (lifecycleResponseNames.has(name)) {
    if (!same(Object.keys(response.content ?? {}), ["application/json"])) fail(`${name} must use only application/json`);
    if (!headerObject(response, "ETag")?.required) fail(`${name} must require ETag`);
  }
  if (name.endsWith("CreatedResponse") && !headerObject(response, "Location")?.required) fail(`${name} must require Location`);
  if (name.endsWith("AcceptedResponse")) {
    if (!headerObject(response, "Location")?.required) fail(`${name} must require Location`);
    const retryAfter = headerObject(response, "Retry-After");
    if (!retryAfter || retryAfter.required === true) fail(`${name} must declare optional Retry-After`);
  }
}
for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const method of requiredSurface[path]) {
    const operation = pathItem[method];
    for (const [status, unresolvedResponse] of Object.entries(operation.responses)) {
      const response = resolveRef(unresolvedResponse);
      if (status.startsWith("4") || status.startsWith("5")) {
        if (!same(Object.keys(response?.content ?? {}), ["application/problem+json"])) fail(`${operation.operationId} ${status} must use application/problem+json`);
        if (status === "401" && headerObject(response, "WWW-Authenticate")?.schema?.const !== "Bearer") fail(`${operation.operationId} 401 must require the bearer challenge`);
        continue;
      }
      if (!status.startsWith("2")) continue;
      if (status === "204") {
        if (own(response, "content")) fail(`${operation.operationId} 204 must not contain a body`);
        continue;
      }
      const expectedMedia = path === "/v1/events" ? "text/event-stream" : "application/json";
      if (!same(Object.keys(response?.content ?? {}), [expectedMedia])) fail(`${operation.operationId} ${status} must use only ${expectedMedia}`);
      if (!response.content[expectedMedia]?.schema) fail(`${operation.operationId} ${status} must link a response schema`);
      const schemaRef = response.content[expectedMedia].schema.$ref;
      if (schemaRef === "#/components/schemas/Workspace" || schemaRef === "#/components/schemas/Runtime" || schemaRef === "#/components/schemas/ConnectionDescriptor") {
        if (!headerObject(response, "ETag")?.required) fail(`${operation.operationId} ${status} must require ETag`);
      }
      if (status === "201" || status === "202") {
        if (!headerObject(response, "Location")?.required) fail(`${operation.operationId} ${status} must require Location`);
      }
      if (status === "202") {
        const retryAfter = headerObject(response, "Retry-After");
        if (!retryAfter || retryAfter.required === true) fail(`${operation.operationId} 202 must declare optional Retry-After`);
      }
    }
  }
}

const eventOperation = document.paths["/v1/events"].get;
const eventParameters = operationParameters(document.paths["/v1/events"], eventOperation);
if (!eventParameters.some((parameter) => parameter?.in === "header" && parameter?.name === "Last-Event-ID")) fail("event stream must declare Last-Event-ID");
const eventResponse = responseObject(eventOperation, "200");
if (!same(Object.keys(eventResponse.content ?? {}), ["text/event-stream"])) fail("event stream must use only text/event-stream");
if (headerObject(eventResponse, "Cache-Control")?.schema?.const !== "no-store") fail("event stream must require Cache-Control: no-store");
const eventLinkage = eventResponse.content["text/event-stream"].schema?.["x-omperator-sse-events"];
if (!same(eventLinkage, { invalidation: "#/components/schemas/InvalidationEvent", reset: "#/components/schemas/ResetEvent" })) fail("event stream must link invalidation and reset payload schemas");
const invalidation = document.components.schemas.InvalidationEvent;
const reset = document.components.schemas.ResetEvent;
if (invalidation?.additionalProperties !== false || reset?.additionalProperties !== false) fail("SSE payloads must reject unbounded fields");
if (!same(invalidation?.required, ["eventId", "event", "resourceKind", "resourceId", "scopeId", "revision", "phase", "timestamp"])) fail("invalidation payload must contain only lifecycle identity and status linkage");
if (invalidation?.properties?.event?.const !== "invalidation" || reset?.properties?.event?.const !== "reset" || reset?.properties?.reason?.const !== "cursor_expired") fail("SSE event constants are invalid");

const routeExpectations = {
  MachineProviderSshRoute: ["machine-provider-ssh", "providerVersion", 1],
  OmpAppWebSocketRoute: ["omp-app-websocket", "protocol", "omp-app/1"],
  CmuxWebSocketRoute: ["cmux-websocket", "protocol", 10]
};
const route = document.components.schemas.ConnectionRoute;
if (route?.discriminator?.propertyName !== "kind") fail("connection routes must discriminate on kind");
if (!same(Object.keys(route.discriminator.mapping ?? {}).sort(), Object.values(routeExpectations).map(([kind]) => kind).sort())) fail("connection route discriminator must contain exactly the supported routes");
if (route.oneOf?.length !== 3) fail("connection routes must contain exactly three supported variants");
for (const [schemaName, [kind, protocolField, protocolValue]] of Object.entries(routeExpectations)) {
  const schema = document.components.schemas[schemaName];
  if (schema?.properties?.kind?.const !== kind || schema?.properties?.[protocolField]?.const !== protocolValue) fail(`${schemaName} protocol constants are invalid`);
  if (route.discriminator.mapping[kind] !== `#/components/schemas/${schemaName}` || !route.oneOf.some((entry) => entry.$ref === `#/components/schemas/${schemaName}`)) fail(`${schemaName} is not linked from the discriminator and union`);
}
const descriptorRoutes = document.components.schemas.ConnectionDescriptor?.properties?.routes;
if (descriptorRoutes?.maxItems !== 3 || descriptorRoutes?.items?.$ref !== "#/components/schemas/ConnectionRoute") fail("connection descriptors must contain only the bounded supported route union");

const discovery = document.components.schemas.Discovery;
const discoveryFields = ["apiVersion", "cmuxWebSocketTemplate", "ompAppWebSocketUrl", "protocols", "restBaseUrl", "service", "ssh"];
if (discovery?.additionalProperties !== false || !Object.keys(discovery.properties ?? {}).every((field) => discoveryFields.includes(field))) fail("discovery exposes an unsupported field");
const templateRef = discovery.properties?.cmuxWebSocketTemplate?.$ref;
const template = document.components.schemas.WssUrlTemplate;
const templatePattern = "^wss://[^/@\\s?#]+/v1/cmux/\\{runtimeId\\}$";
if (templateRef !== "#/components/schemas/WssUrlTemplate" || template?.type !== "string" || own(template, "format") || template?.minLength !== 25 || template?.maxLength !== 2048 || template?.pattern !== templatePattern) {
  fail("cmuxWebSocketTemplate must be a bounded credential-free WSS URI template with the canonical /v1/cmux/{runtimeId} path");
}
const publicUrlSchemas = {
  HttpsUrl: "^https://[^/@\\s?#]+/v1$",
  WssUrl: "^wss://[^/@\\s?#]+/v1/ws$",
  CmuxWssUrl: "^wss://[^/@\\s?#]+/v1/cmux/[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$"
};
for (const [schemaName, pattern] of Object.entries(publicUrlSchemas)) {
  const schema = document.components.schemas[schemaName];
  if (schema?.type !== "string" || schema?.format !== "uri" || schema?.maxLength !== 2048 || schema?.pattern !== pattern) fail(`${schemaName} must be a bounded credential-free canonical public URL`);
}
if (document.components.schemas.OmpAppWebSocketRoute?.properties?.url?.$ref !== "#/components/schemas/WssUrl" ||
  document.components.schemas.CmuxWebSocketRoute?.properties?.url?.$ref !== "#/components/schemas/CmuxWssUrl") fail("WebSocket routes must use their canonical public URL schemas");
const publicHost = document.components.schemas.PublicHost;
const sshUser = document.components.schemas.SshUser;
if (publicHost?.pattern !== "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$" || publicHost?.minLength !== 1 || publicHost?.maxLength !== 253 ||
  sshUser?.pattern !== "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" || sshUser?.minLength !== 1 || sshUser?.maxLength !== 128) {
  fail("SSH connection fields must use bounded control-free public host and user grammars");
}
if (document.components.schemas.SshEndpoint?.properties?.host?.$ref !== "#/components/schemas/PublicHost" ||
  document.components.schemas.MachineProviderSshRoute?.properties?.host?.$ref !== "#/components/schemas/PublicHost" ||
  document.components.schemas.MachineProviderSshRoute?.properties?.user?.$ref !== "#/components/schemas/SshUser") {
  fail("SSH discovery and connection routes must reuse the bounded public field schemas");
}
const idleVariants = document.components.schemas.IdlePolicy?.oneOf;
const idleDisabled = idleVariants?.find((variant) => variant.properties?.enabled?.const === false);
const idleEnabled = idleVariants?.find((variant) => variant.properties?.enabled?.const === true);
if (idleVariants?.length !== 2 || idleDisabled?.additionalProperties !== false || !same(idleDisabled?.required, ["enabled"]) ||
  !same(Object.keys(idleDisabled?.properties ?? {}), ["enabled"]) || idleEnabled?.additionalProperties !== false ||
  !same(idleEnabled?.required, ["enabled", "idleSeconds"]) || idleEnabled?.properties?.idleSeconds?.minimum !== 60 ||
  idleEnabled?.properties?.idleSeconds?.maximum !== 2592000) fail("IdlePolicy must be either disabled or enabled with a bounded duration");
const discoveryProtocols = document.components.schemas.ProtocolDiscovery?.properties;
if (discoveryProtocols?.machineProvider?.items?.const !== "machine-provider-v1" || discoveryProtocols?.cmux?.items?.const !== 10 || discoveryProtocols?.application?.items?.const !== "omp-app/1") fail("discovery protocol arrays must advertise the exact portable protocol versions");
for (const protocol of Object.values(discoveryProtocols ?? {})) {
  if (protocol.minItems !== 1 || protocol.maxItems !== 1 || protocol.uniqueItems !== true) fail("discovery protocol arrays must be exact singletons");
}
const capabilitiesProtocols = document.components.schemas.CapabilitiesProtocols?.properties;
if (resolveRef(capabilitiesProtocols?.machineProvider)?.properties?.versions?.items?.const !== 1) fail("capabilities must advertise machine provider version 1");
for (const [name, version] of [["cmux", 10], ["ompApp", 1]]) {
  const schema = capabilitiesProtocols?.[name];
  const versionConstraint = schema?.allOf?.find((entry) => entry.properties)?.properties?.versions?.items?.const;
  if (versionConstraint !== version) fail(`capabilities must advertise ${name} version ${version}`);
}
if (document.components.schemas.CapabilityLimits?.properties?.idempotencyRetentionSeconds?.minimum < 86400) fail("idempotency retention minimum must be at least 24 hours");
const expectedPhases = ["Pending", "Provisioning", "Starting", "Ready", "Sleeping", "Stopped", "Deleting", "Unavailable", "Degraded", "Failed"];
if (!same(document.components.schemas.Phase?.enum, expectedPhases)) fail("Phase must include the exact portable infrastructure state set, including Degraded");

const problem = document.components.schemas.Problem;
const problemRequired = ["type", "title", "status", "detail", "instance", "code", "retryable"];
if (!problem || !same(problem.required, problemRequired)) fail("Problem must require only RFC 9457 members plus code and retryable");
if (problem.properties?.status?.minimum !== 400 || problem.properties?.status?.maximum !== 599) fail("Problem.status must be an HTTP error status");
if (problem.required.includes("retryAfterMs") || problem.properties?.retryAfterMs?.type !== "integer") fail("Problem.retryAfterMs must be an optional non-null integer");
if (problem.required.includes("currentRevision") || problem.properties?.currentRevision?.$ref !== "#/components/schemas/Revision") fail("Problem.currentRevision must be an optional non-null revision");
const exampleSchemaNames = ["Discovery", "Capabilities", "Workspace", "WorkspaceCreate", "WorkspacePatch", "Runtime", "RuntimeCreate", "RuntimePatch", "ConnectionDescriptor", "InvalidationEvent", "ResetEvent", "Problem"];
const exampleForbiddenFields = ["authorization", "token", "password", "credential", "secret", "privatekey", "serviceip", "podaddress", "filesystempath", "hostpath", "internalurl", "environment", "command", "shell"];
const inspectExample = (value, location) => {
  if (typeof value === "string") {
    if (value.length > 2048) fail(`${location} contains an unbounded string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) fail(`${location} contains an unbounded array`);
    value.forEach((item, index) => inspectExample(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (JSON.stringify(value).length > 16384) fail(`${location} exceeds the example size bound`);
  for (const [field, child] of Object.entries(value)) {
    const normalized = field.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (exampleForbiddenFields.some((forbidden) => normalized.includes(forbidden))) fail(`${location}.${field} exposes a secret or internal field`);
    inspectExample(child, `${location}.${field}`);
  }
};
for (const schemaName of exampleSchemaNames) {
  const examples = document.components.schemas[schemaName]?.examples;
  if (!Array.isArray(examples) || examples.length !== 1) fail(`${schemaName} must publish exactly one bounded example`);
  inspectExample(examples[0], `${schemaName}.examples[0]`);
}
const requestExampleMedia = {
  WorkspaceCreate: "application/json",
  WorkspacePatch: "application/merge-patch+json",
  RuntimeCreate: "application/json",
  RuntimePatch: "application/merge-patch+json"
};
for (const [requestName, mediaType] of Object.entries(requestExampleMedia)) {
  const example = document.components.requestBodies[requestName]?.content?.[mediaType]?.example;
  if (!same(example, document.components.schemas[requestName]?.examples?.[0])) fail(`${requestName} request body must publish its named schema example`);
  inspectExample(example, `requestBodies.${requestName}`);
}
const discoveryExample = document.components.schemas.Discovery.examples[0];
if (discoveryExample.restBaseUrl !== "https://omp.example.net/v1" || discoveryExample.ompAppWebSocketUrl !== "wss://omp.example.net/v1/ws" || discoveryExample.cmuxWebSocketTemplate !== "wss://omp.example.net/v1/cmux/{runtimeId}") fail("Discovery example must use the exact public v1 routes");
if (!same(discoveryExample.protocols, { machineProvider: ["machine-provider-v1"], cmux: [10], application: ["omp-app/1"] })) fail("Discovery example must use the exact portable protocol arrays");
const capabilityExampleProtocols = document.components.schemas.Capabilities.examples[0].protocols;
if (!same(capabilityExampleProtocols.machineProvider.versions, [1]) || !same(capabilityExampleProtocols.cmux.versions, [10]) || !same(capabilityExampleProtocols.ompApp.versions, [1])) fail("Capabilities example must use machine-provider-v1, cmux 10, and omp-app/1");
const connectionExampleRoutes = document.components.schemas.ConnectionDescriptor.examples[0].routes;
if (!same(connectionExampleRoutes.map((route) => route.kind), ["machine-provider-ssh", "omp-app-websocket", "cmux-websocket"])) fail("ConnectionDescriptor example must contain exactly the three public route kinds");
if (connectionExampleRoutes[1]?.url !== "wss://omp.example.net/v1/ws" || connectionExampleRoutes[1]?.protocol !== "omp-app/1" || connectionExampleRoutes[2]?.url !== "wss://omp.example.net/v1/cmux/rt_01JZ8R7N2P" || connectionExampleRoutes[2]?.protocol !== 10 || connectionExampleRoutes[0]?.providerVersion !== 1) fail("ConnectionDescriptor example must use the exact public routes and protocols");

const lowerCamel = /^[a-z][A-Za-z0-9]*$/;
for (const [schemaName, schema] of Object.entries(document.components.schemas ?? {})) {
  for (const property of Object.keys(schema.properties ?? {})) {
    if (!lowerCamel.test(property)) fail(`${schemaName}.${property} is not lowerCamelCase`);
  }
}
const forbiddenNames = [
  "session", "command", "snapshot", "transcript", "terminal", "ompevent", "browserframe", "browserstream",
  "podspec", "hostpath", "containerimage", "privileged", "environmentvariable", "secretcontent", "internalurl"
];
const inspectPublicNames = (value, location = "document") => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
    if (forbiddenNames.some((term) => normalized.includes(term))) fail(`${location}.${key} exposes forbidden semantic or private vocabulary`);
    if (key === "operationId" && typeof child === "string") {
      const operationName = child.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (forbiddenNames.some((term) => operationName.includes(term))) fail(`${child} exposes forbidden semantic or private vocabulary`);
    }
    if (key !== "description") inspectPublicNames(child, `${location}.${key}`);
  }
};
inspectPublicNames({ paths: document.paths, schemas: document.components.schemas });

console.log("Portable Agent Platform v1 OpenAPI contract is valid");
