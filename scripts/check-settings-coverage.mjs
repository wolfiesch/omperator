#!/usr/bin/env node
// Verify that every OMP setting path is owned by exactly one named section of
// exactly one settings page.
//
// The manifest at docs/settings-surface/coverage.json declares, per section, an
// `exact` key list and a `prefixes` list. Resolution is two-tier: exact claims
// win, and more than one claim at either tier is an error, as is zero claims.
// First-match-wins prefix ordering is deliberately not used, because a broad
// prefix would shadow a narrower one and the shadowing would be invisible in
// review.
//
// `keys` on each section is derived, not authored: it is the expansion of that
// section's claims against the committed schema snapshot. `--write` recomputes
// it. Without `--write` the script fails on any drift, so a setting added to
// either schema always surfaces as a reviewable manifest diff naming the exact
// section it landed in, and a setting nothing claims fails the build.
//
//   node scripts/check-settings-coverage.mjs            # verify
//   node scripts/check-settings-coverage.mjs --write    # regenerate `keys`

import { promises as fs } from "node:fs";
import path from "node:path";

export const COVERAGE_RELATIVE_PATH = "docs/settings-surface/coverage.json";
export const SNAPSHOT_RELATIVE_PATH = "docs/settings-surface/schema-snapshot.json";

const PAGE_ID = /^[a-z][\w-]*\/[a-z][\w-]*$/u;

function byText(a, b) {
  return a.localeCompare(b);
}
/**
 * Every key any snapshotted runtime publishes.
 *
 * The union spans the shipped fork pin, the supported upstream pin, and
 * upstream's tip, so the manifest covers what ships today and pre-claims what
 * arrives when the pin advances.
 */
export function schemaUniverse(snapshot) {
  const sources = snapshot.sources ?? [];
  if (sources.length === 0) throw new Error(`${SNAPSHOT_RELATIVE_PATH}: no sources; run scripts/refresh-schema-snapshot.mjs`);
  return [...new Set(sources.flatMap((entry) => entry.keys ?? []))].sort(byText);
}

/**
 * Resolve one key to its owning section.
 *
 * @returns {{ owner?: { page: string, section: string }, failure?: string }}
 */
export function resolveKey(key, sections) {
  const exact = sections.filter((entry) => entry.claims.exact.includes(key));
  if (exact.length > 1)
    return { failure: `${key}: claimed exactly by ${exact.map((entry) => entry.label).sort(byText).join(", ")}` };
  if (exact.length === 1) return { owner: exact[0] };
  const prefixed = sections.filter((entry) => entry.claims.prefixes.some((prefix) => key.startsWith(prefix)));
  if (prefixed.length > 1)
    return { failure: `${key}: claimed by overlapping prefixes in ${prefixed.map((entry) => entry.label).sort(byText).join(", ")}` };
  if (prefixed.length === 1) return { owner: prefixed[0] };
  return { failure: `${key}: no section claims this path` };
}

function flatten(coverage) {
  const sections = [];
  for (const page of coverage.pages ?? [])
    for (const section of page.sections ?? [])
      sections.push({
        page: page.id,
        section: section.label,
        label: `${page.id} > ${section.label}`,
        claims: { exact: section.claims?.exact ?? [], prefixes: section.claims?.prefixes ?? [] },
        committed: section.keys ?? [],
        node: section,
      });
  return sections;
}

function structureFailures(coverage) {
  const failures = [];
  const groups = new Set((coverage.groups ?? []).map((group) => group.id));
  if (groups.size !== (coverage.groups ?? []).length) failures.push("duplicate group id");
  const pageIds = new Set();
  for (const page of coverage.pages ?? []) {
    if (!PAGE_ID.test(page.id)) failures.push(`${page.id}: page id must be exactly group/page`);
    if (pageIds.has(page.id)) failures.push(`${page.id}: duplicate page id`);
    pageIds.add(page.id);
    if (!groups.has(page.group)) failures.push(`${page.id}: unknown group ${page.group}`);
    if (!page.id.startsWith(`${page.group}/`)) failures.push(`${page.id}: id does not start with its group`);
    const labels = new Set();
    for (const section of page.sections ?? []) {
      if (labels.has(section.label)) failures.push(`${page.id}: duplicate section ${section.label}`);
      labels.add(section.label);
      const exact = section.claims?.exact ?? [];
      const prefixes = section.claims?.prefixes ?? [];
      if (exact.length === 0 && prefixes.length === 0)
        failures.push(`${page.id} > ${section.label}: section claims nothing`);
    }
  }
  return failures;
}

/**
 * @param {object} coverage parsed coverage.json
 * @param {object} snapshot parsed schema-snapshot.json
 * @returns {{ failures: string[], expansion: Map<object, string[]>, universe: string[] }}
 */
export function auditCoverage(coverage, snapshot) {
  const failures = structureFailures(coverage);
  const sections = flatten(coverage);
  const universe = schemaUniverse(snapshot);
  const expansion = new Map(sections.map((entry) => [entry.node, []]));

  for (const key of universe) {
    const { owner, failure } = resolveKey(key, sections);
    if (failure) failures.push(failure);
    else expansion.get(owner.node).push(key);
  }

  for (const entry of sections) {
    const derived = expansion.get(entry.node).sort(byText);
    if (derived.length === 0)
      failures.push(`${entry.label}: claims expand to no key; a section that owns nothing is a catch-all in waiting`);
    const committed = [...entry.committed].sort(byText);
    if (derived.join("\u0000") !== committed.join("\u0000")) {
      const added = derived.filter((key) => !committed.includes(key));
      const removed = committed.filter((key) => !derived.includes(key));
      const detail = [added.length ? `+${added.join(" +")}` : "", removed.length ? `-${removed.join(" -")}` : ""]
        .filter(Boolean)
        .join(" ");
      failures.push(`${entry.label}: committed keys are stale (${detail}); rerun with --write`);
    }
  }

  failures.sort(byText);
  return { failures, expansion, universe };
}

/** Rewrite the derived `keys` arrays in place. Claims and ordering are untouched. */
export function applyExpansion(coverage, expansion) {
  for (const page of coverage.pages ?? [])
    for (const section of page.sections ?? []) section.keys = (expansion.get(section) ?? []).sort(byText);
  return coverage;
}

export function formatReport(result, universe) {
  const owned = universe.length - result.failures.filter((failure) => failure.includes("no section claims")).length;
  const head = `Checked ${universe.length} setting paths; ${owned} owned; ${result.failures.length} failure${
    result.failures.length === 1 ? "" : "s"
  }.`;
  return result.failures.length ? `${head}\n${result.failures.join("\n")}` : head;
}

export async function checkSettingsCoverage(root = process.cwd(), { write = false } = {}) {
  const coveragePath = path.join(root, COVERAGE_RELATIVE_PATH);
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  const snapshot = JSON.parse(await fs.readFile(path.join(root, SNAPSHOT_RELATIVE_PATH), "utf8"));
  const result = auditCoverage(coverage, snapshot);
  if (write) {
    applyExpansion(coverage, result.expansion);
    await fs.writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
    const rechecked = auditCoverage(coverage, snapshot);
    return { ...rechecked, universe: result.universe, wrote: true };
  }
  return { ...result, wrote: false };
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const result = await checkSettingsCoverage(process.cwd(), { write });
  console.log(formatReport(result, result.universe));
  if (result.wrote) console.log(`\nwrote ${COVERAGE_RELATIVE_PATH}`);
  if (result.failures.length) process.exitCode = 1;
}
