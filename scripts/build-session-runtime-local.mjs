#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execute = promisify(execFile);
const EXACT_COMMIT = /^[0-9a-f]{40}$/u;
const DEFAULT_WAIT_MS = 30 * 60 * 1000;

function requireExactCommit(sourceCommit) {
  if (!EXACT_COMMIT.test(sourceCommit)) {
    throw new Error("source identity must be a 40-character lowercase commit SHA");
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function readOwner(lockDirectory) {
  try {
    return JSON.parse(await readFile(join(lockDirectory, "owner.json"), "utf8"));
  } catch {
    return undefined;
  }
}

export function localRuntimeImage(sourceCommit) {
  requireExactCommit(sourceCommit);
  return `omperator-session-runtime:${sourceCommit.slice(0, 8)}-arm64`;
}

export function createDockerBuildArguments({ image, sourceCommit }) {
  requireExactCommit(sourceCommit);
  if (!image) throw new Error("image reference is required");
  return [
    "build",
    "--platform", "linux/arm64",
    "--file", "cluster/images/session-runtime/Dockerfile",
    "--build-arg", `SOURCE_COMMIT=${sourceCommit}`,
    "--build-arg", "IMAGE_VERSION=portable-agent-platform-v1-local",
    "--tag", image,
    ".",
  ];
}

export async function acquireBuildLease({
  lockDirectory,
  image,
  waitMs = DEFAULT_WAIT_MS,
  pollMs = 1000,
}) {
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  await mkdir(dirname(lockDirectory), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDirectory);
      const owner = {
        schemaVersion: 1,
        pid: process.pid,
        token,
        image,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      };
      await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
      return {
        owner,
        async release() {
          const current = await readOwner(lockDirectory);
          if (current?.token === token) await rm(lockDirectory, { recursive: true, force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = await readOwner(lockDirectory);
    if (owner && !processIsAlive(owner.pid)) {
      await rm(lockDirectory, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const identity = owner ? `pid ${owner.pid} (${owner.image ?? "unknown image"})` : "an initializing process";
      throw new Error(`another session-runtime build owns the lease: ${identity}`);
    }
    await delay(pollMs);
  }
}

async function imageMatches(image, sourceCommit) {
  try {
    const { stdout } = await execute("docker", ["image", "inspect", image], { encoding: "utf8" });
    const inspected = JSON.parse(stdout)[0];
    return inspected?.Architecture === "arm64"
      && inspected?.Config?.Labels?.["org.opencontainers.image.revision"] === sourceCommit;
  } catch {
    return false;
  }
}

async function run(executable, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} exited with ${signal ?? `status ${code}`}`));
    });
  });
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main() {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { stdout: commitOutput } = await execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  const sourceCommit = commitOutput.trim();
  requireExactCommit(sourceCommit);
  const { stdout: statusOutput } = await execute("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" });
  if (statusOutput.trim()) throw new Error("refusing to label a dirty worktree as an exact source commit; commit or stash the changes first");

  const image = option("image") ?? localRuntimeImage(sourceCommit);
  if (await imageMatches(image, sourceCommit)) {
    process.stdout.write(`${image}\n`);
    return;
  }

  const waitSeconds = Number(option("wait-seconds") ?? DEFAULT_WAIT_MS / 1000);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error("--wait-seconds must be a non-negative number");
  const lockDirectory = join(homedir(), ".cache", "omperator", "session-runtime-build.lock");
  const lease = await acquireBuildLease({ lockDirectory, image, waitMs: waitSeconds * 1000 });
  try {
    if (await imageMatches(image, sourceCommit)) {
      process.stdout.write(`${image}\n`);
      return;
    }
    await run("docker", createDockerBuildArguments({ image, sourceCommit }), {
      cwd: repositoryRoot,
      env: { ...process.env, DOCKER_BUILDKIT: "1" },
    });
    if (!(await imageMatches(image, sourceCommit))) throw new Error("built image does not preserve the exact ARM64 source identity");
    process.stdout.write(`${image}\n`);
  } finally {
    await lease.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
