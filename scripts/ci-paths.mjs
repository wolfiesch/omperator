#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const FORCE_ALL = [
  /^package\.json$/u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
];

const GROUP_PATTERNS = Object.freeze({
  continuity: [
    /^\.github\/workflows\/ci\.yml$/u,
    /^\.woodpecker\.yml$/u,
    /^compat\/omp-app-matrix\.json$/u,
    /^packages\/client\/src\//u,
    /^packages\/host-service\/bin\/current-omp-bridge-proof\.ts$/u,
    /^packages\/host-service\/src\//u,
    /^packages\/host-service\/package\.json$/u,
    /^packages\/host-wire\/src\//u,
    /^packages\/host-wire\/package\.json$/u,
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
    /^scripts\/stage-omp-runtime\.mjs$/u,
  ],
  tooling: [
    /^\.github\//u,
    /^compat\//u,
    /^docs\//u,
    /^provenance\//u,
    /^scripts\//u,
    /^packages\/host-(?:daemon|service|wire)\//u,
  ],
  android_debug: [
    /^apps\/(?:mobile|web)\//u,
    /^packages\/(?:client|ui)\//u,
    /^packages\/host-wire\//u,
  ],
});

function normalizePath(path) {
  return path.replace(/^\.\//u, "").replaceAll("\\", "/");
}

export function classifyCiPaths(paths) {
  const normalized = [...new Set(paths.map(normalizePath).filter(Boolean))];
  const all = normalized.some((path) => FORCE_ALL.some((pattern) => pattern.test(path)));
  return Object.fromEntries(
    Object.entries(GROUP_PATTERNS).map(([group, patterns]) => [
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
