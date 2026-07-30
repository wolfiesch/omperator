import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  decodeGeneration,
  decodeOpaqueId,
  type Generation,
  type RuntimeId,
} from "@t4-code/portable-core";

export const CMUX_SOURCE_REPOSITORY = "https://github.com/manaflow-ai/cmux";
export const CMUX_SOURCE_COMMIT = "192e44428c16b98210c951ec4bd5a86bc7139014";
export const CMUX_SOURCE_TREE = "8e8fd0f70452987a00773f21e96b6c2f14825332";
export const CMUX_TUI_SOURCE_TREE = "e0b39f571435fcee7557394988bf04e43bc3d4f6";
export const CMUX_GHOSTTY_COMMIT = "8f31fb57cde291e7b8fecb46203bc398c44459f4";
export const CMUX_PROTOCOL_VERSION = 10;
export const CMUX_RUST_TOOLCHAIN = "1.95.0";
export const CMUX_ZIG_TOOLCHAIN = "0.15.2";
/** Darwin's sockaddr_un.sun_path is 104 bytes including its trailing NUL. */
export const MAX_CMUX_SOCKET_PATH_BYTES = 103;

const STATE_MARKER = ".t4-cmux-state.json";
const WRITER_LOCK = ".t4-cmux-writer.lock";
const OUTPUT_LIMIT = 64 * 1024;
const PROBE_OUTPUT_LIMIT = 16 * 1024;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_IDENTITY_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;

export interface CmuxBuildManifest {
  readonly schemaVersion: 1;
  readonly artifact: "cmux-tui-headless";
  readonly sourceRepository: typeof CMUX_SOURCE_REPOSITORY;
  readonly sourceCommit: typeof CMUX_SOURCE_COMMIT;
  readonly sourceTree: typeof CMUX_SOURCE_TREE;
  readonly cmuxTuiSourceTree: typeof CMUX_TUI_SOURCE_TREE;
  readonly ghosttyCommit: typeof CMUX_GHOSTTY_COMMIT;
  readonly rustToolchain: typeof CMUX_RUST_TOOLCHAIN;
  readonly zigToolchain: typeof CMUX_ZIG_TOOLCHAIN;
  readonly target: string;
  readonly binaryFile: string;
  readonly binarySha256: string;
  readonly versionOutput: string;
}

export interface CmuxRuntimeConfig {
  readonly binaryPath: string;
  readonly buildManifestPath: string;
  readonly runtimeId: RuntimeId;
  readonly generation: Generation;
  /** A short, local, supervisor-private root such as T4_HOST_RUNTIME_DIR. */
  readonly runtimeDirectory: string;
  /** Durable cmux state. This must not be a shared workspace directory. */
  readonly stateDirectory: string;
  /** Bounded identity probe; increase only for translated/cold-start test artifacts. */
  readonly identityTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface CmuxRuntimePaths {
  readonly generationDirectory: string;
  readonly socketPath: string;
  readonly privateHome: string;
  readonly writerLockPath: string;
  readonly stateMarkerPath: string;
}

export interface CmuxExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  /** Unexpected exit retains the lock because descendant/storage fencing is unproven. */
  readonly writerLockRetained: boolean;
}

export interface CmuxRuntimeHandle {
  readonly pid: number;
  readonly runtimeId: RuntimeId;
  readonly generation: Generation;
  readonly socketPath: string;
  readonly stateDirectory: string;
  readonly exited: Promise<CmuxExit>;
  readonly diagnostics: () => Readonly<{ stdout: string; stderr: string }>;
  stop(): Promise<void>;
}

export class CmuxRuntimeError extends Error {
  readonly code:
    | "invalidConfiguration"
    | "pathTooLong"
    | "sourceMismatch"
    | "binaryMismatch"
    | "duplicateWriter"
    | "corruptState"
    | "startFailed"
    | "protocolMismatch"
    | "stopFailed";

  constructor(code: CmuxRuntimeError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CmuxRuntimeError";
    this.code = code;
  }
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function byteLength(path: string): number {
  return Buffer.byteLength(path, "utf8");
}

function positiveTimeout(value: number | undefined, fallback: number, field: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 120_000)
    throw new CmuxRuntimeError("invalidConfiguration", `${field} must be 1..120000 milliseconds`);
  return result;
}

function requireAbsolute(path: string, field: string): string {
  if (!isAbsolute(path))
    throw new CmuxRuntimeError("invalidConfiguration", `${field} must be absolute`);
  return resolve(path);
}

export function allocateCmuxRuntimePaths(
  config: Pick<CmuxRuntimeConfig, "runtimeId" | "generation" | "runtimeDirectory" | "stateDirectory">,
): CmuxRuntimePaths {
  const runtimeId = decodeOpaqueId(config.runtimeId) as RuntimeId;
  const generation = decodeGeneration(config.generation);
  const runtimeDirectory = requireAbsolute(config.runtimeDirectory, "runtimeDirectory");
  const stateDirectory = requireAbsolute(config.stateDirectory, "stateDirectory");
  const key = sha256(`${runtimeId}\0${generation}`).slice(0, 20);
  const generationDirectory = join(runtimeDirectory, key);
  const socketPath = join(generationDirectory, "c.sock");
  if (byteLength(socketPath) > MAX_CMUX_SOCKET_PATH_BYTES) {
    throw new CmuxRuntimeError(
      "pathTooLong",
      `cmux socket path is ${byteLength(socketPath)} bytes; maximum is ${MAX_CMUX_SOCKET_PATH_BYTES}`,
    );
  }
  return {
    generationDirectory,
    socketPath,
    privateHome: join(stateDirectory, ".home"),
    writerLockPath: join(stateDirectory, WRITER_LOCK),
    stateMarkerPath: join(stateDirectory, STATE_MARKER),
  };
}

function exactString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is invalid`);
  return value;
}

function parseBuildManifest(value: unknown): CmuxBuildManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("manifest is not an object");
  const item = value as Record<string, unknown>;
  const keys = [
    "schemaVersion", "artifact", "sourceRepository", "sourceCommit", "sourceTree",
    "cmuxTuiSourceTree", "ghosttyCommit", "rustToolchain", "zigToolchain", "target", "binaryFile",
    "binarySha256", "versionOutput",
  ];
  if (Object.keys(item).sort().join("\0") !== [...keys].sort().join("\0"))
    throw new Error("manifest fields are not exact");
  const manifest = {
    schemaVersion: item.schemaVersion,
    artifact: item.artifact,
    sourceRepository: exactString(item, "sourceRepository"),
    sourceCommit: exactString(item, "sourceCommit"),
    sourceTree: exactString(item, "sourceTree"),
    cmuxTuiSourceTree: exactString(item, "cmuxTuiSourceTree"),
    ghosttyCommit: exactString(item, "ghosttyCommit"),
    rustToolchain: exactString(item, "rustToolchain"),
    zigToolchain: exactString(item, "zigToolchain"),
    target: exactString(item, "target"),
    binaryFile: exactString(item, "binaryFile"),
    binarySha256: exactString(item, "binarySha256"),
    versionOutput: exactString(item, "versionOutput"),
  };
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifact !== "cmux-tui-headless" ||
    manifest.sourceRepository !== CMUX_SOURCE_REPOSITORY ||
    manifest.sourceCommit !== CMUX_SOURCE_COMMIT ||
    manifest.sourceTree !== CMUX_SOURCE_TREE ||
    manifest.cmuxTuiSourceTree !== CMUX_TUI_SOURCE_TREE ||
    manifest.ghosttyCommit !== CMUX_GHOSTTY_COMMIT ||
    manifest.rustToolchain !== CMUX_RUST_TOOLCHAIN ||
    manifest.zigToolchain !== CMUX_ZIG_TOOLCHAIN ||
    !/^[a-f0-9]{64}$/u.test(manifest.binarySha256) ||
    !manifest.versionOutput.includes(`(${CMUX_SOURCE_COMMIT}; ghostty ${CMUX_GHOSTTY_COMMIT})`)
  ) throw new Error("manifest identity does not match the pinned cmux build");
  return manifest as CmuxBuildManifest;
}

async function boundedCommand(
  executable: string,
  argv: readonly string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(executable, argv, { stdio: ["ignore", "pipe", "pipe"], env: {} });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let outputError: CmuxRuntimeError | undefined;
  const append = (chunks: Buffer[], chunk: Buffer): void => {
    outputBytes += chunk.length;
    if (outputBytes > PROBE_OUTPUT_LIMIT) {
      outputError = new CmuxRuntimeError("binaryMismatch", "cmux identity output exceeds 16 KiB");
      child.kill("SIGKILL");
      return;
    }
    chunks.push(chunk);
  };
  child.stdout!.on("data", (chunk: Buffer) => { append(stdout, chunk); });
  child.stderr!.on("data", (chunk: Buffer) => { append(stderr, chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const completion = Promise.withResolvers<number | null>();
    child.once("error", completion.reject);
    child.once("close", code => completion.resolve(code));
    const code = await completion.promise;
    if (outputError) throw outputError;
    return {
      code,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
      stderr: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr)),
    };
  } finally {
    clearTimeout(timer);
  }
}

interface LoadedCmuxArtifact {
  readonly manifest: CmuxBuildManifest;
  readonly bytes: Uint8Array;
  readonly canonicalPath: string;
}

async function loadCmuxArtifact(binaryPath: string, buildManifestPath: string): Promise<LoadedCmuxArtifact> {
  const binary = requireAbsolute(binaryPath, "binaryPath");
  const manifestPath = requireAbsolute(buildManifestPath, "buildManifestPath");
  let manifest: CmuxBuildManifest;
  try {
    manifest = parseBuildManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    throw new CmuxRuntimeError("sourceMismatch", "cmux build manifest is invalid", { cause: error });
  }
  const canonicalPath = await realpath(binary).catch(error => {
    throw new CmuxRuntimeError("binaryMismatch", "cmux binary cannot be resolved", { cause: error });
  });
  if (basename(canonicalPath) !== manifest.binaryFile)
    throw new CmuxRuntimeError("binaryMismatch", "cmux binary filename does not match its manifest");
  const bytes = await readFile(canonicalPath);
  if (sha256(bytes) !== manifest.binarySha256)
    throw new CmuxRuntimeError("binaryMismatch", "cmux binary SHA-256 does not match its manifest");
  return { manifest, bytes, canonicalPath };
}

async function verifyEmbeddedIdentity(
  binaryPath: string,
  manifest: CmuxBuildManifest,
  timeoutMs = DEFAULT_IDENTITY_TIMEOUT_MS,
): Promise<void> {
  const probe = await boundedCommand(binaryPath, ["--version"], timeoutMs).catch(error => {
    if (error instanceof CmuxRuntimeError) throw error;
    throw new CmuxRuntimeError("binaryMismatch", "cmux version probe failed", { cause: error });
  });
  if (probe.code !== 0 || probe.stdout.trim() !== manifest.versionOutput)
    throw new CmuxRuntimeError(
      "binaryMismatch",
      `cmux embedded source identity does not match its manifest: expected ${JSON.stringify(manifest.versionOutput)}, received ${JSON.stringify(probe.stdout.trim())}, exit ${String(probe.code)}`,
    );
}

export async function verifyCmuxBinary(
  binaryPath: string,
  buildManifestPath: string,
): Promise<CmuxBuildManifest> {
  const artifact = await loadCmuxArtifact(binaryPath, buildManifestPath);
  await verifyEmbeddedIdentity(artifact.canonicalPath, artifact.manifest);
  return artifact.manifest;
}

async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
  try {
    await mkdir(path, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new CmuxRuntimeError("invalidConfiguration", `${path} must be a real directory`);
  if ((info.mode & 0o077) !== 0)
    throw new CmuxRuntimeError("invalidConfiguration", `${path} must not be group/world accessible`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new CmuxRuntimeError("invalidConfiguration", `${path} is not owned by the runtime user`);
}

interface WriterLease {
  readonly token: string;
  readonly path: string;
  readonly file: FileHandle;
}

async function acquireWriterLease(
  path: string,
  runtimeId: RuntimeId,
  generation: Generation,
): Promise<WriterLease> {
  const token = randomUUID();
  let file: FileHandle;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CmuxRuntimeError("duplicateWriter", "cmux durable state already has a writer lock");
    throw error;
  }
  try {
    await file.writeFile(`${JSON.stringify({ schemaVersion: 1, token, runtimeId, generation, pid: process.pid })}\n`);
    await file.sync();
    return { token, path, file };
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
}

async function releaseWriterLease(lease: WriterLease): Promise<void> {
  await lease.file.close();
  const current = JSON.parse(await readFile(lease.path, "utf8")) as { token?: unknown };
  if (current.token !== lease.token)
    throw new CmuxRuntimeError("stopFailed", "cmux writer lock ownership changed while held");
  await unlink(lease.path);
}

interface StateMarker {
  readonly schemaVersion: 1;
  readonly runtimeId: RuntimeId;
  readonly sourceCommit: typeof CMUX_SOURCE_COMMIT;
  readonly muxProtocol: 10;
}

async function validateOrInitializeState(
  stateDirectory: string,
  markerPath: string,
  runtimeId: RuntimeId,
): Promise<void> {
  const entries = (await readdir(stateDirectory)).filter(entry => entry !== WRITER_LOCK);
  if (!entries.includes(STATE_MARKER)) {
    if (entries.length !== 0)
      throw new CmuxRuntimeError("corruptState", "unmarked cmux state directory is not safe to adopt");
    const marker: StateMarker = {
      schemaVersion: 1,
      runtimeId,
      sourceCommit: CMUX_SOURCE_COMMIT,
      muxProtocol: CMUX_PROTOCOL_VERSION,
    };
    const file = await open(markerPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(marker)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    return;
  }
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
    const keys = ["muxProtocol", "runtimeId", "schemaVersion", "sourceCommit"];
    if (
      Object.keys(marker).sort().join("\0") !== keys.sort().join("\0") ||
      marker.schemaVersion !== 1 ||
      marker.runtimeId !== runtimeId ||
      marker.sourceCommit !== CMUX_SOURCE_COMMIT ||
      marker.muxProtocol !== CMUX_PROTOCOL_VERSION
    ) throw new Error("state marker identity mismatch");
  } catch (error) {
    throw new CmuxRuntimeError("corruptState", "cmux durable state marker is invalid", { cause: error });
  }
}

function privateEnvironment(paths: CmuxRuntimePaths): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: paths.privateHome,
    XDG_CONFIG_HOME: join(paths.privateHome, ".config"),
    XDG_CACHE_HOME: join(paths.privateHome, ".cache"),
    XDG_DATA_HOME: join(paths.privateHome, ".local", "share"),
    TERM: "xterm-256color",
  };
  for (const key of ["PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL"] as const) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await delay(25);
  return !processAlive(pid);
}



function processAlive(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
    encoding: "utf8",
    timeout: 1_000,
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new CmuxRuntimeError("stopFailed", `could not inspect contained cmux process ${pid}`);
  const state = result.stdout.trim();
  return result.status === 0 && state !== "" && !state.startsWith("Z");
}

function descendantProcessIds(rootPid: number): ReadonlySet<number> {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0)
    throw new CmuxRuntimeError("stopFailed", `could not inspect cmux descendants for ${rootPid}`);
  const children = new Map<number, number[]>();
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  const descendants = new Set<number>();
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (pid <= 1 || pid === process.pid || descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

function containedProcessIds(paths: CmuxRuntimePaths): ReadonlySet<number> {
  const executable = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const found = new Set<number>();
  for (const path of [paths.generationDirectory, dirname(paths.stateMarkerPath)]) {
    const result = spawnSync(executable, ["-t", "+D", path], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (result.error || (result.status !== 0 && result.status !== 1))
      throw new CmuxRuntimeError("stopFailed", `could not inspect cmux containment path ${path}`);
    for (const line of result.stdout.split("\n")) {
      const pid = Number(line.trim());
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) found.add(pid);
    }
  }
  return found;
}

function signalContainedProcesses(pids: ReadonlySet<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function waitForContainmentExit(
  paths: CmuxRuntimePaths,
  tracked: Set<number>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ([...tracked].every(pid => !processAlive(pid))) {
      const current = containedProcessIds(paths);
      for (const pid of current) tracked.add(pid);
      if (current.size === 0) return true;
    }
    await delay(25);
  }
  const current = containedProcessIds(paths);
  for (const pid of current) tracked.add(pid);
  return current.size === 0 && [...tracked].every(pid => !processAlive(pid));
}

function delay(ms: number): Promise<void> {
  const completion = Promise.withResolvers<void>();
  setTimeout(completion.resolve, ms);
  return completion.promise;
}

export async function startCmuxRuntime(config: CmuxRuntimeConfig): Promise<CmuxRuntimeHandle> {
  if (process.platform === "win32")
    throw new CmuxRuntimeError("invalidConfiguration", "P1-04 requires Unix domain sockets");
  const runtimeId = decodeOpaqueId(config.runtimeId) as RuntimeId;
  const generation = decodeGeneration(config.generation);
  const artifact = await loadCmuxArtifact(config.binaryPath, config.buildManifestPath);
  const startTimeoutMs = positiveTimeout(config.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, "startTimeoutMs");
  const stopTimeoutMs = positiveTimeout(config.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs");
  const identityTimeoutMs = positiveTimeout(config.identityTimeoutMs, DEFAULT_IDENTITY_TIMEOUT_MS, "identityTimeoutMs");
  const paths = allocateCmuxRuntimePaths({ ...config, runtimeId, generation });
  const boundBinaryPath = join(paths.generationDirectory, "cmux");
  await ensurePrivateDirectory(resolve(config.runtimeDirectory), true);
  await ensurePrivateDirectory(paths.generationDirectory);
  await ensurePrivateDirectory(resolve(config.stateDirectory), true);
  const existingSocket = await lstat(paths.socketPath).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  });
  if (existingSocket)
    throw new CmuxRuntimeError("duplicateWriter", "generation socket path already exists");

  const lease = await acquireWriterLease(paths.writerLockPath, runtimeId, generation);
  let child: ChildProcess | undefined;
  let childExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  try {
    await validateOrInitializeState(resolve(config.stateDirectory), paths.stateMarkerPath, runtimeId);
    await ensurePrivateDirectory(paths.privateHome);
    await writeFile(boundBinaryPath, artifact.bytes, { flag: "wx", mode: 0o500 });
    await verifyEmbeddedIdentity(boundBinaryPath, artifact.manifest, identityTimeoutMs);
    child = spawn(boundBinaryPath, [
      "--headless",
      "--session", `t4-${sha256(runtimeId).slice(0, 16)}`,
      "--socket", paths.socketPath,
      "--state", resolve(config.stateDirectory),
    ], {
      cwd: paths.privateHome,
      detached: true,
      env: privateEnvironment(paths),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid === undefined) throw new Error("cmux child has no pid");

    let stdout = "";
    let stderr = "";
    const capture = (current: string, chunk: Buffer): string =>
      (current + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
    child.stdout!.on("data", (chunk: Buffer) => { stdout = capture(stdout, chunk); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr = capture(stderr, chunk); });

    let expected = false;
    let exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let exitExpected = false;
    const completion =
      Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    child.once("error", completion.reject);
    child.once("exit", (code, signal) => {
      exitExpected = expected;
      exitResult = { code, signal };
      if (!expected) {
        try { signalProcessGroup(child!, "SIGTERM"); } catch { /* lock remains fail closed */ }
      }
      completion.resolve({ code, signal });
    });
    const rawExit = completion.promise;
    childExited = rawExit;
    const exited: Promise<CmuxExit> = rawExit.then(result => ({
      ...result,
      expected: exitExpected,
      writerLockRetained: !exitExpected,
    }));

    const deadline = Date.now() + startTimeoutMs;
    let identified = false;
    let lastProbeError: unknown;
    while (Date.now() < deadline) {
      if (exitResult) throw new Error(`cmux exited before readiness (${exitResult.code ?? exitResult.signal})`);
      const socketReady = await stat(paths.socketPath).then(info => info.isSocket(), error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
      if (socketReady) {
        try {
          const probe = await boundedCommand(boundBinaryPath, [
            "identify", "--socket", paths.socketPath, "--json",
          ], Math.min(2_000, Math.max(1, deadline - Date.now())));
          if (probe.code !== 0) throw new Error(probe.stderr.trim() || `identify exited ${probe.code}`);
          const identity = JSON.parse(probe.stdout) as Record<string, unknown>;
          if (identity.protocol !== CMUX_PROTOCOL_VERSION)
            throw new CmuxRuntimeError(
              "protocolMismatch",
              `cmux identify reported protocol ${String(identity.protocol)}, expected ${CMUX_PROTOCOL_VERSION}`,
            );
          if (identity.pid !== child.pid)
            throw new CmuxRuntimeError("protocolMismatch", "cmux identify pid does not match supervised child");
          identified = true;
          break;
        } catch (error) {
          if (error instanceof CmuxRuntimeError && error.code === "protocolMismatch") throw error;
          lastProbeError = error;
        }
      }
      await delay(25);
    }
    if (!identified)
      throw new CmuxRuntimeError("startFailed", "cmux did not become ready before timeout", { cause: lastProbeError });

    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        if (exitResult && !exitExpected)
          throw new CmuxRuntimeError(
            "stopFailed",
            "cmux exited unexpectedly; writer lock retained until external fencing is proven",
          );
        const tracked = new Set([...containedProcessIds(paths), ...descendantProcessIds(child!.pid!)]);
        expected = true;
        signalProcessGroup(child!, "SIGTERM");
        signalContainedProcesses(tracked, "SIGTERM");
        let [leaderStopped, containmentStopped] = await Promise.all([
          waitForProcessExit(child!.pid!, stopTimeoutMs),
          waitForContainmentExit(paths, tracked, stopTimeoutMs),
        ]);
        if (!leaderStopped || !containmentStopped) {
          const current = new Set([...containedProcessIds(paths), ...[...tracked].filter(processAlive)]);
          for (const pid of current) tracked.add(pid);
          if (processAlive(child!.pid!)) signalProcessGroup(child!, "SIGKILL");
          signalContainedProcesses(current, "SIGKILL");
          [leaderStopped, containmentStopped] = await Promise.all([
            waitForProcessExit(child!.pid!, stopTimeoutMs),
            waitForContainmentExit(paths, tracked, stopTimeoutMs),
          ]);
        }
        if (leaderStopped) await rawExit;
        if (!leaderStopped || !containmentStopped)
          throw new CmuxRuntimeError("stopFailed", "cmux containment did not terminate; writer lock retained");
        await releaseWriterLease(lease);
        await rm(paths.socketPath, { force: true });
      })();
      return stopPromise;
    };

    return {
      pid: child.pid,
      runtimeId,
      generation,
      socketPath: paths.socketPath,
      stateDirectory: resolve(config.stateDirectory),
      exited,
      diagnostics: () => Object.freeze({ stdout, stderr }),
      stop,
    };
  } catch (error) {
    if (child?.pid !== undefined) {
      const tracked = new Set([...containedProcessIds(paths), ...descendantProcessIds(child.pid)]);
      try {
        signalProcessGroup(child, "SIGKILL");
        signalContainedProcesses(tracked, "SIGKILL");
      } catch { /* retain lock unless complete containment exit is observed below */ }
      const [leaderStopped, containmentStopped] = await Promise.all([
        waitForProcessExit(child.pid, stopTimeoutMs),
        waitForContainmentExit(paths, tracked, stopTimeoutMs),
      ]);
      if (leaderStopped && childExited) await childExited;
      if (!leaderStopped || !containmentStopped)
        throw new CmuxRuntimeError("startFailed", "cmux startup failed and fencing is uncertain; writer lock retained", { cause: error });
    }
    await releaseWriterLease(lease).catch(releaseError => {
      throw new CmuxRuntimeError("startFailed", "cmux startup failed and writer lock release failed", { cause: releaseError });
    });
    if (error instanceof CmuxRuntimeError) throw error;
    throw new CmuxRuntimeError("startFailed", "cmux startup failed", { cause: error });
  }
}
