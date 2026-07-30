/**
 * Offline contract between what the t4-cluster chart advertises and what the
 * release-lifecycle harness proves.
 *
 * This makes no cluster request and runs no measurement. It answers exactly
 * one question: does every capability the packaged chart claims have a real
 * values gate, a real rendered kind, and a proving lifecycle scenario, and
 * does every declared scenario prove something?
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "..", "..");
export const CHART_DIRECTORY = join(REPOSITORY_ROOT, "deploy", "charts", "t4-cluster");

export const CAPABILITIES_SCHEMA_VERSION = "t4-cluster-capabilities/1";
export const CHART_NAME = "t4-cluster";
export const CRD_INSTALL_FLAG = "--skip-crds";

/**
 * The lifecycle proof set the distribution promises. A capability inventory is
 * only a closed set if these scenarios cannot quietly disappear from it, so
 * they are a floor: the chart may declare more, never fewer.
 */
export const REQUIRED_SCENARIOS = Object.freeze([
  "additive-upgrade",
  "capability-render-matrix",
  "clean-uninstall",
  "crd-separate-order",
  "fresh-install",
  "optional-adapters",
  "retained-state-reinstall",
  "rollback",
]);

const IDENTIFIER = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/u;
const VALUES_PATH = /^[a-zA-Z][A-Za-z0-9]*(\.[a-zA-Z][A-Za-z0-9]*)*$/u;
const KUBERNETES_KIND = /^[A-Z][A-Za-z0-9]{1,62}$/u;
const CAPABILITY_FIELDS = Object.freeze([
  "id",
  "summary",
  "optional",
  "adapter",
  "enablingGate",
  "valuesGates",
  "renders",
  "scenarios",
]);
const SCENARIO_FIELDS = Object.freeze(["id", "summary"]);
const DOCUMENT_FIELDS = Object.freeze(["schemaVersion", "chart", "scenarios", "capabilities"]);
/** A summary describes shape, never speed or availability. */
const MEASUREMENT_CLAIM =
  /\b(?:latenc|throughput|percentile|p9[59]|uptime|availability|SLA|SLO|faster|slower|ms\b|seconds?\b)/iu;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Empty string, empty list, empty map, and false all mean "off". */
function isDisabledDefault(value) {
  if (value === false || value === "" || value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Resolve a dotted values path by key presence, not truthiness: a documented
 * default of `false` or `""` still means the chart defines the path.
 */
function lookupValuesPath(values, path) {
  let cursor = values;
  for (const segment of path.split(".")) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, segment)) {
      return { present: false, value: undefined };
    }
    cursor = cursor[segment];
  }
  return { present: true, value: cursor };
}

function exactFields(failures, value, fields, label) {
  if (!isPlainObject(value)) {
    failures.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    failures.push(`${label} fields must be exactly ${wanted.join(", ")} (found ${actual.join(", ") || "none"})`);
    return false;
  }
  return true;
}

function stringList(failures, value, label, pattern) {
  if (!Array.isArray(value)) {
    failures.push(`${label} must be an array`);
    return [];
  }
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || !pattern.test(entry)) {
      failures.push(`${label} contains an invalid entry ${JSON.stringify(entry)}`);
      continue;
    }
    if (seen.has(entry)) failures.push(`${label} repeats ${entry}`);
    seen.add(entry);
  }
  return value.filter((entry) => typeof entry === "string");
}

async function renderedKinds(chartDirectory) {
  const kinds = new Set();
  for (const subdirectory of ["templates", "crds"]) {
    const directory = join(chartDirectory, subdirectory);
    let entries;
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".yaml")) continue;
      const source = await readFile(join(directory, entry), "utf8");
      for (const match of source.matchAll(/^kind:\s*(\S+)\s*$/gmu)) kinds.add(match[1]);
    }
  }
  return kinds;
}

export async function loadChartCapabilities(chartDirectory = CHART_DIRECTORY) {
  const [capabilitiesSource, valuesSource, chartSource] = await Promise.all([
    readFile(join(chartDirectory, "capabilities.yaml"), "utf8"),
    readFile(join(chartDirectory, "values.yaml"), "utf8"),
    readFile(join(chartDirectory, "Chart.yaml"), "utf8"),
  ]);
  return {
    capabilities: yaml.load(capabilitiesSource),
    values: yaml.load(valuesSource),
    chart: yaml.load(chartSource),
    kinds: await renderedKinds(chartDirectory),
  };
}

/**
 * @returns {string[]} every contract violation; empty means the chart's
 * advertised capability surface is fully backed and fully proven.
 */
export function collectCapabilityFailures({ capabilities, values, chart, kinds }) {
  const failures = [];
  if (!exactFields(failures, capabilities, DOCUMENT_FIELDS, "capabilities.yaml")) return failures;
  if (capabilities.schemaVersion !== CAPABILITIES_SCHEMA_VERSION) {
    failures.push(`capabilities.yaml schemaVersion must be ${CAPABILITIES_SCHEMA_VERSION}`);
  }
  if (capabilities.chart !== CHART_NAME) {
    failures.push(`capabilities.yaml chart must be ${CHART_NAME}`);
  }

  const scenarioIds = new Set();
  if (!Array.isArray(capabilities.scenarios) || capabilities.scenarios.length === 0) {
    failures.push("capabilities.yaml scenarios must be a non-empty array");
  } else {
    for (const [index, scenario] of capabilities.scenarios.entries()) {
      const label = `capabilities.yaml scenarios[${index}]`;
      if (!exactFields(failures, scenario, SCENARIO_FIELDS, label)) continue;
      if (typeof scenario.id !== "string" || !IDENTIFIER.test(scenario.id)) {
        failures.push(`${label}.id must be a kebab-case identifier`);
        continue;
      }
      if (scenarioIds.has(scenario.id)) failures.push(`${label}.id repeats ${scenario.id}`);
      scenarioIds.add(scenario.id);
      if (typeof scenario.summary !== "string" || scenario.summary.trim().length < 16) {
        failures.push(`${label}.summary must describe the scenario`);
      }
    }
  }
  for (const required of REQUIRED_SCENARIOS) {
    if (!scenarioIds.has(required)) {
      failures.push(`capabilities.yaml is missing the required lifecycle scenario ${required}`);
    }
  }

  const capabilityIds = new Set();
  const adapterIds = [];
  const provenScenarios = new Set();
  if (!Array.isArray(capabilities.capabilities) || capabilities.capabilities.length === 0) {
    failures.push("capabilities.yaml capabilities must be a non-empty array");
    return failures;
  }

  for (const [index, capability] of capabilities.capabilities.entries()) {
    const label = `capabilities.yaml capabilities[${index}]`;
    if (!exactFields(failures, capability, CAPABILITY_FIELDS, label)) continue;
    const { id } = capability;
    if (typeof id !== "string" || !IDENTIFIER.test(id)) {
      failures.push(`${label}.id must be a kebab-case identifier`);
      continue;
    }
    if (capabilityIds.has(id)) failures.push(`${label}.id repeats ${id}`);
    capabilityIds.add(id);

    if (typeof capability.summary !== "string" || capability.summary.trim().length < 16) {
      failures.push(`${id}.summary must describe the capability`);
    } else if (MEASUREMENT_CLAIM.test(capability.summary)) {
      failures.push(`${id}.summary makes a performance or availability claim; capabilities describe shape only`);
    }
    if (typeof capability.optional !== "boolean") failures.push(`${id}.optional must be a boolean`);
    if (typeof capability.adapter !== "boolean") failures.push(`${id}.adapter must be a boolean`);
    if (capability.adapter === true) {
      adapterIds.push(id);
      if (capability.optional !== true) failures.push(`${id} is an adapter and must be optional`);
    }

    const gates = stringList(failures, capability.valuesGates, `${id}.valuesGates`, VALUES_PATH);
    for (const gate of gates) {
      if (!lookupValuesPath(values, gate).present) {
        failures.push(`${id}.valuesGates names ${gate}, which values.yaml does not define`);
      }
    }

    const gate = capability.enablingGate;
    if (gate !== null) {
      if (typeof gate !== "string" || !VALUES_PATH.test(gate)) {
        failures.push(`${id}.enablingGate must be null or a values path`);
      } else if (!gates.includes(gate)) {
        failures.push(`${id}.enablingGate ${gate} must also appear in valuesGates`);
      } else {
        const resolved = lookupValuesPath(values, gate);
        if (capability.adapter === true && !isDisabledDefault(resolved.value)) {
          failures.push(
            `${id} is an adapter but values.yaml default ${gate}=${JSON.stringify(resolved.value)} is enabled`,
          );
        }
      }
    } else if (capability.adapter === true) {
      failures.push(`${id} is an adapter and must name an enablingGate`);
    }

    for (const kind of stringList(failures, capability.renders, `${id}.renders`, KUBERNETES_KIND)) {
      if (!kinds.has(kind)) failures.push(`${id}.renders names ${kind}, which no chart manifest emits`);
    }

    const claimed = stringList(failures, capability.scenarios, `${id}.scenarios`, IDENTIFIER);
    if (claimed.length === 0) failures.push(`${id} has no proving lifecycle scenario`);
    for (const scenario of claimed) {
      if (!scenarioIds.has(scenario)) {
        failures.push(`${id}.scenarios names undeclared scenario ${scenario}`);
        continue;
      }
      provenScenarios.add(scenario);
    }
  }

  for (const scenario of scenarioIds) {
    if (!provenScenarios.has(scenario)) failures.push(`scenario ${scenario} proves no capability`);
  }

  const annotations = isPlainObject(chart?.annotations) ? chart.annotations : {};
  if (chart?.name !== CHART_NAME) failures.push(`Chart.yaml name must be ${CHART_NAME}`);
  if (annotations["cluster.t4.dev/capabilities-file"] !== "capabilities.yaml") {
    failures.push("Chart.yaml must annotate cluster.t4.dev/capabilities-file: capabilities.yaml");
  }
  if (annotations["cluster.t4.dev/crd-ordering"] !== "separate") {
    failures.push("Chart.yaml must annotate cluster.t4.dev/crd-ordering: separate");
  }
  if (annotations["cluster.t4.dev/crd-install-flag"] !== CRD_INSTALL_FLAG) {
    failures.push(`Chart.yaml must annotate cluster.t4.dev/crd-install-flag: ${CRD_INSTALL_FLAG}`);
  }
  if (annotations["cluster.t4.dev/provider-neutral"] !== "true") {
    failures.push('Chart.yaml must annotate cluster.t4.dev/provider-neutral: "true"');
  }
  const announced = String(annotations["cluster.t4.dev/optional-adapters"] ?? "")
    .split(",")
    .filter((entry) => entry.length > 0);
  if (JSON.stringify(announced) !== JSON.stringify(adapterIds)) {
    failures.push(
      `Chart.yaml cluster.t4.dev/optional-adapters must list exactly the adapter capabilities ${adapterIds.join(",")}`,
    );
  }

  return failures;
}

export async function checkChartCapabilities(chartDirectory = CHART_DIRECTORY) {
  return collectCapabilityFailures(await loadChartCapabilities(chartDirectory));
}

/** Scenario ids the release-lifecycle harness must implement. */
export async function declaredScenarioIds(chartDirectory = CHART_DIRECTORY) {
  const { capabilities } = await loadChartCapabilities(chartDirectory);
  return capabilities.scenarios.map((scenario) => scenario.id);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const failures = await checkChartCapabilities();
  if (failures.length > 0) {
    for (const failure of failures) console.error(`t4-cluster capability contract: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log("Validated the t4-cluster advertised capability contract");
  }
}
