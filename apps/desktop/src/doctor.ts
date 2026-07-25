import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverTailscaleExecutable,
  NodeProcessRunner,
  readTailscaleStatus,
  runProcess,
  TailscaleCliNotFoundError,
  type ProcessRunner,
} from "@t4-code/remote";

import { discoverNativeOmpProfiles } from "./local-profiles.ts";
import {
  createSafeServiceEnvironment,
  discoverOmpExecutable,
  inspectPathOmpCompatibility,
  OmpAppserverCompatibilityError,
  type PathOmpCompatibility,
  probeOmpAppserver,
} from "./service.ts";

export type DoctorStatus = "pass" | "warning" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly action?: string;
}

export interface SourceContract {
  readonly nodeEngine: string;
  readonly pnpmVersion: string;
  readonly bunEngine: string;
  readonly ompVersion: string;
  readonly ompTag: string;
  readonly ompUrl: string;
}

export type TailnetInspection = "ready" | "not-connected" | "not-installed" | "unavailable";

export interface DoctorRuntime {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly sourceContract: () => Promise<SourceContract>;
  readonly pnpmVersion: () => Promise<string | null>;
  readonly bunVersion: () => Promise<string | null>;
  readonly discoverOmp: () => Promise<string | undefined>;
  readonly inspectPathOmp: () => Promise<PathOmpCompatibility>;
  readonly probeOmp: (executable: string) => Promise<boolean>;
  readonly profileCount: () => Promise<number>;
  readonly inspectTailnet: () => Promise<TailnetInspection>;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version | null {
  const match = value
    .trim()
    .replace(/^v/u, "")
    .match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u);
  if (match === null) return null;
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function satisfiesCaretVersion(version: string, range: string): boolean {
  const minimum = range.match(/^\^(\d+\.\d+\.\d+)$/u)?.[1];
  const actual = parseVersion(version);
  const required = minimum === undefined ? null : parseVersion(minimum);
  if (actual === null || required === null || compareVersion(actual, required) < 0) return false;
  if (required.major > 0) return actual.major === required.major;
  if (required.minor > 0) return actual.major === 0 && actual.minor === required.minor;
  return actual.major === 0 && actual.minor === 0 && actual.patch === required.patch;
}

export function satisfiesMinimumVersion(version: string, range: string): boolean {
  const minimum = range.match(/^>=(\d+\.\d+\.\d+)$/u)?.[1];
  const actual = parseVersion(version);
  const required = minimum === undefined ? null : parseVersion(minimum);
  return actual !== null && required !== null && compareVersion(actual, required) >= 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid ${label}`);
  return value;
}

export async function readSourceContract(
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
): Promise<SourceContract> {
  const manifest = record(JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8")));
  const hostManifest = record(
    JSON.parse(
      await readFile(resolve(repoRoot, "packages", "host-daemon", "package.json"), "utf8"),
    ),
  );
  const matrix = record(
    JSON.parse(await readFile(resolve(repoRoot, "compat/omp-app-matrix.json"), "utf8")),
  );
  const engines = record(manifest?.engines);
  const hostEngines = record(hostManifest?.engines);
  const packageManager = requiredText(manifest?.packageManager, "package manager");
  const pnpmVersion = packageManager.match(/^pnpm@(\d+\.\d+\.\d+)$/u)?.[1];
  const verifiedRuntime = record(matrix?.verifiedRuntime);
  if (pnpmVersion === undefined) throw new Error("invalid package manager");
  const ompTag = requiredText(verifiedRuntime?.sourceTag, "OMP tag");
  const ompRepository = requiredText(verifiedRuntime?.sourceRepository, "OMP repository").replace(
    /\/+$/u,
    "",
  );
  return Object.freeze({
    nodeEngine: requiredText(engines?.node, "Node engine"),
    pnpmVersion,
    bunEngine: requiredText(hostEngines?.bun, "Bun engine"),
    ompVersion: requiredText(verifiedRuntime?.version, "OMP version"),
    ompTag,
    ompUrl: `${ompRepository}/tree/${encodeURIComponent(ompTag)}`,
  });
}

// Cold `pnpm --version` on a warm-but-unprimed macOS shell measured 2.9-4.5s
// across repeated runs, so the previous 1.5s deadline reported a healthy,
// correctly-versioned toolchain as missing. The deadline only bounds a
// misbehaving binary; it is not a latency budget.
async function installedToolVersion(command: "bun" | "pnpm"): Promise<string | null> {
  try {
    const result = await runProcess({
      runner: new NodeProcessRunner(),
      command,
      args: ["--version"],
      env: createSafeServiceEnvironment(),
      timeoutMs: 10_000,
    });
    const version = result.stdout.trim();
    return result.exitCode === 0 && parseVersion(version) !== null ? version : null;
  } catch {
    return null;
  }
}

export interface TailnetProbeOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable?: string;
  readonly runner?: ProcessRunner;
}

function createScrubbedProcessRunner(
  runner: ProcessRunner,
  environment: NodeJS.ProcessEnv,
): ProcessRunner {
  return {
    spawn(spec, signal) {
      return runner.spawn(
        { ...spec, env: createSafeServiceEnvironment(spec.env ?? environment) },
        signal,
      );
    },
  };
}

export async function inspectTailnet(
  options: TailnetProbeOptions = {},
): Promise<TailnetInspection> {
  const baseRunner = options.runner ?? new NodeProcessRunner();
  const environment = createSafeServiceEnvironment(options.environment);
  const runner = createScrubbedProcessRunner(baseRunner, environment);
  let executable: string;
  try {
    executable =
      options.executable ??
      (await discoverTailscaleExecutable());
  } catch (error) {
    return error instanceof TailscaleCliNotFoundError ? "not-installed" : "unavailable";
  }
  try {
    const status = await readTailscaleStatus({ runner, executable });
    return status.magicDnsName !== null || status.tailnetIpv4Addresses.length > 0
      ? "ready"
      : "not-connected";
  } catch {
    return "unavailable";
  }
}

export function createDoctorRuntime(): DoctorRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    sourceContract: () => readSourceContract(),
    pnpmVersion: () => installedToolVersion("pnpm"),
    bunVersion: () => installedToolVersion("bun"),
    discoverOmp: () => discoverOmpExecutable(),
    inspectPathOmp: () => inspectPathOmpCompatibility(),
    probeOmp: (executable) => probeOmpAppserver(executable),
    profileCount: async () => (await discoverNativeOmpProfiles()).length,
    inspectTailnet,
  };
}

function check(
  id: string,
  label: string,
  status: DoctorStatus,
  detail: string,
  action?: string,
): DoctorCheck {
  return Object.freeze({ id, label, status, detail, ...(action === undefined ? {} : { action }) });
}

export async function collectDoctorReport(
  runtime: DoctorRuntime = createDoctorRuntime(),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let contract: SourceContract;
  try {
    contract = await runtime.sourceContract();
  } catch {
    checks.push(
      check(
        "source-contract",
        "Source contract",
        "fail",
        "The checked-in toolchain or OMP compatibility contract could not be read.",
        "Restore package.json and compat/omp-app-matrix.json from the repository.",
      ),
    );
    return Object.freeze({ schemaVersion: 1, ok: false, checks: Object.freeze(checks) });
  }

  const supportedPlatform =
    (runtime.platform === "darwin" && runtime.arch === "arm64") ||
    (runtime.platform === "linux" && runtime.arch === "x64");
  checks.push(
    supportedPlatform
      ? check(
          "platform",
          "Platform",
          "pass",
          `${runtime.platform}/${runtime.arch} is a released desktop target.`,
        )
      : check(
          "platform",
          "Platform",
          "warning",
          `${runtime.platform}/${runtime.arch} is not a released desktop target.`,
          "Use Linux x86-64 or Apple Silicon macOS for a supported packaged desktop build.",
        ),
  );

  const nodeCompatible = satisfiesCaretVersion(runtime.nodeVersion, contract.nodeEngine);
  checks.push(
    nodeCompatible
      ? check(
          "node",
          "Node.js",
          "pass",
          `Node ${runtime.nodeVersion} satisfies ${contract.nodeEngine}.`,
        )
      : check(
          "node",
          "Node.js",
          "fail",
          `Node ${runtime.nodeVersion} does not satisfy ${contract.nodeEngine}.`,
          `Select a ${contract.nodeEngine} Node release with your version manager, then reinstall dependencies.`,
        ),
  );
  if (!nodeCompatible) {
    return Object.freeze({ schemaVersion: 1, ok: false, checks: Object.freeze(checks) });
  }

  const pnpmVersion = await runtime.pnpmVersion();
  checks.push(
    pnpmVersion === contract.pnpmVersion
      ? check("pnpm", "pnpm", "pass", `pnpm ${pnpmVersion} matches the repository.`)
      : check(
          "pnpm",
          "pnpm",
          "fail",
          pnpmVersion === null
            ? "pnpm is unavailable or did not report a valid version."
            : `pnpm ${pnpmVersion} does not match ${contract.pnpmVersion}.`,
          `Install pnpm ${contract.pnpmVersion}, then run pnpm install --frozen-lockfile.`,
        ),
  );

  const bunVersion = await runtime.bunVersion();
  checks.push(
    bunVersion !== null && satisfiesMinimumVersion(bunVersion, contract.bunEngine)
      ? check("bun", "Bun", "pass", `Bun ${bunVersion} satisfies ${contract.bunEngine}.`)
      : check(
          "bun",
          "Bun",
          "fail",
          bunVersion === null
            ? "Bun is unavailable or did not report a valid version."
            : `Bun ${bunVersion} does not satisfy ${contract.bunEngine}.`,
          `Install Bun ${contract.bunEngine} for the compiled T4 host development loop.`,
        ),
  );

  let executable: string | undefined;
  try {
    executable = await runtime.discoverOmp();
    checks.push(
      executable === undefined
        ? check(
            "omp",
            "OMP runtime",
            "fail",
            "No compatible OMP authority bridge was found.",
            `Install the verified OMP ${contract.ompVersion} integration (${contract.ompTag}): ${contract.ompUrl}`,
          )
        : check(
            "omp",
            "OMP runtime",
            "pass",
            `A compatible OMP ${contract.ompVersion} authority bridge is available.`,
          ),
    );
  } catch (error) {
    checks.push(
      error instanceof OmpAppserverCompatibilityError
        ? check(
            "omp",
            "OMP runtime",
            "fail",
            "OMP is installed, but it does not provide the versioned authority bridge T4 Code requires.",
            `Install the verified OMP ${contract.ompVersion} integration (${contract.ompTag}): ${contract.ompUrl}`,
          )
        : check(
            "omp",
            "OMP runtime",
            "fail",
            "OMP compatibility could not be checked safely.",
            "Run the check again. If it still fails, attach the redacted JSON report to a bug report.",
          ),
    );
  }

  const pathOmp = await runtime.inspectPathOmp().catch(() => "unavailable" as const);
  const pathOmpChecks: Record<PathOmpCompatibility, DoctorCheck> = {
    compatible: check(
      "terminal-omp",
      "OMP commands",
      "pass",
      "Every omp command found on PATH provides the authority bridge T4 requires.",
    ),
    incompatible: check(
      "terminal-omp",
      "OMP commands",
      "warning",
      "The omp commands found on PATH are too old for T4 live ownership signals. T4 can still open saved history, but a running task may look idle or update in chunks.",
      `Install the verified OMP integration (${contract.ompTag}) in every shell or app launch path: ${contract.ompUrl}`,
    ),
    missing: check(
      "terminal-omp",
      "OMP commands",
      "warning",
      "No omp command was found on PATH.",
      `Install the verified OMP integration (${contract.ompTag}) before starting tasks from another shell or app: ${contract.ompUrl}`,
    ),
    mixed: check(
      "terminal-omp",
      "OMP commands",
      "warning",
      "Different omp commands are installed, and they do not all pass T4's authority-bridge check. A task can therefore look live in one app but idle or delayed in another.",
      `Update or remove stale OMP copies so every shell and app uses the verified integration (${contract.ompTag}): ${contract.ompUrl}`,
    ),
    unavailable: check(
      "terminal-omp",
      "OMP commands",
      "warning",
      "The omp commands found on PATH could not be verified safely.",
      `Check that every shell and app uses the verified OMP integration (${contract.ompTag}): ${contract.ompUrl}`,
    ),
  };
  checks.push(pathOmpChecks[pathOmp]);

  if (executable !== undefined) {
    const running = await runtime.probeOmp(executable).catch(() => false);
    checks.push(
      running
        ? check(
            "appserver",
            "T4 host",
            "pass",
            "The default T4 host is running and healthy.",
          )
        : check(
            "appserver",
            "T4 host",
            "warning",
            "The compatible OMP runtime was found, but the default T4 host is not running.",
            "Open T4 Code and start the default local profile.",
          ),
    );
  }

  try {
    const profiles = await runtime.profileCount();
    checks.push(
      check(
        "profiles",
        "OMP profiles",
        "pass",
        `${profiles} local OMP ${profiles === 1 ? "profile is" : "profiles are"} discoverable.`,
      ),
    );
  } catch {
    checks.push(
      check(
        "profiles",
        "OMP profiles",
        "warning",
        "Local OMP profiles could not be counted safely.",
        "Check that the native OMP profile registry is readable and contains valid JSON.",
      ),
    );
  }

  const tailnet = await runtime.inspectTailnet();
  const tailnetCheck: Record<TailnetInspection, DoctorCheck> = {
    ready: check("tailscale", "Tailscale", "pass", "Tailscale returned a local tailnet identity."),
    "not-connected": check(
      "tailscale",
      "Tailscale",
      "warning",
      "Tailscale is installed but no local tailnet identity was reported.",
      "Sign in to Tailscale before using remote hosts or the browser client.",
    ),
    "not-installed": check(
      "tailscale",
      "Tailscale",
      "warning",
      "Tailscale is not installed. Local desktop use can still work.",
      "Install Tailscale only if you need paired computers, Android, or browser access.",
    ),
    unavailable: check(
      "tailscale",
      "Tailscale",
      "warning",
      "Tailscale status could not be read safely. Local desktop use can still work.",
      "Open Tailscale and confirm it is signed in before using remote access.",
    ),
  };
  checks.push(tailnetCheck[tailnet]);

  return Object.freeze({
    schemaVersion: 1,
    ok: checks.every((item) => item.status !== "fail"),
    checks: Object.freeze(checks),
  });
}

const STATUS_MARK: Record<DoctorStatus, string> = { pass: "PASS", warning: "WARN", fail: "FAIL" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["T4 Code setup check", ""];
  for (const item of report.checks) {
    lines.push(`[${STATUS_MARK[item.status]}] ${item.label}: ${item.detail}`);
    if (item.action !== undefined) lines.push(`       Next: ${item.action}`);
  }
  lines.push(
    "",
    report.ok ? "Required setup checks passed." : "Setup needs attention before live OMP use.",
  );
  return lines.join("\n");
}
