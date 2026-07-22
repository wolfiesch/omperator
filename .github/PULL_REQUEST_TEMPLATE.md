## What this changes

<!-- Describe one coherent outcome and why it matters. -->

## Risk and rollout

<!-- Note compatibility, migration, release, security, or rollback concerns. Write "None" when genuinely none. -->

## How you verified it

<!-- Commands you ran and what you saw. "Ran X, saw Y" beats "should work." -->

## Checklist

- [ ] `pnpm check` passes (release contract, provenance, lint, typecheck)
- [ ] `pnpm test` passes; new behavior has a test that fails without this change
- [ ] User-facing or architectural changes update the relevant docs, ADR, or release notes
- [ ] Any pasted logs or screenshots are redacted: no secrets, tokens, pairing codes, or private paths
- [ ] Ported code (T3 Code / OMP) follows the provenance rules in `THIRD_PARTY_NOTICES.md`
