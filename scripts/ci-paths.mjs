#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Selection itself, and the release authority that trusts a run conclusion,
// cannot be graded by the selection they define. A change to any of these must
// be proven by a full run, or a bug in the classifier could pick a narrow set
// of legs, conclude green, and become the baseline that every later run
// inherits from.
const FORCE_ALL = [
  /^\.github\/workflows\/(?:ci|release)\.yml$/u,
  /^package\.json$/u,
  /^patches\//u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /^scripts\/check-release-consistency(?:\.test)?\.mjs$/u,
  /^scripts\/release-consistency\//u,
  /^scripts\/ci-baseline(?:\.test)?\.mjs$/u,
  /^scripts\/ci-paths(?:\.test)?\.mjs$/u,
  /^scripts\/read-bounded-response\.mjs$/u,
  /^scripts\/wait-for-exact-ci(?:\.test)?\.mjs$/u,
];

// Paths that cannot affect any path-gated leg because the unconditional legs
// already cover them: `check` lints and typechecks the workspace, `unit-tests`
// runs every workspace suite, and `build-e2e` builds, drives the end-to-end
// suite, and asserts the packaging contract. A path listed here is a claim
// that those three prove it. Anything not listed here and not claimed by a
// group below fails closed to the full matrix, so an unclassified new
// directory is slow rather than silently unproven.
const NO_IMPACT = [
  /^\.gitignore$/u,
  /^AGENTS\.md$/u,
  /^README\.md$/u,
  /^Taskfile\.yml$/u,
  /^apps\/(?:desktop|site)\//u,
  /^e2e\/(?!cluster-operator\.spec\.ts)/u,
  /^electron-builder\.config\.mjs$/u,
  /^infra\/site\//u,
  /^packages\/(?:fixture-server|service-manager)\//u,
];

const GROUP_PATTERNS = Object.freeze({
  continuity: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^compat\/omp-app-matrix\.json$/u,
    /^packages\/client\/src\//u,
    /^packages\/host-service\/bin\/current-omp-bridge-proof\.ts$/u,
    /^packages\/host-service\/src\//u,
    /^packages\/host-service\/package\.json$/u,
    /^packages\/host-wire\/src\//u,
    /^packages\/host-wire\/package\.json$/u,
    /^packages\/protocol\//u,
    /^provenance\/omp-host-migration\.json$/u,
    /^scripts\/legacy-bridge-continuity(?:\.test)?\.mjs$/u,
    /^scripts\/ci-paths(?:\.test)?\.mjs$/u,
  ],
  cluster: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^\.woodpecker\.yml$/u,
    /^cluster\//u,
    /^deploy\/charts\/t4-cluster\//u,
    /^e2e\/cluster-operator\.spec\.ts$/u,
    /^packages\/cluster-(?:operator|server)\//u,
    /^packages\/host-(?:service|wire)\/(?:src\/|package\.json$)/u,
    /^scripts\/cluster-ci\//u,
  ],
  official_omp_gate0: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^compat\/(?:official-omp-gate0|omp-app-matrix)\.json$/u,
    /^docs\/(?:archive\/flutter-migration\/(?:OMP_T4_CAPABILITY_AUDIT\.md|OMP_T4_CAPABILITY_TRACKER\.csv)|T4_ARCHITECTURE\.html)$/u,
    /^packages\/host-service\/(?:bin\/official-omp-gate0\.ts|package\.json)$/u,
    /^packages\/host-service\/src\/(?:official-omp-profile-authority|rpc-child|server|types)\.ts$/u,
    /^packages\/host-daemon\/(?:bin\/official-omp-packaged-proof\.ts|package\.json|src\/cli\.ts)$/u,
    /^packages\/protocol\//u,
    /^scripts\/stage-omp-runtime\.mjs$/u,
  ],
  tooling: [
    /^\.github\//u,
    /^\.woodpecker\.yml$/u,
    /^compat\//u,
    /^docs\//u,
    /^provenance\//u,
    /^scripts\//u,
    /^packages\/host-(?:daemon|service|wire)\//u,
  ],
  // The maintainer deployment suite spawns ~150 bash fixtures and costs minutes.
  // Its only subject is the ops/t4-maintainer surface, so keep it off the broad
  // tooling trigger and run it when that surface or its harness actually moves.
  maintainer: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^ops\/t4-maintainer\//u,
    /^scripts\/t4-maintainer-/u,
    /^scripts\/test-temporary-directory\.mjs$/u,
  ],
  // The Swift client re-implements the wire contract by hand in
  // apps/ios/HostWire, so a protocol change can compile everywhere and still
  // break the app. host-wire therefore selects this leg alongside the iOS
  // sources themselves.
  ios: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^apps\/ios\//u,
    /^packages\/host-wire\//u,
    /^packages\/protocol\//u,
    /^scripts\/prepare-ios-ci-cache\.mjs$/u,
    /^scripts\/verify-ios\.mjs$/u,
  ],
  android_debug: [
    /^apps\/(?:mobile|web)\//u,
    /^packages\/(?:client|protocol|ui)\//u,
    /^packages\/host-wire\//u,
  ],
});

function normalizePath(path) {
  return path.replace(/^\.\//u, "").replaceAll("\\", "/");
}

export function classifyCiPaths(paths) {
  const normalized = [...new Set(paths.map(normalizePath).filter(Boolean))];
  const groups = Object.entries(GROUP_PATTERNS);
  const all = normalized.some(
    (path) =>
      FORCE_ALL.some((pattern) => pattern.test(path)) ||
      // A path no group claims and no no-impact rule excuses is unclassified.
      // Selection now decides what a merge run proves, so an unclassified path
      // must widen coverage rather than quietly narrow it.
      (!NO_IMPACT.some((pattern) => pattern.test(path)) &&
        !groups.some(([, patterns]) => patterns.some((pattern) => pattern.test(path)))),
  );
  return Object.fromEntries(
    groups.map(([group, patterns]) => [
      group,
      all || normalized.some((path) => patterns.some((pattern) => pattern.test(path))),
    ]),
  );
}

export function formatGitHubOutputs(result) {
  return `${Object.entries(result)
    .map(([name, enabled]) => `${name}=${enabled ? "true" : "false"}`)
    .join("\n")}\n`;
}

async function readChangedPaths() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.includes("\0") ? raw.split("\0").filter(Boolean) : raw.split(/\r?\n/u).filter(Boolean);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const all = process.argv.includes("--all");
  const result = all
    ? Object.fromEntries(Object.keys(GROUP_PATTERNS).map((group) => [group, true]))
    : classifyCiPaths(await readChangedPaths());
  process.stdout.write(formatGitHubOutputs(result));
}
