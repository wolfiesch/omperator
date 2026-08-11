# Runbook: rollback

Return workloads to the previous known-compatible revision. Destructive
effects: workload pods are replaced. CRDs stay installed and additive, custom
resources, PVCs, snapshots, and retained storage are untouched.

## What rollback is not

- It is not a CRD rollback. CRDs remain at the newer additive schema, which is
  backward compatible by contract. Never delete, replace, or downgrade a CRD to
  make a workload rollback proceed.
- It is not a way to roll OMP independently of the T4 session runtime. The
  pinned authority boundary is not negotiated down.
- It is not a storage recovery tool. Use
  [cluster-backup-restore.md](cluster-backup-restore.md).

## Steps

### 1. Choose the exact target revision

```sh
kubectl config current-context
helm history t4-cluster --namespace t4-system
```

Pick the revision whose recorded digest set is known-compatible with the
currently installed CRD schema. If that digest set was not recorded together in
`compat/portable-distribution-v1.json`, stop: rollback is unproven.

### 2. Quiesce new work

Stop accepting new workspace and session mutations at the gateway before
replacing server pods. Active runtimes keep their generation; the controller
does not advance a generation during a workload rollback.

### 3. Roll back

```sh
helm rollback t4-cluster REVISION --namespace t4-system --wait --timeout 15m
```

Substitute the exact revision number from step 1. Do not pass `--force`: it
deletes and recreates live objects.

### 4. Verify

```sh
helm history t4-cluster --namespace t4-system
kubectl -n t4-system rollout status deploy/t4-cluster-controller --timeout=600s
kubectl -n t4-system rollout status deploy/t4-cluster-server --timeout=600s
kubectl -n t4-system get deploy -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.template.spec.containers[0].image}{"\n"}{end}'
kubectl -n t4-system get t4sessions -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.runtimeGeneration}{"\t"}{.status.fenceState}{"\n"}{end}'
```

Every rendered image must match the recorded rollback digest set exactly.
Session generations must be unchanged and no session may be left in
`FenceUncertain`; if one is, go to [cluster-fencing.md](cluster-fencing.md)
before resuming traffic.

### 5. Reconcile the adapter's state

| Adapter | Action |
|---|---|
| Plain Helm | Nothing further |
| Terraform | Re-run `terraform apply` with the previous values file and digest set so state matches the cluster. Terraform exposes no `helm rollback` |
| Flux | Set the `GitRepository` commit back to the previously reconciled commit. `uninstall.keepHistory: true` and `upgrade.remediation.strategy: rollback` mean the controller may already have rolled back for you; confirm with `helm history` before changing the pin |
| Argo CD | Set `targetRevision` on both Applications back to the previously synced commit. Do not use `argocd app sync --force` or `--replace` |

## Rollback window

Keep the previous digest set, values file, and a verified backup available for
the whole rollback window. `max_history` in the Terraform configuration and
`maxHistory` in the Flux HelmRelease both retain 20 revisions for this reason;
Helm's default of 10 is also sufficient but must not be lowered below the number
of upgrades in the window.

## If rollback fails

A failed `helm rollback` leaves the release in a `failed` state with mixed pod
generations. Do not force. Re-run the rollback once with `--wait`. If it fails
again, stop, capture `helm status`, `kubectl -n t4-system get events
--sort-by=.lastTimestamp`, and the controller/server logs, and treat it as an
incident: the correct next action depends on whether any runtime attached under
the new digest set.
