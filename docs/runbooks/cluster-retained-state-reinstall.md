# Runbook: retained-state reinstall

Reinstalling the release into a namespace that already holds retained
workspaces, PVCs, and the three CRDs. This is the normal path after a clean
uninstall, after a namespace-level control-plane rebuild, or when moving the
release to a new Helm ownership.

Destructive effects: none, if the steps below are followed. The two ways to
destroy state here are deleting a CRD and deleting the namespace; both are
covered in
[cluster-retention-and-destructive-effects.md](cluster-retention-and-destructive-effects.md).

## What survived the uninstall

- All three CRDs, at the schema version installed at uninstall time.
- Every `T4Workspace` and `T4Session` object that was not explicitly deleted.
- Every PVC, including workspaces whose `retentionPolicy` was `Retain` and whose
  owner reference the controller removed before permitting deletion.
- Every administrator-owned Secret, ConfigMap, and StorageClass.
- Every `VolumeSnapshot`.

The chart-owned `T4ClusterHost` did **not** survive: it is a chart-rendered
object and is recreated by the reinstall.

## Steps

### 1. Inventory before touching anything

```sh
kubectl config current-context
helm list --namespace t4-system --all
kubectl get crd t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev \
  -o custom-columns=NAME:.metadata.name,STORED:.status.storedVersions
kubectl -n t4-system get t4workspaces -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.retentionPolicy}{"\t"}{.status.pvcName}{"\n"}{end}'
kubectl -n t4-system get pvc -o \
  custom-columns=NAME:.metadata.name,CLASS:.spec.storageClassName,MODE:.spec.accessModes,PHASE:.status.phase
kubectl -n t4-system get t4sessions
```

Write the inventory down. It is the acceptance criterion for step 5.

### 2. Confirm the values match the retained storage

The reinstall must select the same StorageClasses the retained PVCs were
provisioned from:

- `storage.adminRWXStorageClass` must equal the retained workspace PVCs' class.
- `storage.runtimeStateStorageClass` and `storage.runtimeStateAccessMode` must
  equal the retained runtime-state PVCs' class and mode.
- `storage.volumeSnapshotClass` must still share the same driver.

A mismatch does not corrupt anything, but the controller will provision new
volumes and the retained ones will be orphaned silently. Check before, not
after.

### 3. Confirm no live writer

Reinstalling while an old runtime still holds a runtime-state volume is exactly
the split-brain the fence prevents.

```sh
kubectl -n t4-system get pods -l app.kubernetes.io/part-of=t4-cluster
kubectl -n t4-system get t4sessions -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podName}{"\t"}{.status.fenceState}{"\n"}{end}'
```

Every session must report no Pod. Any session in `DrainRequired`,
`ShutdownRequested`, `FenceVerifying`, or `FenceUncertain` goes through
[cluster-fencing.md](cluster-fencing.md) first.

### 4. Reinstall through the lifecycle runner

Use `install`, not `upgrade`: there is no Helm release to upgrade. The runner
still validates the candidate schemas against the installed CRDs and every live
custom resource, which is precisely the check that matters here.

```sh
scripts/cluster-ci/crd-lifecycle.sh install -- \
  helm install t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --skip-crds \
  --values operator-values.yaml
```

Do not pass `--create-namespace`; the namespace already exists and holds the
retained state. If the runner reports an incompatible live object, stop: the
candidate chart is older than the schema the retained objects were written
under, and installing it would prune declared fields.

### 5. Prove re-adoption

```sh
kubectl -n t4-system rollout status deploy/t4-cluster-controller --timeout=600s
kubectl -n t4-system rollout status deploy/t4-cluster-server --timeout=600s
kubectl -n t4-system get t4clusterhost t4-cluster \
  -o jsonpath='{.status.storageCapabilities}{"\n"}'
kubectl -n t4-system get t4workspaces -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.pvcName}{"\n"}{end}'
kubectl -n t4-system get pvc
```

Acceptance:

- Every workspace from step 1 reports the **same** PVC name it reported before.
- No new PVC appeared for an existing workspace.
- The PVC count matches the step 1 inventory.
- `storageCapabilities` reports the same bounded observations; unknown or
  mismatched observations fail closed before any runtime Pod is created.

### 6. Resume runtimes

Bring sessions back one at a time. Each start goes through positive fence proof
and commits a **new** `runtimeGeneration` while preserving the stable
`publicId`. A reused generation identifier is a defect, not a convenience.

```sh
kubectl -n t4-system get t4sessions -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.publicId}{"\t"}{.status.runtimeGeneration}{"\t"}{.status.fenceState}{"\n"}{end}'
```

## If a retained PVC must be re-declared

A `Retain` workspace whose `T4Workspace` object was deleted leaves an orphaned
PVC with no owner reference. Re-declare a workspace that binds to it rather
than copying data:

1. Confirm the PVC is `Bound` and not attached to any Pod.
2. Create the `T4Workspace` with the same name and the same size and retention
   policy it had before.
3. Verify `status.pvcName` resolves to the existing PVC and
   that no second PVC was provisioned.

If a second PVC appears, delete the new empty one only after confirming by name
which is which. Never delete the bound one to "clean up".
