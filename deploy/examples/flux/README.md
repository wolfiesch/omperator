# Flux example for t4-cluster

Provider-neutral Flux configuration. It requires only `source-controller`,
`kustomize-controller`, and `helm-controller`. No cloud provider, registry,
image-automation, notification, or secret-management controller is required.

| File | Purpose |
|---|---|
| `source.yaml` | `GitRepository` pinned to an exact commit, scoped to the chart directory |
| `crds-kustomization.yaml` | Separately ordered CRD reconciliation with health checks and pruning refused |
| `helmrelease.yaml` | Workload release with `crds: Skip` on install and upgrade, gated on the CRD Kustomization |

## Ordering contract

`helmrelease.yaml` `dependsOn` `t4-cluster-crds`, and both `install.crds` and
`upgrade.crds` are `Skip`. Helm never creates, upgrades, or deletes a
CustomResourceDefinition in this topology.

The Kustomization applies CRD manifests directly. That is safe for a fresh
install and for an already-validated additive change, but it reproduces none of
the fail-closed gates in `scripts/cluster-ci/crd-lifecycle.sh`: proposed-schema
fixture validation, live custom-resource enumeration, structural additive-only
comparison, guarded merge patches, served-schema convergence, and
`storedVersions` verification.

For any CRD change, run the lifecycle runner against the same commit first, and
only then advance the `GitRepository` commit:

```sh
scripts/cluster-ci/crd-lifecycle.sh upgrade -- \
  helm upgrade t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds
```

A red gate is a stop, not a retry. Do not advance the pinned commit to make
reconciliation proceed.

## Values

The chart is default-off and this example injects no inline values. Supply an
administrator-owned `t4-cluster-values` ConfigMap holding a `values.yaml` key;
`deploy/examples/values/minimal-values.yaml` is a documented starting shape with
placeholders, not a usable configuration. The optional
`t4-cluster-adapter-values` ConfigMap is marked `optional: true`, so every
adapter can be dropped without editing the HelmRelease.

## Deliberate safety choices

- The source ref is a commit, not a branch or tag, so the chart, the CRDs, and
  the recorded digest set cannot drift apart between reconciliations.
- `prune: false` on the CRD Kustomization. Deleting a CRD deletes every
  `T4ClusterHost`, `T4Workspace`, and `T4Session` regardless of retention.
- `rollback.recreate: false` and `rollback.force: false`. Remediation never
  deletes and re-creates Services or PVC-bound workloads.
- `uninstall.keepHistory: true`, so the rollback target survives a removal.
- `driftDetection.mode: warn`. Drift on a live control plane is reported for a
  human decision instead of silently corrected.
- `install.remediation.retries: 0`. A failed first install is investigated, not
  retried into a partially converged namespace.
