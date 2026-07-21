#!/bin/sh
set -eu

umask 077

mode=${1:-}
component=${2:-}
repository_suffix=${3:-}
case "$component:$repository_suffix" in
  controller:t4-cluster-operator | cluster-server:t4-cluster-server | session-runtime:t4-session-runtime) ;;
  *)
    echo "component and repository suffix do not match the fixed T4 image contract" >&2
    exit 64
    ;;
esac
case "$mode" in
  sbom | vulnerability | provenance) ;;
  *)
    echo "evidence mode must be sbom, vulnerability, or provenance" >&2
    exit 64
    ;;
esac

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"

artifact_dir="artifacts/cluster-proof/images"
digest=$(cat "$artifact_dir/$component.digest")
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *)
    echo "image digest artifact is malformed" >&2
    exit 65
    ;;
esac
reference="$HARBOR_REGISTRY/$HARBOR_PROJECT/quarantine/$repository_suffix@$digest"

case "$mode" in
  sbom)
    syft "registry:$reference" -o "spdx-json=$artifact_dir/$component.spdx.json"
    test -s "$artifact_dir/$component.spdx.json"
    ;;
  vulnerability)
    trivy image \
      --format json \
      --output "$artifact_dir/$component.trivy.json" \
      --scanners vuln \
      --severity HIGH,CRITICAL \
      --exit-code 1 \
      "$reference"
    test -s "$artifact_dir/$component.trivy.json"
    ;;
  provenance)
    identity=${T4_COSIGN_CERTIFICATE_IDENTITY:-}
    issuer=${T4_COSIGN_CERTIFICATE_OIDC_ISSUER:-}
    if [ -n "$identity" ] && [ -n "$issuer" ]; then
      cosign verify-attestation \
        --type slsaprovenance \
        --certificate-identity "$identity" \
        --certificate-oidc-issuer "$issuer" \
        "$reference" > "$artifact_dir/$component.provenance.jsonl"
      printf '%s\n' '{"mode":"cosign-keyless","signatureVerified":true}' > "$artifact_dir/$component.provenance-verification.json"
    elif [ -z "$identity" ] && [ -z "$issuer" ]; then
      cosign download attestation "$reference" > "$artifact_dir/$component.provenance.jsonl"
      printf '%s\n' '{"mode":"buildkit-content","signatureVerified":false}' > "$artifact_dir/$component.provenance-verification.json"
    else
      echo "cosign certificate identity and OIDC issuer must be configured together" >&2
      exit 64
    fi
    unset identity issuer
    test -s "$artifact_dir/$component.provenance.jsonl"
    test -s "$artifact_dir/$component.provenance-verification.json"
    ;;
esac
