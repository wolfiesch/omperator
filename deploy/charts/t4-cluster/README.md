# t4-cluster Helm chart

Default-off portable control plane for T4 workspaces and one-session runtime
pods. Kubernetes owns infrastructure desired state only; OMP remains the sole
authority for sessions, agent ids and parentage, lifecycle, turns, prompts,
approvals, jobs, IRC, artifacts, terminals, browser commands, cancellation, and
takeover through `t4-omp-authority/1`.

This chart is provider-neutral. It bundles no cloud provider, CSI driver,
StorageClass, ingress controller, identity provider, CI system, registry, or
model provider. Every integration is a reference to an object the administrator
already owns, and every adapter defaults to off.

## Contents

| Path | Purpose |
|---|---|
| `Chart.yaml` | Chart identity, `kubeVersion` floor, and the separate-CRD/provider-neutral annotations |
| `capabilities.yaml` | Machine-readable inventory of every advertised capability, its values gates, and its proving scenarios |
| `values.yaml` | Default-off values; every destination list is empty and fails closed |
| `values.schema.json` | Strict values validation applied by Helm before rendering |
| `crds/` | The three `cluster.t4.dev/v1alpha1` CRDs, administered separately from Helm |
| `templates/` | Workloads, RBAC, Services, PDBs, HPAs, NetworkPolicies, Ingress, observability, and the optional adapters |

## CRDs are administered separately

Helm installs files in `crds/` only on a direct install and never upgrades or
deletes them. This chart therefore requires `--skip-crds` on every invocation
and delegates CRD administration to the fail-closed lifecycle runner:

```sh
scripts/cluster-ci/crd-lifecycle.sh install -- \
  helm install t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --create-namespace --skip-crds \
  --values operator-values.yaml
```

The same ordering applies to every deployment adapter. See
`deploy/terraform/t4-cluster`, `deploy/examples/flux`, and
`deploy/examples/argo`.

## Advertised capabilities

`capabilities.yaml` is the authoritative list. It is validated by
`scripts/cluster-ci/chart-capabilities.mjs`, which fails closed when a
capability names a values path the chart does not define, when a capability has
no proving lifecycle scenario, or when a declared scenario proves nothing.
`scripts/cluster-ci/release-lifecycle.sh` executes those scenarios against a
disposable cluster.

Optional adapters, all default-off:

- `sshGateway.enabled` — SSH front door, with optional provider/relay/attach/version command handlers
- `modelGateway.enabled` — provider-neutral credential boundary workload
- `imagePrePull.enabled` — session-runtime digest warm-up DaemonSet
- `ingress.enabled` — chart-managed Ingress, restricted to the `tailscale` class
- `observability.serviceMonitor.enabled`, `observability.prometheusRule.enabled` — Prometheus Operator objects
- `woodpecker.configMap` plus a Secret or projected audience — CI provider reference

Nothing in the core install depends on any of them.

## Required administrator-owned inputs

The chart references, and never creates:

- two StorageClasses (shared RWX workspace, separately fenced runtime state) and
  a driver-compatible `VolumeSnapshotClass`
- immutable per-image digests for controller, server, session runtime, and any
  enabled adapter image
- one same-namespace ConfigMap holding credential-free OMP `models.yml` and
  `config.yml` where every provider uses `auth: none`
- narrow NetworkPolicy destinations for each enabled integration; empty lists
  fail closed
- any Secret referenced by the SSH gateway, model gateway, CI provider, or
  initial-prompt flow

## Local packaging

`scripts/cluster-ci/package-chart.sh` lints, renders, and packages the chart
locally and records the archive digest. It never contacts a registry.
Publishing the packaged chart is a separate, explicitly approved action.

## Compatibility and evidence

`compat/portable-distribution-v1.json` records the Kubernetes and Helm floors,
the served API surface, the deployment adapters, the carried upstream deltas,
and the digest set of each release. `scripts/cluster-ci/distribution-compat.mjs`
checks every one of those claims against this repository and fails closed on an
unexplained null, an incomplete or tag-based digest set, an undeclared adapter,
or a harness or runbook reference that does not resolve.

`compat/cluster-slo-evidence-v1.json` is the startup and failover ledger. Every
entry in it is currently unmeasured, and `scripts/cluster-ci/slo-evidence.mjs`
is what keeps it that way until `scripts/cluster-ci/measure-slo.sh` produces a
run with complete identity metadata. No number in this chart's documentation
describes anything that has been measured.

## Operations

Runbooks for install, upgrade, rollback, backup/restore, fencing, identity
rotation, retained-state reinstall, uninstall, and the exact retention and
destructive effects live in `docs/runbooks/`. Architecture and API detail live
in `docs/CLUSTER_OPERATOR.md`.
