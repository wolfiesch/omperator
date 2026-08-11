output "release_name" {
  description = "Installed Helm release name."
  value       = helm_release.t4_cluster.name
}

output "release_namespace" {
  description = "Namespace holding the release."
  value       = helm_release.t4_cluster.namespace
}

output "release_revision" {
  description = "Current Helm revision. Use this as the rollback target recorded in docs/runbooks/cluster-rollback.md."
  value       = helm_release.t4_cluster.version
}

output "chart_version" {
  description = "Chart version applied by this configuration."
  value       = helm_release.t4_cluster.metadata[0].chart
}

output "app_version" {
  description = "Chart appVersion applied by this configuration."
  value       = helm_release.t4_cluster.metadata[0].app_version
}

output "crd_management" {
  description = "Who administers the cluster.t4.dev CRDs for this configuration."
  value       = var.crd_management
}
