import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORIZED_CI_MIRROR,
  CANONICAL_BUILD_SOURCE_REPOSITORY,
  OBSERVATION_SYSTEMS,
  PROOF_SCENARIOS,
  createFileEvidence,
  redactFrame,
  validateImagePublicationManifest,
  validateProofManifest,
} from "./proof-contract.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const proofRoot = resolve(repoRoot, "artifacts/cluster-proof");
const MAX_LOCAL_ARTIFACTS = 32;
const SCENARIO_ASSERTION = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const CONTRACT_SCENARIOS = new Set([
  "wire-reconnect-idempotency",
  "gui-auth-isolation",
  "desktop-viewport",
  "mobile-viewport",
]);
const WOODPECKER_ORIGIN = "https://woodpecker-ci-dev.tailb18de3.ts.net";
const OBSERVATION_ORIGINS = Object.freeze({
  prometheus: "https://interview-responder-prometheus.tailb18de3.ts.net",
  loki: "https://interview-responder-loki.tailb18de3.ts.net",
  grafana: "https://grafana.tailb18de3.ts.net",
});


function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function woodpeckerIdentity() {
  const value = requiredEnvironment("CI_PIPELINE_URL");
  const url = new URL(value);
  const match = url.pathname.match(/\/repos\/([1-9][0-9]*)\/pipeline\/([1-9][0-9]*)\/?$/u);
  const pipelineNumber = Number(requiredEnvironment("CI_PIPELINE_NUMBER"));
  if (
    url.origin !== WOODPECKER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !Number.isSafeInteger(pipelineNumber) ||
    pipelineNumber <= 0
  ) {
    throw new Error("Woodpecker pipeline URL/number identity is invalid");
  }
  return {
    repositoryId: Number(match[1]),
    pipelineId: Number(match[2]),
    pipelineNumber,
    url: value,
  };
}


function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unexpected field ${key}`);
  }
  for (const key of keys) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  }
}

function utcTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a UTC RFC 3339 timestamp`);
  }
  return value;
}

async function scenarioEntries() {
  const directory = resolve(proofRoot, "scenarios");
  const entries = [];
  for (const id of PROOF_SCENARIOS) {
    const path = resolve(directory, `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    exactKeys(record, ["schemaVersion", "id", "status", "observedAt", "assertions"], `scenario ${id}`);
    if (
      record.schemaVersion !== "t4-cluster-scenario/1" ||
      record.id !== id ||
      record.status !== "passed" ||
      !Array.isArray(record.assertions) ||
      record.assertions.length < 1 ||
      record.assertions.length > 64 ||
      new Set(record.assertions).size !== record.assertions.length ||
      record.assertions.some((assertion) => !SCENARIO_ASSERTION.test(assertion))
    ) {
      throw new Error(`scenario ${id} did not contain an exact passing contract result`);
    }
    entries.push({
      id,
      status: "passed",
      evidenceType: CONTRACT_SCENARIOS.has(id) ? "contract" : "live",
      observedAt: utcTimestamp(record.observedAt, `scenario ${id}.observedAt`),
      assertions: record.assertions,
      evidence: [await createFileEvidence(path, { artifactRoot: repoRoot })],
    });
  }
  return entries;
}

function safeSummary(value, label, depth = 0) {
  if (depth > 8) throw new Error(`${label} exceeded its depth bound`);
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (value.length > 2048) throw new Error(`${label} contained an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error(`${label} exceeded its item bound`);
    value.forEach((item, index) => safeSummary(item, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} contained an unsupported value`);
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error(`${label} exceeded its field bound`);
  for (const [key, item] of entries) {
    if (/api.?key|private.?key|authorization|auth|bearer|cookie|credential|password|prompt|secret|token|transcript/iu.test(key)) {
      throw new Error(`${label} contained sensitive field ${key}`);
    }
    safeSummary(item, `${label}.${key}`, depth + 1);
  }
}

async function observationEntries() {
  const directory = resolve(proofRoot, "observations");
  await mkdir(directory, { recursive: true });
  const commit = requiredEnvironment("CI_COMMIT_SHA");
  const entries = [];

  const woodpecker = woodpeckerIdentity();
  const woodpeckerObservedAt = new Date().toISOString();
  const woodpeckerPath = resolve(directory, "woodpecker.json");
  await writeFile(
    woodpeckerPath,
    `${JSON.stringify({ schemaVersion: "t4-woodpecker-observation/1", observedAt: woodpeckerObservedAt, ...woodpecker }, null, 2)}\n`,
    { mode: 0o600 },
  );
  entries.push({
    system: "woodpecker",
    observedAt: woodpeckerObservedAt,
    url: WOODPECKER_ORIGIN,
    ids: [String(woodpecker.repositoryId), String(woodpecker.pipelineId), String(woodpecker.pipelineNumber)],
    evidence: await createFileEvidence(woodpeckerPath, { artifactRoot: repoRoot }),
  });

  const kubernetesPath = resolve(directory, "kubernetes.json");
  const kubernetes = JSON.parse(await readFile(kubernetesPath, "utf8"));
  if (
    kubernetes?.schemaVersion !== "t4-cluster-readonly-snapshot/1" ||
    !Array.isArray(kubernetes.deployments) ||
    kubernetes.deployments.length < 2
  ) {
    throw new Error("Kubernetes observation does not contain exact read-only cluster evidence");
  }
  entries.push({
    system: "kubernetes",
    observedAt: utcTimestamp(kubernetes.observedAt, "kubernetes observedAt"),
    url: null,
    ids: kubernetes.deployments.map(({ name }) => name),
    evidence: await createFileEvidence(kubernetesPath, { artifactRoot: repoRoot }),
  });

  for (const system of ["prometheus", "loki", "grafana"]) {
    const path = resolve(directory, `${system}.json`);
    const payload = JSON.parse(await readFile(path, "utf8"));
    exactKeys(payload, ["schemaVersion", "sourceCommit", "system", "observedAt", "redacted", "ids", "summary"], `${system} evidence`);
    if (
      payload.schemaVersion !== "t4-cluster-observation/1" ||
      payload.sourceCommit !== commit ||
      payload.system !== system ||
      payload.redacted !== true ||
      !Array.isArray(payload.ids) ||
      payload.ids.length < 1 ||
      payload.ids.length > 16
    ) {
      throw new Error(`${system} evidence is not an exact source-bound redacted observation`);
    }
    utcTimestamp(payload.observedAt, `${system} evidence observedAt`);
    safeSummary(payload.summary, `${system} evidence summary`);
    entries.push({
      system,
      observedAt: payload.observedAt,
      url: OBSERVATION_ORIGINS[system],
      ids: payload.ids,
      evidence: await createFileEvidence(path, { artifactRoot: repoRoot }),
    });
  }
  if (entries.length !== OBSERVATION_SYSTEMS.length) {
    throw new Error("observation coverage does not match the truthfully available systems");
  }
  return entries;
}

async function localArtifacts(kind, extensions) {
  const directory = resolve(proofRoot, kind);
  const names = (await readdir(directory)).filter((name) => extensions.some((extension) => name.endsWith(extension))).sort();
  if (names.length < 1 || names.length > MAX_LOCAL_ARTIFACTS) {
    throw new Error(`${kind} artifact count is outside its bound`);
  }
  const results = [];
  for (const name of names) {
    const path = resolve(directory, name);
    if (kind === "frames") {
      const parsed = JSON.parse(await readFile(path, "utf8"));
      const frames = Array.isArray(parsed) ? parsed : [parsed];
      if (frames.length < 1 || frames.length > 256) throw new Error(`${name} frame count is outside its bound`);
      for (const frame of frames) {
        if (JSON.stringify(redactFrame(frame)) !== JSON.stringify(frame)) {
          throw new Error(`${name} contains unredacted authority-sensitive frame state`);
        }
      }
    }
    const viewport = /mobile/iu.test(name) ? "mobile" : /desktop/iu.test(name) ? "desktop" : undefined;
    results.push({
      ...(await createFileEvidence(path, { artifactRoot: repoRoot })),
      redacted: true,
      evidenceType: kind === "frames" ? "live" : "contract",
      ...(viewport ? { viewport } : {}),
    });
  }
  return results;
}

async function verifyLiveImageDigests(images) {
  const snapshot = JSON.parse(
    await readFile(resolve(proofRoot, "observations/kubernetes.json"), "utf8"),
  );
  if (
    snapshot?.schemaVersion !== "t4-cluster-readonly-snapshot/1" ||
    !Array.isArray(snapshot.images) ||
    snapshot.images.length > 64
  ) {
    throw new Error("Kubernetes observation has no bounded live image identity");
  }
  const identities = {
    controller: { component: "controller", container: "controller" },
    "cluster-server": { component: "server", container: "server" },
    "session-runtime": { name: "t4-session-runtime", container: "session-runtime" },
  };
  for (const image of images) {
    const identity = identities[image.component];
    const matches = snapshot.images.filter((observed) =>
      observed?.labels?.partOf === "t4-cluster" &&
      (identity.component ? observed.labels.component === identity.component : observed.labels.name === identity.name) &&
      observed.container === identity.container &&
      observed.phase === "Running" &&
      observed.ready === true &&
      observed.image === image.reference &&
      typeof observed.imageID === "string" &&
      observed.imageID.endsWith(`@${image.digest}`),
    );
    if (matches.length < 1) {
      throw new Error(`live Kubernetes pods do not run the exact ready ${image.component} reference ${image.reference}`);
    }
  }
}

export async function assembleProofManifest() {
  const imageManifest = validateImagePublicationManifest(
    JSON.parse(await readFile(resolve(proofRoot, "image-publication.json"), "utf8")),
  );
  if (imageManifest.source.commit !== requiredEnvironment("CI_COMMIT_SHA")) {
    throw new Error("image publication manifest does not match this source commit");
  }
  await verifyLiveImageDigests(imageManifest.images);
  const ciRepository = requiredEnvironment("CI_REPO");
  if (ciRepository !== AUTHORIZED_CI_MIRROR) throw new Error("CI_REPO is not the authorized CI mirror");
  const source = {
    repository: CANONICAL_BUILD_SOURCE_REPOSITORY,
    commit: requiredEnvironment("CI_COMMIT_SHA"),
    woodpecker: { repository: ciRepository, ...woodpeckerIdentity() },
  };
  const manifest = {
    schemaVersion: "t4-cluster-proof/1",
    source,
    images: imageManifest.images,
    scenarios: await scenarioEntries(),
    observations: await observationEntries(),
    artifacts: {
      frames: await localArtifacts("frames", [".json"]),
      screenshots: await localArtifacts("screenshots", [".png", ".webp"]),
    },
  };
  return validateProofManifest(manifest);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const manifest = await assembleProofManifest();
    const outputPath = resolve(proofRoot, "manifest.json");
    const temporaryPath = `${outputPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, outputPath);
    console.log(`Wrote ${outputPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
