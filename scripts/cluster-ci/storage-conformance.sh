#!/bin/sh
set -eu

print_plan() {
  cat <<'EOF'
T4 storage conformance plan (read-only; no cluster requests)
Prerequisites:
  1. kubectl context explicitly names a disposable non-production cluster.
  2. At least two schedulable Linux nodes with CSI topology/reattach support.
  3. An installed CSI provisioner exposing an online-expandable ReadWriteMany StorageClass.
  4. A separate online-expandable ReadWriteOncePod or ReadWriteOnce runtime-state StorageClass.
  5. snapshot.storage.k8s.io/v1 VolumeSnapshot and VolumeSnapshotClass APIs; both selected StorageClasses must have a compatible snapshot class/driver.
  6. T4_STORAGE_FIXTURE_IMAGE is a digest-pinned image containing POSIX sh and sqlite3; no pull credentials are created or read by this harness.
  7. T4_STORAGE_NAMESPACE starts with t4-storage-conformance- and is disposable.
Scenarios:
  A. Provision workspace RWX and separate fenced runtime-state PVCs; verify selected access modes and online expansion.
  B. Write shared workspace data plus SQLite WAL, cmux state, browser state, and OMP generation state.
  C. Attempt a second runtime-state writer, replace the writer onto a different node, and prove single-writer reattach plus durable reads.
  D. Quiesce SQLite/OMP/cmux/browser for the exact generation, stop the writer, and create separately labeled workspace and runtime-state snapshots.
  E. Restore both ReadyToUse snapshots into new PVCs, start a fresh generation, and prove workspace/runtime-state data and generation separation.
  F. Record bounded conformance annotations only after every proof passes; namespace cleanup remains explicit.
Run prerequisites are validated before mutation. Live results are not implied by --plan.
EOF
}

usage() {
  cat >&2 <<'EOF'
usage: storage-conformance.sh --plan
       storage-conformance.sh --run
       storage-conformance.sh --cleanup

--run environment (all required):
  T4_STORAGE_NAMESPACE          disposable namespace beginning t4-storage-conformance-
  T4_WORKSPACE_STORAGE_CLASS    RWX StorageClass
  T4_RUNTIME_STORAGE_CLASS      RWOP/RWO runtime-state StorageClass
  T4_RUNTIME_ACCESS_MODE        ReadWriteOncePod or ReadWriteOnce
  T4_VOLUME_SNAPSHOT_CLASS      compatible VolumeSnapshotClass
  T4_STORAGE_FIXTURE_IMAGE      digest-pinned image with sh and sqlite3
Optional: KUBECTL (default kubectl), T4_STORAGE_TIMEOUT (default 180s)
EOF
  exit 64
}

mode=${1:-}
[ "$#" -eq 1 ] || usage
case "$mode" in
  --plan) print_plan; exit 0 ;;
  --run|--cleanup) ;;
  *) usage ;;
esac

kubectl=${KUBECTL:-kubectl}
namespace=${T4_STORAGE_NAMESPACE:-}
case "$namespace" in t4-storage-conformance-?*) ;; *) echo "T4_STORAGE_NAMESPACE must begin t4-storage-conformance-" >&2; exit 64 ;; esac

if [ "$mode" = --cleanup ]; then
  "$kubectl" delete namespace "$namespace" --wait=true
  exit 0
fi

workspace_class=${T4_WORKSPACE_STORAGE_CLASS:-}
runtime_class=${T4_RUNTIME_STORAGE_CLASS:-}
runtime_mode=${T4_RUNTIME_ACCESS_MODE:-}
snapshot_class=${T4_VOLUME_SNAPSHOT_CLASS:-}
fixture_image=${T4_STORAGE_FIXTURE_IMAGE:-}
timeout=${T4_STORAGE_TIMEOUT:-180s}
[ -n "$workspace_class" ] || { echo "T4_WORKSPACE_STORAGE_CLASS is required" >&2; exit 64; }
[ -n "$runtime_class" ] || { echo "T4_RUNTIME_STORAGE_CLASS is required" >&2; exit 64; }
case "$runtime_mode" in ReadWriteOncePod|ReadWriteOnce) ;; *) echo "T4_RUNTIME_ACCESS_MODE must be ReadWriteOncePod or ReadWriteOnce" >&2; exit 64 ;; esac
[ -n "$snapshot_class" ] || { echo "T4_VOLUME_SNAPSHOT_CLASS is required" >&2; exit 64; }
case "$fixture_image" in *@sha256:????????????????????????????????????????????????????????????????) ;; *) echo "T4_STORAGE_FIXTURE_IMAGE must be digest-pinned" >&2; exit 64 ;; esac

# All preflight requests are read-only. The namespace must not already exist so
# the harness never adopts or deletes an ambiguous target.
"$kubectl" version --request-timeout=10s >/dev/null
[ "$("$kubectl" config current-context)" != "" ]
"$kubectl" get nodes -l 'kubernetes.io/os=linux' -o name | awk 'END { exit(NR >= 2 ? 0 : 1) }'
"$kubectl" get storageclass "$workspace_class" >/dev/null
"$kubectl" get storageclass "$runtime_class" >/dev/null
"$kubectl" get volumesnapshotclass.snapshot.storage.k8s.io "$snapshot_class" >/dev/null
workspace_driver=$("$kubectl" get storageclass "$workspace_class" -o 'jsonpath={.provisioner}')
runtime_driver=$("$kubectl" get storageclass "$runtime_class" -o 'jsonpath={.provisioner}')
snapshot_driver=$("$kubectl" get volumesnapshotclass.snapshot.storage.k8s.io "$snapshot_class" -o 'jsonpath={.driver}')
workspace_expansion=$("$kubectl" get storageclass "$workspace_class" -o 'jsonpath={.allowVolumeExpansion}')
runtime_expansion=$("$kubectl" get storageclass "$runtime_class" -o 'jsonpath={.allowVolumeExpansion}')
[ "$workspace_expansion" = true ] && [ "$runtime_expansion" = true ] || {
  echo "selected StorageClasses must both allow online expansion" >&2
  exit 65
}
[ -n "$workspace_driver" ] && [ "$workspace_driver" = "$runtime_driver" ] && [ "$runtime_driver" = "$snapshot_driver" ] || {
  echo "selected StorageClasses and VolumeSnapshotClass must use the same CSI driver" >&2
  exit 65
}
if "$kubectl" get namespace "$namespace" >/dev/null 2>&1; then
  echo "refusing to adopt existing namespace $namespace" >&2
  exit 65
fi

"$kubectl" create namespace "$namespace"
cat <<EOF | "$kubectl" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: workspace
  namespace: $namespace
spec:
  accessModes: [ReadWriteMany]
  storageClassName: $workspace_class
  resources: {requests: {storage: 1Gi}}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: runtime-state
  namespace: $namespace
spec:
  accessModes: [$runtime_mode]
  storageClassName: $runtime_class
  resources: {requests: {storage: 1Gi}}
EOF
"$kubectl" -n "$namespace" wait pvc/workspace pvc/runtime-state --for=jsonpath='{.status.phase}'=Bound --timeout="$timeout"

cat <<EOF | "$kubectl" apply -f -
apiVersion: v1
kind: Pod
metadata: {name: writer-g1, namespace: $namespace, labels: {cluster.t4.dev/runtime-generation: gen_conformance_1}}
spec:
  restartPolicy: Never
  containers:
  - name: fixture
    image: $fixture_image
    command: [sh, -ceu]
    args:
    - |
      echo workspace-shared > /workspace/shared.txt
      sqlite3 /runtime/cmux.db 'PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES("cmux-g1");'
      mkdir -p /runtime/omp /runtime/cmux /runtime/browser
      echo gen_conformance_1 > /runtime/omp/generation
      echo cmux-g1 > /runtime/cmux/durable
      echo browser-g1 > /runtime/browser/durable
      touch /runtime/writer-ready
      sleep 3600
    volumeMounts:
    - {name: workspace, mountPath: /workspace}
    - {name: runtime, mountPath: /runtime}
  volumes:
  - name: workspace
    persistentVolumeClaim: {claimName: workspace}
  - name: runtime
    persistentVolumeClaim: {claimName: runtime-state}
EOF
"$kubectl" -n "$namespace" wait pod/writer-g1 --for=condition=Ready --timeout="$timeout"
old_node=$("$kubectl" -n "$namespace" get pod writer-g1 -o 'jsonpath={.spec.nodeName}')
"$kubectl" -n "$namespace" exec writer-g1 -- test -f /runtime/writer-ready
"$kubectl" -n "$namespace" patch pvc workspace --type=merge -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'
"$kubectl" -n "$namespace" patch pvc runtime-state --type=merge -p '{"spec":{"resources":{"requests":{"storage":"2Gi"}}}}'
"$kubectl" -n "$namespace" wait pvc/workspace pvc/runtime-state --for=jsonpath='{.status.capacity.storage}'=2Gi --timeout="$timeout"

# A second writer is deliberately constrained away from the current node. It
# must not become Ready while generation 1 remains attached.
cat <<EOF | "$kubectl" apply -f -
apiVersion: v1
kind: Pod
metadata: {name: writer-contender, namespace: $namespace}
spec:
  restartPolicy: Never
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - {key: kubernetes.io/hostname, operator: NotIn, values: [$old_node]}
  containers:
  - name: fixture
    image: $fixture_image
    command: [sh, -ceu]
    args: ['test -f /runtime/writer-ready; sleep 3600']
    volumeMounts:
    - {name: runtime, mountPath: /runtime}
  volumes:
  - name: runtime
    persistentVolumeClaim: {claimName: runtime-state}
EOF
sleep 10
if [ "$("$kubectl" -n "$namespace" get pod writer-contender -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')" = True ]; then
  echo "runtime-state admitted two cross-node writers" >&2
  exit 1
fi
"$kubectl" -n "$namespace" delete pod writer-contender --wait=true

# Force the first writer away, then require the same fenced volume to remount on
# a different node and preserve workspace plus runtime authority state.
"$kubectl" -n "$namespace" delete pod writer-g1 --wait=true
cat <<EOF | "$kubectl" apply -f -
apiVersion: v1
kind: Pod
metadata: {name: writer-g1-remount, namespace: $namespace, labels: {cluster.t4.dev/runtime-generation: gen_conformance_1}}
spec:
  restartPolicy: Never
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
        - matchExpressions:
          - {key: kubernetes.io/hostname, operator: NotIn, values: [$old_node]}
  containers:
  - name: fixture
    image: $fixture_image
    command: [sh, -ceu]
    args:
    - |
      test "\$(cat /workspace/shared.txt)" = workspace-shared
      test "\$(sqlite3 /runtime/cmux.db 'SELECT value FROM proof;')" = cmux-g1
      sleep 3600
    volumeMounts:
    - {name: workspace, mountPath: /workspace}
    - {name: runtime, mountPath: /runtime}
  volumes:
  - name: workspace
    persistentVolumeClaim: {claimName: workspace}
  - name: runtime
    persistentVolumeClaim: {claimName: runtime-state}
EOF
"$kubectl" -n "$namespace" wait pod/writer-g1-remount --for=condition=Ready --timeout="$timeout"
new_node=$("$kubectl" -n "$namespace" get pod writer-g1-remount -o 'jsonpath={.spec.nodeName}')
[ "$new_node" != "$old_node" ] || { echo "runtime-state did not remount on a different node" >&2; exit 1; }

# Quiesce the exact generation and stop all writers before snapshot creation.
"$kubectl" -n "$namespace" exec writer-g1-remount -- sh -ceu 'sqlite3 /runtime/cmux.db "PRAGMA wal_checkpoint(TRUNCATE);"; sync; echo gen_conformance_1 > /runtime/omp/checkpoint.ack; echo gen_conformance_1 > /runtime/cmux/checkpoint.ack; echo gen_conformance_1 > /runtime/browser/checkpoint.ack'
"$kubectl" -n "$namespace" delete pod writer-g1-remount --wait=true
cat <<EOF | "$kubectl" apply -f -
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: workspace-g1
  namespace: $namespace
  labels: {cluster.t4.dev/snapshot-source: workspace, cluster.t4.dev/snapshot-consistency: Quiesced, cluster.t4.dev/runtime-generation: gen_conformance_1}
spec: {volumeSnapshotClassName: $snapshot_class, source: {persistentVolumeClaimName: workspace}}
---
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: runtime-g1
  namespace: $namespace
  labels: {cluster.t4.dev/snapshot-source: runtime-state, cluster.t4.dev/snapshot-consistency: Quiesced, cluster.t4.dev/runtime-generation: gen_conformance_1}
spec: {volumeSnapshotClassName: $snapshot_class, source: {persistentVolumeClaimName: runtime-state}}
EOF
"$kubectl" -n "$namespace" wait volumesnapshot/workspace-g1 volumesnapshot/runtime-g1 --for=jsonpath='{.status.readyToUse}'=true --timeout="$timeout"
if [ -n "$("$kubectl" -n "$namespace" get pods -l 'cluster.t4.dev/runtime-generation=gen_conformance_1' -o name)" ]; then
  echo "generation 1 runtime remained active during restore" >&2
  exit 1
fi

cat <<EOF | "$kubectl" apply -f -
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: workspace-restored, namespace: $namespace}
spec:
  accessModes: [ReadWriteMany]
  storageClassName: $workspace_class
  dataSource: {apiGroup: snapshot.storage.k8s.io, kind: VolumeSnapshot, name: workspace-g1}
  resources: {requests: {storage: 2Gi}}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: runtime-restored, namespace: $namespace}
spec:
  accessModes: [$runtime_mode]
  storageClassName: $runtime_class
  dataSource: {apiGroup: snapshot.storage.k8s.io, kind: VolumeSnapshot, name: runtime-g1}
  resources: {requests: {storage: 2Gi}}
---
apiVersion: v1
kind: Pod
metadata: {name: restore-g2, namespace: $namespace, labels: {cluster.t4.dev/runtime-generation: gen_conformance_2}}
spec:
  restartPolicy: Never
  containers:
  - name: fixture
    image: $fixture_image
    command: [sh, -ceu]
    args:
    - |
      test "\$(cat /workspace/shared.txt)" = workspace-shared
      test "\$(cat /runtime/omp/generation)" = gen_conformance_1
      test "\$(cat /runtime/omp/checkpoint.ack)" = gen_conformance_1
      test "\$(cat /runtime/cmux/checkpoint.ack)" = gen_conformance_1
      test "\$(cat /runtime/browser/checkpoint.ack)" = gen_conformance_1
      test "\$(sqlite3 /runtime/cmux.db 'SELECT value FROM proof;')" = cmux-g1
      echo gen_conformance_2 > /runtime/omp/generation
    volumeMounts:
    - {name: workspace, mountPath: /workspace}
    - {name: runtime, mountPath: /runtime}
  volumes:
  - name: workspace
    persistentVolumeClaim: {claimName: workspace-restored}
  - name: runtime
    persistentVolumeClaim: {claimName: runtime-restored}
EOF
"$kubectl" -n "$namespace" wait pod/restore-g2 --for=jsonpath='{.status.phase}'=Succeeded --timeout="$timeout"

"$kubectl" annotate storageclass "$workspace_class" cluster.t4.dev/conformance-rwx-remount=passed --overwrite
"$kubectl" annotate storageclass "$runtime_class" cluster.t4.dev/conformance-runtime-reattach=passed --overwrite
"$kubectl" annotate volumesnapshotclass "$snapshot_class" cluster.t4.dev/conformance-snapshot-restore=passed --overwrite

cat <<EOF
storage conformance passed in namespace $namespace
bounded observations recorded:
  storageclass/$workspace_class cluster.t4.dev/conformance-rwx-remount=passed
  storageclass/$runtime_class cluster.t4.dev/conformance-runtime-reattach=passed
  volumesnapshotclass/$snapshot_class cluster.t4.dev/conformance-snapshot-restore=passed
cleanup:
  T4_STORAGE_NAMESPACE=$namespace $0 --cleanup
EOF
