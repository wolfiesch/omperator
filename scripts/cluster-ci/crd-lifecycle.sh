#!/bin/sh
set -eu

usage() {
  cat >&2 <<'EOF'
usage: crd-lifecycle.sh install|upgrade -- helm install|upgrade ... --skip-crds

Environment:
  KUBECTL                 kubectl executable (default: kubectl)
  T4_CRD_DIRECTORY        reviewed CRD directory
  T4_COMPAT_DIRECTORY     old-object compatibility fixture directory
  T4_VALIDATION_NAMESPACE existing namespace used for server dry-runs (default: default)
  T4_CRD_VALIDATOR        proposed-schema validator executable (default: Go validator)
  T4_DISCOVERY_OBSERVATIONS consecutive matching OpenAPI observations required (default: 3)
  T4_DISCOVERY_ATTEMPTS   maximum OpenAPI fetch attempts (default: 30)
  T4_DISCOVERY_INTERVAL_SECONDS delay between OpenAPI attempts (default: 2)
  T4_DISCOVERY_REQUEST_TIMEOUT timeout for each OpenAPI request (default: 10s)
EOF
  exit 64
}

[ "$#" -ge 4 ] || usage
mode=$1
shift
case "$mode" in
  install|upgrade) ;;
  *) usage ;;
esac
[ "${1:-}" = "--" ] || usage
shift
[ "${1:-}" = "helm" ] || usage
[ "${2:-}" = "$mode" ] || usage

has_skip_crds=false
for argument in "$@"; do
  case "$argument" in
    --skip-crds) has_skip_crds=true ;;
    --force|--force=*|--force-conflicts|replace)
      echo "force replacement is prohibited by the T4 CRD lifecycle" >&2
      exit 64
      ;;
  esac
done
[ "$has_skip_crds" = true ] || {
  echo "the workload command must include --skip-crds" >&2
  exit 64
}

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
kubectl=${KUBECTL:-kubectl}
crd_directory=${T4_CRD_DIRECTORY:-$repo_root/deploy/charts/t4-cluster/crds}
compat_directory=${T4_COMPAT_DIRECTORY:-$repo_root/packages/cluster-operator/api/v1alpha1/testdata/compat}
validation_namespace=${T4_VALIDATION_NAMESPACE:-default}
field_manager=t4-crd-lifecycle
crds="crd/t4clusterhosts.cluster.t4.dev crd/t4workspaces.cluster.t4.dev crd/t4sessions.cluster.t4.dev"
live_resources="t4clusterhosts.cluster.t4.dev t4workspaces.cluster.t4.dev t4sessions.cluster.t4.dev"
discovery_observations=${T4_DISCOVERY_OBSERVATIONS:-3}
discovery_attempts=${T4_DISCOVERY_ATTEMPTS:-30}
discovery_interval_seconds=${T4_DISCOVERY_INTERVAL_SECONDS:-2}
discovery_request_timeout=${T4_DISCOVERY_REQUEST_TIMEOUT:-10s}

case "$discovery_observations:$discovery_attempts:$discovery_interval_seconds" in
  *[!0-9:]*|0:*|*:0:*)
    echo "T4 discovery observations and attempts must be positive integers; interval must be a non-negative integer" >&2
    exit 64
    ;;
esac
if [ "$discovery_attempts" -lt "$discovery_observations" ]; then
  echo "T4_DISCOVERY_ATTEMPTS must be at least T4_DISCOVERY_OBSERVATIONS" >&2
  exit 64
fi
case "$discovery_request_timeout" in
  *s) discovery_request_timeout_seconds=${discovery_request_timeout%s} ;;
  *) discovery_request_timeout_seconds= ;;
esac
case "$discovery_request_timeout_seconds" in
  ''|*[!0-9]*|0)
    echo "T4_DISCOVERY_REQUEST_TIMEOUT must be a positive whole number of seconds such as 10s" >&2
    exit 64
    ;;
esac
case "$discovery_observations" in
  ''|*[!0-9]*|0)
    echo "T4_DISCOVERY_OBSERVATIONS must be a positive integer" >&2
    exit 64
    ;;
esac

run_validator() {
  if [ -n "${T4_CRD_VALIDATOR:-}" ]; then
    "$T4_CRD_VALIDATOR" "$@"
  else
    (cd "$repo_root/packages/cluster-operator" && go run ./cmd/crd-preflight "$@")
  fi
}

# Validate the persisted compatibility instances, including status and CEL,
# directly against the proposed structural schemas. This is intentionally the
# first operation: current-cluster admission cannot prove candidate compatibility.
run_validator fixtures "$crd_directory" "$compat_directory"

# Curated fixtures cannot prove that every value currently persisted in the
# cluster remains valid. Enumerate only the three namespaced T4 resources and
# run each complete live object, including status, through the same proposed-
# schema engine before a CRD or workload can be mutated. A denied or malformed
# list fails closed under set -e.
live_objects=$(mktemp)
installed_crds=$(mktemp -d)
merge_patches=$(mktemp -d)
cleanup_preflight() {
  rm -f "$live_objects"
  rm -rf "$installed_crds"
  rm -rf "$merge_patches"
}
trap 'cleanup_preflight' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for resource in $live_resources; do
  installed_crd="$installed_crds/$resource.yaml"
  "$kubectl" get "crd/$resource" --ignore-not-found -o yaml >"$installed_crd"
  if [ ! -s "$installed_crd" ]; then
    rm -f "$installed_crd"
    continue
  fi
  "$kubectl" get "$resource" --all-namespaces -o json >"$live_objects"
  run_validator objects "$crd_directory" <"$live_objects"
done
run_validator compatible "$crd_directory" "$installed_crds"

# Build resource-version and UID guarded merge patches for existing CRDs. A
# missing CRD instead uses create, which atomically fails if another writer
# creates it after the absence check.
for resource in $live_resources; do
  installed_crd="$installed_crds/$resource.yaml"
  if [ -s "$installed_crd" ]; then
    run_validator patch "$crd_directory/$resource.yaml" "$installed_crd" >"$merge_patches/$resource.json"
  fi
done

# Every kubectl operation before the first non-dry-run request is read-only.
for resource in $live_resources; do
  merge_patch="$merge_patches/$resource.json"
  if [ -s "$merge_patch" ]; then
    "$kubectl" patch "crd/$resource" --type=merge --dry-run=server \
      --field-manager="$field_manager" --patch-file="$merge_patch" >/dev/null
  else
    "$kubectl" create --dry-run=server --validate=strict \
      --field-manager="$field_manager" -f "$crd_directory/$resource.yaml" >/dev/null
  fi
done

for resource in $live_resources; do
  merge_patch="$merge_patches/$resource.json"
  if [ -s "$merge_patch" ]; then
    "$kubectl" patch "crd/$resource" --type=merge \
      --field-manager="$field_manager" --patch-file="$merge_patch"
  else
    "$kubectl" create --validate=strict --field-manager="$field_manager" \
      -f "$crd_directory/$resource.yaml"
  fi
done
cleanup_preflight
trap - EXIT HUP INT TERM
# Discovery and admission must converge before compatibility validation or any
# workload rollout uses the new schema.
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" wait --for=condition=Established --timeout=120s $crds

# Established can remain True across an update. Require several independently
# fetched discovery documents to expose exactly the candidate OpenAPI semantics
# before trusting admission or starting a workload rollout.
openapi_document=$(mktemp)
trap 'rm -f "$openapi_document"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
observation=0
attempt=0
while [ "$observation" -lt "$discovery_observations" ]; do
  attempt=$((attempt + 1))
  if "$kubectl" get --request-timeout="$discovery_request_timeout" \
    --raw /openapi/v3/apis/cluster.t4.dev/v1alpha1 >"$openapi_document" && \
    run_validator served "$crd_directory" <"$openapi_document"; then
    observation=$((observation + 1))
  else
    observation=0
  fi
  if [ "$observation" -ge "$discovery_observations" ]; then
    break
  fi
  if [ "$attempt" -ge "$discovery_attempts" ]; then
    echo "served OpenAPI did not converge after $discovery_attempts attempts" >&2
    exit 65
  fi
  sleep "$discovery_interval_seconds"
done

"$kubectl" apply --dry-run=server --validate=strict \
  --namespace "$validation_namespace" -f "$compat_directory" >/dev/null

for crd in $crds; do
  stored_versions=$("$kubectl" get "$crd" -o 'jsonpath={.status.storedVersions[*]}')
  if [ "$stored_versions" != v1alpha1 ]; then
    echo "$crd status.storedVersions is '$stored_versions'; expected exactly 'v1alpha1'" >&2
    exit 65
  fi
done

# Helm is deliberately last and must not manage CRDs. If any earlier gate fails,
# the existing controller, server, session workloads, and custom resources are
# untouched by this runner.
rm -f "$openapi_document"
trap - EXIT HUP INT TERM
exec "$@"
