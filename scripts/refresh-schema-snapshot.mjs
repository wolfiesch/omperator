#!/usr/bin/env node
// Refresh `docs/settings-surface/schema-snapshot.json`, the committed record of
// every OMP setting path the settings coverage manifest must account for.
//
// There is more than one relevant schema. Omperator ships a pinned fork runtime
// and also supports the official upstream runtime (ADR-019), so a key published
// by either one needs a home in the GUI. Upstream's tip is snapshotted too, so
// sections can pre-claim keys before the pin advances and a new upstream
// setting never arrives unreviewed.
//
// Refs come from `compat/omp-app-matrix.json`, the same manifest the release
// gate trusts. A checkout's mutable HEAD is deliberately not a default:
// snapshotting HEAD would validate coverage against a schema no released build
// ships, and would erase the pin drift this exists to expose.
//
// Checkout locations are arguments and are never recorded. The snapshot stores
// repository slug, tag, and commit only, so no local path reaches the repo.
//
// CI never runs this. It reads the committed snapshot, so the coverage check
// stays deterministic and offline. Refreshing is a human action with its own
// reviewable diff.
//
//   node scripts/refresh-schema-snapshot.mjs \
//     --fork <fork-checkout> --upstream <upstream-checkout> \
//     [--tip-ref origin/main] [--no-tip]

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { settingsSchemaKeys } from "./settings-schema-keys.mjs";

const run = promisify(execFile);

export const SCHEMA_RELATIVE_PATH = "packages/coding-agent/src/config/settings-schema.ts";
export const SNAPSHOT_RELATIVE_PATH = "docs/settings-surface/schema-snapshot.json";
export const MATRIX_RELATIVE_PATH = "compat/omp-app-matrix.json";

const SLUG = /^[\w.-]+\/[\w.-]+$/u;
const byText = (a, b) => a.localeCompare(b);

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) out[flag.slice(2)] = true;
    else {
      out[flag.slice(2)] = next;
      index += 1;
    }
  }
  return out;
}

async function git(checkout, args) {
  const { stdout } = await run("git", args, { cwd: checkout, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** The runtimes the compatibility matrix declares. These are the authority for repo, tag, and commit. */
export async function declaredRuntimes(root) {
  const matrix = JSON.parse(await fs.readFile(path.join(root, MATRIX_RELATIVE_PATH), "utf8"));
  const pick = (entry, label) => {
    if (!entry?.sourceCommit) throw new Error(`${MATRIX_RELATIVE_PATH}: ${label} has no sourceCommit`);
    return {
      repo: (entry.sourceRepository ?? "").replace(/^https:\/\/github\.com\//u, ""),
      tag: entry.sourceTag ?? "",
      commit: entry.sourceCommit,
    };
  };
  return { pinned: pick(matrix.verifiedRuntime, "verifiedRuntime"), official: pick(matrix.officialRuntime, "officialRuntime") };
}

/** Resolve the slug for a ref that names a remote. A bare commit cannot be attributed this way. */
async function slugForRef(checkout, ref) {
  if (!ref.includes("/")) return "";
  const remote = ref.slice(0, ref.indexOf("/"));
  for (const line of (await git(checkout, ["remote", "-v"])).split("\n")) {
    const match = /^(\S+)\s+\S*github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\s/u.exec(line);
    if (match && match[1] === remote) return match[2];
  }
  return "";
}

/**
 * Read one source's schema key set.
 *
 * `declared` carries matrix-declared provenance. When present it is the
 * authority for `repo`, because a bare commit SHA cannot be attributed to a
 * remote, and the resolved commit must match it exactly.
 */
export async function readSource(checkout, { id, role, ref, declared }) {
  const failures = [];
  let source = "";
  try {
    source = await git(checkout, ["show", `${ref}:${SCHEMA_RELATIVE_PATH}`]);
  } catch {
    return { id, role, ref, repo: declared?.repo ?? "", tag: declared?.tag ?? "", commit: "", path: SCHEMA_RELATIVE_PATH, keys: [], failures: [`cannot read ${ref}; fetch the checkout`] };
  }
  const { keys, failures: parseFailures } = settingsSchemaKeys(source);
  failures.push(...parseFailures);
  const commit = (await git(checkout, ["rev-parse", ref])).trim();
  const repo = declared?.repo || (await slugForRef(checkout, ref));
  if (declared?.commit && declared.commit !== commit)
    failures.push(`resolves to ${commit.slice(0, 12)} but the matrix declares ${declared.commit.slice(0, 12)}`);
  if (!repo) failures.push("cannot attribute a repository; pass a remote-qualified ref or declare it in the matrix");
  else if (!SLUG.test(repo)) failures.push(`unexpected repository slug: ${repo}`);
  return { id, role, ref, repo, tag: declared?.tag ?? "", commit, path: SCHEMA_RELATIVE_PATH, keys, failures };
}

/**
 * Build the snapshot. Deterministic: no timestamps, sorted keys, stable order.
 *
 * Two different comparisons are reported and must not be conflated.
 * `exclusiveToSource` is relative to every other source, and answers "does
 * anything only this runtime knows about". `pinVersusTip` is the pairwise gap
 * between the shipped pin and upstream's tip, and answers "how far behind is
 * what we ship". A key can be absent from `exclusiveToSource` while still
 * counting in `pinVersusTip`, because a third source also carries it.
 */
export function buildSnapshot(sources) {
  const union = [...new Set(sources.flatMap((entry) => entry.keys))].sort(byText);
  const exclusiveToSource = {};
  for (const entry of sources) {
    const others = new Set(sources.filter((other) => other !== entry).flatMap((other) => other.keys));
    exclusiveToSource[entry.id] = entry.keys.filter((key) => !others.has(key));
  }
  const pin = sources.find((entry) => entry.id === "pinned");
  const tip = sources.find((entry) => entry.id === "upstream-tip");
  let pinVersusTip;
  if (pin && tip) {
    const pinSet = new Set(pin.keys);
    const tipSet = new Set(tip.keys);
    const missingFromPin = tip.keys.filter((key) => !pinSet.has(key));
    const extraInPin = pin.keys.filter((key) => !tipSet.has(key));
    pinVersusTip = {
      missingFromPin,
      extraInPin,
      differing: missingFromPin.length + extraInPin.length,
      net: pin.keys.length - tip.keys.length,
    };
  }
  return {
    $comment:
      "Generated by scripts/refresh-schema-snapshot.mjs. The settings coverage manifest is expanded against " +
      "the union of every source below, so a key any supported runtime publishes has a home in the GUI. " +
      "Refresh when the runtime pin advances or upstream is re-synced; the diff is the review.",
    sources: sources.map(({ id, role, repo, ref, tag, commit, path: file, keys }) => ({
      id,
      role,
      repo,
      ref,
      tag,
      commit,
      path: file,
      count: keys.length,
      keys,
    })),
    universe: { count: union.length, exclusiveToSource, ...(pinVersusTip ? { pinVersusTip } : {}) },
  };
}
export function formatReport(snapshot, failures) {
  const lines = snapshot.sources.map(
    (entry) =>
      `${entry.id.padEnd(13)} ${entry.repo || "(unattributed)"} ${entry.tag || entry.ref}@${entry.commit.slice(0, 12)}  ` +
      `${String(entry.count).padStart(4)} keys, ${snapshot.universe.exclusiveToSource[entry.id].length} exclusive`,
  );
  lines.push(`union ${snapshot.universe.count}`);
  const drift = snapshot.universe.pinVersusTip;
  if (drift)
    lines.push(
      `pin vs upstream tip: ${drift.missingFromPin.length} missing from pin, ${drift.extraInPin.length} extra in pin, ` +
        `${drift.differing} differing, net ${drift.net}`,
    );
  if (failures.length) lines.push("", ...failures.map((failure) => `FAIL ${failure}`));
  return lines.join("\n");
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const declared = await declaredRuntimes(root);
  if (!args.fork || !args.upstream) {
    console.error(
      "usage: refresh-schema-snapshot.mjs --fork <fork-checkout> --upstream <upstream-checkout> " +
        "[--tip-ref origin/main] [--no-tip]\n" +
        `matrix pins: ${declared.pinned.tag || declared.pinned.commit.slice(0, 12)} (fork), ` +
        `${declared.official.tag || declared.official.commit.slice(0, 12)} (upstream)`,
    );
    process.exit(2);
  }
  const plan = [
    [args.fork, { id: "pinned", role: "shipped fork runtime", ref: declared.pinned.commit, declared: declared.pinned }],
    [args.upstream, { id: "official", role: "supported upstream runtime", ref: declared.official.commit, declared: declared.official }],
  ];
  if (!args["no-tip"])
    plan.push([args.upstream, { id: "upstream-tip", role: "not yet shipped by any pin", ref: args["tip-ref"] ?? "origin/main" }]);

  const sources = [];
  const failures = [];
  for (const [checkout, spec] of plan) {
    const entry = await readSource(checkout, spec);
    sources.push(entry);
    failures.push(...entry.failures.map((failure) => `${entry.id}: ${failure}`));
  }
  const snapshot = buildSnapshot(sources);
  console.log(formatReport(snapshot, failures));
  if (failures.length) process.exit(1);
  await fs.writeFile(path.join(root, SNAPSHOT_RELATIVE_PATH), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`\nwrote ${SNAPSHOT_RELATIVE_PATH}`);
}
