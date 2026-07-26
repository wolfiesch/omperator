# Settings surface coverage manifest

`coverage.json` is the partition of OMP's setting-path space across Omperator's settings pages and the
named sections inside them. It is the artifact [`../SETTINGS_SURFACE_SPEC.md`](../SETTINGS_SURFACE_SPEC.md)
sections 5.2 and 5.3 describe, and it is the seed for
`apps/web/src/features/settings/route-map.ts`.

One manifest drives three things: the rail (groups and pages), the page body (section order and
headings), and the key-to-row assignment.

## Contract

Every setting path the pinned OMP runtime publishes must be owned by exactly one **section** of
exactly one page.

Resolution is two-tier:

1. Sections whose `claims.exact` contains the key. More than one section is an error.
2. If none matched, sections whose `claims.prefixes` match. More than one section is an error.
3. Zero matches at both tiers is an error.

Exact claims win over prefix claims, so a narrow key can be pulled out of a broad prefix without
reordering anything. First-match-wins prefix ordering is deliberately not used: it lets a broad prefix
shadow a narrower one invisibly.

Prefixes are authoring shorthand for a namespace that genuinely belongs in one section (`edit.`,
`retry.`, `statusLine.`). They are never a catch-all. `keys` on each section is the committed
expansion of `claims` against the pinned schema, so a key added upstream shows up as a reviewable
diff naming the section it landed in rather than being silently absorbed. Do not hand-edit `keys`,
and do not add a section whose only job is to swallow unclaimed paths: the checker fails any section
whose expansion is empty. Two such sections existed in an earlier draft and were removed.

## Provenance of the current file

Generated 2026-07-25 from the union of two schemas, so a runtime pin bump does not invalidate it:

| Source | Keys |
|---|---:|
| `can1357/oh-my-pi` `packages/coding-agent/src/config/settings-schema.ts` (upstream, matches `omp config list --json` on omp 17.1.3) | 439 |
| `wolfiesch/oh-my-pi` `packages/coding-agent/src/config/settings-schema.ts` (the pinned fork that ships in Omperator) | 421 |
| union, which this manifest partitions | 447 |

The two schemas differ on 34 keys. Reporting only the net figure of -18 would hide the extras, so the
manifest records both directions:

- `schemaUniverse.upstreamOnly` (26) exist upstream but not in the pinned fork. The GUI cannot
  surface them until the pin advances. They include all five `computer.*` keys, `bash.patterns`,
  `providers.webSearchOrder`, `providers.imageOrder`, and `workspace.additionalDirectories`.
- `schemaUniverse.forkOnly` (8) exist only in the pinned fork: four `appserver.remote*` keys, two
  fork-local task keys (`task.maxNestedConcurrency`, `task.nestedEager`), and the two
  upstream-removed legacy enums `providers.image` and `providers.webSearch`, which upstream replaced
  with the `*Order` arrays. These render today and disappear on a pin bump.

## Regenerating

Not yet automated. `scripts/gen-settings-coverage.mjs` and `scripts/check-settings-coverage.mjs` are
Phase 1 deliverables.

### Two inputs, not one

The manifest partitions the union of two schemas, so the generator needs both. Expanding against the
pinned schema alone would silently drop the 26 upstream-only keys from every `keys` array, and the
guarantee that a newly added upstream key surfaces as a reviewable diff would be false: it would
surface only later, when the pin advanced.

| Input | Role | Consequence if omitted |
|---|---|---|
| pinned fork schema | source of truth for what the GUI can actually render | the manifest cannot mark a page as renderable today |
| upstream schema snapshot | lets sections pre-claim keys the pin has not reached | upstream additions become invisible until a pin bump |

Both belong in a checked-in `schema-snapshot.json` next to this file, carrying each schema's key list
plus the commit SHA it came from. That keeps generation and CI deterministic and offline, and makes a
refresh an explicit, reviewable commit rather than a network call whose result changes under you.
Refreshing the snapshot is its own script and its own diff.

### Where each schema comes from

Still open, and the options have real tradeoffs:

- **`omp config list --json` against the bundled runtime.** Exactly what the app sees, including
  runtime-computed defaults. Requires the pinned binary in CI.
- **Parsing `settings-schema.ts`.** No binary needed, but it reparses TypeScript and can drift from
  what the authority actually publishes after its own filtering.
- **A schema dump published by the bridge at release time.** Deterministic, at the cost of one more
  release artifact to keep current.

Pick one per input in Phase 1 and record it here. The upstream side additionally needs a refresh
cadence, since nothing forces it to stay current.

### What CI enforces

Regenerate and require an empty diff. That fails on a key in **either** schema that no section claims,
on a double claim, and on a section whose expansion is empty. Drift between the two schemas is
reported rather than failed, because the pin advances on its own schedule.

Until the scripts land, treat `coverage.json` as reviewed input rather than generated output, and do
not hand-edit `keys`.
