# Runbook: clean uninstall

Removing the release and accounting for everything left behind. Read
[cluster-retention-and-destructive-effects.md](cluster-retention-and-destructive-effects.md)
first.

Destructive effects of the full sequence: `T4Session` deletion destroys running
runtimes and their routes. `T4Workspace` deletion with `retentionPolicy: Delete`
destroys that workspace's PVC and all `/workspace` data. `helm uninstall`
destroys only chart-rendered objects. CRDs, retained PVCs, snapshots, and
administrator-owned Secrets and ConfigMaps survive.

## Steps

### 1. Stop accepting new work

Stop new workspace and session mutations at the gateway before deleting
anything. A creation that lands mid-uninstall produces a Pod the uninstall will
not wait for.

```sh
kubectl config current-context
kubectl -n t4-system get t4sessions,t4workspaces
```

### 2. Delete sessions and wait

`T4Session` carries the `cluster.t4.dev/session-cleanup` finalizer and waits for
its Pod and Service to disappear. Let it.

```sh
kubectl -n t4-system delete t4session --all --wait=true
kubectl -n t4-system get pods -l app.kubernetes.io/name=t4-session-runtime
kubectl -n t4-system get svc  -l app.kubernetes.io/part-of=t4-cluster
```

If a session hangs, do not remove the finalizer. A stuck cleanup means the
runtime writer is not provably gone; go to
[cluster-fencing.md](cluster-fencing.md).

### 3. Review every workspace retention policy, individually

```sh
kubectl -n t4-system get t4workspaces -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.retentionPolicy}{"\t"}{.status.pvcName}{"\n"}{end}'
```

- `retentionPolicy: Delete` — deleting the workspace waits for its PVC to
  disappear. **The project data is destroyed.**
- `retentionPolicy: Retain` — the controller removes its owner reference, marks
  it retained, then permits workspace deletion. The PVC is deliberately
  orphaned for administrator recovery.

Decide per workspace. Never `delete t4workspace --all` without having read this
list.

```sh
kubectl -n t4-system delete t4workspace EXACT-NAME --wait=true
```

### 4. Uninstall the release

```sh
helm uninstall t4-cluster --namespace t4-system --wait
```

This removes the controller and server Deployments, adapter workloads, Services,
PDBs, HPAs, RBAC, ServiceAccounts, NetworkPolicies, Ingress, observability
objects, and the chart-owned `T4ClusterHost`.

It removes no CRD, no custom resource it does not own, no PVC, no Secret, and no
ConfigMap.

### 5. Account for what remains

```sh
kubectl -n t4-system get all
kubectl -n t4-system get pvc,volumesnapshot
kubectl -n t4-system get t4sessions,t4workspaces
kubectl get crd t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev
helm list --namespace t4-system --all
```

Expected: no chart workloads; no Helm release; the three CRDs still installed;
exactly the retained PVCs and snapshots you decided to keep; administrator-owned
Secrets and ConfigMaps untouched.

Record this inventory. It is the input to
[cluster-retained-state-reinstall.md](cluster-retained-state-reinstall.md).

### 6. Retained storage

Delete retained PVCs only after their contents have been recovered or confirmed
disposable, and only by exact name:

```sh
kubectl -n t4-system delete pvc EXACT-NAME
```

## CRD removal is a separate operation

`helm uninstall` deliberately leaves the CRDs installed so custom resources and
retained storage survive rollback and reinstall.

Removing a CRD deletes **every instance in every namespace regardless of
retention intent**. Do it only as an explicit administrative operation, after
proving there are no instances anywhere:

```sh
kubectl get t4sessions,t4workspaces,t4clusterhosts --all-namespaces
# All three must be empty before the next command.
kubectl delete crd t4sessions.cluster.t4.dev
kubectl delete crd t4workspaces.cluster.t4.dev
kubectl delete crd t4clusterhosts.cluster.t4.dev
```

## Namespace removal

`kubectl delete namespace t4-system` destroys retained PVCs, remaining custom
resources, and administrator-owned Secrets and ConfigMaps. It is not part of a
clean uninstall and is not recoverable. The Terraform configuration sets
`prevent_destroy = true` on the namespace resource for this reason.

## Adapters

| Adapter | Uninstall |
|---|---|
| Terraform | `terraform destroy -target=helm_release.t4_cluster`. The namespace resource is protected; a bare `terraform destroy` fails on it by design |
| Flux | Suspend or delete the `HelmRelease`. `uninstall.keepHistory: true` preserves the rollback target. Do not delete the CRD `Kustomization`; `prune: false` already prevents CRD removal |
| Argo CD | Delete the workload `Application` with the non-cascading option, or set `Prune=false` as configured. Do not delete the wave `-1` CRD Application with cascade |
