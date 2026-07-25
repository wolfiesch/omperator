import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeProcessRunner, runProcess, type ProcessRunner } from "@t4-code/remote";
import {
  LinuxSystemdUserManager,
  MacLaunchAgentManager,
  NodeServiceFileSystem,
  type ServiceFileSystem,
  type ServiceInspection,
  type ServiceManager,
  type ServiceRunner,
  type ServiceRunnerResult,
  type ServiceSpec,
} from "@t4-code/service-manager";
import { decodeLocalProfileId } from "@t4-code/protocol/desktop-ipc";
export { NodeServiceFileSystem };

export const SERVICE_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "TMPDIR",
] as const;

export type ServiceEnvironmentKey = (typeof SERVICE_ENVIRONMENT_KEYS)[number];

export function createSafeServiceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const key of SERVICE_ENVIRONMENT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(environment, key)) continue;
    const value = environment[key];
    if (value !== undefined) safeEnvironment[key] = value;
  }
  return safeEnvironment;
}

// Cold OMP startup can exceed 1.5 seconds on macOS. A shorter deadline can
// reject the verified runtime before it returns a healthy status response.
const APP_SERVER_PROBE_TIMEOUT_MS = 3_000;
const APP_SERVER_PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
const AUTHORITY_BRIDGE_HELP_MARKERS = [
  "Expose the private OMP authority bridge used by T4 Code",
  "--stdio",
] as const;

export class OmpAppserverCompatibilityError extends Error {
  readonly code = "omp_authority_bridge_required" as const;

  constructor() {
    super(
      "Installed OMP is incompatible with this T4 Code build. T4 Code requires the versioned `omp bridge --stdio` authority bridge. Update OMP, then choose Check again.",
    );
    this.name = "OmpAppserverCompatibilityError";
    Object.defineProperty(this, "stack", {
      value: undefined,
      enumerable: false,
      configurable: true,
    });
  }
}

export interface OmpExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly runner?: ProcessRunner;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface T4HostExecutableDiscoveryOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly packagedExecutable?: string;
}

export interface OmpAppserverProbeOptions extends Omit<
  OmpExecutableDiscoveryOptions,
  "homeDirectory"
> {
  readonly profileId?: string;
}

export type PathOmpCompatibility =
  | "compatible"
  | "incompatible"
  | "missing"
  | "mixed"
  | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAppserverStatus(value: unknown): boolean {
  if (!isRecord(value) || (value.state !== "running" && value.state !== "stopped")) return false;
  if (value.state === "running") {
    if (!isRecord(value.health) || value.health.ok !== true) return false;
    return (
      typeof value.health.hostId === "string" &&
      value.health.hostId.length > 0 &&
      typeof value.health.epoch === "string" &&
      value.health.epoch.length > 0
    );
  }
  return (
    value.reason === "unreachable" || value.reason === "malformed" || value.reason === "failed"
  );
}

type AppserverProbeState = "running" | "stopped" | "incompatible" | false;
async function probesAuthorityBridgeCommand(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<boolean> {
  try {
    const result = await runProcess({
      runner,
      command: executable,
      args: ["bridge", "--help"],
      env: createSafeServiceEnvironment(environment),
      timeoutMs,
    });
    const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
    return (
      result.exitCode === 0 &&
      !result.stdoutTruncated &&
      !result.stderrTruncated &&
      stderrBytes === 0 &&
      stdoutBytes <= maxOutputBytes &&
      AUTHORITY_BRIDGE_HELP_MARKERS.every((marker) => result.stdout.includes(marker))
    );
  } catch {
    return false;
  }
}

async function probesAppserverStatus(
  executable: string,
  environment: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  timeoutMs: number,
  maxOutputBytes: number,
  profileId = "default",
): Promise<AppserverProbeState> {
  try {
    const result = await runProcess({
      runner,
      command: executable,
      args: ["appserver", "status", "--json"],
      env: {
        ...createSafeServiceEnvironment(environment),
        ...(decodeLocalProfileId(profileId) === "default" ? {} : { OMP_PROFILE: profileId }),
      },
      timeoutMs,
    });
    const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
    const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      stdoutBytes > maxOutputBytes ||
      stderrBytes > maxOutputBytes ||
      stdoutBytes + stderrBytes > maxOutputBytes
    )
      return false;
    const diagnosticOutput = `${result.stdout}\n${result.stderr}`;
    if (
      /(?:unknown|unrecognized)\s+(?:flag|option)\s*:?\s*--json\b/iu.test(diagnosticOutput) ||
      /flag provided but not defined\s*:\s*-json\b/iu.test(diagnosticOutput)
    )
      return "incompatible";
    if ((result.exitCode !== 0 && result.exitCode !== 1) || result.stderr.trim().length > 0)
      return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return false;
    }
    if (!isAppserverStatus(parsed) || !isRecord(parsed)) return false;
    return parsed.state === "running" ? "running" : "stopped";
  } catch {
    return false;
  }
}

export async function discoverOmpExecutable(
  options: OmpExecutableDiscoveryOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? APP_SERVER_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? APP_SERVER_PROBE_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return undefined;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024)
    return undefined;
  const candidates: string[] = [];
  const explicit = environment.OMP_EXECUTABLE;
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);
  const pathEntries = (environment.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0)
    .slice(0, 64);
  for (const entry of pathEntries) candidates.push(join(entry, "omp"));
  for (const entry of [
    join(home, ".local", "bin", "omp"),
    join(home, "bin", "omp"),
    "/usr/local/bin/omp",
    "/usr/bin/omp",
    "/opt/omp/bin/omp",
  ])
    candidates.push(entry);
  const seen = new Set<string>();
  let incompatible = false;
  for (const candidate of candidates.slice(0, 80)) {
    if (
      seen.has(candidate) ||
      !candidate.startsWith("/") ||
      candidate.includes("\0") ||
      !candidate.endsWith("/omp")
    )
      continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const hasAuthorityBridge = await probesAuthorityBridgeCommand(
      candidate,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    );
    if (!hasAuthorityBridge) {
      incompatible = true;
      continue;
    }
    const state = await probesAppserverStatus(
      candidate,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    );
    if (state === "running" || state === "stopped") return candidate;
    if (state === "incompatible") incompatible = true;
  }
  if (incompatible) throw new OmpAppserverCompatibilityError();
  return undefined;
}

export async function discoverT4HostExecutable(
  options: T4HostExecutableDiscoveryOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? homedir();
  const candidates = [
    options.packagedExecutable,
    environment.T4_HOST_EXECUTABLE,
    ...(environment.PATH ?? "")
      .split(":")
      .filter(Boolean)
      .slice(0, 64)
      .map((entry) => join(entry, "t4-host")),
    join(home, ".local", "bin", "t4-host"),
    join(home, "bin", "t4-host"),
    "/usr/local/bin/t4-host",
    "/usr/bin/t4-host",
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (
      !candidate ||
      seen.has(candidate) ||
      !candidate.startsWith("/") ||
      candidate.includes("\0") ||
      !candidate.endsWith("/t4-host")
    )
      continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

/**
 * Check every `omp` command on PATH. T4 may have its own compatible bundled
 * runtime while another shell or app launch path selects an older build,
 * which makes cross-app activity look idle or arrive in chunks.
 */
export async function inspectPathOmpCompatibility(
  options: Omit<OmpExecutableDiscoveryOptions, "homeDirectory"> = {},
): Promise<PathOmpCompatibility> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? APP_SERVER_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? APP_SERVER_PROBE_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return "unavailable";
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 64 * 1024)
    return "unavailable";

  const entries = (environment.PATH ?? "")
    .split(":")
    .filter((entry) => entry.startsWith("/") && !entry.includes("\0"))
    .slice(0, 64);
  const seen = new Set<string>();
  let compatible = 0;
  let incompatible = 0;
  let unavailable = 0;
  for (const entry of entries) {
    const candidate = join(entry, "omp");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      await access(candidate, fsConstants.X_OK);
    } catch {
      continue;
    }
    const hasAuthorityBridge = await probesAuthorityBridgeCommand(
      candidate,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
    );
    if (!hasAuthorityBridge) {
      incompatible += 1;
      continue;
    }
    const state = await probesAppserverStatus(candidate, environment, runner, timeoutMs, maxOutputBytes);
    if (state === "running" || state === "stopped") compatible += 1;
    else if (state === "incompatible") incompatible += 1;
    else unavailable += 1;
  }
  if (compatible > 0 && (incompatible > 0 || unavailable > 0)) return "mixed";
  if (compatible > 0) return "compatible";
  if (incompatible > 0) return "incompatible";
  if (unavailable > 0) return "unavailable";
  return "missing";
}

export async function probeOmpAppserver(
  executable: string,
  options: OmpAppserverProbeOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? new NodeProcessRunner();
  const timeoutMs = options.timeoutMs ?? APP_SERVER_PROBE_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? APP_SERVER_PROBE_MAX_OUTPUT_BYTES;
  if (!executable.startsWith("/") || !executable.endsWith("/omp")) return false;
  try {
    await access(executable, fsConstants.X_OK);
  } catch {
    return false;
  }
  return (
    (await probesAppserverStatus(
      executable,
      environment,
      runner,
      timeoutMs,
      maxOutputBytes,
      options.profileId,
    )) === "running"
  );
}

export interface AppserverServiceRepairOptions {
  readonly attempts?: number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly retryDelayMs?: number;
}

/**
 * Reconcile a T4-owned appserver definition and its service registration.
 *
 * The first pass uses the smallest needed action. A second pass performs a
 * full install transaction, which safely replaces a stale LaunchAgent path
 * and recovers when launchd was still removing an older registration.
 */
export async function repairAppserverService(
  manager: ServiceManager,
  options: AppserverServiceRepairOptions = {},
): Promise<ServiceInspection> {
  const attempts = options.attempts ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 150;
  const delay = options.delay ?? (
    (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
  );
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3)
    throw new Error("invalid appserver service repair attempt count");
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 5_000)
    throw new Error("invalid appserver service repair delay");

  let inspection = await manager.inspect();
  if (
    inspection.definition === "current" &&
    (inspection.service === "running" || inspection.service === "starting")
  ) return inspection;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (attempt === 0 && inspection.definition === "current") await manager.start();
      else await manager.install();
      inspection = await manager.inspect();
      if (
        inspection.definition === "current" &&
        (inspection.service === "running" || inspection.service === "starting")
      ) return inspection;
      lastError = new Error(
        `appserver service repair did not start the service (${inspection.diagnostics.slice(0, 512)})`,
      );
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 >= attempts) break;
    await delay(retryDelayMs);
    inspection = await manager.inspect();
    if (
      inspection.definition === "current" &&
      (inspection.service === "running" || inspection.service === "starting")
    ) return inspection;
  }
  throw lastError ?? new Error("appserver service repair failed");
}
export interface NodeServiceRunnerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly runner?: ProcessRunner;
}

export class NodeServiceRunner implements ServiceRunner {
  private readonly runner: ProcessRunner;
  private readonly environment: NodeJS.ProcessEnv;

  constructor(options: NodeServiceRunnerOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.environment = createSafeServiceEnvironment(options.environment);
  }

  async run(argv: readonly string[]): Promise<ServiceRunnerResult> {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("service command is empty");
    const handle = await this.runner.spawn({ command, args, env: this.environment });
    const result = await handle.result;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }
}

export function createAppserverServiceManager(options: {
  readonly profileId?: string;
  readonly homeDirectory: string;
  readonly logsDirectory: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly fs: ServiceFileSystem;
  readonly runner?: ServiceRunner;
  readonly environment?: Readonly<Record<string, string>>;
  readonly serviceLabel?: string;
}): ServiceManager {
  const profileId = decodeLocalProfileId(options.profileId ?? "default");
  const spec: ServiceSpec = {
    profileId,
    executable: options.executable,
    argv: options.argv,
    logsDirectory: options.logsDirectory,
    // Pin both default and named services explicitly. A graphical/login service
    // manager can retain an imported OMP_PROFILE from an unrelated shell; an
    // omitted value would let that ambient profile silently hijack T4's
    // default appserver.
    environment: { ...options.environment, OMP_PROFILE: profileId },
  };
  const runner = options.runner ?? new NodeServiceRunner();
  if (process.platform === "darwin") {
    return new MacLaunchAgentManager(spec, {
      homeDirectory: options.homeDirectory,
      ...(options.serviceLabel === undefined ? {} : { label: options.serviceLabel }),
      uid: process.getuid?.() ?? 0,
      fs: options.fs,
      runner,
    });
  }
  return new LinuxSystemdUserManager(spec, {
    homeDirectory: options.homeDirectory,
    ...(options.serviceLabel === undefined ? {} : { label: options.serviceLabel }),
    fs: options.fs,
    runner,
  });
}
