# Omperator Repository Guidance

## Project identity and provenance

Omperator is a desktop-first observability and control workspace for Oh My Pi (OMP). It presents projects, concurrent sessions, subagents, streaming output, tools, terminals, files, settings, and local or remote execution without replacing OMP as the runtime and state authority.

This repository is an intentionally independent hard fork of [`LycaonLLC/t4-code`](https://github.com/LycaonLLC/t4-code), a repository owned by a friend of the Omperator maintainer. The fork was created so development, architecture, releases, governance, and product direction can proceed in an isolated, separately owned repository without depending on access to or coordination through the friend's repository. Preserve applicable MIT attribution and provenance, but do not assume changes must remain compatible with or be upstreamed to the original repository unless a task explicitly requires it.

The repository and project are called **Omperator**. The shipped application, packages, paths, and documentation still contain the **T4 Code** name. A product rebrand from T4 Code to Omperator is under consideration but remains undecided. Until that decision is explicit, do not perform a broad rename or claim that the public product has been renamed; use Omperator for this repository and use T4 Code where it describes the current application, package, or release identity.

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

## Boundaries that still apply

The absence of users does not make unrelated assets disposable. Continue to protect credentials, repository history, signed release assets, remote infrastructure, third-party services, and personal or irreplaceable data. Existing approval requirements still apply to publishing, deployment, paid operations, security-sensitive changes, and destructive actions outside disposable project state.
