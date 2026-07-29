import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { T4OmpLauncherState } from "@t4-code/protocol/desktop-ipc";

const COMMAND = "t4-omp" as const;
const DISPLAY_PATH = "~/.local/bin/t4-omp" as const;

export interface T4OmpLauncherOptions {
  readonly supported: boolean;
  readonly homeDirectory: string;
  readonly runtimeRoot: string;
  readonly resolveRuntime: () => Promise<string | undefined>;
  readonly launcherPath?: string;
}

function state(
  phase: T4OmpLauncherState["phase"],
  message: string,
): T4OmpLauncherState {
  return { phase, command: COMMAND, location: DISPLAY_PATH, message };
}

function pathInside(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child !== "" && !child.startsWith("..") && !isAbsolute(child);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Installs a side-by-side terminal entrypoint without changing `omp` or shell
 * configuration. Only symlinks targeting T4's private runtime tree are ever
 * replaced or removed.
 */
export class T4OmpLauncher {
  private readonly supported: boolean;
  private readonly runtimeRoot: string;
  private readonly runtime: () => Promise<string | undefined>;
  private readonly launcherPath: string;
  private readonly localDirectory: string;

  constructor(options: T4OmpLauncherOptions) {
    this.supported = options.supported;
    this.runtimeRoot = resolve(options.runtimeRoot);
    this.runtime = options.resolveRuntime;
    this.localDirectory = resolve(options.homeDirectory, ".local");
    this.launcherPath = resolve(
      options.launcherPath ?? join(options.homeDirectory, ".local", "bin", COMMAND),
    );
  }

  async inspect(): Promise<T4OmpLauncherState> {
    if (!this.supported) {
      return state("unsupported", "The t4-omp terminal launcher is available in the installed macOS app.");
    }
    const runtime = await this.currentRuntime();
    if (!(await exists(this.launcherPath))) {
      return state(
        "not-installed",
        "Install t4-omp to start terminal sessions with the same OMP runtime as T4 Code.",
      );
    }
    const entry = await lstat(this.launcherPath);
    if (!entry.isSymbolicLink()) {
      return state("conflict", "A different file already uses ~/.local/bin/t4-omp. T4 Code left it untouched.");
    }
    const rawTarget = await readlink(this.launcherPath);
    const target = resolve(dirname(this.launcherPath), rawTarget);
    if (target === runtime) {
      return state("installed", "t4-omp uses the same verified OMP runtime as T4 Code.");
    }
    if (this.isOwnedRuntimeTarget(target)) {
      return state("update-available", "Update t4-omp to use this version of T4 Code's OMP runtime.");
    }
    return state("conflict", "A different command already owns ~/.local/bin/t4-omp. T4 Code left it untouched.");
  }

  async install(): Promise<T4OmpLauncherState> {
    if (!this.supported) throw new Error("The t4-omp terminal launcher is unavailable in this build.");
    const runtime = await this.currentRuntime();
    const current = await this.inspect();
    if (current.phase === "conflict") throw new Error(current.message);
    if (current.phase === "installed") return current;

    await this.prepareDirectory();
    if (current.phase === "update-available") await this.unlinkOwnedLink();
    // Creating the final link directly is intentionally no-clobber. If
    // another process wins the name, this fails instead of overwriting it.
    await symlink(runtime, this.launcherPath, "file");
    return this.inspect();
  }

  async remove(): Promise<T4OmpLauncherState> {
    if (!this.supported) throw new Error("The t4-omp terminal launcher is unavailable in this build.");
    const current = await this.inspect();
    if (current.phase === "conflict") throw new Error(current.message);
    if (current.phase === "installed" || current.phase === "update-available") {
      await this.unlinkOwnedLink();
    }
    return state(
      "not-installed",
      "t4-omp is not installed. Your existing omp command was not changed.",
    );
  }

  private async currentRuntime(): Promise<string> {
    const runtime = await this.runtime();
    if (runtime === undefined || !this.isOwnedRuntimeTarget(runtime)) {
      throw new Error("T4 Code's bundled OMP runtime is unavailable.");
    }
    const info = await lstat(runtime);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
      throw new Error("T4 Code's bundled OMP runtime is not executable.");
    }
    return resolve(runtime);
  }

  private isOwnedRuntimeTarget(candidate: string): boolean {
    return pathInside(this.runtimeRoot, candidate) && candidate.endsWith("/omp");
  }

  private async prepareDirectory(): Promise<void> {
    const directory = dirname(this.launcherPath);
    if (dirname(directory) !== this.localDirectory) {
      throw new Error("The t4-omp installation path is outside ~/.local/bin.");
    }
    if (await exists(this.localDirectory)) {
      const local = await lstat(this.localDirectory);
      if (!local.isDirectory() || local.isSymbolicLink()) {
        throw new Error("The ~/.local directory is not a safe installation directory.");
      }
    } else {
      await mkdir(this.localDirectory, { mode: 0o755 });
    }
    if (!(await exists(directory))) await mkdir(directory, { mode: 0o755 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("The ~/.local/bin directory is not a safe installation directory.");
    }
  }

  private async unlinkOwnedLink(): Promise<void> {
    const info = await lstat(this.launcherPath);
    if (!info.isSymbolicLink()) throw new Error("The t4-omp command changed before T4 Code could update it.");
    const rawTarget = await readlink(this.launcherPath);
    const target = resolve(dirname(this.launcherPath), rawTarget);
    if (!this.isOwnedRuntimeTarget(target)) {
      throw new Error("The t4-omp command changed before T4 Code could update it.");
    }
    await unlink(this.launcherPath);
  }
}
