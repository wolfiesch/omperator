import { isAbsolute, join, resolve } from "node:path";

export interface DevelopmentSandboxServiceConfig {
  readonly homeDirectory: string;
  readonly electronUserData: string;
  readonly logsDirectory: string;
  readonly stateRoot: string;
  readonly serviceLabel: string;
  readonly environment: Readonly<Record<string, string>>;
}

export function developmentSandboxServiceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DevelopmentSandboxServiceConfig | undefined {
  const configuredRoot = environment.T4_DEV_SANDBOX_ROOT;
  const sandbox = environment.T4_DEV_SANDBOX;
  if (configuredRoot === undefined && sandbox === undefined) return undefined;
  if (
    configuredRoot === undefined ||
    !isAbsolute(configuredRoot) ||
    resolve(configuredRoot) !== configuredRoot ||
    sandbox === undefined ||
    !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(sandbox)
  ) {
    throw new Error("invalid development sandbox configuration");
  }
  const homeDirectory = join(configuredRoot, "home");
  return Object.freeze({
    homeDirectory,
    electronUserData: join(configuredRoot, "electron", "user-data"),
    logsDirectory: join(configuredRoot, "logs", "host"),
    stateRoot: join(configuredRoot, "host-state"),
    serviceLabel: `dev.oh-my-pi.appserver.development.${sandbox}`,
    environment: Object.freeze({
      HOME: homeDirectory,
      TMPDIR: join(configuredRoot, "tmp"),
      XDG_CACHE_HOME: join(configuredRoot, "xdg", "cache"),
      XDG_CONFIG_HOME: join(configuredRoot, "xdg", "config"),
      XDG_DATA_HOME: join(configuredRoot, "xdg", "data"),
      XDG_RUNTIME_DIR: join(configuredRoot, "run"),
      XDG_STATE_HOME: join(configuredRoot, "xdg", "state"),
    }),
  });
}
