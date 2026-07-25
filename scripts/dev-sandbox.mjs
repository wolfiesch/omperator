import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const DIRECTORY_MODE = 0o700;

export function parseSandboxName(value) {
  if (typeof value !== "string" || !SANDBOX_NAME.test(value)) {
    throw new Error("sandbox must match [a-z0-9][a-z0-9-]{0,39}");
  }
  return value;
}

export function developmentSandboxPaths(name, root = repoRoot) {
  const sandbox = parseSandboxName(name);
  const developmentRoot = resolve(root, ".artifacts", "dev");
  const sandboxRoot = resolve(developmentRoot, sandbox);
  if (relative(developmentRoot, sandboxRoot).startsWith("..")) {
    throw new Error("sandbox path escapes the development root");
  }
  return Object.freeze({
    name: sandbox,
    root: sandboxRoot,
    home: join(sandboxRoot, "home"),
    agent: join(sandboxRoot, "home", ".omp", "agent"),
    config: join(sandboxRoot, "xdg", "config"),
    data: join(sandboxRoot, "xdg", "data"),
    state: join(sandboxRoot, "xdg", "state"),
    cache: join(sandboxRoot, "xdg", "cache"),
    runtime: join(sandboxRoot, "run"),
    temporary: join(sandboxRoot, "tmp"),
    electronUserData: join(sandboxRoot, "electron", "user-data"),
    hostState: join(sandboxRoot, "host-state"),
    logs: join(sandboxRoot, "logs"),
    processLogs: join(sandboxRoot, "logs", "processes"),
    hostLogs: join(sandboxRoot, "logs", "host"),
    manifest: join(sandboxRoot, "manifest.json"),
  });
}

async function secureDirectory(path) {
  try {
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`development path is not a normal directory: ${path}`);
    }
    if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
      throw new Error(`development path is not owned by the current user: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  }
  await chmod(path, DIRECTORY_MODE);
}

export async function prepareDevelopmentSandbox(name, root = repoRoot) {
  const paths = developmentSandboxPaths(name, root);
  for (const path of [
    paths.root,
    paths.home,
    paths.agent,
    paths.config,
    paths.data,
    paths.state,
    paths.cache,
    paths.runtime,
    paths.temporary,
    paths.electronUserData,
    paths.hostState,
    paths.processLogs,
    paths.hostLogs,
  ]) {
    await secureDirectory(path);
  }

  let createdAt = new Date().toISOString();
  try {
    const previous = JSON.parse(await readFile(paths.manifest, "utf8"));
    if (typeof previous.createdAt === "string") createdAt = previous.createdAt;
  } catch {}
  const manifest = {
    schemaVersion: 1,
    sandbox: paths.name,
    createdAt,
    lastPreparedAt: new Date().toISOString(),
    disposable: true,
  };
  await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return paths;
}

export function sandboxEnvironment(paths, environment = process.env) {
  return {
    ...environment,
    HOME: paths.home,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    XDG_STATE_HOME: paths.state,
    XDG_CACHE_HOME: paths.cache,
    XDG_RUNTIME_DIR: paths.runtime,
    TMPDIR: paths.temporary,
    T4_DEV_SANDBOX: paths.name,
    T4_DEV_SANDBOX_ROOT: paths.root,
    T4_DEV_LOG_DIR: paths.processLogs,
  };
}

function runBestEffort(command, args, environment = process.env) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { env: environment, stdio: "ignore" });
    child.once("error", () => resolvePromise());
    child.once("exit", () => resolvePromise());
  });
}

async function stopDevelopmentService(paths, environment = process.env) {
  const label = `dev.oh-my-pi.appserver.development.${paths.name}`;
  if (process.platform === "darwin" && typeof process.getuid === "function") {
    const definition = join(paths.home, "Library", "LaunchAgents", `${label}.plist`);
    try {
      await lstat(definition);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await runBestEffort(
      "launchctl",
      ["bootout", `gui/${process.getuid()}/${label}`],
      environment,
    );
    return;
  }
  if (process.platform === "linux") {
    const definition = join(paths.home, ".config", "systemd", "user", `${label}.service`);
    try {
      await lstat(definition);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await runBestEffort(
      "systemctl",
      ["--user", "disable", "--now", label],
      sandboxEnvironment(paths, environment),
    );
  }
}

export async function resetDevelopmentSandbox(name, root = repoRoot) {
  const paths = developmentSandboxPaths(name, root);
  let current;
  try {
    current = await lstat(paths.root);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!current.isDirectory() || current.isSymbolicLink()) {
    throw new Error("refusing to reset a sandbox root that is not a normal directory");
  }
  if (typeof process.getuid === "function" && current.uid !== process.getuid()) {
    throw new Error("refusing to reset a sandbox owned by another user");
  }
  await stopDevelopmentService(paths);
  await rm(paths.root, { recursive: true, force: false });
  return true;
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

export async function runSandboxCli(args = process.argv.slice(2), root = repoRoot) {
  const [command] = args;
  const name = option(args, "sandbox");
  if ((command !== "status" && command !== "reset") || name === undefined) {
    console.error("Usage: node scripts/dev-sandbox.mjs <status|reset> --sandbox <name>");
    return 2;
  }
  const paths = developmentSandboxPaths(name, root);
  if (command === "reset") {
    const removed = await resetDevelopmentSandbox(name, root);
    console.log(removed ? `reset development sandbox ${paths.name}` : `development sandbox ${paths.name} does not exist`);
    return 0;
  }
  let exists = true;
  try {
    await lstat(paths.root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    exists = false;
  }
  console.log(JSON.stringify({ sandbox: paths.name, exists, root: paths.root, disposable: true }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runSandboxCli();
}
