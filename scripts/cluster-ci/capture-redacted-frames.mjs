import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

import { redactFrame } from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const outputPath = resolve(repoRoot, "artifacts/cluster-proof/frames/live-operator-state.json");
const MAX_INBOUND_BYTES = 1024 * 1024;
const MAX_FRAMES = 32;
const SAFE_AGENT_ID_KEYS = ["agentId", "rootAgentId", "activeAgentId", "parentAgentId"];
const CLUSTER_HOST = "t4-dev.tailb18de3.ts.net";
const EXPECTED_OMP_VERSION = "17.0.5";
const EXPECTED_OMP_BUILD = "8476f4451ed95c5d5401785d279a93d3c659fac4";
const REQUIRED_CAPABILITIES = Object.freeze([
  "sessions.read",
  "ci.trigger",
  "preview.read",
  "preview.control",
  "preview.input",
]);

export function proofHelloFrame() {
  return {
    v: "omp-app/1",
    type: "hello",
    protocol: { min: "omp-app/1", max: "omp-app/1" },
    client: { name: "t4-cluster-proof", version: "1", build: "1", platform: "woodpecker" },
    requestedFeatures: ["cluster.operator", "resume", "preview.control"],
    capabilities: { client: [...REQUIRED_CAPABILITIES] },
    savedCursors: [],
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function clusterWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== CLUSTER_HOST ||
    url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`T4_CLUSTER_BASE_URL must be the credential-free HTTPS origin https://${CLUSTER_HOST}/`);
  }
  url.protocol = "wss:";
  url.pathname = "/v1/ws";
  return url;
}

function boundedId(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 253 || /\p{Cc}/u.test(value)) {
    throw new Error(`${label} is not a bounded identifier`);
  }
  return value;
}

function cursor(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.epoch !== "string" ||
    value.epoch.length < 1 ||
    value.epoch.length > 253 ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0
  ) {
    throw new Error(`${label} is not a bounded cursor`);
  }
  return { epoch: value.epoch, seq: value.seq };
}

function agentIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const ids = {};
  const stack = [value];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || Array.isArray(current)) continue;
    visited += 1;
    if (visited > 256) throw new Error("session state exceeded its object bound");
    for (const [key, item] of Object.entries(current)) {
      if (SAFE_AGENT_ID_KEYS.includes(key) && typeof item === "string" && !(key in ids)) {
        ids[key] = boundedId(item, key);
      } else if (item && typeof item === "object") {
        stack.push(item);
      }
    }
  }
  return ids;
}

function projectItems(items, kind) {
  if (!Array.isArray(items) || items.length > 256) throw new Error(`${kind} list exceeded its bound`);
  if (kind === "sessions") {
    return items.map((item, index) => ({
      hostId: boundedId(item?.hostId, `sessions[${index}].hostId`),
      sessionId: boundedId(item?.sessionId, `sessions[${index}].sessionId`),
      revision: boundedId(item?.revision, `sessions[${index}].revision`),
      ...(typeof item?.liveState?.cluster?.workspaceId === "string"
        ? { workspaceId: boundedId(item.liveState.cluster.workspaceId, `sessions[${index}].workspaceId`) }
        : {}),
      ...agentIds(item?.liveState),
    }));
  }
  return items.map((item, index) => ({
    hostId: boundedId(item?.hostId, `workspaces[${index}].hostId`),
    workspaceId: boundedId(item?.workspaceId ?? item?.id, `workspaces[${index}].workspaceId`),
    revision: boundedId(item?.revision, `workspaces[${index}].revision`),
  }));
}

function projectListResult(kind, hostId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${kind} result is malformed`);
  const items = value[kind];
  return {
    v: "omp-app/1",
    type: `${kind}.proof`,
    hostId,
    cursor: cursor(value.cursor, `${kind}.cursor`),
    items: projectItems(items, kind),
  };
}

async function capture() {
  const baseUrl = requiredEnvironment("T4_CLUSTER_BASE_URL");
  const origin = new URL(baseUrl).origin;
  const pipelineNumber = requiredEnvironment("CI_PIPELINE_NUMBER");
  const sessionRequest = `proof-session-list-${pipelineNumber}`;
  const workspaceRequest = `proof-workspace-list-${pipelineNumber}`;
  const socket = new WebSocket(clusterWebSocketUrl(baseUrl), {
    headers: { Origin: origin },
    handshakeTimeout: 15_000,
    maxPayload: MAX_INBOUND_BYTES,
    perMessageDeflate: false,
  });
  const frames = [];
  let hostId;
  let sessionResult;
  let workspaceResult;

  const complete = new Promise((resolveComplete, rejectComplete) => {
    const timeout = setTimeout(() => rejectComplete(new Error("timed out waiting for bounded cluster frames")), 20_000);
    const finish = (callback, value) => {
      clearTimeout(timeout);
      callback(value);
    };
    socket.once("error", (error) => finish(rejectComplete, error));
    socket.once("close", (code) => {
      if (!sessionResult || !workspaceResult) finish(rejectComplete, new Error(`cluster socket closed early (${code})`));
    });
    socket.once("open", () => {
      socket.send(JSON.stringify(proofHelloFrame()));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary || data.length > MAX_INBOUND_BYTES) return finish(rejectComplete, new Error("cluster frame was binary or oversized"));
      let frame;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        return finish(rejectComplete, new Error("cluster frame was not JSON"));
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.v !== "omp-app/1") {
        return finish(rejectComplete, new Error("cluster frame was malformed"));
      }
      if (frame.type === "welcome") {
        hostId = boundedId(frame.hostId, "welcome.hostId");
        if (
          frame.selectedProtocol !== "omp-app/1" ||
          frame.ompVersion !== EXPECTED_OMP_VERSION ||
          frame.ompBuild !== EXPECTED_OMP_BUILD ||
          !Array.isArray(frame.grantedFeatures) ||
          !frame.grantedFeatures.includes("cluster.operator") ||
          !frame.grantedFeatures.includes("preview.control") ||
          !Array.isArray(frame.grantedCapabilities) ||
          REQUIRED_CAPABILITIES.some((capability) => !frame.grantedCapabilities.includes(capability))
        ) {
          return finish(rejectComplete, new Error("cluster operator sessions.read/CI/preview capability contract was not negotiated"));
        }
        frames.push({
          v: "omp-app/1",
          type: "welcome.proof",
          hostId,
          epoch: boundedId(frame.epoch, "welcome.epoch"),
          selectedProtocol: frame.selectedProtocol,
          ompVersion: frame.ompVersion,
          ompBuild: frame.ompBuild,
          clusterOperator: true,
          grantedCapabilities: REQUIRED_CAPABILITIES,
        });
        for (const [requestId, command] of [
          [sessionRequest, "session.list"],
          [workspaceRequest, "workspace.list"],
        ]) {
          socket.send(
            JSON.stringify({
              v: "omp-app/1",
              type: "command",
              requestId,
              commandId: requestId,
              hostId,
              command,
              args: {},
            }),
          );
        }
      } else if (frame.type === "response" && frame.requestId === sessionRequest) {
        if (frame.ok !== true) return finish(rejectComplete, new Error("session.list proof command failed"));
        sessionResult = projectListResult("sessions", hostId, frame.result);
        frames.push(sessionResult);
      } else if (frame.type === "response" && frame.requestId === workspaceRequest) {
        if (frame.ok !== true) return finish(rejectComplete, new Error("workspace.list proof command failed"));
        workspaceResult = projectListResult("workspaces", hostId, frame.result);
        frames.push(workspaceResult);
      }
      if (frames.length > MAX_FRAMES) return finish(rejectComplete, new Error("cluster proof frame count exceeded its bound"));
      if (sessionResult && workspaceResult) finish(resolveComplete);
    });
  });

  try {
    await complete;
  } finally {
    socket.close(1000, "proof complete");
  }
  if (sessionResult.items.length < 1 || workspaceResult.items.length < 1) {
    throw new Error("cluster proof requires at least one workspace and session revision");
  }
  const artifact = redactFrame({
    schemaVersion: "t4-cluster-redacted-frames/1",
    redacted: true,
    capturedAt: new Date().toISOString(),
    frames,
  });
  await mkdir(resolve(proofRoot(), "frames"), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  return artifact;
}

function proofRoot() {
  return resolve(repoRoot, "artifacts/cluster-proof");
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const artifact = await capture();
    console.log(`Captured ${artifact.frames.length} bounded redacted cluster frames`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { capture as captureRedactedFrameEvidence };
