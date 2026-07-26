# Settings surface coverage manifest

Two committed artifacts drive Omperator's settings surface:

| File | What it is |
|---|---|
| `schema-snapshot.json` | every setting path any supported OMP runtime publishes, with provenance |
| `coverage.json` | the partition of those paths across settings pages and their named sections |

`coverage.json` is the artifact [`../SETTINGS_SURFACE_SPEC.md`](../SETTINGS_SURFACE_SPEC.md) sections 5.2
and 5.3 describe, and it is the seed for `apps/web/src/features/settings/route-map.ts`. One manifest
drives three things: the rail (groups and pages), the page body (section order and headings), and the
key-to-row assignment.

## Contract

Every setting path in the snapshot must be owned by exactly one **section** of exactly one page.

Resolution is two-tier:

1. Sections whose `claims.exact` contains the key. More than one section is an error.
2. If none matched, sections whose `claims.prefixes` match. More than one section is an error.
3. Zero matches at both tiers is an error.

Exact claims win over prefix claims, so a narrow key can be pulled out of a broad namespace without
reordering anything. First-match-wins prefix ordering is deliberately not used: it lets a broad prefix
shadow a narrower one invisibly.

Prefixes are authoring shorthand for a namespace that genuinely belongs in one section (`edit.`,
`retry.`, `statusLine.`). They are never a catch-all. `keys` on each section is the committed
expansion of `claims`, so a key added to any source shows up as a reviewable diff naming the section it
landed in rather than being silently absorbed. Do not hand-edit `keys`, and do not add a section whose
only job is to swallow unclaimed paths: the checker fails any section whose expansion is empty.

## Why the snapshot has three sources

Omperator ships a pinned fork runtime and also supports the official upstream runtime (ADR-019), so a
key published by either one needs a home. Upstream's tip is snapshotted as well, so sections can
pre-claim keys before the pin advances.

| Source | Role | Ref |
|---|---|---|
| `pinned` | shipped fork runtime | `verifiedRuntime` in `compat/omp-app-matrix.json` |
| `official` | supported upstream runtime | `officialRuntime` in the same matrix |
| `upstream-tip` | not yet shipped by any pin | `origin/main` in the upstream checkout |

Refs come from the compatibility matrix, the same manifest the release gate trusts. A checkout's
mutable `HEAD` is deliberately not a default: snapshotting HEAD would validate coverage against a
schema no released build ships, and would erase the pin drift this exists to expose.

### Two comparisons, deliberately kept apart

- `universe.exclusiveToSource` answers "does anything only this runtime know about", measured against
  every other source. Currently 6 for `pinned`, 0 for `official`, 20 for `upstream-tip`.
- `universe.pinVersusTip` answers "how far behind is what we ship", measured pairwise between the
  shipped pin and upstream's tip. Currently 26 missing from the pin, 8 extra in it, 34 differing,
  net -18.

A key can be absent from `exclusiveToSource` while still counting in `pinVersusTip`, because a third
source also carries it. Reporting only one of these, or only the net figure, hides real drift.

## Regenerating

```sh
# refresh the snapshot after a pin bump or an upstream re-sync (human action, reviewable diff)
node scripts/refresh-schema-snapshot.mjs --fork <fork-checkout> --upstream <upstream-checkout>

# re-expand the manifest's derived `keys` arrays
node scripts/check-settings-coverage.mjs --write

# verify (runs in `pnpm check` as `pnpm check:settings`)
node scripts/check-settings-coverage.mjs
```

Checkout locations are arguments and are never recorded. The snapshot stores repository slug, tag, and
commit only, so no local path reaches the repository.

CI never runs the refresh script. It reads the committed snapshot, so the coverage check is
deterministic and offline, and needs neither a network call nor an OMP binary.

### Schema source: settled

Each source is read with `git show <ref>:packages/coding-agent/src/config/settings-schema.ts` and
parsed by `scripts/settings-schema-keys.mjs`. The alternatives were `omp config list --json` against a
bundled runtime, which needs the pinned binary in CI, and a release-time schema dump, which adds an
artifact to keep current. Parsing wins because the desktop config authority enumerates
`Object.keys(SETTINGS_SCHEMA)` directly, so the schema's top-level keys are exactly the paths it
publishes.

The parse is indentation-based and therefore fragile against a reformat, so it is guarded: a missing
terminator, a duplicate key, or a result under 300 keys is reported as a failure rather than returned
as data. Brace-depth tracking was tried first and rejected, because regex literals in the file carry
quantifiers like `{40}` that unbalance the count. The comment stripper is string-aware for the same
class of reason: schema descriptions contain glob patterns such as `src/**/*.ts`, and a naive stripper
reads the embedded `/*` as a block comment and swallows the rest of the file. Both failures are
covered by regression tests in `scripts/check-settings-coverage.test.mjs`.

Upstream's tip has no forcing function to stay current. Refresh it when picking up upstream work, and
treat a large `pinVersusTip` as a signal that the pin is overdue rather than as noise.
