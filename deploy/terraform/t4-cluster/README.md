# Terraform configuration for the t4-cluster chart

Provider-neutral Terraform for installing the portable `t4-cluster` chart. Only
`hashicorp/helm` and `hashicorp/kubernetes` are required. No cloud, DNS,
storage, identity, registry, or network provider is declared, so adopting this
configuration never makes one of those providers mandatory.

## CRD ordering

The three `cluster.t4.dev/v1alpha1` CRDs are never managed by Helm. This
configuration keeps them separately ordered in one of two explicit modes:

| `crd_management` | Behaviour |
|---|---|
| `external-lifecycle-runner` (default) | `scripts/cluster-ci/crd-lifecycle.sh` has already applied and converged the CRDs. Terraform only reads them and refuses to proceed unless each is `Established` with `storedVersions` exactly `[v1alpha1]` and serves exactly one served/storage `v1alpha1` version. |
| `terraform` | First install only, into a cluster with no `cluster.t4.dev` CRDs. Terraform applies the manifests in `kubernetes_manifest.crd` and the release depends on them. |

`terraform` mode performs no additive-compatibility preflight, no live-object
enumeration, and no served-schema convergence check. It must never be used to
change an installed CRD. Upgrades always run the lifecycle runner first:

```sh
scripts/cluster-ci/crd-lifecycle.sh upgrade -- \
  helm upgrade t4-cluster deploy/charts/t4-cluster \
  --namespace t4-system --values operator-values.yaml --skip-crds
```

then re-run `terraform apply` with `crd_management = "external-lifecycle-runner"`
so state converges on the already-applied schema. When Terraform owns the Helm
release, run the lifecycle runner's CRD gates with a no-op Helm command and let
Terraform perform the workload upgrade; do not let both tools upgrade workloads
in the same window.

## Usage

```sh
cd deploy/terraform/t4-cluster
cp example.tfvars local.auto.tfvars   # then edit every placeholder
terraform init
terraform plan  -var-file=local.auto.tfvars
terraform apply -var-file=local.auto.tfvars
```

`values_files` has no default. The chart is default-off and this configuration
injects no values of its own, so an apply without an administrator-owned values
file fails the `helm_release` precondition rather than installing something
partially configured.

## Deliberate safety choices

- `kubeconfig_context` is required. A plan can never inherit an ambient
  current-context.
- `skip_crds = true` on the release, always.
- `replace`, `force_update`, and `recreate_pods` are pinned false. Terraform
  never force-replaces a release or restarts session-adjacent workloads to make
  an apply converge.
- `create_namespace` on the release is false; the namespace is a separate
  resource with `prevent_destroy = true`, because destroying it would delete
  retained PVCs and remaining custom resources.
- `max_history` must retain at least three revisions so a rollback target
  survives two upgrades.
- `atomic` and `cleanup_on_fail` default true: a failed apply rolls the
  workloads back and leaves the additive CRDs in place, which is the same
  end state as the manual rollback runbook.

## Rollback

`terraform` does not expose `helm rollback`. Roll back with the runbook
(`docs/runbooks/cluster-rollback.md`), then re-run `terraform apply` with the
previous values file and digest set so state matches the cluster. Recording the
digest set per revision is what makes this reversible; see
`compat/portable-distribution-v1.json`.
