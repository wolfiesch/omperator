#!/bin/sh
set -eu

umask 077

mode=${1:-}
case "$mode" in
  images)
    repository_suffix=t4-cluster-image-evidence
    tag=${CI_COMMIT_SHA:-}
    artifact_type=application/vnd.t4.cluster.images.v1
    files="artifacts/cluster-proof/image-publication.json artifacts/cluster-proof/images/*"
    ;;
  proof)
    repository_suffix=t4-cluster-proof
    tag="${CI_COMMIT_SHA:-}-${CI_PIPELINE_NUMBER:-}"
    artifact_type=application/vnd.t4.cluster.proof.v1
    files="artifacts/cluster-proof/manifest.json artifacts/cluster-proof/scenarios/* artifacts/cluster-proof/observations/* artifacts/cluster-proof/frames/* artifacts/cluster-proof/screenshots/*"
    ;;
  *)
    echo "artifact mode must be images or proof" >&2
    exit 64
    ;;
esac

case "${CI_COMMIT_SHA:-}" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *)
    echo "CI_COMMIT_SHA must be an exact lowercase 40-character SHA" >&2
    exit 64
    ;;
esac
if [ "$mode" = proof ]; then
  case "${CI_PIPELINE_NUMBER:-}" in
    '' | *[!0-9]*) echo "CI_PIPELINE_NUMBER must be numeric" >&2; exit 64 ;;
  esac
fi

: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"
reference="$HARBOR_REGISTRY/$HARBOR_PROJECT/$repository_suffix:$tag"
# shellcheck disable=SC2086
oras push \
  --artifact-type "$artifact_type" \
  --format json \
  "$reference" \
  $files > "artifacts/cluster-proof/$mode-oci-publication.json"
test -s "artifacts/cluster-proof/$mode-oci-publication.json"
