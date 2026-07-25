#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareDevelopmentSandbox, resetDevelopmentSandbox } from "./dev-sandbox.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const worktreesRoot = join(repoRoot, ".worktrees");
const metadataRoot = join(repoRoot, ".artifacts", "worktrees");

export function parseWorktreeSlug(value) {
  if (typeof value !== "string" || !WORKTREE_NAME.test(value)) {
    throw new Error("worktree slug must match [a-z0-9][a-z0-9-]{0,39}");
  }
  return value;
}

export function worktreeIdentity(slug, root = repoRoot) {
  const name = parseWorktreeSlug(slug);
  const path = resolve(root, ".worktrees", name);
  const parent = resolve(root, ".worktrees");
  if (relative(parent, path).startsWith("..")) throw new Error("worktree path escapes its root");
  return {
    slug: name,
    path,
    branch: `worktree/${name}`,
    sandbox: name,
    metadataPath: resolve(root, ".artifacts", "worktrees", `${name}.json`),
    environmentPath: resolve(path, ".artifacts", "worktree.env"),
  };
}

export function candidatePorts(slug, offset = 0) {
  const seed = createHash("sha256").update(parseWorktreeSlug(slug)).digest().readUInt32BE(0);
  const slot = (seed + offset) % 1_000;
  return { renderer: 41_000 + slot, tailnet: 43_000 + slot, fixture: 45_000 + slot };
}

export function worktreePortEnvironment(ports) {
  const entries = {
    T4_DEV_RENDERER_PORT: ports?.renderer,
    T4_GATEWAY_PORT: ports?.tailnet,
    T4_FIXTURE_PORT: ports?.fixture,
  };
  for (const [name, port] of Object.entries(entries)) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`${name} must be an integer from 1 through 65535`);
    }
  }
  return Object.fromEntries(Object.entries(entries).map(([name, port]) => [name, String(port)]));
}

function git(args, options = {}) {
  const result = spawnSync("git", ["-C", options.cwd ?? repoRoot, ...args], {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || "";
    throw new Error(detail.trim() || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

async function allocatedPorts(slug) {
  await mkdir(metadataRoot, { recursive: true, mode: 0o700 });
  const occupied = new Set();
  for (const entry of await readdir(metadataRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const metadata = JSON.parse(await readFile(join(metadataRoot, entry.name), "utf8"));
      for (const port of Object.values(metadata.ports ?? {})) if (Number.isInteger(port)) occupied.add(port);
    } catch {}
  }
  for (let offset = 0; offset < 1_000; offset += 1) {
    const ports = candidatePorts(slug, offset);
    if (Object.values(ports).every((port) => !occupied.has(port))) return ports;
  }
  throw new Error("no isolated development port range is available");
}

async function readMetadata(identity) {
  try {
    return JSON.parse(await readFile(identity.metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`worktree ${identity.slug} is not registered`);
    throw error;
  }
}


function branchExists(branch) {
  const result = spawnSync("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`], { stdio: "ignore" });
  return result.status === 0;
}

async function newWorktree(slug) {
  const identity = worktreeIdentity(slug);
  await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
  await mkdir(metadataRoot, { recursive: true, mode: 0o700 });
  git(["fetch", "origin", "main"]);
  const baseCommit = git(["rev-parse", "origin/main"]);
  if (!/^[0-9a-f]{40}$/u.test(baseCommit)) throw new Error("origin/main did not resolve to an exact commit");
  if (branchExists(identity.branch)) throw new Error(`branch ${identity.branch} already exists`);
  try {
    git(["worktree", "add", "-b", identity.branch, identity.path, baseCommit], { inherit: true });
    const head = git(["rev-parse", "HEAD"], { cwd: identity.path });
    if (head !== baseCommit) throw new Error("new worktree does not match exact origin/main");
    const ports = await allocatedPorts(identity.slug);
    const sandbox = await prepareDevelopmentSandbox(identity.sandbox, identity.path);
    const environment = worktreePortEnvironment(ports);
    await writeFile(
      identity.environmentPath,
      `${Object.entries(environment).map(([name, value]) => `${name}=${value}`).join("\n")}\n`,
      { mode: 0o600 },
    );
    const metadata = {
      schemaVersion: 1,
      slug: identity.slug,
      branch: identity.branch,
      baseCommit,
      worktree: relative(repoRoot, identity.path),
      sandbox: relative(identity.path, sandbox.root),
      environment: relative(identity.path, identity.environmentPath),
      ports,
      createdAt: new Date().toISOString(),
    };
    await writeFile(identity.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
    return metadata;
  } catch (error) {
    spawnSync("git", ["-C", repoRoot, "worktree", "remove", "--force", identity.path], { stdio: "ignore" });
    spawnSync("git", ["-C", repoRoot, "branch", "-D", identity.branch], { stdio: "ignore" });
    throw error;
  }
}

async function worktreeStatus(slug) {
  const identity = worktreeIdentity(slug);
  const metadata = await readMetadata(identity);
  const head = git(["rev-parse", "HEAD"], { cwd: identity.path });
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], { cwd: identity.path }).length > 0;
  return { ...metadata, head, dirty };
}

async function removeWorktree(slug) {
  const identity = worktreeIdentity(slug);
  await readMetadata(identity);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], { cwd: identity.path });
  if (dirty) throw new Error(`refusing to remove dirty worktree ${identity.slug}`);
  await resetDevelopmentSandbox(identity.sandbox, identity.path);
  git(["worktree", "remove", identity.path]);
  if (branchExists(identity.branch)) git(["branch", "-D", identity.branch]);
  await rm(identity.metadataPath, { force: false });
  return { removed: true, slug: identity.slug };
}

async function listWorktrees() {
  await mkdir(metadataRoot, { recursive: true, mode: 0o700 });
  const worktrees = [];
  for (const entry of await readdir(metadataRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      worktrees.push(JSON.parse(await readFile(join(metadataRoot, entry.name), "utf8")));
    } catch {}
  }
  worktrees.sort((left, right) => String(left.slug).localeCompare(String(right.slug)));
  return { worktrees };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === "list" && rest.length === 0) return { command };
  const index = rest.indexOf("--slug");
  const slug = index === -1 ? undefined : rest[index + 1];
  if (!["create", "status", "remove"].includes(command) || slug === undefined || rest.length !== 2) {
    throw new Error("Usage: node scripts/worktree-sandbox.mjs <create|status|remove> --slug <name> | list");
  }
  return { command, slug: parseWorktreeSlug(slug) };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = options.command === "create"
    ? await newWorktree(options.slug)
    : options.command === "status"
      ? await worktreeStatus(options.slug)
      : options.command === "list"
        ? await listWorktrees()
        : await removeWorktree(options.slug);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
