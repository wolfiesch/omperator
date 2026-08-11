# Runbook: upgrade

Additive upgrade of an installed release: a new controller/server/session-runtime
digest set, and optionally an additive `v1alpha1` CRD change. Destructive
effects: workload pods are replaced. No CRD, custom resource, PVC, or retained
storage is deleted.

## Non-negotiables

- `cluster.t4.dev/v1alpha1` is the only version. Changes must stay additive:
  existing fields keep their meaning and validation; new fields are optional or
  have safe defaults.
- Helm does not upgrade CRDs. `--skip-crds` on every invocation.
- Do not use `helm upgrade --install`: install and upgrade have different
  compatibility preflights.
- Do not roll OMP independently of the T4 session runtime. Controller, server,
  session runtime, cmux, and OMP roll as one compatibility set.

## Steps

### 1. Record the current state as the rollback target

```sh
kubectl config current-context
helm history t4-cluster --namespace t4-system
kubectl -n t4-system get deploy -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
```

Store the revision number together with every image digest and the current
values file. Rollback is only possible as a set.

### 2. Confirm the candidate is additive

```sh
(cd packages/cluster-operator && \
  go run ./cmd/crd-preflight fixtures ../../deploy/charts/t4-cluster/crds api/v1alpha1/testdata/compat)
```

This validates every persisted compatibility fixture, including `status` and
CEL, against the proposed structural schemas before any cluster access.

### 3. Upgrade through the lifecycle runner

```sh
scripts/cluster-ci/crd-lifecycle.sh upgrade -- \
  helm upgrade t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds
```

The runner performs, in this exact order: proposed-schema fixture validation;
live custom-resource enumeration and validation across namespaces; structural
additive-only comparison against each installed schema; resource-version and
UID guarded merge-patch generation plus server-side dry run; guarded apply with
field manager `t4-crd-lifecycle`; `Established` wait; three consecutive matching
served-OpenAPI observations; fixture dry-run through the converged admission
path; `storedVersions == [v1alpha1]`; then Helm.

### 4. Verify

```sh
kubectl -n t4-system rollout status deploy/t4-cluster-controller --timeout=600s
kubectl -n t4-system rollout status deploy/t4-cluster-server --timeout=600s
helm history t4-cluster --namespace t4-system
kubectl -n t4-system get t4clusterhost t4-cluster -o jsonpath='{.status.conditions}{"\n"}'
```

The server Deployment uses `maxUnavailable: 0`, a `minAvailable: 2` PDB,
topology spread, anti-affinity, and readiness draining, so the upgrade is
non-disruptive to connected clients when at least three replicas are healthy.

### 5. Update the ledger

Append the new revision, digest set, and source commit to
`compat/portable-distribution-v1.json` and keep the previous entry for the
whole rollback window.

## Failure handling

| Failure point | State left behind | Action |
|---|---|---|
| Fixture, live-object, structural, patch-generation, or dry-run gate | Nothing mutated | Fix the candidate; rerun the whole runner |
| Resource-version conflict on the guarded patch | Nothing mutated | The validated snapshot is stale. Investigate the concurrent CRD change and rerun the complete lifecycle. Do not retry only the patch |
| After the additive CRD patch, before Helm | New additive schema, prior workloads still running against a backward-compatible schema | Investigate and rerun the gates. Do not attempt a CRD rollback |
| During the Helm upgrade | Partially rolled workloads | [cluster-rollback.md](cluster-rollback.md) |

Never use `kubectl replace --force`, delete and recreate a CRD, apply an
unguarded force-conflict update, or alter `status.storedVersions` outside the
reviewed migration sequence in `docs/CLUSTER_OPERATOR.md`.

## Adapters

- **Terraform**: run the lifecycle runner first, then `terraform apply` with
  `crd_management = "external-lifecycle-runner"` so state converges on the
  already-applied schema. Do not let Terraform and Helm upgrade workloads in the
  same window.
- **Flux**: run the runner against the target commit, then advance the
  `GitRepository` commit. `install.crds` and `upgrade.crds` stay `Skip`.
- **Argo CD**: run the runner against the target revision, then advance
  `targetRevision` on both Applications. `skipCrds` stays true.
