# Example only. Every value below is a placeholder that must be replaced with
# an identity that already exists in the target cluster. Copy this file, do not
# apply it unchanged.

kubeconfig_path    = "~/.kube/config"
kubeconfig_context = "replace-with-the-exact-context-name"

namespace        = "t4-system"
create_namespace = true
release_name     = "t4-cluster"

chart_path = "../../charts/t4-cluster"

# Administrator-owned values. deploy/examples/values/minimal-values.yaml is a
# documented starting shape, not a usable production configuration: it still
# contains placeholder StorageClasses, digests, and destinations.
values_files = ["../../examples/values/minimal-values.yaml"]

# Keep the fail-closed additive-compatibility preflight in front of every CRD
# change. Only a first install into a cluster with no cluster.t4.dev CRDs may
# use "terraform".
crd_management = "external-lifecycle-runner"

atomic          = true
timeout_seconds = 900
max_history     = 20
