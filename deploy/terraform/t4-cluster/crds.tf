locals {
  crd_names = [
    "t4clusterhosts.cluster.t4.dev",
    "t4workspaces.cluster.t4.dev",
    "t4sessions.cluster.t4.dev",
  ]

  terraform_manages_crds = var.crd_management == "terraform"

  crd_manifests = local.terraform_manages_crds ? {
    for name in local.crd_names :
    name => yamldecode(file("${var.crd_directory}/${name}.yaml"))
  } : {}
}

# First-install path only. Applied as its own resource so the Helm release can
# depend on it and CRD ordering stays explicit rather than implicit in Helm.
resource "kubernetes_manifest" "crd" {
  for_each = local.crd_manifests

  manifest = each.value

  field_manager {
    name            = "t4-crd-lifecycle"
    force_conflicts = false
  }

  wait {
    condition {
      type   = "Established"
      status = "True"
    }
  }
}

# Steady-state path. Terraform reads, but never mutates, the installed CRDs and
# refuses to touch workloads unless discovery already serves the exact contract.
data "kubernetes_resource" "crd" {
  for_each = local.terraform_manages_crds ? toset([]) : toset(local.crd_names)

  api_version = "apiextensions.k8s.io/v1"
  kind        = "CustomResourceDefinition"

  metadata {
    name = each.value
  }

  lifecycle {
    postcondition {
      condition = try(self.object.metadata.name, "") == each.value
      error_message = "CRD ${each.value} is not installed. Run scripts/cluster-ci/crd-lifecycle.sh install before Terraform, or set crd_management = \"terraform\" for a first install."
    }

    postcondition {
      condition = anytrue([
        for condition in try(self.object.status.conditions, []) :
        condition.type == "Established" && condition.status == "True"
      ])
      error_message = "CRD ${each.value} is not Established."
    }

    postcondition {
      condition     = try(self.object.status.storedVersions, []) == ["v1alpha1"]
      error_message = "CRD ${each.value} storedVersions is not exactly [v1alpha1]. Stop and complete the reviewed storage-version procedure."
    }

    postcondition {
      condition = alltrue([
        for version in try(self.object.spec.versions, []) :
        version.name == "v1alpha1" && version.served && version.storage
      ])
      error_message = "CRD ${each.value} serves a version other than the single served/storage v1alpha1 contract."
    }
  }
}
