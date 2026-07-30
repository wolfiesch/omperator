/**
 * Strict validator for compat/portable-distribution-v1.json.
 *
 * The ledger claims what the portable t4-cluster distribution is compatible
 * with, which deployment adapters exist, which upstream deltas are carried, and
 * which harnesses and runbooks prove all of it. Every one of those claims is
 * checkable against the repository, so this validator checks them rather than
 * trusting the prose.
 *
 * It fails closed on: a null value with no stated reason, a chart identity that
 * disagrees with Chart.yaml, an API surface that disagrees with crds/, an image
 * set that is published without immutable digests, a deployment adapter that
 * exists on disk but is not declared (or vice versa), a mandatory provider, a
 * carried upstream patch with no removal condition, and any harness or runbook
 * reference that does not resolve to a file.
 *
 * It measures nothing and asserts nothing about speed or availability.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const DISTRIBUTION_PATH = join(REPOSITORY_ROOT, "compat", "portable-distribution-v1.json");
export const CHART_DIRECTORY = join(REPOSITORY_ROOT, "deploy", "charts", "t4-cluster");

export const DISTRIBUTION_SCHEMA_VERSION = "t4-cluster-distribution/1";
export const CRD_INSTALL_FLAG = "--skip-crds";

/** Every harness the distribution promises, and nothing else. */
export const REQUIRED_PROOF_HARNESSES = Object.freeze([
  "capabilityContract",
  "crdLifecycle",
  "distributionCompatibility",
  "localPackaging",
  "releaseLifecycle",
  "sloMeasurement",
  "storageConformance",
]);

/** Every operational runbook the distribution promises, and nothing else. */
export const REQUIRED_RUNBOOKS = Object.freeze([
  "backupRestore",
  "fencing",
  "identityRotation",
  "index",
  "install",
  "retainedStateReinstall",
  "retentionAndDestructiveEffects",
  "rollback",
  "uninstall",
  "upgrade",
]);

/**
 * Keys whose value must be null: a null here is a positive statement of
 * provider neutrality, not an unfilled field, so it needs no reason.
 */
const REQUIRED_NULL_KEYS = new Set(["mandatoryProvider"]);

const COMMIT = /^[0-9a-f]{40}$/u;
const IMAGE_REFERENCE = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;
const IDENTIFIER = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;
const KUBE_VERSION_FLOOR = /^>=\s*(\d+\.\d+\.\d+)/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
/** A `requires` or ledger entry that looks like a repository path. */
const REPOSITORY_PATH = /^(?:compat|deploy|docs|packages|provenance|scripts|vendor)\/[A-Za-z0-9._/-]+$/u;
/** Ordering prose must actually name the separate-CRD mechanism it uses. */
const CRD_ORDERING_MECHANISM = /skip-crds|skipCrds|crds=Skip|separate resource|separately/iu;
const MINIMUM_PROSE = 24;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(relativePath) {
  try {
    await stat(join(REPOSITORY_ROOT, relativePath));
    return true;
  } catch {
    return false;
  }
}

/** `compat/omp-app-matrix.json#/publishedRuntime/x` resolves to the file. */
function withoutFragment(reference) {
  const hash = reference.indexOf("#");
  return hash === -1 ? reference : reference.slice(0, hash);
}

/**
 * Every unfilled value must say why it is unfilled. Without this rule a null
 * silently reads as "not applicable" when it actually means "never checked".
 */
function collectUnexplainedNulls(node, path, failures) {
  if (Array.isArray(node)) {
    for (const [index, entry] of node.entries()) {
      collectUnexplainedNulls(entry, `${path}[${index}]`, failures);
    }
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (REQUIRED_NULL_KEYS.has(key)) {
      if (value !== null) {
        failures.push(`${here} must be null; the distribution mandates no provider`);
      }
      continue;
    }
    if (value === null) {
      const reason = node[`${key}Reason`];
      if (typeof reason !== "string" || reason.trim().length < MINIMUM_PROSE) {
        failures.push(`${here} is null and needs a ${key}Reason explaining what is not established`);
      }
      continue;
    }
    collectUnexplainedNulls(value, here, failures);
  }
}

async function referencedFiles(failures, entries) {
  for (const [label, reference] of entries) {
    if (typeof reference !== "string" || reference.length === 0) {
      failures.push(`${label} must name a repository path`);
      continue;
    }
    if (!REPOSITORY_PATH.test(reference)) {
      failures.push(`${label} must be a repository-relative path, got ${reference}`);
      continue;
    }
    if (!(await pathExists(reference))) failures.push(`${label} names ${reference}, which does not exist`);
  }
}

/** Chart identity, CRD surface, and adapter directories, read from disk. */
export async function loadDistributionContext(chartDirectory = CHART_DIRECTORY) {
  const chart = yaml.load(await readFile(join(chartDirectory, "Chart.yaml"), "utf8"));
  const crdDirectory = join(chartDirectory, "crds");
  const crds = [];
  for (const entry of (await readdir(crdDirectory)).sort()) {
    if (!entry.endsWith(".yaml")) continue;
    crds.push(yaml.load(await readFile(join(crdDirectory, entry), "utf8")));
  }
  const adapterDirectories = new Set();
  for (const [parent, skip] of [
    [join(REPOSITORY_ROOT, "deploy", "examples"), new Set(["values"])],
    [join(REPOSITORY_ROOT, "deploy", "terraform"), new Set()],
  ]) {
    let entries;
    try {
      entries = await readdir(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      adapterDirectories.add(
        `${parent.slice(REPOSITORY_ROOT.length + 1).split("\\").join("/")}/${entry.name}`,
      );
    }
  }
  let runbookFiles = [];
  try {
    runbookFiles = (await readdir(join(REPOSITORY_ROOT, "docs", "runbooks")))
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => `docs/runbooks/${entry}`)
      .sort();
  } catch {
    runbookFiles = [];
  }
  let chartLock = true;
  try {
    await stat(join(chartDirectory, "Chart.lock"));
  } catch {
    chartLock = false;
  }
  return { chart, crds, adapterDirectories, runbookFiles, chartLock };
}

function checkChart(failures, document, chart) {
  const declared = document.chart;
  if (!isPlainObject(declared)) {
    failures.push("chart must be an object");
    return;
  }
  const annotations = isPlainObject(chart?.annotations) ? chart.annotations : {};
  for (const [field, actual] of [
    ["name", chart?.name],
    ["version", chart?.version],
    ["appVersion", chart?.appVersion],
  ]) {
    if (declared[field] !== actual) {
      failures.push(`chart.${field} is ${JSON.stringify(declared[field])} but Chart.yaml says ${JSON.stringify(actual)}`);
    }
  }
  if (declared.crdOrdering !== annotations["cluster.t4.dev/crd-ordering"]) {
    failures.push("chart.crdOrdering must match the Chart.yaml cluster.t4.dev/crd-ordering annotation");
  }
  if (declared.crdOrdering !== "separate") failures.push("chart.crdOrdering must be separate");
  if (declared.crdInstallFlag !== CRD_INSTALL_FLAG) {
    failures.push(`chart.crdInstallFlag must be ${CRD_INSTALL_FLAG}`);
  }
  if (declared.crdInstallFlag !== annotations["cluster.t4.dev/crd-install-flag"]) {
    failures.push("chart.crdInstallFlag must match the Chart.yaml cluster.t4.dev/crd-install-flag annotation");
  }
  if (annotations["cluster.t4.dev/provider-neutral"] !== "true") {
    failures.push('Chart.yaml must annotate cluster.t4.dev/provider-neutral: "true"');
  }
  if (typeof declared.published !== "boolean") {
    failures.push("chart.published must be a boolean");
  } else if (declared.published === false) {
    if (typeof declared.publicationNote !== "string" || declared.publicationNote.trim().length < MINIMUM_PROSE) {
      failures.push("chart.published is false and needs a publicationNote saying what has not happened");
    }
  } else {
    const publication = declared.publication;
    if (!isPlainObject(publication)) {
      failures.push("chart.published is true and needs a chart.publication record naming the registry, reference, and archive digest");
    } else {
      for (const field of ["registry", "reference"]) {
        if (typeof publication[field] !== "string" || publication[field].length === 0) {
          failures.push(`chart.publication.${field} is required once the chart is published`);
        }
      }
      if (!/^[0-9a-f]{64}$/u.test(publication.sha256 ?? "")) {
        failures.push("chart.publication.sha256 must be the published archive digest");
      }
    }
  }
}

function checkApi(failures, document, crds) {
  const api = document.api;
  if (!isPlainObject(api)) {
    failures.push("api must be an object");
    return;
  }
  if (crds.length === 0) {
    failures.push("the chart ships no CustomResourceDefinition; the API claim cannot be checked");
    return;
  }
  const groups = new Set();
  const kinds = new Set();
  const served = new Set();
  const storage = new Set();
  for (const crd of crds) {
    groups.add(crd?.spec?.group);
    kinds.add(crd?.spec?.names?.kind);
    for (const version of crd?.spec?.versions ?? []) {
      if (version?.served === true) served.add(version.name);
      if (version?.storage === true) storage.add(version.name);
    }
  }
  if (groups.size !== 1 || !groups.has(api.group)) {
    failures.push(`api.group must be the single group the CRDs declare, got ${[...groups].join(",")}`);
  }
  const declaredKinds = Array.isArray(api.kinds) ? [...api.kinds].sort() : [];
  if (JSON.stringify(declaredKinds) !== JSON.stringify([...kinds].sort())) {
    failures.push(`api.kinds must be exactly the CRD kinds ${[...kinds].sort().join(",")}`);
  }
  const declaredServed = Array.isArray(api.servedVersions) ? [...api.servedVersions].sort() : [];
  if (JSON.stringify(declaredServed) !== JSON.stringify([...served].sort())) {
    failures.push(`api.servedVersions must be exactly the served CRD versions ${[...served].sort().join(",")}`);
  }
  if (storage.size !== 1 || !storage.has(api.storageVersion)) {
    failures.push(`api.storageVersion must be the single CRD storage version, got ${[...storage].join(",")}`);
  }
  if (api.conversionWebhook !== false) {
    failures.push("api.conversionWebhook must be false while every kind serves one version");
  }
  for (const field of ["compatibilityPolicy", "skewPolicy"]) {
    if (typeof api[field] !== "string" || api[field].trim().length < MINIMUM_PROSE) {
      failures.push(`api.${field} must state the policy`);
    }
  }
}

function checkPlatform(failures, document, chart) {
  const platform = document.platform;
  if (!isPlainObject(platform)) {
    failures.push("platform must be an object");
    return;
  }
  const floor = KUBE_VERSION_FLOOR.exec(String(chart?.kubeVersion ?? ""));
  if (!floor) {
    failures.push("Chart.yaml kubeVersion must declare a >= floor the ledger can be checked against");
  } else if (platform.kubernetesMinimum !== floor[1]) {
    failures.push(`platform.kubernetesMinimum must be ${floor[1]} to match Chart.yaml kubeVersion`);
  }
  if (!SEMVER.test(String(platform.helmMinimum ?? ""))) {
    failures.push("platform.helmMinimum must be an exact semantic version");
  }
  if (!Array.isArray(platform.requiredApis) || platform.requiredApis.length === 0) {
    failures.push("platform.requiredApis must be a non-empty list");
  }
  for (const [index, optional] of (platform.optionalApis ?? []).entries()) {
    if (!isPlainObject(optional) || typeof optional.api !== "string") {
      failures.push(`platform.optionalApis[${index}].api is required`);
      continue;
    }
    if (typeof optional.requiredFor !== "string" || optional.requiredFor.trim().length === 0) {
      failures.push(`platform.optionalApis[${index}] must say what it is required for`);
    }
  }
  const storage = platform.storage;
  if (!isPlainObject(storage)) {
    failures.push("platform.storage must be an object");
    return;
  }
  if (storage.workspaceAccessMode !== "ReadWriteMany") {
    failures.push("platform.storage.workspaceAccessMode must be ReadWriteMany");
  }
  if (!Array.isArray(storage.runtimeStateAccessModes) || storage.runtimeStateAccessModes.length === 0) {
    failures.push("platform.storage.runtimeStateAccessModes must list the fenced access modes");
  }
  if (storage.bundledDriver !== null) {
    failures.push("platform.storage.bundledDriver must be null; the chart is backend neutral");
  }
}

function checkImages(failures, document) {
  const images = document.images;
  if (!isPlainObject(images)) {
    failures.push("images must be an object");
    return;
  }
  const components = Array.isArray(images.components) ? images.components : [];
  if (components.length === 0) failures.push("images.components must be a non-empty list");
  if (typeof images.referenceForm !== "string" || !images.referenceForm.includes("@sha256:")) {
    failures.push("images.referenceForm must require an immutable @sha256: digest");
  }
  for (const component of images.proofManifestComponents ?? []) {
    if (!components.includes(component)) {
      failures.push(`images.proofManifestComponents names ${component}, which is not an image component`);
    }
  }
  for (const field of ["digestSet", "rollbackImageSet"]) {
    const value = images[field];
    if (value === null) continue;
    if (!isPlainObject(value)) {
      failures.push(`images.${field} must be null with a reason, or a component-to-reference map`);
      continue;
    }
    for (const component of components) {
      if (!Object.hasOwn(value, component)) {
        failures.push(`images.${field} is recorded but omits ${component}; a partial digest set cannot be rolled back`);
      }
    }
    for (const [component, reference] of Object.entries(value)) {
      if (!components.includes(component)) {
        failures.push(`images.${field} names unknown component ${component}`);
      }
      if (typeof reference !== "string" || !IMAGE_REFERENCE.test(reference)) {
        failures.push(`images.${field}.${component} must be repository@sha256:<64 hex>, never a tag`);
      }
    }
  }
  if (document.chart?.published === true && images.digestSet === null) {
    failures.push("a published chart must record the immutable digest set it was published against");
  }
}

function checkRuntimeCompatibilitySet(failures, document, references) {
  const set = document.runtimeCompatibilitySet;
  if (!isPlainObject(set)) {
    failures.push("runtimeCompatibilitySet must be an object");
    return;
  }
  for (const field of ["specificationContractCommit", "ompSourceCommit"]) {
    if (!COMMIT.test(String(set[field] ?? ""))) {
      failures.push(`runtimeCompatibilitySet.${field} must be an exact 40-character commit`);
    }
  }
  for (const field of ["ompAuthorityProtocol", "appProtocol"]) {
    if (typeof set[field] !== "string" || !set[field].includes("/")) {
      failures.push(`runtimeCompatibilitySet.${field} must be a versioned protocol identifier`);
    }
  }
  for (const field of ["source", "runtimeProvenance"]) {
    references.push([`runtimeCompatibilitySet.${field}`, set[field]]);
  }
}

function checkDeploymentAdapters(failures, document, adapterDirectories, references) {
  const adapters = document.deploymentAdapters;
  if (!Array.isArray(adapters) || adapters.length === 0) {
    failures.push("deploymentAdapters must be a non-empty list");
    return;
  }
  const ids = new Set();
  const declaredPaths = new Set();
  let referenceCount = 0;
  for (const [index, adapter] of adapters.entries()) {
    const label = `deploymentAdapters[${index}]`;
    if (!isPlainObject(adapter)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (typeof adapter.id !== "string" || !IDENTIFIER.test(adapter.id)) {
      failures.push(`${label}.id must be a kebab-case identifier`);
    } else if (ids.has(adapter.id)) {
      failures.push(`${label}.id repeats ${adapter.id}`);
    } else {
      ids.add(adapter.id);
    }
    if (adapter.reference === true) referenceCount += 1;
    else if (adapter.reference !== false) failures.push(`${label}.reference must be a boolean`);
    references.push([`${label}.path`, adapter.path]);
    if (typeof adapter.path === "string") declaredPaths.add(adapter.path);
    if (!Array.isArray(adapter.requires) || adapter.requires.length === 0) {
      failures.push(`${label}.requires must list what the adapter needs`);
    } else {
      for (const requirement of adapter.requires) {
        if (typeof requirement === "string" && REPOSITORY_PATH.test(requirement)) {
          references.push([`${label}.requires`, requirement]);
        }
      }
    }
    if (typeof adapter.crdOrdering !== "string" || adapter.crdOrdering.trim().length < MINIMUM_PROSE) {
      failures.push(`${label}.crdOrdering must describe how CRDs stay separately ordered`);
    } else if (!CRD_ORDERING_MECHANISM.test(adapter.crdOrdering)) {
      failures.push(`${label}.crdOrdering must name the mechanism that keeps CRDs out of the Helm release`);
    }
  }
  if (referenceCount !== 1) {
    failures.push(`exactly one deployment adapter must be the reference path, found ${referenceCount}`);
  }
  for (const directory of adapterDirectories) {
    if (!declaredPaths.has(directory)) {
      failures.push(`${directory} is a deployment adapter on disk but is not declared in deploymentAdapters`);
    }
  }
}

function checkUpstreamPatchLedger(failures, document, chart, chartLock, references) {
  const ledger = document.upstreamPatchLedger;
  if (!isPlainObject(ledger)) {
    failures.push("upstreamPatchLedger must be an object");
    return;
  }
  if (typeof ledger.policy !== "string" || ledger.policy.trim().length < MINIMUM_PROSE) {
    failures.push("upstreamPatchLedger.policy must state the recording policy");
  }
  const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
  if (entries.length === 0) failures.push("upstreamPatchLedger.entries must be a list");
  const ids = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `upstreamPatchLedger.entries[${index}]`;
    if (!isPlainObject(entry)) {
      failures.push(`${label} must be an object`);
      continue;
    }
    if (typeof entry.id !== "string" || !IDENTIFIER.test(entry.id)) {
      failures.push(`${label}.id must be a kebab-case identifier`);
    } else if (ids.has(entry.id)) {
      failures.push(`${label}.id repeats ${entry.id}`);
    } else {
      ids.add(entry.id);
    }
    if (typeof entry.upstreamRepository !== "string" || !entry.upstreamRepository.startsWith("https://")) {
      failures.push(`${label}.upstreamRepository must be an https URL`);
    }
    if (!COMMIT.test(String(entry.upstreamCommit ?? ""))) {
      failures.push(`${label}.upstreamCommit must be an exact 40-character commit`);
    }
    for (const field of ["pinnedCommit", "pinnedTree"]) {
      if (Object.hasOwn(entry, field) && !COMMIT.test(String(entry[field]))) {
        failures.push(`${label}.${field} must be an exact 40-character object id`);
      }
    }
    if (typeof entry.packagedInProduct !== "boolean") {
      failures.push(`${label}.packagedInProduct must be a boolean`);
    }
    if (typeof entry.removalCondition !== "string" || entry.removalCondition.trim().length < MINIMUM_PROSE) {
      failures.push(`${label}.removalCondition must state exactly when the delta is dropped`);
    }
    for (const field of ["patchSetSource", "manifest", "vendorPath", "pinnedArtifact"]) {
      if (!Object.hasOwn(entry, field)) continue;
      const value = entry[field];
      if (typeof value !== "string") {
        failures.push(`${label}.${field} must be a repository path`);
        continue;
      }
      references.push([`${label}.${field}`, withoutFragment(value)]);
    }
  }

  const dependencies = ledger.chartUpstreamDependencies;
  if (!isPlainObject(dependencies)) {
    failures.push("upstreamPatchLedger.chartUpstreamDependencies must be an object");
    return;
  }
  for (const field of ["helmDependencies", "vendoredThirdPartyManifests"]) {
    if (!Array.isArray(dependencies[field])) {
      failures.push(`upstreamPatchLedger.chartUpstreamDependencies.${field} must be a list`);
      continue;
    }
    if (dependencies[field].length === 0) {
      const note = dependencies[`${field}Note`];
      if (typeof note !== "string" || note.trim().length < MINIMUM_PROSE) {
        failures.push(`upstreamPatchLedger.chartUpstreamDependencies.${field} is empty and needs a ${field}Note`);
      }
    }
  }
  const chartDependencies = Array.isArray(chart?.dependencies) ? chart.dependencies : [];
  if (chartDependencies.length !== (dependencies.helmDependencies?.length ?? -1)) {
    failures.push(
      `upstreamPatchLedger.chartUpstreamDependencies.helmDependencies must list the ${chartDependencies.length} Chart.yaml dependencies`,
    );
  }
  if (chartLock && (dependencies.helmDependencies?.length ?? 0) === 0) {
    failures.push("the chart has a Chart.lock but the ledger declares no Helm dependencies");
  }
}

function checkHarnessesAndRunbooks(failures, document, runbookFiles, references) {
  for (const [section, required] of [
    ["proofHarnesses", REQUIRED_PROOF_HARNESSES],
    ["runbooks", REQUIRED_RUNBOOKS],
  ]) {
    const value = document[section];
    if (!isPlainObject(value)) {
      failures.push(`${section} must be an object`);
      continue;
    }
    const keys = Object.keys(value).sort();
    if (JSON.stringify(keys) !== JSON.stringify([...required])) {
      failures.push(`${section} must declare exactly ${required.join(", ")}`);
    }
    for (const [key, reference] of Object.entries(value)) {
      references.push([`${section}.${key}`, reference]);
    }
  }

  const listed = new Set(Object.values(document.runbooks ?? {}));
  for (const file of runbookFiles) {
    if (!listed.has(file)) {
      failures.push(`${file} exists but no runbooks entry points at it; the runbook set must be closed`);
    }
  }
}

/**
 * @returns {Promise<string[]>} every violation; empty means every claim the
 * distribution ledger makes is backed by something in this repository.
 */
export async function collectDistributionFailures(document, context) {
  const failures = [];
  if (!isPlainObject(document)) return ["portable-distribution-v1.json must be an object"];
  if (document.schemaVersion !== DISTRIBUTION_SCHEMA_VERSION) {
    failures.push(`schemaVersion must be ${DISTRIBUTION_SCHEMA_VERSION}`);
  }
  if (typeof document.contract !== "string" || document.contract.length === 0) {
    failures.push("contract must name the distribution contract");
  }

  collectUnexplainedNulls(document, "", failures);

  const references = [];
  checkChart(failures, document, context.chart);
  references.push(["chart.path", document.chart?.path]);
  references.push(["chart.capabilitiesFile", document.chart?.capabilitiesFile]);
  checkApi(failures, document, context.crds);
  references.push(["api.compatibilityFixtures", document.api?.compatibilityFixtures]);
  checkPlatform(failures, document, context.chart);
  references.push(["platform.storage.conformanceHarness", document.platform?.storage?.conformanceHarness]);
  checkImages(failures, document);
  checkRuntimeCompatibilitySet(failures, document, references);
  checkDeploymentAdapters(failures, document, context.adapterDirectories, references);
  checkUpstreamPatchLedger(failures, document, context.chart, context.chartLock, references);
  checkHarnessesAndRunbooks(failures, document, context.runbookFiles, references);

  await referencedFiles(failures, references);
  return failures;
}

export async function checkDistributionFile(path = DISTRIBUTION_PATH, chartDirectory = CHART_DIRECTORY) {
  let document;
  try {
    document = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`distribution ledger ${path} is not valid JSON`, { cause: error });
  }
  return collectDistributionFailures(document, await loadDistributionContext(chartDirectory));
}

/** One line that never implies a measurement or a publication. */
export function summarizeDistribution(document) {
  const adapters = document.deploymentAdapters ?? [];
  const patches = document.upstreamPatchLedger?.entries ?? [];
  const published = document.chart?.published === true ? "published" : "unpublished";
  return `chart ${document.chart?.name}@${document.chart?.version} (${published}), ${adapters.length} deployment adapters, ${patches.length} carried upstream deltas`;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const path = process.argv[2] ? resolve(process.argv[2]) : DISTRIBUTION_PATH;
  const failures = await checkDistributionFile(path);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`distribution compatibility: ${failure}`);
    process.exitCode = 1;
  } else {
    const document = JSON.parse(await readFile(path, "utf8"));
    console.log(`Validated ${path}: ${summarizeDistribution(document)}`);
  }
}
