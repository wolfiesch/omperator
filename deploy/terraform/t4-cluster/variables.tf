variable "kubeconfig_path" {
  description = "Path to an existing kubeconfig. Supplied by the operator; no cloud provider credential source is assumed."
  type        = string
}

variable "kubeconfig_context" {
  description = "Exact kubeconfig context to act on. Required so a plan can never silently target the wrong cluster."
  type        = string

  validation {
    condition     = length(trimspace(var.kubeconfig_context)) > 0
    error_message = "kubeconfig_context must name one exact context."
  }
}

variable "namespace" {
  description = "Namespace that holds the release. Created by this configuration when create_namespace is true."
  type        = string
  default     = "t4-system"
}

variable "create_namespace" {
  description = "Create the namespace. Set false when the namespace is owned elsewhere."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name."
  type        = string
  default     = "t4-cluster"
}

variable "chart_path" {
  description = "Filesystem path to the t4-cluster chart directory, or a local packaged chart archive."
  type        = string
  default     = "../../charts/t4-cluster"
}

variable "values_files" {
  description = "Ordered list of values files. Every file is administrator-owned; this configuration contains no defaults that enable the control plane."
  type        = list(string)

  validation {
    condition     = length(var.values_files) > 0
    error_message = "At least one values file must be supplied; the chart is default-off and requires explicit configuration."
  }
}

variable "crd_management" {
  description = <<-EOT
    Who administers the three cluster.t4.dev CRDs.

    external-lifecycle-runner (default): scripts/cluster-ci/crd-lifecycle.sh has
    already applied and converged the CRDs. Terraform only asserts that each CRD
    is Established with storedVersions exactly [v1alpha1] before Helm runs. This
    preserves the fail-closed additive-compatibility preflight, which Terraform
    cannot reproduce.

    terraform: only valid for a first install into a cluster that has no
    cluster.t4.dev CRDs. Terraform applies the CRD manifests itself, in a
    separate resource that Helm depends on. It performs no additive-compatibility
    check, so it must never be used to change an installed CRD.
  EOT
  type        = string
  default     = "external-lifecycle-runner"

  validation {
    condition     = contains(["external-lifecycle-runner", "terraform"], var.crd_management)
    error_message = "crd_management must be external-lifecycle-runner or terraform."
  }
}

variable "crd_directory" {
  description = "Directory holding the three CRD manifests. Only read when crd_management is terraform."
  type        = string
  default     = "../../charts/t4-cluster/crds"
}

variable "atomic" {
  description = "Roll the release back automatically when an install or upgrade fails."
  type        = bool
  default     = true
}

variable "timeout_seconds" {
  description = "Helm operation timeout in seconds."
  type        = number
  default     = 900
}

variable "max_history" {
  description = "Helm release revisions retained for rollback. Keep this above the number of revisions in the rollback window."
  type        = number
  default     = 20

  validation {
    condition     = var.max_history >= 3
    error_message = "max_history must retain at least three revisions so a rollback target survives two upgrades."
  }
}
