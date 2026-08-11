# Runbook: install

Fresh install of the portable `t4-cluster` chart into a namespace that has no
prior release. Destructive effects: none, unless step 2 finds an existing
release, in which case use [cluster-upgrade.md](cluster-upgrade.md) or
[cluster-retained-state-reinstall.md](cluster-retained-state-reinstall.md)
instead.

## Preconditions

- Kubernetes 1.30 or newer; the chart declares `kubeVersion: ">=1.30.0-0"`.
- Two administrator-created, online-expandable StorageClasses: a real shared
  `ReadWriteMany` workspace class and a separate fenced `ReadWriteOncePod`
  (preferred) or `ReadWriteOnce` runtime-state class, plus a `VolumeSnapshotClass`
  whose driver matches both.
- `scripts/cluster-ci/storage-conformance.sh --run` has passed on a disposable
  cluster with the same driver, and the three `passed` annotations exist.
- Immutable digests for `t4-cluster-operator`, `t4-cluster-server`,
  `t4-session-runtime`, plus `t4-ssh-gateway` and `t4-model-gateway` if those
  adapters are enabled.
- One same-namespace ConfigMap holding credential-free OMP `models.yml` and
  `config.yml`; every provider uses `auth: none`.
- Narrow NetworkPolicy destinations for each enabled integration. Empty lists
  fail closed.

## Steps

### 1. Confirm the target

```sh
kubectl config current-context
kubectl version --request-timeout=10s
```

### 2. Prove there is no prior release or CRD state

```sh
helm list --namespace t4-system --all
kubectl get crd t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev --ignore-not-found
kubectl get t4sessions,t4workspaces,t4clusterhosts --all-namespaces --ignore-not-found
```

All three must be empty for a fresh install. A prior CRD with live objects means
this is a reinstall.

### 3. Validate the values file offline

```sh
helm lint deploy/charts/t4-cluster --values operator-values.yaml
helm template t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds >/dev/null
```

`values.schema.json` and the template `fail` guards reject a malformed or
half-configured install before any cluster mutation.

### 4. Install through the lifecycle runner

The runner validates compatibility fixtures against the proposed schemas,
enumerates live objects, applies guarded CRD changes, waits for `Established`,
requires three consecutive matching discovery observations, dry-runs the
fixtures through the converged admission path, requires `storedVersions` to be
exactly `v1alpha1`, and only then execs Helm.

```sh
scripts/cluster-ci/crd-lifecycle.sh install -- \
  helm install t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --create-namespace --skip-crds \
  --values operator-values.yaml
```

`--skip-crds` is mandatory; the runner refuses a Helm command without it.

### 5. Verify the rollout

```sh
kubectl -n t4-system rollout status deploy/t4-cluster-controller --timeout=300s
kubectl -n t4-system rollout status deploy/t4-cluster-server --timeout=300s
kubectl -n t4-system get pdb,hpa,networkpolicy
kubectl -n t4-system get t4clusterhost t4-cluster \
  -o jsonpath='{.status.storageCapabilities}{"\n"}'
```

The controller runs two replicas with a single-reconciler Lease. The server runs
at least two. Missing, unknown, mismatched, or unsupported RWX/reattach
observations in `storageCapabilities` fail closed before any runtime Pod is
created; that is correct behaviour, not an install failure to work around.

### 6. Record the release identity

Record together, in one place, for the rollback window:

- Helm revision number and the exact values file
- controller, server, session-runtime, and any adapter image digests
- the source commit and the OMP/cmux compatibility set

`compat/portable-distribution-v1.json` is the ledger for this. A rollback is
only possible if these were recorded as a set.

## Verification

```sh
scripts/cluster-ci/release-lifecycle.sh --plan
node scripts/cluster-ci/chart-capabilities.mjs
```

The first prints the exact scenario plan with no cluster request. The second
proves offline that every capability the chart advertises has a proving
scenario and a values gate the chart actually defines.

## If a step fails

A preflight failure leaves the live CRDs, custom resources, and workloads
untouched. A failure after an additive CRD patch but before Helm leaves no
workloads and a still-backward-compatible schema; investigate and rerun the
complete runner. Do not retry only the failed sub-step.

## Adapters

Plain Helm is the reference path. `deploy/terraform/t4-cluster`,
`deploy/examples/flux`, and `deploy/examples/argo` wrap exactly this ordering.
None of them reproduces the runner's compatibility gates, so run the runner
first for any CRD change.
