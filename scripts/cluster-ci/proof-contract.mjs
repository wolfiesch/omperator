import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";

export const CANONICAL_BUILD_SOURCE_REPOSITORY = "usr-bin-roygbiv/t4-code";
export const AUTHORIZED_CI_MIRROR = "z-peterson/t4-code";
export const IMAGE_COMPONENTS = Object.freeze(["controller", "cluster-server", "session-runtime"]);
export const PROOF_SCENARIOS = Object.freeze([
  "ha-manifest",
  "leader-election",
  "crd-reconcile-storage",
  "feature-off",
  "wire-reconnect-idempotency",
  "gui-auth-isolation",
  "ci-mapping",
  "desktop-viewport",
  "mobile-viewport",
]);
export const OBSERVATION_SYSTEMS = Object.freeze([
  "woodpecker",
  "kubernetes",
  "prometheus",
  "loki",
  "grafana",
]);
const CONTRACT_SCENARIOS = new Set([
  "wire-reconnect-idempotency",
  "gui-auth-isolation",
  "desktop-viewport",
  "mobile-viewport",
]);

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SHA_PATTERN = /^[0-9a-f]{64}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REPOSITORY_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/u;
const ARTIFACT_PATH_PATTERN = /^artifacts\/cluster-proof\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const ASSERTION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SENSITIVE_KEY_PATTERN = /api.?key|private.?key|authorization|auth|bearer|cookie|credential|password|prompt|secret|token|transcript/iu;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_DEPTH = 12;
const MAX_OBJECT_FIELDS = 128;
const MAX_ARRAY_ITEMS = 256;
const OBSERVATION_HOSTS = Object.freeze({
  woodpecker: new Set(["woodpecker-ci-dev.tailb18de3.ts.net"]),
  prometheus: new Set(["interview-responder-prometheus.tailb18de3.ts.net"]),
  loki: new Set(["interview-responder-loki.tailb18de3.ts.net"]),
  grafana: new Set(["grafana.tailb18de3.ts.net"]),
});

function fail(message) {
  throw new Error(`T4 cluster proof ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactFields(value, required, label) {
  object(value, label);
  const expected = new Set(required);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) fail(`${label} has unexpected field ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) fail(`${label} is missing ${key}`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive integer`);
  return value;
}

function boundedString(value, label, maxLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(`${label} must be a non-empty string no longer than ${maxLength}`);
  }
  return value;
}

function exactSet(values, expected, label) {
  if (!Array.isArray(values) || values.length !== expected.length) fail(`${label} coverage is incomplete`);
  const actual = values.map((item) => item.id ?? item.system ?? item.component);
  if (new Set(actual).size !== actual.length) fail(`${label} contains duplicates`);
  for (const required of expected) {
    if (!actual.includes(required)) fail(`${label} coverage is missing ${required}`);
  }
}

function timestamp(value, label) {
  boundedString(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(`${label} must be a UTC RFC 3339 timestamp`);
  }
  return value;
}

function httpsUrl(value, label) {
  boundedString(value, label, 2048);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(`${label} must be a credential-free HTTPS URL without query or fragment`);
  }
  return value;
}

function observationUrl(value, system, label) {
  if (system === "kubernetes") {
    if (value !== null) fail(`${label} must be null because Kubernetes was captured through bounded kubectl GETs`);
    return value;
  }
  httpsUrl(value, label);
  const url = new URL(value);
  if (url.port || !OBSERVATION_HOSTS[system]?.has(url.hostname)) {
    fail(`${label} is outside the exact ${system} tailnet allowlist`);
  }
  return value;
}

function fileEvidence(value, label, extraFields = []) {
  const fields = ["path", "sha256", ...extraFields];
  exactFields(value, fields, label);
  if (!ARTIFACT_PATH_PATTERN.test(value.path) || value.path.includes("..")) {
    fail(`${label}.path must stay inside artifacts/cluster-proof`);
  }
  if (!SHA_PATTERN.test(value.sha256)) fail(`${label}.sha256 must be a lowercase SHA-256`);
  return value;
}

function visualEvidence(value, label) {
  const fields = ["path", "sha256", "redacted", "evidenceType", ...(value.viewport === undefined ? [] : ["viewport"] )];
  fileEvidence(value, label, fields.slice(2));
  if (value.redacted !== true) fail(`${label} must be redacted`);
  if (!["contract", "live"].includes(value.evidenceType)) fail(`${label}.evidenceType is invalid`);
  if (value.viewport !== undefined && !["desktop", "mobile"].includes(value.viewport)) {
    fail(`${label}.viewport is invalid`);
  }
  return value;
}

function validateSource(source) {
  exactFields(source, ["repository", "commit", "woodpecker"], "source");
  if (source.repository !== CANONICAL_BUILD_SOURCE_REPOSITORY) {
    fail("source.repository is not the canonical build source");
  }
  if (!COMMIT_PATTERN.test(source.commit)) fail("source.commit must be an exact lowercase SHA");
  exactFields(
    source.woodpecker,
    ["repository", "repositoryId", "pipelineId", "pipelineNumber", "url"],
    "source.woodpecker",
  );
  if (source.woodpecker.repository !== AUTHORIZED_CI_MIRROR) {
    fail("source.woodpecker.repository is not the authorized CI mirror");
  }
  positiveInteger(source.woodpecker.repositoryId, "source.woodpecker.repositoryId");
  positiveInteger(source.woodpecker.pipelineId, "source.woodpecker.pipelineId");
  positiveInteger(source.woodpecker.pipelineNumber, "source.woodpecker.pipelineNumber");
  httpsUrl(source.woodpecker.url, "source.woodpecker.url");
  return source;
}

export function validateImageEntries(images, sourceCommit) {
  exactSet(images, IMAGE_COMPONENTS, "image");
  for (const [index, image] of images.entries()) {
    const label = `images[${index}]`;
    exactFields(
      image,
      ["component", "repository", "tag", "digest", "reference", "sbom", "provenance", "vulnerability"],
      label,
    );
    if (!IMAGE_COMPONENTS.includes(image.component)) fail(`${label}.component is invalid`);
    if (!REPOSITORY_PATTERN.test(image.repository) || image.repository.length > 255) {
      fail(`${label}.repository is invalid`);
    }
    if (image.tag !== sourceCommit || !COMMIT_PATTERN.test(image.tag)) {
      fail(`${label}.tag must equal the exact source commit`);
    }
    if (!DIGEST_PATTERN.test(image.digest)) fail(`${label}.digest is invalid`);
    if (image.reference !== `${image.repository}@${image.digest}`) {
      fail(`${label}.reference must use the immutable digest`);
    }
    fileEvidence(image.sbom, `${label}.sbom`);
    fileEvidence(image.provenance, `${label}.provenance`, ["mode", "signatureVerified"]);
    if (
      !["buildkit-content", "cosign-keyless"].includes(image.provenance.mode) ||
      image.provenance.signatureVerified !== (image.provenance.mode === "cosign-keyless")
    ) {
      fail(`${label}.provenance signer verification claim is not truthful`);
    }
    fileEvidence(image.vulnerability, `${label}.vulnerability`, ["scanner", "critical", "high"]);
    if (
      image.vulnerability.scanner !== "trivy" ||
      image.vulnerability.critical !== 0 ||
      image.vulnerability.high !== 0
    ) {
      fail(`${label}.vulnerability must contain a clean Trivy result`);
    }
  }
  return images;
}

function validateScenarioEntries(scenarios) {
  exactSet(scenarios, PROOF_SCENARIOS, "scenario");
  for (const [index, scenario] of scenarios.entries()) {
    const label = `scenarios[${index}]`;
    exactFields(scenario, ["id", "status", "evidenceType", "observedAt", "assertions", "evidence"], label);
    if (!PROOF_SCENARIOS.includes(scenario.id)) fail(`${label}.id is invalid`);
    if (scenario.status !== "passed") fail(`${label} must be passed`);
    const expectedType = CONTRACT_SCENARIOS.has(scenario.id) ? "contract" : "live";
    if (scenario.evidenceType !== expectedType) fail(`${label}.evidenceType must be ${expectedType}`);
    timestamp(scenario.observedAt, `${label}.observedAt`);
    if (
      !Array.isArray(scenario.assertions) ||
      scenario.assertions.length < 1 ||
      scenario.assertions.length > 64 ||
      new Set(scenario.assertions).size !== scenario.assertions.length ||
      scenario.assertions.some((assertion) => !ASSERTION_PATTERN.test(assertion))
    ) {
      fail(`${label}.assertions are invalid or outside their bound`);
    }
    if (!Array.isArray(scenario.evidence) || scenario.evidence.length < 1 || scenario.evidence.length > 32) {
      fail(`${label}.evidence is outside its bound`);
    }
    scenario.evidence.forEach((evidence, evidenceIndex) =>
      fileEvidence(evidence, `${label}.evidence[${evidenceIndex}]`),
    );
  }
  return scenarios;
}

function validateObservationEntries(observations) {
  exactSet(observations, OBSERVATION_SYSTEMS, "observation");
  for (const [index, observation] of observations.entries()) {
    const label = `observations[${index}]`;
    exactFields(observation, ["system", "observedAt", "url", "ids", "evidence"], label);
    if (!OBSERVATION_SYSTEMS.includes(observation.system)) fail(`${label}.system is invalid`);
    timestamp(observation.observedAt, `${label}.observedAt`);
    observationUrl(observation.url, observation.system, `${label}.url`);
    if (
      !Array.isArray(observation.ids) ||
      observation.ids.length < 1 ||
      observation.ids.length > 16 ||
      new Set(observation.ids).size !== observation.ids.length
    ) {
      fail(`${label}.ids are invalid or outside their bound`);
    }
    observation.ids.forEach((id, idIndex) => boundedString(id, `${label}.ids[${idIndex}]`));
    fileEvidence(observation.evidence, `${label}.evidence`);
  }
  return observations;
}

function validateArtifacts(artifacts) {
  exactFields(artifacts, ["frames", "screenshots"], "artifacts");
  const bounds = {
    frames: [1, 32],
    screenshots: [2, 32],
  };
  for (const [kind, [minimum, maximum]] of Object.entries(bounds)) {
    const entries = artifacts[kind];
    if (!Array.isArray(entries) || entries.length < minimum || entries.length > maximum) {
      fail(`artifacts.${kind} is outside its bound`);
    }
    const expectedType = kind === "frames" ? "live" : "contract";
    entries.forEach((entry, index) => {
      visualEvidence(entry, `artifacts.${kind}[${index}]`);
      if (entry.evidenceType !== expectedType) fail(`artifacts.${kind} must be ${expectedType} evidence`);
    });
  }
  const viewports = new Set(artifacts.screenshots.map(({ viewport }) => viewport));
  if (!viewports.has("desktop") || !viewports.has("mobile")) {
    fail("artifacts.screenshots must include desktop and mobile contract evidence");
  }
  return artifacts;
}

export function validateImagePublicationManifest(manifest) {
  exactFields(manifest, ["schemaVersion", "source", "images"], "image publication manifest");
  if (manifest.schemaVersion !== "t4-cluster-images/1") fail("image publication schemaVersion is invalid");
  validateSource(manifest.source);
  validateImageEntries(manifest.images, manifest.source.commit);
  return manifest;
}

export function validateProofManifest(manifest) {
  exactFields(
    manifest,
    ["schemaVersion", "source", "images", "scenarios", "observations", "artifacts"],
    "manifest",
  );
  if (manifest.schemaVersion !== "t4-cluster-proof/1") fail("schemaVersion is invalid");
  validateSource(manifest.source);
  validateImageEntries(manifest.images, manifest.source.commit);
  validateScenarioEntries(manifest.scenarios);
  validateObservationEntries(manifest.observations);
  validateArtifacts(manifest.artifacts);
  return manifest;
}

function redactValue(value, key, depth) {
  if (depth > MAX_DEPTH) fail("frame exceeded its depth bound");
  if (SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 16_384 ? value : fail("frame string exceeded its bound");
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) fail("frame array exceeded its bound");
    return value.map((item) => redactValue(item, "", depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_OBJECT_FIELDS) fail("frame object exceeded its bound");
    return Object.fromEntries(entries.map(([field, item]) => [field, redactValue(item, field, depth + 1)]));
  }
  fail("frame contained an unsupported value");
}

export function redactFrame(frame) {
  object(frame, "frame");
  const redacted = redactValue(frame, "", 0);
  if (Buffer.byteLength(JSON.stringify(redacted)) > MAX_FRAME_BYTES) fail("frame exceeded its byte bound");
  return redacted;
}

export async function createFileEvidence(
  absolutePath,
  { artifactRoot = process.cwd(), artifactPrefix } = {},
) {
  const root = resolve(artifactRoot);
  const target = resolve(absolutePath);
  const relativePath = relative(root, target);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    fail("evidence file must be inside its artifact root");
  }
  const bytes = await readFile(target);
  if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
    fail("evidence file is empty or exceeded its size bound");
  }
  const path = artifactPrefix
    ? `${artifactPrefix.replace(/\/$/u, "")}/${basename(relativePath)}`
    : relativePath.split(sep).join("/");
  if (!ARTIFACT_PATH_PATTERN.test(path) || path.includes("..")) {
    fail("evidence path must stay inside artifacts/cluster-proof");
  }
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
