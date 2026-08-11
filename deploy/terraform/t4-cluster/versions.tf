# Provider-neutral by construction: only the generic Kubernetes and Helm
# providers are required. No cloud, DNS, storage, identity, registry, or
# network provider is declared, so no such provider can become mandatory for
# consumers of this configuration.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    helm = {
      source  = "hashicorp/helm"
      version = ">= 2.12.0, < 4.0.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = ">= 2.27.0, < 3.0.0"
    }
  }
}
