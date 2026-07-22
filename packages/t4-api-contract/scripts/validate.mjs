import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileErrors, validate } from "@readme/openapi-parser";

const source = new URL("../openapi.json", import.meta.url);
const document = JSON.parse(await readFile(source, "utf8"));
const validation = await validate(fileURLToPath(source));
if (!validation.valid || validation.warnings.length > 0) throw new Error(compileErrors(validation));

if (document.openapi !== "3.1.0") throw new Error("T4 API contract must remain OpenAPI 3.1.0");
if (!Array.isArray(document.servers) || document.servers.length === 0) throw new Error("T4 API contract requires an HTTPS server");
for (const server of document.servers) {
  if (new URL(server.url).protocol !== "https:") throw new Error("T4 API contract permits only HTTPS servers");
}
if (document.security?.[0]?.BearerAuth === undefined) throw new Error("T4 API contract must default to bearer authentication");
const sseSchema = document.paths?.["/v1/sessions/{sessionId}/events"]?.get?.responses?.["200"]?.content?.["text/event-stream"]?.schema;
if (sseSchema?.["x-t4-sse-data-schema"] !== "#/components/schemas/WatchEvent") throw new Error("watch SSE data must remain linked to WatchEvent");
const schemas = document.components?.schemas ?? {};
const commandCreate = schemas.CommandCreate;
if (commandCreate?.["x-t4-maxUtf8Bytes"] !== 1048576) throw new Error("CommandCreate must retain its UTF-8 request-byte bound");
if (commandCreate?.properties?.command?.["x-t4-maxUtf8Bytes"] !== 262144) throw new Error("command must retain its UTF-8 byte bound");
const metadataString = commandCreate?.properties?.metadata?.additionalProperties?.oneOf?.find((item) => item?.type === "string");
if (metadataString?.["x-t4-maxUtf8Bytes"] !== 262144) throw new Error("command metadata strings must retain their UTF-8 byte bound");
if (schemas.SessionSnapshot?.["x-t4-maxUtf8Bytes"] !== 16777216) throw new Error("SessionSnapshot must retain its aggregate UTF-8 response-byte bound");

for (const [schema, property] of [["Discovery", "supportedMajors"], ["ApiError", "supportedMajors"]]) {
  if (schemas[schema]?.properties?.[property]?.uniqueItems !== true) throw new Error(`${schema}.${property} must retain uniqueItems`);
}
if (schemas.Discovery?.required?.includes("serverBuild") !== true || schemas.Discovery?.properties?.capabilities?.$ref !== "#/components/schemas/Capabilities") throw new Error("Discovery must require structured server build and capabilities");
if (schemas.Capabilities?.maxProperties !== 128 || schemas.Capabilities?.additionalProperties?.$ref !== "#/components/schemas/CapabilityStatus") throw new Error("Capabilities must remain a bounded status map");

const selectedVersionHeader = document.components?.headers?.SelectedVersion;
const replayHeaderObject = document.components?.headers?.IdempotencyReplayed;
const eventCursorHeader = document.components?.headers?.EventCursor;
if (selectedVersionHeader?.required !== true) throw new Error("SelectedVersion must remain required wherever referenced");
if (replayHeaderObject?.required !== true) throw new Error("IdempotencyReplayed must remain required wherever referenced");
if (eventCursorHeader?.required !== true || eventCursorHeader?.schema?.$ref !== "#/components/schemas/Cursor") throw new Error("EventCursor must remain a required header-safe cursor");
const selectedVersion = document.components?.headers?.SelectedVersion?.schema;
if (selectedVersion?.pattern !== "^1\\.[0-9]+$" || selectedVersion?.maxLength !== 16) throw new Error("SelectedVersion must remain a bounded v1 minor");
const replayHeader = document.components?.headers?.IdempotencyReplayed?.schema;
if (replayHeader?.type !== "string" || JSON.stringify(replayHeader.enum) !== '["true","false"]') throw new Error("IdempotencyReplayed must remain the exact true|false string enum");
if (schemas.HeartbeatWatchEvent?.properties?.observedAt?.maxLength !== 64) throw new Error("HeartbeatWatchEvent.observedAt must remain bounded to 64 characters");
const selectedVersionRef = "#/components/headers/SelectedVersion";
const replayRef = "#/components/headers/IdempotencyReplayed";
const selectedVersionResponses = ["Discovery", "Workspace", "WorkspaceAccepted", "WorkspaceReplay", "WorkspacePage", "Session", "SessionAccepted", "SessionReplay", "SessionPage", "CommandAccepted", "CommandReplay", "Snapshot", "Deleted", "Error400", "Error403", "Error404", "Error406", "Error409", "Error410", "Error422", "Error503"];
for (const responseName of selectedVersionResponses) {
  if (document.components?.responses?.[responseName]?.headers?.["T4-API-Version"]?.$ref !== selectedVersionRef) throw new Error(`${responseName} must declare SelectedVersion`);
}
const mutationResponses = ["WorkspaceAccepted", "WorkspaceReplay", "SessionAccepted", "SessionReplay", "CommandAccepted", "CommandReplay", "Deleted"];
for (const responseName of mutationResponses) {
  if (document.components?.responses?.[responseName]?.headers?.["Idempotency-Replayed"]?.$ref !== replayRef) throw new Error(`${responseName} must declare IdempotencyReplayed`);
  if (document.components?.responses?.[responseName]?.headers?.["T4-Event-Cursor"]?.$ref !== "#/components/headers/EventCursor") throw new Error(`${responseName} must declare EventCursor`);
}
if (document.paths?.["/v1/sessions/{sessionId}/events"]?.get?.responses?.["200"]?.headers?.["T4-API-Version"]?.$ref !== selectedVersionRef) throw new Error("watch success must declare SelectedVersion");
const watchCacheControl = document.paths?.["/v1/sessions/{sessionId}/events"]?.get?.responses?.["200"]?.headers?.["Cache-Control"];
if (watchCacheControl?.required !== true || watchCacheControl?.schema?.const !== "no-store") throw new Error("watch success must require Cache-Control: no-store");
if (document.components?.responses?.Error401?.headers?.["T4-API-Version"] !== undefined) throw new Error("Error401 must omit SelectedVersion");
if (document.paths?.["/v1/workspaces/{workspaceId}"]?.patch?.responses?.["200"]?.$ref !== "#/components/responses/WorkspaceReplay") throw new Error("workspace PATCH success must declare replay headers");
if (document.paths?.["/v1/sessions/{sessionId}"]?.patch?.responses?.["200"]?.$ref !== "#/components/responses/SessionReplay") throw new Error("session PATCH success must declare replay headers");
const errorResponses = { 400: "Error400", 401: "Error401", 403: "Error403", 404: "Error404", 406: "Error406", 409: "Error409", 410: "Error410", 422: "Error422", 503: "Error503" };
for (const path of Object.values(document.paths ?? {})) {
  for (const operation of Object.values(path)) {
    if (operation === null || typeof operation !== "object" || operation.responses === undefined) continue;
    for (const [status, component] of Object.entries(errorResponses)) {
      const response = operation.responses[status];
      if (response !== undefined && response.$ref !== `#/components/responses/${component}`) throw new Error(`${status} responses must use ${component}`);
    }
  }
}
const serializedSchemas = JSON.stringify(document.components?.schemas ?? {}).toLowerCase();
for (const privateType of ["kubernetes.io", "v1alpha1", "postgresql", "ompserver", "podspec"]) {
  if (serializedSchemas.includes(privateType)) throw new Error(`public schema leaks private type ${privateType}`);
}
console.log("T4 API OpenAPI 3.1 contract is valid");
