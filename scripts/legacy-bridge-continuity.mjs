import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  clusterOperatorRequestedCapabilities,
  clusterOperatorRequestedFeatures,
  createOmpClient,
} from "../packages/client/src/index.ts";
import { UnixWebSocketTransport } from "../apps/desktop/src/transport.ts";
import {
  ADDITIVE_FEATURES,
  decodeSessionListResult,
  DEVICE_CAPABILITIES,
} from "../packages/protocol/src/index.ts";

const LEGACY_DEVICE_CAPABILITIES =
  clusterOperatorRequestedCapabilities(DEVICE_CAPABILITIES);
const LEGACY_REQUESTED_FEATURES =
  clusterOperatorRequestedFeatures(ADDITIVE_FEATURES);

const PROCESS_TIMEOUT_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 45_000;
const POLL_MS = 100;
const WIRE_JOURNAL_MAX_ENTRIES = 4_096;
const WIRE_JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const output = {
    artifactRoot: resolve(repoRoot, "artifacts/legacy-bridge-continuity"),
    ompRepo: process.env.T4_OMP_SOURCE_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root") output.artifactRoot = resolve(argv[++index]);
    else if (arg === "--omp-repo") output.ompRepo = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!output.ompRepo) throw new Error("pass --omp-repo or set T4_OMP_SOURCE_DIR");
  return output;
}

function commandOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function gitSource(cwd) {
  const commit = commandOutput("git", ["rev-parse", "HEAD"], cwd).trim();
  const changed = commandOutput("git", ["status", "--short", "--untracked-files=all"], cwd);
  const changedLines = changed.split("\n").filter(Boolean);
  const fingerprint = createHash("sha256").update(
    commandOutput("git", ["diff", "--binary", "--no-ext-diff", "HEAD"], cwd),
  );
  for (const line of changedLines.filter((entry) => entry.startsWith("?? ")).sort()) {
    const path = line.slice(3);
    const blob = commandOutput("git", ["hash-object", "--", path], cwd).trim();
    fingerprint.update(`\0${path}\0${blob}`);
  }
  return {
    commit,
    dirty: changedLines.length > 0,
    diffSha256: changedLines.length === 0 ? null : fingerprint.digest("hex"),
    changedPaths: changedLines.map((line) => line.slice(3)),
  };
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function progress(stage) {
  process.stderr.write(`[legacy-bridge-continuity] ${stage}\n`);
}

async function waitUntil(check, label, timeoutMs = PROCESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MS);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function captureProcess(child) {
  const chunks = [];
  const capture = (chunk) => {
    chunks.push(Buffer.from(chunk));
    while (chunks.reduce((total, item) => total + item.length, 0) > 128 * 1024) chunks.shift();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return () => Buffer.concat(chunks).toString("utf8");
}

async function stopProcess(record, name) {
  if (!record || record.child.exitCode !== null || record.child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => record.child.once("exit", resolvePromise));
  try {
    if (record.group) process.kill(-record.child.pid, "SIGTERM");
    else record.child.kill("SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  const graceful = await Promise.race([
    exited.then(() => true),
    delay(PROCESS_TIMEOUT_MS).then(() => false),
  ]);
  if (!graceful) {
    try {
      if (record.group) process.kill(-record.child.pid, "SIGKILL");
      else record.child.kill("SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    await exited;
  }
  if (
    record.child.exitCode &&
    record.child.exitCode !== 143 &&
    record.child.signalCode !== "SIGTERM"
  ) {
    throw new Error(
      `${name} exited unexpectedly (${record.child.exitCode ?? record.child.signalCode}): ${record.output()}`,
    );
  }
}

async function stopRealTui(record) {
  try {
    await writeFile(record.stopFile, "stop\n", "utf8");
    await waitUntil(
      () => record.child.exitCode !== null || record.child.signalCode !== null,
      "graceful real OMP TUI shutdown",
      PROCESS_TIMEOUT_MS,
    );
  } catch {
    await stopProcess(record, "real OMP TUI");
  } finally {
    await rm(record.stopFile, { force: true });
  }
}

async function startAppserver({ ompRepo, env, profile, token, projectRoot }) {
  const socketRoot =
    process.platform === "darwin"
      ? join(env.HOME, ".omp", "run")
      : join(env.XDG_RUNTIME_DIR, "omp");
  const socket = join(
    socketRoot,
    `appserver-profile-${createHash("sha256").update(profile).digest("hex").slice(0, 24)}.sock`,
  );
  const child = spawn(
    "bun",
    [join(ompRepo, "packages/coding-agent/src/cli.ts"), "--profile", profile, "appserver", "serve"],
    {
      cwd: projectRoot,
      env: {
        ...env,
        OMP_APP_TEST_MODE: "1",
        OMP_APP_TEST_TOKEN: token,
        OMP_APP_TEST_PROJECT_ROOT: projectRoot,
        OMP_APP_TEST_PROFILE: profile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = { child, output: captureProcess(child), socket, profile, token, group: false };
  try {
    await waitUntil(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(record.output());
      return pathExists(socket);
    }, `appserver ${profile}`);
    return record;
  } catch (error) {
    const socketEntries = await readdir(dirname(socket)).catch(() => []);
    const startupDetail = `${error instanceof Error ? error.message : String(error)}; sockets=${socketEntries.join(",") || "none"}; output=${record.output() || "none"}`;
    try {
      await stopProcess(record, `failed ${profile} appserver startup`);
    } catch {
      // Preserve the startup failure.
    }
    throw new Error(startupDetail);
  }
}

async function startRealTui({ ompRepo, env, profile, projectRoot, sessionPath }) {
  const expectScript = join(env.HOME, ".t4-operations-tui.exp");
  const pidFile = join(env.HOME, ".t4-operations-tui.pid");
  const stopFile = join(env.HOME, ".t4-operations-tui.stop");
  await Promise.all([rm(pidFile, { force: true }), rm(stopFile, { force: true })]);
  await writeFile(
    expectScript,
    'set timeout 1\nspawn -noecho {*}$argv\nset pidfile [open $env(T4_TUI_PID_FILE) w]\nputs $pidfile [exp_pid]\nclose $pidfile\nset done 0\nwhile {!$done} {\n  expect {\n    eof { set done 1 }\n    timeout {\n      if {[file exists $env(T4_TUI_STOP_FILE)]} {\n        send -- "/exit\\r"\n        set timeout -1\n      }\n    }\n  }\n}\ncatch wait result\nexit [lindex $result 3]\n',
    "utf8",
  );
  const child = spawn(
    "/usr/bin/expect",
    [
      "-f",
      expectScript,
      "--",
      "bun",
      join(ompRepo, "packages/coding-agent/src/cli.ts"),
      "--profile",
      profile,
      "--session",
      sessionPath,
      "--no-tools",
      "--no-skills",
      "--no-rules",
      "--no-extensions",
      "--no-title",
    ],
    {
      cwd: projectRoot,
      env: {
        ...env,
        OMP_SKIP_SETUP: "1",
        TERM: "xterm-256color",
        T4_TUI_PID_FILE: pidFile,
        T4_TUI_STOP_FILE: stopFile,
      },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output = captureProcess(child);
  const tuiPid = await waitUntil(async () => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(output());
    const value = Number.parseInt(await readFile(pidFile, "utf8"), 10);
    return Number.isSafeInteger(value) && value > 0 && value;
  }, "real OMP TUI pid");
  return { child, output, group: true, tuiPid, stopFile };
}

async function adminRaw(processRecord, method, route, body) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolvePromise, reject) => {
    const request = http.request(
      {
        socketPath: processRecord.socket,
        path: route,
        method,
        headers: {
          Authorization: `Bearer ${processRecord.token}`,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": payload.length }
            : {}),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let value;
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            value = { text };
          }
          resolvePromise({ status: response.statusCode ?? 0, body: value });
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(60_000, () => request.destroy(new Error(`${method} ${route} timed out`)));
    if (payload) request.write(payload);
    request.end();
  });
}

async function adminRequest(processRecord, method, route, body) {
  const response = await adminRaw(processRecord, method, route, body);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `${method} ${route} returned ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body;
}

function frameSummary(label, direction, data) {
  const raw = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  const summary = {
    at: new Date().toISOString(),
    label,
    direction,
    bytes: Buffer.byteLength(raw),
    frameSha256: createHash("sha256").update(raw).digest("hex"),
  };
  try {
    const frame = JSON.parse(raw);
    Object.assign(summary, {
      type: frame.type,
      hostId: frame.hostId,
      sessionId: frame.sessionId,
      requestId: frame.requestId,
      commandId: frame.commandId,
      command: frame.command,
      expectedRevision: frame.expectedRevision,
      cursor: frame.cursor,
      revision: frame.revision,
      ok: frame.ok,
      errorCode: frame.error?.code,
    });
    if (frame.type === "hello") {
      summary.client = frame.client?.name;
      summary.requestedFeatureCount = frame.requestedFeatures?.length ?? 0;
      summary.capabilityCount = frame.capabilities?.length ?? 0;
      summary.savedCursorCount = frame.savedCursors?.length ?? 0;
    }
    if (frame.type === "command") summary.argKeys = Object.keys(frame.args ?? {}).sort();
    if (frame.type === "sessions") {
      summary.sessionCount = frame.sessions?.length ?? 0;
      summary.totalCount = frame.totalCount;
    }
    if (frame.type === "snapshot") {
      summary.entryCount = frame.entries?.length ?? 0;
      summary.firstEntryId = frame.entries?.at(0)?.id;
      summary.lastEntryId = frame.entries?.at(-1)?.id;
    }
    if (frame.type === "session.delta") {
      summary.upsertSessionId = frame.upsert?.sessionId;
      summary.removedSessionId = frame.remove?.sessionId;
    }
    if (frame.type === "response" && frame.result && typeof frame.result === "object") {
      summary.resultKeys = Object.keys(frame.result).sort();
      summary.rowCount = Array.isArray(frame.result.rows) ? frame.result.rows.length : undefined;
      summary.accepted = frame.result.accepted;
      summary.renamed = frame.result.renamed;
      summary.attached = frame.result.attached;
    }
  } catch {
    summary.type = "unparsed";
  }
  return Object.fromEntries(Object.entries(summary).filter(([, value]) => value !== undefined));
}

function createWireJournal() {
  const retained = [];
  let retainedBytes = 0;
  let droppedEntries = 0;
  let droppedBytes = 0;
  return {
    record(event) {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
      if (bytes > WIRE_JOURNAL_MAX_BYTES) {
        droppedEntries += 1;
        droppedBytes += bytes;
        return;
      }
      while (
        retained.length > 0 &&
        (retained.length >= WIRE_JOURNAL_MAX_ENTRIES ||
          retainedBytes + bytes > WIRE_JOURNAL_MAX_BYTES)
      ) {
        const dropped = retained.shift();
        retainedBytes -= dropped.bytes;
        droppedEntries += 1;
        droppedBytes += dropped.bytes;
      }
      retained.push({ event, bytes });
      retainedBytes += bytes;
    },
    events() {
      return retained.map((entry) => entry.event);
    },
    summary() {
      return {
        maxEntries: WIRE_JOURNAL_MAX_ENTRIES,
        maxBytes: WIRE_JOURNAL_MAX_BYTES,
        retainedEntries: retained.length,
        retainedBytes,
        droppedEntries,
        droppedBytes,
      };
    },
  };
}

function auditedTransportFactory(socketPath, label, wireJournal) {
  let active;
  return {
    factory: async () => {
      progress(`${label} transport opening`);
      const inner = new UnixWebSocketTransport({ socketPath, handshakeTimeoutMs: 10_000 });
      try {
        await inner.open();
      } catch (error) {
        progress(
          `${label} transport open failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
      progress(`${label} transport open`);
      active = inner;
      return {
        send(data) {
          wireJournal.record(frameSummary(label, "out", data));
          inner.send(data);
        },
        close() {
          inner.close();
        },
        onMessage(listener) {
          return inner.onMessage((data) => {
            wireJournal.record(frameSummary(label, "in", data));
            listener(data);
          });
        },
        onClose(listener) {
          return inner.onClose(listener);
        },
        onError(listener) {
          return inner.onError(listener);
        },
      };
    },
    disconnect() {
      const socket = active && Reflect.get(active, "socket");
      if (socket === undefined || typeof socket.terminate !== "function") {
        throw new Error(`${label} has no active transport socket`);
      }
      socket.terminate();
    },
  };
}

class T4Probe {
  constructor(label, socketPath, wireJournal) {
    this.label = label;
    this.events = [];
    this.states = [];
    this.welcomeHostId = undefined;
    this.errors = [];
    this.transport = auditedTransportFactory(socketPath, label, wireJournal);
    this.client = createOmpClient({
      transport: this.transport.factory,
      capabilities: LEGACY_DEVICE_CAPABILITIES,
      requestedFeatures: LEGACY_REQUESTED_FEATURES,
      compatibilityRequestedFeatures: LEGACY_REQUESTED_FEATURES.filter(
        (feature) => feature !== "prompt.images" && feature !== "transcript.images",
      ),
      client: {
        name: "T4 Code",
        version: "0.1.28",
        build: "legacy-bridge-continuity",
        platform: process.platform,
      },
      reconnect: { baseMs: 100, maxMs: 1_000 },
      commandTimeoutMs: 20_000,
    });
    this.client.onEvent((event) => {
      this.events.push(event);
      if (event.kind === "welcome") {
        this.welcomeHostId = event.payload.hostId;
        progress(`${this.label} welcome received`);
      }
    });
    this.client.onState((state) => {
      this.states.push(state);
      progress(`${this.label} state=${state.state} generation=${state.generation}`);
    });
    this.client.onError((error) => {
      this.errors.push(error.toJSON());
      progress(`${this.label} error=${error.code}`);
    });
  }

  async connect() {
    await this.client.connect();
    assert.equal(this.client.state, "ready", `${this.label} did not reach ready`);
    return this;
  }

  mark() {
    return this.events.length;
  }

  async event(kind, predicate = () => true, after = 0, timeoutMs = PROCESS_TIMEOUT_MS) {
    return waitUntil(
      () =>
        this.events.slice(after).find((event) => event.kind === kind && predicate(event.payload)),
      `${this.label} ${kind}`,
      timeoutMs,
    );
  }

  hostId() {
    const hostId = this.client.snapshot().hostId ?? this.welcomeHostId;
    assert(hostId, `${this.label} has no host id`);
    return hostId;
  }

  close() {
    return this.client.close();
  }
}

async function sessionList(probe, label = "inventory") {
  const response = await probe.client.command({
    hostId: probe.hostId(),
    command: "session.list",
    args: {},
  });
  assert.equal(
    response.ok,
    true,
    `${probe.label} session.list failed: ${JSON.stringify(response.error)}`,
  );
  return { label, ...decodeSessionListResult(response.result) };
}

async function attachSnapshot(probe, sessionId, label) {
  const mark = probe.mark();
  const response = await probe.client.attach(probe.hostId(), sessionId);
  assert.equal(
    response.ok,
    true,
    `${probe.label} attach failed: ${JSON.stringify(response.error)}`,
  );
  const event = await probe.event("snapshot", (payload) => payload.sessionId === sessionId, mark);
  return { label, ...event.payload };
}

async function visit(directory, output = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return output;
    throw error;
  }
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) await visit(target, output);
    else if (entry.isFile()) output.push(target);
  }
  return output;
}

async function findSessionPath(home, profile, runId, sessionId) {
  const manifestPath = join(
    home,
    ".omp",
    "profiles",
    profile,
    "state",
    "appserver-test-runs",
    `${runId}.json`,
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const session = manifest.sessions?.find((candidate) => candidate.sessionId === sessionId);
  assert(session?.path, `could not locate seeded session ${sessionId}`);
  const resolvedSessionPath = await realpath(session.path);
  const profileRoot = join(home, ".omp", "profiles", profile);
  const profileRelative = relative(profileRoot, resolvedSessionPath);
  assert(
    profileRelative !== ".." &&
      !profileRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    "seeded session escaped the disposable profile root",
  );
  return resolvedSessionPath;
}

function assertDeliveredCursorIntegrity(probes) {
  const seen = new Map();
  for (const probe of probes) {
    for (const event of probe.events) {
      if (!["entry", "event", "session.delta"].includes(event.kind)) continue;
      const cursor = event.payload?.cursor;
      if (!cursor || typeof cursor.epoch !== "string") continue;
      const sessionId =
        typeof event.payload.sessionId === "string" ? event.payload.sessionId : "host";
      const stream = `${probe.label}/${event.kind}/${sessionId}/${cursor.epoch}`;
      const seq = cursor.seq;
      assert(Number.isSafeInteger(seq) && seq >= 0, `invalid cursor sequence for ${stream}`);
      const values = seen.get(stream) ?? new Set();
      assert(!values.has(seq), `duplicate delivered cursor ${seq} for ${stream}`);
      values.add(seq);
      seen.set(stream, values);
    }
  }
  return {
    streams: seen.size,
    cursors: [...seen.values()].reduce((total, values) => total + values.size, 0),
  };
}

function assertCleanStatus(status, label) {
  assert.equal(status.state, "clean", `${label} state`);
  assert.deepEqual(status.sessions, { seeded: 0, indexed: 0 }, `${label} sessions`);
  assert.deepEqual(status.locks, { live: 0, suspect: 0, stale: 0, malformed: 0 }, `${label} locks`);
  assert.deepEqual(
    status.workers,
    { supervisors: 0, starting: 0, pendingRpc: 0 },
    `${label} workers`,
  );
  assert.equal(status.remainingFiles, 0, `${label} remaining files`);
  assert.deepEqual(status.errors, [], `${label} errors`);
}

function assertPathClean(value) {
  const serialized = JSON.stringify(value);
  assert(!serialized.includes("/Users/"), "artifact contains a local macOS identity path");
  assert(!serialized.includes("/home/"), "artifact contains a local Linux identity path");
  assert(!serialized.includes("mise/installs"), "artifact contains a toolchain path");
  assert(!/Bearer\s+[A-Za-z0-9._-]+/u.test(serialized), "artifact contains a bearer token");
}

function failureDescriptor(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const rawName = error instanceof Error ? error.name : "Error";
  const rawCode =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown";
  return {
    name: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(rawName) ? rawName : "Error",
    code: /^[A-Za-z0-9_.-]{1,64}$/u.test(rawCode) ? rawCode : "unknown",
    messageSha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export async function runLegacyBridgeContinuity(argv = []) {
  const options = parseArgs(argv);
  const ompRepo = await realpath(options.ompRepo);
  const artifactRoot = options.artifactRoot;
  const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const artifactDir = join(artifactRoot, runStamp);
  const temporaryBase = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const temporaryRoot = await realpath(await mkdtemp(join(temporaryBase, "t4-legacy-bridge-")));
  const home = join(temporaryRoot, "home");
  const projectsRoot = join(temporaryRoot, "projects");
  const projectA = join(projectsRoot, "project-a");
  const projectB = join(projectsRoot, "project-b");
  const xdgRoot = join(temporaryRoot, "xdg");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(projectA, { recursive: true }),
    mkdir(projectB, { recursive: true }),
    mkdir(join(xdgRoot, "config"), { recursive: true }),
    mkdir(join(xdgRoot, "data"), { recursive: true }),
    mkdir(join(xdgRoot, "state"), { recursive: true }),
    mkdir(join(xdgRoot, "cache"), { recursive: true }),
    mkdir(join(xdgRoot, "run"), { recursive: true, mode: 0o700 }),
    mkdir(artifactDir, { recursive: true }),
  ]);

  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: join(home, ".omp", "agent"),
    XDG_CONFIG_HOME: join(xdgRoot, "config"),
    XDG_DATA_HOME: join(xdgRoot, "data"),
    XDG_STATE_HOME: join(xdgRoot, "state"),
    XDG_CACHE_HOME: join(xdgRoot, "cache"),
    XDG_RUNTIME_DIR: join(xdgRoot, "run"),
  };
  env[["OPENAI", "API", "KEY"].join("_")] = ["t4", "operations", "fixture"].join("-");
  for (const key of [
    "OMP_APP_TEST_MODE",
    "OMP_APP_TEST_PROFILE",
    "OMP_APP_TEST_TOKEN",
    "OMP_APP_TEST_PROJECT_ROOT",
    "OMP_PROFILE",
    "PI_PROFILE",
    "PI_CONFIG_DIR",
    "PI_CONFIG_FILES",
  ]) {
    delete env[key];
  }

  const profiles = [
    {
      name: "continuity-a",
      projectRoot: projectA,
      runId: "continuity-a",
      sessions: 25,
      history: 10_000,
      token: createHash("sha256").update(`${runStamp}:a`).digest("hex"),
    },
    {
      name: "continuity-b",
      projectRoot: projectB,
      runId: "continuity-b",
      sessions: 2,
      history: 4,
      token: createHash("sha256").update(`${runStamp}:b`).digest("hex"),
    },
  ];
  const running = new Map();
  const probes = [];
  const wireJournal = createWireJournal();
  let tui;
  let result;
  let failure;

  try {
    for (const profile of profiles) {
      running.set(
        profile.name,
        await startAppserver({
          ompRepo,
          env,
          profile: profile.name,
          token: profile.token,
          projectRoot: profile.projectRoot,
        }),
      );
    }
    progress("appservers ready");
    const primaryProcess = running.get("continuity-a");
    const secondaryProcess = running.get("continuity-b");
    for (const profile of profiles) {
      const processRecord = running.get(profile.name);
      const initialStatus = await adminRequest(processRecord, "POST", "/admin/test/status", {
        runId: profile.runId,
      });
      assert.equal(initialStatus.profile, profile.name, "appserver test profile escaped isolation");
      assert.equal(initialStatus.state, "clean", "appserver test profile was not initially clean");
    }

    const seededA = await adminRequest(primaryProcess, "POST", "/admin/test/seed", {
      runId: profiles[0].runId,
      projectRoot: projectA,
      sessionCount: profiles[0].sessions,
      historyEntries: profiles[0].history,
    });
    assert.equal(seededA.sessions.seeded, 25);
    assert.equal(seededA.sessions.indexed, 25);
    progress("profile A seeded");

    const collisionRequests = await Promise.all([
      adminRaw(secondaryProcess, "POST", "/admin/test/seed", {
        runId: profiles[1].runId,
        projectRoot: projectB,
        sessionCount: profiles[1].sessions,
        historyEntries: profiles[1].history,
      }),
      adminRaw(secondaryProcess, "POST", "/admin/test/seed", {
        runId: profiles[1].runId,
        projectRoot: projectB,
        sessionCount: profiles[1].sessions,
        historyEntries: profiles[1].history,
      }),
    ]);
    assert.deepEqual(
      collisionRequests.map((item) => item.status).sort(),
      [200, 500],
      "same-run seed requests did not serialize",
    );
    const seededB = await adminRequest(secondaryProcess, "POST", "/admin/test/status", {
      runId: profiles[1].runId,
    });
    assert.deepEqual(seededB.sessions, { seeded: 2, indexed: 2 });
    progress("profile B collision gate passed");

    progress("connecting production T4 client");
    let t4Primary = await new T4Probe(
      "T4 Code primary",
      primaryProcess.socket,
      wireJournal,
    ).connect();
    probes.push(t4Primary);
    progress("production T4 client ready");
    const inventoryA = await sessionList(t4Primary, "profile A inventory");
    assert.equal(inventoryA.sessions.length, 25);
    const target = inventoryA.sessions.find((session) =>
      session.title.startsWith("[t4-test:continuity-a] Session 01"),
    );
    assert(target, "seeded target session missing");
    const targetPath = await findSessionPath(
      home,
      profiles[0].name,
      profiles[0].runId,
      target.sessionId,
    );
    progress("target session resolved");

    const initialSnapshot = await attachSnapshot(
      t4Primary,
      target.sessionId,
      "initial T4 snapshot",
    );
    assert(
      initialSnapshot.entries.length > 0 && initialSnapshot.entries.length < profiles[0].history,
      "large transcript snapshot was not bounded",
    );
    assert(
      initialSnapshot.entries.some((entry) => entry.kind === "compaction"),
      "bounded snapshot omitted compaction marker",
    );
    progress("bounded T4 snapshot received");
    await t4Primary.close();
    probes.splice(probes.indexOf(t4Primary), 1);
    progress("initial T4 transcript inspection complete");

    tui = await startRealTui({
      ompRepo,
      env,
      profile: profiles[0].name,
      projectRoot: projectA,
      sessionPath: targetPath,
    });
    progress("real OMP TUI launched");
    await waitUntil(
      async () => {
        if (tui.child.exitCode !== null) throw new Error(tui.output());
        const status = await adminRequest(primaryProcess, "POST", "/admin/test/status", {
          runId: profiles[0].runId,
        });
        return status.locks.live >= 1 && status;
      },
      "real TUI session ownership",
      RECONNECT_TIMEOUT_MS,
    );
    t4Primary = await new T4Probe("T4 Code observer", primaryProcess.socket, wireJournal).connect();
    probes.push(t4Primary);

    const observerMark = t4Primary.mark();
    const liveSnapshot = await attachSnapshot(
      t4Primary,
      target.sessionId,
      "live TUI observer snapshot",
    );
    assert(
      liveSnapshot.entries.some((entry) => entry.kind === "compaction"),
      "live observer snapshot lost the bounded transcript marker",
    );
    const observerDelta = await t4Primary.event(
      "session.delta",
      (payload) =>
        payload.sessionId === target.sessionId &&
        payload.upsert?.liveState?.sessionControl?.mode === "observer",
      observerMark,
      RECONNECT_TIMEOUT_MS,
    );
    assert.equal(observerDelta.payload.upsert.liveState.sessionControl.mode, "observer");
    const lockedTarget = observerDelta.payload.upsert;

    const t4Second = await new T4Probe(
      "T4 Code secondary",
      primaryProcess.socket,
      wireJournal,
    ).connect();
    probes.push(t4Second);
    const secondSnapshot = await attachSnapshot(
      t4Second,
      target.sessionId,
      "second-client transcript snapshot",
    );
    assert(
      secondSnapshot.entries.length > 0 && secondSnapshot.entries.length < profiles[0].history,
      "second client did not receive bounded transcript snapshot",
    );

    const lockedRename = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      sessionId: target.sessionId,
      command: "session.rename",
      expectedRevision: lockedTarget.revision,
      args: { name: "[t4-test:continuity-a] locked rename must fail" },
    });
    assert.equal(lockedRename.ok, false, "T4 control bypassed live TUI ownership");
    assert.equal(
      lockedRename.error?.code,
      "session_locked",
      "live ownership returned the wrong failure code",
    );

    const reconnectMark = t4Second.mark();
    const beforeDropGeneration = t4Second.client.snapshot().generation;
    const contextPending = t4Second.client.command({
      hostId: t4Second.hostId(),
      sessionId: target.sessionId,
      command: "transcript.context",
      args: { anchorId: secondSnapshot.entries.at(-1).id, before: 1, after: 0 },
    });
    const disconnectStartedAt = Date.now();
    t4Second.transport.disconnect();
    const droppedOutcome = await contextPending.then(
      (response) => ({ kind: "response", ok: response.ok, code: response.error?.code ?? null }),
      (error) => ({ kind: "error", ok: false, code: error.code ?? "unknown" }),
    );
    const forcedDisconnectOutcomeMs = Date.now() - disconnectStartedAt;
    assert(
      forcedDisconnectOutcomeMs < 5_000,
      `forced disconnect was not client-visible promptly (${forcedDisconnectOutcomeMs}ms)`,
    );
    assert.equal(
      droppedOutcome.ok,
      false,
      "forced mid-command disconnect unexpectedly completed normally",
    );
    assert.equal(
      droppedOutcome.code,
      "outcome_unknown",
      "forced disconnect did not expose outcome_unknown",
    );
    await waitUntil(
      () =>
        t4Second.client.state === "ready" &&
        t4Second.client.snapshot().generation > beforeDropGeneration,
      "T4 reconnect after forced disconnect",
      RECONNECT_TIMEOUT_MS,
    );
    const reattachResponse = await t4Second.event(
      "response",
      (payload) => payload.ok === true && payload.result?.attached === true,
      reconnectMark,
      RECONNECT_TIMEOUT_MS,
    );
    assert.equal(reattachResponse.payload.ok, true, "reconnected T4 client did not reattach");
    const postReconnectContext = await t4Second.client.command({
      hostId: t4Second.hostId(),
      sessionId: target.sessionId,
      command: "transcript.context",
      args: { anchorId: secondSnapshot.entries.at(-1).id, before: 1, after: 0 },
    });
    assert.equal(
      postReconnectContext.ok,
      true,
      "reconnected T4 client could not read transcript context",
    );
    assert(
      (postReconnectContext.result?.rows?.length ?? 0) > 0,
      "reconnected T4 client recovered no transcript rows",
    );

    const restartMark = t4Primary.mark();
    const beforeRestartEpoch = t4Primary.client.snapshot().epoch;
    await stopProcess(primaryProcess, "primary appserver before restart");
    running.delete("continuity-a");
    const restarted = await startAppserver({
      ompRepo,
      env,
      profile: profiles[0].name,
      token: profiles[0].token,
      projectRoot: projectA,
    });
    running.set("continuity-a", restarted);
    await waitUntil(
      () =>
        t4Primary.client.state === "ready" &&
        t4Primary.client.snapshot().epoch !== beforeRestartEpoch,
      "T4 reconnect after appserver restart",
      RECONNECT_TIMEOUT_MS,
    );
    await waitUntil(
      () =>
        t4Second.client.state === "ready" &&
        t4Second.client.snapshot().epoch === t4Primary.client.snapshot().epoch,
      "second T4 reconnect after appserver restart",
      RECONNECT_TIMEOUT_MS,
    );
    const postRestartSnapshotEvent = await t4Primary.event(
      "snapshot",
      (payload) => payload.sessionId === target.sessionId,
      restartMark,
      RECONNECT_TIMEOUT_MS,
    );
    const postRestartSnapshot = {
      label: "post-restart transcript snapshot",
      ...postRestartSnapshotEvent.payload,
    };
    const persistedStatus = await adminRequest(restarted, "POST", "/admin/test/status", {
      runId: profiles[0].runId,
    });
    assert.equal(
      persistedStatus.sessions.seeded,
      25,
      "test run manifest did not survive appserver restart",
    );
    assert.equal(
      persistedStatus.locks.live,
      1,
      "live TUI ownership did not survive appserver restart",
    );

    await stopRealTui(tui);
    tui = undefined;
    await waitUntil(
      async () => {
        const status = await adminRequest(restarted, "POST", "/admin/test/status", {
          runId: profiles[0].runId,
        });
        return status.locks.live === 0 && status.workers.supervisors === 0 && status;
      },
      "TUI ownership release",
      RECONNECT_TIMEOUT_MS,
    );

    const recoverTarget = await waitUntil(
      async () => {
        const inventory = await sessionList(t4Primary, "post-restart control inventory");
        const candidate = inventory.sessions.find(
          (session) => session.sessionId === target.sessionId,
        );
        if (candidate?.liveState?.sessionControl === undefined) return candidate;
        throw new Error(
          `target control=${JSON.stringify(candidate?.liveState?.sessionControl ?? null)}`,
        );
      },
      "writable T4 session projection",
      RECONNECT_TIMEOUT_MS,
    );
    const firstRenameMark = t4Primary.mark();
    const firstRename = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      sessionId: target.sessionId,
      command: "session.rename",
      expectedRevision: recoverTarget.revision,
      args: { name: "[t4-test:continuity-a] T4 control recovered" },
    });
    assert.equal(
      firstRename.ok,
      true,
      `T4 control recovery failed: ${JSON.stringify(firstRename.error)}`,
    );
    const renameDelta = await t4Primary.event(
      "session.delta",
      (payload) =>
        payload.upsert?.sessionId === target.sessionId &&
        payload.upsert?.title.endsWith("T4 control recovered"),
      firstRenameMark,
    );
    const staleRename = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      sessionId: target.sessionId,
      command: "session.rename",
      expectedRevision: recoverTarget.revision,
      args: { name: "[t4-test:continuity-a] stale rename must fail" },
    });
    assert.equal(staleRename.ok, false, "stale revision unexpectedly mutated the session");
    assert.equal(
      staleRename.error?.code,
      "stale_revision",
      "stale control returned the wrong error code",
    );
    const secondRename = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      sessionId: target.sessionId,
      command: "session.rename",
      expectedRevision: renameDelta.payload.upsert.revision,
      args: { name: "[t4-test:continuity-a] T4 control final" },
    });
    assert.equal(secondRename.ok, true, "fresh revision did not recover control");

    const searchResponse = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      command: "transcript.search",
      args: { query: "T4 continuity continuity-a session 1 entry", limit: 5 },
    });
    assert.equal(
      searchResponse.ok,
      true,
      `transcript search failed: ${JSON.stringify(searchResponse.error)}`,
    );
    assert((searchResponse.result?.items?.length ?? 0) > 0, "transcript search returned no items");
    const contextResponse = await t4Primary.client.command({
      hostId: t4Primary.hostId(),
      sessionId: target.sessionId,
      command: "transcript.context",
      args: { anchorId: searchResponse.result.items[0].anchorId, before: 2, after: 0 },
    });
    assert.equal(
      contextResponse.ok,
      true,
      `transcript context failed: ${JSON.stringify(contextResponse.error)}`,
    );
    assert((contextResponse.result?.rows?.length ?? 0) > 0, "transcript context returned no rows");

    const t4ProfileB = await new T4Probe(
      "T4 Code profile B",
      secondaryProcess.socket,
      wireJournal,
    ).connect();
    probes.push(t4ProfileB);
    const inventoryB = await sessionList(t4ProfileB, "profile B inventory");
    assert.equal(inventoryB.sessions.length, 2, "profile B seed count changed under collision");
    assert(
      !inventoryB.sessions.some((session) => session.sessionId === target.sessionId),
      "profile A session leaked into profile B",
    );
    assert(
      !inventoryA.sessions.some((sessionB) =>
        inventoryB.sessions.some((session) => session.sessionId === sessionB.sessionId),
      ),
      "profiles shared session identities",
    );

    const cursorIntegrity = assertDeliveredCursorIntegrity(probes);
    assert(cursorIntegrity.cursors > 0, "T4 clients delivered no durable cursors");

    for (const probe of probes) await probe.close();
    probes.length = 0;

    const cleanupA = await adminRequest(restarted, "POST", "/admin/test/cleanup", {
      runId: profiles[0].runId,
    });
    const cleanupB = await adminRequest(secondaryProcess, "POST", "/admin/test/cleanup", {
      runId: profiles[1].runId,
    });
    assertCleanStatus(cleanupA, "profile A cleanup");
    assertCleanStatus(cleanupB, "profile B cleanup");
    const cleanupARepeat = await adminRequest(restarted, "POST", "/admin/test/cleanup", {
      runId: profiles[0].runId,
    });
    assertCleanStatus(cleanupARepeat, "profile A idempotent cleanup");

    const cleanupProbeA = await new T4Probe(
      "T4 Code cleanup profile A",
      restarted.socket,
      wireJournal,
    ).connect();
    const cleanupProbeB = await new T4Probe(
      "T4 Code cleanup profile B",
      secondaryProcess.socket,
      wireJournal,
    ).connect();
    probes.push(cleanupProbeA, cleanupProbeB);
    const postCleanupInventoryA = await sessionList(
      cleanupProbeA,
      "profile A post-cleanup inventory",
    );
    const postCleanupInventoryB = await sessionList(
      cleanupProbeB,
      "profile B post-cleanup inventory",
    );
    assert.equal(
      postCleanupInventoryA.sessions.length,
      0,
      "profile A retained cleaned sessions in memory",
    );
    assert.equal(
      postCleanupInventoryB.sessions.length,
      0,
      "profile B retained cleaned sessions in memory",
    );
    const postCleanupSearch = await cleanupProbeA.client.command({
      hostId: cleanupProbeA.hostId(),
      command: "transcript.search",
      args: { query: "T4 continuity continuity-a", limit: 5 },
    });
    assert.equal(postCleanupSearch.ok, true, "post-cleanup transcript search failed");
    assert.equal(
      postCleanupSearch.result?.items?.length ?? 0,
      0,
      "transcript search retained cleaned sessions",
    );
    for (const probe of probes) await probe.close();
    probes.length = 0;

    const remainingJsonl = (await visit(join(home, ".omp"))).filter((path) =>
      path.endsWith(".jsonl"),
    );
    assert.equal(
      remainingJsonl.length,
      0,
      "cleanup left session JSONL files in the isolated profile root",
    );
    const remainingLocks = (await visit(join(home, ".omp"))).filter(
      (path) => path.endsWith(".lock") || path.endsWith(".lock.steal"),
    );
    assert.equal(
      remainingLocks.length,
      0,
      "cleanup left session lock files in the isolated profile root",
    );

    const report = {
      v: 1,
      status: "passed",
      scenario: {
        hostImplementation: "legacy-omp-appserver",
        authorityImplementation: "lycaon-omp",
        profiles: 2,
        projects: 2,
        seededSessions: 27,
        largeHistoryEntries: profiles[0].history,
        clients: ["real OMP TUI", "T4 Code primary", "T4 Code secondary", "T4 Code profile B"],
        restart: true,
        reconnect: true,
        cleanup: true,
      },
      source: { t4: gitSource(repoRoot), omp: gitSource(ompRepo) },
      evidence: {
        initialSnapshotEntries: initialSnapshot.entries.length,
        secondSnapshotEntries: secondSnapshot.entries.length,
        postRestartSnapshotEntries: postRestartSnapshot.entries.length,
        realTuiOwnershipObserved: lockedRename.error.code === "session_locked",
        lockedControlCode: lockedRename.error.code,
        forcedDisconnectOutcome: droppedOutcome,
        forcedDisconnectOutcomeMs,
        postReconnectContextRows: postReconnectContext.result?.rows?.length ?? 0,
        staleRevisionCode: staleRename.error.code,
        recoveredControl: secondRename.ok,
        profileIsolation: {
          profileA: inventoryA.sessions.length,
          profileB: inventoryB.sessions.length,
          sharedSessionIds: 0,
        },
        concurrentSeedStatuses: collisionRequests.map((item) => item.status).sort(),
        persistedAcrossRestart: persistedStatus.sessions.seeded,
        cursorIntegrity,
        transcriptContextRows: contextResponse.result.rows.length,
        transcriptSearchRows: searchResponse.result.items.length,
        postCleanupSessions: {
          profileA: postCleanupInventoryA.sessions.length,
          profileB: postCleanupInventoryB.sessions.length,
        },
        postCleanupSearchRows: postCleanupSearch.result?.items?.length ?? 0,
        wireJournal: wireJournal.summary(),
      },
      artifacts: [
        "report.json",
        "wire-events.ndjson",
        "cleanup-status.json",
        "failure-matrix.json",
        "rollback.sh",
      ],
      cleanup: {
        profileA: cleanupA,
        profileB: cleanupB,
        repeatProfileA: cleanupARepeat,
        remainingJsonl: 0,
        remainingLocks: 0,
        sandboxRemovedByHarness: process.env.T4_KEEP_CONTINUITY_SANDBOX !== "1",
      },
    };
    const failureMatrix = {
      v: 1,
      failures: [
        {
          injection: "concurrent duplicate seed",
          expected: "one 200 and one 500",
          observed: collisionRequests.map((item) => item.status).sort(),
          recovered: seededB.sessions.seeded === 2,
        },
        {
          injection: "live TUI ownership",
          expected: "session_locked",
          observed: lockedRename.error.code,
          recovered: secondRename.ok,
        },
        {
          injection: "T4 transport closed with command in flight",
          expected: "outcome_unknown then reconnect",
          observed: droppedOutcome.code,
          recovered:
            t4Second.client.state === "closed" ||
            t4Second.states.some(
              (state) => state.state === "ready" && state.generation > beforeDropGeneration,
            ),
        },
        {
          injection: "appserver SIGTERM and restart",
          expected: "new epoch and retained run manifest",
          observed: persistedStatus.sessions.seeded,
          recovered: persistedStatus.sessions.seeded === 25,
        },
        {
          injection: "stale revision after recovery",
          expected: "stale_revision",
          observed: staleRename.error.code,
          recovered: secondRename.ok,
        },
      ],
    };
    assertPathClean(report);
    assertPathClean(wireJournal.events());
    assertPathClean(failureMatrix);
    await Promise.all([
      writeFile(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`),
      writeFile(
        join(artifactDir, "wire-events.ndjson"),
        `${wireJournal
          .events()
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
      ),
      writeFile(
        join(artifactDir, "cleanup-status.json"),
        `${JSON.stringify(report.cleanup, null, 2)}\n`,
      ),
      writeFile(
        join(artifactDir, "failure-matrix.json"),
        `${JSON.stringify(failureMatrix, null, 2)}\n`,
      ),
      writeFile(
        join(artifactDir, "rollback.sh"),
        `#!/bin/sh\nset -eu\n: "\${APP_SOCKET:?set APP_SOCKET}"\n: "\${APP_TOKEN:?set APP_TOKEN}"\n: "\${RUN_ID:?set RUN_ID}"\ncurl --fail --silent --show-error --unix-socket "$APP_SOCKET" \\\n  -H "Authorization: Bearer $APP_TOKEN" -H "Content-Type: application/json" \\\n  --data "{\\"runId\\":\\"$RUN_ID\\"}" http://localhost/admin/test/cleanup\n# The response must report: state=clean, sessions=0/0, every lock and worker count=0, remainingFiles=0, errors=[].\n`,
        { mode: 0o700 },
      ),
      appendFile(
        join(artifactRoot, "runs.ndjson"),
        `${JSON.stringify({ run: relative(artifactRoot, artifactDir), status: "passed", t4Commit: report.source.t4.commit, ompCommit: report.source.omp.commit })}\n`,
      ),
    ]);
    result = { artifactDir, report };
  } catch (error) {
    failure = error;
    const failureReport = {
      v: 1,
      status: "failed",
      error: failureDescriptor(error),
      source: { t4: gitSource(repoRoot), omp: gitSource(ompRepo) },
      evidence: { wireJournal: wireJournal.summary() },
    };
    assertPathClean(failureReport);
    assertPathClean(wireJournal.events());
    await Promise.all([
      writeFile(join(artifactDir, "report.json"), `${JSON.stringify(failureReport, null, 2)}\n`),
      writeFile(
        join(artifactDir, "wire-events.ndjson"),
        `${wireJournal
          .events()
          .map((event) => JSON.stringify(event))
          .join("\n")}\n`,
      ),
      appendFile(
        join(artifactRoot, "runs.ndjson"),
        `${JSON.stringify({ run: relative(artifactRoot, artifactDir), status: "failed", t4Commit: failureReport.source.t4.commit, ompCommit: failureReport.source.omp.commit })}\n`,
      ),
    ]);
  } finally {
    for (const probe of probes) {
      try {
        await probe.close();
      } catch {
        // Continue deterministic teardown after a failed assertion.
      }
    }
    if (tui) {
      try {
        await stopProcess(tui, "real OMP TUI during teardown");
      } catch {
        // Preserve the original failure.
      }
    }
    for (const [name, processRecord] of running) {
      try {
        await stopProcess(processRecord, `${name} appserver during teardown`);
      } catch {
        // Preserve the original failure.
      }
    }
    if (process.env.T4_KEEP_CONTINUITY_SANDBOX !== "1")
      await rm(temporaryRoot, { recursive: true, force: true });
  }

  if (failure) throw failure;
  const summary = {
    status: result.report.status,
    artifactDir: relative(repoRoot, result.artifactDir),
    scenario: result.report.scenario,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}
