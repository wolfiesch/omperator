# GitHub operations

This document is the operating contract for `wolfiesch/omperator`. Repository
settings should match it; changes to the contract land through pull requests.

## Repository model

- `main` is the only integration and release branch.
- `origin` is `wolfiesch/omperator` and is authoritative for product work.
- `upstream` is the original `LycaonLLC/t4-code` repository and is fetch-only in
  the canonical local checkout. Upstream changes are selected deliberately and
  imported through ordinary reviewed pull requests. There is no automatic sync.
- `can1357/oh-my-pi` remains the upstream runtime project. OMP runtime updates
  follow the pinned compatibility and provenance contracts already in this repo.

## Access levels

Use the least privilege that lets someone do their job:

| Role | Intended use |
| --- | --- |
| Admin | Product owner only; access, security, signing, and repository settings |
| Maintain | Core collaborator who can triage, review, merge, and manage ordinary repository work |
| Write | Regular implementation collaborator who works through pull requests |
| Triage | Issue and pull-request management without code write access |

New core collaborators should normally start with **Write**. Promote to
**Maintain** after the merge/release workflow has been exercised together. Do
not grant Admin for ordinary development.

## Protected `main`

The GitHub protection rule for `main` should enforce:

- pull requests for non-admin collaborators;
- one approval from someone other than the author, with stale approvals
  dismissed after new commits;
- CODEOWNER review requests for protected product, release, security, and
  provenance paths, without making CODEOWNER approval a branch-protection gate;
- the aggregate `verify` CI check;
- resolved review conversations;
- no force pushes or branch deletion.

The product owner retains the admin bypass for releases and emergency recovery.
Routine owner changes still use pull requests and independent maintainer review
so CI and review history remain visible. A product-owner-authored change to a
CODEOWNERS path therefore needs another maintainer's approval, not an admin
bypass or an impossible self-approval.

## Issues, proposals, and labels

Bug reports, feature requests, and questions use structured issue forms. Product
or architecture decisions receive the `proposal` label and end with a written
decision before implementation diverges.

`.github/labels.json` is the label source of truth. The `Sync repository labels`
workflow applies it after changes reach `main`. Labels are intentionally compact:
type, priority, platform, and product area. Do not reproduce OMP's provider-scale
taxonomy unless Omperator actually develops that breadth.

OMP's vouch gate is intentionally not copied. It is useful for a mature project
with sustained untrusted pull-request volume. Omperator should add such a gate
only after ordinary review and moderation become a repeated burden.

## Dependencies

Dependabot checks the pnpm workspace, Go cluster operator, and pinned GitHub
Actions. Scheduled version-update pull requests are temporarily disabled with
`open-pull-requests-limit: 0`; GitHub's separate security-update allowance stays
active. This prevents broad mechanical upgrades from violating toolchain,
release-consistency, or minimum-package-age contracts while the inherited
dependency baseline is repaired deliberately.

Security updates must pass the same `verify` gate as product changes. Re-enable
scheduled version updates one ecosystem at a time only after its current update
set passes locally, and keep major upgrades in individual pull requests.

## CI and merges

The `verify` job is the stable required check. It aggregates core, OMP
continuity, official OMP platform, cluster, tooling, and Android lanes while
allowing path-irrelevant lanes to skip. Do not require every matrix job directly;
that would make path-based CI brittle.

Enable automatic head-branch updates and delete merged branches. Prefer squash
merges for ordinary feature work; use a merge commit only when preserving a
multi-commit import or provenance boundary materially helps future auditing.

## Releases

Release tags are immutable and must point to a commit reachable from `main` with
successful exact-SHA CI. The release workflow owns packaging and publication.
macOS notarization, Android signing, updater metadata, deployment credentials,
and GitHub environments remain owner-controlled.

Until Omperator's application identifiers and artifacts are rebranded, do not
publish a new stable tag from this repository. Existing T4 release tags and
artifacts remain historical upstream records rather than Omperator releases.
