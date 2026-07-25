#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { classifyCiPaths } from "./ci-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function normalize(path) {
  return path.replace(/^\.\//u, "").replaceAll("\\", "/");
}

function command(id, argv, reason, requiredEnvironment = []) {
  return { id, argv, reason, requiredEnvironment };
}

function add(planned, item) {
  if (!planned.some((current) => current.id === item.id)) planned.push(item);
}

function workspaceTest(path) {
  const match = /^(apps|packages)\/([^/]+)\//u.exec(path);
  if (!match) return undefined;
  const manifestPath = join(repoRoot, match[1], match[2], "package.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name === "string" && typeof manifest.scripts?.test === "string") {
      return command(
        `workspace:${manifest.name}`,
        ["pnpm", "--filter", manifest.name, "test"],
        `${match[1]}/${match[2]} has affected source or tests`,
      );
    }
  } catch {}
  return undefined;
}

export function planAffectedVerification(inputPaths) {
  const paths = [...new Set(inputPaths.map(normalize).filter(Boolean))].sort();
  if (paths.length === 0) return { paths, classifications: classifyCiPaths([]), commands: [] };

  const classifications = classifyCiPaths(paths);
  const commands = [];
  add(commands, command("check", ["pnpm", "check"], "every non-empty change must pass source and type checks"));

  for (const path of paths) {
    const workspace = workspaceTest(path);
    if (workspace) add(commands, workspace);
  }

  if (classifications.tooling || paths.some((path) => /^(?:Taskfile\.yml|package\.json|scripts\/)/u.test(path))) {
    add(commands, command("tooling", ["pnpm", "test:tooling"], "repository tooling or its command surface changed"));
  }
  if (classifications.maintainer) {
    add(commands, command("maintainer", ["pnpm", "test:maintainer"], "maintainer deployment surface changed"));
  }
  if (paths.some((path) => /^(?:electron-builder\.config\.mjs|apps\/desktop\/build\/|scripts\/(?:package|inspect-macos|inspect-package|run-electron-builder))/u.test(path))) {
    add(commands, command("build", ["pnpm", "build"], "packaging checks require built desktop, web, and host inputs"));
    add(commands, command("packaging", ["pnpm", "test:packaging"], "packaging inputs changed"));
  }
  if (paths.some((path) => /^(?:e2e\/|apps\/(?:web|site)\/src\/)/u.test(path))) {
    add(commands, command("e2e", ["pnpm", "test:e2e"], "browser-visible behavior changed"));
  }
  if (classifications.cluster) {
    add(commands, command("cluster", ["pnpm", "test:cluster:ci"], "cluster or shared host contracts changed"));
  }
  if (paths.some((path) => /^(?:cluster\/|e2e\/cluster-operator\.spec\.ts$|packages\/cluster-)/u.test(path))) {
    add(commands, command("cluster-e2e", ["pnpm", "test:cluster:e2e"], "cluster runtime behavior changed"));
  }
  if (classifications.official_omp_gate0) {
    add(commands, command("official-lifecycle", ["pnpm", "verify:official-omp-lifecycle"], "official OMP lifecycle inputs changed"));
    add(commands, command("official-packaged", ["pnpm", "verify:official-omp-packaged"], "packaged host or official OMP inputs changed"));
  }
  if (classifications.continuity) {
    add(commands, command(
      "bridge-continuity",
      ["pnpm", "test:legacy-bridge-continuity"],
      "bridge continuity inputs changed",
      ["T4_OMP_SOURCE_DIR"],
    ));
  }
  if (classifications.android_debug) {
    add(commands, command(
      "android-debug",
      ["pnpm", "--filter", "@t4-code/mobile", "check:android:debug"],
      "mobile, web, client, or host-wire behavior changed",
    ));
  }

  const recognized = paths.every((path) =>
    /^(?:\.github\/|\.woodpecker\.yml$|apps\/|cluster\/|compat\/|deploy\/|docs\/|e2e\/|packages\/|provenance\/|scripts\/|Taskfile\.yml$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/u.test(path),
  );
  if (!recognized) add(commands, command("full-test", ["pnpm", "test"], "an affected path has no narrower verified mapping"));

  return { paths, classifications, commands };
}

function gitPaths(args) {
  const result = spawnSync("git", ["-C", repoRoot, ...args], { encoding: "buffer" });
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8").trim() || `git ${args.join(" ")} failed`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

export function changedPaths(base = "origin/main") {
  return [...new Set([
    ...gitPaths(["diff", "--name-only", "-z", `${base}...HEAD`]),
    ...gitPaths(["diff", "--name-only", "-z"]),
    ...gitPaths(["diff", "--cached", "--name-only", "-z"]),
    ...gitPaths(["ls-files", "--others", "--exclude-standard", "-z"]),
  ])];
}

function parseArguments(argv) {
  const options = { base: "origin/main", run: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--run") options.run = true;
    else if (value === "--json") options.json = true;
    else if (value === "--base") options.base = argv[++index];
    else throw new Error(`unknown option: ${value}`);
  }
  if (!options.base) throw new Error("--base requires a git revision");
  return options;
}

function runPlan(plan) {
  for (const item of plan.commands) {
    const missing = item.requiredEnvironment.filter((name) => !process.env[name]);
    if (missing.length > 0) throw new Error(`${item.id} requires ${missing.join(", ")}`);
    process.stderr.write(`[verify:affected] ${item.id}: ${item.reason}\n`);
    const result = spawnSync(item.argv[0], item.argv.slice(1), { cwd: repoRoot, env: process.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${item.id} failed with exit code ${result.status ?? "unknown"}`);
  }
}

export function formatAffectedPlan(plan) {
  const lines = [`Affected paths (${plan.paths.length}):`, ...plan.paths.map((path) => `  ${path}`), "", "Selected checks:"];
  if (plan.commands.length === 0) lines.push("  none");
  for (const item of plan.commands) {
    const requirement = item.requiredEnvironment.length > 0 ? ` [requires ${item.requiredEnvironment.join(", ")}]` : "";
    lines.push(`  ${item.argv.join(" ")}${requirement}`, `    ${item.reason}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = planAffectedVerification(changedPaths(options.base));
  process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : formatAffectedPlan(plan));
  if (options.run) runPlan(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
