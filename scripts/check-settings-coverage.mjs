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
export const ROUTE_MAP_RELATIVE_PATH = "apps/web/src/features/settings/route-map.ts";

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

const TS_HEADER = `// Generated from ${COVERAGE_RELATIVE_PATH} by scripts/check-settings-coverage.mjs.
// Do not edit. Run \`node scripts/check-settings-coverage.mjs --write\` to regenerate.
//
// This is the settings information architecture: the rail's groups and pages,
// the named sections inside each page, and which OMP setting path belongs to
// which section. It replaces deriving sections from the host's \`ui.tab\`, which
// left every untabbed key in one unlabelled bucket.
`;

const quote = (value) => JSON.stringify(value);

/** Render the manifest as a typed module the renderer imports. */
export function renderRouteMap(coverage) {
  const lines = [TS_HEADER];
  lines.push(`export interface SettingsRouteGroup {
  readonly id: string;
  readonly label: string;
  readonly summary: string;
}

export interface SettingsRouteSection {
  readonly label: string;
  readonly keys: readonly string[];
}

export type SettingsPageTemplate = "form" | "collection" | "action" | "form+collection" | "form+action";

export interface SettingsRoutePage {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly template: SettingsPageTemplate;
  /** Named runtime predicate that must hold for this page to appear in the rail. */
  readonly visibleWhen?: string;
  /** Resource kinds this page edits through \`config.resource.*\`. */
  readonly collections: readonly string[];
  readonly sections: readonly SettingsRouteSection[];
}
`);
  lines.push(
    `export const SETTINGS_GROUPS: readonly SettingsRouteGroup[] = [\n${(coverage.groups ?? [])
      .map((group) => `  { id: ${quote(group.id)}, label: ${quote(group.label)}, summary: ${quote(group.summary ?? "")} },`)
      .join("\n")}\n];\n`,
  );
  const pages = (coverage.pages ?? []).map((page) => {
    const sections = page.sections
      .map(
        (section) =>
          `      {\n        label: ${quote(section.label)},\n        keys: [${section.keys
            .map((key) => `\n          ${quote(key)},`)
            .join("")}\n        ],\n      },`,
      )
      .join("\n");
    return [
      "  {",
      `    id: ${quote(page.id)},`,
      `    group: ${quote(page.group)},`,
      `    label: ${quote(page.label)},`,
      `    template: ${quote(page.template)},`,
      ...(page.visibleWhen ? [`    visibleWhen: ${quote(page.visibleWhen)},`] : []),
      `    collections: [${(page.collections ?? []).map((kind) => quote(kind)).join(", ")}],`,
      page.sections.length === 0 ? "    sections: []," : `    sections: [\n${sections}\n    ],`,
      "  },",
    ].join("\n");
  });
  lines.push(`export const SETTINGS_PAGES: readonly SettingsRoutePage[] = [\n${pages.join("\n")}\n];\n`);
  lines.push(`const ROUTE_BY_PATH = new Map<string, { readonly page: SettingsRoutePage; readonly section: SettingsRouteSection }>(
  SETTINGS_PAGES.flatMap((page) => page.sections.flatMap((section) => section.keys.map((key) => [key, { page, section }] as const))),
);

/** The single home of one OMP setting path, or undefined when no section claims it. */
export function routeForSetting(path: string): { readonly page: SettingsRoutePage; readonly section: SettingsRouteSection } | undefined {
  return ROUTE_BY_PATH.get(path);
}

/** Every setting path the manifest accounts for. */
export function routedSettingPaths(): readonly string[] {
  return [...ROUTE_BY_PATH.keys()];
}
`);
  return lines.join("\n");
}

export async function checkSettingsCoverage(root = process.cwd(), { write = false } = {}) {
  const coveragePath = path.join(root, COVERAGE_RELATIVE_PATH);
  const routePath = path.join(root, ROUTE_MAP_RELATIVE_PATH);
  const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  const snapshot = JSON.parse(await fs.readFile(path.join(root, SNAPSHOT_RELATIVE_PATH), "utf8"));
  let result = auditCoverage(coverage, snapshot);
  if (write) {
    applyExpansion(coverage, result.expansion);
    await fs.writeFile(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`);
    await fs.writeFile(routePath, renderRouteMap(coverage));
    result = { ...auditCoverage(coverage, snapshot), universe: result.universe };
    return { ...result, wrote: true };
  }
  // The route map is derived too, so a stale one is the same class of failure
  // as a stale `keys` array: regenerate and the diff must be empty.
  const expected = renderRouteMap(coverage);
  const actual = await fs.readFile(routePath, "utf8").catch(() => null);
  if (actual === null) result.failures.push(`${ROUTE_MAP_RELATIVE_PATH}: missing; rerun with --write`);
  else if (actual !== expected) result.failures.push(`${ROUTE_MAP_RELATIVE_PATH}: stale; rerun with --write`);
  return { ...result, wrote: false };
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const result = await checkSettingsCoverage(process.cwd(), { write });
  console.log(formatReport(result, result.universe));
  if (result.wrote) console.log(`\nwrote ${COVERAGE_RELATIVE_PATH}`);
  if (result.failures.length) process.exitCode = 1;
}
