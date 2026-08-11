# Argo CD example for t4-cluster

Provider-neutral Argo CD configuration. It requires only Argo CD itself; no
cloud provider, image updater, registry, notification, or secret plugin is
required.

| File | Purpose |
|---|---|
| `appproject.yaml` | Narrow project allowing exactly the kinds this chart renders |
| `crds-application.yaml` | Sync wave `-1` Application that applies the three CRDs |
| `application.yaml` | Sync wave `0` Application that installs the chart with `skipCrds: true` |

## Ordering contract

Sync waves keep the CRDs strictly ahead of the workloads: `-1` for the CRD
Application, `0` for the chart. `helm.skipCrds: true` means Helm never creates,
upgrades, or deletes a CustomResourceDefinition in this topology.

The CRD Application applies manifests directly. That is safe for a fresh install
and for an already-validated additive change, but it reproduces none of the
fail-closed gates in `scripts/cluster-ci/crd-lifecycle.sh`. For any CRD change,
run the lifecycle runner against the same revision first, then advance
`targetRevision`:

```sh
scripts/cluster-ci/crd-lifecycle.sh upgrade -- \
  helm upgrade t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds
```

A red gate is a stop, not a retry.

## Values

`application.yaml` uses two sources pinned to the same commit: the chart path,
and a `ref: values` source that exposes `deploy/examples/values/*.yaml` to
`valueFiles`. Argo CD rejects out-of-bounds `valueFiles` from a single source,
so this is the shape that keeps values reviewable beside the chart.

The example value files are documented placeholders. Replace them with an
administrator-owned values source before syncing. Removing the adapter overlay
entry leaves the core install with no optional adapters.

## Deliberate safety choices

- `targetRevision` is an exact commit in every source.
- `automated: null` on both Applications. A control plane that owns live agent
  runtimes is never self-healed into a new digest set.
- `Prune=false` everywhere, and `PruneLast=true` on the workload Application.
  Retained PVCs, remaining custom resources, and the CRDs survive a sync.
- `retry.limit: 0`. A failed sync is investigated, not retried into a partially
  converged namespace.
- The project blacklists `Secret`, `ConfigMap`, `PersistentVolumeClaim`,
  `T4Workspace`, and `T4Session`. Administrator-owned inputs and durable
  user-owned objects are never reconciled by GitOps.
- `orphanedResources.warn: false`. Retained workspaces and their PVCs are
  expected to outlive a release; flagging them as orphans invites deletion of
  durable state.

## Rollback

Roll back with `docs/runbooks/cluster-rollback.md`, then set `targetRevision` to
the previously synced commit so Argo CD stops reporting the rolled-back release
as out of sync. Do not use `argocd app sync --force` or `--replace`: both delete
and recreate live objects.
