/**
 * Turn one measure-slo.sh run into observation entries for
 * compat/cluster-slo-evidence-v1.json, or refuse.
 *
 * This is the only place a number is allowed to enter the SLO ledger, and it is
 * deliberately hostile about it:
 *
 *   - The targets a run can speak for are read from the ledger itself, by
 *     matching the harness string already recorded against each target. A run
 *     cannot invent a target, and a target cannot be silently skipped.
 *   - A latency observation is emitted as `measured` only when every declared
 *     iteration completed. A percentile over the subset that happened to
 *     succeed is survivorship bias, not a measurement.
 *   - A correctness counter is emitted as `measured` only when every iteration
 *     recorded an explicit `invariant=held` or `invariant=violated` verdict.
 *     Absence of a reported violation is not evidence of no violation.
 *   - Anything else is emitted as `unmeasured` with the reason and the blocker,
 *     which is exactly the shape the ledger already carries.
 *   - The candidate ledger is run through the real validator before anything is
 *     written, so a fragment that would not validate is never produced. That is
 *     what makes a missing image digest, a missing environment record, or a
 *     missing source commit block the observation instead of decorating it.
 *
 * Output is a JSON array of observation objects on stdout, ready to replace the
 * matching entries in the ledger's `observations` list. This tool never writes
 * to the ledger.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SLO_EVIDENCE_PATH,
  collectSloEvidenceFailures,
  verifySloRawArtifact,
  validateBoundObservation,
} from "./slo-evidence.mjs";
import { validateImagePublicationManifest } from "./proof-contract.mjs";
import {
  SLO_REQUIRED_RUN_FILES,
  SLO_RUN_MANIFEST_VERSION,
  parseSloCommands,
  parseSloEvents,
  parseSloIdentity,
  parseSloRunManifest,
} from "./slo-run-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const HARNESS = "scripts/cluster-ci/measure-slo.sh";
export const SAMPLE_HEADER = "iteration\tstatus\tseconds\tdetail";
export const MINIMUM_ITERATIONS = 5;

const INVARIANT_HELD = "invariant=held";
const INVARIANT_VIOLATED = "invariant=violated";
const SAMPLE_STATUSES = new Set(["ok", "timeout", "refused", "failed"]);
const RUN_MANIFEST = "run-manifest.json";
const RUN_FILES = SLO_REQUIRED_RUN_FILES;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;

const OPTIONS = Object.freeze([
  "scenario",
  "samples",
  "observed-at",
  "iterations",
  "timeout-seconds",
  "environment-id",
  "commit",
  "artifact-root",
]);

class RefusalError extends Error {}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !OPTIONS.includes(flag.slice(2))) {
      throw new RefusalError(`unknown argument ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined) throw new RefusalError(`${flag} needs a value`);
    values.set(flag.slice(2), value);
  }
  for (const option of OPTIONS) {
    if (!values.has(option)) throw new RefusalError(`--${option} is required`);
  }
  return Object.fromEntries(values);
}

/**
 * @returns {{iteration: number, status: string, seconds: number, detail: string}[]}
 */
export function parseSamples(source) {
  const lines = source.split("\n").filter((line) => line.length > 0);
  if (lines.shift() !== SAMPLE_HEADER) {
    throw new RefusalError(`samples file must start with the header ${JSON.stringify(SAMPLE_HEADER)}`);
  }
  const samples = lines.map((line, index) => {
    const columns = line.split("\t");
    if (columns.length !== 4) {
      throw new RefusalError(`sample line ${index + 1} does not have four tab-separated columns`);
    }
    const [iteration, status, seconds, detail] = columns;
    const parsedIteration = Number(iteration);
    if (!Number.isSafeInteger(parsedIteration) || parsedIteration < 1) {
      throw new RefusalError(`sample line ${index + 1} has an invalid iteration ${JSON.stringify(iteration)}`);
    }
    if (!SAMPLE_STATUSES.has(status)) {
      throw new RefusalError(`sample line ${index + 1} has unknown status ${JSON.stringify(status)}`);
    }
    const parsedSeconds = Number(seconds);
    if (!Number.isFinite(parsedSeconds) || parsedSeconds < 0) {
      throw new RefusalError(`sample line ${index + 1} has a non-numeric duration ${JSON.stringify(seconds)}`);
    }
    return { iteration: parsedIteration, status, seconds: parsedSeconds, detail };
  });
  for (let index = 0; index < samples.length; index += 1) {
    if (samples[index].iteration !== index + 1) {
      throw new RefusalError(
        `sample iterations must be the exact ordered set 1..N; row ${index + 1} records ${samples[index].iteration}`,
      );
    }
  }
  return samples;
}

/** Nearest-rank percentile; no interpolation between samples that never existed. */
export function statisticOf(name, values) {
  const sorted = [...values].sort((left, right) => left - right);
  const count = sorted.length;
  if (count === 0) throw new RefusalError(`cannot compute ${name} over zero samples`);
  switch (name) {
    case "min":
      return sorted[0];
    case "max":
      return sorted[count - 1];
    case "mean":
      return sorted.reduce((total, value) => total + value, 0) / count;
    case "sum":
      return sorted.reduce((total, value) => total + value, 0);
    case "median":
      return count % 2 === 1
        ? sorted[(count - 1) / 2]
        : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
    case "p95":
      return sorted[Math.ceil(0.95 * count) - 1];
    case "p99":
      return sorted[Math.ceil(0.99 * count) - 1];
    default:
      throw new RefusalError(`unsupported statistic ${name}`);
  }
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

/** Every target whose recorded harness names this scenario, in ledger order. */
export function targetsForScenario(ledger, scenario) {
  const command = `${HARNESS} --run ${scenario}`;
  const targetIds = (ledger.observations ?? [])
    .filter((observation) => observation.harness === command)
    .map((observation) => observation.targetId);
  const targets = (ledger.targets ?? []).filter((target) => targetIds.includes(target.id));
  if (targets.length === 0) {
    throw new RefusalError(
      `no target in the ledger records ${JSON.stringify(command)} as its harness; add the target and its unmeasured observation first`,
    );
  }
  return targets;
}

function unmeasured(target, command, reason, blockedBy) {
  return { targetId: target.id, status: "unmeasured", harness: command, reason, blockedBy };
}

/**
 * @returns {object[]} one observation per target the scenario speaks for.
 */
export function buildObservations({ targets, scenario, samples, options, rawArtifact }) {
  const command = `${HARNESS} --run ${scenario}`;
  const iterations = Number(options.iterations);
  const timeoutSeconds = Number(options["timeout-seconds"]);
  if (!Number.isInteger(iterations) || iterations < MINIMUM_ITERATIONS) {
    throw new RefusalError(`--iterations must be an integer of at least ${MINIMUM_ITERATIONS}`);
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new RefusalError("--timeout-seconds must be a positive number");
  }
  if (samples.length !== iterations) {
    throw new RefusalError(
      `the samples file has ${samples.length} rows but the run declared ${iterations} iterations; a discarded iteration is a deleted measurement`,
    );
  }

  const completed = samples.filter((sample) => sample.status === "ok");
  const incomplete = samples.filter((sample) => sample.status !== "ok");
  const incompleteStatuses = [...new Set(incomplete.map((sample) => sample.status))].sort();

  return targets.map((target) => {
    if (target.unit === "count") {
      const verdicts = samples.map((sample) => {
        const held = sample.detail.includes(INVARIANT_HELD);
        const violated = sample.detail.includes(INVARIANT_VIOLATED);
        if (held === violated) return "unreported-or-ambiguous";
        return violated ? "violated" : "held";
      });
      const unreported = verdicts.filter((verdict) => verdict === "unreported-or-ambiguous").length;
      if (incomplete.length > 0 || unreported > 0) {
        return unmeasured(
          target,
          command,
          `The run recorded ${incomplete.length} incomplete iterations and ${unreported} iterations without exactly one ${INVARIANT_HELD} or ${INVARIANT_VIOLATED} verdict. A missing or ambiguous invariant is not a held invariant, so no count is claimed.`,
          incompleteStatuses.length > 0 ? incompleteStatuses.join(",") : "invariant-verdict-invalid",
        );
      }
      return {
        targetId: target.id,
        status: "measured",
        harness: command,
        environmentId: options["environment-id"],
        observedAt: options["observed-at"],
        iterations,
        timeoutSeconds,
        statistic: target.statistic,
        value: statisticOf("sum", verdicts.map((verdict) => Number(verdict === "violated"))),
        unit: target.unit,
        failures: 0,
        rawArtifact,
      };
    }

    if (incomplete.length > 0) {
      return unmeasured(
        target,
        command,
        `${incomplete.length} of ${iterations} iterations did not complete (${incompleteStatuses.join(", ")}). A ${target.statistic} over the surviving ${completed.length} iterations would describe only the runs that happened to work.`,
        incompleteStatuses.join(","),
      );
    }
    return {
      targetId: target.id,
      status: "measured",
      harness: command,
      environmentId: options["environment-id"],
      observedAt: options["observed-at"],
      iterations,
      timeoutSeconds,
      statistic: target.statistic,
      value: round(statisticOf(target.statistic, completed.map((sample) => sample.seconds))),
      unit: target.unit,
      failures: 0,
      rawArtifact,
    };
  });
}

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function repositoryArtifactPath(path) {
  const candidate = relative(REPOSITORY_ROOT, path).split("\\").join("/");
  if (
    candidate.startsWith("../") ||
    isAbsolute(candidate) ||
    !candidate.startsWith("artifacts/cluster-slo/")
  ) {
    throw new RefusalError(`SLO evidence path is outside repository artifacts/cluster-slo: ${path}`);
  }
  return candidate;
}

async function canonicalRegularFile(path, expectedName, runDirectory) {
  const resolved = resolve(path);
  const relativeName = relative(runDirectory, resolved).split(sep).join("/");
  if (relativeName !== expectedName || relativeName.startsWith("../") || isAbsolute(relativeName)) {
    throw new RefusalError(`${expectedName} must stay inside the canonical run directory`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) {
    throw new RefusalError(`${expectedName} must not traverse a symlink or non-canonical path`);
  }
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new RefusalError(`${expectedName} must be a regular file`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new RefusalError(`${expectedName} exceeds the evidence file byte ceiling or is empty`);
  }
  const source = await readFile(canonical);
  if (source.byteLength !== metadata.size) {
    throw new RefusalError(`${expectedName} changed while the run manifest was assembled`);
  }
  return { name: expectedName, bytes: source.byteLength, sha256: sha256(source), source };
}

function validateRunManifest(manifest) {
  try {
    return parseSloRunManifest(manifest);
  } catch (error) {
    throw new RefusalError(`run manifest is invalid: ${error.message}`);
  }
}

async function verifyManifestFiles(runDirectory, manifest) {
  validateRunManifest(manifest);
  for (const expected of manifest.files) {
    const actual = await canonicalRegularFile(
      resolve(runDirectory, expected.name),
      expected.name,
      runDirectory,
    );
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new RefusalError(`${expected.name} does not match the run manifest`);
    }
  }
}

export async function createAndVerifyRunManifest(samplesPath, artifactRoot, additionalFiles = []) {
  const requestedSamples = resolve(samplesPath);
  const canonicalSamples = await realpath(requestedSamples);
  if (canonicalSamples !== requestedSamples || basename(canonicalSamples) !== "samples.tsv") {
    throw new RefusalError("raw samples must be the canonical samples.tsv file");
  }
  const runDirectory = dirname(canonicalSamples);
  const canonicalRunDirectory = await realpath(runDirectory);
  const canonicalArtifactRoot = await realpath(resolve(artifactRoot));
  if (canonicalRunDirectory !== runDirectory) {
    throw new RefusalError("run directory must not traverse a symlink or non-canonical path");
  }
  const underRoot = relative(canonicalArtifactRoot, canonicalRunDirectory);
  if (underRoot === "" || underRoot.startsWith("..") || isAbsolute(underRoot)) {
    throw new RefusalError("run directory must be strictly beneath the canonical artifact root");
  }
  repositoryArtifactPath(runDirectory);

  const extraNames = [...new Set(additionalFiles)].sort();
  if (extraNames.some((name) => RUN_FILES.includes(name))) {
    throw new RefusalError("additional run manifest files duplicate a required file");
  }
  const files = [];
  for (const name of [...RUN_FILES, ...extraNames]) {
    const entry = await canonicalRegularFile(resolve(runDirectory, name), name, runDirectory);
    files.push({ name: entry.name, bytes: entry.bytes, sha256: entry.sha256 });
  }
  const manifest = { schemaVersion: SLO_RUN_MANIFEST_VERSION, files };
  validateRunManifest(manifest);
  const manifestSource = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = resolve(runDirectory, RUN_MANIFEST);
  try {
    await writeFile(manifestPath, manifestSource, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new RefusalError(`refusing to replace an existing or unwritable ${RUN_MANIFEST}: ${error.message}`);
  }
  const canonicalManifest = await canonicalRegularFile(manifestPath, RUN_MANIFEST, runDirectory);
  if (canonicalManifest.source.toString("utf8") !== manifestSource) {
    throw new RefusalError("run manifest changed while it was written");
  }
  await verifyManifestFiles(runDirectory, manifest);
  return {
    path: repositoryArtifactPath(manifestPath),
    sha256: sha256(canonicalManifest.source),
    bytes: canonicalManifest.bytes,
  };
}


async function writeSnapshot(runDirectory, name, source) {
  const path = resolve(runDirectory, name);
  const relativeName = relative(runDirectory, path).split(sep).join("/");
  if (relativeName !== name || relativeName.startsWith("../") || isAbsolute(relativeName)) {
    throw new RefusalError(`snapshot ${name} escapes the run directory`);
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, source, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new RefusalError(`refusing to replace snapshot ${name}: ${error.message}`);
  }
  return name;
}

async function readRepositorySnapshot(path, expectedSha256, label) {
  const resolved = resolve(REPOSITORY_ROOT, path);
  const relativePath = relative(REPOSITORY_ROOT, resolved).split(sep).join("/");
  if (relativePath !== path || !relativePath.startsWith("artifacts/") || relativePath.includes("../")) {
    throw new RefusalError(`${label} path is outside repository artifacts`);
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new RefusalError(`${label} path is not canonical`);
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_EVIDENCE_FILE_BYTES) throw new RefusalError(`${label} is not a bounded regular file`);
  const source = await readFile(canonical);
  if (source.byteLength !== metadata.size || (expectedSha256 !== null && sha256(source) !== expectedSha256)) throw new RefusalError(`${label} changed or does not match its declared hash`);
  return source;
}

export async function snapshotRunInputs(runDirectory, identity) {
  parseSloIdentity(identity);
  const publicationIdentity = identity.build.imagePublicationManifest;
  const publicationSource = await readRepositorySnapshot(
    publicationIdentity.path,
    publicationIdentity.sha256,
    "image publication manifest",
  );
  let publication;
  try {
    publication = validateImagePublicationManifest(JSON.parse(publicationSource.toString("utf8")));
  } catch (error) {
    throw new RefusalError(`image publication manifest is invalid: ${error.message}`);
  }
  if (publication.source.commit !== identity.sourceCommit) throw new RefusalError("image publication manifest source does not match the measured run");
  const names = [
    await writeSnapshot(runDirectory, "publication/image-publication.json", publicationSource),
    await writeSnapshot(runDirectory, "source/source-identity.json", `${JSON.stringify(identity.source, null, 2)}\n`),
    await writeSnapshot(runDirectory, "source/head-tree.txt", `${identity.source.headTreeHash}\n`),
    await writeSnapshot(runDirectory, "source/repository-tree.sha256", `${identity.source.repositoryTreeHash}\n`),
    await writeSnapshot(runDirectory, "source/harness-tree.sha256", `${identity.source.harnessTreeHash}\n`),
  ];
  for (const image of publication.images) {
    if (image.provenance.mode !== "cosign-keyless") {
      throw new RefusalError(`${image.component} measured provenance must retain a cosign-keyless Sigstore bundle`);
    }
    const provenanceSource = await readRepositorySnapshot(
      image.provenance.path,
      image.provenance.sha256,
      `${image.component} provenance`,
    );
    const bundleSource = await readRepositorySnapshot(
      image.provenance.bundle.path,
      image.provenance.bundle.sha256,
      `${image.component} Sigstore bundle`,
    );
    if (bundleSource.byteLength !== image.provenance.bundle.bytes) {
      throw new RefusalError(`${image.component} Sigstore bundle size does not match the publication manifest`);
    }
    names.push(
      await writeSnapshot(runDirectory, `publication/${image.component}.provenance.jsonl`, provenanceSource),
      await writeSnapshot(runDirectory, `publication/${image.component}.provenance.sigstore.jsonl`, bundleSource),
    );
  }
  if (identity.source.dirty) {
    const patch = await readRepositorySnapshot(
      identity.source.retainedPatch.path,
      identity.source.retainedPatch.sha256,
      "retained source patch",
    );
    names.push(await writeSnapshot(runDirectory, "source/retained.patch", patch));
  }
  return names;
}
/**
 * Replace the matching observations and validate the complete candidate.
 * Pre-existing invalidity is a blocker: a schema-invalid ledger is not a safe
 * base from which to emit a measured claim.
 */
export function validateAgainstLedger(ledger, observations, commit) {
  const ledgerFailures = collectSloEvidenceFailures(ledger);
  if (ledgerFailures.length > 0) return ledgerFailures;
  if (ledger.source?.commit === null || commit !== ledger.source?.commit) {
    return ["--commit must exactly equal the ledger's non-null source.commit"];
  }
  const replaced = new Set(observations.map((observation) => observation.targetId));
  const candidate = {
    ...ledger,

    observations: [
      ...(ledger.observations ?? []).filter((observation) => !replaced.has(observation.targetId)),
      ...observations,
    ],
  };
  return collectSloEvidenceFailures(candidate);
}

function verifyRunIdentity(identity, options, ledgerSource) {
  const expected = [
    ["scenario", options.scenario],
    ["sourceCommit", options.commit],
    ["environmentId", options["environment-id"]],
    ["startedAt", options["observed-at"]],
    ["iterations", Number(options.iterations)],
  ];
  for (const [field, value] of expected) {
    if (identity?.[field] !== value) {
      throw new RefusalError(`identity.json ${field} does not match the summarized run`);
    }
  }
  let ledger;
  try {
    ledger = JSON.parse(ledgerSource);
  } catch {
    throw new RefusalError("the bound SLO ledger snapshot is not valid JSON");
  }
  const environment = ledger.environments?.find((candidate) => candidate?.id === options["environment-id"]);
  const buildKeys = Object.keys(ledger.build ?? {});
  const boundBuild = Object.fromEntries(buildKeys.map((key) => [key, identity?.build?.[key]]));
  if (!sameCanonicalValue(boundBuild, ledger.build)) {
    throw new RefusalError("identity.json build does not match the SLO ledger");
  }
  const sha256Pattern = /^[0-9a-f]{64}$/u;
  const source = identity?.source;
  const publication = identity?.build?.imagePublicationManifest;
  if (
    !source ||
    Object.keys(source).sort().join(",") !== "commit,dirty,harnessTreeHash,headTreeHash,repositoryTreeHash,retainedPatch" ||
    source.commit !== options.commit ||
    !/^[0-9a-f]{40}$/u.test(source.headTreeHash ?? "") ||
    !sha256Pattern.test(source.repositoryTreeHash ?? "") ||
    !sha256Pattern.test(source.harnessTreeHash ?? "") ||
    typeof source.dirty !== "boolean" ||
    (source.dirty === false && source.retainedPatch !== null) ||
    !publication ||
    (source.dirty === true && (
      !source.retainedPatch ||
      !String(source.retainedPatch.path ?? "").startsWith("artifacts/cluster-slo/retained-source/") ||
      !sha256Pattern.test(source.retainedPatch.sha256 ?? "") ||
      !Number.isSafeInteger(source.retainedPatch.size) ||
      source.retainedPatch.size < 1 ||
      source.retainedPatch.size > MAX_EVIDENCE_FILE_BYTES
    )) ||
    Object.keys(publication).sort().join(",") !== "measuredImages,path,sha256,size,source" ||
    !/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,510}$/u.test(publication.path ?? "") ||
    !sha256Pattern.test(publication.sha256 ?? "") ||
    !Number.isSafeInteger(publication.size) ||
    publication.size < 1 ||
    publication.size > MAX_EVIDENCE_FILE_BYTES ||
    publication.source?.commit !== options.commit ||
    !Array.isArray(publication.measuredImages) ||
    publication.measuredImages.length !== 3 ||
    !sameCanonicalValue(
      [...new Set(publication.measuredImages)].sort(),
      ["cluster-server", "controller", "session-runtime"],
    )
  ) {
    throw new RefusalError("identity.json source or image publication identity is incomplete");
  }
  if (
    identity?.source?.commit !== options.commit ||
    identity?.warmupIterations !== 0 ||
    identity?.deadlines?.iterationSeconds !== Number(options["timeout-seconds"]) ||
    identity?.deadlines?.operationSeconds !== identity?.timeoutSeconds ||
    Object.keys(identity?.deadlines ?? {}).sort().join(",") !== "cleanupSeconds,iterationSeconds,operationSeconds,wholeRunSeconds" ||
    Object.values(identity?.deadlines ?? {}).some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)
  ) {
    throw new RefusalError("identity.json source, deadlines, or warmup boundary is incomplete");
  }
  const fingerprint = environment?.fingerprint;
  const iterations = Number(options.iterations);
  const fleet = Array.isArray(fingerprint?.contexts)
    ? new Map(fingerprint.contexts.map((entry) => [entry.context, entry.fingerprint]))
    : null;
  const expectedForContext = (context) => fleet === null ? fingerprint : fleet.get(context);
  const coldEnvironment = options.scenario === "control-plane-cold-start" ||
    options.scenario === "session-cold-first-attach";
  if ((coldEnvironment && fleet === null) || (!coldEnvironment && fleet !== null)) {
    throw new RefusalError("ledger environment fingerprint shape does not match cold or reused-context scenario");
  }
  const identityClusterContexts = Array.isArray(identity?.clusters)
    ? new Set(identity.clusters.map((cluster) => cluster?.context))
    : new Set();
  if (
    fingerprint === undefined ||
    !Array.isArray(identity?.clusters) ||
    identity.clusters.length !== iterations ||
    (fleet !== null && (
      fleet.size !== iterations ||
      identityClusterContexts.size !== fleet.size ||
      [...fleet.keys()].some((context) => !identityClusterContexts.has(context))
    )) ||
    identity.clusters.some((cluster) => {
      const expected = expectedForContext(cluster?.context);
      return expected === undefined ||
        cluster?.uid !== cluster?.fingerprint?.clusterUid ||
        !sameCanonicalValue(cluster?.fingerprint, expected);
    })
  ) {
    throw new RefusalError("identity.json clusters do not exactly match the ledger environment fingerprint");
  }
  const contexts = new Set(identity.clusters.map((cluster) => cluster.context));
  if (
    !Array.isArray(identity?.environmentIterations) ||
    identity.environmentIterations.length !== iterations ||
    identity.environmentIterations.some((entry, index) => {
      const expected = expectedForContext(entry?.context);
      return entry?.iteration !== index + 1 ||
        !contexts.has(entry.context) ||
        expected === undefined ||
        !sameCanonicalValue(entry.fingerprint, expected);
    })
  ) {
    throw new RefusalError("identity.json does not bind the live environment for every iteration");
  }
  if (identity?.ledger?.snapshot !== ledgerSource || identity?.ledger?.sha256 !== sha256(ledgerSource)) {
    throw new RefusalError("identity.json does not bind the exact SLO ledger being validated");
  }
}

export async function summarizeRun(argv, { ledgerPath = SLO_EVIDENCE_PATH } = {}) {
  const options = parseArguments(argv);
  const ledgerSource = await readFile(ledgerPath, "utf8");
  const ledger = JSON.parse(ledgerSource);
  const ledgerFailures = collectSloEvidenceFailures(ledger);
  if (ledgerFailures.length > 0) {
    throw new RefusalError(`the SLO ledger is invalid:\n${ledgerFailures.map((failure) => `  ${failure}`).join("\n")}`);
  }
  const targets = targetsForScenario(ledger, options.scenario);

  if (ledger.source?.commit === null || options.commit !== ledger.source?.commit) {
    throw new RefusalError("--commit must exactly equal the ledger's non-null source.commit");
  }
  const samplesPath = resolve(options.samples);
  const runDirectory = dirname(samplesPath);
  const samplesSource = await readFile(samplesPath, "utf8");
  const samples = parseSamples(samplesSource);
  let identity;
  let identitySource;
  try {
    identitySource = await readFile(resolve(runDirectory, "identity.json"), "utf8");
    identity = parseSloIdentity(JSON.parse(identitySource));
  } catch (error) {
    throw new RefusalError(`identity.json is invalid: ${error.message}`);
  }
  verifyRunIdentity(identity, options, ledgerSource);
  let eventEvidence;
  try {
    eventEvidence = parseSloEvents(
      await readFile(resolve(runDirectory, "events.jsonl"), "utf8"),
      {
        runToken: identity.runToken,
        scenario: options.scenario,
        iterations: Number(options.iterations),
        deadlineSeconds: Number(options["timeout-seconds"]),
      },
    );
    parseSloCommands(
      await readFile(resolve(runDirectory, "commands.jsonl"), "utf8"),
      {
        runToken: identity.runToken,
        scenario: options.scenario,
        iterations: Number(options.iterations),
      },
      eventEvidence.events,
    );
  } catch (error) {
    throw new RefusalError(`typed run evidence is invalid: ${error.message}`);
  }
  if (
    samples.length !== eventEvidence.samples.length ||
    samples.some((sample, index) => {
      const derived = eventEvidence.samples[index];
      return sample.iteration !== derived.iteration ||
        sample.status !== derived.status ||
        sample.seconds !== derived.seconds ||
        sample.detail !== derived.detail;
    })
  ) {
    throw new RefusalError("samples.tsv does not derive exactly from events.jsonl");
  }
  const snapshotFiles = await snapshotRunInputs(runDirectory, identity);
  const rawArtifact = await createAndVerifyRunManifest(
    samplesPath,
    options["artifact-root"],
    snapshotFiles,
  );
  const verifiedArtifact = await verifySloRawArtifact(rawArtifact);
  const { manifest } = verifiedArtifact;
  const boundSamples = manifest.files.find((entry) => entry.name === "samples.tsv");
  if (
    boundSamples.bytes !== Buffer.byteLength(samplesSource) ||
    boundSamples.sha256 !== sha256(samplesSource)
  ) {
    throw new RefusalError("samples.tsv changed between parsing and run-manifest verification");
  }
  const boundIdentity = manifest.files.find((entry) => entry.name === "identity.json");
  if (
    boundIdentity.bytes !== Buffer.byteLength(identitySource) ||
    boundIdentity.sha256 !== sha256(identitySource)
  ) {
    throw new RefusalError("identity.json changed between run-manifest verification and identity validation");
  }
  const observations = buildObservations({
    targets,
    scenario: options.scenario,
    samples,
    options,
    rawArtifact,
  });
  for (const observation of observations) {
    if (observation.status !== "measured") continue;
    const target = targets.find((candidate) => candidate.id === observation.targetId);
    try {
      validateBoundObservation(ledger, observation, target, verifiedArtifact);
    } catch (error) {
      throw new RefusalError(`typed run bundle cannot support ${observation.targetId}: ${error.message}`);
    }
  }
  const failures = validateAgainstLedger(ledger, observations, options.commit);
  if (failures.length > 0) {
    throw new RefusalError(
      [
        "the observation this run produced would not validate against the ledger:",
        ...failures.map((failure) => `  ${failure}`),
        "Record the missing identity in compat/cluster-slo-evidence-v1.json first. Do not paste a number the ledger cannot account for.",
      ].join("\n"),
    );
  }
  await verifySloRawArtifact(rawArtifact);
  return observations;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const observations = await summarizeRun(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(observations, null, 2)}\n`);
    const measured = observations.filter((observation) => observation.status === "measured").length;
    console.error(
      `summarize-slo-run: ${measured} measured, ${observations.length - measured} unmeasured; nothing was written to the ledger`,
    );
  } catch (error) {
    if (error instanceof RefusalError) {
      console.error(`summarize-slo-run refused: ${error.message}`);
      process.exitCode = 65;
    } else {
      throw error;
    }
  }
}
