# T4 cluster operational runbooks

Local, provider-neutral runbooks for the portable `t4-cluster` chart. They
assume the architecture, API, and storage contracts documented in
`docs/CLUSTER_OPERATOR.md` and change none of them.

| Runbook | Use when |
|---|---|
| [cluster-install.md](cluster-install.md) | Installing the control plane for the first time in a namespace |
| [cluster-upgrade.md](cluster-upgrade.md) | Moving an installed release to a new additive CRD schema and digest set |
| [cluster-rollback.md](cluster-rollback.md) | Returning workloads to the previous known-compatible revision |
| [cluster-backup-restore.md](cluster-backup-restore.md) | Taking a quiesced checkpoint, or restoring workspace and runtime-state volumes |
| [cluster-fencing.md](cluster-fencing.md) | A runtime will not attach, reports `FenceUncertain`, or a generation must be replaced |
| [cluster-identity-rotation.md](cluster-identity-rotation.md) | Rotating gateway identity, SSH host/CA/authorized keys, provider assertions, or provider credentials |
| [cluster-retained-state-reinstall.md](cluster-retained-state-reinstall.md) | Reinstalling the release on top of retained workspaces and CRDs |
| [cluster-uninstall.md](cluster-uninstall.md) | Removing the release cleanly and accounting for everything left behind |
| [cluster-retention-and-destructive-effects.md](cluster-retention-and-destructive-effects.md) | Before any deletion: exactly what each operation destroys and what it keeps |

## Rules that apply to every runbook

1. **One authority.** Kubernetes owns infrastructure desired state. OMP owns
   sessions, agent ids and parentage, lifecycle, turns, prompts, approvals,
   jobs, IRC, artifacts, terminals, browser commands, cancellation, and
   takeover through `t4-omp-authority/1`. No runbook step patches OMP state
   through Kubernetes.
2. **CRDs are separate.** Helm never administers a CustomResourceDefinition.
   Every Helm invocation passes `--skip-crds` and runs through
   `scripts/cluster-ci/crd-lifecycle.sh`.
3. **Fail closed.** If a readiness, source, compatibility, ownership, fencing,
   or acknowledgement check is unavailable, stop. Do not patch status, relabel a
   crash-consistent snapshot, force-detach storage, or delete a source object to
   make a step proceed.
4. **Never force.** `kubectl replace --force`, `helm upgrade --force`,
   `argocd app sync --force|--replace`, and Flux `force: true` all delete and
   recreate live objects. None of them is a recovery tool here.
5. **Name the target.** Every destructive command in these runbooks names an
   exact namespace and object. Verify the active context first:
   `kubectl config current-context`.
6. **Record the digest set.** Rollback is only possible if the previous
   controller, server, session-runtime, and OMP digests were recorded together.
   See `compat/portable-distribution-v1.json`.
7. **Targets are not measurements.** Startup and failover numbers in
   `compat/cluster-slo-evidence-v1.json` are targets until a run records
   observations with full metadata. Never quote a target as an observation.

## Proving the lifecycle locally

`scripts/cluster-ci/release-lifecycle.sh --plan` prints the exact scenario plan
and performs no cluster request. `--run` executes fresh install, additive
upgrade, rollback, retained-state reinstall, clean uninstall, separately ordered
CRDs, optional adapters, and the capability render matrix against a disposable
cluster. `scripts/cluster-ci/chart-capabilities.mjs` proves that every
capability the chart advertises has a scenario, offline.

## Offline gates

All three are read-only, need no cluster, and fail closed.

| Gate | Command | Fails when |
|---|---|---|
| Capability contract | `pnpm check:cluster:capabilities` | A capability names an undefined values path, an optional adapter defaults to enabled, a rendered kind exists in no template, a required lifecycle scenario is missing, or a scenario proves nothing |
| Distribution compatibility | `pnpm check:cluster:distribution` | Chart identity, the CRD API surface, or a deployment adapter directory disagrees with `compat/portable-distribution-v1.json`; a null has no stated reason; a recorded image set is incomplete or tag-based; a carried upstream delta has no removal condition; a named harness or runbook does not exist |
| SLO evidence | `pnpm check:cluster:slo` | An unmeasured entry carries a number, a measured entry is missing its environment, iteration count, timeout, raw artifact, source commit, or image digests, or a target has no observation at all |

`pnpm check:cluster:distribution-all` runs all three. `pnpm cluster:package-chart`
packages the chart locally and records the archive digest; it never contacts a
registry.

## Measuring startup and failover

`scripts/cluster-ci/measure-slo.sh --plan` prints the scenarios and the required
environment without touching a cluster. `--run SCENARIO` writes raw per-iteration
samples under `artifacts/cluster-slo/` and hands them to
`scripts/cluster-ci/summarize-slo-run.mjs`, which emits observation entries only
if they would validate against `compat/cluster-slo-evidence-v1.json`.

That summarizer refuses to produce a number when any iteration did not complete,
when a correctness iteration reported no `invariant=held` or `invariant=violated`
verdict, or when the ledger has not yet recorded the source commit, the image
digests, and the environment the run happened in. In each case it emits an
`unmeasured` entry naming the blocker. Nothing writes to the ledger
automatically: pasting the observation in is a deliberate human act.
