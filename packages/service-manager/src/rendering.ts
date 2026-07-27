import { ServiceValidationError, type ServiceSpec } from "./contracts.ts";

const MAX_PATH = 4096;
const MAX_ARG = 2048;
const MAX_ARGS = 128;
const MAX_PROFILE = 64;
const SAFE_ENV_KEYS: Record<string, true> = {
  HOME: true,
  // Relocates the host socket to a short absolute directory; a deep sandbox
  // HOME otherwise yields a path connect(2) rejects with EINVAL.
  T4_HOST_RUNTIME_DIR: true,
  OMP_LOG_LEVEL: true,
  OMP_PROFILE: true,
  TMPDIR: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
  XDG_STATE_HOME: true,
};
const PATH_ENV_KEYS: Record<string, true> = {
  HOME: true,
  T4_HOST_RUNTIME_DIR: true,
  TMPDIR: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_RUNTIME_DIR: true,
  XDG_STATE_HOME: true,
};
const SECRET_KEY = /(token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)/i;
const PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SERVICE_LABEL = /^dev\.oh-my-pi\.appserver(?:\.(?:profile|development)\.[a-z0-9][a-z0-9.-]{0,79})?$/u;
const WINDOWS_RESERVED_PROFILE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/iu;

function invalid(message: string): never {
  throw new ServiceValidationError(message);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validateText(value: string, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    hasControlCharacter(value) ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    invalid(`Invalid ${label}.`);
  }
  return value;
}

export function validateAbsolutePath(value: string, label: string): string {
  validateText(value, label, MAX_PATH);
  if (!value.startsWith("/") || value.includes("\0"))
    invalid(`Invalid ${label}: absolute path required.`);
  return value;
}

export function validateProfileId(value: string): string {
  validateText(value, "profile id", MAX_PROFILE);
  if (
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    !PROFILE_NAME.test(value) ||
    WINDOWS_RESERVED_PROFILE.test(value)
  )
    invalid("Invalid profile id.");
  return value;
}

export function validateServiceLabel(value: string): string {
  validateText(value, "service label", 128);
  if (!SERVICE_LABEL.test(value)) invalid("Invalid service label.");
  return value;
}

export function serviceLabelForProfile(profileId: string): string {
  const profile = validateProfileId(profileId);
  return profile === "default"
    ? "dev.oh-my-pi.appserver"
    : `dev.oh-my-pi.appserver.profile.${profile}`;
}

export function validateSpec(spec: ServiceSpec): ServiceSpec {
  const profileId = validateProfileId(spec.profileId);
  const executable = validateAbsolutePath(spec.executable, "executable");
  if (!Array.isArray(spec.argv) || spec.argv.length > MAX_ARGS) invalid("Invalid argv.");
  const argv = spec.argv.map((value, index) => validateText(value, `argv[${index}]`, MAX_ARG));
  const executableName = executable.slice(executable.lastIndexOf("/") + 1);
  if (executableName !== "t4-host") invalid("Executable must be t4-host.");
  // `serve --omp <path>/omp --profile <id>`, then two optional blocks in this
  // order: official authority, then the state root. Spelled out positionally on
  // purpose. This argv is written into a service definition, so any shape not
  // named here must not reach it.
  if (
    argv.length < 5 ||
    argv[0] !== "serve" ||
    argv[1] !== "--omp" ||
    !argv[2]?.startsWith("/") ||
    !argv[2].endsWith("/omp") ||
    argv[3] !== "--profile" ||
    argv[4] !== profileId
  )
    invalid("Unsupported T4 host argv.");
  let next = 5;
  let sessionsRoot: string | undefined;
  if (argv[next] === "--omp-authority") {
    sessionsRoot = argv[next + 3];
    if (
      argv[next + 1] !== "official" ||
      argv[next + 2] !== "--omp-sessions-root" ||
      sessionsRoot === undefined ||
      !sessionsRoot.startsWith("/")
    )
      invalid("Unsupported T4 host argv.");
    next += 4;
  }
  if (argv[next] === "--state-root") {
    const stateRoot = argv[next + 1];
    if (stateRoot === undefined || !stateRoot.startsWith("/")) invalid("Unsupported T4 host argv.");
    // Official authority claims the whole root without a lock, so the root must
    // be the one this profile derives from the declared state root. Accepting
    // any other path would let a caller aim lockless authority at a sessions
    // directory the OMP TUI co-owns.
    if (sessionsRoot !== undefined && sessionsRoot !== `${stateRoot}/official-sessions/${profileId}`)
      invalid("Unsupported T4 host argv.");
    next += 2;
  } else if (sessionsRoot !== undefined) {
    // Without a declared state root the derived sessions root cannot be
    // checked, so official authority must always declare one.
    invalid("Unsupported T4 host argv.");
  }
  if (next !== argv.length) invalid("Unsupported T4 host argv.");
  const logsDirectory = validateAbsolutePath(spec.logsDirectory, "logs directory");
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.environment ?? {})) {
    validateText(key, "environment key", 128);
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || SECRET_KEY.test(key) || SAFE_ENV_KEYS[key] !== true)
      invalid("Environment key is not permitted.");
    environment[key] = PATH_ENV_KEYS[key] === true
      ? validateAbsolutePath(value, `environment value for ${key}`)
      : validateText(value, `environment value for ${key}`, MAX_ARG);
  }
  // Service managers can retain environment imported from an unrelated shell.
  // Explicitly selecting the default profile prevents ambient OMP_PROFILE state
  // from silently routing the legacy singleton service to a named profile.
  if (profileId === "default" && environment.OMP_PROFILE === undefined) {
    environment.OMP_PROFILE = "default";
  }
  if (profileId !== "default" && environment.OMP_PROFILE !== profileId)
    invalid("Named profile service must set matching OMP_PROFILE.");
  if (
    profileId === "default" &&
    environment.OMP_PROFILE !== undefined &&
    environment.OMP_PROFILE !== "default"
  )
    invalid("Default profile service has mismatched OMP_PROFILE.");
  return { profileId, executable, argv, logsDirectory, environment };
}

export function quoteSystemd(value: string, max = MAX_ARG): string {
  validateText(value, "systemd argument", max);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`").replaceAll("%", "%%")}"`;
}

export function escapeXml(value: string): string {
  validateText(value, "plist value", MAX_ARG);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function shellFreeExec(spec: ServiceSpec): string {
  return [spec.executable, ...spec.argv].map((value) => quoteSystemd(value)).join(" ");
}

function systemdFilePath(path: string): string {
  return /[\s"'\\$`%]/.test(path) ? quoteSystemd(path, MAX_PATH) : path;
}

export function renderSystemd(spec: ServiceSpec, _label: string): string {
  const env = Object.entries(spec.environment ?? {})
    .map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
    .join("\n");
  return [
    "[Unit]",
    `Description=Omperator host (${spec.profileId})`,
    "Wants=network-online.target",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${shellFreeExec(spec)}`,
    // The appserver owns independent session workers. If the kernel kills one
    // runaway worker under memory pressure, keep the broker (and unrelated
    // sessions) alive instead of treating the child OOM as a unit failure.
    // This is isolation, not a memory limit: workers retain the full host
    // environment and available memory.
    "OOMPolicy=continue",
    "Restart=on-failure",
    "UMask=0077",
    `StandardOutput=append:${systemdFilePath(`${spec.logsDirectory}/appserver.log`)}`,
    `StandardError=append:${systemdFilePath(`${spec.logsDirectory}/appserver.error.log`)}`,
    ...(env ? [env] : []),
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderPlist(spec: ServiceSpec, label: string): string {
  const args = [spec.executable, ...spec.argv]
    .map((arg) => `      <string>${escapeXml(arg)}</string>`)
    .join("\n");
  const envEntries = Object.entries(spec.environment ?? {})
    .flatMap(([key, value]) => [
      `      <key>${escapeXml(key)}</key>`,
      `      <string>${escapeXml(value)}</string>`,
    ])
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    `    <key>Label</key><string>${escapeXml(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    args,
    "    </array>",
    "    <key>RunAtLoad</key><true/>",
    "    <key>KeepAlive</key>",
    "    <dict><key>SuccessfulExit</key><false/></dict>",
    "    <key>Umask</key><integer>63</integer>",
    `    <key>StandardOutPath</key><string>${escapeXml(spec.logsDirectory)}/appserver.log</string>`,
    `    <key>StandardErrorPath</key><string>${escapeXml(spec.logsDirectory)}/appserver.error.log</string>`,
    ...(envEntries
      ? ["    <key>EnvironmentVariables</key>", "    <dict>", envEntries, "    </dict>"]
      : []),
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");
}

function redactControlCharacters(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 0x1f || code === 0x7f ? " " : value[index];
  }
  return result;
}

export function sanitizeDiagnostic(value: string): string {
  const bounded = value
    .replaceAll(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replaceAll(
      /([A-Za-z0-9_-]*(?:token|secret|password|credential|authorization|api[_-]?key|private[_-]?key)[A-Za-z0-9_-]*\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
  return redactControlCharacters(bounded).trim().slice(0, 512);
}
