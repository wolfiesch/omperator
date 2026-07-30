import {
  LinuxSystemdUserManager,
  MacLaunchAgentManager,
  type LinuxSystemdUserManagerOptions,
} from "./index.ts";
import type { ServiceInspection, ServiceManager, ServiceRunner, ServiceSpec } from "./contracts.ts";
import { validateAbsolutePath, validateProfileId } from "./rendering.ts";

export interface PortableHostServiceOptions {
  readonly mode: "local" | "single-host";
  readonly platform: "linux" | "macos";
  readonly profileId: string;
  readonly executable: string;
  readonly homeDirectory: string;
  readonly logsDirectory: string;
  readonly stateRoot: string;
  readonly ompExecutable: string;
  readonly fs: LinuxSystemdUserManagerOptions["fs"];
  readonly runner: ServiceRunner;
  readonly uid?: number;
  readonly label?: string;
}

export interface PortableHostServiceInspection {
  readonly mode: "local" | "single-host";
  readonly highAvailability: { readonly gateway: false; readonly runtime: false };
  readonly writableOmpAuthoritiesPerRuntime: 1;
  readonly service: ServiceInspection;
}

/**
 * Packages the profile-scoped, single-authority T4 host behind the repository's
 * launchd/systemd managers. The service definition uses only the exact
 * credential-free argv accepted by t4-host.
 */
export function createPortableHostServiceManager(options: PortableHostServiceOptions): ServiceManager {
  if (options.mode !== "local" && options.mode !== "single-host") throw new TypeError("portable host service mode is invalid");
  const profileId = validateProfileId(options.profileId);
  const stateRoot = validateAbsolutePath(options.stateRoot, "portable state root");
  const ompExecutable = validateAbsolutePath(options.ompExecutable, "OMP executable");
  const spec: ServiceSpec = {
    profileId,
    executable: validateAbsolutePath(options.executable, "portable host executable"),
    argv: [
      "serve",
      "--omp", ompExecutable,
      "--profile", profileId,
      "--omp-authority", "official",
      "--omp-sessions-root", `${stateRoot}/official-sessions/${profileId}`,
      "--state-root", stateRoot,
    ],
    logsDirectory: validateAbsolutePath(options.logsDirectory, "logs directory"),
    environment: { OMP_PROFILE: profileId },
  };
  if (options.platform === "macos") {
    if (options.uid === undefined) throw new TypeError("uid is required for a launchd portable host service");
    return new MacLaunchAgentManager(spec, {
      homeDirectory: options.homeDirectory,
      uid: options.uid,
      fs: options.fs,
      runner: options.runner,
      ...(options.label === undefined ? {} : { label: options.label }),
    });
  }
  if (options.platform !== "linux") throw new TypeError("portable host service platform is invalid");
  return new LinuxSystemdUserManager(spec, {
    homeDirectory: options.homeDirectory,
    fs: options.fs,
    runner: options.runner,
    ...(options.label === undefined ? {} : { label: options.label }),
  });
}

export class PortableHostService {
  readonly #manager: ServiceManager;
  readonly #mode: "local" | "single-host";
  constructor(mode: "local" | "single-host", manager: ServiceManager) {
    this.#mode = mode;
    this.#manager = manager;
  }
  async inspect(): Promise<PortableHostServiceInspection> {
    return {
      mode: this.#mode,
      highAvailability: { gateway: false, runtime: false },
      writableOmpAuthoritiesPerRuntime: 1,
      service: await this.#manager.inspect(),
    };
  }
  install(): Promise<void> { return this.#manager.install(); }
  start(): Promise<void> { return this.#manager.start(); }
  stop(): Promise<void> { return this.#manager.stop(); }
  restart(): Promise<void> { return this.#manager.restart(); }
  uninstall(): Promise<void> { return this.#manager.uninstall(); }
}
