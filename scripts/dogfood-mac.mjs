#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { prepareDevelopmentSandbox, resetDevelopmentSandbox, sandboxEnvironment } from "./dev-sandbox.mjs";
import { pnpmProcessInvocation } from "./pnpm-process.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const TIMEOUT_MS = 60_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, env: process.env, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}`);
}

function git(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || "git command failed");
  return result.stdout.trim();
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      if ((await stat(path)).isDirectory()) return path;
    } catch {}
  }
  throw new Error("unsigned macOS application bundle was not produced");
}

async function waitForSocket(path, child) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {}
    if (child.exitCode !== null) throw new Error(`packaged Electron exited before host readiness (${child.exitCode})`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("packaged Electron host socket timed out");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)).then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 10_000)),
  ]);
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("dogfood:mac requires Apple Silicon macOS");
  }
  const commit = git(["rev-parse", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"]).length > 0;
  const artifactRoot = resolve(repoRoot, "artifacts", "dogfood", commit, "mac");
  await mkdir(artifactRoot, { recursive: true });

  const packageInvocation = pnpmProcessInvocation(["package:mac:unsigned", "--", "--dir"], process.env.npm_execpath);
  run(packageInvocation.command, packageInvocation.args);
  const app = await firstExisting([
    resolve(repoRoot, "release", "mac-arm64", "T4 Code.app"),
    resolve(repoRoot, "release", "mac", "T4 Code.app"),
  ]);
  const resources = join(app, "Contents", "Resources");
  const host = join(resources, "runtime", "t4-host");
  const runtime = join(resources, "runtime", "omp");
  const scenario = spawnSync(
    "bun",
    [
      "run",
      "packages/host-daemon/bin/dogfood-scenarios.ts",
      "--scenario",
      "full",
      "--artifact-root",
      artifactRoot,
      "--host",
      host,
      "--runtime",
      runtime,
    ],
    { cwd: repoRoot, env: process.env, stdio: "inherit" },
  );
  if (scenario.error) throw scenario.error;
  if (scenario.status !== 0) throw new Error(`packaged dogfood scenarios failed with exit code ${scenario.status ?? "unknown"}`);

  const sandboxName = `dogfood-${commit.slice(0, 12)}`;
  const paths = await prepareDevelopmentSandbox(sandboxName, repoRoot);
  const environment = sandboxEnvironment(paths, {
    ...process.env,
    OMP_PROFILE: "default",
  });
  const executable = join(app, "Contents", "MacOS", "t4-code");
  const electron = spawn(executable, [], { cwd: repoRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let launchPassed = false;
  try {
    await waitForSocket(join(paths.home, ".omp", "run", "appserver.sock"), electron);
    launchPassed = true;
  } finally {
    await stopChild(electron);
    await resetDevelopmentSandbox(sandboxName, repoRoot);
  }
  const report = {
    schemaVersion: 1,
    commit,
    dirty,
    app: relative(repoRoot, app),
    bundledHost: relative(repoRoot, host),
    bundledRuntime: relative(repoRoot, runtime),
    packagedElectronLaunch: launchPassed,
    isolatedSandboxCleaned: true,
    passed: launchPassed,
  };
  await writeFile(join(artifactRoot, "packaged-app.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
