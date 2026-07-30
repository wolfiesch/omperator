import { performance } from "node:perf_hooks";

export const SLO_IDENTITY_VERSION = "t4-slo-identity/1";
export const SLO_COMMAND_VERSION = "t4-slo-command/1";
export const SLO_EVENT_VERSION = "t4-slo-event/1";
export const SLO_RUN_MANIFEST_VERSION = "t4-cluster-slo-run/2";
export const SLO_SAMPLE_HEADER = "iteration\tstatus\tseconds\tdetail";
export const SLO_REQUIRED_RUN_FILES = Object.freeze([
  "samples.tsv",
  "identity.json",
  "commands.jsonl",
  "events.jsonl",
]);

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/u;
const SCENARIO = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,510}$/u;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;
const SAMPLE_STATUSES = new Set(["ok", "timeout", "refused", "failed"]);
const EVENT_KINDS = ["boundary-start", "boundary-end", "proof", "cleanup"];
const MAX_STRING = 1024 * 1024;
const MAX_DETAIL = 16_384;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function plain(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, required, optional, label) {
  if (!plain(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = keys.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(`${label} fields are invalid (missing: ${missing.join(",") || "none"}; unknown: ${unknown.join(",") || "none"})`);
  }
}

function timestamp(value, label) {
  const match = typeof value === "string" ? UTC_TIMESTAMP.exec(value) : null;
  const milliseconds = match ? Date.parse(value) : Number.NaN;
  if (!match || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(`${label} must be a real UTC timestamp`);
  }
  return milliseconds;
}

function boundedJson(value, label, depth = 0, entries = { count: 0 }) {
  if (depth > 12 || ++entries.count > 4096) throw new Error(`${label} exceeds its structural bound`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING) throw new Error(`${label} contains an oversized string`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error(`${label} contains an oversized array`);
    value.forEach((entry) => boundedJson(entry, label, depth + 1, entries));
    return;
  }
  if (!plain(value)) throw new Error(`${label} contains a non-JSON value`);
  const keys = Object.keys(value);
  if (keys.length > 256 || keys.some((key) => key.length > 128)) throw new Error(`${label} contains an oversized object`);
  for (const entry of Object.values(value)) boundedJson(entry, label, depth + 1, entries);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_JSON_BYTES) throw new Error(`${label} exceeds its byte bound`);
}

function parseJsonLines(source, label, maximum = 100_000) {
  if (typeof source !== "string" || source.length === 0 || !source.endsWith("\n")) {
    throw new Error(`${label} must be non-empty newline-terminated JSONL`);
  }
  const lines = source.slice(0, -1).split("\n");
  if (lines.length > maximum || lines.some((line) => line.length === 0)) throw new Error(`${label} has an invalid record count`);
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`${label} record ${index + 1} is not JSON`, { cause: error }); }
  });
}

export function parseSloIdentity(value) {
  exactKeys(value, [
    "schemaVersion", "scenario", "sourceCommit", "environmentId", "runToken", "startedAt", "completedAt",
    "timeoutSeconds", "iterations", "warmupIterations", "deadlines", "images", "executables",
    "source", "build", "ledger", "clusters", "environmentIterations",
  ], ["chart", "values", "failureMechanism"], "identity.json");
  if (value.schemaVersion !== SLO_IDENTITY_VERSION) throw new Error(`identity.json schemaVersion must be ${SLO_IDENTITY_VERSION}`);
  if (!SCENARIO.test(value.scenario ?? "") || !TOKEN.test(value.runToken ?? "") || !COMMIT.test(value.sourceCommit ?? "")) {
    throw new Error("identity.json run identity is invalid");
  }
  const startedAt = timestamp(value.startedAt, "identity.json startedAt");
  if (timestamp(value.completedAt, "identity.json completedAt") < startedAt) {
    throw new Error("identity.json completion precedes its start");
  }
  if (!Number.isSafeInteger(value.iterations) || value.iterations < 1 || value.warmupIterations !== 0) throw new Error("identity.json iteration boundary is invalid");
  if (typeof value.timeoutSeconds !== "number" || !Number.isFinite(value.timeoutSeconds) || value.timeoutSeconds <= 0) throw new Error("identity.json timeoutSeconds is invalid");
  exactKeys(value.deadlines, ["operationSeconds", "iterationSeconds", "cleanupSeconds", "wholeRunSeconds"], [], "identity.json deadlines");
  if (Object.values(value.deadlines).some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0)) throw new Error("identity.json deadlines are invalid");
  exactKeys(value.source, ["commit", "headTreeHash", "repositoryTreeHash", "harnessTreeHash", "dirty", "retainedPatch"], [], "identity.json source");
  if (value.source.commit !== value.sourceCommit || !COMMIT.test(value.source.headTreeHash ?? "") || !SHA256.test(value.source.repositoryTreeHash ?? "") || !SHA256.test(value.source.harnessTreeHash ?? "") || typeof value.source.dirty !== "boolean") {
    throw new Error("identity.json source identity is invalid");
  }
  if (value.source.dirty === false && value.source.retainedPatch !== null) throw new Error("a clean source must not claim a retained patch");
  if (value.source.dirty === true) {
    exactKeys(value.source.retainedPatch, ["path", "sha256", "size"], [], "identity.json retained patch");
    if (!SAFE_PATH.test(value.source.retainedPatch.path ?? "") || !SHA256.test(value.source.retainedPatch.sha256 ?? "") || !Number.isSafeInteger(value.source.retainedPatch.size) || value.source.retainedPatch.size < 1) throw new Error("identity.json retained patch is invalid");
  }
  if (!plain(value.build) || value.build.platform !== "linux" || !["amd64", "arm64"].includes(value.build.architecture)) throw new Error("identity.json build platform is invalid");
  if (!Array.isArray(value.clusters) || !Array.isArray(value.environmentIterations) || value.environmentIterations.length !== value.iterations) throw new Error("identity.json iteration fingerprints are incomplete");
  boundedJson(value, "identity.json");
  return value;
}

export function parseSloEvents(source, expected) {
  const events = parseJsonLines(source, "events.jsonl", 400_000);
  const { runToken, scenario, iterations, deadlineSeconds } = expected;
  if (!TOKEN.test(runToken ?? "") || !SCENARIO.test(scenario ?? "") || !Number.isSafeInteger(iterations) || iterations < 1 || typeof deadlineSeconds !== "number" || !Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0) {
    throw new Error("event validation boundary is invalid");
  }
  if (events.length !== iterations * EVENT_KINDS.length) throw new Error("events.jsonl does not contain exactly four events per iteration");
  let priorTimestamp = -Infinity;
  let priorOffset = -1;
  const samples = [];
  for (let position = 0; position < events.length; position += 1) {
    const event = events[position];
    exactKeys(event, ["schemaVersion", "runToken", "scenario", "iteration", "sequence", "timestamp", "monotonicOffsetMs", "kind", "payload"], [], `events.jsonl record ${position + 1}`);
    const iteration = Math.floor(position / EVENT_KINDS.length) + 1;
    const kind = EVENT_KINDS[position % EVENT_KINDS.length];
    if (event.schemaVersion !== SLO_EVENT_VERSION || event.runToken !== runToken || event.scenario !== scenario || event.iteration !== iteration || event.sequence !== position + 1 || event.kind !== kind) {
      throw new Error(`events.jsonl record ${position + 1} is missing, extra, or out of order`);
    }
    const currentTimestamp = timestamp(event.timestamp, `events.jsonl record ${position + 1} timestamp`);
    if (!Number.isSafeInteger(event.monotonicOffsetMs) || event.monotonicOffsetMs < 0 || event.monotonicOffsetMs < priorOffset || currentTimestamp < priorTimestamp) {
      throw new Error(`events.jsonl record ${position + 1} inverts time`);
    }
    priorTimestamp = currentTimestamp;
    priorOffset = event.monotonicOffsetMs;
    boundedJson(event.payload, `events.jsonl record ${position + 1} payload`);
    if (kind === "boundary-start" || kind === "boundary-end") exactKeys(event.payload, [], [], `${kind} payload`);
    if (kind === "proof") {
      exactKeys(event.payload, ["status", "detail", "proof"], [], "proof payload");
      if (!SAMPLE_STATUSES.has(event.payload.status) || typeof event.payload.detail !== "string" || event.payload.detail.length > MAX_DETAIL || !plain(event.payload.proof) || Object.keys(event.payload.proof).length === 0) throw new Error("proof payload is invalid or empty");
    }
    if (kind === "cleanup") {
      exactKeys(event.payload, ["status", "detail", "runComplete"], [], "cleanup payload");
      if (event.payload.status !== "ok" || typeof event.payload.detail !== "string" || event.payload.detail.length > MAX_DETAIL || event.payload.runComplete !== (iteration === iterations)) throw new Error("each iteration needs one successful cleanup and only the final cleanup may complete the run");
    }
    if (kind === "cleanup") {
      const base = position - 3;
      const start = events[base];
      const end = events[base + 1];
      const proof = events[base + 2];
      const durationMs = end.monotonicOffsetMs - start.monotonicOffsetMs;
      if (durationMs < 0 || durationMs > deadlineSeconds * 1000) throw new Error(`iteration ${iteration} duration exceeds its deadline`);
      samples.push({ iteration, status: proof.payload.status, seconds: Math.round(durationMs) / 1000, detail: proof.payload.detail, proof: proof.payload.proof });
    }
  }
  return { events, samples };
}

export function parseSloCommands(source, expected, events) {
  const records = parseJsonLines(source, "commands.jsonl");
  const eventBySequence = new Map(events.map((event) => [event.sequence, event]));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    exactKeys(record, [
      "schemaVersion", "runToken", "scenario", "iteration", "eventSequence", "startedAt", "durationMs",
      "executable", "args", "exitCode", "signal", "stdout", "stderr", "overflow", "timedOut",
    ], ["recordTruncated"], `commands.jsonl record ${index + 1}`);
    if (record.schemaVersion !== SLO_COMMAND_VERSION || record.runToken !== expected.runToken || record.scenario !== expected.scenario) throw new Error(`commands.jsonl record ${index + 1} is not correlated to the run`);
    timestamp(record.startedAt, `commands.jsonl record ${index + 1} startedAt`);
    if (!Number.isSafeInteger(record.iteration) || record.iteration < 0 || record.iteration > expected.iterations || !Number.isSafeInteger(record.eventSequence) || record.eventSequence < 0) throw new Error(`commands.jsonl record ${index + 1} has an invalid correlation`);
    if (record.iteration === 0 ? record.eventSequence !== 0 : eventBySequence.get(record.eventSequence)?.iteration !== record.iteration) throw new Error(`commands.jsonl record ${index + 1} is not correlated to an event/iteration`);
    if (typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0 || typeof record.executable !== "string" || record.executable.length < 1 || record.executable.length > 2048 || !Array.isArray(record.args) || record.args.length > 128 || record.args.some((arg) => typeof arg !== "string" || arg.length > 2048)) throw new Error(`commands.jsonl record ${index + 1} execution fields are invalid`);
    if (!(record.exitCode === null || Number.isSafeInteger(record.exitCode)) || !(record.signal === null || typeof record.signal === "string") || typeof record.stdout !== "string" || typeof record.stderr !== "string" || typeof record.overflow !== "boolean" || typeof record.timedOut !== "boolean" || (record.recordTruncated !== undefined && record.recordTruncated !== true)) throw new Error(`commands.jsonl record ${index + 1} result fields are invalid`);
    boundedJson(record, `commands.jsonl record ${index + 1}`);
  }
  return records;
}

export function parseSloRunManifest(value) {
  exactKeys(value, ["schemaVersion", "files"], [], "run-manifest.json");
  if (value.schemaVersion !== SLO_RUN_MANIFEST_VERSION || !Array.isArray(value.files) || value.files.length < SLO_REQUIRED_RUN_FILES.length || value.files.length > 64) throw new Error("run-manifest.json schema or file count is invalid");
  const names = new Set();
  value.files.forEach((entry, index) => {
    exactKeys(entry, ["name", "bytes", "sha256"], [], `run-manifest.json files[${index}]`);
    if (!SAFE_PATH.test(entry.name ?? "") || names.has(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !SHA256.test(entry.sha256 ?? "")) throw new Error(`run-manifest.json files[${index}] is invalid`);
    names.add(entry.name);
  });
  if (SLO_REQUIRED_RUN_FILES.some((name, index) => value.files[index]?.name !== name)) throw new Error("run-manifest.json required files are missing or out of order");
  return value;
}

function nowTimestamp() { return new Date().toISOString(); }

export class SloEventRecorder {
  constructor({ runToken, scenario, iterations, deadlineSeconds, append, wallClock = nowTimestamp, monotonicClock = () => performance.now() }) {
    if (typeof append !== "function") throw new Error("SLO event recorder requires an append sink");
    this.expected = { runToken, scenario, iterations, deadlineSeconds };
    this.append = append;
    this.wallClock = wallClock;
    this.monotonicClock = monotonicClock;
    this.origin = monotonicClock();
    this.events = [];
    this.samples = [];
    this.openIteration = null;
  }

  async #emit(iteration, kind, payload) {
    const event = {
      schemaVersion: SLO_EVENT_VERSION,
      runToken: this.expected.runToken,
      scenario: this.expected.scenario,
      iteration,
      sequence: this.events.length + 1,
      timestamp: this.wallClock(),
      monotonicOffsetMs: Math.max(0, Math.round(this.monotonicClock() - this.origin)),
      kind,
      payload,
    };
    this.events.push(event);
    await this.append(`${JSON.stringify(event)}\n`);
    return event;
  }

  async startIteration(iteration) {
    if (this.openIteration !== null || iteration !== this.samples.length + 1 || iteration > this.expected.iterations) throw new Error("SLO event iteration start is out of order");
    this.openIteration = iteration;
    await this.#emit(iteration, "boundary-start", {});
  }

  async finishIteration({ status, detail, proof }) {
    if (this.openIteration === null) throw new Error("SLO event iteration is not open");
    const iteration = this.openIteration;
    const end = await this.#emit(iteration, "boundary-end", {});
    const proofEvent = await this.#emit(iteration, "proof", { status, detail, proof });
    const start = this.events.at(-3);
    const sample = { iteration, status, seconds: Math.round(end.monotonicOffsetMs - start.monotonicOffsetMs) / 1000, detail, proof: proofEvent.payload.proof };
    this.samples.push(sample);
    return sample;
  }

  async recordCleanup({ detail, proof = { cleanup: "verified" } }) {
    if (this.openIteration === null || this.samples.length !== this.openIteration) throw new Error("SLO cleanup must follow proof finalization");
    const iteration = this.openIteration;
    boundedJson(proof, "cleanup proof");
    await this.#emit(iteration, "cleanup", { status: "ok", detail, runComplete: iteration === this.expected.iterations });
    this.openIteration = null;
  }

  finalize() {
    if (this.openIteration !== null || this.samples.length !== this.expected.iterations) throw new Error("SLO run is incomplete");
    return parseSloEvents(this.events.map((event) => JSON.stringify(event)).join("\n") + "\n", this.expected);
  }
}
