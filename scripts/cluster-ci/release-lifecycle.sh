#!/bin/sh
set -eu

# End-to-end distribution proof for the portable t4-cluster chart. Publication
# is deliberately out of scope: this harness installs, upgrades, rolls back,
# reinstalls over retained state, and uninstalls a local chart directory, and
# never contacts a registry or publishes an artifact.

print_plan() {
  cat <<'PLAN'
T4 release lifecycle plan (read-only; no cluster requests)
Prerequisites:
  1. kubectl context explicitly names a disposable non-production cluster.
  2. No cluster.t4.dev CustomResourceDefinition is installed; this harness administers all three.
  3. T4_LIFECYCLE_NAMESPACE starts with t4-lifecycle- and does not exist yet.
  4. T4_LIFECYCLE_VALUES is a complete enabled values file with digest-pinned images and reviewed StorageClasses.
  5. T4_LIFECYCLE_UPGRADE_VALUES differs from the baseline only additively, including a distinct digest set.
  6. T4_LIFECYCLE_ADAPTER_VALUES enables every optional adapter and nothing else.
  7. helm, kubectl, and node are on PATH; no registry credential is created or read by this harness.
Scenarios:
  A. capability-render-matrix. Validate the advertised capability contract offline, then render every capability on and off from the chart directory and assert the advertised kinds.
  B. crd-separate-order. Prove the chart body renders no CustomResourceDefinition, that crds/ holds exactly the three definitions, and that the lifecycle runner refuses a Helm command without --skip-crds.
  C. fresh-install. Administer the CRDs and install into an empty namespace; assert revision 1, both rollouts, the T4ClusterHost, and that the chart created no PersistentVolumeClaim.
  D. additive-upgrade. Upgrade through the lifecycle runner; assert revision 2, the new digest set, Established CRDs, and storedVersions exactly v1alpha1.
  E. rollback. Roll back to the baseline revision; assert the previous digest set, unchanged CRDs, and retained custom resources.
  F. optional-adapters. Enable every adapter, assert each advertised object exists, disable them again, and assert the core install is unaffected.
  G. retained-state-reinstall. Create a Retain workspace, uninstall, prove CRDs and the PVC survive, reinstall, and prove the same PVC is re-adopted.
  H. clean-uninstall. Prove Delete retention removes its PVC, Retain retention keeps its PVC, the release is removed, and the CRDs remain installed.
Run prerequisites are validated before mutation. Live results are not implied by --plan.
Cleanup is explicit and is printed after a successful run; nothing is deleted implicitly.
PLAN
}

usage() {
  cat >&2 <<'USAGE'
usage: release-lifecycle.sh --plan | --run | --cleanup

  --plan     print the exact scenario plan; performs no cluster request
  --run      execute every scenario against a disposable cluster
  --cleanup  delete the harness namespace and the three CRDs it administered

Required for --run and --cleanup:
  T4_LIFECYCLE_NAMESPACE          disposable namespace beginning t4-lifecycle-
Required for --run:
  T4_LIFECYCLE_VALUES             baseline enabled values file
  T4_LIFECYCLE_UPGRADE_VALUES     additive upgrade values file with a new digest set
  T4_LIFECYCLE_ADAPTER_VALUES     values file enabling every optional adapter
Optional:
  T4_LIFECYCLE_RELEASE            Helm release name (default t4-cluster)
  T4_LIFECYCLE_TIMEOUT            wait timeout (default 300s)
  HELM, KUBECTL, NODE             tool overrides
USAGE
  exit 64
}

mode=${1:-}
[ "$#" -eq 1 ] || usage
case "$mode" in
  --plan) print_plan; exit 0 ;;
  --run | --cleanup) ;;
  *) usage ;;
esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
helm=${HELM:-helm}
kubectl=${KUBECTL:-kubectl}
node=${NODE:-node}
chart_directory=$repo_root/deploy/charts/t4-cluster
crd_directory=$chart_directory/crds
lifecycle_runner=$repo_root/scripts/cluster-ci/crd-lifecycle.sh
release=${T4_LIFECYCLE_RELEASE:-t4-cluster}
timeout=${T4_LIFECYCLE_TIMEOUT:-300s}
namespace=${T4_LIFECYCLE_NAMESPACE:-}
crds="crd/t4clusterhosts.cluster.t4.dev crd/t4workspaces.cluster.t4.dev crd/t4sessions.cluster.t4.dev"

case "$namespace" in
  t4-lifecycle-?*) ;;
  *) echo "T4_LIFECYCLE_NAMESPACE must begin t4-lifecycle-" >&2; exit 64 ;;
esac

if [ "$mode" = --cleanup ]; then
  "$kubectl" delete namespace "$namespace" --ignore-not-found --wait=true
  # shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
  "$kubectl" delete $crds --ignore-not-found --wait=true
  exit 0
fi

baseline_values=${T4_LIFECYCLE_VALUES:-}
upgrade_values=${T4_LIFECYCLE_UPGRADE_VALUES:-}
adapter_values=${T4_LIFECYCLE_ADAPTER_VALUES:-}
[ -r "$baseline_values" ] || { echo "T4_LIFECYCLE_VALUES must be a readable values file" >&2; exit 64; }
[ -r "$upgrade_values" ] || { echo "T4_LIFECYCLE_UPGRADE_VALUES must be a readable values file" >&2; exit 64; }
[ -r "$adapter_values" ] || { echo "T4_LIFECYCLE_ADAPTER_VALUES must be a readable values file" >&2; exit 64; }

scenario=""
scenario_log=$(mktemp)
render=$(mktemp)
cleanup_temporary() { rm -f "$scenario_log" "$render"; }
trap 'cleanup_temporary' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

begin() {
  scenario=$1
  printf 'scenario %s: start\n' "$scenario"
}

pass() {
  printf 'scenario %s: passed\n' "$scenario"
}

fail() {
  printf 'scenario %s: %s\n' "$scenario" "$1" >&2
  exit 1
}

# Assert the rendered manifest contains an exact line. Substring matching would
# accept a commented or unrelated occurrence.
render_contains() {
  grep -Fqx "$1" "$render" || fail "rendered manifest is missing the exact line: $1"
}

render_lacks() {
  if grep -Fqx "$1" "$render"; then fail "rendered manifest unexpectedly contains: $1"; fi
}

helm_template() {
  "$helm" template "$release" "$chart_directory" \
    --namespace "$namespace" --skip-crds "$@" >"$render"
}

require_deployment() {
  "$kubectl" -n "$namespace" get "deploy/$1" >/dev/null 2>&1 ||
    fail "expected Deployment $1 to exist"
}

require_absent() {
  if "$kubectl" -n "$namespace" get "$1" >/dev/null 2>&1; then
    fail "expected $1 to be absent"
  fi
}

release_revision() {
  "$helm" status "$release" --namespace "$namespace" -o json |
    "$node" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).version))'
}

workload_images() {
  "$kubectl" -n "$namespace" get deploy -o \
    'jsonpath={range .items[*]}{.metadata.name}={.spec.template.spec.containers[0].image}{"\n"}{end}' |
    LC_ALL=C sort
}

# ---------------------------------------------------------------------------
# Preflight. Every request here is read-only.
# ---------------------------------------------------------------------------
"$helm" version --short >/dev/null
"$kubectl" version --request-timeout=10s >/dev/null
[ "$("$kubectl" config current-context)" != "" ]
if "$kubectl" get namespace "$namespace" >/dev/null 2>&1; then
  echo "$namespace already exists; this harness never adopts an existing namespace" >&2
  exit 64
fi
for crd in $crds; do
  if "$kubectl" get "$crd" >/dev/null 2>&1; then
    echo "$crd is already installed; run --cleanup or choose a disposable cluster" >&2
    exit 64
  fi
done

# ---------------------------------------------------------------------------
# A. capability-render-matrix
# ---------------------------------------------------------------------------
begin capability-render-matrix
"$node" "$repo_root/scripts/cluster-ci/chart-capabilities.mjs"
"$helm" lint "$chart_directory" --values "$baseline_values"

helm_template
render_contains 'kind: Deployment'
render_contains 'kind: T4ClusterHost'
render_contains 'kind: NetworkPolicy'
render_contains 'kind: PodDisruptionBudget'
render_contains 'kind: ServiceAccount'
render_contains 'kind: ClusterRole'
render_lacks 'kind: CustomResourceDefinition'
render_lacks 'kind: Secret'
render_lacks 'kind: PersistentVolumeClaim'
render_lacks 'kind: StorageClass'
fail_closed_render=0
"$helm" template "$release" "$chart_directory" --namespace "$namespace" --skip-crds >"$render" 2>/dev/null || fail_closed_render=1
[ "$fail_closed_render" -eq 0 ] || fail "default values must render successfully"
if grep -q '[^[:space:]]' "$render"; then fail "default values must render nothing at all"; fi

# Every adapter is off in the baseline and on in the adapter overlay.
helm_template --values "$baseline_values"
render_lacks 'kind: DaemonSet'
render_lacks 'kind: Ingress'
render_lacks 'kind: ServiceMonitor'
render_lacks 'kind: PrometheusRule'
helm_template --values "$baseline_values" --values "$adapter_values"
render_contains 'kind: DaemonSet'
render_contains 'kind: Ingress'
render_contains 'kind: ServiceMonitor'
render_contains 'kind: PrometheusRule'
render_contains 'kind: HorizontalPodAutoscaler'
pass

# ---------------------------------------------------------------------------
# B. crd-separate-order
# ---------------------------------------------------------------------------
begin crd-separate-order
crd_files=$(ls "$crd_directory" | LC_ALL=C sort | tr '\n' ' ')
[ "$crd_files" = "t4clusterhosts.cluster.t4.dev.yaml t4sessions.cluster.t4.dev.yaml t4workspaces.cluster.t4.dev.yaml " ] ||
  fail "crds/ must hold exactly the three cluster.t4.dev definitions"
refused=0
"$lifecycle_runner" install -- "$helm" install "$release" "$chart_directory" \
  --namespace "$namespace" >"$scenario_log" 2>&1 || refused=$?
[ "$refused" -ne 0 ] || fail "the lifecycle runner accepted a Helm command without --skip-crds"
if "$kubectl" get namespace "$namespace" >/dev/null 2>&1; then
  fail "a refused lifecycle command must not create the namespace"
fi
pass

# ---------------------------------------------------------------------------
# C. fresh-install
# ---------------------------------------------------------------------------
begin fresh-install
"$lifecycle_runner" install -- "$helm" install "$release" "$chart_directory" \
  --namespace "$namespace" --create-namespace --skip-crds \
  --values "$baseline_values" --wait --timeout "$timeout"
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" wait --for=condition=Established --timeout="$timeout" $crds
[ "$(release_revision)" = 1 ] || fail "a fresh install must be revision 1"
require_deployment "$release-controller"
require_deployment "$release-server"
"$kubectl" -n "$namespace" rollout status "deploy/$release-controller" --timeout="$timeout"
"$kubectl" -n "$namespace" rollout status "deploy/$release-server" --timeout="$timeout"
"$kubectl" -n "$namespace" get t4clusterhost >/dev/null
[ -z "$("$kubectl" -n "$namespace" get pvc -o name)" ] ||
  fail "the portable chart must not create a PersistentVolumeClaim"
[ -z "$("$kubectl" -n "$namespace" get secret -l app.kubernetes.io/part-of=t4-cluster -o name)" ] ||
  fail "the portable chart must not create a Secret"
baseline_images=$(workload_images)
pass

# ---------------------------------------------------------------------------
# D. additive-upgrade
# ---------------------------------------------------------------------------
begin additive-upgrade
"$lifecycle_runner" upgrade -- "$helm" upgrade "$release" "$chart_directory" \
  --namespace "$namespace" --skip-crds \
  --values "$baseline_values" --values "$upgrade_values" --wait --timeout "$timeout"
[ "$(release_revision)" = 2 ] || fail "an upgrade must produce revision 2"
upgraded_images=$(workload_images)
[ "$upgraded_images" != "$baseline_images" ] ||
  fail "the upgrade values must change the digest set, otherwise rollback proves nothing"
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" wait --for=condition=Established --timeout="$timeout" $crds
for crd in $crds; do
  [ "$("$kubectl" get "$crd" -o 'jsonpath={.status.storedVersions[*]}')" = v1alpha1 ] ||
    fail "$crd storedVersions is not exactly v1alpha1"
done
"$kubectl" -n "$namespace" rollout status "deploy/$release-server" --timeout="$timeout"
pass

# ---------------------------------------------------------------------------
# E. rollback
# ---------------------------------------------------------------------------
begin rollback
"$helm" rollback "$release" 1 --namespace "$namespace" --wait --timeout "$timeout"
[ "$(release_revision)" = 3 ] || fail "a rollback must append revision 3"
[ "$(workload_images)" = "$baseline_images" ] ||
  fail "rollback did not restore the baseline digest set"
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" wait --for=condition=Established --timeout="$timeout" $crds
"$kubectl" -n "$namespace" get t4clusterhost >/dev/null
pass

# ---------------------------------------------------------------------------
# F. optional-adapters
# ---------------------------------------------------------------------------
begin optional-adapters
"$helm" upgrade "$release" "$chart_directory" --namespace "$namespace" --skip-crds \
  --values "$baseline_values" --values "$adapter_values" --wait --timeout "$timeout"
require_deployment "$release-ssh-gateway"
require_deployment "$release-model-gateway"
"$kubectl" -n "$namespace" get "daemonset/$release-runtime-prepull" >/dev/null
"$kubectl" -n "$namespace" get "ingress/$release" >/dev/null
"$kubectl" -n "$namespace" get "hpa/$release-server" >/dev/null
"$kubectl" -n "$namespace" get "hpa/$release-ssh-gateway" >/dev/null
[ -n "$("$kubectl" -n "$namespace" get servicemonitor -o name)" ] ||
  fail "the ServiceMonitor adapter rendered nothing"
[ -n "$("$kubectl" -n "$namespace" get prometheusrule -o name)" ] ||
  fail "the PrometheusRule adapter rendered nothing"
"$helm" upgrade "$release" "$chart_directory" --namespace "$namespace" --skip-crds \
  --values "$baseline_values" --wait --timeout "$timeout"
require_absent "deploy/$release-ssh-gateway"
require_absent "deploy/$release-model-gateway"
require_absent "daemonset/$release-runtime-prepull"
require_absent "ingress/$release"
require_absent "hpa/$release-ssh-gateway"
[ -z "$("$kubectl" -n "$namespace" get servicemonitor -o name)" ] ||
  fail "a disabled adapter left a ServiceMonitor behind"
[ -z "$("$kubectl" -n "$namespace" get prometheusrule -o name)" ] ||
  fail "a disabled adapter left a PrometheusRule behind"
require_deployment "$release-controller"
require_deployment "$release-server"
pass

# ---------------------------------------------------------------------------
# G. retained-state-reinstall
# ---------------------------------------------------------------------------
begin retained-state-reinstall
host_name=$("$kubectl" -n "$namespace" get t4clusterhost -o 'jsonpath={.items[0].metadata.name}')
[ -n "$host_name" ] || fail "the install did not declare a T4ClusterHost"
cat <<EOF | "$kubectl" apply -f -
apiVersion: cluster.t4.dev/v1alpha1
kind: T4Workspace
metadata:
  name: retained
  namespace: $namespace
spec:
  hostRef: $host_name
  displayName: retained lifecycle workspace
  owner: release-lifecycle-harness
  size: 1Gi
  retentionPolicy: Retain
EOF
"$kubectl" -n "$namespace" wait t4workspace/retained \
  --for=jsonpath='{.status.pvcPhase}'=Bound --timeout="$timeout"
retained_pvc=$("$kubectl" -n "$namespace" get t4workspace/retained \
  -o 'jsonpath={.status.pvcName}')
[ -n "$retained_pvc" ] || fail "the retained workspace never reported a PersistentVolumeClaim"
"$kubectl" -n "$namespace" wait "pvc/$retained_pvc" \
  --for=jsonpath='{.status.phase}'=Bound --timeout="$timeout"

"$helm" uninstall "$release" --namespace "$namespace" --wait
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" get $crds >/dev/null || fail "helm uninstall removed a CustomResourceDefinition"
"$kubectl" -n "$namespace" get t4workspace/retained >/dev/null ||
  fail "helm uninstall removed a retained workspace"
"$kubectl" -n "$namespace" get "pvc/$retained_pvc" >/dev/null ||
  fail "helm uninstall removed retained storage"

"$lifecycle_runner" install -- "$helm" install "$release" "$chart_directory" \
  --namespace "$namespace" --skip-crds \
  --values "$baseline_values" --wait --timeout "$timeout"
"$kubectl" -n "$namespace" rollout status "deploy/$release-controller" --timeout="$timeout"
readopted_pvc=$("$kubectl" -n "$namespace" get t4workspace/retained \
  -o 'jsonpath={.status.pvcName}')
[ "$readopted_pvc" = "$retained_pvc" ] ||
  fail "reinstall provisioned $readopted_pvc instead of re-adopting $retained_pvc"
[ "$("$kubectl" -n "$namespace" get pvc -o name | wc -l | tr -d ' ')" = 1 ] ||
  fail "reinstall left more than one PersistentVolumeClaim"
pass

# ---------------------------------------------------------------------------
# H. clean-uninstall
# ---------------------------------------------------------------------------
begin clean-uninstall
cat <<EOF | "$kubectl" apply -f -
apiVersion: cluster.t4.dev/v1alpha1
kind: T4Workspace
metadata:
  name: disposable
  namespace: $namespace
spec:
  hostRef: $host_name
  displayName: disposable lifecycle workspace
  owner: release-lifecycle-harness
  size: 1Gi
  retentionPolicy: Delete
EOF
"$kubectl" -n "$namespace" wait t4workspace/disposable \
  --for=jsonpath='{.status.pvcPhase}'=Bound --timeout="$timeout"
disposable_pvc=$("$kubectl" -n "$namespace" get t4workspace/disposable \
  -o 'jsonpath={.status.pvcName}')
"$kubectl" -n "$namespace" delete t4workspace/disposable --wait=true
require_absent "pvc/$disposable_pvc"

[ -z "$("$kubectl" -n "$namespace" get t4sessions -o name)" ] ||
  fail "sessions must be deleted and drained before uninstall"
"$kubectl" -n "$namespace" delete t4workspace/retained --wait=true
"$kubectl" -n "$namespace" get "pvc/$retained_pvc" >/dev/null ||
  fail "Retain retention did not orphan the PersistentVolumeClaim for recovery"

"$helm" uninstall "$release" --namespace "$namespace" --wait
require_absent "deploy/$release-controller"
require_absent "deploy/$release-server"
[ -z "$("$helm" list --namespace "$namespace" --all --short)" ] ||
  fail "a Helm release survived uninstall"
[ -z "$("$kubectl" -n "$namespace" get t4clusterhost -o name)" ] ||
  fail "the chart-owned T4ClusterHost survived uninstall"
# shellcheck disable=SC2086 # The fixed CRD words are intentional argv entries.
"$kubectl" get $crds >/dev/null ||
  fail "uninstall removed a CustomResourceDefinition; retained state would be unrecoverable"
pass

cat <<EOF
release lifecycle passed in namespace $namespace
The retained PersistentVolumeClaim $retained_pvc and all three CRDs are still
installed. That is the documented end state of a clean uninstall.
Deleting the CRDs removes every T4 custom resource in the cluster regardless of
retention intent. Clean up explicitly when the evidence has been recorded:
  T4_LIFECYCLE_NAMESPACE=$namespace $0 --cleanup
EOF
