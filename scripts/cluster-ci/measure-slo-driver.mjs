import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile, appendFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateImagePublicationManifest } from "./proof-contract.mjs";
import { SLO_COMMAND_VERSION, SLO_IDENTITY_VERSION, SloEventRecorder } from "./slo-run-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(HERE, "../..");
export const SAMPLE_HEADER = "iteration\tstatus\tseconds\tdetail";
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 2_250_000;
const MIN_RECORD_RESERVE_BYTES = 2048;
const MAX_RAW_BYTES = 16 * 1024 * 1024;
const ID = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;
const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SCENARIOS = new Set([
  "control-plane-cold-start",
  "session-cold-first-attach",
  "session-warm-first-attach",
  "controller-leader-failover",
  "gateway-replica-failover",
  "fenced-generation-replacement",
]);

export class RefusalError extends Error { constructor(message) { super(message); this.name = "RefusalError"; } }
export class TimeoutError extends Error { constructor(message) { super(message); this.name = "TimeoutError"; } }

function required(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) throw new RefusalError(`${name} is required`);
  return value;
}
function integer(env, name, fallback, minimum = 1) {
  const raw = env[name] ?? String(fallback);
  if (!/^(?:0|[1-9]\d*)$/u.test(raw) || Number(raw) < minimum) throw new RefusalError(`${name} must be an integer of at least ${minimum}`);
  return Number(raw);
}
function list(env, name, expected) {
  const values = required(env, name).split(",").map(value => value.trim());
  if (values.some(value => value.length === 0) || (expected !== undefined && values.length !== expected)) throw new RefusalError(`${name} must contain exactly ${expected} non-empty comma-separated values`);
  return values;
}
function jsonStringArray(env, name) {
  let value;
  try { value = JSON.parse(required(env, name)); } catch { throw new RefusalError(`${name} must be a JSON string array`); }
  if (!Array.isArray(value) || value.length > 64 || value.some(item => typeof item !== "string" || item.length > 512)) throw new RefusalError(`${name} must be a bounded JSON string array`);
  return value;
}
function safeId(value, name) {
  if (!ID.test(value)) throw new RefusalError(`${name} must be a DNS label`);
  return value;
}
function publicId(value, name) {
  if (!PUBLIC_ID.test(value)) throw new RefusalError(`${name} is not a valid public id`);
  return value;
}
function digestImage(value, name) {
  if (!DIGEST_IMAGE.test(value)) throw new RefusalError(`${name} must be an immutable image reference with a sha256 digest`);
  return value;
}
function bounded(value, maximum = 800) {
  return String(value).replace(/[\t\r\n\p{Cc}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maximum) || "-";
}
function sleep(milliseconds) { return new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)); }
function monotonicMs() { return Number(process.hrtime.bigint() / 1_000_000n); }
function wallTime() { return new Date().toISOString(); }

export class Deadline {
  constructor(milliseconds, label) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new RefusalError(`${label} deadline must be a positive integer`);
    this.expiresAtMs = monotonicMs() + milliseconds;
    this.label = label;
  }
  remainingMs() {
    const remaining = this.expiresAtMs - monotonicMs();
    if (remaining <= 0) throw new TimeoutError(`${this.label} deadline expired`);
    return remaining;
  }
  signal() { return AbortSignal.timeout(this.remainingMs()); }
}
export async function withinDeadline(deadline, operation) {
  const controller = new AbortController();
  const timeoutMs = deadline.remainingMs();
  const timer = setTimeout(() => controller.abort(new TimeoutError(`${deadline.label} deadline expired`)), timeoutMs);
  const task = Promise.resolve().then(() => operation(controller.signal));
  try {
    const result = await task;
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } catch (error) {
    if (controller.signal.aborted && (error?.name === "AbortError" || error === controller.signal.reason)) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export class IterationLifecycle {
  constructor() {
    this.controller = new AbortController();
    this.cleanups = [];
    this.cleanupStarted = false;
  }
  get signal() { return this.controller.signal; }
  own(cleanup) {
    if (this.cleanupStarted) throw new Error("cannot register cleanup after cleanup started");
    this.cleanups.push(cleanup);
    return cleanup;
  }
  abort(reason = new TimeoutError("iteration aborted")) {
    if (!this.signal.aborted) this.controller.abort(reason);
  }
  async cleanup() {
    if (this.cleanupStarted) return;
    this.cleanupStarted = true;
    const errors = [];
    for (const cleanup of this.cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "iteration cleanup failed");
  }
}

function effectiveTimeoutMs(seconds, deadline) {
  const configured = seconds * 1000;
  return deadline === undefined ? configured : Math.min(configured, deadline.remainingMs());
}
let activeIterationDeadline;
export function conditionTrue(resource, type) {
  const generation = resource?.metadata?.generation;
  return Number.isInteger(generation) && Array.isArray(resource?.status?.conditions) && resource.status.conditions.some(condition =>
    condition?.type === type && condition?.status === "True" &&
    Number.isInteger(condition?.observedGeneration) && condition.observedGeneration === generation);
}
export function routeAndFenceReady(resource, previousGeneration) {
  const generation = resource?.status?.runtimeGeneration;
  return typeof generation === "string" && generation.startsWith("gen_") &&
    (previousGeneration === undefined || generation !== previousGeneration) &&
    resource?.status?.fenceState === "FenceProven" && conditionTrue(resource, "RouteReady") &&
    resource?.status?.observedGeneration === resource?.metadata?.generation;
}
export function resumedCursor(before, after) {
  return before !== undefined && after !== undefined && before.epoch === after.epoch && after.seq >= before.seq;
}
export function liveWriterInvariant({ session, previousGeneration, previousPublicId, pods, leases }) {
  const generation = session?.status?.runtimeGeneration;
  const publicIdentity = session?.spec?.publicId;
  const activePods = pods.filter(pod => pod?.metadata?.deletionTimestamp === undefined &&
    pod?.status?.phase !== "Succeeded" && pod?.status?.phase !== "Failed");
  const heldLeases = leases.filter(lease => typeof lease?.spec?.holderIdentity === "string" && lease.spec.holderIdentity.length > 0);
  const podSnapshots = pods.map(pod => ({
    uid: pod?.metadata?.uid,
    name: pod?.metadata?.name,
    generation: pod?.metadata?.annotations?.["cluster.t4.dev/runtime-generation"] ?? null,
    nodeName: pod?.spec?.nodeName ?? null,
    deletionTimestamp: pod?.metadata?.deletionTimestamp ?? null,
    phase: pod?.status?.phase ?? null,
    ready: pod?.status?.conditions?.some(condition => condition?.type === "Ready" && condition?.status === "True") === true,
    active: pod?.metadata?.deletionTimestamp === undefined && pod?.status?.phase !== "Succeeded" && pod?.status?.phase !== "Failed",
  }));
  const leaseSnapshots = leases.map(lease => ({
    uid: lease?.metadata?.uid,
    name: lease?.metadata?.name,
    generation: lease?.metadata?.annotations?.["cluster.t4.dev/runtime-generation"] ?? null,
    holderIdentity: lease?.spec?.holderIdentity ?? null,
  }));
  const writer = activePods[0];
  const writerLease = heldLeases[0];
  const writerGeneration = writer?.metadata?.annotations?.["cluster.t4.dev/runtime-generation"];
  const leaseGeneration = writerLease?.metadata?.annotations?.["cluster.t4.dev/runtime-generation"];
  const reasons = [];
  if (generation === previousGeneration) reasons.push("generation-not-advanced");
  if (publicIdentity !== previousPublicId) reasons.push("public-id-changed");
  if (activePods.length !== 1) reasons.push(`active-session-writers=${activePods.length}`);
  if (heldLeases.length !== 1) reasons.push(`held-session-writer-leases=${heldLeases.length}`);
  if (activePods.length === 1 && writerGeneration !== generation) reasons.push(`writer-generation=${writerGeneration ?? "unknown"}`);
  if (heldLeases.length === 1 && leaseGeneration !== generation) reasons.push(`lease-generation=${leaseGeneration ?? "unknown"}`);
  if (activePods.length === 1 && heldLeases.length === 1 && writerLease.spec.holderIdentity !== writer.metadata.uid) reasons.push("writer-lease-holder-mismatch");
  if (!routeAndFenceReady(session, previousGeneration)) reasons.push("route-or-fence-not-ready");
  return {
    held: reasons.length === 0,
    reasons,
    generation,
    publicIdentity,
    podUid: writer?.metadata?.uid,
    leaseUid: writerLease?.metadata?.uid,
    snapshots: { pods: podSnapshots, leases: leaseSnapshots },
  };
}

async function executableIdentity(command) {
  let path = command;
  if (!path.includes("/")) {
    for (const directory of (process.env.PATH ?? "").split(":")) {
      const candidate = resolve(directory, path);
      try { await access(candidate, fsConstants.X_OK); path = candidate; break; } catch { /* continue */ }
    }
  }
  const canonical = await realpath(path).catch(() => { throw new RefusalError(`executable ${command} is unavailable`); });
  const data = await readFile(canonical);
  const metadata = await stat(canonical);
  return { path: canonical, sha256: createHash("sha256").update(data).digest("hex"), size: metadata.size };
}

async function fileIdentity(path) {
  const canonical = await realpath(path).catch(() => { throw new RefusalError(`identity input ${path} is unavailable`); });
  const metadata = await lstat(canonical);
  if (!metadata.isFile()) throw new RefusalError(`identity input ${path} is not a regular file`);
  const data = await readFile(canonical);
  return { path: canonical, sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
}

async function directoryIdentity(path) {
  const inputMetadata = await lstat(path).catch(() => { throw new RefusalError(`chart ${path} is unavailable`); });
  if (inputMetadata.isSymbolicLink()) throw new RefusalError("chart identity refuses a symbolic-link root");
  if (!inputMetadata.isDirectory()) throw new RefusalError(`chart ${path} is not a directory`);
  const root = await realpath(path);
  const hash = createHash("sha256");
  let files = 0; let bytes = 0;
  async function visit(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = resolve(directory, entry.name);
      const relativePath = relative(root, absolute);
      if (entry.isSymbolicLink()) throw new RefusalError(`chart identity refuses symbolic link ${relativePath}`);
      if (entry.isDirectory()) { await visit(absolute); continue; }
      if (!entry.isFile()) throw new RefusalError(`chart identity refuses non-file ${relativePath}`);
      const data = await readFile(absolute);
      files += 1; bytes += data.length;
      if (bytes > 16 * 1024 * 1024) throw new RefusalError("chart identity exceeds 16 MiB");
      hash.update(relativePath).update("\0").update(data).update("\0");
    }
  }
  await visit(root);
  if (files === 0) throw new RefusalError("chart directory is empty");
  return { kind: "directory", path: root, sha256: hash.digest("hex"), files, bytes };
}

export async function chartIdentity(path) {
  const metadata = await lstat(path).catch(() => { throw new RefusalError(`chart ${path} is unavailable`); });
  if (metadata.isSymbolicLink()) throw new RefusalError("chart identity refuses a symbolic-link root");
  if (metadata.isDirectory()) return directoryIdentity(path);
  if (!metadata.isFile()) throw new RefusalError(`chart ${path} is neither a regular archive nor a directory`);
  const identity = await fileIdentity(path);
  return { kind: "archive", ...identity };
}

function redactedArguments(args) {
  let redactNext = false;
  return args.slice(0, 128).map(argument => {
    if (redactNext) { redactNext = false; return "<redacted>"; }
    if (/^--?(?:token|secret|password|credential|api[-_]?key|access[-_]?key|authorization)$/iu.test(argument)) { redactNext = true; return argument; }
    if (/^bearer\s+/iu.test(argument)) return "Bearer <redacted>";
    return bounded(argument.replace(/((?:token|secret|password|credential|api[-_]?key|access[-_]?key|authorization)=)[^\s]+/giu, "$1<redacted>"), 2048);
  });
}

function redactedOutput(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*["']?bearer\s+)[^\s"',}\\]+/giu, "$1<redacted>")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+/giu, "$1<redacted>")
    .replace(/(["']?(?:token|secret|password|credential|api[-_]?key|access[-_]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu, "$1<redacted>")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, "<redacted-private-key>");
}

export class CommandRunner {
  constructor(rawPath, timeoutSeconds) { this.rawPath = rawPath; this.timeoutSeconds = timeoutSeconds; this.iteration = 0; this.eventSequence = 0; this.recordedBytes = 0; this.deadline = undefined; this.runToken = undefined; this.scenario = undefined; }
  async run(command, args, options = {}) {
    const startedAt = wallTime();
    if (options.record !== false && (typeof this.runToken !== "string" || typeof this.scenario !== "string")) {
      throw new Error("command evidence requires runToken and scenario correlation");
    }
    if (options.record !== false && this.recordedBytes + MIN_RECORD_RESERVE_BYTES > MAX_RAW_BYTES) throw new Error(`raw command artifact has no capacity for another bounded record`);
    const started = monotonicMs();
    const result = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, { cwd: options.cwd ?? REPOSITORY_ROOT, env: options.env ?? process.env, detached: process.platform !== "win32", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let overflow = false; let timedOut = false;
      const capture = (current, chunk) => { const next = Buffer.concat([current, chunk]); if (next.length > MAX_CAPTURE_BYTES) { overflow = true; return next.subarray(0, MAX_CAPTURE_BYTES); } return next; };
      child.stdout.on("data", chunk => { stdout = capture(stdout, chunk); });
      child.stderr.on("data", chunk => { stderr = capture(stderr, chunk); });
      child.on("error", rejectRun);
      const terminate = signal => {
        if (child.pid === undefined) return;
        try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch { /* already exited */ }
      };
      const timeoutMs = effectiveTimeoutMs(options.timeoutSeconds ?? this.timeoutSeconds, options.deadline ?? this.deadline);
      const timer = setTimeout(() => { timedOut = true; terminate("SIGTERM"); terminate("SIGKILL"); }, timeoutMs);
      if (options.input !== undefined) { child.stdin.end(options.input); }
      child.on("close", (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), overflow, timedOut }); });
    });
    let artifactError;
    if (options.record !== false) {
      let record = { schemaVersion: SLO_COMMAND_VERSION, runToken: this.runToken, scenario: this.scenario, iteration: this.iteration, eventSequence: this.eventSequence, startedAt, durationMs: monotonicMs() - started, executable: redactedOutput(command), args: redactedArguments(args), exitCode: result.code, signal: result.signal, stdout: redactedOutput(result.stdout), stderr: redactedOutput(result.stderr), overflow: result.overflow, timedOut: result.timedOut };
      let serialized = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
        record = { ...record, args: record.args.slice(0, 32), stdout: "<omitted: record limit>", stderr: "<omitted: record limit>", recordTruncated: true };
        serialized = `${JSON.stringify(record)}\n`;
      }
      let bytes = Buffer.byteLength(serialized);
      if (bytes > MAX_RECORD_BYTES) {
        artifactError = new Error(`command record exceeds ${MAX_RECORD_BYTES} bytes`);
      } else if (this.recordedBytes + bytes > MAX_RAW_BYTES) {
        record = { schemaVersion: SLO_COMMAND_VERSION, runToken: this.runToken, scenario: this.scenario, iteration: this.iteration, eventSequence: this.eventSequence, startedAt, durationMs: monotonicMs() - started, executable: bounded(redactedOutput(command), 512), args: [], exitCode: result.code, signal: result.signal, stdout: "<omitted: cumulative limit>", stderr: "<omitted: cumulative limit>", overflow: result.overflow, timedOut: result.timedOut, recordTruncated: true };
        serialized = `${JSON.stringify(record)}\n`;
        bytes = Buffer.byteLength(serialized);
        if (bytes > MIN_RECORD_RESERVE_BYTES) artifactError = new Error(`compact command record exceeds ${MIN_RECORD_RESERVE_BYTES} bytes`);
        if (this.recordedBytes + bytes > MAX_RAW_BYTES) artifactError = new Error(`raw command artifact exceeds ${MAX_RAW_BYTES} bytes`);
      }
      if (artifactError === undefined) {
        await appendFile(this.rawPath, serialized);
        this.recordedBytes += bytes;
      }
    }
    if (result.timedOut) throw new TimeoutError(`${basename(command)} timed out`);
    if (result.code !== 0 && !options.allowFailure) throw new Error(`${basename(command)} failed (${result.code}): ${bounded(redactedOutput(result.stderr))}`);
    if (result.overflow) throw new Error(`${basename(command)} output exceeded ${MAX_CAPTURE_BYTES} bytes`);
    if (artifactError !== undefined) throw artifactError;
    return result;
  }
}

export class Kubernetes {
  constructor(runner, kubectl, context, namespace) { this.runner = runner; this.kubectl = kubectl; this.context = context; this.namespace = namespace; }
  args(namespaced, ...args) { return ["--context", this.context, ...(namespaced ? ["-n", this.namespace] : []), ...args]; }
  async raw(namespaced, ...args) { return this.runner.run(this.kubectl, this.args(namespaced, ...args)); }
  async json(namespaced, ...args) { const result = await this.raw(namespaced, ...args, "-o", "json"); try { return JSON.parse(result.stdout); } catch { throw new Error(`kubectl returned invalid JSON for ${args.join(" ")}`); } }
  async get(kind, name) { return this.json(true, "get", `${kind}/${name}`); }
  async list(kind, ...extra) { return this.json(true, "get", kind, ...extra); }
}

async function poll(label, timeoutSeconds, operation, accept, intervalMs = 500) {
  const localExpiry = monotonicMs() + effectiveTimeoutMs(timeoutSeconds, activeIterationDeadline);
  let last;
  while (monotonicMs() < localExpiry) {
    try { last = await operation(); if (accept(last)) return last; } catch (error) { last = error; }
    const remaining = localExpiry - monotonicMs();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new TimeoutError(`${label} did not converge: ${bounded(last instanceof Error ? last.message : JSON.stringify(last))}`);
}

async function loadApi(baseUrl, token) {
  const { createT4ApiClient } = await import("../../packages/t4-api-client/src/index.ts");
  const boundedFetch = (input, init) => globalThis.fetch(input, {
    ...init,
    ...(activeIterationDeadline === undefined ? {} : { signal: activeIterationDeadline.signal() }),
  });
  return createT4ApiClient({ baseUrl, credential: token, fetch: boundedFetch });
}
async function apiCall(promise, label) {
  const result = await promise;
  if (result.error !== undefined) throw new Error(`${label} failed: ${bounded(JSON.stringify(result.error))}`);
  return result;
}
async function createWorkspace(api, scopeId, id, capacityBytes, displayName = "SLO workspace") {
  const result = await apiCall(api.http.PUT("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: id }, query: { scopeId } }, headers: { "If-None-Match": "*" }, body: { scopeId, displayName, capacityBytes, retention: "Delete" } }), "workspace creation");
  if (result.response.status !== 201 && result.response.status !== 202) throw new RefusalError(`workspace creation returned non-creation status ${result.response.status}`);
  return { data: result.data, etag: result.response.headers.get("etag") };
}
async function createRuntime(api, scopeId, id, workspaceId, hostProfileId) {
  const requestStartedAtMs = monotonicMs();
  const result = await apiCall(api.http.PUT("/v1/runtimes/{runtimeId}", { params: { path: { runtimeId: id }, query: { scopeId } }, headers: { "If-None-Match": "*" }, body: { scopeId, displayName: "SLO runtime", workspaceId, hostProfileId, desiredState: "Running", browserPolicy: "Disabled", idlePolicy: { enabled: false } } }), "runtime creation");
  if (result.response.status !== 201 && result.response.status !== 202) throw new RefusalError(`runtime creation returned non-creation status ${result.response.status}`);
  return { data: result.data, etag: result.response.headers.get("etag"), acceptedAtMs: monotonicMs(), requestStartedAtMs };
}
async function getResource(api, kind, scopeId, id) {
  const path = kind === "runtime" ? "/v1/runtimes/{runtimeId}" : "/v1/workspaces/{workspaceId}";
  const key = kind === "runtime" ? "runtimeId" : "workspaceId";
  const result = await apiCall(api.http.GET(path, { params: { path: { [key]: id }, query: { scopeId } } }), `${kind} read`);
  return { data: result.data, etag: result.response.headers.get("etag") };
}
async function assertResourceAbsent(api, kind, scopeId, id) {
  const path = kind === "runtime" ? "/v1/runtimes/{runtimeId}" : "/v1/workspaces/{workspaceId}";
  const key = kind === "runtime" ? "runtimeId" : "workspaceId";
  const result = await api.http.GET(path, { params: { path: { [key]: id }, query: { scopeId } } });
  if (result.data !== undefined) throw new RefusalError(`${kind} public id ${id} already exists`);
  if (result.error?.status !== 404) throw new RefusalError(`${kind} absence could not be proven: ${bounded(JSON.stringify(result.error))}`);
}
async function deleteResource(api, kind, scopeId, id, timeoutSeconds = 60) {
  const path = kind === "runtime" ? "/v1/runtimes/{runtimeId}" : "/v1/workspaces/{workspaceId}";
  const key = kind === "runtime" ? "runtimeId" : "workspaceId";
  const params = { path: { [key]: id }, query: { scopeId } };
  const readResult = await api.http.GET(path, { params });
  if (readResult.error?.status === 404) return;
  if (readResult.error !== undefined) throw new Error(`${kind} cleanup read failed: ${bounded(JSON.stringify(readResult.error))}`);
  const etag = readResult.response.headers.get("etag");
  if (!etag) throw new Error(`${kind} cleanup response had no ETag`);
  await apiCall(api.http.DELETE(path, { params, headers: { "If-Match": etag } }), `${kind} cleanup`);
  await poll(`${kind} deletion`, timeoutSeconds, () => api.http.GET(path, { params }), result => result.error?.status === 404);
}
async function patchWorkspace(api, scopeId, id, displayName) {
  const current = await getResource(api, "workspace", scopeId, id);
  if (!current.etag) throw new Error("workspace patch response had no ETag");
  return apiCall(api.http.PATCH("/v1/workspaces/{workspaceId}", { params: { path: { workspaceId: id }, query: { scopeId } }, headers: { "If-Match": current.etag, "Content-Type": "application/merge-patch+json" }, body: { displayName } }), "workspace patch");
}
async function findOwnedResource(kube, kind, publicIdentity) {
  const items = (await kube.list(kind)).items ?? [];
  const matches = items.filter(item => item?.spec?.publicId === publicIdentity || item?.metadata?.annotations?.["cluster.t4.dev/public-id"] === publicIdentity);
  if (matches.length !== 1) throw new Error(`expected exactly one ${kind} with public id ${publicIdentity}, found ${matches.length}`);
  return matches[0];
}
async function waitWorkspaceBound(kube, publicIdentity, timeoutSeconds) {
  return poll("workspace PVC Bound", timeoutSeconds, () => findOwnedResource(kube, "t4workspaces", publicIdentity), resource => resource?.status?.pvcPhase === "Bound" && conditionTrue(resource, "Ready"));
}
async function waitSessionReady(kube, publicIdentity, timeoutSeconds, previousGeneration) {
  return poll("FenceProven and RouteReady", timeoutSeconds, () => findOwnedResource(kube, "t4sessions", publicIdentity), resource => routeAndFenceReady(resource, previousGeneration));
}

async function verifyDeploymentImages(kube, config) {
  const controller = await kube.get("deployment", `${config.release}-controller`);

  const server = await kube.get("deployment", `${config.release}-server`);
  const controllerImage = controller?.spec?.template?.spec?.containers?.find(item => item.name === "controller")?.image;
  const serverImage = server?.spec?.template?.spec?.containers?.find(item => item.name === "server")?.image;
  const runtimeImage = controller?.spec?.template?.spec?.containers?.find(item => item.name === "controller")?.env?.find(item => item.name === "T4_SESSION_RUNTIME_IMAGE")?.value;
  if (controllerImage !== config.controllerImage || serverImage !== config.serverImage || runtimeImage !== config.runtimeImage) throw new RefusalError("live Deployment image identity does not match the required digest-pinned images");
  return { controllerImage, serverImage, runtimeImage };
}
export function deploymentBaseline(deployment) {
  const desired = deployment?.spec?.replicas;
  const generation = deployment?.metadata?.generation;
  if (!Number.isInteger(desired) || desired < 1 || !Number.isInteger(generation) ||
      deployment?.status?.observedGeneration !== generation ||
      deployment?.status?.readyReplicas !== desired ||
      deployment?.status?.availableReplicas !== desired) {
    throw new RefusalError("failover requires the current Deployment generation with every desired replica Ready and Available");
  }
  return { uid: deployment.metadata.uid, generation, desired };
}

async function requireDeploymentBaseline(kube, name, expected) {
  const deployment = await kube.get("deployment", name);
  const actual = deploymentBaseline(deployment);
  if (expected !== undefined && (actual.uid !== expected.uid || actual.generation !== expected.generation || actual.desired !== expected.desired)) {
    throw new RefusalError("failover Deployment baseline changed during the measurement run");
  }
  return actual;
}
async function verifyApiIdentity(api, commit) {
  const result = await apiCall(api.http.GET("/v1/version"), "version identity");
  if (result.data?.build?.revision !== commit) throw new RefusalError(`server build revision ${result.data?.build?.revision ?? "<missing>"} does not match T4_SLO_COMMIT`);
  return result.data;
}
async function clusterUid(kube) { return (await kube.json(false, "get", "namespace/kube-system"))?.metadata?.uid; }
function substituteImageInspection(argv, context, node) {
  return argv.map(value => value.replaceAll("{context}", context).replaceAll("{node}", node));
}
async function inspectNodeImages(kube, argv, node) {
  const substituted = substituteImageInspection(argv, kube.context, node);
  const result = await kube.runner.run(substituted[0], substituted.slice(1));
  let proof;
  try { proof = JSON.parse(result.stdout); } catch { throw new RefusalError(`node image inspector returned invalid JSON for ${node}`); }
  const exactKeys = proof !== null && typeof proof === "object" && !Array.isArray(proof) &&
    Object.keys(proof).sort().join(",") === "complete,context,images,node,runtime,schemaVersion";
  const validImages = Array.isArray(proof?.images) && proof.images.length <= 10_000 &&
    proof.images.every(image => typeof image === "string" && image.length <= 512 && DIGEST_IMAGE.test(image)) &&
    new Set(proof.images).size === proof.images.length;
  if (!exactKeys || proof.schemaVersion !== "t4-node-image-inspection/1" || proof.context !== kube.context || proof.node !== node ||
      proof.complete !== true || typeof proof.runtime !== "string" || proof.runtime.length === 0 || proof.runtime.length > 128 || !validImages) {
    throw new RefusalError(`node image inspector returned invalid, incomplete, or mismatched inventory for ${node}`);
  }
  return proof.images;
}
function sameImageDigest(left, right) {
  return left.slice(left.indexOf("@") + 1) === right.slice(right.indexOf("@") + 1);
}
async function verifyImageState(kube, images, expectedPresent, inspectorArgv) {
  const nodes = (await kube.list("nodes")).items ?? [];
  const candidates = nodes.filter(node => !node?.spec?.unschedulable && node?.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True"));
  if (candidates.length === 0) throw new RefusalError("no Ready schedulable node exists");
  const names = candidates.map(node => node?.metadata?.name);
  if (names.some(name => typeof name !== "string" || name.length === 0) || new Set(names).size !== names.length) throw new RefusalError("node identities are unavailable or duplicated");
  const wrong = [];
  for (const node of names) {
    const inventory = await inspectNodeImages(kube, inspectorArgv, node);
    for (const image of images) {
      const present = inventory.some(candidate => sameImageDigest(candidate, image));
      if (present !== expectedPresent) wrong.push(`${image} on ${node}`);
    }
  }
  if (wrong.length > 0) throw new RefusalError(`image cache prerequisite is not proven: ${wrong.join(", ")}`);
  return names;
}
async function verifyRuntimeImageState(kube, runtimeImage, expectedPresent, inspectorArgv) {
  return verifyImageState(kube, [runtimeImage], expectedPresent, inspectorArgv);
}
async function verifyWarmPrepull(kube, release, runtimeImage, inspectorArgv) {
  await verifyRuntimeImageState(kube, runtimeImage, true, inspectorArgv);
  const daemonset = await kube.get("daemonset", `${release}-runtime-prepull`);
  if (!Number.isInteger(daemonset?.status?.desiredNumberScheduled) || daemonset.status.desiredNumberScheduled < 1 || daemonset.status.numberReady !== daemonset.status.desiredNumberScheduled || daemonset.status.updatedNumberScheduled !== daemonset.status.desiredNumberScheduled) throw new RefusalError("imagePrePull DaemonSet is not fully ready");
}

function parseImageInspectorArgv(env) {
  let value;
  try { value = JSON.parse(required(env, "T4_SLO_NODE_IMAGE_INSPECT_ARGV")); } catch { throw new RefusalError("T4_SLO_NODE_IMAGE_INSPECT_ARGV must be a JSON string array"); }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.length === 0 || item.length > 2048)) throw new RefusalError("T4_SLO_NODE_IMAGE_INSPECT_ARGV must be a bounded non-empty JSON string array");
  const argumentsText = value.slice(1).join("\0");
  for (const placeholder of ["{context}", "{node}"]) if (!argumentsText.includes(placeholder)) throw new RefusalError(`T4_SLO_NODE_IMAGE_INSPECT_ARGV must contain a ${placeholder} argument placeholder`);
  return value;
}
function parseFailureArgv(env, name) {
  let value;
  try { value = JSON.parse(required(env, name)); } catch { throw new RefusalError(`${name} must be a JSON string array`); }
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.length === 0 || item.length > 2048)) throw new RefusalError(`${name} must be a bounded non-empty JSON string array`);
  if (!value.slice(1).some(item => item.includes("{node}"))) throw new RefusalError(`${name} must contain a {node} argument placeholder`);
  return value;
}
function substituteNode(argv, node) { return argv.map(value => value.replaceAll("{node}", node)); }

async function createSessionFixture(context, config, index, warm, lifecycle, runtimeBoundary) {
  const kube = new Kubernetes(context.runner, config.kubectl, context.context, context.namespace);
  const api = await loadApi(context.restBaseUrl, context.apiToken);
  const suffix = `${config.runToken}-${index}`;
  const workspaceId = publicId(`ws-slo-${suffix}`, "workspace id");
  const runtimeId = publicId(`rt-slo-${suffix}`, "runtime id");
  await verifyDeploymentImages(kube, config);
  if (warm) await verifyWarmPrepull(kube, config.release, config.runtimeImage, config.imageInspectorArgv);
  else await verifyRuntimeImageState(kube, config.runtimeImage, false, config.imageInspectorArgv);
  await assertResourceAbsent(api, "workspace", config.scopeId, workspaceId);
  await assertResourceAbsent(api, "runtime", config.scopeId, runtimeId);
  lifecycle.own(async () => {
    await deleteResource(api, "runtime", config.scopeId, runtimeId, config.cleanupTimeoutSeconds);
    await deleteResource(api, "workspace", config.scopeId, workspaceId, config.cleanupTimeoutSeconds);
  });
  await createWorkspace(api, config.scopeId, workspaceId, config.workspaceCapacityBytes);
  if (warm) await waitWorkspaceBound(kube, workspaceId, config.timeoutSeconds);
  await runtimeBoundary?.start();
  const runtime = await createRuntime(api, config.scopeId, runtimeId, workspaceId, config.hostProfileId);
  return { kube, api, workspaceId, runtimeId, requestStartedAtMs: runtime.requestStartedAtMs };
}

async function measureSessionAttach(context, config, index, warm, lifecycle, boundary) {
  const fixture = await createSessionFixture(context, config, index, warm, lifecycle, boundary);
  const session = await waitSessionReady(fixture.kube, fixture.runtimeId, config.timeoutSeconds);
  return {
    seconds: (monotonicMs() - fixture.requestStartedAtMs) / 1000,
    detail: `boundary=requestStartedAtMs workspace=${fixture.workspaceId} runtime=${fixture.runtimeId} generation=${session.status.runtimeGeneration} fence=FenceProven route=RouteReady`,
    proof: { workspaceId: fixture.workspaceId, runtimeId: fixture.runtimeId, generation: session.status.runtimeGeneration, fenceState: session.status.fenceState },
  };
}

export class WebSocketTransport {
  constructor(url, token, timeoutMs, deadline = activeIterationDeadline) { this.url = url; this.token = token; this.timeoutMs = timeoutMs; this.deadline = deadline; this.socket = undefined; this.messages = new Set(); this.closes = new Set(); this.errors = new Set(); }
  async open() {
    const { WebSocket } = await import("ws");
    const timeoutMs = this.deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, this.deadline.remainingMs());
    const socket = new WebSocket(this.url, { perMessageDeflate: false, maxPayload: 1_048_576, handshakeTimeout: timeoutMs, headers: { Authorization: `Bearer ${this.token}` } });
    this.socket = socket;
    socket.on("message", data => { for (const listener of this.messages) listener(data); });
    socket.on("close", (code, reason) => { for (const listener of this.closes) listener(code, reason.toString()); });
    socket.on("error", error => { for (const listener of this.errors) listener(error); });
    const abort = () => socket.terminate();
    const signal = this.deadline?.signal();
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", abort));
    await new Promise((resolveOpen, rejectOpen) => { socket.once("open", resolveOpen); socket.once("error", rejectOpen); });
  }
  send(data) { if (!this.socket) throw new Error("WebSocket is not open"); this.socket.send(data); }
  close(code, reason) { this.socket?.close(code, reason); }
  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener); }
  onClose(listener) { this.closes.add(listener); return () => this.closes.delete(listener); }
  onError(listener) { this.errors.add(listener); return () => this.errors.delete(listener); }
}

export async function awaitAutomaticGatewayResume({ client, projection, key, host, sessionId, beforeCursor, survivorUids, timeoutSeconds, signal }) {
  let observedLoss = false;
  const survivor = Promise.withResolvers();
  const replay = Promise.withResolvers();
  const unsubscribeState = client.onState(state => {
    if (state.state !== "ready") {
      observedLoss = true;
      return;
    }
    if (!observedLoss) return;
    const replicaUid = typeof state.epoch === "string" && state.epoch.startsWith("replica:")
      ? state.epoch.slice("replica:".length)
      : undefined;
    if (state.authentication === "paired" && survivorUids.has(replicaUid)) survivor.resolve(replicaUid);
  });
  const unsubscribeEvent = client.onEvent(event => {
    const response = event?.kind === "response" ? event.payload : undefined;
    if (response?.command !== "session.attach" || String(response.hostId) !== host ||
        String(response.sessionId) !== sessionId || response.ok !== true) return;
    const result = response.result;
    const cursor = result && typeof result === "object" && !Array.isArray(result) ? result.cursor : undefined;
    if (resumedCursor(beforeCursor, cursor)) replay.resolve(cursor);
  });
  const abort = () => {
    const error = signal?.reason instanceof Error ? signal.reason : new TimeoutError("gateway resume was aborted");
    survivor.reject(error);
    replay.reject(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    survivor.reject(new TimeoutError("original omp-app/1 client did not reconnect to a pre-existing Ready survivor"));
    replay.reject(new TimeoutError("original omp-app/1 client did not automatically replay session.attach from its saved cursor"));
  }, timeoutSeconds * 1000);
  try {
    const [newReplicaUid, acknowledgedCursor] = await Promise.all([survivor.promise, replay.promise]);
    const resumedProjection = await poll(
      "automatically resumed attached cursor projection",
      timeoutSeconds,
      () => projection.snapshot.sessions.get(key),
      value => value?.freshness === "fresh" && resumedCursor(beforeCursor, value.cursor),
    );
    return { newReplicaUid, acknowledgedCursor, resumedProjection };
  } finally {
    clearTimeout(timer);
    unsubscribeState();
    unsubscribeEvent();
    signal?.removeEventListener("abort", abort);
  }
}

async function measureGateway(context, config, index, lifecycle, boundary) {
  const fixture = await createSessionFixture(context, config, index, true, lifecycle);
  const session = await waitSessionReady(fixture.kube, fixture.runtimeId, config.timeoutSeconds);
  const internalSession = session.metadata.name;
  const { OmpClient, ProjectionStore } = await import("../../packages/client/src/index.ts");
  const cursors = new Map();
  const cursorStore = {
    load: () => [...cursors.values()],
    save: record => { cursors.set(`${record.hostId}\0${record.sessionId}`, record); },
  };
  const projection = new ProjectionStore();
  const client = new OmpClient({
    reconnect: { baseMs: 50, maxMs: 500 },
    heartbeat: { intervalMs: 250, timeoutMs: 2_000 },
    handshakeTimeoutMs: config.timeoutSeconds * 1000,
    authentication: () => ({ deviceId: config.deviceId, deviceToken: config.deviceToken }),
    projection,
    cursorStore,
    transport: async () => {
      const transport = new WebSocketTransport(context.ompUrl, context.apiToken, config.timeoutSeconds * 1000);
      await transport.open();
      return transport;
    },
  });
  lifecycle.own(() => client.close());
  await client.connect();
  const beforeState = client.snapshot();
  if (beforeState.state !== "ready" || beforeState.authentication !== "paired" || typeof beforeState.epoch !== "string" || !beforeState.epoch.startsWith("replica:")) throw new RefusalError("omp-app/1 client did not establish paired replica identity");
  const host = beforeState.hostId;
  if (!host) throw new RefusalError("omp-app/1 welcome did not identify a host");
  const attached = await client.attach(host, internalSession, { timeoutMs: config.timeoutSeconds * 1000 });
  if (!attached.ok) throw new Error("omp-app/1 session.attach was rejected");
  const key = `${host}\0${internalSession}`;
  const initial = await poll("initial attached cursor", config.timeoutSeconds, () => projection.snapshot.sessions.get(key), value => value?.freshness === "fresh" && value.cursor !== undefined);
  const beforeCursor = initial.cursor;
  await poll("durable cursor save", config.timeoutSeconds, () => cursors.get(key), value => resumedCursor(beforeCursor, value?.cursor));
  const victimUid = beforeState.epoch.slice("replica:".length);
  const pods = (await fixture.kube.list("pods", "-l", `app.kubernetes.io/instance=${config.release},app.kubernetes.io/component=server`)).items ?? [];
  const victims = pods.filter(pod => pod?.metadata?.uid === victimUid && pod?.metadata?.deletionTimestamp === undefined);
  if (victims.length !== 1) throw new RefusalError(`welcome replica UID maps to ${victims.length} serving Pods`);
  const survivorUids = new Set(pods.filter(pod => pod?.metadata?.uid !== victimUid && pod?.metadata?.deletionTimestamp === undefined && pod?.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True")).map(pod => pod.metadata.uid));
  if (survivorUids.size === 0) throw new RefusalError("gateway failover requires a Ready server replica other than the serving Pod");
  const victim = victims[0].metadata.name;
  const automaticResume = awaitAutomaticGatewayResume({
    client, projection, key, host, sessionId: internalSession, beforeCursor, survivorUids, timeoutSeconds: config.timeoutSeconds, signal: lifecycle.signal,
  });
  lifecycle.own(async () => {
    lifecycle.abort(new Error("gateway iteration cleanup"));
    await automaticResume.catch(() => undefined);
  });
  await boundary.start();
  const terminationAt = monotonicMs();
  await fixture.kube.raw(true, "delete", `pod/${victim}`, `--uid=${victimUid}`, "--wait=false");
  const { newReplicaUid, acknowledgedCursor, resumedProjection } = await automaticResume;
  return {
    seconds: (monotonicMs() - terminationAt) / 1000,
    detail: `victim=${victim} oldReplica=${victimUid} newReplica=${newReplicaUid} cursor=${beforeCursor.epoch}:${beforeCursor.seq}->${resumedProjection.cursor.seq} acknowledged=${acknowledgedCursor.seq} protocol=omp-app/1 sameClient=true automaticResume=true`,
    proof: { victim, oldReplicaUid: victimUid, newReplicaUid, beforeCursor, acknowledgedCursor, resumedCursor: resumedProjection.cursor },
  };
}

async function measureController(context, config, index, lifecycle, boundary) {
  const suffix = `${config.runToken}-leader-${index}`;
  const api = await loadApi(context.restBaseUrl, context.apiToken);
  const kube = new Kubernetes(context.runner, config.kubectl, context.context, context.namespace);
  await verifyDeploymentImages(kube, config); await verifyApiIdentity(api, config.commit);
  const workspaceId = publicId(`ws-${suffix}`, "leader probe workspace id");
  await assertResourceAbsent(api, "workspace", config.scopeId, workspaceId);
  lifecycle.own(() => deleteResource(api, "workspace", config.scopeId, workspaceId, config.cleanupTimeoutSeconds));
  await createWorkspace(api, config.scopeId, workspaceId, config.workspaceCapacityBytes, "leader probe before");
  const resource = await waitWorkspaceBound(kube, workspaceId, config.timeoutSeconds);
  const holder = (await kube.get("lease", "t4-cluster-operator.cluster.t4.dev"))?.spec?.holderIdentity;
  if (typeof holder !== "string" || !holder.includes("_")) throw new RefusalError("controller Lease has no parseable holderIdentity");
  const victim = holder.slice(0, holder.indexOf("_"));
  const pods = (await kube.list("pods", "-l", `app.kubernetes.io/instance=${config.release},app.kubernetes.io/component=controller`)).items ?? [];
  const victimPod = pods.find(pod => pod?.metadata?.name === victim && pod?.metadata?.deletionTimestamp === undefined);
  const survivors = pods.filter(pod => pod?.metadata?.name !== victim && pod?.metadata?.deletionTimestamp === undefined && pod?.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True"));
  if (!victimPod || survivors.length < 1) throw new RefusalError("controller failover requires the holder Pod and a Ready survivor");
  await boundary.start();
  const started = monotonicMs();
  await kube.raw(true, "delete", `pod/${victim}`, `--uid=${victimPod.metadata.uid}`, "--wait=false");
  const newHolder = await poll("new controller Lease holder", config.timeoutSeconds, () => kube.get("lease", "t4-cluster-operator.cluster.t4.dev"), lease => typeof lease?.spec?.holderIdentity === "string" && lease.spec.holderIdentity !== holder && survivors.some(pod => lease.spec.holderIdentity.startsWith(`${pod.metadata.name}_`)));
  await patchWorkspace(api, config.scopeId, workspaceId, "leader probe after");
  const reconciled = await poll("post-failover workspace reconcile", config.timeoutSeconds, () => findOwnedResource(kube, "t4workspaces", workspaceId), item => item.metadata.generation > resource.metadata.generation && item.status?.observedGeneration === item.metadata.generation && conditionTrue(item, "Ready"));
  return {
    seconds: (monotonicMs() - started) / 1000,
    detail: `oldHolder=${holder} newHolder=${newHolder.spec.holderIdentity} reconcile=t4workspace/${reconciled.metadata.name}@${reconciled.status.observedGeneration}`,
    proof: { oldHolder: holder, newHolder: newHolder.spec.holderIdentity, workspaceId, reconciledGeneration: reconciled.status.observedGeneration },
  };
}

function nodeFaultState(node) {
  return canonical({
    uid: node?.metadata?.uid,
    unschedulable: node?.spec?.unschedulable === true,
    taints: node?.spec?.taints ?? [],
    conditions: (node?.status?.conditions ?? []).map(condition => ({
      type: condition.type,
      status: condition.status,
      reason: condition.reason,
    })).sort((left, right) => left.type.localeCompare(right.type)),
  });
}

export async function captureFencedBaseline(kube, session, workspace, nodeName) {
  const node = await kube.json(false, "get", `node/${nodeName}`);
  const pvcNames = [workspace?.status?.pvcName, session?.status?.runtimeStatePVCName];
  if (pvcNames.some(name => typeof name !== "string" || name.length === 0) || new Set(pvcNames).size !== pvcNames.length) {
    throw new RefusalError("fenced baseline requires distinct authoritative workspace and runtime-state PVCs");
  }
  const pvcs = [];
  for (const name of pvcNames) pvcs.push(await kube.get("persistentvolumeclaim", name));
  const volumeNames = pvcs.map(pvc => pvc?.spec?.volumeName);
  if (volumeNames.some(name => typeof name !== "string" || name.length === 0) || new Set(volumeNames).size !== volumeNames.length) {
    throw new RefusalError("fenced baseline requires two distinct bound volume identities");
  }
  const attachments = (await kube.json(false, "get", "volumeattachments")).items ?? [];
  const storage = pvcs.map(pvc => ({
    uid: pvc.metadata?.uid,
    name: pvc.metadata?.name,
    storageClassName: pvc.spec?.storageClassName,
    accessModes: [...(pvc.spec?.accessModes ?? [])].sort(),
    volumeName: pvc.spec?.volumeName,
    phase: pvc.status?.phase,
  }));
  const volumeAttachments = attachments.filter(item => volumeNames.includes(item?.spec?.source?.persistentVolumeName)).map(item => ({
    uid: item.metadata?.uid,
    volumeName: item.spec?.source?.persistentVolumeName,
    attacher: item.spec?.attacher,
    nodeName: item.spec?.nodeName,
    attached: item.status?.attached === true,
  })).sort((left, right) => left.volumeName.localeCompare(right.volumeName));
  return canonical({
    node: nodeFaultState(node),
    storage,
    volumeAttachments,
    fence: {
      fenceState: session?.status?.fenceState,
      fencingVolumeIdentity: session?.status?.fencingVolumeIdentity ?? null,
      runtimeStateVolumeIdentity: session?.status?.runtimeStateVolumeIdentity,
    },
  });
}

async function requireFencedBaselineRestored(kube, baseline, runtimeId, workspaceId, nodeName, timeoutSeconds) {
  return poll("fenced node/storage/attachment baseline restoration", timeoutSeconds, async () => {
    const session = await findOwnedResource(kube, "t4sessions", runtimeId);
    const workspace = await findOwnedResource(kube, "t4workspaces", workspaceId);
    return captureFencedBaseline(kube, session, workspace, nodeName);
  }, snapshot => JSON.stringify(snapshot) === JSON.stringify(baseline));
}

async function measureFenced(context, config, index, lifecycle, boundary) {
  const fixture = await createSessionFixture(context, config, index, true, lifecycle);
  try {
    const before = await waitSessionReady(fixture.kube, fixture.runtimeId, config.timeoutSeconds);
    const oldGeneration = before.status.runtimeGeneration; const oldPublicId = before.spec.publicId; const oldPodUid = before.status.podUid;
    const pod = await fixture.kube.get("pod", before.status.podName);
    const node = pod?.spec?.nodeName;
    if (!node || pod?.metadata?.uid !== oldPodUid) throw new RefusalError("runtime status does not identify its live Pod and node");
    const workspace = await findOwnedResource(fixture.kube, "t4workspaces", fixture.workspaceId);
    const baseline = await captureFencedBaseline(fixture.kube, before, workspace, node);
    lifecycle.own(async () => {
      await context.runner.run(config.recoveryArgv[0], substituteNode(config.recoveryArgv.slice(1), node), { timeoutSeconds: config.cleanupTimeoutSeconds });
      await requireFencedBaselineRestored(fixture.kube, baseline, fixture.runtimeId, fixture.workspaceId, node, config.cleanupTimeoutSeconds);
    });
    await context.runner.run(config.failureArgv[0], substituteNode(config.failureArgv.slice(1), node), { timeoutSeconds: config.timeoutSeconds });
    await poll("node loss", config.timeoutSeconds, () => fixture.kube.list("nodes"), listValue => {
      const current = (listValue.items ?? []).find(item => item?.metadata?.name === node);
      return current === undefined || !current?.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True");
    });
    await boundary.start();
    const lossAt = monotonicMs();
    const after = await waitSessionReady(fixture.kube, fixture.runtimeId, config.timeoutSeconds, oldGeneration);
    const ownedPods = (await fixture.kube.list("pods")).items?.filter(item => item?.metadata?.ownerReferences?.some(owner => owner.uid === after.metadata.uid && owner.controller === true)) ?? [];
    const ownedLeases = (await fixture.kube.list("leases")).items?.filter(item => item?.metadata?.ownerReferences?.some(owner => owner.uid === after.metadata.uid && owner.controller === true)) ?? [];
    const verdict = liveWriterInvariant({ session: after, previousGeneration: oldGeneration, previousPublicId: oldPublicId, pods: ownedPods, leases: ownedLeases });
    if (!verdict.held) throw new Error(`invariant=violated ${verdict.reasons.join(",")}`);
    return {
      seconds: (monotonicMs() - lossAt) / 1000,
      detail: `invariant=held mechanism=${config.failureMechanismId} storageDriver=${config.storageDriver} node=${node} generation=${oldGeneration}->${after.status.runtimeGeneration} publicId=${oldPublicId} writer=${verdict.podUid}`,
      proof: { oldGeneration, newGeneration: after.status.runtimeGeneration, publicId: oldPublicId, node, writerInvariant: verdict, baseline },
    };
  } catch (error) {
    if (!String(error.message).includes("invariant=")) error.message = `${error.message} invariant=violated`;
    throw error;
  }
}

export function extractRenderedImages(source) {

  const images = [...source.matchAll(/^\s*(?:-\s*)?image:\s*["']?([^\s"']+)["']?\s*$/gmu)].map(match => match[1]);
  return [...new Set(images)];
}

export async function verifyImagePublicationInput(path, config) {
  const identity = await fileIdentity(path);
  const manifestRelativePath = relative(REPOSITORY_ROOT, identity.path);
  if (!manifestRelativePath.startsWith("artifacts/cluster-proof/")) throw new RefusalError("image publication manifest must stay under artifacts/cluster-proof");
  let manifest;
  try { manifest = validateImagePublicationManifest(JSON.parse(await readFile(identity.path, "utf8"))); }
  catch (error) { throw new RefusalError(`image publication manifest is invalid: ${error.message}`); }
  if (manifest.source.commit !== config.commit) throw new RefusalError("image publication manifest source commit does not match T4_SLO_COMMIT");
  const expected = new Map([
    ["controller", config.controllerImage],
    ["cluster-server", config.serverImage],
    ["session-runtime", config.runtimeImage],
  ]);
  for (const [component, reference] of expected) {
    const image = manifest.images.find(candidate => candidate.component === component);
    if (image?.reference !== reference) throw new RefusalError(`image publication manifest ${component} reference/digest does not match the measured image`);
    if (image.provenance.mode !== "cosign-keyless") {
      throw new RefusalError(`${component} must have retained cosign-keyless Sigstore provenance evidence`);
    }
    for (const evidence of [image.sbom, image.provenance, image.provenance.bundle, image.vulnerability]) {
      const actual = await fileIdentity(resolve(REPOSITORY_ROOT, evidence.path));
      if (actual.sha256 !== evidence.sha256) throw new RefusalError(`${component} immutable artifact hash does not match ${evidence.path}`);
      if (evidence === image.provenance.bundle && actual.size !== evidence.bytes) {
        throw new RefusalError(`${component} Sigstore bundle size does not match ${evidence.path}`);
      }
    }
  }
  return { ...identity, path: manifestRelativePath, source: manifest.source, measuredImages: [...expected.keys()] };
}

export async function captureSourceIdentity(runner, env, config) {
  const head = (await runner.run("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, record: false })).stdout.trim();
  const headTreeHash = (await runner.run("git", ["rev-parse", "HEAD^{tree}"], { cwd: REPOSITORY_ROOT, record: false })).stdout.trim();
  if (head !== config.commit) throw new RefusalError("checked-out source HEAD does not match T4_SLO_COMMIT");
  const status = (await runner.run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: REPOSITORY_ROOT, record: false })).stdout;
  const dirty = status.length > 0;
  let retainedPatch = null;
  if (dirty) {
    const patchPath = required(env, "T4_SLO_RETAINED_PATCH");
    const actual = await fileIdentity(resolve(patchPath));
    const patchRelativePath = relative(REPOSITORY_ROOT, actual.path);
    if (!patchRelativePath.startsWith("artifacts/cluster-slo/retained-source/")) throw new RefusalError("T4_SLO_RETAINED_PATCH must stay under artifacts/cluster-slo/retained-source");
    const untracked = status.split("\n").filter(line => line.startsWith("?? ")).map(line => line.slice(3));
    if (untracked.some(path => path !== patchRelativePath)) throw new RefusalError("dirty source contains untracked files that are not the retained patch artifact");
    const diff = (await runner.run("git", ["diff", "--binary", "HEAD"], { cwd: REPOSITORY_ROOT, record: false })).stdout;
    const supplied = await readFile(actual.path, "utf8");
    if (supplied !== diff) throw new RefusalError("T4_SLO_RETAINED_PATCH is not the exact git diff --binary HEAD artifact");
    retainedPatch = { ...actual, path: patchRelativePath };
  }
  const harness = await directoryIdentity(HERE);
  return {
    commit: head,
    headTreeHash,
    repositoryTreeHash: createHash("sha256").update(headTreeHash).update("\0").update(retainedPatch?.sha256 ?? "clean").digest("hex"),
    harnessTreeHash: harness.sha256,
    dirty,
    retainedPatch,
  };
}
export async function measureControlPlane(context, config, lifecycle = new IterationLifecycle(), boundary = { start: async () => {} }) {
  const kube = new Kubernetes(context.runner, config.kubectl, context.context, context.namespace);
  const namespaceProbe = await context.runner.run(config.kubectl, ["--context", context.context, "get", `namespace/${context.namespace}`, "--ignore-not-found", "-o", "json"]);
  if (namespaceProbe.stdout.trim().length > 0) throw new RefusalError(`disposable namespace ${context.namespace} already exists`);
  const helmContext = ["--kube-context", context.context];
  const valueArgs = ["--values", config.valuesFile, "--set-string", `images.controller.repository=${config.controllerImage.split("@")[0]}`, "--set-string", `images.controller.digest=${config.controllerImage.split("@")[1]}`, "--set-string", `images.server.repository=${config.serverImage.split("@")[0]}`, "--set-string", `images.server.digest=${config.serverImage.split("@")[1]}`, "--set-string", `images.sessionRuntime.repository=${config.runtimeImage.split("@")[0]}`, "--set-string", `images.sessionRuntime.digest=${config.runtimeImage.split("@")[1]}`];
  const rendered = await context.runner.run(config.helm, ["template", config.release, config.chart, "--namespace", context.namespace, ...helmContext, ...valueArgs]);
  const renderedImages = extractRenderedImages(rendered.stdout);
  if (renderedImages.length < 3 || renderedImages.some(image => !DIGEST_IMAGE.test(image))) throw new RefusalError("every rendered chart image must be digest-pinned");
  await verifyImageState(kube, renderedImages, false, config.imageInspectorArgv);
  lifecycle.own(async () => {
    await context.runner.run(config.helm, ["uninstall", config.release, "--namespace", context.namespace, "--wait", `--timeout=${config.cleanupTimeoutSeconds}s`, ...helmContext], { allowFailure: true });
    await context.runner.run(config.kubectl, ["--context", context.context, "delete", `namespace/${context.namespace}`, "--ignore-not-found=true", "--wait=true", `--timeout=${config.cleanupTimeoutSeconds}s`]);
  });
  const installStarted = monotonicMs();
  await context.runner.run(config.helm, ["install", config.release, config.chart, "--namespace", context.namespace, "--create-namespace", "--skip-crds", "--wait=false", ...helmContext, ...valueArgs]);
  const installReturned = monotonicMs();
  await boundary.start();
  const deployments = await poll("control-plane Deployments Available", config.timeoutSeconds, () => kube.list("deployments", "-l", `app.kubernetes.io/instance=${config.release}`), listValue => {
    const required = ["controller", "server"].map(component => listValue.items?.find(item => item?.metadata?.labels?.["app.kubernetes.io/component"] === component));
    return required.every(item => item && item.status?.availableReplicas === item.spec?.replicas && item.status?.readyReplicas === item.spec?.replicas && item.status?.observedGeneration === item.metadata?.generation && item.status?.conditions?.some(condition => condition.type === "Available" && condition.status === "True"));
  });
  const identity = Object.fromEntries(deployments.items.filter(item => ["controller", "server"].includes(item?.metadata?.labels?.["app.kubernetes.io/component"])).map(item => [item.metadata.labels["app.kubernetes.io/component"], { uid: item.metadata.uid, generation: item.metadata.generation, images: item.spec.template.spec.containers.map(container => container.image) }]));
  const controllerDeployment = deployments.items.find(item => item?.metadata?.labels?.["app.kubernetes.io/component"] === "controller");
  const serverDeployment = deployments.items.find(item => item?.metadata?.labels?.["app.kubernetes.io/component"] === "server");
  const liveControllerImage = controllerDeployment?.spec?.template?.spec?.containers?.find(container => container.name === "controller")?.image;
  const liveServerContainer = serverDeployment?.spec?.template?.spec?.containers?.find(container => container.name === "server");
  const liveRuntimeImage = controllerDeployment?.spec?.template?.spec?.containers?.find(container => container.name === "controller")?.env?.find(variable => variable.name === "T4_SESSION_RUNTIME_IMAGE")?.value;
  const liveRevision = liveServerContainer?.env?.find(variable => variable.name === "T4_BUILD_REVISION")?.value;
  if (liveControllerImage !== config.controllerImage || liveServerContainer?.image !== config.serverImage || liveRuntimeImage !== config.runtimeImage || liveRevision !== config.commit) {
    throw new Error("installed control-plane source or image identity does not match the declared run identity");
  }
  return {
    seconds: (monotonicMs() - installReturned) / 1000,
    detail: `helmRequestMs=${installReturned - installStarted} cluster=${context.clusterUid} namespace=${context.namespace} images=${renderedImages.length} controller=${identity.controller?.uid} server=${identity.server?.uid}`,
    proof: { clusterUid: context.clusterUid, namespace: context.namespace, renderedImages, deployments: identity },
  };
}
async function verifyLedgerIdentity(config) {
  const path = resolve(REPOSITORY_ROOT, "compat/cluster-slo-evidence-v1.json");
  const source = await readFile(path, "utf8");
  let ledger;
  try { ledger = JSON.parse(source); }
  catch { throw new RefusalError("SLO evidence ledger is not valid JSON"); }
  const expected = new Map([
    ["controller", config.controllerImage],
    ["cluster-server", config.serverImage],
    ["session-runtime", config.runtimeImage],
  ]);
  if (ledger.source?.commit !== config.commit) throw new RefusalError("T4_SLO_COMMIT does not match the SLO evidence ledger source commit");
  for (const [component, image] of expected) {
    const record = ledger.images?.find(candidate => candidate?.component === component);
    const separator = image.lastIndexOf("@");
    const reference = image.slice(0, separator);
    const digest = image.slice(separator + 1);
    if (!record || record.digest !== digest || (record.reference !== reference && record.reference !== image)) {
      throw new RefusalError(`T4_SLO_${component.replaceAll("-", "_").toUpperCase()}_IMAGE does not match the SLO evidence ledger`);
    }
  }
  const expectedBuild = { mode: config.buildMode, flags: config.buildFlags, provenanceMode: "buildkit-content", platform: config.platform, architecture: config.architecture };
  if (JSON.stringify(canonical(ledger.build)) !== JSON.stringify(canonical(expectedBuild))) throw new RefusalError("explicit build mode/flags/platform/architecture do not exactly match the SLO evidence ledger");
  const environment = ledger.environments?.find(candidate => candidate?.id === config.environmentId);
  if (!environment) throw new RefusalError("T4_SLO_ENVIRONMENT_ID is not present in the SLO evidence ledger");
  if ((config.scenario === "control-plane-cold-start" || config.scenario === "session-cold-first-attach") && environment.imagePrePulled !== false) throw new RefusalError("cold scenario requires a ledger environment with imagePrePulled=false");
  if (["session-warm-first-attach", "gateway-replica-failover", "fenced-generation-replacement"].includes(config.scenario) && environment.imagePrePulled !== true) throw new RefusalError("warm scenario requires a ledger environment with imagePrePulled=true");
  if (config.scenario === "fenced-generation-replacement" && environment.storageDriver !== config.storageDriver) throw new RefusalError("T4_SLO_STORAGE_DRIVER does not match the ledger environment");
  return { path, sha256: createHash("sha256").update(source).digest("hex"), snapshot: source, environment };
}

function scenarioContexts(env, scenario, config, runner) {
  if (scenario === "control-plane-cold-start") {
    const contexts = list(env, "T4_SLO_COLD_CONTEXTS", config.iterations);
    const prefix = safeId(required(env, "T4_SLO_DISPOSABLE_NAMESPACE_PREFIX"), "T4_SLO_DISPOSABLE_NAMESPACE_PREFIX");
    return contexts.map((context, index) => ({ runner, context, namespace: `${prefix}-${index + 1}`.slice(0, 63) }));
  }
  if (scenario === "session-cold-first-attach") {
    const contexts = list(env, "T4_SLO_COLD_CONTEXTS", config.iterations);

    const namespaces = list(env, "T4_SLO_COLD_NAMESPACES", config.iterations).map((value, index) => safeId(value, `T4_SLO_COLD_NAMESPACES[${index}]`));
    const restUrls = list(env, "T4_SLO_COLD_REST_BASE_URLS", config.iterations);
    const ompUrls = (env.T4_SLO_COLD_OMP_APP_URLS ?? restUrls.map(value => value.replace(/^https:/u, "wss:").replace(/\/v1$/u, "/v1/ws")).join(",")).split(",");
    return contexts.map((context, index) => ({ runner, context, namespace: namespaces[index], restBaseUrl: restUrls[index], ompUrl: ompUrls[index], apiToken: config.apiToken }));
  }
  return Array.from({ length: config.iterations }, () => ({ runner, context: config.context, namespace: config.namespace, restBaseUrl: config.restBaseUrl, ompUrl: config.ompUrl, apiToken: config.apiToken }));
}
function sortedUnique(values) { return [...new Set(values)].sort((left, right) => left.localeCompare(right)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function controlledBy(resource, kind, uid) {
  return resource?.metadata?.ownerReferences?.some(owner => owner?.controller === true && owner?.kind === kind && owner?.uid === uid) === true;
}

function storageRecord(pvc, storageClasses) {
  const storageClassName = pvc?.spec?.storageClassName;
  const storageClass = storageClasses.find(item => item?.metadata?.name === storageClassName);
  return {
    pvcUid: pvc?.metadata?.uid,
    pvcName: pvc?.metadata?.name,
    storageClassName,
    provisioner: storageClass?.provisioner,
    accessModes: [...(pvc?.spec?.accessModes ?? [])].sort(),
    binding: pvc?.status?.phase,
    volumeName: pvc?.spec?.volumeName,
  };
}

export function classifyOwnedStorage({ namespace, release, hosts, workspaces, sessions, pvcs, storageClasses }) {
  const inNamespace = resource => namespace === undefined || resource?.metadata?.namespace === namespace;
  const ownedHosts = hosts.filter(host => inNamespace(host) && host?.metadata?.labels?.["app.kubernetes.io/instance"] === release);
  const hostNames = new Set(ownedHosts.map(host => host?.metadata?.name));
  const ownedWorkspaces = workspaces.filter(workspace => inNamespace(workspace) && hostNames.has(workspace?.spec?.hostRef));
  const ownedSessions = sessions.filter(session => inNamespace(session) && hostNames.has(session?.spec?.hostRef));
  const scopedPvcs = pvcs.filter(inNamespace);
  const workspaceStorage = ownedWorkspaces.map(workspace => {
    const name = workspace?.status?.pvcName;
    const matches = scopedPvcs.filter(pvc => pvc?.metadata?.name === name &&
      (controlledBy(pvc, "T4Workspace", workspace?.metadata?.uid) ||
       pvc?.metadata?.annotations?.["cluster.t4.dev/workspace-uid"] === workspace?.metadata?.uid));
    if (matches.length !== 1) throw new RefusalError(`workspace ${workspace?.metadata?.name} does not have exactly one owned authoritative PVC`);
    const record = storageRecord(matches[0], storageClasses);
    const host = ownedHosts.find(candidate => candidate.metadata.name === workspace.spec.hostRef);
    const expectedClass = workspace.spec?.storageClassName ?? host?.spec?.storageClassName;
    if (record.storageClassName !== expectedClass || workspace.status?.selectedStorageClassName !== expectedClass ||
        record.accessModes.length !== 1 || record.accessModes[0] !== "ReadWriteMany" ||
        record.binding !== "Bound" || typeof record.pvcUid !== "string" || typeof record.volumeName !== "string" ||
        record.volumeName.length === 0 || typeof record.provisioner !== "string" || record.provisioner.length === 0) {
      throw new RefusalError(`workspace ${workspace.metadata.name} PVC does not match exact release storage policy`);
    }
    return record;
  });
  const runtimeStorage = ownedSessions.map(session => {
    const name = session?.status?.runtimeStatePVCName;
    const matches = scopedPvcs.filter(pvc => pvc?.metadata?.name === name && controlledBy(pvc, "T4Session", session?.metadata?.uid));
    if (matches.length !== 1) throw new RefusalError(`session ${session?.metadata?.name} does not have exactly one owned authoritative runtime-state PVC`);
    const record = storageRecord(matches[0], storageClasses);
    const host = ownedHosts.find(candidate => candidate.metadata.name === session.spec.hostRef);
    const expectedClass = host?.spec?.runtimeStateStorageProfile?.storageClassName;
    const expectedMode = host?.spec?.runtimeStateStorageProfile?.accessMode ?? "ReadWriteOncePod";
    if (record.storageClassName !== expectedClass || session.status?.runtimeStateStorageClassName !== expectedClass ||
        record.accessModes.length !== 1 || record.accessModes[0] !== expectedMode ||
        record.binding !== "Bound" || typeof record.pvcUid !== "string" || typeof record.volumeName !== "string" ||
        record.volumeName.length === 0 || typeof record.provisioner !== "string" || record.provisioner.length === 0) {
      throw new RefusalError(`session ${session.metadata.name} PVC does not match exact release runtime-state storage policy`);
    }
    return record;
  });
  return canonical({ workspace: workspaceStorage, runtimeState: runtimeStorage });
}

export async function captureEnvironmentFingerprint(kube, config) {
  const version = await kube.json(false, "version");
  const namespace = await kube.json(false, "get", "namespace/kube-system");
  const nodeList = await kube.list("nodes");
  const storageClassList = await kube.json(false, "get", "storageclasses");
  const csiDriverList = await kube.json(false, "get", "csidrivers");
  const disposableNamespace = config.scenario === "control-plane-cold-start";
  const pvcList = disposableNamespace ? { items: [] } : await kube.list("persistentvolumeclaims");
  const deploymentList = disposableNamespace ? { items: [] } : await kube.list("deployments", "-l", `app.kubernetes.io/instance=${config.release}`);
  const daemonSetList = disposableNamespace ? { items: [] } : await kube.list("daemonsets", "-l", `app.kubernetes.io/instance=${config.release}`);
  const hostList = disposableNamespace ? { items: [] } : await kube.list("t4clusterhosts", "-l", `app.kubernetes.io/instance=${config.release}`);
  const workspaceList = disposableNamespace ? { items: [] } : await kube.list("t4workspaces");
  const sessionList = disposableNamespace ? { items: [] } : await kube.list("t4sessions");
  const nodes = (nodeList.items ?? []).filter(node => !node?.spec?.unschedulable && node?.status?.conditions?.some(condition => condition.type === "Ready" && condition.status === "True")).map(node => ({
    uid: node.metadata.uid,
    name: node.metadata.name,
    architecture: node.status?.nodeInfo?.architecture,
    allocatableCpu: node.status?.allocatable?.cpu,
    allocatableMemory: node.status?.allocatable?.memory,
  })).sort((left, right) => left.uid.localeCompare(right.uid));
  if (nodes.length === 0 || nodes.some(node => Object.values(node).some(value => typeof value !== "string" || value.length === 0))) throw new RefusalError("live environment has incomplete Ready schedulable node identity/capacity");
  if (nodes.some(node => node.architecture !== config.architecture)) throw new RefusalError("live Ready schedulable node architecture does not match the measured build architecture");
  const deployments = deploymentList.items ?? [];
  const controller = deployments.find(item => item?.metadata?.labels?.["app.kubernetes.io/component"] === "controller");
  const featureEntries = controller?.spec?.template?.spec?.containers?.find(container => container.name === "controller")?.env
    ?.filter(variable => variable.name.startsWith("T4_FEATURE_") && typeof variable.value === "string")
    .map(variable => [variable.name, variable.value]) ?? [];
  const prepull = (daemonSetList.items ?? []).find(item => item?.metadata?.name === `${config.release}-runtime-prepull`);
  if (!disposableNamespace && (hostList.items ?? []).length === 0) {
    throw new RefusalError(`release ${config.release} has no exactly scoped T4ClusterHost configuration in namespace ${kube.namespace}`);
  }
  const storage = classifyOwnedStorage({
    namespace: kube.namespace,
    release: config.release,
    hosts: hostList.items ?? [],
    workspaces: workspaceList.items ?? [],
    sessions: sessionList.items ?? [],
    pvcs: pvcList.items ?? [],
    storageClasses: storageClassList.items ?? [],
  });
  const fingerprint = {
    kubernetesVersion: version?.serverVersion?.gitVersion,
    clusterUid: namespace?.metadata?.uid,
    nodes,
    storageClasses: (storageClassList.items ?? []).map(item => ({ name: item.metadata?.name, provisioner: item.provisioner })).sort((left, right) => left.name.localeCompare(right.name)),
    csiDrivers: sortedUnique((csiDriverList.items ?? []).map(item => item?.metadata?.name)),
    workspaceStorage: storage.workspace,
    runtimeStateStorage: storage.runtimeState,
    release: {
      name: config.release,
      namespace: kube.namespace,
      controllerUid: controller?.metadata?.uid ?? null,
      revision: Number(controller?.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? 0),
      features: Object.fromEntries(featureEntries.sort(([left], [right]) => left.localeCompare(right))),
      imagePrePull: prepull !== undefined && prepull.status?.numberReady === prepull.status?.desiredNumberScheduled && prepull.status?.desiredNumberScheduled > 0,
    },
  };
  if (typeof fingerprint.kubernetesVersion !== "string" || typeof fingerprint.clusterUid !== "string" ||
      fingerprint.storageClasses.some(item => typeof item.name !== "string" || typeof item.provisioner !== "string") ||
      fingerprint.csiDrivers.some(item => typeof item !== "string")) throw new RefusalError("live environment fingerprint is incomplete");
  return canonical(fingerprint);
}

export function requireLedgerEnvironmentMatch(ledgerIdentity, fingerprint, contextName, scenario) {
  const expected = ledgerIdentity.environment?.fingerprint;
  const cold = scenario === "control-plane-cold-start" || scenario === "session-cold-first-attach";
  let declared = expected;
  if (cold) {
    if (!Array.isArray(expected?.contexts)) throw new RefusalError("cold ledger environment fingerprint must declare context-keyed fingerprints");
    const matches = expected.contexts.filter(candidate => candidate?.context === contextName);
    if (matches.length !== 1) throw new RefusalError(`cold ledger environment must declare exactly one fingerprint for context ${contextName}`);
    declared = matches[0].fingerprint;
  } else if (expected?.contexts !== undefined) {
    throw new RefusalError("reused-context scenarios require one singular ledger environment fingerprint");
  }
  if (declared === undefined || JSON.stringify(canonical(declared)) !== JSON.stringify(canonical(fingerprint))) {
    throw new RefusalError(`live environment fingerprint for context ${contextName} does not exactly match the ledger environment`);
  }
}

export function requireLedgerEnvironmentFleet(ledgerIdentity, contexts, scenario) {
  const cold = scenario === "control-plane-cold-start" || scenario === "session-cold-first-attach";
  if (!cold) return;
  const declared = ledgerIdentity.environment?.fingerprint?.contexts;
  const actualContexts = contexts.map(context => context.context).sort();
  const declaredContexts = declared.map(candidate => candidate.context).sort();
  if (declared.length !== contexts.length || new Set(declaredContexts).size !== declaredContexts.length ||
      JSON.stringify(declaredContexts) !== JSON.stringify(actualContexts)) {
    throw new RefusalError("cold ledger environment fingerprint context set/count does not exactly match the measured iterations");
  }
  const declaredClusterUids = declared.map(candidate => candidate?.fingerprint?.clusterUid);
  if (new Set(declaredClusterUids).size !== declaredClusterUids.length) throw new RefusalError("cold ledger environment fingerprints must declare unique cluster UIDs");
}

async function preflightContexts(contexts, scenario, config, ledgerIdentity) {
  const identities = [];
  for (const context of contexts) {
    if (!context.context || context.context === "current") throw new RefusalError("an explicit Kubernetes context is required");
    const kube = new Kubernetes(context.runner, config.kubectl, context.context, context.namespace);
    const uid = await clusterUid(kube);
    if (typeof uid !== "string" || uid.length < 8) throw new RefusalError(`context ${context.context} has no cluster UID`);
    context.clusterUid = uid;
    context.fingerprint = await captureEnvironmentFingerprint(kube, config);
    requireLedgerEnvironmentMatch(ledgerIdentity, context.fingerprint, context.context, scenario);
    identities.push(uid);
    if (scenario !== "control-plane-cold-start") {
      const namespace = await kube.json(false, "get", `namespace/${context.namespace}`);
      if (namespace?.metadata?.uid === undefined) throw new RefusalError(`namespace ${context.namespace} identity is unavailable`);
      await verifyDeploymentImages(kube, config);
      const api = await loadApi(context.restBaseUrl, context.apiToken);
      context.apiVersion = await verifyApiIdentity(api, config.commit);
    }
  }
  if ((scenario === "control-plane-cold-start" || scenario === "session-cold-first-attach") && new Set(identities).size !== identities.length) throw new RefusalError("cold iterations require distinct disposable cluster UIDs");
  requireLedgerEnvironmentFleet(ledgerIdentity, contexts, scenario);
  if (scenario === "session-cold-first-attach") for (const context of contexts) await verifyRuntimeImageState(new Kubernetes(context.runner, config.kubectl, context.context, context.namespace), config.runtimeImage, false, config.imageInspectorArgv);
}
function buildConfig(env, scenario) {
  if (!SCENARIOS.has(scenario)) throw new RefusalError(`unknown scenario ${scenario}`);
  const iterations = integer(env, "T4_SLO_ITERATIONS", 5, 5);
  const timeoutSeconds = integer(env, "T4_SLO_OPERATION_TIMEOUT_SECONDS", integer(env, "T4_SLO_TIMEOUT_SECONDS", 600, 1), 1);
  const iterationTimeoutSeconds = integer(env, "T4_SLO_ITERATION_TIMEOUT_SECONDS", timeoutSeconds, 1);
  const cleanupTimeoutSeconds = integer(env, "T4_SLO_CLEANUP_TIMEOUT_SECONDS", 120, 1);
  const wholeRunTimeoutSeconds = integer(env, "T4_SLO_WHOLE_RUN_TIMEOUT_SECONDS", iterationTimeoutSeconds * iterations + cleanupTimeoutSeconds * iterations + timeoutSeconds, 1);
  const commit = required(env, "T4_SLO_COMMIT");
  if (!COMMIT.test(commit)) throw new RefusalError("T4_SLO_COMMIT must be an exact lowercase 40-character commit");
  if (required(env, "T4_SLO_DISPOSABLE_CLUSTER") !== "true") throw new RefusalError("T4_SLO_DISPOSABLE_CLUSTER=true is required because every scenario mutates measurement resources");
  const config = {
    scenario,
    iterations,
    timeoutSeconds,
    iterationTimeoutSeconds,
    cleanupTimeoutSeconds,
    wholeRunTimeoutSeconds,
    warmupIterations: 0,
    commit,
    imagePublicationManifest: resolve(required(env, "T4_SLO_IMAGE_PUBLICATION_MANIFEST")),
    buildMode: required(env, "T4_SLO_BUILD_MODE"),
    buildFlags: jsonStringArray(env, "T4_SLO_BUILD_FLAGS"),
    platform: required(env, "T4_SLO_PLATFORM"),
    architecture: required(env, "T4_SLO_ARCHITECTURE"),
    environmentId: required(env, "T4_SLO_ENVIRONMENT_ID"),
    kubectl: env.KUBECTL ?? "kubectl",
    helm: env.HELM ?? "helm",
    node: env.NODE ?? process.execPath,
    release: safeId(env.T4_SLO_RELEASE ?? "t4-cluster", "T4_SLO_RELEASE"),
    namespace: scenario === "control-plane-cold-start" || scenario === "session-cold-first-attach" ? undefined : safeId(required(env, "T4_SLO_NAMESPACE"), "T4_SLO_NAMESPACE"),
    context: env.T4_SLO_CONTEXT,
    restBaseUrl: env.T4_SLO_REST_BASE_URL,
    ompUrl: env.T4_SLO_OMP_APP_URL,
    apiToken: env.T4_SLO_API_TOKEN,
    scopeId: env.T4_SLO_SCOPE_ID,
    hostProfileId: env.T4_SLO_HOST_PROFILE_ID,
    deviceId: env.T4_SLO_DEVICE_ID,
    deviceToken: env.T4_SLO_DEVICE_TOKEN,
    controllerImage: digestImage(required(env, "T4_SLO_CONTROLLER_IMAGE"), "T4_SLO_CONTROLLER_IMAGE"),
    serverImage: digestImage(required(env, "T4_SLO_SERVER_IMAGE"), "T4_SLO_SERVER_IMAGE"),
    runtimeImage: digestImage(required(env, "T4_SLO_SESSION_RUNTIME_IMAGE"), "T4_SLO_SESSION_RUNTIME_IMAGE"),
    workspaceCapacityBytes: integer(env, "T4_SLO_WORKSPACE_CAPACITY_BYTES", 1_073_741_824, 1),
    runToken: randomUUID().replaceAll("-", "").slice(0, 12),
  };
  if (!["production", "release", "profiling", "ci", "local"].includes(config.buildMode)) throw new RefusalError("T4_SLO_BUILD_MODE is invalid");
  if (config.platform !== "linux") throw new RefusalError("T4_SLO_PLATFORM must be linux");
  if (!["amd64", "arm64"].includes(config.architecture)) throw new RefusalError("T4_SLO_ARCHITECTURE must be amd64 or arm64");
  if (scenario !== "controller-leader-failover") config.imageInspectorArgv = parseImageInspectorArgv(env);
  if (scenario === "control-plane-cold-start") {
    config.chart = resolve(required(env, "T4_SLO_CHART"));
    config.valuesFile = resolve(required(env, "T4_SLO_VALUES_FILE"));
  } else {
    for (const name of ["T4_SLO_API_TOKEN", "T4_SLO_SCOPE_ID", "T4_SLO_HOST_PROFILE_ID"]) required(env, name);
    publicId(config.scopeId, "T4_SLO_SCOPE_ID");
    publicId(config.hostProfileId, "T4_SLO_HOST_PROFILE_ID");
    if (scenario !== "session-cold-first-attach") {
      required(env, "T4_SLO_CONTEXT");
      required(env, "T4_SLO_REST_BASE_URL");
    }
  }
  if (scenario === "gateway-replica-failover") for (const name of ["T4_SLO_OMP_APP_URL", "T4_SLO_DEVICE_ID", "T4_SLO_DEVICE_TOKEN"]) required(env, name);
  if (scenario === "fenced-generation-replacement") {
    config.failureMechanismId = publicId(required(env, "T4_SLO_FAILURE_MECHANISM_ID"), "T4_SLO_FAILURE_MECHANISM_ID");
    config.storageDriver = publicId(required(env, "T4_SLO_STORAGE_DRIVER"), "T4_SLO_STORAGE_DRIVER");
    config.failureArgv = parseFailureArgv(env, "T4_SLO_NODE_FAILURE_ARGV");
    config.recoveryArgv = parseFailureArgv(env, "T4_SLO_NODE_RECOVERY_ARGV");
  }
  return config;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2 || argv[0] !== "--run") throw new RefusalError("usage: measure-slo-driver.mjs --run SCENARIO");
  const scenario = argv[1];
  const config = buildConfig(env, scenario);
  const outputRoot = resolve(env.T4_SLO_OUTPUT_DIR ?? resolve(REPOSITORY_ROOT, "artifacts/cluster-slo"));
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z");
  const runDirectory = resolve(outputRoot, scenario, `${stamp}-${config.runToken}`);
  if (!runDirectory.startsWith(`${resolve(REPOSITORY_ROOT, "artifacts/cluster-slo")}/`)) throw new RefusalError("T4_SLO_OUTPUT_DIR must remain under repository artifacts/cluster-slo");
  await mkdir(runDirectory, { recursive: true });
  const rawPath = resolve(runDirectory, "commands.jsonl");
  await writeFile(rawPath, "");
  const samplesPath = resolve(runDirectory, "samples.tsv");
  await writeFile(samplesPath, `${SAMPLE_HEADER}\n`);
  const eventsPath = resolve(runDirectory, "events.jsonl");
  await writeFile(eventsPath, "");
  const runner = new CommandRunner(rawPath, config.timeoutSeconds);
  runner.runToken = config.runToken;
  runner.scenario = scenario;
  const wholeRunDeadline = new Deadline(config.wholeRunTimeoutSeconds * 1000, "whole-run");
  runner.deadline = wholeRunDeadline;
  activeIterationDeadline = wholeRunDeadline;
  const contexts = scenarioContexts(env, scenario, config, runner);
  const recorder = new SloEventRecorder({
    runToken: config.runToken,
    scenario,
    iterations: config.iterations,
    deadlineSeconds: config.iterationTimeoutSeconds,
    append: line => appendFile(eventsPath, line),
  });
  const identities = {
    schemaVersion: SLO_IDENTITY_VERSION,
    scenario,
    sourceCommit: config.commit,
    environmentId: config.environmentId,
    runToken: config.runToken,
    startedAt: wallTime(),
    timeoutSeconds: config.timeoutSeconds,
    iterations: config.iterations,
    warmupIterations: config.warmupIterations,
    deadlines: {
      operationSeconds: config.timeoutSeconds,
      iterationSeconds: config.iterationTimeoutSeconds,
      cleanupSeconds: config.cleanupTimeoutSeconds,
      wholeRunSeconds: config.wholeRunTimeoutSeconds,
    },
    images: { controller: config.controllerImage, server: config.serverImage, sessionRuntime: config.runtimeImage },
    executables: {
      kubectl: await executableIdentity(config.kubectl),
      node: await executableIdentity(config.node),
      ...(scenario === "control-plane-cold-start" ? { helm: await executableIdentity(config.helm) } : {}),
      ...(config.imageInspectorArgv === undefined ? {} : { nodeImageInspector: await executableIdentity(config.imageInspectorArgv[0]) }),
    },
  };
  identities.source = await captureSourceIdentity(runner, env, config);
  identities.build = {
    mode: config.buildMode,
    flags: config.buildFlags,
    provenanceMode: "buildkit-content",
    platform: config.platform,
    architecture: config.architecture,
    imagePublicationManifest: await verifyImagePublicationInput(config.imagePublicationManifest, config),
  };
  identities.ledger = await verifyLedgerIdentity(config);
  if (scenario === "control-plane-cold-start") {
    identities.chart = await chartIdentity(config.chart);
    identities.values = await fileIdentity(config.valuesFile);
  }
  if (scenario === "fenced-generation-replacement") {
    identities.failureMechanism = {
      id: config.failureMechanismId,
      storageDriver: config.storageDriver,
      failureExecutable: await executableIdentity(config.failureArgv[0]),
      recoveryExecutable: await executableIdentity(config.recoveryArgv[0]),
    };
  }
  await preflightContexts(contexts, scenario, config, identities.ledger);
  identities.clusters = contexts.map(context => ({
    context: context.context,
    namespace: context.namespace,
    uid: context.clusterUid,
    ...(context.apiVersion === undefined ? {} : { apiVersion: context.apiVersion }),
    fingerprint: context.fingerprint,
  }));
  identities.environmentIterations = [];
  await writeFile(resolve(runDirectory, "identity.json"), `${JSON.stringify(identities, null, 2)}\n`);
  const failoverDeploymentName = scenario === "gateway-replica-failover" ? `${config.release}-server`
    : scenario === "controller-leader-failover" ? `${config.release}-controller`
    : undefined;
  let failoverBaseline;
  for (let index = 1; index <= config.iterations; index++) {
    runner.iteration = 0;
    runner.eventSequence = 0;
    const context = contexts[index - 1];
    const iterationFingerprint = await captureEnvironmentFingerprint(new Kubernetes(runner, config.kubectl, context.context, context.namespace), config);
    requireLedgerEnvironmentMatch(identities.ledger, iterationFingerprint, context.context, scenario);
    identities.environmentIterations.push({ iteration: index, context: context.context, fingerprint: iterationFingerprint });
    if (failoverDeploymentName !== undefined) {
      const kube = new Kubernetes(runner, config.kubectl, context.context, context.namespace);
      failoverBaseline = await requireDeploymentBaseline(kube, failoverDeploymentName, failoverBaseline);
    }
    const lifecycle = new IterationLifecycle();
    let status = "ok";
    let detail = "-";
    let proof = { result: "completed" };
    let boundaryStarted = false;
    const boundary = {
      async start() {
        if (boundaryStarted) return;
        await recorder.startIteration(index);
        boundaryStarted = true;
        runner.iteration = index;
        runner.eventSequence = recorder.events.at(-1).sequence;
      },
    };
    activeIterationDeadline = new Deadline(Math.min(config.iterationTimeoutSeconds * 1000, wholeRunDeadline.remainingMs()), `iteration ${index}`);
    runner.deadline = activeIterationDeadline;
    try {
      const result = await withinDeadline(activeIterationDeadline, async signal => {
        signal.addEventListener("abort", () => lifecycle.abort(signal.reason), { once: true });
        return scenario === "control-plane-cold-start" ? measureControlPlane(context, config, lifecycle, boundary)
          : scenario === "session-cold-first-attach" ? measureSessionAttach(context, config, index, false, lifecycle, boundary)
          : scenario === "session-warm-first-attach" ? measureSessionAttach(context, config, index, true, lifecycle, boundary)
          : scenario === "controller-leader-failover" ? measureController(context, config, index, lifecycle, boundary)
          : scenario === "gateway-replica-failover" ? measureGateway(context, config, index, lifecycle, boundary)
          : measureFenced(context, config, index, lifecycle, boundary);
      });
      detail = result.detail;
      proof = result.proof ?? { detail: result.detail };
    } catch (error) {
      lifecycle.abort(error);
      status = error instanceof TimeoutError || error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : error instanceof RefusalError ? "refused" : "failed";
      detail = `${error.name}: ${error.message}`;
      if (scenario === "fenced-generation-replacement" && !detail.includes("invariant=")) detail += " invariant=violated";
      proof = { error: { name: error?.name ?? "Error", message: bounded(error?.message ?? error, 16_000) } };
    }
    await boundary.start();
    const sample = await recorder.finishIteration({ status, detail: bounded(detail, 16_000), proof });
    runner.eventSequence = recorder.events.at(-1).sequence;
    const cleanupDeadline = new Deadline(Math.min(config.cleanupTimeoutSeconds * 1000, wholeRunDeadline.remainingMs()), `iteration ${index} cleanup`);
    activeIterationDeadline = cleanupDeadline;
    runner.deadline = cleanupDeadline;
    await lifecycle.cleanup();
    if (failoverDeploymentName !== undefined) {
      const kube = new Kubernetes(runner, config.kubectl, context.context, context.namespace);
      await poll("failover Deployment baseline restoration", config.cleanupTimeoutSeconds, () => kube.get("deployment", failoverDeploymentName), deployment => {
        try {
          const actual = deploymentBaseline(deployment);
          return actual.uid === failoverBaseline.uid && actual.generation === failoverBaseline.generation && actual.desired === failoverBaseline.desired;
        } catch { return false; }
      });
    }
    await poll("exact environment baseline restoration", config.cleanupTimeoutSeconds,
      () => captureEnvironmentFingerprint(new Kubernetes(runner, config.kubectl, context.context, context.namespace), config),
      restoredFingerprint => JSON.stringify(restoredFingerprint) === JSON.stringify(iterationFingerprint));
    await recorder.recordCleanup({ detail: "iteration resources and environment baseline restored" });
    await appendFile(samplesPath, `${sample.iteration}\t${sample.status}\t${sample.seconds.toFixed(3)}\t${bounded(sample.detail)}\n`);
    runner.deadline = wholeRunDeadline;
    activeIterationDeadline = wholeRunDeadline;
  }
  recorder.finalize();
  identities.completedAt = wallTime();
  await writeFile(resolve(runDirectory, "identity.json"), `${JSON.stringify(identities, null, 2)}\n`);
  runner.iteration = 0;
  runner.eventSequence = 0;
  const observationPath = resolve(runDirectory, "observation.json");
  const summarized = await runner.run(config.node, [resolve(HERE, "summarize-slo-run.mjs"), "--scenario", scenario, "--samples", samplesPath, "--observed-at", identities.startedAt, "--iterations", String(config.iterations), "--timeout-seconds", String(config.iterationTimeoutSeconds), "--environment-id", config.environmentId, "--commit", config.commit, "--artifact-root", outputRoot], { record: false });
  await writeFile(observationPath, summarized.stdout);
  activeIterationDeadline = undefined;
  process.stdout.write(`scenario ${scenario} recorded ${config.iterations} iterations\nsamples: ${relative(REPOSITORY_ROOT, samplesPath)}\nevents: ${relative(REPOSITORY_ROOT, eventsPath)}\nraw commands: ${relative(REPOSITORY_ROOT, rawPath)}\nidentity: ${relative(REPOSITORY_ROOT, resolve(runDirectory, "identity.json"))}\nmanifest: ${relative(REPOSITORY_ROOT, resolve(runDirectory, "run-manifest.json"))}\nobservation: ${relative(REPOSITORY_ROOT, observationPath)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) run().catch(error => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = error instanceof RefusalError ? 64 : 1; });
