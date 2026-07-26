import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { applyExpansion, auditCoverage, checkSettingsCoverage, renderRouteMap, resolveKey, schemaUniverse } from "./check-settings-coverage.mjs";
import { settingsSchemaKeys } from "./settings-schema-keys.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const snapshot = (...keys) => ({ sources: [{ id: "pinned", keys }] });

function manifest(sections, { group = "agent", page = "agent/models" } = {}) {
  return {
    groups: [{ id: group, label: "Agent" }],
    pages: [
      {
        id: page,
        group,
        label: "Models",
        sections: sections.map(({ label, exact = [], prefixes = [], keys = [] }) => ({
          label,
          claims: { exact, prefixes },
          keys,
        })),
      },
    ],
  };
}

const failuresFor = (coverage, snap) => auditCoverage(coverage, snap).failures;

test("the committed manifest owns every path in the committed snapshot", async () => {
  const result = await checkSettingsCoverage(ROOT);
  assert.deepEqual(result.failures, []);
  assert.ok(result.universe.length > 400, `expected a realistic universe, saw ${result.universe.length}`);
});

test("the union spans every snapshot source, not just the shipped pin", () => {
  const universe = schemaUniverse({
    sources: [
      { id: "pinned", keys: ["a", "shared"] },
      { id: "official", keys: ["shared"] },
      { id: "upstream-tip", keys: ["shared", "b"] },
    ],
  });
  assert.deepEqual(universe, ["a", "b", "shared"]);
});

test("a snapshot with no sources is a hard error, never an empty universe", () => {
  assert.throws(() => schemaUniverse({ sources: [] }), /no sources/u);
});

test("an unclaimed path fails instead of being absorbed", () => {
  const coverage = manifest([{ label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] }]);
  const failures = failuresFor(coverage, snapshot("modelRoles", "brandNewSetting"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /brandNewSetting: no section claims this path/u);
});

test("exact claims win over a prefix claim so a narrow key can leave a broad namespace", () => {
  const sections = [
    { label: "Retry", prefixes: ["retry."], keys: ["retry.enabled"] },
    { label: "Fallback", exact: ["retry.fallbackChains"], keys: ["retry.fallbackChains"] },
  ];
  const failures = failuresFor(manifest(sections), snapshot("retry.enabled", "retry.fallbackChains"));
  assert.deepEqual(failures, []);
});

test("two exact claims on one path fail rather than resolving by order", () => {
  const sections = [
    { label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] },
    { label: "Routing", exact: ["modelRoles"], keys: [] },
  ];
  const failures = failuresFor(manifest(sections), snapshot("modelRoles"));
  assert.ok(failures.some((failure) => /modelRoles: claimed exactly by/u.test(failure)));
});

test("overlapping prefixes fail rather than shadowing silently", () => {
  const sections = [
    { label: "Mental models", prefixes: ["hindsight.mentalModel"], keys: [] },
    { label: "Everything else", prefixes: ["hindsight."], keys: [] },
  ];
  const failures = failuresFor(manifest(sections), snapshot("hindsight.mentalModelsEnabled"));
  assert.ok(failures.some((failure) => /overlapping prefixes/u.test(failure)));
});

test("a section whose claims expand to nothing fails as a catch-all in waiting", () => {
  const sections = [
    { label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] },
    { label: "Future", prefixes: ["providers."], keys: [] },
  ];
  const failures = failuresFor(manifest(sections), snapshot("modelRoles"));
  assert.ok(failures.some((failure) => /Future: claims expand to no key/u.test(failure)));
});

test("stale committed keys fail and name what drifted", () => {
  const sections = [{ label: "Roles", prefixes: ["model"], keys: ["modelRoles"] }];
  const failures = failuresFor(manifest(sections), snapshot("modelRoles", "modelTags"));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /committed keys are stale \(\+modelTags\)/u);
});

test("regeneration fixes staleness and leaves claims untouched", () => {
  const coverage = manifest([{ label: "Roles", prefixes: ["model"], keys: ["modelRoles"] }]);
  const snap = snapshot("modelRoles", "modelTags");
  applyExpansion(coverage, auditCoverage(coverage, snap).expansion);
  assert.deepEqual(coverage.pages[0].sections[0].keys, ["modelRoles", "modelTags"]);
  assert.deepEqual(coverage.pages[0].sections[0].claims, { exact: [], prefixes: ["model"] });
  assert.deepEqual(failuresFor(coverage, snap), []);
});

test("structure violations are reported without needing a schema", () => {
  const coverage = manifest([{ label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] }], { page: "agent/models/deep" });
  assert.ok(failuresFor(coverage, snapshot("modelRoles")).some((f) => /page id must be exactly group\/page/u.test(f)));

  const orphan = manifest([{ label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] }], { page: "tools/models" });
  assert.ok(failuresFor(orphan, snapshot("modelRoles")).some((f) => /id does not start with its group/u.test(f)));

  const empty = manifest([{ label: "Nothing" }, { label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] }]);
  assert.ok(failuresFor(empty, snapshot("modelRoles")).some((f) => /section claims nothing/u.test(f)));
});

test("resolveKey reports the owner for a single claim", () => {
  const sections = [{ label: "a", page: "p", claims: { exact: [], prefixes: ["edit."] }, node: {} }];
  assert.equal(resolveKey("edit.mode", sections).owner, sections[0]);
  assert.match(resolveKey("read.mode", sections).failure, /no section claims/u);
});

// ── schema parsing ───────────────────────────────────────────────────────────

const schemaSource = (body) => `export const SETTINGS_SCHEMA = {\n${body}\n} as const;\n`;
const padding = Array.from({ length: 320 }, (_, index) => `\tpad${index}: { type: "boolean", default: false },`).join("\n");

test("a glob inside a description does not open a block comment", () => {
  // The literal `/*` in `src/**/*.ts` swallowed the rest of the file before
  // the stripper became string-aware.
  const source = schemaSource(
    [`\t"rules.globs": { type: "array", default: [], ui: { description: "matches src/**/*.ts" } },`, padding].join("\n"),
  );
  const { keys, failures } = settingsSchemaKeys(source);
  assert.deepEqual(failures, []);
  assert.ok(keys.includes("rules.globs"));
  assert.equal(keys.length, 321);
});

test("commented-out entries are not counted", () => {
  const source = schemaSource(
    [`\t// "ghost.setting": { type: "boolean", default: false },`, `\t/* "block.ghost": { type: "boolean" } */`, padding].join("\n"),
  );
  const { keys } = settingsSchemaKeys(source);
  assert.ok(!keys.includes("ghost.setting"));
  assert.ok(!keys.includes("block.ghost"));
});

test("an implausibly small or unterminated parse is reported, never returned as data", () => {
  const small = settingsSchemaKeys(schemaSource(`\tonly: { type: "boolean", default: false },`));
  assert.ok(small.failures.some((failure) => /expected at least 300/u.test(failure)));

  const unterminated = settingsSchemaKeys(`export const SETTINGS_SCHEMA = {\n${padding}\n`);
  assert.ok(unterminated.failures.some((failure) => /never terminated/u.test(failure)));

  const missing = settingsSchemaKeys("export const SOMETHING_ELSE = {};");
  assert.deepEqual(missing.keys, []);
  assert.ok(missing.failures.some((failure) => /not found/u.test(failure)));
});

test("duplicate schema keys are reported", () => {
  const source = schemaSource([`\tdupe: { type: "boolean", default: false },`, `\tdupe: { type: "boolean", default: true },`, padding].join("\n"));
  const { failures } = settingsSchemaKeys(source);
  assert.ok(failures.some((failure) => /duplicate schema key: dupe/u.test(failure)));
});

// ── generated route map ──────────────────────────────────────────────────────

test("the committed route map matches a fresh render", async () => {
  const coverage = JSON.parse(await readFile(path.join(ROOT, "docs/settings-surface/coverage.json"), "utf8"));
  const committed = await readFile(path.join(ROOT, "apps/web/src/features/settings/route-map.ts"), "utf8");
  assert.equal(committed, renderRouteMap(coverage));
});

test("the route map carries every page, section, and key from the manifest", () => {
  const coverage = manifest([
    { label: "Roles", exact: ["modelRoles"], keys: ["modelRoles"] },
    { label: "Reasoning", prefixes: ["thinkingBudgets."], keys: ["thinkingBudgets.low"] },
  ]);
  coverage.pages[0].template = "form+collection";
  coverage.pages[0].visibleWhen = "advisorEnabled";
  coverage.pages[0].collections = ["agent"];
  const rendered = renderRouteMap(coverage);
  assert.match(rendered, /id: "agent\/models"/u);
  assert.match(rendered, /template: "form\+collection"/u);
  assert.match(rendered, /visibleWhen: "advisorEnabled"/u);
  assert.match(rendered, /collections: \["agent"\]/u);
  assert.match(rendered, /label: "Reasoning"/u);
  assert.match(rendered, /"thinkingBudgets\.low"/u);
  assert.match(rendered, /export function routeForSetting/u);
});

test("a page with no sections renders an empty array rather than invalid syntax", () => {
  const coverage = { groups: [{ id: "system", label: "System", summary: "" }], pages: [{ id: "system/hosts", group: "system", label: "Hosts", template: "collection", collections: [], sections: [] }] };
  assert.match(renderRouteMap(coverage), /sections: \[\],/u);
});
