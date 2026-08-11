# Deployment adapter examples

Backend- and provider-neutral examples for installing the portable `t4-cluster`
chart. Every adapter here is optional and interchangeable; none of them is
required to install the chart, and adopting one never makes a cloud, storage,
identity, registry, CI, or network provider mandatory.

| Path | Adapter | Requires |
|---|---|---|
| `../terraform/t4-cluster` | Terraform | `hashicorp/helm`, `hashicorp/kubernetes` |
| `flux/` | Flux | `source-controller`, `kustomize-controller`, `helm-controller` |
| `argo/` | Argo CD | Argo CD |
| `values/` | Shared values shapes | none |

Plain Helm plus `scripts/cluster-ci/crd-lifecycle.sh` remains the reference
path; each adapter is a wrapper around exactly that ordering.

## The one invariant every adapter preserves

The three `cluster.t4.dev/v1alpha1` CRDs are administered separately from the
workload release, always before it, and Helm is always invoked with
`--skip-crds` (`skip_crds`, `crds: Skip`, `skipCrds`). No adapter reproduces the
fail-closed additive-compatibility preflight in
`scripts/cluster-ci/crd-lifecycle.sh`, so every CRD change runs that runner
first, against the same revision, and a red gate stops the change.

`scripts/cluster-ci/release-lifecycle.sh` proves this invariant for all three
adapters in its `crd-separate-order` and `optional-adapters` scenarios.

## Values

`values/minimal-values.yaml` and `values/adapters-values.yaml` are documented
shapes with placeholder StorageClasses, image digests, ConfigMaps, Secrets,
origins, and CIDRs. They are not usable configurations and are not defaults:
the chart is default-off and none of these examples inject values of their own.
