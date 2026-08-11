resource "kubernetes_namespace" "release" {
  count = var.create_namespace ? 1 : 0

  metadata {
    name = var.namespace

    labels = {
      "app.kubernetes.io/part-of"    = "t4-cluster"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }

  # Deleting the namespace would delete retained PersistentVolumeClaims and any
  # remaining custom resources. Namespace teardown is an explicit administrative
  # step in docs/runbooks/cluster-uninstall.md, never a Terraform side effect.
  lifecycle {
    prevent_destroy = true
  }
}

resource "helm_release" "t4_cluster" {
  name      = var.release_name
  chart     = var.chart_path
  namespace = var.namespace

  # Helm never administers the CRDs. Ordering is expressed by depends_on, and
  # by the read-only Established/storedVersions postconditions in crds.tf.
  skip_crds = true

  # The chart's values.schema.json is the validation contract; no value is
  # injected here that the chart does not already define.
  values = [for path in var.values_files : file(path)]

  atomic          = var.atomic
  cleanup_on_fail = true
  wait            = true
  wait_for_jobs   = true
  timeout         = var.timeout_seconds
  max_history     = var.max_history

  # Never let Terraform silently take over an unmanaged release or reorder CRDs.
  replace          = false
  force_update     = false
  recreate_pods    = false
  create_namespace = false

  depends_on = [
    kubernetes_namespace.release,
    kubernetes_manifest.crd,
    data.kubernetes_resource.crd,
  ]

  lifecycle {
    precondition {
      condition     = length(var.values_files) > 0
      error_message = "The chart is default-off. Supply at least one administrator-owned values file."
    }
  }
}
