#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  createAppserver,
  createRemoteAppserver,
  OfficialOmpProfileAuthority,
  OmpAuthorityBridgeClient,
  profileSocketPath,
  ProjectFileSearchAuthority,
  TranscriptSearchIndex,
  type AppserverHandle,
  type AppserverOptions,
  type DesktopOperationsAuthority,
  type SessionAuthority,
  type SessionDiscovery,
} from "@t4-code/host-service";
import { COMMAND_DESCRIPTORS, type ProjectId, type SessionId } from "@t4-code/protocol";

export const T4_HOST_VERSION = "0.1.31";
export const OFFICIAL_OMP_VERSION = "17.0.6";
export const OFFICIAL_OMP_BUILD = "89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6";
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ORIGIN_LIMIT = 32;
const VERSION_OUTPUT_BYTES = 4 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
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
  readonly remote?: {
    readonly mode: "direct" | "serve";
    readonly address: string;
    readonly port: number;
    readonly origins: readonly string[];
    readonly trustedServeProxy: boolean;
  };
}

export interface HostDaemonPaths {
  readonly profileStateRoot: string;
  readonly hostIdPath: string;
  readonly attentionOutcomePath: string;
  readonly transcriptSearchPath: string;
  readonly officialMetadataPath: string;
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
  let trustedServeProxy = false;
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
    } else if (flag === "--remote-origin") {
      if (origins.length >= ORIGIN_LIMIT) throw new Error("too many --remote-origin values");
      origins.push(boundedOrigin(value(argv, index++, flag)));
    } else if (flag === "--trusted-serve-proxy") trustedServeProxy = true;
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
  if (!remoteMode && (remoteAddress || origins.length || trustedServeProxy || remotePort !== 8787))
    throw new Error("remote flags require --remote-mode");
  if (remoteMode && !remoteAddress) throw new Error("remote mode requires --remote-address");
  if (remoteMode === "serve" && remoteAddress !== "127.0.0.1" && remoteAddress !== "::1")
    throw new Error("serve mode requires a loopback address");
  if (remoteMode === "serve" && !trustedServeProxy)
    throw new Error("serve mode requires --trusted-serve-proxy");
  if (remoteMode === "direct" && trustedServeProxy)
    throw new Error("trusted Serve proxy is invalid in direct mode");
  return {
    ompExecutable: resolve(ompExecutable),
    authorityMode,
    ...(ompSessionsRoot ? { ompSessionsRoot: resolve(ompSessionsRoot) } : {}),
    profileId,
    stateRoot: resolve(stateRoot),
    ...(remoteMode
      ? {
          remote: {
            mode: remoteMode,
            address: remoteAddress!,
            port: remotePort,
            origins,
            trustedServeProxy,
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
    transcriptSearchPath: join(profileStateRoot, "transcript-search.sqlite"),
    officialMetadataPath: join(profileStateRoot, "official-omp-sessions.json"),
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
  readonly verifyOfficialRuntime?: (executable: string) => Promise<Pick<AppserverOptions, "ompVersion" | "ompBuild">>;
  readonly onSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly removeSignal?: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
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

export async function verifyOfficialRuntime(
  executable: string,
): Promise<Pick<AppserverOptions, "ompVersion" | "ompBuild">> {
  const child = Bun.spawn([executable, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {},
  });
  const timer = setTimeout(() => child.kill(), VERSION_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      boundedProcessOutput(child.stdout, VERSION_OUTPUT_BYTES),
      boundedProcessOutput(child.stderr, VERSION_OUTPUT_BYTES),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`official OMP version probe failed (${exitCode}): ${stderr.trim()}`);
    if (stdout.trim() !== `omp/${OFFICIAL_OMP_VERSION}`)
      throw new Error(`official OMP runtime must report omp/${OFFICIAL_OMP_VERSION}`);
    return { ompVersion: OFFICIAL_OMP_VERSION, ompBuild: OFFICIAL_OMP_BUILD };
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
  let bridge: OmpAuthorityBridgeClient | undefined;
  let officialAuthority: OfficialOmpProfileAuthority | undefined;
  let sessionAuthority: SessionAuthority;
  let discovery: SessionDiscovery;
  let operationsAuthority: DesktopOperationsAuthority = {};
  let usageAuthority: AppserverOptions["usageAuthority"];
  let transcriptImageRoot: string | undefined;
  let identity: Pick<AppserverOptions, "ompVersion" | "ompBuild"> = {};
  let projectRootForProject: (projectId: ProjectId) => Promise<string> | string;
  let projectRootForSession: (sessionId: SessionId) => Promise<string>;
  let lockCheck: NonNullable<AppserverOptions["lockCheck"]>;
  let lockStatus: NonNullable<AppserverOptions["lockStatus"]>;
  if (config.authorityMode === "official") {
    identity = await (dependencies.verifyOfficialRuntime ?? verifyOfficialRuntime)(config.ompExecutable);
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
    operationsAuthority = {
      catalogGet: async () => ({
        revision: `official-omp-${OFFICIAL_OMP_VERSION}`,
        items: officialCatalogItems(),
      }),
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
    const options: AppserverOptions = {
      ...identity,
      appserverVersion: T4_HOST_VERSION,
      appserverBuild: process.env.T4_HOST_BUILD?.slice(0, 128) || "source",
      socketPath: paths.socketPath,
      hostIdPath: paths.hostIdPath,
      attentionOutcomePath: paths.attentionOutcomePath,
      sessionAuthority,
      discovery,
      operationsAuthority: {
        ...operationsAuthority,
        ...projectFileSearchAuthority.operations(),
      },
      ...(usageAuthority ? { usageAuthority } : {}),
      transcriptSearchAuthority,
      projectRootForProject,
      lockCheck,
      lockStatus,
      ...(config.authorityMode === "official" ? { claimLocklessSessions: true } : {}),
      ...(transcriptImageRoot ? { transcriptImageRoot } : {}),
      rpcChildInvocation: { executable: config.ompExecutable, prefixArgv: [] },
      rpcChildEnvironment: { OMP_PROFILE: config.profileId },
      ...(config.authorityMode === "official" ? { rpcDialect: "official-17.0.6" as const } : {}),
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
    };
    let appserver: AppserverHandle;
    try {
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
    await bridge?.stop();
    await officialAuthority?.close();
  }
}

async function main(): Promise<void> {
  try {
    await runHostDaemon(parseHostDaemonArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `t4-host error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
