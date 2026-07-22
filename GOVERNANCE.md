# Governance

Omperator is a maintainer-led project with one accountable product owner. The
goal is fast collaboration without reopening settled product direction in every
pull request.

## Roles

- **Product owner / BDFL:** `@wolfiesch` owns product direction, architecture,
  repository access, releases, and final decisions when consensus does not form.
- **Maintainers:** trusted collaborators may triage issues, review and merge
  ordinary pull requests, and own defined subsystems. Maintainer access does not
  include changing security, signing, release, or governance boundaries without
  product-owner approval.
- **Contributors:** anyone may open an issue or a pull request. Merge access is
  earned through sustained, trustworthy work rather than a single contribution.

## Product baseline

- Electron and React are the production client until a replacement reaches
  explicit feature, reliability, packaging, and release parity.
- Native Swift work may proceed as an isolated experiment against stable host
  contracts. It does not replace the production client by default.
- OMP remains the runtime authority. Omperator owns the workspace, host,
  orchestration, client, and release experience around that runtime boundary.

Changing one of these baselines requires a `proposal` issue, a written decision,
and product-owner approval.

## Change and merge flow

1. Work happens on a branch and lands through a pull request.
2. Each pull request represents one coherent, independently explainable outcome.
3. The `verify` CI check must pass and review conversations must be resolved.
4. Ordinary changes require one maintainer approval. CODEOWNERS identify areas
   that require product-owner review.
5. Direct pushes to `main` are reserved for the product owner during release or
   emergency recovery. Any emergency change gets a follow-up issue or pull
   request with the missing evidence.

Maintainers may make routine implementation decisions. Cross-cutting product or
architecture changes use a `proposal` issue and, when durable, an ADR under
`docs/adr/`. The product owner makes the final call when needed.

## Security and releases

Security boundaries, signing identities, credentials, public deployment,
release publication, breaking compatibility, and irreversible data changes
require product-owner approval. Vulnerabilities must use private reporting as
described in [SECURITY.md](SECURITY.md).
