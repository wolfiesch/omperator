import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The deploy-site `deploy` job classifies the referenced release and waits for
 * its assets BEFORE it checks out the immutable source and runs
 * `pnpm install --frozen-lockfile`. Those steps therefore run with no
 * node_modules, and a single third-party import anywhere in their module graph
 * aborts the deployment with ERR_MODULE_NOT_FOUND.
 *
 * The install cannot simply move earlier: it installs against the immutable
 * release checkout, and that checkout wipes untracked files. So the boundary is
 * enforced here instead.
 */
const PRE_INSTALL_ENTRYPOINTS = [
  "scripts/check-release-publication.mjs",
  "scripts/wait-for-release-assets.mjs",
];

/**
 * All three literal specifier forms, because any of them is enough to pull a
 * third-party package into the pre-install graph: `from "x"`, a bare
 * side-effect `import "x"`, and a static `import("x")`.
 */
const IMPORT_PATTERNS = [
  /^\s*(?:import|export)[^"']*from\s*["']([^"']+)["']/gmu,
  /^\s*import\s*["']([^"']+)["']/gmu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

function localImportGraph(entrypoint) {
  const visited = new Set();
  const external = new Map();
  const queue = [entrypoint];
  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = readFileSync(resolve(repoRoot, current), "utf8");
    for (const pattern of IMPORT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          external.set(specifier, current);
          continue;
        }
        queue.push(relative(repoRoot, resolve(repoRoot, dirname(current), specifier)));
      }
    }
  }
  return { visited, external };
}

test("scripts that run before dependency installation import only Node builtins", () => {
  for (const entrypoint of PRE_INSTALL_ENTRYPOINTS) {
    const { visited, external } = localImportGraph(entrypoint);
    assert.ok(visited.size >= 1, `${entrypoint} resolved no modules`);
    assert.deepEqual(
      [...external].map(([specifier, importer]) => `${importer} imports ${specifier}`),
      [],
      `${entrypoint} must not reach a third-party import before dependencies are installed`,
    );
  }
});

test("the pre-install entrypoints are the ones the deploy workflow actually runs", () => {
  // A renamed or newly added pre-install step would otherwise silently escape
  // the check above.
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/deploy-site.yml"), "utf8");
  // Scope to the deploy job: the demo job installs first and would otherwise
  // make this look like nothing runs before an install.
  const deployIndex = workflow.indexOf("\n  deploy:");
  assert.ok(deployIndex > 0, "deploy-site must define a deploy job");
  const deployJob = workflow.slice(deployIndex);
  const installIndex = deployJob.indexOf("pnpm install --frozen-lockfile");
  assert.ok(installIndex > 0, "the deploy job must install dependencies");
  const invoked = new Set(
    [...deployJob.slice(0, installIndex).matchAll(/node (scripts\/[\w.-]+\.mjs)/gu)].map(
      (match) => match[1],
    ),
  );
  assert.deepEqual([...invoked].sort(), [...PRE_INSTALL_ENTRYPOINTS].sort());
});

/**
 * The tooling suites name their files explicitly, so a new `scripts/*.test.mjs`
 * is not picked up by anything and silently never runs. That is how a guard
 * test becomes decoration: green CI, zero coverage. Every script test must be
 * reachable from a package script or from a workflow that invokes it directly.
 */
test("every scripts test file is reachable from a configured command", () => {
  const packageScripts = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ).scripts;
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const commands = [...Object.values(packageScripts), workflow].join("\n");
  const referenced = new Set(commands.match(/scripts\/[\w./*-]+\.test\.mjs/gu) ?? []);

  const covers = (candidate) => {
    for (const reference of referenced) {
      if (reference === candidate) return true;
      const wildcard = reference.indexOf("*");
      if (wildcard > 0 && candidate.startsWith(reference.slice(0, wildcard))) return true;
    }
    return false;
  };

  const orphans = [];
  const walk = (directory) => {
    for (const entry of readdirSync(resolve(repoRoot, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".test.mjs") && !covers(child)) orphans.push(child);
    }
  };
  walk("scripts");

  assert.deepEqual(orphans, [], "these test files are never executed by any configured command");
});
