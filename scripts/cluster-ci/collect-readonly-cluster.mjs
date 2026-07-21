import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import yaml from "js-yaml";

import { AUTHORIZED_CI_MIRROR } from "./proof-contract.mjs";
import {
  collectReadOnlyClusterSnapshot,
  summarizeClusterSnapshot,
  validateDefaultOffRender,
} from "./readonly-cluster-proof.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const proofRoot = resolve(repoRoot, "artifacts/cluster-proof");
const scenarioRoot = resolve(proofRoot, "scenarios");
const observationRoot = resolve(proofRoot, "observations");
const MAX_OBSERVATION_BYTES = 2 * 1024 * 1024;
const OBSERVABILITY_SERVICES = Object.freeze({
  prometheus: "http://prometheus-prometheus.linkedin-monitoring.svc.cluster.local:9090",
  loki: "http://loki.linkedin-monitoring.svc.cluster.local:3100",
  grafana: "http://prometheus-grafana.linkedin-monitoring.svc.cluster.local",
});
const PROMETHEUS_QUERIES = Object.freeze([
  ["t4-cluster-up", 'sum(up{job="t4-cluster"})'],
  ["t4-cluster-reconcile-success", 'sum(t4_cluster_reconcile_total{result="success"})'],
  ["t4-cluster-conditions", "sum(t4_cluster_condition)"],
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function currentCiMapping() {
  const pipelineUrl = new URL(requiredEnvironment("CI_PIPELINE_URL"));
  const match = pipelineUrl.pathname.match(/^\/repos\/([1-9][0-9]*)\/pipeline\/[1-9][0-9]*\/?$/u);
  if (
    pipelineUrl.origin !== "https://woodpecker-ci-dev.tailb18de3.ts.net" ||
    pipelineUrl.username ||
    pipelineUrl.password ||
    pipelineUrl.search ||
    pipelineUrl.hash ||
    !match
  ) {
    throw new Error("CI_PIPELINE_URL does not identify the exact credential-free Woodpecker repository");
  }
  const ciRepository = requiredEnvironment("CI_REPO");
  if (ciRepository !== AUTHORIZED_CI_MIRROR) throw new Error("CI_REPO is not the authorized CI mirror");
  return {
    repositoryId: match[1],
    ref: requiredEnvironment("CI_COMMIT_REF"),
    commit: requiredEnvironment("CI_COMMIT_SHA"),
  };
}

async function atomicJson(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function scenario(id, observedAt, assertions) {
  await atomicJson(resolve(scenarioRoot, `${id}.json`), {
    schemaVersion: "t4-cluster-scenario/1",
    id,
    status: "passed",
    observedAt,
    assertions,
  });
}

async function defaultOffEvidence(namespace) {
  const { stdout } = await execFileAsync(
    "helm",
    ["template", "t4-default-off", "deploy/charts/t4-cluster", "--namespace", namespace],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
  );
  const documents = [];
  yaml.loadAll(stdout, (document) => {
    if (document) documents.push(document);
  });
  const result = validateDefaultOffRender(documents);
  await atomicJson(resolve(observationRoot, "feature-off-render.json"), {
    schemaVersion: "t4-cluster-feature-off/1",
    observedAt: new Date().toISOString(),
    ...result,
    renderedKinds: [...new Set(documents.map(({ kind }) => kind).filter(Boolean))].sort(),
  });
  return result;
}

async function boundedJson(url, label, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "t4-cluster-proof/1" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_OBSERVATION_BYTES) throw new Error(`${label} exceeded its byte bound`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_OBSERVATION_BYTES) {
    throw new Error(`${label} was empty or exceeded its byte bound`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} was not valid JSON`, { cause: error });
  }
}

export function prometheusSample(payload, name) {
  const result = payload?.data?.result;
  const sample = Array.isArray(result) && result.length === 1 ? result[0]?.value : undefined;
  const timestamp = Array.isArray(sample) ? Number(sample[0]) : Number.NaN;
  const value = Array.isArray(sample) ? Number(sample[1]) : Number.NaN;
  if (
    payload?.status !== "success" ||
    payload?.data?.resultType !== "vector" ||
    !Array.isArray(sample) ||
    sample.length !== 2 ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0 ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`Prometheus ${name} did not return one bounded nonnegative sample`);
  }
  return { name, value, sampledAt: new Date(timestamp * 1000).toISOString() };
}

export function lokiLogSummary(payload) {
  const streams = payload?.data?.result;
  if (
    payload?.status !== "success" ||
    payload?.data?.resultType !== "streams" ||
    !Array.isArray(streams) ||
    streams.length < 1 ||
    streams.length > 128
  ) {
    throw new Error("Loki did not return a bounded T4 log stream result");
  }
  let entryCount = 0;
  let errorCount = 0;
  for (const stream of streams) {
    if (!stream?.stream || typeof stream.stream !== "object" || !Array.isArray(stream.values) || stream.values.length > 1000) {
      throw new Error("Loki returned a malformed T4 log stream");
    }
    for (const entry of stream.values) {
      if (!Array.isArray(entry) || entry.length !== 2 || !/^[0-9]{1,20}$/u.test(entry[0]) || typeof entry[1] !== "string" || entry[1].length > 65_536) {
        throw new Error("Loki returned a malformed T4 log entry");
      }
      entryCount += 1;
      try {
        if (JSON.parse(entry[1])?.level === "error") errorCount += 1;
      } catch {
        if (/"level"\s*:\s*"error"/u.test(entry[1])) errorCount += 1;
      }
    }
  }
  if (entryCount < 1) throw new Error("Loki returned no current T4 log entries");
  return { streamCount: streams.length, entryCount, errorCount };
}

export function grafanaHealthSummary(payload) {
  if (
    payload?.database !== "ok" ||
    typeof payload.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(payload.version) ||
    typeof payload.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(payload.commit)
  ) {
    throw new Error("Grafana health identity is malformed or unhealthy");
  }
  return { database: "ok", version: payload.version, commit: payload.commit };
}

export async function collectObservabilityEvidence({ sourceCommit, namespace, fetchImpl = fetch, now = Date.now() }) {
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) throw new Error("observability source commit is invalid");
  if (!/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u.test(namespace)) throw new Error("observability namespace is invalid");
  const observedAt = new Date(now).toISOString();
  const metrics = [];
  for (const [name, query] of PROMETHEUS_QUERIES) {
    const url = new URL("/api/v1/query", OBSERVABILITY_SERVICES.prometheus);
    url.searchParams.set("query", query);
    metrics.push(prometheusSample(await boundedJson(url, `Prometheus ${name}`, fetchImpl), name));
  }
  const lokiUrl = new URL("/loki/api/v1/query_range", OBSERVABILITY_SERVICES.loki);
  lokiUrl.searchParams.set("query", `{namespace="${namespace}"}`);
  lokiUrl.searchParams.set("start", String((now - 15 * 60_000) * 1_000_000));
  lokiUrl.searchParams.set("end", String(now * 1_000_000));
  lokiUrl.searchParams.set("limit", "256");
  lokiUrl.searchParams.set("direction", "backward");
  const logs = lokiLogSummary(await boundedJson(lokiUrl, "Loki T4 logs", fetchImpl));
  if (logs.errorCount !== 0) throw new Error(`Loki found ${logs.errorCount} current T4 error event(s)`);
  const grafana = grafanaHealthSummary(
    await boundedJson(new URL("/api/health", OBSERVABILITY_SERVICES.grafana), "Grafana health", fetchImpl),
  );
  const records = [
    { system: "prometheus", ids: metrics.map(({ name }) => name), summary: { metrics } },
    { system: "loki", ids: [namespace], summary: logs },
    { system: "grafana", ids: [grafana.version, grafana.commit], summary: grafana },
  ];
  for (const record of records) {
    await atomicJson(resolve(observationRoot, `${record.system}.json`), {
      schemaVersion: "t4-cluster-observation/1",
      sourceCommit,
      system: record.system,
      observedAt,
      redacted: true,
      ids: record.ids,
      summary: record.summary,
    });
  }
  return records;
}

export async function collectClusterEvidence({ namespace, ciMapping = currentCiMapping() }) {
  await mkdir(scenarioRoot, { recursive: true });
  await mkdir(observationRoot, { recursive: true });
  const snapshot = await collectReadOnlyClusterSnapshot({ namespace });
  const summary = summarizeClusterSnapshot(snapshot, { ciMapping });
  await atomicJson(resolve(observationRoot, "kubernetes.json"), summary);
  await scenario("ha-manifest", summary.observedAt, [
    "controller.replicas-2",
    "controller.rolling-update.max-unavailable-0",
    "server.replicas-3",
    "server.rolling-update.max-unavailable-0",
  ]);
  await scenario("leader-election", summary.observedAt, [
    "lease.active-holder",
    "lease.renew-time-observed",
    "reconcile.single-active-leader",
  ]);
  await scenario("crd-reconcile-storage", summary.observedAt, [
    "crd.namespaced-v1alpha1",
    "reconcile.observed-generation",
    "storage.bound-read-write-many",
    "placement.session-worker-exclusions",
  ]);
  await scenario("ci-mapping", summary.observedAt, [
    "ci.repository-id-exact",
    "ci.ref-exact",
    "ci.commit-exact",
    "ci.session-running-ready",
  ]);
  const off = await defaultOffEvidence(namespace);
  await scenario("feature-off", new Date().toISOString(), [
    off.clusterOperatorEnabled ? "feature-off.invalid" : "feature-off.no-workloads",
  ]);
  await collectObservabilityEvidence({ sourceCommit: ciMapping.commit, namespace });
  return summary;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const namespace = process.env.T4_CLUSTER_NAMESPACE?.trim();
    if (!namespace) throw new Error("T4_CLUSTER_NAMESPACE is required");
    const summary = await collectClusterEvidence({ namespace });
    console.log(
      `Captured read-only T4 cluster evidence for ${summary.workspaces.length} workspace(s) and ${summary.sessions.length} session(s)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
