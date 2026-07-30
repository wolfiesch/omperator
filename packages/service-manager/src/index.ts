import { constants as fsConstants } from "node:fs";
import { lstat as nodeLstat, mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { ServiceCommandError, ServiceFileError, ServiceValidationError } from "./contracts.ts";
import type {
  Platform,
  RuntimeSnapshot,
  ServiceFileStat,
  ServiceFileSystem,
  ServiceInspection,
  ServiceManager,
  ServicePlan,
  ServiceRunner,
  ServiceRunnerResult,
  ServiceSpec,
  ServiceState,
} from "./contracts.ts";
import {
  escapeXml,
  quoteSystemd,
  renderPlist,
  renderSystemd,
  sanitizeDiagnostic,
  serviceLabelForProfile,
  validateAbsolutePath,
  validateProfileId,
  validateServiceLabel,
  validateSpec,
} from "./rendering.ts";

export {
  ServiceCommandError,
  ServiceFileError,
  ServiceValidationError,
} from "./contracts.ts";
export type {
  DefinitionState,
  Platform,
  ServiceFileStat,
  ServiceFileSystem,
  ServiceInspection,
  ServiceManager,
  ServiceRunner,
  ServiceRunnerResult,
  ServiceSpec,
  ServiceState,
} from "./contracts.ts";

export interface LinuxSystemdUserManagerOptions {
  readonly homeDirectory: string;
  readonly label?: string;
  readonly fs: ServiceFileSystem;
  readonly runner: ServiceRunner;
}

export interface MacLaunchAgentManagerOptions {
  readonly homeDirectory: string;
  readonly label?: string;
  readonly uid: number;
  readonly fs: ServiceFileSystem;
  readonly runner: ServiceRunner;
}


export function validateServiceSpec(spec: ServiceSpec): ServiceSpec {
  return validateSpec(spec);
}

export function renderLinuxSystemdDefinition(spec: ServiceSpec): string {
  const validated = validateSpec(spec);
  return renderSystemd(validated, serviceLabelForProfile(validated.profileId));
}

export function renderMacLaunchAgentDefinition(spec: ServiceSpec): string {
  const validated = validateSpec(spec);
  return renderPlist(validated, serviceLabelForProfile(validated.profileId));
}

export const sanitizeServiceDiagnostic = sanitizeDiagnostic;
export { serviceLabelForProfile, validateProfileId };

function stateFromResult(result: ServiceRunnerResult, platform: Platform): ServiceState {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (platform === "linux") {
    if (output.includes("activating")) return "starting";
    if (output.includes("inactive")) return "stopped";
    if (output.includes("failed")) return "failed";
    if (output.includes("active")) return "running";
    if (result.exitCode === 0) return "running";
    if (result.exitCode === 1) return "stopped";
    if (result.exitCode === 2) return "starting";
    if (result.exitCode === 3) return "failed";
    return "unknown";
  }
  if (output.includes("state = running") || output.includes("state=running")) return "running";
  if (output.includes("state = starting") || output.includes("state=starting")) return "starting";
  if (
    output.includes("state = exited") ||
    output.includes("state=exited") ||
    output.includes("could not find") ||
    output.includes("no such process")
  )
    return "stopped";
  if (output.includes("failed")) return "failed";
  if (result.exitCode === 0) return "running";
  return "unknown";
}

function runtimeSnapshot(result: ServiceRunnerResult, platform: Platform): RuntimeSnapshot {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const missing =
    output.includes("could not find") ||
    output.includes("not loaded") ||
    output.includes("no such process") ||
    (output.includes("unit ") && output.includes("not found"));
  if (missing) return { registered: false, state: "stopped" };
  if (result.exitCode === 0) return { registered: true, state: stateFromResult(result, platform) };
  if (
    platform === "linux" &&
    (output.includes("inactive") || output.includes("activating") || output.includes("failed"))
  ) {
    return { registered: true, state: stateFromResult(result, platform) };
  }
  throw new ServiceCommandError(["status"], result);
}
async function runChecked(
  runner: ServiceRunner,
  command: readonly string[],
): Promise<ServiceRunnerResult> {
  const isLaunchctlBootstrap = command[0] === "launchctl" && command[1] === "bootstrap";
  // launchd can accept bootout before it has finished removing the service.
  // A replacement bootstrap can then return EINPROGRESS (37), or the less
  // specific EIO (5), for several seconds even though the plist is valid.
  const retryDeadline = Date.now() + 30_000;
  while (true) {
    let result: ServiceRunnerResult;
    try {
      result = await runner.run(command);
    } catch (cause) {
      throw new ServiceCommandError(command, {
        exitCode: null,
        stdout: "",
        stderr: sanitizeDiagnostic(String(cause)),
      });
    }
    if (result.exitCode === 0) return result;
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    const removalStillFinishing =
      isLaunchctlBootstrap &&
      (
        result.exitCode === 37 ||
        /operation already in progress|bootstrap failed:\s*37\b/iu.test(diagnostics) ||
        (
          result.exitCode === 5 &&
          /bootstrap failed:\s*5\s*:\s*input\/output error/iu.test(diagnostics)
        )
      );
    if (!removalStillFinishing || Date.now() >= retryDeadline)
      throw new ServiceCommandError(command, result);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

abstract class BaseManager implements ServiceManager {
  protected readonly spec: ServiceSpec;
  protected readonly fs: ServiceFileSystem;
  protected readonly runner: ServiceRunner;
  abstract readonly platform: Platform;
  abstract readonly label: string;
  abstract readonly definitionPath: string;
  protected constructor(spec: ServiceSpec, fs: ServiceFileSystem, runner: ServiceRunner) {
    this.spec = validateSpec(spec);
    this.fs = fs;
    this.runner = runner;
  }
  protected abstract createPlan(): ServicePlan;
  protected abstract statusCommand(): readonly string[];
  protected installCommands(
    plan: ServicePlan,
    changed: boolean,
    _runtime: RuntimeSnapshot,
    _hadPreviousDefinition: boolean,
  ): readonly (readonly string[])[] {
    return changed ? plan.commands.install : plan.commands.install.slice(1);
  }
  protected async rollbackRuntime(
    _runtime: RuntimeSnapshot,
    _hadPreviousDefinition: boolean,
  ): Promise<void> {}
  protected async afterUninstall(_plan: ServicePlan): Promise<void> {}
  protected async rollbackAfterUninstall(_plan: ServicePlan): Promise<void> {}
  private async definitionSnapshot(
    path: string,
  ): Promise<{ content: string | null; mode: number; unsafe: boolean }> {
    const stat = this.fs.lstat ? await this.fs.lstat(path) : null;
    if (stat?.isSymbolicLink) return { content: null, mode: 0o600, unsafe: true };
    const content = await this.fs.read(path);
    return { content, mode: stat?.mode ?? 0o600, unsafe: false };
  }
  async inspect(): Promise<ServiceInspection> {
    const plan = this.createPlan();
    let definition: { content: string | null; mode: number; unsafe: boolean };
    try {
      definition = await this.definitionSnapshot(plan.definitionPath);
    } catch (cause) {
      throw new ServiceFileError("read", plan.definitionPath, cause);
    }
    let result: ServiceRunnerResult;
    try {
      result = await this.runner.run(this.statusCommand());
    } catch (cause) {
      result = { exitCode: null, stdout: "", stderr: String(cause) };
    }
    return {
      definition: definition.unsafe
        ? "drifted"
        : definition.content === null
          ? "missing"
          : definition.content === plan.content
            ? "current"
            : "drifted",
      service: stateFromResult(result, this.platform),
      diagnostics: sanitizeDiagnostic(
        definition.unsafe ? "unsafe symbolic-link definition" : result.stderr || result.stdout,
      ),
    };
  }
  async install(): Promise<void> {
    const plan = this.createPlan();
    let previous: { content: string | null; mode: number; unsafe: boolean };
    try {
      previous = await this.definitionSnapshot(plan.definitionPath);
    } catch (cause) {
      throw new ServiceFileError("read", plan.definitionPath, cause);
    }
    if (previous.unsafe)
      throw new ServiceFileError("install", plan.definitionPath, new Error("unsafe symbolic link"));
    let status: ServiceRunnerResult;
    try {
      status = await this.runner.run(this.statusCommand());
    } catch (cause) {
      status = { exitCode: null, stdout: "", stderr: String(cause) };
    }
    const runtime = runtimeSnapshot(status, this.platform);
    const changed = previous.content !== plan.content || previous.mode !== plan.mode;
    if (changed) {
      try {
        await this.fs.mkdir(this.spec.logsDirectory);
        await this.fs.mkdir(dirname(plan.definitionPath));
        await this.fs.writeAtomic(plan.definitionPath, plan.content, plan.mode);
        await this.fs.chmod(plan.definitionPath, plan.mode);
      } catch (cause) {
        if (previous.content === null)
          await this.fs.remove(plan.definitionPath).catch(() => undefined);
        else
          await this.fs
            .writeAtomic(plan.definitionPath, previous.content, previous.mode)
            .catch(() => undefined);
        throw new ServiceFileError("install", plan.definitionPath, cause);
      }
    }
    try {
      for (const command of this.installCommands(plan, changed, runtime, previous.content !== null))
        await runChecked(this.runner, command);
    } catch (cause) {
      if (changed) {
        try {
          if (previous.content === null) await this.fs.remove(plan.definitionPath);
          else {
            await this.fs.writeAtomic(plan.definitionPath, previous.content, previous.mode);
            await this.fs.chmod(plan.definitionPath, previous.mode);
          }
          await this.rollbackRuntime(runtime, previous.content !== null);
        } catch (rollbackCause) {
          throw new ServiceFileError("rollback", plan.definitionPath, rollbackCause);
        }
      }
      throw cause;
    }
  }
  async start(): Promise<void> {
    for (const command of this.createPlan().commands.start) await runChecked(this.runner, command);
  }
  async stop(): Promise<void> {
    for (const command of this.createPlan().commands.stop) await runChecked(this.runner, command);
  }
  async restart(): Promise<void> {
    for (const command of this.createPlan().commands.restart)
      await runChecked(this.runner, command);
  }
  async uninstall(): Promise<void> {
    const plan = this.createPlan();
    let previous: { content: string | null; mode: number; unsafe: boolean };
    try {
      previous = await this.definitionSnapshot(plan.definitionPath);
    } catch (cause) {
      throw new ServiceFileError("read", plan.definitionPath, cause);
    }
    let status: ServiceRunnerResult;
    try {
      status = await this.runner.run(this.statusCommand());
    } catch (cause) {
      status = { exitCode: null, stdout: "", stderr: String(cause) };
    }
    const runtime = runtimeSnapshot(status, this.platform);
    for (const command of plan.commands.uninstall) await runChecked(this.runner, command);
    try {
      await this.fs.remove(plan.definitionPath);
      await this.afterUninstall(plan);
    } catch (cause) {
      if (previous.content !== null)
        await this.fs
          .writeAtomic(plan.definitionPath, previous.content, previous.mode)
          .catch(() => undefined);
      await this.rollbackAfterUninstall(plan).catch(() => undefined);
      await this.rollbackRuntime(runtime, previous.content !== null).catch(() => undefined);
      throw new ServiceFileError("uninstall", plan.definitionPath, cause);
    }
  }
}


export class LinuxSystemdUserManager extends BaseManager {
  readonly platform = "linux" as const;
  readonly label: string;
  readonly definitionPath: string;
  constructor(spec: ServiceSpec, options: LinuxSystemdUserManagerOptions) {
    super(spec, options.fs, options.runner);
    validateAbsolutePath(options.homeDirectory, "home directory");
    this.label = validateServiceLabel(options.label ?? serviceLabelForProfile(this.spec.profileId));
    this.definitionPath = join(
      options.homeDirectory,
      ".config/systemd/user",
      `${this.label}.service`,
    );
  }
  protected statusCommand(): readonly string[] {
    return ["systemctl", "--user", "is-active", this.label];
  }
  protected override installCommands(
    plan: ServicePlan,
    changed: boolean,
    runtime: RuntimeSnapshot,
    hadPreviousDefinition: boolean,
  ): readonly (readonly string[])[] {
    if (!changed || !hadPreviousDefinition) return changed ? plan.commands.install : plan.commands.install.slice(1);
    if (runtime.state === "running") {
      return [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", this.label],
        ["systemctl", "--user", "restart", this.label],
      ];
    }
    return plan.commands.install;
  }
  protected override async rollbackRuntime(
    runtime: RuntimeSnapshot,
    hadPreviousDefinition: boolean,
  ): Promise<void> {
    await runChecked(this.runner, ["systemctl", "--user", "daemon-reload"]);
    if (runtime.state === "running")
      await runChecked(this.runner, ["systemctl", "--user", "restart", this.label]);
    else if (!hadPreviousDefinition || !runtime.registered)
      await runChecked(this.runner, ["systemctl", "--user", "disable", "--now", this.label]);
    else await runChecked(this.runner, ["systemctl", "--user", "stop", this.label]);
  }
  protected override async afterUninstall(): Promise<void> {
    await runChecked(this.runner, ["systemctl", "--user", "daemon-reload"]);
  }
  protected override async rollbackAfterUninstall(): Promise<void> {
    await this.runner.run(["systemctl", "--user", "daemon-reload"]).catch(() => undefined);
  }
  protected override createPlan(): ServicePlan {
    const base = ["systemctl", "--user"] as const;
    return {
      platform: this.platform,
      label: this.label,
      definitionPath: this.definitionPath,
      content: renderSystemd(this.spec, this.label),
      mode: 0o600,
      commands: {
        install: [
          [...base, "daemon-reload"],
          [...base, "enable", "--now", this.label],
        ],
        start: [[...base, "enable", "--now", this.label]],
        stop: [[...base, "stop", this.label]],
        restart: [[...base, "restart", this.label]],
        uninstall: [[...base, "disable", "--now", this.label]],
        status: [this.statusCommand()],
      },
    };
  }
}


export class MacLaunchAgentManager extends BaseManager {
  readonly platform = "macos" as const;
  readonly label: string;
  readonly definitionPath: string;
  readonly domain: string;
  constructor(spec: ServiceSpec, options: MacLaunchAgentManagerOptions) {
    super(spec, options.fs, options.runner);
    validateAbsolutePath(options.homeDirectory, "home directory");
    if (!Number.isInteger(options.uid) || options.uid < 0 || options.uid > 4_000_000_000)
      throw new ServiceValidationError("Invalid uid.");
    this.label = validateServiceLabel(options.label ?? serviceLabelForProfile(this.spec.profileId));
    this.domain = `gui/${options.uid}`;
    this.definitionPath = join(
      options.homeDirectory,
      "Library/LaunchAgents",
      `${this.label}.plist`,
    );
  }
  protected statusCommand(): readonly string[] {
    return ["launchctl", "print", `${this.domain}/${this.label}`];
  }
  protected override installCommands(
    plan: ServicePlan,
    changed: boolean,
    runtime: RuntimeSnapshot,
  ): readonly (readonly string[])[] {
    const target = `${this.domain}/${this.label}`;
    if (runtime.registered)
      return changed
        ? [["launchctl", "bootout", target], ...plan.commands.install]
        : plan.commands.install.slice(1);
    return plan.commands.install;
  }
  protected override async rollbackRuntime(
    runtime: RuntimeSnapshot,
    hadPreviousDefinition: boolean,
  ): Promise<void> {
    const target = `${this.domain}/${this.label}`;
    await runChecked(this.runner, ["launchctl", "bootout", target]);
    if (runtime.registered && hadPreviousDefinition) {
      await runChecked(this.runner, ["launchctl", "bootstrap", this.domain, this.definitionPath]);
      if (runtime.state === "running")
        await runChecked(this.runner, ["launchctl", "kickstart", "-k", target]);
    }
  }
  override async start(): Promise<void> {
    const result = await this.runner
      .run(this.statusCommand())
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    const target = `${this.domain}/${this.label}`;
    if (!runtimeSnapshot(result, this.platform).registered)
      await runChecked(this.runner, ["launchctl", "bootstrap", this.domain, this.definitionPath]);
    await runChecked(this.runner, ["launchctl", "kickstart", "-k", target]);
  }
  override async restart(): Promise<void> {
    await this.start();
  }
  protected override createPlan(): ServicePlan {
    const target = `${this.domain}/${this.label}`;
    return {
      platform: this.platform,
      label: this.label,
      definitionPath: this.definitionPath,
      content: renderPlist(this.spec, this.label),
      mode: 0o600,
      commands: {
        install: [
          ["launchctl", "bootstrap", this.domain, this.definitionPath],
          ["launchctl", "kickstart", "-k", target],
        ],
        start: [["launchctl", "kickstart", "-k", target]],
        stop: [["launchctl", "bootout", target]],
        restart: [["launchctl", "kickstart", "-k", target]],
        uninstall: [["launchctl", "bootout", target]],
        status: [this.statusCommand()],
      },
    };
  }
}

function errnoCode(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== "object" || !("code" in cause)) return undefined;
  return typeof cause.code === "string" ? cause.code : undefined;
}

export class NodeServiceFileSystem implements ServiceFileSystem {
  private async ensureSafePath(path: string): Promise<void> {
    let current = path;
    while (current !== "/") {
      try {
        const stat = await nodeLstat(current);
        if (stat.isSymbolicLink()) throw new Error("symbolic link path");
      } catch (cause) {
        if (errnoCode(cause) !== "ENOENT") throw cause;
      }
      current = dirname(current);
    }
  }
  async lstat(path: string): Promise<ServiceFileStat | null> {
    try {
      const stat = await nodeLstat(path);
      return { mode: stat.mode & 0o777, isSymbolicLink: stat.isSymbolicLink() };
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") return null;
      throw cause;
    }
  }
  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(dirname(path), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  async read(path: string): Promise<string | null> {
    await this.ensureSafePath(path);
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      return await handle.readFile("utf8");
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") return null;
      throw cause;
    } finally {
      await handle?.close();
    }
  }
  async writeAtomic(path: string, content: string, mode: number): Promise<void> {
    await this.ensureSafePath(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await this.ensureSafePath(path);
    const temp = `${path}.tmp-${randomUUID()}`;
    const handle = await open(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await this.ensureSafePath(path);
      await rename(temp, path);
      await this.syncDirectory(path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async mkdir(path: string): Promise<void> {
    await this.ensureSafePath(path);
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  async chmod(path: string, mode: number): Promise<void> {
    await this.ensureSafePath(path);
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  }
  async remove(path: string): Promise<void> {
    await this.ensureSafePath(path);
    await rm(path, { force: true });
    await this.ensureSafePath(path);
    await this.syncDirectory(path);
  }
}
export const serviceInternals = {
  renderSystemd,
  renderPlist,
  quoteSystemd,
  escapeXml,
  validateSpec,
  sanitizeDiagnostic,
} as const;

export * from "./portable-host.ts";
