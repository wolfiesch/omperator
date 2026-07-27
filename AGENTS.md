# Omperator Repository Guidance

## Project identity and provenance

Omperator is a desktop-first observability and control workspace for Oh My Pi (OMP). It presents projects, concurrent sessions, subagents, streaming output, tools, terminals, files, settings, and local or remote execution without replacing OMP as the runtime and state authority.

This repository is an intentionally independent hard fork of [`LycaonLLC/t4-code`](https://github.com/LycaonLLC/t4-code), a repository owned by a friend of the Omperator maintainer. The fork was created so development, architecture, releases, governance, and product direction can proceed in an isolated, separately owned repository without depending on access to or coordination through the friend's repository. Preserve applicable MIT attribution and provenance, but do not assume changes must remain compatible with or be upstreamed to the original repository unless a task explicitly requires it.

The repository, project, and shipped product are called **Omperator**. The
public application name and release artifacts changed from **T4 Code** in
v0.2.0. Preserve the stable technical identities needed for safe upgrades:
`net.t4code.app`, `t4-code://`, `@t4-code/*`, `t4-omp`, existing service
labels, and the legacy Application Support and log paths. Keep **T4 Code** in
historical provenance and compatibility records where it identifies the
pre-v0.2.0 product or the upstream hard-fork source.

## Current project stage

Omperator currently has no external users, customer data, production workloads, or backward-compatibility commitments. The maintainer's local dogfooding is development usage, not a production user base. Treat local app state and development data as disposable unless a task explicitly says otherwise.

Keep this section true. Update it before onboarding external users, storing irreplaceable data, or operating production workloads.

## Engineering defaults

- Optimize for rapid iteration and the simplest correct end state, not hypothetical-user compatibility.
- Prefer clean cutovers. Update every in-repo caller and remove obsolete paths instead of adding compatibility shims, deprecation periods, dual-write paths, or migration frameworks.
- Reset or replace disposable local development state when that is simpler than preserving it.
- Do not add rollout flags, telemetry, elaborate rollback machinery, or support processes solely for users who do not exist.
- Breaking an internal API, development fixture, or local data format is acceptable when the replacement is complete and the changed behavior is verified.
- Tests and direct smoke checks still protect development velocity. Verify the behavior being changed rather than preserving accidental compatibility.

## Local verification loop

Do not reach for the full repository gates while iterating. `pnpm check` and
`pnpm test` are the pre-pull-request gates, not the inner loop.

- Run `pnpm verify:affected:plan` to preview the checks your changed paths
  select, then `pnpm verify:affected` to run exactly those. Unknown or
  cross-cutting paths fail closed to the full gates.
- Scope work to one package with `vp run --filter @t4-code/<package> <script>`
  (for example `test`, `typecheck`, or `dev`) instead of the recursive
  `pnpm test` and `pnpm typecheck`.
- CI mirrors this split. `check`, `unit-tests`, and `build-e2e` run in
  parallel, and the remaining legs are path-gated by `scripts/ci-paths.mjs`, so
  a local affected run predicts what a pull request will actually execute.
- Reserve `pnpm test:e2e`, `pnpm test:maintainer`, and the bridge continuity
  gates for changes that touch their subject. They cost minutes and CI already
  selects them from the changed paths.

## Boundaries that still apply

The absence of users does not make unrelated assets disposable. Continue to protect credentials, repository history, signed release assets, remote infrastructure, third-party services, and personal or irreplaceable data. Existing approval requirements still apply to publishing, deployment, paid operations, security-sensitive changes, and destructive actions outside disposable project state.
