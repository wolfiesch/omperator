#!/bin/sh
set -eu

# Runnable startup and failover measurement harness.
#
# It writes raw per-iteration samples under artifacts/cluster-slo/ and prints an
# observation fragment that can be pasted into compat/cluster-slo-evidence-v1.json.
# It never edits that ledger itself, and it refuses to emit an observation whose
# identity metadata is incomplete. An unmeasured entry is always preferable to a
# number nobody can reproduce.

print_plan() {
  cat <<'PLAN'
T4 startup and failover SLO measurement plan (read-only; no cluster requests)

Every run:
  * Requires T4_SLO_DISPOSABLE_CLUSTER=true and an explicit Kubernetes context.
  * Requires T4_SLO_COMMIT, the exact three measured digest image inputs, and
    T4_SLO_IMAGE_PUBLICATION_MANIFEST. The assembled t4-cluster-images/1 input,
    its verified cosign-keyless provenance/platform proof, and every referenced
    immutable evidence hash must match the source and live workloads.
  * Requires explicit build mode/flags/platform/architecture. The checked-out
    HEAD/tree and harness tree are hashed. Dirty source is refused unless its
    complete tracked diff is exactly T4_SLO_RETAINED_PATCH and manifest-bound.
  * Requires T4_SLO_ENVIRONMENT_ID to name a complete ledger environment whose
    structured live Kubernetes/cluster/node/storage/PVC/release fingerprint
    exact-matches every context before preflight and every iteration.
    Cold environment records declare exactly one full fingerprint per explicit
    context; the context set/count and cluster UIDs must be unique and exact.
  * Cache-sensitive runs require T4_SLO_NODE_IMAGE_INSPECT_ARGV to name an
    audited no-shell node image inspector returning a complete
    t4-node-image-inspection/1 inventory. Its exact executable is hashed and
    every node/image proof is retained.
  * Creates unique public REST workspaces/runtimes, deletes only those resources,
    preserves typed boundary/proof/cleanup events, bounded command output,
    executable hashes, build/source/environment identity, and per-iteration raw
    metadata. Numeric samples are derived from the typed event boundary.
  * Requires at least five independent measured iterations and explicitly uses
    warmupIterations=0.
  * Uses distinct T4_SLO_OPERATION_TIMEOUT_SECONDS,
    T4_SLO_ITERATION_TIMEOUT_SECONDS, T4_SLO_CLEANUP_TIMEOUT_SECONDS, and
    T4_SLO_WHOLE_RUN_TIMEOUT_SECONDS deadlines. On success, failure, or timeout,
    measurement work is cooperatively aborted and settled before the cleanup
    deadline owns recovery and baseline restoration. No next iteration begins
    before successful cleanup.

Exact scenario boundaries:
  control-plane-cold-start
    T4_SLO_COLD_CONTEXTS must name one distinct disposable cluster per iteration.
    Each derived namespace must not exist. The driver renders the exact Helm
    install, proves every rendered image is digest-pinned and absent from every
    node image store, then times from Helm install return until both controller
    and server Deployments are Available with all replicas ready. It uninstalls
    the release and deletes the iteration namespace.

  session-cold-first-attach
    T4_SLO_COLD_CONTEXTS/NAMESPACES/REST_BASE_URLS must name one distinct installed
    cluster per iteration. The session-runtime image must be absent from every
    Ready schedulable node. A unique workspace and runtime are accepted through
    the public REST API without waiting for PVC binding; the timed boundary is
    client-visible runtime create-request start (requestStartedAtMs) through
    FenceProven and RouteReady.

  session-warm-first-attach
    Requires the runtime-prepull DaemonSet fully ready and the runtime image
    present on every Ready schedulable node. A unique workspace PVC is first
    proven Bound. The timed boundary is client-visible runtime create-request
    start (requestStartedAtMs) through FenceProven and RouteReady.

  controller-leader-failover
    Creates and readies an owned reconcile-probe workspace, deletes the exact
    Lease-holder Pod by UID, observes a different surviving holder, patches the
    probe through the public REST API, and stops only after its new generation is
    reconciled and Ready.
    Each failover iteration begins only when the current controller Deployment
    generation has every desired replica Ready and Available, and the exact same
    UID/generation/replica baseline must be restored before the next iteration.

  gateway-replica-failover
    Creates a warm real runtime, attaches one paired reconnect-capable typed
    omp-app/1 client, maps its welcome replica UID to the serving server Pod,
    and deletes that Pod by UID. Without closing or replacing that client, or
    manually issuing session.attach, it times until the same instance reconnects
    to a pre-existing Ready survivor and automatically replays the saved attached
    session cursor at or beyond the pre-failure cursor.
    Each failover iteration begins only when the current server Deployment
    generation has every desired replica Ready and Available, and restores that
    exact baseline before another sample may begin.

  fenced-generation-replacement
    Creates a warm real runtime, invokes T4_SLO_NODE_FAILURE_ARGV against its
    actual node, begins timing when Kubernetes observes that node unavailable,
    and waits for a fresh generation with FenceProven and RouteReady. Every
    active session-owned writer Pod and every held session-owned writer Lease is
    counted across current, old, and unknown generations. Exactly one Pod/Lease
    pair may remain; both must match the current generation and each other, so
    old or unknown authority can never pass. Every sample retains the complete
    writer/Lease snapshots and records invariant=held or invariant=violated.
    Cleanup recovers the node and exactly restores the captured node, storage,
    VolumeAttachment, and fence baseline before owned resources are deleted,
    including after the final iteration.

Artifacts:
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/samples.tsv
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/commands.jsonl
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/events.jsonl
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/identity.json
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/run-manifest.json
  artifacts/cluster-slo/<scenario>/<timestamp>-<run>/observation.json
PLAN
}

usage() {
  cat >&2 <<'USAGE'
usage: measure-slo.sh --plan | --run SCENARIO

Scenarios:
  control-plane-cold-start
  session-cold-first-attach
  session-warm-first-attach
  controller-leader-failover
  gateway-replica-failover
  fenced-generation-replacement

Required for every --run:
  T4_SLO_DISPOSABLE_CLUSTER=true
  T4_SLO_COMMIT                 exact lowercase 40-character image source revision
  T4_SLO_ENVIRONMENT_ID         environment id present in the SLO evidence ledger
  T4_SLO_CONTROLLER_IMAGE       digest reference (repository@sha256:...)
  T4_SLO_SERVER_IMAGE           digest reference (repository@sha256:...)
  T4_SLO_SESSION_RUNTIME_IMAGE  digest reference (repository@sha256:...)
  T4_SLO_IMAGE_PUBLICATION_MANIFEST assembled artifacts/cluster-proof/image-publication.json
  T4_SLO_BUILD_MODE              production|release|profiling|ci|local
  T4_SLO_BUILD_FLAGS             bounded JSON string array (use [] when none)
  T4_SLO_PLATFORM                linux
  T4_SLO_ARCHITECTURE            amd64|arm64, proved by provenance and live nodes

Required except control-plane-cold-start:
  T4_SLO_NAMESPACE
  T4_SLO_CONTEXT                explicit context (cold session uses the lists below)
  T4_SLO_REST_BASE_URL          public HTTPS /v1 endpoint (cold session uses list)
  T4_SLO_API_TOKEN              public REST bearer credential; never written
  T4_SLO_SCOPE_ID
  T4_SLO_HOST_PROFILE_ID

Required except controller-leader-failover:
  T4_SLO_NODE_IMAGE_INSPECT_ARGV
      JSON argv array containing {context} and {node}; no shell. It must inspect
      that node's actual container-runtime image store and print exactly one
      exhaustive JSON inventory with schemaVersion=t4-node-image-inspection/1,
      matching context/node, complete=true, a non-empty runtime identity, and a
      bounded unique images array of immutable digest references.

Required for control-plane-cold-start:
  T4_SLO_COLD_CONTEXTS                 distinct comma-separated contexts, one per iteration
  T4_SLO_DISPOSABLE_NAMESPACE_PREFIX  prefix for absent per-iteration namespaces
  T4_SLO_CHART                         exact chart directory or archive
  T4_SLO_VALUES_FILE                   exact non-secret Helm values file

Required for session-cold-first-attach:
  T4_SLO_COLD_CONTEXTS          distinct comma-separated contexts, one per iteration
  T4_SLO_COLD_NAMESPACES        installed release namespaces, one per iteration
  T4_SLO_COLD_REST_BASE_URLS    public HTTPS /v1 endpoints, one per iteration

Required for gateway-replica-failover:
  T4_SLO_OMP_APP_URL            public WSS /v1/ws endpoint
  T4_SLO_DEVICE_ID
  T4_SLO_DEVICE_TOKEN           omp-app/1 device credential; never written

Required for fenced-generation-replacement:
  T4_SLO_FAILURE_MECHANISM_ID   stable audited mechanism name
  T4_SLO_STORAGE_DRIVER         exact CSI/storage driver identity
  T4_SLO_NODE_FAILURE_ARGV      JSON argv array containing {node}; no shell
  T4_SLO_NODE_RECOVERY_ARGV     JSON argv array containing {node}; no shell

Optional:
  T4_SLO_RELEASE                 release name (default t4-cluster)
  T4_SLO_ITERATIONS              minimum 5 (default 5)
  T4_SLO_TIMEOUT_SECONDS         per operation/iteration timeout (default 600)
  T4_SLO_OPERATION_TIMEOUT_SECONDS   one command/REST/poll cap (default legacy timeout or 600)
  T4_SLO_ITERATION_TIMEOUT_SECONDS   one monotonic measured-iteration cap
  T4_SLO_CLEANUP_TIMEOUT_SECONDS     post-sample cleanup/restoration cap (default 120)
  T4_SLO_WHOLE_RUN_TIMEOUT_SECONDS   monotonic whole-run cap
  T4_SLO_RETAINED_PATCH              required only for tracked dirty source; exact git diff --binary HEAD
  T4_SLO_WORKSPACE_CAPACITY_BYTES (default 1073741824)
  T4_SLO_OUTPUT_DIR              must remain under artifacts/cluster-slo
  KUBECTL, HELM, NODE, BUN       executable overrides
USAGE
  exit 64
}

case "${1:-}" in
  --plan)
    [ "$#" -eq 1 ] || usage
    print_plan
    ;;
  --run)
    [ "$#" -eq 2 ] || usage
    repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
    exec "${BUN:-bun}" "$repo_root/scripts/cluster-ci/measure-slo-driver.mjs" "$@"
    ;;
  *)
    usage
    ;;
esac
