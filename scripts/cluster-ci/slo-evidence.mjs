/**
 * Strict validator for the startup/failover SLO evidence ledger.
 *
 * The schema in slo-evidence.schema.json describes the shape. This module
 * enforces the part a schema cannot: that a target is never mistaken for an
 * observation, that a "measured" claim carries the complete identity of what
 * was measured, and that an "unmeasured" entry carries no number at all.
 */
import Ajv2020 from "ajv/dist/2020.js";

import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyAuthorizedSignedProvenance, verifyProvenance } from "./assemble-image-manifest.mjs";
import { validateImagePublicationManifest } from "./proof-contract.mjs";
import {
  SLO_REQUIRED_RUN_FILES,
  parseSloCommands,
  parseSloEvents,
  parseSloIdentity,
  parseSloRunManifest,
} from "./slo-run-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SLO_EVIDENCE_SCHEMA_PATH = join(HERE, "slo-evidence.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat("date-time", {
  type: "string",
  validate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/u.exec(value);
    if (!match) return false;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return false;
    const date = new Date(parsed);
    return date.getUTCFullYear() === Number(match[1])
      && date.getUTCMonth() + 1 === Number(match[2])
      && date.getUTCDate() === Number(match[3])
      && date.getUTCHours() === Number(match[4])
      && date.getUTCMinutes() === Number(match[5])
      && date.getUTCSeconds() === Number(match[6]);
  },
});
const validateSloEvidenceSchema = ajv.compile(
  JSON.parse(await readFile(SLO_EVIDENCE_SCHEMA_PATH, "utf8")),
);
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const SLO_EVIDENCE_PATH = join(REPOSITORY_ROOT, "compat", "cluster-slo-evidence-v1.json");
export const SLO_SCHEMA_VERSION = "t4-cluster-slo-evidence/1";

const IDENTIFIER = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ARTIFACT_PATH = /^artifacts\/cluster-slo\/(?!.*(?:\/\.\.?\/|\/\.\.?$))[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const RUN_MANIFEST_NAME = "run-manifest.json";
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const SAMPLE_HEADER = "iteration\tstatus\tseconds\tdetail";
const SAMPLE_STATUSES = new Set(["ok", "timeout", "refused", "failed"]);
const HARNESS = "scripts/cluster-ci/measure-slo.sh";
const STATISTICS = new Set(["min", "median", "mean", "p95", "p99", "max", "sum"]);
const UNITS = new Set(["seconds", "milliseconds", "count", "ratio"]);
const IMAGE_COMPONENTS = Object.freeze(["controller", "cluster-server", "session-runtime"]);
const IMAGE_COMPONENT_SET = new Set(IMAGE_COMPONENTS);
const COMPARATORS = new Set(["at-most", "at-least"]);
/** Fields that only ever belong to a measured observation. */
const RESULT_FIELDS = Object.freeze([
  "environmentId",
  "observedAt",
  "iterations",
  "timeoutSeconds",
  "statistic",
  "value",
  "unit",
  "failures",
  "rawArtifact",
]);
const MINIMUM_ITERATIONS = 5;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function sameCanonicalJson(left, right) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function schemaFailures(document) {
  if (validateSloEvidenceSchema(document)) return [];
  return (validateSloEvidenceSchema.errors ?? []).map((error) => {
    const location = error.instancePath || "/";
    return `schema ${location} ${error.message}`;
  });
}

/**
 * @returns {string[]} every violation. An empty array means the ledger is
 * internally consistent and makes no unsupported claim.
 */
export function collectSloEvidenceFailures(document) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (!isPlainObject(document)) return ["SLO evidence must be an object"];
  const invalidSchema = schemaFailures(document);
  if (invalidSchema.length > 0) return invalidSchema;
  if (document.schemaVersion !== SLO_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SLO_SCHEMA_VERSION}`);
  }

  const targets = Array.isArray(document.targets) ? document.targets : [];
  const observations = Array.isArray(document.observations) ? document.observations : [];
  const images = Array.isArray(document.images) ? document.images : [];
  const environments = Array.isArray(document.environments) ? document.environments : [];
  if (targets.length === 0) fail("targets must not be empty");
  if (observations.length === 0) fail("observations must not be empty");
  if (images.length === 0) fail("images must not be empty");

  const targetIds = new Set();
  for (const target of targets) {
    const id = target?.id;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) {
      fail(`target id ${JSON.stringify(id)} is not a kebab-case identifier`);
      continue;
    }
    if (targetIds.has(id)) fail(`target ${id} is declared twice`);
    targetIds.add(id);
    if (!STATISTICS.has(target.statistic)) fail(`target ${id} has an unknown statistic`);
    if (!UNITS.has(target.unit)) fail(`target ${id} has an unknown unit`);
    if (!COMPARATORS.has(target.comparator)) fail(`target ${id} has an unknown comparator`);
    if (target.unit === "count" && target.statistic !== "sum") {
      fail(`target ${id} measures a count and must use the sum statistic`);
    }
    for (const field of ["scenario", "metric", "rationale"]) {
      if (typeof target[field] !== "string" || target[field].trim().length < 24) {
        fail(`target ${id}.${field} must state the objective precisely`);
      }
    }
    if (target.status === "set") {
      const validValue = typeof target.value === "number"
        && (target.unit === "count" ? target.value >= 0 : target.value > 0);
      if (!validValue) {
        fail(`target ${id} is set but has no valid threshold`);
      }
    } else if (target.status === "unset") {
      if (target.value !== null) fail(`target ${id} is unset and must carry a null value`);
    } else {
      fail(`target ${id}.status must be set or unset`);
    }
  }

  const imageComponents = new Set();
  for (const image of images) {
    const component = image.component;
    if (!IMAGE_COMPONENT_SET.has(component)) {
      fail(`image component ${JSON.stringify(component)} is not part of the exact measured image set`);
      continue;
    }
    if (imageComponents.has(component)) fail(`image component ${component} is declared twice`);
    imageComponents.add(component);
    if ((image.reference === null) !== (image.digest === null)) {
      fail(`image component ${component} must set reference and digest together`);
    }
    if (typeof image.reference === "string" && image.reference.includes("@")) {
      const embeddedDigest = image.reference.slice(image.reference.lastIndexOf("@") + 1);
      if (embeddedDigest !== image.digest) {
        fail(`image component ${component} reference digest does not match its digest field`);
      }
    }
  }
  for (const component of IMAGE_COMPONENTS) {
    if (!imageComponents.has(component)) fail(`image component ${component} is missing from the exact measured image set`);
  }

  const environmentIds = new Set();
  for (const environment of environments) {
    const id = environment?.id;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) {
      fail(`environment id ${JSON.stringify(id)} is not a kebab-case identifier`);
      continue;
    }
    if (environmentIds.has(id)) fail(`environment ${id} is declared twice`);
    environmentIds.add(id);
    for (const field of [
      "kubernetesVersion",
      "nodeDescription",
      "storageDriver",
      "workspaceStorageClass",
      "runtimeStateStorageClass",
      "runtimeStateAccessMode",
    ]) {
      if (typeof environment[field] !== "string" || environment[field].length === 0) {
        fail(`environment ${id}.${field} is required`);
      }
    }
    if (!Number.isInteger(environment.nodeCount) || environment.nodeCount < 1) {
      fail(`environment ${id}.nodeCount must be a positive integer`);
    }
    if (typeof environment.imagePrePulled !== "boolean") {
      fail(`environment ${id}.imagePrePulled must be a boolean`);
    }
    const fingerprint = environment.fingerprint;
    if (fingerprint === null) continue;
    const contextEntries = Array.isArray(fingerprint.contexts)
      ? fingerprint.contexts
      : [{ context: null, fingerprint }];
    if (Array.isArray(fingerprint.contexts)) {
      const contexts = contextEntries.map((entry) => entry.context);
      if (
        new Set(contexts).size !== contexts.length ||
        contexts.some((context, index) => index > 0 && contexts[index - 1].localeCompare(context) >= 0)
      ) {
        fail(`environment ${id}.fingerprint contexts must be unique and sorted`);
      }
      const clusterUids = contextEntries.map((entry) => entry.fingerprint.clusterUid);
      if (new Set(clusterUids).size !== clusterUids.length) {
        fail(`environment ${id}.fingerprint contexts must identify distinct clusters`);
      }
    }
    for (const entry of contextEntries) {
      const live = entry.fingerprint;
      if (live.kubernetesVersion !== environment.kubernetesVersion) {
        fail(`environment ${id}.fingerprint kubernetesVersion does not match its declared environment`);
      }
      if (live.nodes.length !== environment.nodeCount) {
        fail(`environment ${id}.fingerprint node count does not match nodeCount`);
      }
      if (new Set(live.nodes.map((node) => node.uid)).size !== live.nodes.length) {
        fail(`environment ${id}.fingerprint node UIDs must be unique`);
      }
      if (live.release.imagePrePull !== environment.imagePrePulled) {
        fail(`environment ${id}.fingerprint image pre-pull state does not match its declared environment`);
      }
      if (!live.runtimePvcAccessModes.includes(environment.runtimeStateAccessMode)) {
        fail(`environment ${id}.fingerprint does not include runtimeStateAccessMode`);
      }
      const storageByName = new Map(
        live.storageClasses.map((storageClass) => [storageClass.name, storageClass.provisioner]),
      );
      for (const storageClass of [environment.workspaceStorageClass, environment.runtimeStateStorageClass]) {
        if (storageByName.get(storageClass) !== environment.storageDriver) {
          fail(`environment ${id}.fingerprint does not bind ${storageClass} to storageDriver`);
        }
      }
    }
  }

  const covered = new Set();
  const observedTargetIds = new Set();
  let measuredCount = 0;
  for (const observation of observations) {
    const targetId = observation?.targetId;
    if (typeof targetId !== "string" || !targetIds.has(targetId)) {
      fail(`observation names unknown target ${JSON.stringify(targetId)}`);
      continue;
    }
    if (observedTargetIds.has(targetId)) fail(`target ${targetId} has more than one observation`);
    observedTargetIds.add(targetId);
    covered.add(targetId);
    if (typeof observation.harness !== "string" || observation.harness.length === 0) {
      fail(`observation for ${targetId} must name the harness that would produce it`);
    }

    if (observation.status === "unmeasured") {
      // The whole point of this file: an unmeasured entry must not be able to
      // look like a result to a reader or to a downstream tool.
      for (const field of RESULT_FIELDS) {
        if (Object.hasOwn(observation, field)) {
          fail(`observation for ${targetId} is unmeasured but carries ${field}`);
        }
      }
      if (typeof observation.reason !== "string" || observation.reason.trim().length < 16) {
        fail(`observation for ${targetId} is unmeasured and must say why`);
      }
      if (typeof observation.blockedBy !== "string" || observation.blockedBy.length === 0) {
        fail(`observation for ${targetId} is unmeasured and must name what blocks it`);
      }
      continue;
    }

    if (observation.status !== "measured") {
      fail(`observation for ${targetId} has status ${JSON.stringify(observation.status)}`);
      continue;
    }

    measuredCount += 1;
    for (const field of RESULT_FIELDS) {
      if (!Object.hasOwn(observation, field)) {
        fail(`measured observation for ${targetId} is missing ${field}`);
      }
    }
    if (Object.hasOwn(observation, "reason") || Object.hasOwn(observation, "blockedBy")) {
      fail(`measured observation for ${targetId} must not carry an unmeasured reason`);
    }
    if (!environmentIds.has(observation.environmentId)) {
      fail(`measured observation for ${targetId} references unknown environment ${observation.environmentId}`);
    }
    const measuredEnvironment = environments.find((environment) => environment.id === observation.environmentId);
    if (measuredEnvironment && !isPlainObject(measuredEnvironment.fingerprint)) {
      fail(`measured observation for ${targetId} requires a live environment fingerprint`);
    }
    if (typeof observation.observedAt !== "string" || !TIMESTAMP.test(observation.observedAt)) {
      fail(`measured observation for ${targetId} needs a UTC observedAt timestamp`);
    }
    if (!Number.isInteger(observation.iterations) || observation.iterations < MINIMUM_ITERATIONS) {
      fail(`measured observation for ${targetId} needs at least ${MINIMUM_ITERATIONS} iterations`);
    }
    if (isPlainObject(measuredEnvironment?.fingerprint)) {
      const coldEnvironment = targetId === "control-plane-cold-start" ||
        targetId === "session-cold-first-attach";
      const fleet = Array.isArray(measuredEnvironment.fingerprint.contexts);
      if (coldEnvironment !== fleet) {
        fail(`measured observation for ${targetId} has the wrong environment fingerprint shape`);
      } else if (fleet && measuredEnvironment.fingerprint.contexts.length !== observation.iterations) {
        fail(`measured observation for ${targetId} must bind one cold environment context per iteration`);
      }
    }
    if (typeof observation.timeoutSeconds !== "number" || !(observation.timeoutSeconds > 0)) {
      fail(`measured observation for ${targetId} needs a positive timeoutSeconds`);
    }
    if (typeof observation.value !== "number" || !(observation.value >= 0)) {
      fail(`measured observation for ${targetId} needs a non-negative value`);
    }
    if (observation.failures !== 0) {
      fail(`measured observation for ${targetId} must have zero failures`);
    }
    const target = targets.find((entry) => entry.id === targetId);
    if (target && observation.statistic !== target.statistic) {
      fail(`measured observation for ${targetId} reports ${observation.statistic} but the target is ${target.statistic}`);
    }
    if (target && observation.unit !== target.unit) {
      fail(`measured observation for ${targetId} reports ${observation.unit} but the target is ${target.unit}`);
    }
    const raw = observation.rawArtifact;
    if (
      !isPlainObject(raw) ||
      Object.keys(raw).sort().join(",") !== "bytes,path,sha256" ||
      !ARTIFACT_PATH.test(raw.path ?? "") ||
      !raw.path.endsWith(`/${RUN_MANIFEST_NAME}`) ||
      !SHA256.test(raw.sha256 ?? "") ||
      !Number.isSafeInteger(raw.bytes) ||
      raw.bytes < 1 ||
      raw.bytes > MAX_EVIDENCE_FILE_BYTES
    ) {
      fail(`measured observation for ${targetId} needs a hashed and sized run manifest under artifacts/cluster-slo/`);
    }
  }

  for (const id of targetIds) {
    if (!covered.has(id)) fail(`target ${id} has no observation, not even an unmeasured one`);
  }

  // Identity is only mandatory once something is actually claimed. Requiring it
  // up front would push an author to invent a commit or a digest.
  const commit = document.source?.commit ?? null;
  if (measuredCount > 0) {
    if (typeof commit !== "string" || !COMMIT.test(commit)) {
      fail("a measured ledger must record the exact source commit under test");
    }
    if (!isPlainObject(document.build)) {
      fail("a measured ledger must record the exact build configuration under test");
    }
    for (const image of images) {
      if (typeof image?.digest !== "string" || !DIGEST.test(image.digest)) {
        fail(`a measured ledger must record an immutable digest for ${image?.component}`);
      }
      if (typeof image?.reference !== "string" || image.reference.length === 0) {
        fail(`a measured ledger must record a repository reference for ${image?.component}`);
      }
    }
    if (environments.length === 0) {
      fail("a measured ledger must record at least one environment");
    }
  } else if (commit !== null && !COMMIT.test(commit)) {
    fail("source.commit must be null or an exact 40-character commit");
  }

  return failures;
}

function canonicalArtifactPath(path, repositoryRoot) {
  const candidate = relative(repositoryRoot, path).split("\\").join("/");
  if (
    candidate.startsWith("../") ||
    isAbsolute(candidate) ||
    !candidate.startsWith("artifacts/cluster-slo/")
  ) {
    throw new Error(`raw artifact is outside repository artifacts/cluster-slo: ${path}`);
  }
  return candidate;
}

async function evidenceFile(path, expectedName, runDirectory) {
  const resolved = resolve(path);
  const relativeName = relative(runDirectory, resolved).split(sep).join("/");
  if (relativeName !== expectedName || relativeName.startsWith("../") || isAbsolute(relativeName)) {
    throw new Error(`${expectedName} is outside the run directory or is not canonical`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error(`${expectedName} traverses a symlink or non-canonical path`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new Error(`${expectedName} is not a regular file`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`${expectedName} exceeds the evidence file byte ceiling or is empty`);
  }
  const source = await readFile(canonical);
  if (source.byteLength !== metadata.size) throw new Error(`${expectedName} changed while it was read`);
  return {
    bytes: source.byteLength,
    sha256: createHash("sha256").update(source).digest("hex"),
    source,
  };
}

export async function verifySloRawArtifact(rawArtifact, repositoryRoot = REPOSITORY_ROOT) {
  if (
    !isPlainObject(rawArtifact) ||
    Object.keys(rawArtifact).sort().join(",") !== "bytes,path,sha256" ||
    !ARTIFACT_PATH.test(rawArtifact.path ?? "") ||
    !rawArtifact.path.endsWith(`/${RUN_MANIFEST_NAME}`) ||
    !SHA256.test(rawArtifact.sha256 ?? "") ||
    !Number.isSafeInteger(rawArtifact.bytes) ||
    rawArtifact.bytes < 1 ||
    rawArtifact.bytes > MAX_EVIDENCE_FILE_BYTES
  ) {
    throw new Error("rawArtifact does not identify a hashed and sized run manifest");
  }
  const root = resolve(repositoryRoot);
  const manifestPath = resolve(root, rawArtifact.path);
  if (canonicalArtifactPath(manifestPath, root) !== rawArtifact.path) {
    throw new Error("rawArtifact path is not canonical");
  }
  const runDirectory = dirname(manifestPath);
  const manifestFile = await evidenceFile(manifestPath, RUN_MANIFEST_NAME, runDirectory);
  if (manifestFile.bytes !== rawArtifact.bytes || manifestFile.sha256 !== rawArtifact.sha256) {
    throw new Error("run manifest does not match rawArtifact");
  }
  let manifest;
  try {
    manifest = parseSloRunManifest(JSON.parse(manifestFile.source.toString("utf8")));
  } catch (error) {
    throw new Error(`run manifest is invalid: ${error.message}`, { cause: error });
  }
  const sources = new Map();
  for (const expected of manifest.files) {
    const actual = await evidenceFile(resolve(runDirectory, expected.name), expected.name, runDirectory);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`${expected.name} does not match the run manifest`);
    }
    sources.set(expected.name, actual.source);
  }
  return { manifest, sources };
}

function parseBoundSamples(source) {
  const lines = source.toString("utf8").split("\n").filter((line) => line.length > 0);
  if (lines.shift() !== SAMPLE_HEADER) throw new Error("samples.tsv has an invalid header");
  return lines.map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== 4) throw new Error(`samples.tsv row ${index + 1} has an invalid field count`);
    const [iteration, status, seconds, detail] = fields;
    const parsedIteration = Number(iteration);
    const parsedSeconds = Number(seconds);
    if (!Number.isSafeInteger(parsedIteration) || parsedIteration !== index + 1) {
      throw new Error("samples.tsv iterations are not the exact ordered set 1..N");
    }
    if (!SAMPLE_STATUSES.has(status)) throw new Error(`samples.tsv has unknown status ${status}`);
    if (!Number.isFinite(parsedSeconds) || parsedSeconds < 0) throw new Error("samples.tsv has an invalid duration");
    return { status, seconds: parsedSeconds, detail };
  });
}

function statistic(name, values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("cannot recompute a statistic over zero samples");
  if (name === "min") return sorted[0];
  if (name === "max") return sorted.at(-1);
  if (name === "mean") return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  if (name === "sum") return sorted.reduce((sum, value) => sum + value, 0);
  if (name === "median") return sorted.length % 2 === 1
    ? sorted[(sorted.length - 1) / 2]
    : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  if (name === "p95") return sorted[Math.ceil(0.95 * sorted.length) - 1];
  if (name === "p99") return sorted[Math.ceil(0.99 * sorted.length) - 1];
  throw new Error(`cannot recompute unknown statistic ${name}`);
}

function parseJsonSource(source, label) {
  try {
    return JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

async function verifyPublicationAndSourceSnapshots(document, identity, sources) {
  const publicationSource = sources.get("publication/image-publication.json");
  if (!publicationSource) throw new Error("run bundle is missing the publication manifest snapshot");
  if (
    createHash("sha256").update(publicationSource).digest("hex") !==
    identity.build.imagePublicationManifest.sha256
  ) {
    throw new Error("publication manifest snapshot does not match identity.json");
  }
  let publication;
  try {
    publication = validateImagePublicationManifest(parseJsonSource(publicationSource, "publication manifest snapshot"));
  } catch (error) {
    throw new Error(`publication manifest snapshot is invalid: ${error.message}`, { cause: error });
  }
  if (publication.schemaVersion !== "t4-cluster-images/1" || publication.source.commit !== document.source.commit) {
    throw new Error("publication manifest snapshot does not bind the measured source");
  }
  const expectedBundleNames = [
    ...SLO_REQUIRED_RUN_FILES,
    "publication/image-publication.json",
    "source/source-identity.json",
    "source/head-tree.txt",
    "source/repository-tree.sha256",
    "source/harness-tree.sha256",
    ...publication.images.flatMap((image) => [
      `publication/${image.component}.provenance.jsonl`,
      `publication/${image.component}.provenance.sigstore.jsonl`,
    ]),
    ...(identity.source.dirty ? ["source/retained.patch"] : []),
  ].sort();
  const actualBundleNames = [...sources.keys()].sort();
  if (!sameCanonicalJson(actualBundleNames, expectedBundleNames)) {
    throw new Error("run bundle contains a missing or unexplained file");
  }
  for (const image of publication.images) {
    const ledgerImage = document.images.find((candidate) => candidate.component === image.component);
    if (
      ledgerImage?.digest !== image.digest ||
      ledgerImage?.reference !== image.reference ||
      image.provenance.mode !== "cosign-keyless"
    ) {
      throw new Error(`${image.component} publication does not bind the exact signed measured image`);
    }
    const provenanceName = `publication/${image.component}.provenance.jsonl`;
    const bundleName = `publication/${image.component}.provenance.sigstore.jsonl`;
    const provenanceSource = sources.get(provenanceName);
    const bundleSource = sources.get(bundleName);
    if (!provenanceSource || !bundleSource) {
      throw new Error(`${image.component} provenance bundle is incomplete`);
    }
    if (createHash("sha256").update(provenanceSource).digest("hex") !== image.provenance.sha256) {
      throw new Error(`${image.component} provenance snapshot does not match the publication manifest`);
    }
    if (
      bundleSource.byteLength !== image.provenance.bundle.bytes ||
      createHash("sha256").update(bundleSource).digest("hex") !== image.provenance.bundle.sha256
    ) {
      throw new Error(`${image.component} Sigstore bundle does not match the publication manifest`);
    }
    await verifyAuthorizedSignedProvenance(
      provenanceSource.toString("utf8"),
      bundleSource.toString("utf8"),
      {
        certificateIdentity: image.provenance.certificateIdentity,
        certificateIdentityType: image.provenance.certificateIdentityType,
        certificateIssuer: image.provenance.certificateIssuer,
      },
    );
    const slash = image.repository.lastIndexOf("/");
    const evidenceRepository = `${image.repository.slice(0, slash)}/quarantine/${image.repository.slice(slash + 1)}`;
    verifyProvenance(provenanceSource.toString("utf8"), {
      repository: evidenceRepository,
      digest: image.digest,
      commit: document.source.commit,
      platform: identity.build.platform,
      architecture: identity.build.architecture,
    });
  }
  const sourceIdentity = sources.get("source/source-identity.json");
  if (!sourceIdentity || !sameCanonicalJson(parseJsonSource(sourceIdentity, "source identity snapshot"), identity.source)) {
    throw new Error("run bundle does not retain the exact source identity input");
  }
  const sourceHashSnapshots = [
    ["source/head-tree.txt", identity.source.headTreeHash],
    ["source/repository-tree.sha256", identity.source.repositoryTreeHash],
    ["source/harness-tree.sha256", identity.source.harnessTreeHash],
  ];
  for (const [name, expected] of sourceHashSnapshots) {
    if (sources.get(name)?.toString("utf8") !== `${expected}\n`) {
      throw new Error(`${name} does not retain the exact measured source input`);
    }
  }
  if (identity.source.dirty) {
    const retainedPatch = sources.get("source/retained.patch");
    if (
      !retainedPatch ||
      retainedPatch.byteLength !== identity.source.retainedPatch.size ||
      createHash("sha256").update(retainedPatch).digest("hex") !== identity.source.retainedPatch.sha256
    ) {
      throw new Error("dirty measured source does not retain its exact content-addressed patch");
    }
  } else if (sources.has("source/retained.patch")) {
    throw new Error("clean measured source bundle contains an unexplained patch");
  }
}

export async function validateBoundObservation(document, observation, target, verified) {
  let identity;
  try {
    identity = parseSloIdentity(parseJsonSource(verified.sources.get("identity.json"), "identity.json"));
  } catch (error) {
    throw new Error(`identity.json is invalid: ${error.message}`, { cause: error });
  }
  const expectedScenario = target.id.endsWith("-correctness")
    ? target.id.slice(0, -"-correctness".length)
    : target.id;
  if (observation.harness !== `${HARNESS} --run ${expectedScenario}`) {
    throw new Error(`observation harness does not match target ${target.id}`);
  }
  const scenario = observation.harness.startsWith(`${HARNESS} --run `)
    ? observation.harness.slice(`${HARNESS} --run `.length)
    : null;
  const expectedIdentity = [
    ["scenario", scenario],
    ["sourceCommit", document.source?.commit],
    ["environmentId", observation.environmentId],
    ["startedAt", observation.observedAt],
    ["iterations", observation.iterations],
  ];
  for (const [field, expected] of expectedIdentity) {
    if (identity?.[field] !== expected) throw new Error(`identity.json ${field} does not match the observation`);
  }
  const boundBuild = Object.fromEntries(
    Object.keys(document.build).map((key) => [key, identity?.build?.[key]]),
  );
  if (!sameCanonicalJson(boundBuild, document.build)) {
    throw new Error("identity.json build does not match the ledger");
  }
  const publication = identity?.build?.imagePublicationManifest;
  if (
    !isPlainObject(publication) ||
    Object.keys(publication).sort().join(",") !== "measuredImages,path,sha256,size,source" ||
    !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,510}$/u.test(publication.path ?? "") ||
    !SHA256.test(publication.sha256 ?? "") ||
    !Number.isSafeInteger(publication.size) ||
    publication.size < 1 ||
    publication.size > MAX_EVIDENCE_FILE_BYTES ||
    publication.source?.commit !== document.source.commit ||
    !Array.isArray(publication.measuredImages) ||
    publication.measuredImages.length !== IMAGE_COMPONENTS.length ||
    publication.measuredImages.some((component) => !IMAGE_COMPONENT_SET.has(component)) ||
    new Set(publication.measuredImages).size !== IMAGE_COMPONENTS.length
  ) {
    throw new Error("identity.json image publication manifest does not bind the measured build");
  }
  if (
    !isPlainObject(identity?.source) ||
    Object.keys(identity.source).sort().join(",") !== "commit,dirty,harnessTreeHash,headTreeHash,repositoryTreeHash,retainedPatch" ||
    identity?.source?.commit !== document.source.commit ||
    !COMMIT.test(identity?.source?.headTreeHash ?? "") ||
    !SHA256.test(identity?.source?.repositoryTreeHash ?? "") ||
    !SHA256.test(identity?.source?.harnessTreeHash ?? "") ||
    typeof identity?.source?.dirty !== "boolean" ||
    (identity.source.dirty === false && identity.source.retainedPatch !== null) ||
    (identity.source.dirty === true && (
      !isPlainObject(identity.source.retainedPatch) ||
      !String(identity.source.retainedPatch.path ?? "").startsWith("artifacts/cluster-slo/retained-source/") ||
      !SHA256.test(identity.source.retainedPatch.sha256 ?? "") ||
      !Number.isSafeInteger(identity.source.retainedPatch.size) ||
      identity.source.retainedPatch.size < 1 ||
      identity.source.retainedPatch.size > MAX_EVIDENCE_FILE_BYTES
    ))
  ) {
    throw new Error("identity.json source does not completely identify the measured source tree");
  }
  if (
    identity?.warmupIterations !== 0 ||
    !isPlainObject(identity?.deadlines) ||
    Object.keys(identity.deadlines).sort().join(",") !== "cleanupSeconds,iterationSeconds,operationSeconds,wholeRunSeconds" ||
    Object.values(identity.deadlines).some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0) ||
    identity.deadlines.iterationSeconds !== observation.timeoutSeconds ||
    identity.timeoutSeconds !== identity.deadlines.operationSeconds
  ) {
    throw new Error("identity.json deadlines or warmup boundary do not match the observation");
  }
  if (
    typeof identity?.ledger?.snapshot !== "string" ||
    createHash("sha256").update(identity.ledger.snapshot).digest("hex") !== identity?.ledger?.sha256
  ) {
    throw new Error("identity.json does not retain the exact input ledger snapshot");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(identity.ledger.snapshot);
  } catch {
    throw new Error("identity.json input ledger snapshot is not valid JSON");
  }
  const boundTarget = snapshot.targets?.find((candidate) => candidate?.id === target.id);
  if (
    !isPlainObject(boundTarget) ||
    Object.keys(boundTarget).sort().join(",") !== Object.keys(target).sort().join(",") ||
    Object.keys(target).some((key) => boundTarget[key] !== target[key])
  ) {
    throw new Error("input ledger target does not match the current ledger");
  }
  for (const field of ["source", "build", "images", "environments", "targets"]) {
    if (JSON.stringify(snapshot[field]) !== JSON.stringify(document[field])) {
      throw new Error(`input ledger ${field} do not match the current ledger`);
    }
  }
  const environment = document.environments?.find((candidate) => candidate?.id === observation.environmentId);
  if (
    !isPlainObject(snapshot.environments?.find((candidate) => candidate?.id === observation.environmentId)) ||
    !isPlainObject(identity?.ledger?.environment) ||
    !isPlainObject(environment) ||
    !sameCanonicalJson(identity.ledger.environment, environment)
  ) {
    throw new Error("identity.json environment does not match the ledger");
  }
  const snapshotEnvironment = snapshot.environments.find((candidate) => candidate.id === observation.environmentId);
  if (!sameCanonicalJson(snapshotEnvironment, environment)) {
    throw new Error("input ledger environment does not match the current ledger");
  }
  const fleet = Array.isArray(environment.fingerprint.contexts)
    ? new Map(environment.fingerprint.contexts.map((entry) => [entry.context, entry.fingerprint]))
    : null;
  const expectedForContext = (context) => fleet === null ? environment.fingerprint : fleet.get(context);
  const coldEnvironment = scenario === "control-plane-cold-start" ||
    scenario === "session-cold-first-attach";
  if ((coldEnvironment && fleet === null) || (!coldEnvironment && fleet !== null)) {
    throw new Error("ledger environment fingerprint shape does not match cold or reused-context scenario");
  }
  const identityClusterContexts = Array.isArray(identity?.clusters)
    ? new Set(identity.clusters.map((cluster) => cluster?.context))
    : new Set();
  if (
    !Array.isArray(identity?.clusters) ||
    identity.clusters.length !== observation.iterations ||
    (fleet !== null && (
      fleet.size !== observation.iterations ||
      identityClusterContexts.size !== fleet.size ||
      [...fleet.keys()].some((context) => !identityClusterContexts.has(context))
    )) ||
    identity.clusters.some((cluster) => {
      const expected = expectedForContext(cluster?.context);
      return !isPlainObject(cluster) ||
        expected === undefined ||
        cluster.uid !== cluster.fingerprint?.clusterUid ||
        !sameCanonicalJson(cluster.fingerprint, expected);
    })
  ) {
    throw new Error("identity.json clusters do not exactly match the ledger environment fingerprint");
  }
  const clusterContexts = new Set(identity.clusters.map((cluster) => cluster.context));
  if (
    !Array.isArray(identity?.environmentIterations) ||
    identity.environmentIterations.length !== observation.iterations ||
    identity.environmentIterations.some((entry, index) => {
      const expected = expectedForContext(entry?.context);
      return entry?.iteration !== index + 1 ||
        !clusterContexts.has(entry.context) ||
        expected === undefined ||
        !sameCanonicalJson(entry.fingerprint, expected);
    })
  ) {
    throw new Error("identity.json environmentIterations do not bind every measured iteration");
  }
  if (snapshot.source?.commit !== document.source?.commit) {
    throw new Error("input ledger source commit does not match the current ledger");
  }

  const imageFields = new Map([
    ["controller", "controller"],
    ["cluster-server", "server"],
    ["session-runtime", "sessionRuntime"],
  ]);
  for (const [component, field] of imageFields) {
    const ledgerImage = document.images?.find((image) => image?.component === component);
    const expectedImage = ledgerImage?.reference?.includes("@")
      ? ledgerImage.reference
      : `${ledgerImage?.reference}@${ledgerImage?.digest}`;
    if (identity?.images?.[field] !== expectedImage) {
      throw new Error(`identity.json ${field} image does not match the ledger reference and digest`);
    }
    const snapshotImage = snapshot.images?.find((image) => image?.component === component);
    if (
      !isPlainObject(snapshotImage) ||
      Object.keys(snapshotImage).sort().join(",") !== Object.keys(ledgerImage).sort().join(",") ||
      Object.keys(ledgerImage).some((key) => snapshotImage[key] !== ledgerImage[key])
    ) {
      throw new Error(`input ledger ${component} image does not match the current ledger`);
    }
  }
  await verifyPublicationAndSourceSnapshots(document, identity, verified.sources);
  const samples = parseBoundSamples(verified.sources.get("samples.tsv"));
  const eventEvidence = parseSloEvents(verified.sources.get("events.jsonl").toString("utf8"), {
    runToken: identity.runToken,
    scenario,
    iterations: observation.iterations,
    deadlineSeconds: observation.timeoutSeconds,
  });
  parseSloCommands(
    verified.sources.get("commands.jsonl").toString("utf8"),
    { runToken: identity.runToken, scenario, iterations: observation.iterations },
    eventEvidence.events,
  );
  if (samples.length !== observation.iterations) throw new Error("samples.tsv row count does not match observation.iterations");
  if (
    samples.some((sample, index) => {
      const derived = eventEvidence.samples[index];
      return sample.status !== derived.status ||
        sample.seconds !== derived.seconds ||
        sample.detail !== derived.detail;
    })
  ) {
    throw new Error("samples.tsv does not exactly derive from the typed event/proof/cleanup chain");
  }
  if (samples.some((sample) => sample.status !== "ok")) throw new Error("a measured observation contains an incomplete sample");
  let value;
  if (target.unit === "count") {
    if (samples.some((sample) => (
      sample.detail.includes("invariant=held") === sample.detail.includes("invariant=violated")
    ))) {
      throw new Error("a measured count must have exactly one invariant verdict per iteration");
    }
    value = statistic(
      target.statistic,
      samples.map((sample) => Number(sample.detail.includes("invariant=violated"))),
    );
  } else {
    value = Math.round(statistic(target.statistic, samples.map((sample) => sample.seconds)) * 1000) / 1000;
  }
  if (observation.failures !== 0) throw new Error("observation failures does not match the complete samples.tsv run");
  if (observation.value !== value) throw new Error(`observation value does not recompute from samples.tsv (expected ${value})`);
}

export async function checkSloEvidenceFile(path = SLO_EVIDENCE_PATH) {
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`SLO evidence ${path} is not valid JSON`, { cause: error });
  }
  const failures = collectSloEvidenceFailures(document);
  if (!isPlainObject(document) || failures.some((failure) => failure.startsWith("schema "))) return failures;
  for (const observation of document.observations ?? []) {
    if (observation?.status !== "measured") continue;
    try {
      const verified = await verifySloRawArtifact(observation.rawArtifact);
      const target = document.targets?.find((candidate) => candidate?.id === observation.targetId);
      if (!target) throw new Error("observation target is unavailable");
      await validateBoundObservation(document, observation, target, verified);
    } catch (error) {
      failures.push(`measured observation for ${observation.targetId} has unverifiable raw evidence: ${error.message}`);
    }
  }
  return failures;
}

/** Human-readable one-line summary distinguishing targets from observations. */
export function summarizeSloEvidence(document) {
  const targets = document.targets ?? [];
  const observations = document.observations ?? [];
  const set = targets.filter((target) => target.status === "set").length;
  const measured = observations.filter((observation) => observation.status === "measured").length;
  return `${targets.length} targets (${set} set, ${targets.length - set} unset), ${observations.length} observations (${measured} measured, ${observations.length - measured} unmeasured)`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const path = process.argv[2] ? resolve(process.argv[2]) : SLO_EVIDENCE_PATH;
  const failures = await checkSloEvidenceFile(path);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`SLO evidence: ${failure}`);
    process.exitCode = 1;
  } else {
    const document = JSON.parse(await readFile(path, "utf8"));
    console.log(`Validated ${path}: ${summarizeSloEvidence(document)}`);
  }
}
