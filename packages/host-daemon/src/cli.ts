#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  createAppserver,
  createHostLogger,
  createRemoteAppserver,
  OfficialOmpProfileAuthority,
  OmpSettingsAuthority,
  OmpAuthorityBridgeClient,
  profileSocketPath,
  FilesAuthority,
  ProjectFileSearchAuthority,
  PtyTerminalAuthority,
  RpcChildRegistry,
  SeedingTestControl,
  TranscriptSearchIndex,
  type AppserverHandle,
  type AppserverOptions,
  type DesktopOperationsAuthority,
  type HostLogger,
  type SessionAuthority,
  type SessionDiscovery,
} from "@t4-code/host-service";
import { COMMAND_DESCRIPTORS, type ProjectId, type SessionId } from "@t4-code/protocol";
import { parsePairArgs, runPairAction } from "./pair.ts";

export const T4_HOST_VERSION = "0.2.1";
// Stock OMP runtime gate. The host never assumes a build: versions proven by
// the compatibility gates (compat/official-omp-gate0.json) are accepted
// silently; newer versions inside the supported window are accepted with an
// advisory warning; anything outside the window fails with an actionable
// message. OMP_T4_STRICT_RUNTIME=1 (for packaged builds that ship the exact
// runtime) keeps the byte-exact pin.
export const OFFICIAL_OMP_VERSION = "17.0.9";
export const OFFICIAL_OMP_BUILD = "639bac596d94b5993349f3f6696176cb2bf9b5d3";
export const OFFICIAL_OMP_MIN_VERSION = "17.0.9";
export const OFFICIAL_OMP_MAX_MAJOR = 17;

export interface OfficialOmpMatrixRow {
  /** Exact stock OMP version that passed the behavior gates. */
  readonly version: string;
  /** Commit the gates ran against (compat/official-omp-gate0.json runtime). */
  readonly build: string;
  /** RPC dialect the host dispatches on (server.ts #rpcDialect branches). */
  readonly dialect: "fork" | "official-17.0.9";
  /** The compat gate file that proves this row. */
  readonly gates: string;
  readonly platforms: readonly string[];
}

// Keep in sync with compat/official-omp-gate0.json. When a new stock OMP
// version passes the maintainer gates, append a row here — the window widens
// with a data change, not a host code change.
const OFFICIAL_OMP_MATRIX: readonly OfficialOmpMatrixRow[] = Object.freeze([
  Object.freeze({
    version: OFFICIAL_OMP_VERSION,
    build: OFFICIAL_OMP_BUILD,
    dialect: "official-17.0.9" as const,
    gates: "official-omp-gate0",
    platforms: Object.freeze(["darwin-arm64", "linux-x64", "linux-arm64"]),
  }),
]);
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ORIGIN_LIMIT = 32;
const VERSION_OUTPUT_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 5_000;

export function officialOmpRootFromSessionsRoot(sessionsRoot: string): string {
  const parent = dirname(sessionsRoot);
  return basename(parent) === "agent" ? dirname(parent) : parent;
}
const OFFICIAL_CATALOG_COMMANDS = Object.freeze([
  "session.create",
  "session.rename",
  "session.archive",
  "session.restore",
  "session.delete",
  "session.model.set",
  "session.thinking.set",
  "session.cancel",
  "session.close",
  "session.release",
  "session.reclaim",
  "term.open",
]);

function officialCatalogItems(): Record<string, unknown>[] {
  const commands = process.platform === "darwin"
    ? ["project.reveal", ...OFFICIAL_CATALOG_COMMANDS]
    : OFFICIAL_CATALOG_COMMANDS;
  return commands.map(name => ({
    id: `cmd-${name.replaceAll(".", "-")}`,
    kind: "command",
    name,
    capabilities: [COMMAND_DESCRIPTORS[name]!.capability],
    supported: true,
  }));
}

export interface HostDaemonConfig {
  readonly ompExecutable: string;
  readonly authorityMode?: "bridge" | "official";
  readonly ompSessionsRoot?: string;
  readonly profileId: string;
  readonly stateRoot: string;
  /** Local-only deterministic seeding for integration runs. Never enabled by default. */
  readonly testControl?: boolean;
  readonly remote?: {
    readonly mode: "direct" | "serve";
    readonly address: string;
    readonly port: number;
    readonly origins: readonly string[];
    readonly trustedServeProxy: boolean;
    readonly tlsPort?: number;
  };
}

export interface HostDaemonPaths {
  readonly profileStateRoot: string;
  readonly hostIdPath: string;
  readonly attentionOutcomePath: string;
  readonly sessionOwnershipPath: string;
  readonly transcriptSearchPath: string;
  readonly officialMetadataPath: string;
  readonly testControlManifestPath: string;
  readonly remoteStateRoot: string;
  readonly socketPath: string;
}

function value(argv: readonly string[], index: number, flag: string): string {
  const result = argv[index + 1];
  if (!result || result.startsWith("--")) throw new Error(`${flag} requires a value`);
  return result;
}

function boundedOrigin(input: string): string {
  const url = new URL(input);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "--remote-origin must be an HTTP origin without credentials, path, query, or fragment",
    );
  return url.origin;
}

/**
 * The appserver bounds this token to 32-256 bytes and refuses to expose the
 * control routes without it, so a missing or short token must fail startup
 * rather than silently serve an unauthenticated surface.
 */
function requiredTestControlToken(): string {
  const token = process.env.OMP_APP_TEST_TOKEN ?? "";
  if (Buffer.byteLength(token, "utf8") < 32)
    throw new Error("--test-control requires OMP_APP_TEST_TOKEN of at least 32 bytes");
  return token;
}

export function parseHostDaemonArgs(argv: readonly string[], home = homedir()): HostDaemonConfig {
  if (argv[0] !== "serve") throw new Error("t4-host requires the serve action");
  let ompExecutable: string | undefined;
  let authorityMode: "bridge" | "official" = "bridge";
  let ompSessionsRoot: string | undefined;
  let profileId = "default";
  let stateRoot = join(home, ".t4-code", "host");
  let remoteMode: "direct" | "serve" | undefined;
  let remoteAddress: string | undefined;
  let remotePort = 8787;
  let remoteTlsPort: number | undefined;
  let trustedServeProxy = false;
  let testControl = false;
  const origins: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (flag === "--omp") ompExecutable = value(argv, index++, flag);
    else if (flag === "--omp-authority") {
      const mode = value(argv, index++, flag);
      if (mode !== "bridge" && mode !== "official")
        throw new Error("--omp-authority must be bridge or official");
      authorityMode = mode;
    } else if (flag === "--omp-sessions-root") ompSessionsRoot = value(argv, index++, flag);
    else if (flag === "--profile") profileId = value(argv, index++, flag);
    else if (flag === "--state-root") stateRoot = value(argv, index++, flag);
    else if (flag === "--remote-mode") {
      const mode = value(argv, index++, flag);
      if (mode !== "direct" && mode !== "serve")
        throw new Error("--remote-mode must be direct or serve");
      remoteMode = mode;
    } else if (flag === "--remote-address") remoteAddress = value(argv, index++, flag);
    else if (flag === "--remote-port") {
      remotePort = Number(value(argv, index++, flag));
      if (!Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65_535)
        throw new Error("--remote-port must be between 1 and 65535");
    } else if (flag === "--remote-tls-port") {
      remoteTlsPort = Number(value(argv, index++, flag));
      if (!Number.isSafeInteger(remoteTlsPort) || remoteTlsPort < 1 || remoteTlsPort > 65_535)
        throw new Error("--remote-tls-port must be between 1 and 65535");
    } else if (flag === "--remote-origin") {
      if (origins.length >= ORIGIN_LIMIT) throw new Error("too many --remote-origin values");
      origins.push(boundedOrigin(value(argv, index++, flag)));
    } else if (flag === "--trusted-serve-proxy") trustedServeProxy = true;
    else if (flag === "--test-control") testControl = true;
    else throw new Error(`unsupported t4-host argument: ${flag}`);
  }
  if (!ompExecutable || !isAbsolute(ompExecutable))
    throw new Error("--omp must name an absolute executable path");
  if (!PROFILE.test(profileId)) throw new Error("--profile is invalid");
  if (!isAbsolute(stateRoot)) throw new Error("--state-root must be absolute");
  if (authorityMode === "official" && (!ompSessionsRoot || !isAbsolute(ompSessionsRoot)))
    throw new Error("official OMP authority requires an absolute --omp-sessions-root");
  if (authorityMode === "bridge" && ompSessionsRoot)
    throw new Error("--omp-sessions-root requires official OMP authority");
  if (!remoteMode && (remoteAddress || origins.length || trustedServeProxy || remotePort !== 8787 || remoteTlsPort !== undefined))
    throw new Error("remote flags require --remote-mode");
  if (remoteMode && !remoteAddress) throw new Error("remote mode requires --remote-address");
  if (remoteMode === "serve" && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")
    throw new Error("serve mode requires a loopback address");
  if (remoteMode === "serve" && !trustedServeProxy)
    throw new Error("serve mode requires --trusted-serve-proxy");
  if (remoteMode === "serve" && remoteTlsPort !== undefined)
    throw new Error("--remote-tls-port is direct-mode only");
  if (remoteTlsPort === remotePort) throw new Error("--remote-tls-port must differ from --remote-port");
  if (remoteMode === "direct" && trustedServeProxy)
    throw new Error("trusted Serve proxy is invalid in direct mode");
  if (testControl) {
    // Seeding writes disposable sessions into the profile it serves, so it must
    // never reach the default profile a person actually works in, and it must
    // never be reachable from a remote listener.
    if (process.env.OMP_APP_TEST_MODE !== "1")
      throw new Error("--test-control requires OMP_APP_TEST_MODE=1");
    if (profileId === "default") throw new Error("--test-control refuses the default profile");
    if (remoteMode) throw new Error("--test-control is local-only");
  }
  return {
    ompExecutable: resolve(ompExecutable),
    authorityMode,
    ...(ompSessionsRoot ? { ompSessionsRoot: resolve(ompSessionsRoot) } : {}),
    profileId,
    stateRoot: resolve(stateRoot),
    ...(testControl ? { testControl: true } : {}),
    ...(remoteMode
      ? {
          remote: {
            mode: remoteMode,
            address: remoteAddress!,
            port: remotePort,
            origins,
            trustedServeProxy,
            ...(remoteTlsPort !== undefined ? { tlsPort: remoteTlsPort } : {}),
          },
        }
      : {}),
  };
}

export function hostDaemonPaths(
  config: Pick<HostDaemonConfig, "profileId" | "stateRoot">,
): HostDaemonPaths {
  const profileKey = createHash("sha256")
    .update(config.profileId, "utf8")
    .digest("hex")
    .slice(0, 24);
  const profileStateRoot = join(config.stateRoot, "profiles", profileKey);
  return {
    profileStateRoot,
    hostIdPath: join(profileStateRoot, "host-id"),
    attentionOutcomePath: join(profileStateRoot, "attention-outcomes.json"),
    sessionOwnershipPath: join(profileStateRoot, "owned-sessions.json"),
    transcriptSearchPath: join(profileStateRoot, "transcript-search.sqlite"),
    officialMetadataPath: join(profileStateRoot, "official-omp-sessions.json"),
    testControlManifestPath: join(profileStateRoot, "test-control-manifest.json"),
    remoteStateRoot: join(profileStateRoot, "remote"),
    socketPath: profileSocketPath(config.profileId),
  };
}

export interface HostDaemonDependencies {
  readonly createBridge?: (config: HostDaemonConfig) => OmpAuthorityBridgeClient;
  readonly createOfficialAuthority?: (
    config: HostDaemonConfig,
    paths: HostDaemonPaths,
  ) => OfficialOmpProfileAuthority;
  readonly createTranscriptSearch?: (path: string) => TranscriptSearchIndex;
  readonly createLocal?: (options: AppserverOptions) => AppserverHandle;
  readonly createRemote?: typeof createRemoteAppserver;
  readonly verifyOfficialRuntime?: (
    executable: string,
  ) => Promise<
    Pick<AppserverOptions, "ompVersion" | "ompBuild"> & {
      readonly dialect?: OfficialOmpMatrixRow["dialect"];
      readonly warning?: string;
    }
  >;
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  /** Structured host logger for boot reaping and appserver events; constructed from profileStateRoot when omitted. */
  readonly loggerHost?: HostLogger;
}

/**
 * Load or generate the self-signed cert a wss listener serves. Persisted per
 * profile so the fingerprint clients pin (TOFU) survives restarts. RSA rather
 * than ECDSA: Bun's BoringSSL rejected LibreSSL-written EC keys at startup.
 */
async function ensureSelfSignedCert(
  dir: string,
  commonName: string,
): Promise<{ cert: string; key: string; fingerprint: string }> {
  const certPath = join(dir, "wss-cert.pem");
  const keyPath = join(dir, "wss-key.pem");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = await Promise.all([
    readFile(certPath, "utf8").catch(() => undefined),
    readFile(keyPath, "utf8").catch(() => undefined),
  ]);
  if (existing[0] && existing[1])
    return { cert: existing[0], key: existing[1], fingerprint: certFingerprint(existing[0]) };
  const child = Bun.spawn(
    [
      "/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048",
      "-nodes", "-days", "3650", "-subj", `/CN=${commonName}`,
      "-keyout", keyPath, "-out", certPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const stderr = child.stderr ? await boundedProcessOutput(child.stderr, 4096) : "";
  if ((await child.exited) !== 0) throw new Error(`openssl cert generation failed: ${stderr.trim()}`);
  await chmod(keyPath, 0o600);
  const cert = await readFile(certPath, "utf8");
  const key = await readFile(keyPath, "utf8");
  return { cert, key, fingerprint: certFingerprint(cert) };
}

/** sha256 of the certificate DER, hex — the value clients pin. */
function certFingerprint(pem: string): string {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return createHash("sha256").update(Buffer.from(body, "base64")).digest("hex");
}

async function boundedProcessOutput(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("official OMP version output exceeds 4 KiB");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(output);
}

const OMP_VERSION_PATTERN = /^omp\/(\d+)\.(\d+)\.(\d+)(?:-([0-9a-f]+))?$/u;

/** Numeric component-wise compare for `major.minor.patch` strings. */
function compareOmpVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export type OfficialRuntimeAssessment =
  | {
      readonly decision: "known-good";
      readonly version: string;
      readonly build: string;
      readonly dialect: OfficialOmpMatrixRow["dialect"];
    }
  | {
      readonly decision: "compatible";
      readonly version: string;
      readonly build?: string;
      readonly dialect: OfficialOmpMatrixRow["dialect"];
      readonly warning: string;
    }
  | { readonly decision: "too-old" | "unsupported" | "unparseable"; readonly reason: string };

/**
 * Decide whether a stock OMP version may serve official authority. Pure:
 * no process, no env reads beyond the strict flag — unit-testable without
 * spawning. The host accepts what the compatibility matrix proves and what
 * falls inside the supported window; it refuses only old or unparsable
 * runtimes (and, under OMP_T4_STRICT_RUNTIME, anything outside the matrix).
 */
export function assessOfficialRuntime(
  versionText: string,
  strict = process.env.OMP_T4_STRICT_RUNTIME === "1",
): OfficialRuntimeAssessment {
  const match = OMP_VERSION_PATTERN.exec(versionText.trim());
  if (match === null) {
    return {
      decision: "unparseable",
      reason: `OMP version probe is not omp/<major>.<minor>.<patch>: ${JSON.stringify(versionText.trim())}`,
    };
  }
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  const build = match[4];
  const known = OFFICIAL_OMP_MATRIX.find(
    row => row.version === version && (build === undefined || row.build === build),
  );
  if (known) {
    return { decision: "known-good", version, build: known.build, dialect: known.dialect };
  }
  if (strict) {
    return {
      decision: "unsupported",
      reason:
        `strict runtime mode accepts only the gate-proven builds ` +
        `(${OFFICIAL_OMP_MATRIX.map(row => `${row.version} (${row.build})`).join(", ")}); ` +
        `found omp/${version}${build ? `-${build}` : ""}`,
    };
  }
  const newest = OFFICIAL_OMP_MATRIX[0];
  if (newest === undefined) {
    return { decision: "unsupported", reason: "no gate-proven OMP runtime rows are configured" };
  }
  if (
    Number(match[1]) > OFFICIAL_OMP_MAX_MAJOR ||
    compareOmpVersions(version, OFFICIAL_OMP_MIN_VERSION) < 0
  ) {
    return {
      decision: "too-old",
      reason:
        `OMP ${version} is outside the supported window ` +
        `(${OFFICIAL_OMP_MIN_VERSION}..${OFFICIAL_OMP_MAX_MAJOR}.x); upgrade OMP or ` +
        `point --omp at a gate-proven runtime (${newest.version})`,
    };
  }
  return {
    decision: "compatible",
    version,
    ...(build === undefined ? {} : { build }),
    dialect: newest.dialect,
    warning:
      `OMP ${version} is newer than the gate-proven ${newest.version} (${newest.gates}); ` +
      `behavior gates have not run against it — proceeding with the ${newest.dialect} dialect`,
  };
}

export async function verifyOfficialRuntime(
  executable: string,
): Promise<
  Pick<AppserverOptions, "ompVersion" | "ompBuild"> & {
    readonly dialect: OfficialOmpMatrixRow["dialect"];
    readonly warning?: string;
  }
> {
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Isolated env (deterministic probe), except PATH: the stock OMP on
    // Linux ships as a `#!/usr/bin/env bun` script, so a probe with no PATH
    // dies with exit 126 before printing anything. --version is read-only;
    // the ambient-executable boundary (cli.test.ts "without ambient
    // executable lookup") governs which runtime RUNS, not the probe.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedProcessOutput(child.stdout, VERSION_OUTPUT_BYTES),
      boundedProcessOutput(child.stderr, VERSION_OUTPUT_BYTES),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`official OMP version probe failed (${exitCode}): ${stderr.trim()}`);
    const assessment = assessOfficialRuntime(stdout);
    switch (assessment.decision) {
      case "known-good":
        return {
          ompVersion: assessment.version,
          ompBuild: assessment.build,
          dialect: assessment.dialect,
        };
      case "compatible":
        return {
          ompVersion: assessment.version,
          ompBuild: assessment.build ?? OFFICIAL_OMP_BUILD,
          dialect: assessment.dialect,
          warning: assessment.warning,
        };
      case "too-old":
      case "unsupported":
      case "unparseable":
        throw new Error(assessment.reason);
    }
    throw new Error("unreachable: unhandled official runtime assessment");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}

export async function runHostDaemon(
  config: HostDaemonConfig,
  dependencies: HostDaemonDependencies = {},
): Promise<void> {
  const paths = hostDaemonPaths(config);
  await mkdir(paths.profileStateRoot, { recursive: true, mode: 0o700 });
  // One structured logger backs boot reaping and the appserver's
  // connection/pair/denied/supervisor/watchdog event log. It writes NDJSON to
  // <profileStateRoot>/logs/host-<date>.ndjson with size-based rotation.
  const hostLogger = dependencies.loggerHost ?? createHostLogger({ stateRoot: paths.profileStateRoot });
  const rpcChildRegistryPath = join(paths.profileStateRoot, "rpc-children.json");
  const reaped = new RpcChildRegistry(rpcChildRegistryPath).reap();
  for (const pid of reaped.killed)
    hostLogger.log("supervisor.killed", { pid, reason: "identity-verified orphan reaped at boot" });
  for (const pid of reaped.skipped)
    hostLogger.log("reap.skip", { pid, reason: "rpc child was not safe to reap", level: "warn" });
  let bridge: OmpAuthorityBridgeClient | undefined;
  let terminals: PtyTerminalAuthority | undefined;
  let officialAuthority: OfficialOmpProfileAuthority | undefined;
  let sessionAuthority: SessionAuthority;
  let discovery: SessionDiscovery;
  let operationsAuthority: DesktopOperationsAuthority = {};
  let usageAuthority: AppserverOptions["usageAuthority"];
  let transcriptImageRoot: string | undefined;
  let identity: Pick<AppserverOptions, "ompVersion" | "ompBuild"> = {};
  let officialDialect: OfficialOmpMatrixRow["dialect"] | undefined;
  let projectRootForProject: (projectId: ProjectId) => Promise<string> | string;
  let projectRootForSession: (sessionId: SessionId) => Promise<string>;
  let lockCheck: NonNullable<AppserverOptions["lockCheck"]>;
  let lockStatus: NonNullable<AppserverOptions["lockStatus"]>;
  if (config.authorityMode === "official") {
    const verified = await (dependencies.verifyOfficialRuntime ?? verifyOfficialRuntime)(config.ompExecutable);
    identity = { ompVersion: verified.ompVersion, ompBuild: verified.ompBuild };
    officialDialect = verified.dialect ?? "official-17.0.9";
    if (verified.warning !== undefined) {
      hostLogger.log("runtime.advisory", {
        ompVersion: verified.ompVersion,
        warning: verified.warning,
      });
    }
    const official =
      dependencies.createOfficialAuthority?.(config, paths) ??
      new OfficialOmpProfileAuthority({
        sessionsRoot: config.ompSessionsRoot!,
        metadataPath: paths.officialMetadataPath,
      });
    await official.initialize();
    officialAuthority = official;
    sessionAuthority = official;
    discovery = official;
    // T4 owns terminals in official mode: stock OMP has no host-side pty seam.
    // Bridge mode keeps using the fork's termOpen until the runtimes converge.
    terminals = new PtyTerminalAuthority({
      projectRootForSession: sessionId => official.projectRootForSession(sessionId),
    });
    operationsAuthority = {
      catalogGet: async () => ({
        revision: `official-omp-${OFFICIAL_OMP_VERSION}`,
        items: officialCatalogItems(),
      }),
      ...terminals.operations(),
      ...new OmpSettingsAuthority({
        ompRoot: officialOmpRootFromSessionsRoot(config.ompSessionsRoot!),
      }).operations(),
    };
    projectRootForProject = projectId => official.projectRootForProject(projectId);
    projectRootForSession = sessionId => official.projectRootForSession(sessionId);
    lockCheck = session => official.lockCheck(session);
    lockStatus = () => official.lockStatus();
  } else {
    bridge =
      dependencies.createBridge?.(config) ??
      new OmpAuthorityBridgeClient({
        executable: config.ompExecutable,
        environment: { OMP_PROFILE: config.profileId },
      });
    try {
      await bridge.start();
      const authorities = bridge.createAuthorities();
      const hostInfo = await authorities.hostInfo();
      sessionAuthority = authorities.sessionAuthority;
      discovery = authorities.discovery;
      operationsAuthority = authorities.operationsAuthority;
      usageAuthority = authorities.usageAuthority;
      transcriptImageRoot = hostInfo.transcriptImageRoot;
      identity = bridge.identity;
      projectRootForProject = authorities.projectRootForProject;
      projectRootForSession = authorities.projectRootForSession;
      lockCheck = authorities.lockCheck;
      lockStatus = authorities.lockStatus;
    } catch (error) {
      await bridge.stop();
      throw error;
    }
  }
  try {
    const transcriptSearchAuthority =
      dependencies.createTranscriptSearch?.(paths.transcriptSearchPath) ??
      new TranscriptSearchIndex(paths.transcriptSearchPath);
    const projectFileSearchAuthority = new ProjectFileSearchAuthority(
      projectRootForSession,
    );
    const filesAuthority = new FilesAuthority({ projectRootForSession });
    const filesOperations = filesAuthority.operations();
    const turnSnapshotFilesDiff = operationsAuthority.filesDiff;
    const testControl = config.testControl
      ? new SeedingTestControl({
          token: requiredTestControlToken(),
          profile: config.profileId,
          manifestPath: paths.testControlManifestPath,
          authority: sessionAuthority,
          lockStatus,
        })
      : undefined;
    const options: AppserverOptions = {
      ...identity,
      appserverVersion: T4_HOST_VERSION,
      appserverBuild: process.env.T4_HOST_BUILD?.slice(0, 128) || "source",
      socketPath: paths.socketPath,
      hostIdPath: paths.hostIdPath,
      attentionOutcomePath: paths.attentionOutcomePath,
      sessionOwnershipPath: paths.sessionOwnershipPath,
      sessionAuthority,
      discovery,
      logger: hostLogger,
      operationsAuthority: {
        ...operationsAuthority,
        ...projectFileSearchAuthority.operations(),
        // The bridge owns immutable turn-review snapshots. Ordinary
        // working-tree diffs stay with the T4-owned authority so they use the
        // same resolved session cwd as files.list/read and do not depend on a
        // fork-specific bridge response.
        ...(operationsAuthority.filesList ? {} : { filesList: filesOperations.filesList }),
        ...(operationsAuthority.filesRead ? {} : { filesRead: filesOperations.filesRead }),
        filesDiff: (args, context) =>
          args.turnId !== undefined && turnSnapshotFilesDiff
            ? turnSnapshotFilesDiff(args, context)
            : filesAuthority.filesDiff(args, context),
      },
      ...(usageAuthority ? { usageAuthority } : {}),
      transcriptSearchAuthority,
      projectRootForProject,
      lockCheck,
      lockStatus,
      ...(testControl ? { testControl } : {}),
      ...(config.authorityMode === "official" ? { claimLocklessSessions: true } : {}),
      ...(config.authorityMode === "official" ? { observerIndependentTerminalOperations: true } : {}),
      ...(transcriptImageRoot ? { transcriptImageRoot } : {}),
      rpcChildInvocation: { executable: config.ompExecutable, prefixArgv: [] },
      rpcChildEnvironment: { OMP_PROFILE: config.profileId },
      rpcChildRegistryPath,
      ...(config.authorityMode === "official"
        ? { rpcDialect: officialDialect ?? ("official-17.0.9" as const) }
        : {}),
      ...(process.platform === "darwin"
        ? {
            projectRevealer: async (root: string): Promise<boolean> => {
              const child = Bun.spawn(["/usr/bin/open", "-R", root], {
                stdout: "ignore",
                stderr: "ignore",
              });
              return (await child.exited) === 0;
            },
          }
        : {}),
      previewAuthority: { enabled: true },
    };
    let appserver: AppserverHandle;
    try {
      const tlsMaterial = config.remote?.tlsPort
        ? await ensureSelfSignedCert(join(paths.remoteStateRoot, "tls"), config.remote.address)
        : undefined;
      if (tlsMaterial)
        hostLogger.log("remote.tls", { fingerprint: tlsMaterial.fingerprint });
      appserver = config.remote
        ? await (dependencies.createRemote ?? createRemoteAppserver)({
            stateDir: paths.remoteStateRoot,
            remoteEndpoint: {
              address: config.remote.address,
              port: config.remote.port,
              originAllowlist: config.remote.origins,
              serveProxy: config.remote.mode === "serve",
              trustedServeProxy: config.remote.trustedServeProxy,
            },
            ...(tlsMaterial && config.remote.tlsPort
              ? {
                  remoteEndpointTls: {
                    address: config.remote.address,
                    port: config.remote.tlsPort,
                    originAllowlist: config.remote.origins,
                    tls: { cert: tlsMaterial.cert, key: tlsMaterial.key },
                    tlsFingerprint: tlsMaterial.fingerprint,
                  },
                }
              : {}),
            appserver: options,
          })
        : (dependencies.createLocal ?? createAppserver)(options);
    } catch (error) {
      await Promise.resolve(transcriptSearchAuthority.close()).catch(() => undefined);
      throw error;
    }
    const stopped = Promise.withResolvers<void>();
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void appserver.stop().then(stopped.resolve, stopped.reject);
    };
    const onSignal = dependencies.onSignal ?? ((signal, listener) => process.on(signal, listener));
    const removeSignal =
      dependencies.removeSignal ?? ((signal, listener) => process.off(signal, listener));
    onSignal("SIGINT", stop);
    onSignal("SIGTERM", stop);
    try {
      await appserver.start();
      await stopped.promise;
    } finally {
      removeSignal("SIGINT", stop);
      removeSignal("SIGTERM", stop);
      if (!stopping) await appserver.stop().catch(() => undefined);
    }
  } finally {
    terminals?.closeAll();
    await bridge?.stop();
    await officialAuthority?.close();
    // Flush queued log writes (rotation + appserver events) before exit. The
    // injected logger is owned by the caller; only close one we constructed.
    if (!dependencies.loggerHost) await hostLogger.close();
  }
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "pair") {
      await runPairAction(parsePairArgs(argv.slice(1)));
    } else {
      await runHostDaemon(parseHostDaemonArgs(argv));
    }
  } catch (error) {
    process.stderr.write(
      `t4-host error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
