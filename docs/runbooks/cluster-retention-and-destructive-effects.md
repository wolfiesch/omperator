# Retention and destructive effects

Read this before any deletion. Each row names the exact target, what the
operation destroys, and what survives. Nothing here is reversible by rerunning
the same command.

## Operation matrix

| Operation | Exact target | Destroys | Retains | Reversible |
|---|---|---|---|---|
| `helm uninstall t4-cluster -n t4-system` | Helm release `t4-cluster` | Controller/server/adapter Deployments, Services, PDBs, HPAs, RBAC, NetworkPolicies, Ingress, observability objects, the chart-owned `T4ClusterHost` | All three CRDs, every `T4Workspace` and `T4Session`, every PVC, every administrator-owned Secret and ConfigMap, retained storage | Yes, by reinstall with the same values and digest set |
| `helm rollback t4-cluster REVISION -n t4-system` | Helm release revision | Nothing durable; workload pods are replaced | CRDs, custom resources, PVCs, retained storage | Yes, by rolling forward to the recorded digest set |
| `kubectl delete t4session NAME -n t4-system` | One `T4Session` | The session Pod, its Service, its route and tickets, the runtime generation's attachment | The workspace PVC, the runtime-state PVC per its own retention, snapshots | No. OMP session authority state survives only on the runtime-state volume |
| `kubectl delete t4workspace NAME -n t4-system` with `retentionPolicy: Delete` | One `T4Workspace` and its PVC | The workspace PVC and all `/workspace` project data | Snapshots taken earlier, other workspaces | No |
| `kubectl delete t4workspace NAME -n t4-system` with `retentionPolicy: Retain` | One `T4Workspace` object only | The `T4Workspace` object | The PVC, deliberately orphaned for administrator recovery | Yes, by re-declaring a workspace bound to the retained PVC |
| `kubectl delete pvc NAME -n t4-system` | One PVC | All data on that volume once the PV reclaim policy runs | Snapshots taken earlier | No |
| `kubectl delete volumesnapshot NAME -n t4-system` | One snapshot | The restore point, and its backing content when the snapshot class deletion policy is `Delete` | Live PVCs | No |
| `kubectl delete crd t4sessions.cluster.t4.dev` (and hosts, workspaces) | One CRD, cluster scoped | **Every instance in every namespace, regardless of `retentionPolicy: Retain`.** Finalizers run, then the objects are gone | Only PVCs whose workspaces were `Retain` at deletion time | No |
| `kubectl delete namespace t4-system` | The whole namespace | Every PVC in it including retained ones, every remaining custom resource, every administrator-owned Secret and ConfigMap | Cluster-scoped CRDs and ClusterRoles | No |
| `terraform destroy` in `deploy/terraform/t4-cluster` | Helm release, and the namespace if it were not protected | Same as `helm uninstall`; the namespace resource sets `prevent_destroy = true` precisely because namespace deletion is not recoverable | CRDs, retained PVCs | Partially |
| Flux `Kustomization` prune on the CRD path | All three CRDs | Every T4 custom resource in the cluster | Nothing T4-scoped | No. `prune: false` is set for this reason |
| Argo CD sync with `Prune=true` | Whatever is no longer in Git | Potentially retained PVC-bound objects and custom resources | Unmanaged objects | No. `Prune=false` is set for this reason |

## Storage domains

Workspace files and runtime authority state are separate trust and consistency
domains and are never on the same volume:

- **Workspace PVC** (`ReadWriteMany`, `storage.adminRWXStorageClass`): shared
  project data under `/workspace`. Deleting it destroys user project data.
- **Runtime-state PVC** (`ReadWriteOncePod` preferred,
  `storage.runtimeStateStorageClass`): OMP durable state, the cmux
  database/WAL and sockets, and browser profile state. Deleting it destroys
  session authority state that no Kubernetes object can reconstruct.

Never place authority paths on RWX storage unless the backend has separately
proved safe shared-WAL and writer-fencing semantics via
`scripts/cluster-ci/storage-conformance.sh`.

## What is never destroyed by this chart

The chart creates no Secret, no ConfigMap, no PVC, no StorageClass, and no CSI
object. It therefore cannot delete one. Every such object is administrator
owned and outlives every release operation.

## Confirmation gate before any deletion

1. `kubectl config current-context` matches the intended cluster.
2. The object exists and is the one you mean:
   `kubectl -n t4-system get <kind> <name> -o yaml | head -40`.
3. For a workspace, read the retention policy explicitly:
   `kubectl -n t4-system get t4workspace <name> -o jsonpath='{.spec.retentionPolicy}{"\n"}'`.
4. For a CRD deletion, prove there are no instances anywhere:
   `kubectl get t4sessions,t4workspaces,t4clusterhosts --all-namespaces`.
5. Recovery has been established: a `ReadyToUse` snapshot pair, or a documented
   decision that the data is disposable.
