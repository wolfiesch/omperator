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
trap 'rm -f "$live_objects"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
for resource in $live_resources; do
  installed_crd=$("$kubectl" get "crd/$resource" --ignore-not-found -o name)
  if [ -z "$installed_crd" ]; then
    continue
  fi
  "$kubectl" get "$resource" --all-namespaces -o json >"$live_objects"
  run_validator objects "$crd_directory" <"$live_objects"
done
rm -f "$live_objects"
trap - EXIT HUP INT TERM

# Every kubectl operation before the first non-dry-run apply is read-only.
"$kubectl" apply --server-side --dry-run=server --validate=strict \
  --field-manager="$field_manager" -f "$crd_directory" >/dev/null

"$kubectl" apply --server-side --validate=strict \
  --field-manager="$field_manager" -f "$crd_directory"
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
while [ "$observation" -lt "$discovery_observations" ]; do
  "$kubectl" get --raw /openapi/v3/apis/cluster.t4.dev/v1alpha1 >"$openapi_document"
  run_validator served "$crd_directory" <"$openapi_document"
  observation=$((observation + 1))
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
