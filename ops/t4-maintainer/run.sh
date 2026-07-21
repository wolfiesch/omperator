#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

# Keep the user manager's full environment and make the normal per-user tool
# locations available after boot as well as during a desktop login.
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
MAINTAINER_ROOT=${T4_MAINTAINER_ROOT:-"${XDG_DATA_HOME:-$HOME/.local/share}/t4-maintainer"}
PROMPT_FILE=${T4_MAINTAINER_PROMPT_FILE:-"$SCRIPT_DIR/prompt.md"}
STATE_DIR="$MAINTAINER_ROOT/state"
RUNS_DIR="$MAINTAINER_ROOT/runs"
WORK_DIR="$MAINTAINER_ROOT/work"
LOGS_DIR="$MAINTAINER_ROOT/logs"
DEPLOYMENTS_DIR=${T4_LOCAL_DEPLOYMENTS_DIR:-"$MAINTAINER_ROOT/deployments"}
LOCK_FILE="$STATE_DIR/maintainer.lock"
PROCESSED_FILE="$STATE_DIR/processed.json"
PENDING_FILE="$STATE_DIR/pending.json"
LOCAL_APPLIED_FILE="$STATE_DIR/local-applied.json"
BLOCKED_FILE="$STATE_DIR/deployment-blocked.json"
FORK_SYNC_FILE="$STATE_DIR/fork-main-sync.json"
ATOMIC_PUBLICATION_STATE_DIR=${T4_MAINTAINER_ATOMIC_STATE_DIR:-"$STATE_DIR/atomic-publication"}

GH=${T4_MAINTAINER_GH:-gh}
CURL=${T4_MAINTAINER_CURL:-curl}
JQ=${T4_MAINTAINER_JQ:-jq}
OMP=${T4_MAINTAINER_OMP:-omp}
SHA256SUM=${T4_MAINTAINER_SHA256SUM:-sha256sum}
SYSTEMCTL=${T4_MAINTAINER_SYSTEMCTL:-systemctl}
DPKG_QUERY=${T4_MAINTAINER_DPKG_QUERY:-dpkg-query}
DPKG=${T4_MAINTAINER_DPKG:-dpkg}
GIT=${T4_MAINTAINER_GIT:-git}
NODE=${T4_MAINTAINER_NODE:-node}
if [[ -f "$SCRIPT_DIR/inspect-linux-update.mjs" ]]; then
  DEFAULT_LINUX_UPDATE_INSPECTOR="$SCRIPT_DIR/inspect-linux-update.mjs"
else
  DEFAULT_LINUX_UPDATE_INSPECTOR="$SCRIPT_DIR/../../scripts/inspect-linux-update.mjs"
fi
LINUX_UPDATE_INSPECTOR=${T4_MAINTAINER_LINUX_UPDATE_INSPECTOR:-$DEFAULT_LINUX_UPDATE_INSPECTOR}
REALPATH=${T4_MAINTAINER_REALPATH:-realpath}
SYNC=${T4_MAINTAINER_SYNC:-/bin/sync}
DATE=${T4_MAINTAINER_DATE:-/bin/date}
UNAME=${T4_MAINTAINER_UNAME:-/usr/bin/uname}
STAT=${T4_MAINTAINER_STAT:-stat}
SETPRIV=${T4_MAINTAINER_SETPRIV:-/usr/bin/setpriv}
PROC_ROOT=${T4_MAINTAINER_TEST_PROC_ROOT:-/proc}
LOCAL_DEPLOY=${T4_MAINTAINER_LOCAL_DEPLOY:-"$SCRIPT_DIR/deploy-local.sh"}
ATOMIC_PUBLISH=${T4_MAINTAINER_ATOMIC_PUBLISH:-"$SCRIPT_DIR/publish-omp-atomic.sh"}
NOTIFY_HELPER=${T4_MAINTAINER_NOTIFY_HELPER:-"$SCRIPT_DIR/notify.py"}
NOTIFY_SECRET_FILE=${T4_MAINTAINER_HERMES_SECRET_FILE:-"$MAINTAINER_ROOT/secrets/hermes-webhook.secret"}
NOTIFY_URL=${T4_MAINTAINER_HERMES_URL:-http://127.0.0.1:8644/webhooks/t4-maintainer}
NOTIFY_ROUTE=${T4_MAINTAINER_HERMES_ROUTE:-t4-maintainer}
NOTIFY_STATE_FILE="$STATE_DIR/notification-state.json"
CURRENT_STAGE=idle
CURRENT_VERSION=
CURRENT_TAG=
CURRENT_COMMIT=
CURRENT_RESULT_FILE=
CURRENT_RECEIPT_FILE=
HOST_PLATFORM=
VERIFY_ATTEMPTS=${T4_MAINTAINER_VERIFY_ATTEMPTS:-91}
VERIFY_INTERVAL_SECONDS=${T4_MAINTAINER_VERIFY_INTERVAL_SECONDS:-30}
FORK_SYNC_ATTEMPTS=${T4_MAINTAINER_FORK_SYNC_ATTEMPTS:-3}
FORK_SYNC_EVENT_QUIESCE_SECONDS=${T4_MAINTAINER_FORK_SYNC_EVENT_QUIESCE_SECONDS:-30}
FORK_SYNC_RUN_SETTLE_ATTEMPTS=${T4_MAINTAINER_FORK_SYNC_RUN_SETTLE_ATTEMPTS:-18}
FORK_SYNC_RUN_SETTLE_INTERVAL_SECONDS=${T4_MAINTAINER_FORK_SYNC_RUN_SETTLE_INTERVAL_SECONDS:-5}
FORK_SYNC_RUN_QUIET_POLLS=${T4_MAINTAINER_FORK_SYNC_RUN_QUIET_POLLS:-3}
FORK_SYNC_RUN_MIN_OBSERVATION_POLLS=${T4_MAINTAINER_FORK_SYNC_RUN_MIN_OBSERVATION_POLLS:-7}
SLEEP=${T4_MAINTAINER_SLEEP:-sleep}

readonly OMP_UPSTREAM_REPOSITORY="can1357/oh-my-pi"
readonly OMP_INTEGRATION_REPOSITORY="lyc-aon/oh-my-pi"
readonly OMP_PRODUCT_BRANCH="t4code/main"
readonly OMP_FORK_WORKFLOW="ci.yml"
readonly OMP_UPSTREAM_URL="https://github.com/can1357/oh-my-pi.git"
readonly OMP_INTEGRATION_URL="https://github.com/lyc-aon/oh-my-pi.git"
readonly T4_REPOSITORY="LycaonLLC/t4-code"
readonly T4_SITE="https://t4code.net"
T4_MAIN_GATE_SHA=
T4_MAIN_SOL_SHA=
VALIDATED_DEFERRAL_REASON=
VALIDATED_DEFERRAL_PR_NUMBER=
VALIDATED_DEFERRAL_OBSERVED_SHA=
readonly T4_PACKAGE="t4-code"
readonly OMP_TARGET="${T4_LOCAL_OMP_TARGET:-$HOME/bin/omp}"
readonly OMP_SERVICE="${T4_LOCAL_OMP_SERVICE:-dev.oh-my-pi.appserver.service}"
readonly GATEWAY_SERVICE="${T4_LOCAL_GATEWAY_SERVICE:-com.lycaonsolutions.t4code.tailnet-gateway.service}"
readonly GATEWAY_CONFIG="${T4_LOCAL_GATEWAY_CONFIG:-$HOME/.config/t4-code/tailnet-gateway.json}"
readonly GATEWAY_UNIT="${T4_LOCAL_GATEWAY_UNIT:-$HOME/.config/systemd/user/$GATEWAY_SERVICE}"
TAILNET_REACHABILITY_REPORTED=false
RESUME_PUBLICATION_JSON=null

timestamp() {
  "$DATE" -u +'%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  notify_failure "$*" || true
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_date_command() {
  if ! command -v "$DATE" >/dev/null 2>&1; then
    printf 'ERROR: required command is unavailable: %s\n' "$DATE" >&2
    exit 1
  fi
}

notification_result_json() {
  if [[ -s ${CURRENT_RESULT_FILE:-} ]]; then
    $JQ -c '.' "$CURRENT_RESULT_FILE" 2>/dev/null || printf 'null'
  else
    printf 'null'
  fi
}

notify_delivery() {
  local payload=$1
  [[ -x $NOTIFY_HELPER ]] || {
    log "WARNING: notification helper is unavailable; continuing without Hermes delivery."
    return 1
  }
  [[ -n $NOTIFY_SECRET_FILE ]] || {
    log "WARNING: notification secret is not configured; continuing without Hermes delivery."
    return 1
  }
  if ! printf '%s' "$payload" | "$NOTIFY_HELPER" \
    --url "$NOTIFY_URL" --route "$NOTIFY_ROUTE" --secret-file "$NOTIFY_SECRET_FILE"; then
    log "WARNING: Hermes notification delivery failed; release correctness is unchanged."
    return 1
  fi
  return 0
}

notify_event() {
  local event_type=$1 stage=$2 blocker_key=${3:-} reason=${4:-} result_json payload
  result_json=$(notification_result_json)
  payload=$($JQ -cn \
    --arg event_type "$event_type" \
    --arg occurred_at "$(timestamp)" \
    --arg stage "$stage" \
    --arg version "${CURRENT_VERSION:-}" \
    --arg tag "${CURRENT_TAG:-}" \
    --arg commit "${CURRENT_COMMIT:-}" \
    --arg blocker_key "$blocker_key" \
    --arg reason "$reason" \
    --arg run_id "${RUN_ID:-}" \
    --arg result_file "${CURRENT_RESULT_FILE:-}" \
    --arg receipt_file "${CURRENT_RECEIPT_FILE:-}" \
    --argjson result "$result_json" '
      {
        schemaVersion: 1,
        eventType: $event_type,
        occurredAt: $occurred_at,
        stage: $stage,
        version: (if $version == "" then null else $version end),
        tag: (if $tag == "" then null else $tag end),
        commit: (if $commit == "" then null else $commit end),
        release: ($result.release // null),
        site: ($result.site // null),
        upstream: ($result.upstream // null),
        integration: ($result.integration // null),
        t4: ($result.t4 // null),
        runId: (if $run_id == "" then null else $run_id end),
      }
      + {reason: $reason}
      + (if $blocker_key == "" then {} else {blocker: {key: $blocker_key}} end)
    ') || return 1
  notify_delivery "$payload"
}

notify_blocker_once() {
  local event_type=$1 stage=$2 blocker_key=$3 reason=$4
  if [[ -s $NOTIFY_STATE_FILE ]] \
    && $JQ -e --arg key "$blocker_key" '.schemaVersion == 1 and .blockers[$key] == true' \
      "$NOTIFY_STATE_FILE" >/dev/null 2>&1; then
    return 0
  fi
  notify_event "$event_type" "$stage" "$blocker_key" "$reason" || return 1
  local temporary
  if ! temporary=$(mktemp "$STATE_DIR/notification-state.json.XXXXXX"); then
    log "WARNING: Hermes delivery succeeded but notification dedupe state could not be created; the blocker may be notified again."
    return 0
  fi
  if [[ -s $NOTIFY_STATE_FILE ]]; then
    if ! $JQ --arg key "$blocker_key" '.schemaVersion = 1 | .blockers = (.blockers // {}) + {($key): true}' \
      "$NOTIFY_STATE_FILE" >"$temporary" 2>/dev/null; then
      rm -f -- "$temporary"
      log "WARNING: Hermes delivery succeeded but notification dedupe state could not be encoded; the blocker may be notified again."
      return 0
    fi
  elif ! $JQ -n --arg key "$blocker_key" '{schemaVersion: 1, blockers: {($key): true}}' >"$temporary" 2>/dev/null; then
    rm -f -- "$temporary"
    log "WARNING: Hermes delivery succeeded but notification dedupe state could not be encoded; the blocker may be notified again."
    return 0
  fi
  if [[ ! -s $temporary ]] || ! durable_replace "$temporary" "$NOTIFY_STATE_FILE"; then
    rm -f -- "$temporary" || true
    "$SYNC" -f "$STATE_DIR" >/dev/null 2>&1 || true
    log "WARNING: Hermes delivery succeeded but notification dedupe state could not be persisted; the blocker may be notified again."
  fi
}

notify_failure() {
  local message=$1
  notify_event failure "${CURRENT_STAGE:-unknown}" "" "$message" || true
}

require_positive_integer() {
  [[ $2 =~ ^[1-9][0-9]*$ ]] || fail "$1 must be a positive integer"
}

fork_sync_settings_are_valid() {
  [[ $FORK_SYNC_ATTEMPTS =~ ^[1-9][0-9]*$ \
    && $FORK_SYNC_EVENT_QUIESCE_SECONDS =~ ^[1-9][0-9]*$ \
    && $FORK_SYNC_RUN_SETTLE_ATTEMPTS =~ ^[1-9][0-9]*$ \
    && $FORK_SYNC_RUN_SETTLE_INTERVAL_SECONDS =~ ^[1-9][0-9]*$ \
    && $FORK_SYNC_RUN_QUIET_POLLS =~ ^[1-9][0-9]*$ \
    && $FORK_SYNC_RUN_MIN_OBSERVATION_POLLS =~ ^[1-9][0-9]*$ ]] \
    && ((FORK_SYNC_RUN_QUIET_POLLS <= FORK_SYNC_RUN_MIN_OBSERVATION_POLLS \
      && FORK_SYNC_RUN_MIN_OBSERVATION_POLLS <= FORK_SYNC_RUN_SETTLE_ATTEMPTS))
}

validate_fork_sync_settings() {
  fork_sync_settings_are_valid \
    || fail "fork-main synchronization timing settings must be positive and fit inside the bounded settlement window"
}

prepare_directories() {
  mkdir -p -- "$STATE_DIR" "$RUNS_DIR" "$WORK_DIR" "$LOGS_DIR" "$ATOMIC_PUBLICATION_STATE_DIR"
  chmod 700 "$MAINTAINER_ROOT" "$STATE_DIR" "$RUNS_DIR" "$WORK_DIR" "$LOGS_DIR" \
    "$ATOMIC_PUBLICATION_STATE_DIR"
}

acquire_lock() {
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "A maintainer run is already active; this timer event is complete."
    exit 0
  fi
}

durable_replace() {
  local temporary=$1 target=$2 target_dir
  target_dir=$(dirname -- "$target") || return 1
  chmod 600 "$temporary" || return 1
  "$SYNC" -f "$temporary" || return 1
  mv -f -- "$temporary" "$target" || return 1
  "$SYNC" -f "$target_dir" || return 1
}

durable_remove() {
  local target=$1 target_dir
  [[ -e $target ]] || return 0
  target_dir=$(dirname -- "$target") || return 1
  rm -f -- "$target" || return 1
  "$SYNC" -f "$target_dir" || return 1
}

cleanup_processed_workspace() {
  local run_id=$1 workspace
  [[ $run_id != */* && $run_id != *..* && -n $run_id ]] || return 1
  workspace="$RUNS_DIR/$run_id/workspace"
  [[ ! -e $workspace || -d $workspace ]] || return 1
  rm -rf -- "$workspace"
}

cleanup_durable_processed_workspace() {
  local run_id
  [[ -s $PROCESSED_FILE ]] || return 0
  run_id=$($JQ -er '.runId | strings | select(length > 0)' "$PROCESSED_FILE" 2>/dev/null) \
    || return 0
  cleanup_processed_workspace "$run_id"
}

state_files_are_valid_json() {
  local state_file
  for state_file in "$@"; do
    [[ -s $state_file ]] || continue
    $JQ -e 'type == "object"' "$state_file" >/dev/null 2>&1 || return 1
  done
}

cleanup_unreferenced_local_work() {
  local local_work reference state_file referenced
  # The exclusive maintainer lock makes unreferenced pre-cutover build trees
  # safe to remove. Preserve every rollback directory named by durable state.
  if ! state_files_are_valid_json "$LOCAL_APPLIED_FILE" "$PROCESSED_FILE" "$BLOCKED_FILE"; then
    log "WARNING: retained local work because durable maintainer state is not valid JSON."
    return 0
  fi
  while IFS= read -r -d '' local_work; do
    referenced=false
    for state_file in "$LOCAL_APPLIED_FILE" "$PROCESSED_FILE" "$BLOCKED_FILE"; do
      [[ -s $state_file ]] || continue
      while IFS= read -r reference; do
        case "$reference/" in
          "$local_work"/*) referenced=true ;;
        esac
      done < <($JQ -r '
        .localDeployment.rollback.backupDirectory? //
        .rollback.backupDirectory? //
        .backupDirectory? // empty
      ' "$state_file" 2>/dev/null)
    done
    [[ $referenced == true ]] && continue
    case "$local_work" in
      "$RUNS_DIR"/*/local-work) rm -rf -- "$local_work" ;;
      *) fail "refusing to remove an unexpected maintainer work path: $local_work" ;;
    esac
  done < <(find "$RUNS_DIR" -mindepth 2 -maxdepth 2 -type d -name local-work -print0)
}

cleanup_unreferenced_deployments() {
  local deployment reference state_file referenced current_source
  [[ -d $DEPLOYMENTS_DIR ]] || return 0
  [[ -s $GATEWAY_CONFIG ]] || return 0
  if ! state_files_are_valid_json "$LOCAL_APPLIED_FILE" "$PROCESSED_FILE"; then
    log "WARNING: retained local deployments because durable maintainer state is not valid JSON."
    return 0
  fi
  current_source=$($JQ -er '.sourceRoot | strings | select(startswith("/"))' "$GATEWAY_CONFIG") \
    || return 0
  while IFS= read -r -d '' deployment; do
    referenced=false
    [[ $deployment == "$current_source" ]] && referenced=true
    for state_file in "$LOCAL_APPLIED_FILE" "$PROCESSED_FILE"; do
      [[ -s $state_file ]] || continue
      while IFS= read -r reference; do
        [[ $deployment == "$reference" ]] && referenced=true
      done < <($JQ -r '
        (
          .localDeployment.gateway.runtimeSourceRoot?,
          .localDeployment.gateway.previousSourceRoot?
        )
        | select(type == "string" and startswith("/"))
      ' "$state_file" 2>/dev/null)
    done
    [[ $referenced == true ]] && continue
    case "$deployment" in
      "$DEPLOYMENTS_DIR"/t4-*) rm -rf -- "$deployment" ;;
      *) fail "refusing to remove an unexpected T4 deployment path: $deployment" ;;
    esac
  done < <(find "$DEPLOYMENTS_DIR" -mindepth 1 -maxdepth 1 -type d -name 't4-*' -print0)
}

latest_stable_release() {
  local release tag commit
  release=$($GH api "repos/$OMP_UPSTREAM_REPOSITORY/releases/latest")
  tag=$(printf '%s' "$release" | $JQ -er '
    select(.draft == false and .prerelease == false)
    | .tag_name
    | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "the official latest release is not a stable semantic-version tag"
  commit=$($GH api "repos/$OMP_UPSTREAM_REPOSITORY/commits/$tag" --jq .sha)
  [[ $commit =~ ^[0-9a-f]{40}$ ]] || fail "the official release tag did not resolve to a commit"
  $JQ -cn --arg tag "$tag" --arg commit "$commit" '{tag: $tag, commit: $commit}'
}

fork_workflow_state() {
  $GH api "repos/$OMP_INTEGRATION_REPOSITORY/actions/workflows/$OMP_FORK_WORKFLOW" --jq .state
}

enable_fork_workflow_and_prove() {
  $GH api --method PUT "repos/$OMP_INTEGRATION_REPOSITORY/actions/workflows/$OMP_FORK_WORKFLOW/enable" \
    >/dev/null || return 1
  [[ $(fork_workflow_state) == active ]]
}

fork_sync_marker_is_valid() {

  local marker=$1
  [[ -s $marker ]] && $JQ -e '
    (.schemaVersion == 1 or .schemaVersion == 2) and
    .workflow == "ci.yml" and
    (.startedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
    (.officialCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (.previousForkCommit | type == "string" and test("^[0-9a-f]{40}$")) and
    (
      (.schemaVersion == 1) or
      (.schemaVersion == 2 and (
        .phase == "prepared" or
        (
          .phase == "push-attempted" and
          (.preexistingRunIds | type == "array") and
          all(.preexistingRunIds[]; type == "number" and floor == . and . > 0)
        )
      ))
    )
  ' "$marker" >/dev/null 2>&1
}

publication_gate_enabled() {
  [[ ${T4_MAINTAINER_TEST_PUBLICATION_GATE:-0} == 1 ]] && return 0
  [[ ${T4_MAINTAINER_TEST_MODE:-0} != 1 ]] && return 0
  [[ ${canonical_maintainer_root:-} != /tmp/* \
    && ${canonical_maintainer_root:-} != /private/tmp/* ]]
}

capture_t4_main_gate_sha() {
  local current
  current=$(t4_main_identity) || fail "T4 main identity could not be resolved after publication gate"
  if [[ -z $T4_MAIN_GATE_SHA ]]; then
    T4_MAIN_GATE_SHA=$current
  elif [[ $current != "$T4_MAIN_GATE_SHA" ]]; then
    notify_blocker_once collaborator_defer publication "t4-main-race" \
      "T4 main changed after the first publication gate; deferring before Sol" || true
    log "Publication deferred because T4 main changed after the first publication gate."
    return 10
  fi
  CURRENT_COMMIT=$current
}

t4_main_identity() {
  local identity
  identity=$($GH api "repos/$T4_REPOSITORY/commits/main" --jq .sha) || return 1
  [[ $identity =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$identity"
}

publication_gate() {
  local prs number title release_declared files critical_file blocker_key
  GATE_BLOCKER_KEY=
  publication_gate_enabled || return 0
  prs=$($GH api "repos/$T4_REPOSITORY/pulls?state=open&base=main&per_page=100") \
    || fail "publication gate could not classify open T4 pull requests"
  $JQ -e 'type == "array" and all(.[]; (.number | type == "number") and (.draft | type == "boolean") and (.title | type == "string") and (.labels | type == "array") and all(.labels[]; .name | type == "string"))' \
    <<<"$prs" >/dev/null \
    || fail "publication gate received an invalid open pull-request listing"
  [[ $($JQ 'length' <<<"$prs") -lt 100 ]] \
    || fail "publication gate cannot classify all open T4 pull requests"
  while read -r number; do
    [[ -n $number ]] || continue
    if $JQ -e --argjson number "$number" '
      .[] | select(.number == $number and .draft == false)
      | ([.title] + (.labels | map(.name // "")))
      | any(test("(^|[^[:alnum:]])(release|publish|version|cutover|deploy)([^[:alnum:]]|$)"; "i"))
    ' <<<"$prs" >/dev/null; then
      release_declared=true
    else
      release_declared=false
    fi
    files=$($GH api "repos/$T4_REPOSITORY/pulls/$number/files?per_page=100") \
      || fail "publication gate could not inspect files for T4 pull request #$number"
    $JQ -e 'type == "array" and all(.[]; .filename | type == "string")' <<<"$files" >/dev/null \
      || fail "publication gate received invalid changed-file data for T4 pull request #$number"
    [[ $($JQ 'length' <<<"$files") -lt 100 ]] \
      || fail "publication gate cannot classify all changed files for T4 pull request #$number"
    critical_file=$($JQ -r '
      first(.[] | .filename
      | select(test("^(apps/|packages/|ops/t4-maintainer/|scripts/t4-maintainer|\\.github/workflows/(release|ci))|(^|/)(release|version|package)([^/]*)$|(^|/)package\\.json$"; "i")))
      // empty
    ' <<<"$files")
    if [[ $release_declared == true || -n $critical_file ]]; then
      title=$($JQ -r --argjson number "$number" '.[] | select(.number == $number) | .title' <<<"$prs")
      blocker_key="t4-pr-$number"
      GATE_BLOCKER_KEY="$blocker_key"
      notify_blocker_once collaborator_defer publication "$blocker_key" \
        "open non-draft T4 main PR #$number blocks publication (${title:-release-critical change})" || true
      log "Publication deferred by open non-draft T4 main PR #$number."
      return 10
    fi
  done < <($JQ -r '.[] | select(.draft == false) | .number' <<<"$prs")
  capture_t4_main_gate_sha || return $?
  return 0
}
revalidate_t4_main_before_publication() {
  local before after
  publication_gate_enabled || return 0
  before=$(t4_main_identity) || fail "T4 main identity could not be resolved before publication"
  if [[ -n $T4_MAIN_GATE_SHA && $before != "$T4_MAIN_GATE_SHA" ]]; then
    notify_blocker_once collaborator_defer publication "t4-main-race" \
      "T4 main changed after publication gate; retrying without invoking Sol" || true
    fail "T4 main changed after publication gate"
  fi
  after=$(t4_main_identity) || fail "T4 main identity could not be revalidated before publication"
  [[ $before == "$after" ]] || fail "T4 main changed during publication gate revalidation"
  CURRENT_COMMIT=$after
  T4_MAIN_SOL_SHA=$after
}

prepared_fork_sync_marker_is_valid() {
  local marker=$1
  fork_sync_marker_is_valid "$marker" \
    && $JQ -e '
      .schemaVersion == 2 and .phase == "prepared" and
      (has("preexistingRunIds") | not)
    ' "$marker" >/dev/null 2>&1
}

push_attempted_fork_sync_marker_is_valid() {
  local marker=$1
  fork_sync_marker_is_valid "$marker" \
    && $JQ -e '.schemaVersion == 2 and .phase == "push-attempted"' \
      "$marker" >/dev/null 2>&1
}

recover_fork_sync() {
  [[ -e $FORK_SYNC_FILE ]] || return 0
  fork_sync_marker_is_valid "$FORK_SYNC_FILE" \
    || fail "fork-main recovery state is invalid: $FORK_SYNC_FILE"
  local official_commit phase preexisting_run_ids
  official_commit=$($JQ -r '.officialCommit' "$FORK_SYNC_FILE")
  phase=$($JQ -r 'if .schemaVersion == 1 then "legacy" else .phase end' \
    "$FORK_SYNC_FILE")
  if [[ $phase == legacy || $phase == prepared ]]; then
    enable_fork_workflow_and_prove \
      || fail "fork CI recovery could not prove the workflow active; retaining $FORK_SYNC_FILE and stopping before publication"
    if [[ $phase == legacy ]]; then
      log "Recovered legacy fork-main synchronization state and proved fork CI active without settling any run."
    else
      log "Recovered fork-main synchronization before its push and proved fork CI active."
    fi
  else
    preexisting_run_ids=$($JQ -c '
      if .schemaVersion == 1 then [] else .preexistingRunIds end
    ' "$FORK_SYNC_FILE") || fail "fork-main recovery state lost its run snapshot"
    restore_fork_ci_and_settle_main_run "$official_commit" "$preexisting_run_ids" \
      || fail "fork CI recovery could not settle the exact mirrored main run; retaining $FORK_SYNC_FILE and stopping before publication"
    log "Recovered fork-main synchronization and proved fork CI active with its exact mirrored run settled."
  fi
  durable_remove "$FORK_SYNC_FILE" \
    || fail "fork-main recovery state could not be cleared after safe recovery"
}

write_fork_sync_marker() {
  local official_commit=$1 fork_commit=$2 temporary
  temporary=$(mktemp "$STATE_DIR/fork-main-sync.json.XXXXXX")
  $JQ -n \
    --arg started_at "$(timestamp)" \
    --arg workflow "$OMP_FORK_WORKFLOW" \
    --arg official_commit "$official_commit" \
    --arg fork_commit "$fork_commit" '
      {
        schemaVersion: 2,
        startedAt: $started_at,
        phase: "prepared",
        workflow: $workflow,
        officialCommit: $official_commit,
        previousForkCommit: $fork_commit
      }
  ' >"$temporary" \
    || {
      rm -f -- "$temporary" || true
      fail "fork-main recovery state could not be generated before the mirror operation"
    }
  prepared_fork_sync_marker_is_valid "$temporary" \
    || {
      rm -f -- "$temporary" || true
      fail "fork-main recovery state was invalid before the mirror operation"
    }
  durable_replace "$temporary" "$FORK_SYNC_FILE" \
    || fail "fork-main recovery state could not be persisted before the mirror operation"
  prepared_fork_sync_marker_is_valid "$FORK_SYNC_FILE" \
    || fail "persisted fork-main recovery state was invalid before the mirror operation"
}

fork_main_push_runs_json() {
  local official_commit=$1 response
  response=$($GH api \
    "repos/$OMP_INTEGRATION_REPOSITORY/actions/workflows/$OMP_FORK_WORKFLOW/runs?branch=main&event=push&head_sha=$official_commit&per_page=100") \
    || return 1
  printf '%s' "$response" | $JQ -ce --arg commit "$official_commit" '
    select(
      (.workflow_runs | type == "array") and
      ((.total_count // (.workflow_runs | length)) | type == "number" and . <= 100)
    )
    | [
        .workflow_runs[]
        | select(
            .head_sha == $commit and .head_branch == "main" and .event == "push" and
            .path == ".github/workflows/ci.yml"
          )
      ]
    | select(all(.[];
        (.id | type == "number" and floor == . and . > 0) and
        (.run_attempt | type == "number" and floor == . and . > 0) and
        (.status | type == "string" and length > 0)
      ))
  '
}

snapshot_fork_main_run_ids() {
  local official_commit=$1 runs
  runs=$(fork_main_push_runs_json "$official_commit") || return 1
  printf '%s' "$runs" | $JQ -ce '[.[].id] | sort | unique'
}

mark_fork_sync_push_attempted() {
  local official_commit=$1 preexisting_run_ids temporary
  preexisting_run_ids=$(snapshot_fork_main_run_ids "$official_commit") \
    || fail "fork-main runs could not be snapshotted before the mirror push"
  temporary=$(mktemp "$STATE_DIR/fork-main-sync.json.XXXXXX")
  $JQ --argjson preexisting_run_ids "$preexisting_run_ids" '
    select(.schemaVersion == 2 and .phase == "prepared")
    | .phase = "push-attempted"
    | .preexistingRunIds = $preexisting_run_ids
  ' "$FORK_SYNC_FILE" >"$temporary" \
    || fail "fork-main recovery state could not advance before the mirror push"
  [[ -s $temporary ]] \
    || fail "fork-main recovery state could not advance before the mirror push"
  push_attempted_fork_sync_marker_is_valid "$temporary" \
    || {
      rm -f -- "$temporary" || true
      fail "fork-main recovery state was invalid before the mirror push"
    }
  durable_replace "$temporary" "$FORK_SYNC_FILE" \
    || fail "fork-main recovery state could not advance before the mirror push"
  push_attempted_fork_sync_marker_is_valid "$FORK_SYNC_FILE" \
    || fail "persisted fork-main recovery state was invalid before the mirror push"
}

settle_fork_main_push_runs() {
  local official_commit=$1 preexisting_run_ids=$2
  local minimum_polls=${3:-$FORK_SYNC_RUN_QUIET_POLLS}
  local attempt runs matching active_ids run_id quiet_polls=0
  fork_sync_settings_are_valid || return 1
  [[ $official_commit =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$preexisting_run_ids" | $JQ -e '
    type == "array" and all(.[]; type == "number" and floor == . and . > 0)
  ' >/dev/null || return 1
  [[ $minimum_polls =~ ^[1-9][0-9]*$ ]] || return 1
  ((FORK_SYNC_RUN_QUIET_POLLS <= minimum_polls \
    && minimum_polls <= FORK_SYNC_RUN_SETTLE_ATTEMPTS)) || return 1

  for ((attempt = 1; attempt <= FORK_SYNC_RUN_SETTLE_ATTEMPTS; attempt += 1)); do
    runs=$(fork_main_push_runs_json "$official_commit") || return 1
    matching=$(printf '%s' "$runs" | $JQ -ce \
      --argjson preexisting_run_ids "$preexisting_run_ids" '
      [
        .[]
        | select(.run_attempt == 1 and (.id as $id | $preexisting_run_ids | index($id) | not))
      ]
    ') || return 1
    active_ids=$(printf '%s' "$matching" | $JQ -r '.[] | select(.status != "completed") | .id')
    if [[ -z $active_ids ]]; then
      ((quiet_polls += 1))
      if ((attempt >= minimum_polls && quiet_polls >= FORK_SYNC_RUN_QUIET_POLLS)); then
        log "Fork CI has no active transaction-owned run for the exact mirrored main commit $official_commit."
        return 0
      fi
    else
      quiet_polls=0
      while IFS= read -r run_id; do
        [[ $run_id =~ ^[1-9][0-9]*$ ]] || return 1
        if $GH api --method POST \
          "repos/$OMP_INTEGRATION_REPOSITORY/actions/runs/$run_id/cancel" >/dev/null; then
          log "Requested cancellation of delayed fork-main CI run $run_id for $official_commit."
        else
          log "Fork-main CI run $run_id changed while cancellation was requested; rechecking its exact state."
        fi
      done <<<"$active_ids"
    fi
    ((attempt < FORK_SYNC_RUN_SETTLE_ATTEMPTS)) \
      && "$SLEEP" "$FORK_SYNC_RUN_SETTLE_INTERVAL_SECONDS"
  done
  return 1
}

restore_fork_ci_and_settle_main_run() {
  local official_commit=$1 preexisting_run_ids=$2 workflow_state
  workflow_state=$(fork_workflow_state) || return 1
  if ! fork_sync_settings_are_valid; then
    enable_fork_workflow_and_prove || return 1
    return 1
  fi
  # Let GitHub observe the mirror event while the canonical workflow is still
  # disabled, then guard against any delayed delivery after it is re-enabled.
  if [[ $workflow_state == disabled_manually ]]; then
    "$SLEEP" "$FORK_SYNC_EVENT_QUIESCE_SECONDS"
  fi
  enable_fork_workflow_and_prove || return 1
  settle_fork_main_push_runs \
    "$official_commit" "$preexisting_run_ids" "$FORK_SYNC_RUN_MIN_OBSERVATION_POLLS"
}

fork_main_is_fast_forwardable() {
  local official_commit=$1 fork_commit=$2 probe fetched_official fetched_fork
  probe=$(mktemp -d "$WORK_DIR/fork-main-ff.XXXXXX") || return 2
  if ! $GIT -C "$probe" init --quiet \
    || ! $GIT -C "$probe" fetch --quiet --no-tags "$OMP_UPSTREAM_URL" \
      "refs/heads/main:refs/remotes/official/main" \
    || ! $GIT -C "$probe" fetch --quiet --no-tags "$OMP_INTEGRATION_URL" \
      "refs/heads/main:refs/remotes/fork/main"; then
    rm -rf -- "$probe"
    return 2
  fi
  fetched_official=$($GIT -C "$probe" rev-parse refs/remotes/official/main) || {
    rm -rf -- "$probe"
    return 2
  }
  fetched_fork=$($GIT -C "$probe" rev-parse refs/remotes/fork/main) || {
    rm -rf -- "$probe"
    return 2
  }
  if [[ $fetched_official != "$official_commit" || $fetched_fork != "$fork_commit" ]]; then
    rm -rf -- "$probe"
    return 2
  fi
  if ! $GIT -C "$probe" merge-base --is-ancestor \
    refs/remotes/fork/main refs/remotes/official/main; then
    rm -rf -- "$probe"
    return 1
  fi
  rm -rf -- "$probe"
}

sync_fork_main_once() {
  local official_commit=$1 fork_commit=$2 push_repo snapshot_status push_status=0
  local preexisting_run_ids
  if fork_main_is_fast_forwardable "$official_commit" "$fork_commit"; then
    :
  else
    snapshot_status=$?
    if ((snapshot_status == 1)); then
      fail "fork main has diverged from official main; refusing synchronization and stopping before Sol"
    fi
    return 2
  fi
  write_fork_sync_marker "$official_commit" "$fork_commit" \
    || fail "fork-main recovery state could not be persisted before CI was disabled"
  if ! $GH api --method PUT \
    "repos/$OMP_INTEGRATION_REPOSITORY/actions/workflows/$OMP_FORK_WORKFLOW/disable" >/dev/null \
    || [[ $(fork_workflow_state) != disabled_manually ]]; then
    enable_fork_workflow_and_prove || true
    fail "fork CI could not be proven disabled for the bounded main synchronization; retaining recovery state"
  fi
  push_repo=$(mktemp -d "$WORK_DIR/fork-main-push.XXXXXX") || {
    enable_fork_workflow_and_prove || true
    fail "could not create the fork-main push workspace; retaining recovery state"
  }
  if ! $GIT -C "$push_repo" init --quiet \
    || ! $GIT -C "$push_repo" fetch --quiet --no-tags "$OMP_UPSTREAM_URL" \
      "refs/heads/main:refs/remotes/official/main" \
    || [[ $($GIT -C "$push_repo" rev-parse refs/remotes/official/main) != "$official_commit" ]]; then
    rm -rf -- "$push_repo"
    enable_fork_workflow_and_prove \
      || fail "the exact fork-main push preparation failed and fork CI could not be proven active; retaining recovery state"
    durable_remove "$FORK_SYNC_FILE" \
      || fail "fork-main recovery state could not be cleared after safe push preparation recovery"
    return 2
  fi
  mark_fork_sync_push_attempted "$official_commit" \
    || fail "fork-main recovery state could not advance before the mirror push"
  preexisting_run_ids=$($JQ -ec '.preexistingRunIds' "$FORK_SYNC_FILE") \
    || fail "fork-main recovery state lost its run snapshot before the mirror push"
  $GIT -C "$push_repo" push "$OMP_INTEGRATION_URL" \
    "$official_commit:refs/heads/main" || push_status=$?
  rm -rf -- "$push_repo"
  restore_fork_ci_and_settle_main_run "$official_commit" "$preexisting_run_ids" \
    || fail "the fork-main push was attempted, but fork CI could not be restored and settled; retaining recovery state and stopping"
  durable_remove "$FORK_SYNC_FILE" \
    || fail "fork-main recovery state could not be cleared after exact run settlement"
  ((push_status == 0)) || return 2
}

sync_fork_main() {
  local attempt official_commit fork_commit sync_status
  recover_fork_sync
  validate_fork_sync_settings
  for ((attempt = 1; attempt <= FORK_SYNC_ATTEMPTS; attempt += 1)); do
    official_commit=$(resolve_public_commit "$OMP_UPSTREAM_REPOSITORY" main) \
      || fail "official OMP main could not be resolved"
    fork_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" main) \
      || fail "fork OMP main could not be resolved"
    [[ $official_commit =~ ^[0-9a-f]{40}$ && $fork_commit =~ ^[0-9a-f]{40}$ ]] \
      || fail "official or fork OMP main did not resolve to an exact commit"
    if [[ $official_commit == "$fork_commit" ]]; then
      [[ $(fork_workflow_state) == active ]] \
        || fail "fork main is current, but fork CI is not active; stopping before publication"
      log "Fork main exactly matches official main at $official_commit and fork CI is active."
      return 0
    fi
    if sync_fork_main_once "$official_commit" "$fork_commit"; then
      log "Fast-forwarded fork main toward official main at $official_commit without invoking Sol."
    else
      sync_status=$?
      ((sync_status == 2)) \
        || fail "fork main synchronization stopped with an unexpected status"
      log "Fork main moved while its exact snapshot was being proved; retrying within the bounded synchronization window."
    fi
  done
  official_commit=$(resolve_public_commit "$OMP_UPSTREAM_REPOSITORY" main) || return 1
  fork_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" main) || return 1
  [[ $official_commit == "$fork_commit" && $(fork_workflow_state) == active ]] \
    || fail "official main moved throughout the bounded synchronization window; retrying on the next timer"
}

processed_metadata_matches() {
  local target=$1
  [[ -s $PROCESSED_FILE ]] || return 1
  $JQ -e --argjson target "$target" '
    .upstream.tag == $target.tag and
    .upstream.commit == $target.commit and
    .publicVerification == "complete" and
    .localDeployment.status == "complete" and
    .localDeployment.gateway.tailnetHealth == "healthy"
  ' "$PROCESSED_FILE" >/dev/null 2>&1
}

tree_sha256() {
  local requested_root=$1 boundary=${2:-} root boundary_root relative digest
  root=$($REALPATH -e -- "$requested_root") || return 1
  [[ -d $root ]] || return 1
  if [[ -n $boundary ]]; then
    boundary_root=$($REALPATH -e -- "$boundary") || return 1
    [[ -d $boundary_root ]] || return 1
    case "$root/" in
      "$boundary_root"/*) ;;
      *) return 1 ;;
    esac
  fi
  find "$root" -type l -print -quit | grep -q . && return 1
  find "$root" -type f -print -quit | grep -q . || return 1
  (
    cd -- "$root"
    while IFS= read -r -d '' relative; do
      digest=$($SHA256SUM "$relative" | awk '{print $1}')
      printf '%s\0%s\0' "$relative" "$digest"
    done < <(find . -type f -print0 | LC_ALL=C sort -z)
  ) | $SHA256SUM | awk '{print $1}'
}

deployment_identity() {
  local t4_commit=$1 integration_commit=$2 omp_sha=$3 digest
  digest=$(printf '%s\0%s\0%s\0' "$t4_commit" "$integration_commit" "$omp_sha" \
    | $SHA256SUM | awk '{print $1}') || return 1
  [[ $digest =~ ^[0-9a-f]{64}$ ]] || return 1
  printf 'sha256:%s\n' "$digest"
}

tailnet_gateway_is_healthy() {
  local record_file=${1:-} gateway_origin expected_origin expected_identity tailnet_health
  [[ -s $GATEWAY_CONFIG ]] || return 1
  gateway_origin=$($JQ -er '.allowedOrigin | strings | select(test("^https://"))' "$GATEWAY_CONFIG") || return 1
  expected_identity=$($JQ -er '.deploymentIdentity | select(test("^sha256:[0-9a-f]{64}$"))' "$GATEWAY_CONFIG") \
    || return 1
  if [[ -n $record_file ]]; then
    expected_origin=$($JQ -er '.localDeployment.gateway.allowedOrigin | strings | select(test("^https://"))' "$record_file") \
      || return 1
    [[ $gateway_origin == "$expected_origin" ]] || return 1
    [[ $expected_identity == "$($JQ -er '.localDeployment.gateway.deploymentIdentity | select(test("^sha256:[0-9a-f]{64}$"))' "$record_file")" ]] \
      || return 1
  fi
  tailnet_health=$($CURL -fsS --max-time 10 "${gateway_origin}/healthz" 2>/dev/null) || return 1
  printf '%s' "$tailnet_health" | $JQ -e --arg identity "$expected_identity" '
    .ok == true and .web == true and .upstream == true and .transport == "local-unix"
    and .deploymentIdentity == $identity
  ' >/dev/null
}

report_tailnet_unreachable_once() {
  [[ $TAILNET_REACHABILITY_REPORTED == false ]] || return 0
  TAILNET_REACHABILITY_REPORTED=true
  log "Tailnet HTTPS health is temporarily unreachable; exact local deployment state remains valid and will be finalized on a later timer run."
}

local_state_matches_record() {
  local record_file=$1
  local recorded_omp_target recorded_host_id omp_sha omp_service app_pid running_sha omp_status
  local expected_omp_version t4_version expected_t4_version dpkg_verification
  local gateway_service runtime_root runtime_commit expected_t4_commit
  local gateway_port gateway_health gateway_script web_root gateway_origin
  local gateway_socket gateway_label gateway_node_executable
  local deployment_identity
  local gateway_script_sha web_tree_sha ws_tree_sha gateway_config_sha gateway_unit_sha
  [[ -s $record_file && -f $GATEWAY_CONFIG && ! -L $GATEWAY_CONFIG ]] || return 1
  [[ -f $GATEWAY_UNIT && ! -L $GATEWAY_UNIT ]] || return 1
  recorded_omp_target=$($JQ -er '.localDeployment.omp.target | strings | select(startswith("/"))' "$record_file") || return 1
  omp_sha=$($JQ -er '.localDeployment.omp.installedSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  omp_service=$($JQ -er '.localDeployment.omp.service | strings | select(length > 0)' "$record_file") || return 1
  recorded_host_id=$($JQ -er '.localDeployment.omp.hostId | strings | select(length > 0)' "$record_file") || return 1
  t4_version=$($JQ -er '.localDeployment.desktop.installedVersion | strings' "$record_file") || return 1
  gateway_service=$($JQ -er '.localDeployment.gateway.service | strings | select(length > 0)' "$record_file") || return 1
  runtime_root=$($JQ -er '.localDeployment.gateway.runtimeSourceRoot | strings | select(startswith("/"))' "$record_file") || return 1
  runtime_commit=$($JQ -er '.localDeployment.gateway.runtimeCommit | select(test("^[0-9a-f]{40}$"))' "$record_file") || return 1
  gateway_script_sha=$($JQ -er '.localDeployment.gateway.artifacts.gatewayScriptSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  web_tree_sha=$($JQ -er '.localDeployment.gateway.artifacts.webTreeSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  ws_tree_sha=$($JQ -er '.localDeployment.gateway.artifacts.wsTreeSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  gateway_config_sha=$($JQ -er '.localDeployment.gateway.artifacts.configSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  gateway_unit_sha=$($JQ -er '.localDeployment.gateway.artifacts.unitSha256 | select(test("^[0-9a-f]{64}$"))' "$record_file") || return 1
  gateway_origin=$($JQ -er '.localDeployment.gateway.allowedOrigin | strings | select(test("^https://"))' "$record_file") || return 1
  gateway_port=$($JQ -er '.localDeployment.gateway.port | numbers | select(. >= 1024 and . <= 65535)' "$record_file") || return 1
  gateway_socket=$($JQ -er '.localDeployment.gateway.appSocket | strings | select(startswith("/"))' "$record_file") || return 1
  gateway_label=$($JQ -er '.localDeployment.gateway.label | strings | select(length > 0)' "$record_file") || return 1
  deployment_identity=$($JQ -er '.localDeployment.gateway.deploymentIdentity | select(test("^sha256:[0-9a-f]{64}$"))' "$record_file") || return 1
  gateway_node_executable=$($JQ -er '.localDeployment.gateway.nodeExecutable | strings | select(startswith("/"))' "$record_file") || return 1
  expected_omp_version=$($JQ -er '"omp/" + (.upstream.tag | ltrimstr("v"))' "$record_file") || return 1
  expected_t4_version=$($JQ -er '.t4.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$record_file") || return 1
  expected_t4_commit=$($JQ -er '.t4.commit | select(test("^[0-9a-f]{40}$"))' "$record_file") || return 1
  [[ $(deployment_identity "$expected_t4_commit" \
    "$($JQ -er '.integration.commit | select(test("^[0-9a-f]{40}$"))' "$record_file")" \
    "$omp_sha") == "$deployment_identity" ]] || return 1

  [[ $recorded_omp_target == "$OMP_TARGET" && $omp_service == "$OMP_SERVICE" ]] || return 1
  [[ -f $OMP_TARGET && ! -L $OMP_TARGET && -x $OMP_TARGET ]] || return 1
  [[ $("$OMP_TARGET" --version 2>/dev/null) == "$expected_omp_version" ]] || return 1
  [[ $($SHA256SUM "$OMP_TARGET" | awk '{print $1}') == "$omp_sha" ]] || return 1
  $SYSTEMCTL --user is-active --quiet "$omp_service" || return 1
  app_pid=$($SYSTEMCTL --user show "$omp_service" --property MainPID --value) || return 1
  [[ $app_pid =~ ^[1-9][0-9]*$ && -r "$PROC_ROOT/$app_pid/exe" ]] || return 1
  running_sha=$($SHA256SUM "$PROC_ROOT/$app_pid/exe" | awk '{print $1}')
  [[ $running_sha == "$omp_sha" ]] || return 1
  omp_status=$("$OMP_TARGET" appserver status --json 2>/dev/null) || return 1
  printf '%s' "$omp_status" | $JQ -e --arg host_id "$recorded_host_id" '
    .state == "running" and .health.ok == true and .health.hostId == $host_id
  ' >/dev/null || return 1

  [[ $t4_version == "$expected_t4_version" ]] || return 1
  [[ $($DPKG_QUERY -W -f='${Status}\t${Version}' "$T4_PACKAGE" 2>/dev/null) == $'install ok installed\t'"$expected_t4_version" ]] || return 1
  dpkg_verification=$($DPKG -V "$T4_PACKAGE" 2>/dev/null) || return 1
  [[ -z $dpkg_verification ]] || return 1
  [[ $gateway_service == "$GATEWAY_SERVICE" ]] || return 1
  $SYSTEMCTL --user is-active --quiet "$gateway_service" || return 1
  $SYSTEMCTL --user is-enabled --quiet "$gateway_service" || return 1
  [[ $($JQ -r '.sourceRoot' "$GATEWAY_CONFIG") == "$runtime_root" ]] || return 1
  [[ $($JQ -r '.allowedOrigin' "$GATEWAY_CONFIG") == "$gateway_origin" ]] || return 1
  [[ $($JQ -r '.port' "$GATEWAY_CONFIG") == "$gateway_port" ]] || return 1
  [[ $($JQ -r '.appSocket' "$GATEWAY_CONFIG") == "$gateway_socket" ]] || return 1
  [[ $($JQ -r '.label' "$GATEWAY_CONFIG") == "$gateway_label" ]] || return 1
  [[ $($JQ -r '.deploymentIdentity' "$GATEWAY_CONFIG") == "$deployment_identity" ]] || return 1
  [[ $($JQ -r '.nodeExecutable' "$GATEWAY_CONFIG") == "$gateway_node_executable" ]] || return 1
  [[ $($SHA256SUM "$GATEWAY_CONFIG" | awk '{print $1}') == "$gateway_config_sha" ]] || return 1
  [[ $($SHA256SUM "$GATEWAY_UNIT" | awk '{print $1}') == "$gateway_unit_sha" ]] || return 1
  [[ $runtime_commit == "$expected_t4_commit" ]] || return 1
  [[ $($GIT -C "$runtime_root" rev-parse HEAD 2>/dev/null) == "$expected_t4_commit" ]] || return 1
  $GIT -C "$runtime_root" diff --quiet --exit-code HEAD -- || return 1
  gateway_script=$($JQ -er '.gatewayScript | strings | select(startswith("/"))' "$GATEWAY_CONFIG") || return 1
  web_root=$($JQ -er '.webRoot | strings | select(startswith("/"))' "$GATEWAY_CONFIG") || return 1
  [[ $gateway_script == "$runtime_root/scripts/tailnet-gateway.mjs" ]] || return 1
  [[ $web_root == "$runtime_root/apps/web/dist" ]] || return 1
  [[ $($SHA256SUM "$gateway_script" | awk '{print $1}') == "$gateway_script_sha" ]] || return 1
  [[ $(tree_sha256 "$web_root" "$runtime_root") == "$web_tree_sha" ]] || return 1
  [[ $(tree_sha256 "$runtime_root/node_modules/ws" "$runtime_root") == "$ws_tree_sha" ]] || return 1
  "$NODE" "$runtime_root/scripts/tailnet-service.mjs" status >/dev/null 2>&1 || return 1
  gateway_health=$($CURL -fsS --max-time 5 "http://127.0.0.1:${gateway_port}/healthz" 2>/dev/null) || return 1
  printf '%s' "$gateway_health" | $JQ -e --arg identity "$deployment_identity" '
    .ok == true and .web == true and .upstream == true and .transport == "local-unix"
    and .deploymentIdentity == $identity
  ' >/dev/null || return 1
  return 0
}

local_state_matches_processed() {
  local_state_matches_record "$PROCESSED_FILE"
}

processed_matches() {
  local target=$1
  processed_metadata_matches "$target" && local_state_matches_processed \
    && verify_result_once "$PROCESSED_FILE" "$target" true
}

resolve_public_commit() {
  local repository=$1 ref=$2
  $GH api "repos/$repository/commits/$ref" --jq .sha
}

resolve_public_tag_object() {
  local repository=$1 tag=$2
  $GH api "repos/$repository/git/ref/tags/$tag" --jq .object.sha
}

release_assets_are_public() {
  local release_json=$1 version=$2
  local -a expected=(
    "SHA256SUMS.txt"
    "T4-Code-${version}-android.apk"
    "T4-Code-${version}-linux-amd64.deb"
    "T4-Code-${version}-linux-x86_64.AppImage"
    "T4-Code-${version}-mac-arm64.dmg"
    "T4-Code-${version}-mac-arm64.zip"
    "latest-linux.yml"
  )
  local name url manifest_url manifest_digest manifest_file actual_manifest_digest expected_digest asset_digest
  local manifest_entries release_asset_count
  release_asset_count=$(printf '%s' "$release_json" | $JQ -er 'select(.assets | length == 7) | .assets | length') || return 1
  [[ $release_asset_count == "${#expected[@]}" ]] || return 1
  manifest_url=$(printf '%s' "$release_json" | $JQ -er '
    .assets[] | select(.name == "SHA256SUMS.txt" and .state == "uploaded" and .size > 0)
    | .browser_download_url
  ') || return 1
  manifest_digest=$(printf '%s' "$release_json" | $JQ -er '
    .assets[] | select(.name == "SHA256SUMS.txt") | .digest
    | select(test("^sha256:[0-9a-f]{64}$"))
  ') || return 1
  manifest_file=$(mktemp "$STATE_DIR/release-manifest.XXXXXX")
  $CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$manifest_url" -o "$manifest_file" || {
    rm -f -- "$manifest_file"
    return 1
  }
  actual_manifest_digest=$($SHA256SUM "$manifest_file" | awk '{print "sha256:" $1}')
  [[ $actual_manifest_digest == "$manifest_digest" ]] || {
    rm -f -- "$manifest_file"
    return 1
  }
  for name in "${expected[@]}"; do
    url=$(printf '%s' "$release_json" | $JQ -er --arg name "$name" '
      .assets[]
      | select(.name == $name and .state == "uploaded" and .size > 0)
      | .browser_download_url
    ') || {
      rm -f -- "$manifest_file"
      return 1
    }
    $CURL -fsSIL --retry 3 --retry-all-errors --max-time 45 "$url" >/dev/null || {
      rm -f -- "$manifest_file"
      return 1
    }
    if [[ $name != SHA256SUMS.txt ]]; then
      expected_digest=$(awk -v name="$name" '$2 == name && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ {print $1}' "$manifest_file")
      [[ $expected_digest != *$'\n'* && $expected_digest =~ ^[0-9a-f]{64}$ ]] || {
        rm -f -- "$manifest_file"
        return 1
      }
      asset_digest=$(printf '%s' "$release_json" | $JQ -er --arg name "$name" '
        .assets[] | select(.name == $name) | .digest
        | select(test("^sha256:[0-9a-f]{64}$"))
      ') || {
        rm -f -- "$manifest_file"
        return 1
      }
      [[ $asset_digest == "sha256:$expected_digest" ]] || {
        rm -f -- "$manifest_file"
        return 1
      }
    fi
  done
  manifest_entries=$(awk 'length($1) == 64 && $1 ~ /^[0-9a-f]+$/ && NF == 2 {count += 1} END {print count + 0}' "$manifest_file")
  rm -f -- "$manifest_file"
  [[ $manifest_entries == 6 ]]
}

canonical_linux_update_assets() {
  local release_json=$1 version=$2
  printf '%s' "$release_json" | $JQ -ceS --arg version "$version" '
    [
      {name: "T4-Code-\($version)-linux-amd64.deb", maximumSize: 536870912},
      {name: "T4-Code-\($version)-linux-x86_64.AppImage", maximumSize: 536870912},
      {name: "latest-linux.yml", maximumSize: 65536}
    ] as $expected |
    . as $release |
    [$expected[] as $wanted |
      ([$release.assets[] | select(.name == $wanted.name)]) as $matches |
      select(($matches | length) == 1) |
      ($matches[0]) as $asset |
      select(
        $asset.state == "uploaded" and
        (($asset.size | type) == "number" and
          $asset.size > 0 and
          ($asset.size | floor) == $asset.size and
          $asset.size <= $wanted.maximumSize) and
        ($asset.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
        $asset.browser_download_url ==
          "https://github.com/LycaonLLC/t4-code/releases/download/v\($version)/\($wanted.name)"
      ) |
      {
        name: $asset.name,
        size: $asset.size,
        digest: $asset.digest,
        browserDownloadUrl: $asset.browser_download_url
      }
    ] as $assets |
    select(($assets | length) == 3) |
    {tagName: "v\($version)", assets: ($assets | sort_by(.name))}
  '
}

download_exact_release_asset() {
  local url=$1 destination=$2 expected_size=$3 maximum_seconds=$4 hard_limit_bytes file_limit_kib actual_size
  [[ $expected_size =~ ^[1-9][0-9]*$ && $maximum_seconds =~ ^[1-9][0-9]*$ ]] || return 1
  hard_limit_bytes=$((expected_size + 1048576))
  file_limit_kib=$(((hard_limit_bytes + 1023) / 1024))
  (
    ulimit -c 0
    ulimit -f "$file_limit_kib"
    "$CURL" -fsSL --retry 3 --retry-all-errors --proto '=https' --proto-redir '=https' \
      --max-redirs 5 --connect-timeout 15 --max-time "$maximum_seconds" \
      --max-filesize "$expected_size" "$url" -o "$destination"
  ) || return 1
  [[ -f $destination && ! -L $destination ]] || return 1
  actual_size=$(wc -c <"$destination" | awk '{print $1}') || return 1
  [[ $actual_size == "$expected_size" ]]
}

verify_live_linux_update() {
  local result_file=$1 release_json=$2 version=$3 allow_stored_proof=${4:-false}
  local canonical fingerprint stored download_dir asset name url size expected_digest actual_digest
  local metadata_path deb_path appimage_path temporary
  canonical=$(canonical_linux_update_assets "$release_json" "$version") || return 1
  fingerprint=$(printf '%s' "$canonical" | $SHA256SUM | awk '{print "sha256:" $1}') || return 1
  [[ $fingerprint =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  if [[ $allow_stored_proof == true ]] \
    && stored=$($JQ -ce '.publicProof.t4LinuxUpdate' "$result_file" 2>/dev/null); then
    printf '%s' "$stored" | $JQ -e \
      --arg fingerprint "$fingerprint" \
      --argjson canonical "$canonical" '
        .fingerprint == $fingerprint and .canonical == $canonical
      ' >/dev/null || return 1
    return 0
  fi

  [[ -s $LINUX_UPDATE_INSPECTOR && -f $LINUX_UPDATE_INSPECTOR && ! -L $LINUX_UPDATE_INSPECTOR ]] \
    || return 1
  download_dir=$(mktemp -d "$STATE_DIR/t4-linux-update.XXXXXX") || return 1
  while IFS= read -r asset; do
    name=$(printf '%s' "$asset" | $JQ -er '.name') || {
      rm -rf -- "$download_dir"
      return 1
    }
    url=$(printf '%s' "$asset" | $JQ -er '.browserDownloadUrl') || {
      rm -rf -- "$download_dir"
      return 1
    }
    size=$(printf '%s' "$asset" | $JQ -er '.size | select(type == "number" and . > 0 and floor == .)') || {
      rm -rf -- "$download_dir"
      return 1
    }
    expected_digest=$(printf '%s' "$asset" | $JQ -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))') || {
      rm -rf -- "$download_dir"
      return 1
    }
    if [[ $name == latest-linux.yml ]]; then
      download_exact_release_asset "$url" "$download_dir/$name" "$size" 45 || {
        rm -rf -- "$download_dir"
        return 1
      }
    else
      download_exact_release_asset "$url" "$download_dir/$name" "$size" 600 || {
        rm -rf -- "$download_dir"
        return 1
      }
    fi
    actual_digest=$($SHA256SUM "$download_dir/$name" | awk '{print "sha256:" $1}')
    [[ $actual_digest == "$expected_digest" ]] || {
      rm -rf -- "$download_dir"
      return 1
    }
  done < <(printf '%s' "$canonical" | $JQ -c '.assets[]')

  metadata_path="$download_dir/latest-linux.yml"
  deb_path="$download_dir/T4-Code-${version}-linux-amd64.deb"
  appimage_path="$download_dir/T4-Code-${version}-linux-x86_64.AppImage"
  "$NODE" "$LINUX_UPDATE_INSPECTOR" \
    --version "$version" \
    --metadata "$metadata_path" \
    --artifact "$deb_path" \
    --artifact "$appimage_path" >/dev/null || {
    rm -rf -- "$download_dir"
    return 1
  }
  rm -rf -- "$download_dir"

  temporary=$(mktemp "$(dirname -- "$result_file")/.result-with-linux-update-proof.XXXXXX") || return 1
  $JQ \
    --arg verified_at "$(timestamp)" \
    --arg fingerprint "$fingerprint" \
    --argjson canonical "$canonical" '
      .publicProof.t4LinuxUpdate = {
        verifiedAt: $verified_at,
        fingerprint: $fingerprint,
        canonical: $canonical
      }
    ' "$result_file" >"$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  durable_replace "$temporary" "$result_file"
}

site_release_manifest_matches() {
  local release_json=$1 version=$2 manifest_status=0
  local cache_bust checksums_url checksums_digest checksums_file actual_checksums_digest
  local manifest_file release_file manifest_size checksums_size
  cache_bust=$(date +%s)
  checksums_url=$(printf '%s' "$release_json" | $JQ -er '
    [.assets[] | select(
      .name == "SHA256SUMS.txt" and .state == "uploaded" and .size > 0 and
      (.browser_download_url | type == "string") and
      (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
    )] | select(length == 1) | .[0].browser_download_url
  ') || return 1
  checksums_digest=$(printf '%s' "$release_json" | $JQ -er '
    [.assets[] | select(.name == "SHA256SUMS.txt")]
    | select(length == 1) | .[0].digest
    | select(test("^sha256:[0-9a-f]{64}$"))
  ') || return 1
  checksums_file=$(mktemp "$STATE_DIR/site-release-checksums.XXXXXX")
  manifest_file=$(mktemp "$STATE_DIR/site-release-manifest.XXXXXX")
  release_file=$(mktemp "$STATE_DIR/site-release-github.XXXXXX")
  printf '%s' "$release_json" >"$release_file"
  $CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$checksums_url" \
    -o "$checksums_file" || {
    rm -f -- "$checksums_file" "$manifest_file" "$release_file"
    return 1
  }
  checksums_size=$(wc -c <"$checksums_file")
  [[ $checksums_size -gt 0 && $checksums_size -le 65536 ]] || {
    rm -f -- "$checksums_file" "$manifest_file" "$release_file"
    return 1
  }
  actual_checksums_digest=$($SHA256SUM "$checksums_file" | awk '{print "sha256:" $1}')
  [[ $actual_checksums_digest == "$checksums_digest" ]] || {
    rm -f -- "$checksums_file" "$manifest_file" "$release_file"
    return 1
  }
  $CURL -fsSL --retry 3 --retry-all-errors --max-time 45 \
    "$T4_SITE/releases/latest.json?maintainer=$cache_bust" -o "$manifest_file" || {
    rm -f -- "$checksums_file" "$manifest_file" "$release_file"
    return 1
  }
  manifest_size=$(wc -c <"$manifest_file")
  [[ $manifest_size -gt 0 && $manifest_size -le 131072 ]] || {
    rm -f -- "$checksums_file" "$manifest_file" "$release_file"
    return 1
  }
  $JQ -e \
    --arg version "$version" \
    --slurpfile github "$release_file" \
    --rawfile sums "$checksums_file" '
      def expected_packages($version): [
        {platform: "android", kind: "apk", arch: "universal", name: "T4-Code-\($version)-android.apk"},
        {platform: "linux", kind: "deb", arch: "x86_64", name: "T4-Code-\($version)-linux-amd64.deb"},
        {platform: "linux", kind: "appimage", arch: "x86_64", name: "T4-Code-\($version)-linux-x86_64.AppImage"},
        {platform: "mac", kind: "dmg", arch: "arm64", name: "T4-Code-\($version)-mac-arm64.dmg"},
        {platform: "mac", kind: "zip", arch: "arm64", name: "T4-Code-\($version)-mac-arm64.zip"}
      ];
      def checksum_entries:
        ($sums | if endswith("\n") then .[0:-1] else . end) | split("\n") | map(
          capture("^(?<digest>[0-9a-f]{64})  (?<name>[A-Za-z0-9][A-Za-z0-9._-]*)$")
        );
      ($github[0]) as $release |
      (expected_packages($version)) as $expected |
      (checksum_entries) as $entries |
      (reduce $entries[] as $entry ({};
        if has($entry.name) then error("duplicate checksum entry")
        else .[$entry.name] = $entry.digest end
      )) as $checksums |
      . as $manifest |
      ($expected | map(.name)) as $package_names |
      ($package_names + ["latest-linux.yml"]) as $checksummed_names |
      (. | keys | sort) ==
        (["assets", "channel", "publishedAt", "releaseUrl", "schemaVersion", "tag", "version"] | sort) and
      .schemaVersion == 1 and .channel == "stable" and
      .version == $version and .tag == "v\($version)" and
      .publishedAt == $release.published_at and
      .releaseUrl == $release.html_url and
      ($release.published_at | type == "string") and
      ($release.published_at | fromdateiso8601 | type == "number") and
      (.assets | type == "array" and length == 5) and
      (($checksums | keys | sort) == ($checksummed_names | sort)) and
      ([range(0; 5) as $index |
        $expected[$index] as $wanted |
        $manifest.assets[$index] as $actual |
        ([$release.assets[] | select(.name == $wanted.name)]) as $matches |
        (($actual | keys | sort) ==
          (["arch", "kind", "name", "platform", "sha256", "size", "url"] | sort)) and
        $actual.platform == $wanted.platform and
        $actual.kind == $wanted.kind and
        $actual.arch == $wanted.arch and
        $actual.name == $wanted.name and
        ($actual.size | type == "number" and . > 0 and floor == .) and
        ($actual.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
        ($matches | length) == 1 and
        (($matches[0]) as $published |
          $published.state == "uploaded" and
          $published.size == $actual.size and
          $published.browser_download_url == $actual.url and
          $published.browser_download_url ==
            "https://github.com/LycaonLLC/t4-code/releases/download/v\($version)/\($wanted.name)" and
          $published.digest == "sha256:\($actual.sha256)" and
          $checksums[$wanted.name] == $actual.sha256)
      ] | all) and
      ([$checksummed_names[] as $name |
        ([$release.assets[] | select(.name == $name)]) as $matches |
        ($matches | length) == 1 and
        (($matches[0]) as $published |
          $published.digest == "sha256:\($checksums[$name])")
      ] | all)
  ' "$manifest_file" >/dev/null || manifest_status=$?
  rm -f -- "$checksums_file" "$manifest_file" "$release_file"
  return "$manifest_status"
}

atomic_publication_receipt_is_valid() {
  local result_file=$1 integration_tag receipt_file intent_file intent_object embedded
  local upstream_tag upstream_commit integration_commit
  local official_tag_object fork_tag_object integration_tag_object
  integration_tag=$($JQ -er '.integration.tag | strings | select(test("^t4code-[0-9]+\\.[0-9]+\\.[0-9]+-appserver-[1-9][0-9]*$"))' "$result_file") \
    || return 1
  upstream_tag=$($JQ -er '.upstream.tag' "$result_file") || return 1
  upstream_commit=$($JQ -er '.upstream.commit' "$result_file") || return 1
  integration_commit=$($JQ -er '.integration.commit' "$result_file") || return 1
  receipt_file="$ATOMIC_PUBLICATION_STATE_DIR/$integration_tag/receipt.json"
  intent_file="$ATOMIC_PUBLICATION_STATE_DIR/$integration_tag/intent.json"
  [[ -s $receipt_file && -f $receipt_file && ! -L $receipt_file ]] || return 1
  [[ -s $intent_file && -f $intent_file && ! -L $intent_file ]] || return 1
  intent_object=$($GIT hash-object "$intent_file") || return 1
  [[ $intent_object =~ ^[0-9a-f]{40}$ ]] || return 1
  $JQ -e \
    --arg upstream_tag "$upstream_tag" \
    --arg upstream_commit "$upstream_commit" \
    --arg integration_tag "$integration_tag" \
    --arg integration_commit "$integration_commit" \
    --arg intent_object "$intent_object" '
      .schemaVersion == 1 and .helperOwned == true and .atomicPush == true and
      .pushedRefCount == 3 and .productionRemoteIdentity == true and
      .officialRepository == "can1357/oh-my-pi" and
      .forkRepository == "lyc-aon/oh-my-pi" and
      .upstream.tag == $upstream_tag and .upstream.commit == $upstream_commit and
      (.upstream.tagObject | test("^[0-9a-f]{40}$")) and
      .product.branch == "t4code/main" and .product.commit == $integration_commit and
      .integration.tag == $integration_tag and
      .integration.commit == $integration_commit and
      (.integration.tagObject | test("^[0-9a-f]{40}$")) and
      .intentObject == $intent_object
  ' "$receipt_file" >/dev/null || return 1
  $JQ -e \
    --arg upstream_tag "$upstream_tag" \
    --arg upstream_commit "$upstream_commit" \
    --arg integration_tag "$integration_tag" \
    --arg integration_commit "$integration_commit" \
    --slurpfile receipt "$receipt_file" '
      def oid: type == "string" and test("^[0-9a-f]{40}$");
      def oid_or_empty: . == "" or oid;
      ($receipt[0]) as $r |
      .schemaVersion == 1 and (.createdAt | type == "string") and
      .upstream.tag == $upstream_tag and .upstream.commit == $upstream_commit and
      .integrationTag == $integration_tag and
      (.before.baseTagObject == "" or .before.baseTagObject == $r.upstream.tagObject) and
      .before.integrationTagObject == "" and
      (.before.productCommit | oid_or_empty) and
      .desired.baseTagObject == $r.upstream.tagObject and
      .desired.integrationTagObject == $r.integration.tagObject and
      .desired.productCommit == $integration_commit and
      .before.productCommit != .desired.productCommit and
      .atomicRefspecs == [
        "official-base-tag",
        "t4code/main",
        "annotated-integration-tag"
      ]
    ' "$intent_file" >/dev/null || return 1
  official_tag_object=$(resolve_public_tag_object "$OMP_UPSTREAM_REPOSITORY" "$upstream_tag") \
    || return 1
  fork_tag_object=$(resolve_public_tag_object "$OMP_INTEGRATION_REPOSITORY" "$upstream_tag") \
    || return 1
  integration_tag_object=$(resolve_public_tag_object "$OMP_INTEGRATION_REPOSITORY" "$integration_tag") \
    || return 1
  [[ $official_tag_object == "$fork_tag_object" ]] || return 1
  [[ $($JQ -r '.upstream.tagObject' "$receipt_file") == "$official_tag_object" ]] || return 1
  [[ $($JQ -r '.integration.tagObject' "$receipt_file") == "$integration_tag_object" ]] || return 1
  if $JQ -e 'has("atomicPublication")' "$result_file" >/dev/null; then
    embedded=$($JQ -cS '.atomicPublication' "$result_file") || return 1
    [[ $embedded == "$($JQ -cS . "$receipt_file")" ]] || return 1
  fi
}

attach_atomic_publication_receipt() {
  local result_file=$1 integration_tag receipt_file temporary
  atomic_publication_receipt_is_valid "$result_file" || return 1
  $JQ -e 'has("atomicPublication")' "$result_file" >/dev/null && return 0
  integration_tag=$($JQ -r '.integration.tag' "$result_file")
  receipt_file="$ATOMIC_PUBLICATION_STATE_DIR/$integration_tag/receipt.json"
  temporary=$(mktemp "$(dirname -- "$result_file")/.result-with-atomic.XXXXXX")
  $JQ --slurpfile receipt "$receipt_file" '.atomicPublication = $receipt[0]' \
    "$result_file" >"$temporary"
  durable_replace "$temporary" "$result_file"
}

omp_publication_workflow_succeeded() {
  local integration_commit=$1 runs
  runs=$($GH api \
    "repos/$OMP_INTEGRATION_REPOSITORY/actions/workflows/$OMP_FORK_WORKFLOW/runs?head_sha=$integration_commit&event=push&branch=$OMP_PRODUCT_BRANCH&status=success&per_page=100") \
    || return 1
  printf '%s' "$runs" | $JQ -e \
    --arg commit "$integration_commit" \
    --arg branch "$OMP_PRODUCT_BRANCH" '
      any(.workflow_runs[];
        .name == "CI" and .path == ".github/workflows/ci.yml" and
        .head_sha == $commit and .event == "push" and
        .head_branch == $branch and .status == "completed" and
        .conclusion == "success")
    ' >/dev/null
}

canonical_omp_release() {
  local release_json=$1 integration_tag=$2 expected_url expected_download_prefix expected_names allow_mock
  expected_url="https://github.com/$OMP_INTEGRATION_REPOSITORY/releases/tag/$integration_tag"
  expected_download_prefix="https://github.com/$OMP_INTEGRATION_REPOSITORY/releases/download/$integration_tag/"
  expected_names=$($JQ -cn '[
    "omp-linux-x64",
    "omp-linux-arm64",
    "omp-darwin-x64",
    "omp-darwin-arm64",
    "omp-windows-x64.exe"
  ]')
  if [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 ]]; then allow_mock=true; else allow_mock=false; fi
  printf '%s' "$release_json" | $JQ -ceS \
    --arg tag "$integration_tag" \
    --arg url "$expected_url" \
    --arg download_prefix "$expected_download_prefix" \
    --argjson expected "$expected_names" \
    --argjson allow_mock "$allow_mock" '
      select(.tag_name == $tag and .html_url == $url and
        .draft == false and .prerelease == false) |
      select((.assets | type) == "array" and (.assets | length) == 5) |
      select((.assets | map(.name) | sort) == ($expected | sort)) |
      select(all(.assets[];
        .state == "uploaded" and
        (.size | type == "number" and . > 0 and . == floor) and
        (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
        (.browser_download_url | type == "string") and
        ((.browser_download_url | startswith($download_prefix)) or
          ($allow_mock and (.browser_download_url | startswith("mock://")))))) |
      {
        tagName:.tag_name,
        htmlUrl:.html_url,
        assets:(.assets | sort_by(.name) | map({
          name, state, size, digest, browserDownloadUrl:.browser_download_url
        }))
      }
    '
}

verify_omp_release_assets() {
  local result_file=$1 release_json=$2 integration_tag=$3 allow_stored_proof=${4:-false}
  local canonical fingerprint stored
  local download_dir asset name url expected_digest actual_digest temporary
  canonical=$(canonical_omp_release "$release_json" "$integration_tag") || return 1
  fingerprint=$(printf '%s' "$canonical" | $SHA256SUM | awk '{print "sha256:" $1}')
  [[ $fingerprint =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  if [[ $allow_stored_proof == true ]] \
    && stored=$($JQ -ce '.publicProof.ompRelease' "$result_file" 2>/dev/null); then
    printf '%s' "$stored" | $JQ -e \
      --arg fingerprint "$fingerprint" \
      --argjson canonical "$canonical" '
        .fingerprint == $fingerprint and .canonical == $canonical
      ' >/dev/null || return 1
    while IFS= read -r url; do
      $CURL -fsSIL --retry 3 --retry-all-errors --max-time 45 "$url" >/dev/null \
        || return 1
    done < <(printf '%s' "$canonical" | $JQ -r '.assets[].browserDownloadUrl')
    return 0
  fi

  download_dir=$(mktemp -d "$STATE_DIR/omp-release-assets.XXXXXX") || return 1
  while IFS= read -r asset; do
    name=$(printf '%s' "$asset" | $JQ -r '.name')
    url=$(printf '%s' "$asset" | $JQ -r '.browserDownloadUrl')
    expected_digest=$(printf '%s' "$asset" | $JQ -r '.digest')
    $CURL -fsSL --retry 3 --retry-all-errors --max-time 180 "$url" \
      -o "$download_dir/$name" || {
        rm -rf -- "$download_dir"
        return 1
      }
    actual_digest=$($SHA256SUM "$download_dir/$name" | awk '{print "sha256:" $1}')
    [[ $actual_digest == "$expected_digest" ]] || {
      rm -rf -- "$download_dir"
      return 1
    }
  done < <(printf '%s' "$canonical" | $JQ -c '.assets[]')
  rm -rf -- "$download_dir"
  temporary=$(mktemp "$(dirname -- "$result_file")/.result-with-public-proof.XXXXXX")
  $JQ \
    --arg verified_at "$(timestamp)" \
    --arg fingerprint "$fingerprint" \
    --argjson canonical "$canonical" '
      .publicProof.ompRelease = {
        verifiedAt:$verified_at,
        fingerprint:$fingerprint,
        canonical:$canonical
      }
    ' "$result_file" >"$temporary"
  durable_replace "$temporary" "$result_file"
}

tagged_t4_metadata_matches() {
  local result_file=$1 t4_tag package_json matrix
  t4_tag=$($JQ -r '.t4.tag' "$result_file")
  package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/package.json?ref=$t4_tag") || return 1
  matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=$t4_tag") || return 1
  $JQ -e --argjson publication "$(<"$result_file")" '
    .version == $publication.t4.version
  ' <<<"$package_json" >/dev/null || return 1
  $JQ -e --argjson publication "$(<"$result_file")" '
    .desktop.version == $publication.t4.version and
    .verifiedRuntime.upstreamTag == $publication.upstream.tag and
    .verifiedRuntime.upstreamCommit == $publication.upstream.commit and
    .verifiedRuntime.sourceTag == $publication.integration.tag and
    .verifiedRuntime.sourceCommit == $publication.integration.commit
  ' <<<"$matrix" >/dev/null
}

publication_workflows_succeeded() {
  local commit=$1 t4_tag=$2 runs
  runs=$($GH api "repos/$T4_REPOSITORY/actions/runs?head_sha=$commit&per_page=100") || return 1
  printf '%s' "$runs" | $JQ -e --arg tag "$t4_tag" --arg commit "$commit" '
    any(.workflow_runs[]; .name == "CI" and .path == ".github/workflows/ci.yml" and .head_sha == $commit and .event == "push" and .status == "completed" and .conclusion == "success") and
    any(.workflow_runs[]; .name == "Release app builds" and .path == ".github/workflows/release.yml" and .head_sha == $commit and .event == "push" and .head_branch == $tag and .status == "completed" and .conclusion == "success") and
    any(.workflow_runs[]; .path == ".github/workflows/deploy-site.yml" and .head_sha == $commit and .event == "workflow_dispatch" and .status == "completed" and .conclusion == "success")
  ' >/dev/null
}

publication_workflows_active_or_recent() {
  local commit=$1 t4_tag=$2 runs cutoff
  cutoff=$(($(date +%s) - 21600))
  runs=$($GH api "repos/$T4_REPOSITORY/actions/runs?head_sha=$commit&per_page=100") || return 1
  printf '%s' "$runs" | $JQ -e --arg tag "$t4_tag" --arg commit "$commit" --argjson cutoff "$cutoff" '
    def relevant:
      (.name == "CI" and .path == ".github/workflows/ci.yml" and .head_sha == $commit and .event == "push") or
      (.name == "Release app builds" and .path == ".github/workflows/release.yml" and .head_sha == $commit and .event == "push" and .head_branch == $tag) or
      (.path == ".github/workflows/deploy-site.yml" and .head_sha == $commit and .event == "workflow_dispatch");
    any(.workflow_runs[]; relevant and .status != "completed") or
    (
      any(.workflow_runs[]; .name == "CI" and .path == ".github/workflows/ci.yml" and .head_sha == $commit and .event == "push" and .conclusion == "success") and
      any(.workflow_runs[]; .name == "Release app builds" and .path == ".github/workflows/release.yml" and .head_sha == $commit and .event == "push" and .head_branch == $tag and .conclusion == "success") and
      any(.workflow_runs[]; .path == ".github/workflows/deploy-site.yml" and .head_sha == $commit and .event == "workflow_dispatch" and .conclusion == "success") and
      any(.workflow_runs[]; relevant and .conclusion == "success" and ((.updated_at | fromdateiso8601) >= $cutoff))
    )
  ' >/dev/null
}

integration_descends_from_upstream() {
  local upstream_commit=$1 integration_commit=$2 comparison
  comparison=$($GH api "repos/$OMP_INTEGRATION_REPOSITORY/compare/$upstream_commit...$integration_commit") || return 1
  printf '%s' "$comparison" | $JQ -e --arg upstream "$upstream_commit" --arg integration "$integration_commit" '
    .base_commit.sha == $upstream and
    .merge_base_commit.sha == $upstream and
    ((.status == "ahead" and .ahead_by > 0) or
     (.status == "identical" and $integration == $upstream))
  ' >/dev/null
}

integration_is_reachable_from_product_branch() {
  local integration_commit=$1 comparison
  comparison=$($GH api "repos/$OMP_INTEGRATION_REPOSITORY/compare/$integration_commit...$OMP_PRODUCT_BRANCH") || return 1
  printf '%s' "$comparison" | $JQ -e --arg integration "$integration_commit" '
    .base_commit.sha == $integration and
    .merge_base_commit.sha == $integration and
    (.status == "ahead" or .status == "identical")
  ' >/dev/null
}

t4_commit_is_reachable_from_main() {
  local commit=$1 comparison
  comparison=$($GH api "repos/$T4_REPOSITORY/compare/$commit...main") || return 1
  printf '%s' "$comparison" | $JQ -e --arg commit "$commit" '
    .merge_base_commit.sha == $commit and (.status == "ahead" or .status == "identical")
  ' >/dev/null
}

site_has_release() {
  local t4_tag=$1 integration_tag=$2 version=$3
  local cache_bust index docs site_assets asset bundle_file release_asset
  local -a release_assets=(
    "T4-Code-${version}-android.apk"
    "T4-Code-${version}-linux-amd64.deb"
    "T4-Code-${version}-linux-x86_64.AppImage"
    "T4-Code-${version}-mac-arm64.dmg"
    "T4-Code-${version}-mac-arm64.zip"
  )
  cache_bust=$(date +%s)
  index=$($CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE/?maintainer=$cache_bust") || return 1
  docs=$($CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE/docs/?maintainer=$cache_bust") || return 1
  site_assets=$(printf '%s\n%s' "$index" "$docs" | grep -oE '(src|href)="/assets/[^"]+\.js"' | sed -E 's/^(src|href)="([^"]+)"$/\2/' | sort -u)
  [[ -n $site_assets ]] || return 1
  bundle_file=$(mktemp "$STATE_DIR/site-bundles.XXXXXX")
  while IFS= read -r asset; do
    $CURL -fsSL --retry 3 --retry-all-errors --max-time 45 "$T4_SITE${asset}?maintainer=$cache_bust" >>"$bundle_file" || {
      rm -f -- "$bundle_file"
      return 1
    }
  done <<<"$site_assets"
  grep -Fq -- "$t4_tag" "$bundle_file" || {
    rm -f -- "$bundle_file"
    return 1
  }
  grep -Fq -- "$integration_tag" "$bundle_file" || {
    rm -f -- "$bundle_file"
    return 1
  }
  for release_asset in "${release_assets[@]}"; do
    grep -Fq -- "$release_asset" "$bundle_file" || {
      rm -f -- "$bundle_file"
      return 1
    }
  done
  rm -f -- "$bundle_file"
}

verify_result_once() {
  local result_file=$1 target=$2 allow_stored_proof=${3:-false}
  local upstream_tag upstream_commit integration_tag integration_commit
  local t4_version t4_tag t4_commit release_url site_url site_tag
  local actual_upstream_commit actual_integration_commit actual_t4_commit release_json expected_release_url
  local omp_release_json
  local official_main_commit fork_main_commit official_base_tag_object fork_base_tag_object
  local fork_base_commit

  atomic_publication_receipt_is_valid "$result_file" || return 1
  $JQ -e '
    (.upstream.tag | type == "string") and
    (.upstream.commit | test("^[0-9a-f]{40}$")) and
    (.integration.tag | type == "string") and
    (.integration.commit | test("^[0-9a-f]{40}$")) and
    (.t4.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.t4.tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.t4.commit | test("^[0-9a-f]{40}$")) and
    (.release.url | type == "string") and
    (.site.url | type == "string") and
    (.site.releaseTag | type == "string")
  ' "$result_file" >/dev/null || return 1

  upstream_tag=$($JQ -r '.upstream.tag' "$result_file")
  upstream_commit=$($JQ -r '.upstream.commit' "$result_file")
  integration_tag=$($JQ -r '.integration.tag' "$result_file")
  integration_commit=$($JQ -r '.integration.commit' "$result_file")
  t4_version=$($JQ -r '.t4.version' "$result_file")
  t4_tag=$($JQ -r '.t4.tag' "$result_file")
  t4_commit=$($JQ -r '.t4.commit' "$result_file")
  release_url=$($JQ -r '.release.url' "$result_file")
  site_url=$($JQ -r '.site.url' "$result_file")
  site_tag=$($JQ -r '.site.releaseTag' "$result_file")

  [[ $upstream_tag == "$($JQ -r '.tag' <<<"$target")" ]] || return 1
  [[ $upstream_commit == "$($JQ -r '.commit' <<<"$target")" ]] || return 1
  [[ $integration_tag =~ ^t4code-${upstream_tag#v}-appserver-[1-9][0-9]*$ ]] || return 1
  [[ $t4_tag == "v$t4_version" ]] || return 1
  [[ $site_tag == "$t4_tag" && $site_url == "$T4_SITE" ]] || return 1
  expected_release_url="https://github.com/$T4_REPOSITORY/releases/tag/$t4_tag"
  [[ $release_url == "$expected_release_url" ]] || return 1

  actual_upstream_commit=$(resolve_public_commit "$OMP_UPSTREAM_REPOSITORY" "$upstream_tag") || return 1
  [[ $actual_upstream_commit == "$upstream_commit" ]] || return 1
  official_base_tag_object=$(resolve_public_tag_object "$OMP_UPSTREAM_REPOSITORY" "$upstream_tag") \
    || return 1
  fork_base_tag_object=$(resolve_public_tag_object "$OMP_INTEGRATION_REPOSITORY" "$upstream_tag") \
    || return 1
  [[ $official_base_tag_object =~ ^[0-9a-f]{40}$ \
    && $fork_base_tag_object == "$official_base_tag_object" ]] || return 1
  fork_base_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" "$upstream_tag") || return 1
  [[ $fork_base_commit == "$upstream_commit" ]] || return 1
  official_main_commit=$(resolve_public_commit "$OMP_UPSTREAM_REPOSITORY" main) || return 1
  fork_main_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" main) || return 1
  [[ $official_main_commit =~ ^[0-9a-f]{40}$ && $fork_main_commit == "$official_main_commit" ]] \
    || return 1
  actual_integration_commit=$(resolve_public_commit "$OMP_INTEGRATION_REPOSITORY" "$integration_tag") || return 1
  [[ $actual_integration_commit == "$integration_commit" ]] || return 1
  integration_descends_from_upstream "$upstream_commit" "$integration_commit" || return 1
  integration_is_reachable_from_product_branch "$integration_commit" || return 1
  omp_publication_workflow_succeeded "$integration_commit" || return 1
  omp_release_json=$($GH api "repos/$OMP_INTEGRATION_REPOSITORY/releases/tags/$integration_tag") \
    || return 1
  verify_omp_release_assets "$result_file" "$omp_release_json" "$integration_tag" \
    "$allow_stored_proof" || return 1
  actual_t4_commit=$(resolve_public_commit "$T4_REPOSITORY" "$t4_tag") || return 1
  [[ $actual_t4_commit == "$t4_commit" ]] || return 1
  t4_commit_is_reachable_from_main "$t4_commit" || return 1
  tagged_t4_metadata_matches "$result_file" || return 1
  publication_workflows_succeeded "$t4_commit" "$t4_tag" || return 1

  release_json=$($GH api "repos/$T4_REPOSITORY/releases/tags/$t4_tag") || return 1
  printf '%s' "$release_json" | $JQ -e --arg tag "$t4_tag" --arg url "$expected_release_url" '
    .tag_name == $tag and .html_url == $url and .draft == false and .prerelease == false
  ' >/dev/null || return 1
  release_assets_are_public "$release_json" "$t4_version" || return 1
  site_release_manifest_matches "$release_json" "$t4_version" || return 1
  site_has_release "$t4_tag" "$integration_tag" "$t4_version" || return 1
  verify_live_linux_update "$result_file" "$release_json" "$t4_version" \
    "$allow_stored_proof" || return 1
}

verify_result() {
  local result_file=$1 target=$2 allow_stored_proof=${3:-false} attempt retry_stored_proof temporary
  [[ -s $result_file ]] || fail "the maintainer result file is missing"
  retry_stored_proof=$allow_stored_proof
  if [[ $allow_stored_proof != true ]] \
    && $JQ -e '.publicProof? | type == "object" and (has("ompRelease") or has("t4LinuxUpdate"))' \
      "$result_file" >/dev/null 2>&1; then
    temporary=$(mktemp "$(dirname -- "$result_file")/.result-without-untrusted-proof.XXXXXX")
    $JQ '
      del(.publicProof.ompRelease, .publicProof.t4LinuxUpdate)
      | if .publicProof == {} then del(.publicProof) else . end
    ' "$result_file" >"$temporary"
    durable_replace "$temporary" "$result_file"
  fi
  attach_atomic_publication_receipt "$result_file" \
    || fail "the publication lacks a matching wrapper-owned three-ref atomic OMP receipt"
  require_positive_integer T4_MAINTAINER_VERIFY_ATTEMPTS "$VERIFY_ATTEMPTS"
  require_positive_integer T4_MAINTAINER_VERIFY_INTERVAL_SECONDS "$VERIFY_INTERVAL_SECONDS"
  for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1)); do
    if verify_result_once "$result_file" "$target" "$retry_stored_proof"; then
      log "Public GitHub release assets and t4code.net match the maintainer result."
      return 0
    fi
    if [[ $retry_stored_proof != true ]] \
      && $JQ -e '.publicProof.ompRelease.fingerprint | test("^sha256:[0-9a-f]{64}$")' \
        "$result_file" >/dev/null 2>&1; then
      retry_stored_proof=true
    fi
    if ((attempt < VERIFY_ATTEMPTS)); then
      log "Public release verification is still converging (${attempt}/${VERIFY_ATTEMPTS}); checking again in ${VERIFY_INTERVAL_SECONDS}s."
      "$SLEEP" "$VERIFY_INTERVAL_SECONDS"
    fi
  done
  fail "public release verification did not converge"
}

record_pending() {
  local result_file=$1 run_id=$2 temporary
  temporary=$(mktemp "$STATE_DIR/pending.json.XXXXXX")
  $JQ -n \
    --arg public_verified_at "$(timestamp)" \
    --arg run_id "$run_id" \
    --slurpfile publication "$result_file" \
    '{
      schemaVersion: 1,
      publicVerifiedAt: $public_verified_at,
      publicationRunId: $run_id,
      publication: $publication[0]
    }' >"$temporary"
  durable_replace "$temporary" "$PENDING_FILE"
}

clear_pending() {
  durable_remove "$PENDING_FILE"
}

clear_local_applied() {
  durable_remove "$LOCAL_APPLIED_FILE"
}

requeue_processed_publication() {
  local target repair_id run_dir result_file
  [[ -s $PROCESSED_FILE ]] || return 0
  target=$(latest_stable_release)
  processed_metadata_matches "$target" || return 0
  local_state_matches_processed && return 0

  repair_id="repair-$("$DATE" -u +%Y%m%dT%H%M%SZ)-$$"
  run_dir="$RUNS_DIR/$repair_id"
  result_file="$run_dir/result.json"
  mkdir -p -- "$run_dir"
  chmod 700 "$run_dir"
  $JQ 'del(.processedAt, .runId, .publicVerification, .localDeployment)' "$PROCESSED_FILE" >"$result_file"
  verify_result "$result_file" "$target" true
  record_pending "$result_file" "$repair_id"
  log "Local T4 deployment drifted; queued the exact verified publication for repair without invoking Sol."
}

semantic_version_is_newer() {
  local candidate=$1 current=$2
  $JQ -en --arg candidate "$candidate" --arg current "$current" '
    def semver:
      select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
      | split(".")
      | map(tonumber);
    ($candidate | semver) > ($current | semver)
  ' >/dev/null
}

newer_compatible_t4_publication_exists() {
  local target=$1 current_version package_json matrix package_version release_json t4_tag
  current_version=$($JQ -er '
    .t4.version | strings | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ' "$PROCESSED_FILE") || fail "processed T4 state has an invalid package version"

  package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' \
    "repos/$T4_REPOSITORY/contents/package.json?ref=main") \
    || fail "T4 main package metadata could not be read"
  matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' \
    "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=main") \
    || fail "T4 main compatibility metadata could not be read"
  package_version=$(printf '%s' "$package_json" | $JQ -er '
    .version | strings | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "T4 main has an invalid package version"
  if semantic_version_is_newer "$package_version" "$current_version" \
    && public_metadata_is_compatible "$matrix" "$target" "$package_version"; then
    log "T4 main v$package_version is a newer compatible publication candidate than processed v$current_version."
    return 0
  fi

  release_json=$($GH api "repos/$T4_REPOSITORY/releases/latest") \
    || fail "the latest public T4 release could not be read"
  t4_tag=$(printf '%s' "$release_json" | $JQ -er '
    select(.draft == false and .prerelease == false)
    | .tag_name
    | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "the latest public T4 release is not a stable semantic-version tag"
  package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' \
    "repos/$T4_REPOSITORY/contents/package.json?ref=$t4_tag") \
    || fail "the latest public T4 package metadata could not be read"
  matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' \
    "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=$t4_tag") \
    || fail "the latest public T4 compatibility metadata could not be read"
  package_version=$(printf '%s' "$package_json" | $JQ -er '
    .version | strings | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "the latest public T4 package version is invalid"
  [[ $t4_tag == "v$package_version" ]] \
    || fail "the latest T4 release tag and tagged package version disagree"
  if semantic_version_is_newer "$package_version" "$current_version" \
    && public_metadata_is_compatible "$matrix" "$target" "$package_version"; then
    log "Public T4 $t4_tag is newer and compatible with the processed official OMP release."
    return 0
  fi
  return 1
}

finish_verified_processed_noop() {
  local target upstream_tag upstream_commit
  target=$(latest_stable_release)
  processed_metadata_matches "$target" || return 1
  local_state_matches_processed || return 1
  newer_compatible_t4_publication_exists "$target" && return 1
  verify_result "$PROCESSED_FILE" "$target" true
  upstream_tag=$($JQ -r '.tag' <<<"$target")
  upstream_commit=$($JQ -r '.commit' <<<"$target")
  log "Latest stable official OMP release $upstream_tag ($upstream_commit) remains publicly and locally verified."
  return 0
}

record_local_applied() {
  local result_file=$1 run_id=$2 local_receipt=$3 temporary
  temporary=$(mktemp "$STATE_DIR/local-applied.json.XXXXXX")
  $JQ \
    --arg local_applied_at "$(timestamp)" \
    --arg run_id "$run_id" \
    --slurpfile local_deployment "$local_receipt" '
      . + {
        localAppliedAt: $local_applied_at,
        runId: $run_id,
        publicVerification: "complete",
        localDeployment: $local_deployment[0]
      }
    ' "$result_file" >"$temporary"
  durable_replace "$temporary" "$LOCAL_APPLIED_FILE"
}

local_applied_matches_pending() {
  [[ -s $LOCAL_APPLIED_FILE ]] || return 1
  $JQ -e --slurpfile applied "$LOCAL_APPLIED_FILE" '
    .publication.upstream == $applied[0].upstream and
    .publication.integration == $applied[0].integration and
    .publication.t4 == $applied[0].t4 and
    .publicationRunId == $applied[0].runId and
    $applied[0].publicVerification == "complete" and
    $applied[0].localDeployment.status == "complete" and
    $applied[0].localDeployment.gateway.tailnetHealth == "pending"
  ' "$PENDING_FILE" >/dev/null 2>&1
}

finalize_local_applied() {
  local run_id temporary
  run_id=$($JQ -er '.runId | strings | select(length > 0)' "$LOCAL_APPLIED_FILE")
  temporary=$(mktemp "$STATE_DIR/processed.json.XXXXXX")
  $JQ --arg processed_at "$(timestamp)" '
    del(.localAppliedAt)
    | .processedAt = $processed_at
    | .localDeployment.gateway.tailnetHealth = "healthy"
  ' "$LOCAL_APPLIED_FILE" >"$temporary"
  durable_replace "$temporary" "$PROCESSED_FILE"
  clear_local_applied
  clear_pending
  cleanup_processed_workspace "$run_id" \
    || log "WARNING: processed state is durable, but its successful Sol workspace could not be removed."
}

pending_publication_is_valid() {
  $JQ -e '
    .schemaVersion == 1 and
    (.publicVerifiedAt | type == "string") and
    (.publicationRunId | type == "string" and length > 0) and
    (.publication | type == "object") and
    (.publication.upstream.tag | type == "string") and
    (.publication.upstream.commit | test("^[0-9a-f]{40}$"))
  ' "$PENDING_FILE" >/dev/null
}

local_receipt_is_valid() {
  local receipt_file=$1 result_file=$2 expected_identity recorded_identity
  $JQ -e --slurpfile publication "$result_file" '
    .schemaVersion == 1 and
    .status == "complete" and
    .upstream == $publication[0].upstream and
    .integration == $publication[0].integration and
    .t4 == $publication[0].t4 and
    (.omp.installedSha256 | test("^[0-9a-f]{64}$")) and
    (.omp.runningExecutableSha256 | test("^[0-9a-f]{64}$")) and
    .omp.installedSha256 == .omp.runningExecutableSha256 and
    .omp.version == ("omp/" + ($publication[0].upstream.tag | ltrimstr("v"))) and
    (.desktop.debSha256 | test("^[0-9a-f]{64}$")) and
    .desktop.installedVersion == $publication[0].t4.version and
    .desktop.dpkgVerification == "clean" and
    .omp.health == "healthy" and
    (.omp.hostId | type == "string" and length > 0) and
    (.omp.epoch | type == "string" and length > 0) and
    .gateway.activeState == "active" and
    .gateway.health == "healthy" and
    .gateway.helperStatus == "healthy" and
    .gateway.loopbackHealth == "healthy" and
    .gateway.tailnetHealth == "pending" and
    (.gateway.allowedOrigin | type == "string" and test("^https://")) and
    (.gateway.port | type == "number" and . >= 1024 and . <= 65535) and
    (.gateway.appSocket | type == "string" and startswith("/")) and
    (.gateway.label | type == "string" and length > 0) and
    (.gateway.nodeExecutable | type == "string" and startswith("/")) and
    .gateway.runtimeCommit == $publication[0].t4.commit and
    (.gateway.deploymentIdentity | test("^sha256:[0-9a-f]{64}$")) and
    (.gateway.artifacts.gatewayScriptSha256 | test("^[0-9a-f]{64}$")) and
    (.gateway.artifacts.webTreeSha256 | test("^[0-9a-f]{64}$")) and
    (.gateway.artifacts.wsTreeSha256 | test("^[0-9a-f]{64}$")) and
    (.gateway.artifacts.configSha256 | test("^[0-9a-f]{64}$")) and
    (.gateway.artifacts.unitSha256 | test("^[0-9a-f]{64}$")) and
    .rollback.available == true
  ' "$receipt_file" >/dev/null || return 1
  expected_identity=$(deployment_identity \
    "$($JQ -r '.t4.commit' "$result_file")" \
    "$($JQ -r '.integration.commit' "$result_file")" \
    "$($JQ -r '.omp.installedSha256' "$receipt_file")") || return 1
  recorded_identity=$($JQ -r '.gateway.deploymentIdentity' "$receipt_file") || return 1
  [[ $recorded_identity == "$expected_identity" ]]
}

deploy_pending_publication() {
  local retry_id run_dir result_file receipt_file target publication_run_id staged_result
  [[ -s $PENDING_FILE ]] || return 0
  pending_publication_is_valid || fail "pending publication state is invalid: $PENDING_FILE"
  staged_result="$WORK_DIR/pending-publication.json"
  $JQ '.publication' "$PENDING_FILE" >"$staged_result"
  publication_run_id=$($JQ -r '.publicationRunId' "$PENDING_FILE")
  target=$($JQ -c '.publication.upstream' "$PENDING_FILE")

  # Re-resolve official and integration tags, public assets, workflows, and the
  # site on every retry, including Tailnet-only convergence after local apply.
  verify_result "$staged_result" "$target" true

  if [[ -s $PROCESSED_FILE ]] && $JQ -e --slurpfile processed "$PROCESSED_FILE" '
    .publication.upstream == $processed[0].upstream and
    .publication.integration == $processed[0].integration and
    .publication.t4 == $processed[0].t4 and
    $processed[0].publicVerification == "complete" and
    $processed[0].localDeployment.status == "complete"
  ' "$PENDING_FILE" >/dev/null 2>&1 && local_state_matches_processed; then
    clear_local_applied
    clear_pending
    rm -f -- "$staged_result"
    cleanup_processed_workspace "$publication_run_id" \
      || log "WARNING: processed state is durable, but its successful Sol workspace could not be removed."
    log "Cleared a pending publication that was already fully processed."
    return 0
  fi

  if [[ -e $LOCAL_APPLIED_FILE ]]; then
    local_applied_matches_pending \
      || fail "local-applied state does not match the pending publication: $LOCAL_APPLIED_FILE"
    if local_state_matches_record "$LOCAL_APPLIED_FILE"; then
      if tailnet_gateway_is_healthy "$LOCAL_APPLIED_FILE"; then
        finalize_local_applied
        log "Tailnet HTTPS proof converged; processed state is now durable."
      else
        report_tailnet_unreachable_once
      fi
      rm -f -- "$staged_result"
      return 0
    fi
    log "Locally applied T4 state drifted before Tailnet proof; redeploying the exact pending publication."
    clear_local_applied
  fi

  retry_id="local-$("$DATE" -u +%Y%m%dT%H%M%SZ)-$$"
  run_dir="$RUNS_DIR/$retry_id"
  result_file="$run_dir/result.json"
  receipt_file="$run_dir/local-deployment.json"
  mkdir -p -- "$run_dir/local-work"
  chmod 700 "$run_dir" "$run_dir/local-work"
  $JQ '.' "$staged_result" >"$result_file"
  rm -f -- "$staged_result"
  log "Deploying publicly verified T4 $($JQ -r '.t4.tag' "$result_file") to this workstation."
  "$LOCAL_DEPLOY" "$result_file" "$receipt_file" "$run_dir/local-work" 9>&-
  [[ -s $receipt_file ]] || fail "local deployment completed without a receipt"
  local_receipt_is_valid "$receipt_file" "$result_file" || fail "local deployment receipt is invalid"
  record_local_applied "$result_file" "$publication_run_id" "$receipt_file"
  local_state_matches_record "$LOCAL_APPLIED_FILE" \
    || fail "local deployment receipt did not independently match the live workstation"
  if tailnet_gateway_is_healthy "$LOCAL_APPLIED_FILE"; then
    finalize_local_applied
    log "Local deployment and Tailnet HTTPS proof are complete for $($JQ -r '.t4.tag' "$result_file"); processed state is now durable."
  else
    report_tailnet_unreachable_once
  fi
}

public_metadata_is_compatible() {
  local matrix=$1 target=$2 package_version=$3
  $JQ -e --argjson target "$target" --arg version "$package_version" '
    .verifiedRuntime.upstreamTag == $target.tag and
    .verifiedRuntime.upstreamCommit == $target.commit and
    .desktop.version == $version and
    (.verifiedRuntime.sourceTag | test("^t4code-" + ($target.tag | ltrimstr("v")) + "-appserver-[1-9][0-9]*$")) and
    (.verifiedRuntime.sourceCommit | test("^[0-9a-f]{40}$"))
  ' <<<"$matrix" >/dev/null
}

adopt_publication() {
  local target=$1 matrix=$2 package_version=$3 t4_tag=$4 t4_commit=$5 source_label=$6
  local result_file run_id run_dir upstream_tag
  upstream_tag=$($JQ -r '.tag' <<<"$target")
  if processed_matches "$target" && $JQ -e --arg tag "$t4_tag" --arg commit "$t4_commit" '
    .t4.tag == $tag and .t4.commit == $commit
  ' "$PROCESSED_FILE" >/dev/null; then
    log "$source_label $t4_tag and its exact local deployment are already fully processed."
    return 0
  fi

  run_id="adopt-${t4_tag}-$("$DATE" -u +%Y%m%dT%H%M%SZ)"
  run_dir="$RUNS_DIR/$run_id"
  result_file="$run_dir/result.json"
  mkdir -p -- "$run_dir"
  chmod 700 "$run_dir"
  $JQ -n \
    --argjson upstream "$target" \
    --arg integration_tag "$($JQ -r '.verifiedRuntime.sourceTag' <<<"$matrix")" \
    --arg integration_commit "$($JQ -r '.verifiedRuntime.sourceCommit' <<<"$matrix")" \
    --arg version "$package_version" \
    --arg t4_tag "$t4_tag" \
    --arg t4_commit "$t4_commit" \
    --arg release_url "https://github.com/$T4_REPOSITORY/releases/tag/$t4_tag" \
    --arg site_url "$T4_SITE" '
      {
        upstream: $upstream,
        integration: {tag: $integration_tag, commit: $integration_commit},
        t4: {version: $version, tag: $t4_tag, commit: $t4_commit},
        release: {url: $release_url},
        site: {url: $site_url, releaseTag: $t4_tag}
      }
    ' >"$result_file"
  verify_result "$result_file" "$target"
  record_pending "$result_file" "$run_id"
  deploy_pending_publication
  if [[ -s $PENDING_FILE ]]; then
    log "$source_label $t4_tag is locally applied and awaits independent Tailnet HTTPS proof."
  else
    log "Adopted $source_label $t4_tag for official OMP $upstream_tag."
  fi
}

adopt_current_public_release() {
  local allow_incompatible=${1:-false}
  local target release_json matrix package_json package_version t4_tag t4_commit
  local tagged_commit tagged_matrix tagged_version main_commit

  target=$(latest_stable_release)

  # Inspect main before the latest release. A compatible main commit means a
  # publication is already in flight; wait for its immutable public surfaces
  # instead of asking Sol to start a duplicate compatibility release.
  package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/package.json?ref=main")
  matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=main")
  package_version=$(printf '%s' "$package_json" | $JQ -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))') \
    || fail "T4 main has an invalid package version"
  if public_metadata_is_compatible "$matrix" "$target" "$package_version"; then
    t4_tag="v$package_version"
    main_commit=$(resolve_public_commit "$T4_REPOSITORY" main)
    [[ $main_commit =~ ^[0-9a-f]{40}$ ]] || fail "T4 main did not resolve to a commit"
    if tagged_commit=$(resolve_public_commit "$T4_REPOSITORY" "$t4_tag" 2>/dev/null); then
      [[ $tagged_commit =~ ^[0-9a-f]{40}$ ]] || fail "the in-flight T4 tag did not resolve to a commit"
      package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/package.json?ref=$t4_tag")
      tagged_matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=$t4_tag")
      tagged_version=$(printf '%s' "$package_json" | $JQ -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))') \
        || fail "the in-flight T4 tag has an invalid package version"
      if [[ $tagged_version == "$package_version" ]] \
        && public_metadata_is_compatible "$tagged_matrix" "$target" "$tagged_version" \
        && publication_workflows_active_or_recent "$tagged_commit" "$t4_tag"; then
        log "T4 publication workflows are active or recently successful for $t4_tag; waiting for public convergence."
        adopt_publication "$target" "$tagged_matrix" "$tagged_version" "$t4_tag" "$tagged_commit" "In-flight"
        return 0
      fi
      RESUME_PUBLICATION_JSON=$($JQ -cn \
        --arg reason "tagged-publication-terminal-or-stale" \
        --arg main_commit "$main_commit" \
        --arg version "$package_version" \
        --arg tag "$t4_tag" \
        --argjson matrix "$matrix" '
          {reason: $reason, mainCommit: $main_commit, version: $version, tag: $tag, matrix: $matrix}
        ')
    else
      RESUME_PUBLICATION_JSON=$($JQ -cn \
        --arg reason "compatible-main-without-tag" \
        --arg main_commit "$main_commit" \
        --arg version "$package_version" \
        --arg tag "$t4_tag" \
        --argjson matrix "$matrix" '
          {reason: $reason, mainCommit: $main_commit, version: $version, tag: $tag, matrix: $matrix}
        ')
    fi
  fi

  if [[ $RESUME_PUBLICATION_JSON != null ]]; then
    if [[ $allow_incompatible == true ]]; then
      log "Compatible T4 main work is ready for completion through the positive Sol release workflow."
      return 0
    fi
    fail "compatible T4 main work is ready for publication completion"
  fi

  release_json=$($GH api "repos/$T4_REPOSITORY/releases/latest")
  t4_tag=$(printf '%s' "$release_json" | $JQ -er '
    select(.draft == false and .prerelease == false)
    | .tag_name
    | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))
  ') || fail "the latest public T4 release is not a stable semantic-version tag"
  package_json=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/package.json?ref=$t4_tag")
  matrix=$($GH api -H 'Accept: application/vnd.github.raw+json' "repos/$T4_REPOSITORY/contents/compat/omp-app-matrix.json?ref=$t4_tag")
  package_version=$(printf '%s' "$package_json" | $JQ -er '.version | select(test("^[0-9]+\\.[0-9]+\\.[0-9]+$"))') \
    || fail "the latest public T4 package version is invalid"
  [[ $t4_tag == "v$package_version" ]] || fail "the latest T4 release tag and tagged package version disagree"
  if public_metadata_is_compatible "$matrix" "$target" "$package_version"; then
    t4_commit=$(resolve_public_commit "$T4_REPOSITORY" "$t4_tag")
    [[ $t4_commit =~ ^[0-9a-f]{40}$ ]] || fail "the public T4 tag did not resolve to a commit"
    if publication_workflows_succeeded "$t4_commit" "$t4_tag" \
      || publication_workflows_active_or_recent "$t4_commit" "$t4_tag"; then
      adopt_publication "$target" "$matrix" "$package_version" "$t4_tag" "$t4_commit" "Public"
      return 0
    fi
  fi

  if [[ $allow_incompatible == true ]]; then
    log "No current or active T4 publication targets $($JQ -r '.tag' <<<"$target"); starting the positive Sol release workflow."
    return 0
  fi

  fail "neither T4 main nor the latest public release matches the latest stable official OMP release"
}

marker_is_owned_regular_file() {
  local marker=$1 owner file_type mode
  [[ -f $marker && ! -L $marker ]] || return 1
  file_type=$("$STAT" -c '%F' -- "$marker" 2>/dev/null) \
    || file_type=$("$STAT" -f '%HT' "$marker" 2>/dev/null) \
    || return 1
  [[ $file_type == "regular file" || $file_type == "Regular File" ]] || return 1
  owner=$("$STAT" -c '%u' -- "$marker" 2>/dev/null) \
    || owner=$("$STAT" -f '%u' "$marker" 2>/dev/null) \
    || return 1
  [[ $owner == "$EUID" ]] || return 1
  mode=$("$STAT" -c '%a' -- "$marker" 2>/dev/null) \
    || mode=$("$STAT" -f '%Lp' "$marker" 2>/dev/null) \
    || return 1
  [[ $mode == 600 || $mode == 0600 ]]
}

critical_t4_pr_is_open() {
  local prs=$1 number=$2 files release_declared critical_file
  if "$JQ" -e --argjson number "$number" '
    any(.[]; .number == $number and .draft == false
      and (([.title] + (.labels | map(.name // "")))
        | any(test("(^|[^[:alnum:]])(release|publish|version|cutover|deploy)([^[:alnum:]]|$)"; "i"))))
  ' <<<"$prs" >/dev/null 2>&1; then
    release_declared=true
  else
    release_declared=false
  fi
  files=$("$GH" api "repos/$T4_REPOSITORY/pulls/$number/files?per_page=100") || return 1
  "$JQ" -e 'type == "array" and all(.[]; .filename | type == "string") and length < 100' \
    <<<"$files" >/dev/null 2>&1 || return 1
  critical_file=$("$JQ" -r '
    first(.[] | .filename
      | select(test("^(apps/|packages/|ops/t4-maintainer/|scripts/t4-maintainer|\\.github/workflows/(release|ci))|(^|/)(release|version|package)([^/]*)$|(^|/)package\\.json$"; "i")))
    // empty
  ' <<<"$files")
  [[ $release_declared == true || -n $critical_file ]]
}

t4_pr_classification_is_incomplete() {
  local prs number files release_declared critical_file
  prs=$("$GH" api "repos/$T4_REPOSITORY/pulls?state=open&base=main&per_page=100") || return 0
  "$JQ" -e '
    type == "array" and length < 100
    and all(.[];
      (.number | type == "number")
      and (.draft | type == "boolean")
      and (.title | type == "string")
      and (.labels | type == "array")
      and all(.labels[]; .name | type == "string"))
  ' <<<"$prs" >/dev/null 2>&1 || return 0
  while read -r number; do
    [[ -n $number ]] || continue
    if "$JQ" -e --argjson number "$number" '
      any(.[]; .number == $number and .draft == false
        and (([.title] + (.labels | map(.name // "")))
          | any(test("(^|[^[:alnum:]])(release|publish|version|cutover|deploy)([^[:alnum:]]|$)"; "i"))))
    ' <<<"$prs" >/dev/null 2>&1; then
      release_declared=true
    else
      release_declared=false
    fi
    files=$("$GH" api "repos/$T4_REPOSITORY/pulls/$number/files?per_page=100") || return 0
    "$JQ" -e 'type == "array" and all(.[]; .filename | type == "string") and length < 100' \
      <<<"$files" >/dev/null 2>&1 || return 0
    critical_file=$("$JQ" -r '
      first(.[] | .filename
        | select(test("^(apps/|packages/|ops/t4-maintainer/|scripts/t4-maintainer|\\.github/workflows/(release|ci))|(^|/)(release|version|package)([^/]*)$|(^|/)package\\.json$"; "i")))
      // empty
    ' <<<"$files")
    [[ $release_declared != true && -z $critical_file ]] || return 1
  done < <("$JQ" -r '.[] | select(.draft == false) | .number' <<<"$prs")
  return 1
}

validate_deferral_marker() {
  local marker=$1 marker_json reason expected observed pr_number current validation_status prs
  VALIDATED_DEFERRAL_REASON=
  VALIDATED_DEFERRAL_PR_NUMBER=
  VALIDATED_DEFERRAL_OBSERVED_SHA=
  marker_is_owned_regular_file "$marker" || return 1
  [[ $(wc -c <"$marker") -le 2048 ]] || return 1
  marker_json=$("$JQ" -ce '
    select(
      type == "object"
      and (keys_unsorted | sort == ["expectedT4MainSha","observedT4MainSha","prNumber","reason","schemaVersion"])
      and .schemaVersion == 1
      and (.reason == "t4-main-changed"
        or .reason == "release-critical-pr"
        or .reason == "classification-incomplete")
      and (.expectedT4MainSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.observedT4MainSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.prNumber == null or (.prNumber | type == "number" and floor == . and . >= 1 and . <= 1000000))
      and ((.reason == "t4-main-changed" and .prNumber == null)
        or (.reason == "release-critical-pr" and (.prNumber | type == "number"))
        or (.reason == "classification-incomplete" and .prNumber == null))
    )
  ' "$marker" 2>/dev/null) || return 1
  reason=$("$JQ" -r '.reason' <<<"$marker_json")
  expected=$("$JQ" -r '.expectedT4MainSha' <<<"$marker_json")
  observed=$("$JQ" -r '.observedT4MainSha' <<<"$marker_json")
  pr_number=$("$JQ" -r '.prNumber // empty' <<<"$marker_json")
  current=$(t4_main_identity) || return 1
  [[ $current == "$observed" ]] || return 1
  case $reason in
    t4-main-changed)
      [[ -n $T4_MAIN_SOL_SHA && $expected == "$T4_MAIN_SOL_SHA" && $observed != "$expected" ]]
      ;;
    release-critical-pr)
      [[ $expected == "$observed" && -n $pr_number ]] || return 1
      prs=$("$GH" api "repos/$T4_REPOSITORY/pulls?state=open&base=main&per_page=100") || return 1
      "$JQ" -e '
        type == "array" and length < 100
        and all(.[];
          (.number | type == "number")
          and (.draft | type == "boolean")
          and (.title | type == "string")
          and (.labels | type == "array")
          and all(.labels[]; .name | type == "string"))
      ' <<<"$prs" >/dev/null 2>&1 || return 1
      "$JQ" -e --argjson number "$pr_number" 'any(.[]; .number == $number and .draft == false)' \
        <<<"$prs" >/dev/null 2>&1 || return 1
      critical_t4_pr_is_open "$prs" "$pr_number"
      ;;
    classification-incomplete)
      [[ $expected == "$observed" && -z $pr_number ]] || return 1
      t4_pr_classification_is_incomplete
      ;;
    *) return 1 ;;
  esac
  validation_status=$?
  ((validation_status == 0)) || return "$validation_status"
  VALIDATED_DEFERRAL_REASON=$reason
  VALIDATED_DEFERRAL_PR_NUMBER=$pr_number
  VALIDATED_DEFERRAL_OBSERVED_SHA=$observed
}

handle_valid_deferral() {
  local marker=$1 reason=$VALIDATED_DEFERRAL_REASON blocker_key
  case $reason in
    t4-main-changed)
      blocker_key=t4-main-race
      ;;
    release-critical-pr)
      blocker_key="t4-pr-$VALIDATED_DEFERRAL_PR_NUMBER"
      ;;
    classification-incomplete)
      blocker_key="t4-classification-$VALIDATED_DEFERRAL_OBSERVED_SHA"
      ;;
    *)
      return 1
      ;;
  esac
  notify_blocker_once collaborator_defer publication "$blocker_key" \
    "Sol deferred publication after the mandatory final T4 guard ($reason)." || true
  log "Valid collaborator deferral marker accepted ($reason); preserving run files at $(dirname -- "$marker") and leaving publication state unchanged."
}

invoke_sol() {
  case $HOST_PLATFORM in
    Linux)
      "$SETPRIV" --no-new-privs -- "$OMP" "$@"
      ;;
    Darwin)
      "$OMP" "$@"
      ;;
    *)
      fail "unsupported maintainer host platform: $HOST_PLATFORM"
      ;;
  esac
}

validate_platform_probe() {
  local canonical_uname
  if [[ ${T4_MAINTAINER_UNAME+x} == x ]]; then
    [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 \
      && ( ${canonical_maintainer_root:-} == /tmp/* || ${canonical_maintainer_root:-} == /private/tmp/* ) ]] \
      || fail "platform probe override is restricted to an explicit temporary test root"
    canonical_uname=$("$REALPATH" -e -- "$UNAME") \
      || fail "test platform probe must exist and be canonical"
    [[ $canonical_uname == "$canonical_maintainer_root"/* && -x $canonical_uname ]] \
      || fail "test platform probe must remain inside the canonical temporary maintainer root"
  fi
  require_command "$UNAME"
  HOST_PLATFORM=$("$UNAME" -s) || fail "maintainer host platform could not be determined"
  [[ $HOST_PLATFORM == Linux || $HOST_PLATFORM == Darwin ]] \
    || fail "unsupported maintainer host platform: $HOST_PLATFORM"
}

validate_privilege_runner() {
  [[ $HOST_PLATFORM == Linux ]] || return 0
  if [[ ${T4_MAINTAINER_SETPRIV+x} == x ]]; then
    [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 \
      && ( ${canonical_maintainer_root:-} == /tmp/* || ${canonical_maintainer_root:-} == /private/tmp/* ) ]] \
      || fail "privilege runner override is restricted to an explicit temporary test root"
    local canonical_setpriv
    canonical_setpriv=$("$REALPATH" -e -- "$SETPRIV") \
      || fail "test privilege runner must exist and be canonical"
    [[ $canonical_setpriv == "$canonical_maintainer_root"/* && -x $canonical_setpriv ]] \
      || fail "test privilege runner must remain inside the canonical temporary maintainer root"
  fi
  require_command "$SETPRIV"
}

preflight_privilege_runner() {
  validate_platform_probe
  validate_privilege_runner
}

run_live_maintenance() {
  local target upstream_tag upstream_commit run_id run_dir workspace context_file result_file deferral_file
  local omp_status release_instruction
  local marker_present result_present

  target=$(latest_stable_release)
  upstream_tag=$($JQ -r '.tag' <<<"$target")
  upstream_commit=$($JQ -r '.commit' <<<"$target")
  CURRENT_STAGE=publication
  CURRENT_VERSION=${upstream_tag#v}
  CURRENT_TAG=$upstream_tag
  CURRENT_COMMIT=$upstream_commit
  if processed_metadata_matches "$target" && local_state_matches_processed; then
    verify_result "$PROCESSED_FILE" "$target" true
    log "Latest stable official OMP release $upstream_tag ($upstream_commit) is already publicly processed."
    return 0
  fi

  publication_gate || {
    local gate_status=$?
    ((gate_status == 10)) && return 0
    return "$gate_status"
  }
  revalidate_t4_main_before_publication

  run_id="${upstream_tag#v}-$("$DATE" -u +%Y%m%dT%H%M%SZ)"
  RUN_ID=$run_id
  run_dir="$RUNS_DIR/$run_id"
  workspace="$run_dir/workspace"
  context_file="$run_dir/context.json"
  result_file="$run_dir/result.json"
  deferral_file="$run_dir/deferral.json"
  CURRENT_RESULT_FILE=$result_file
  mkdir -p -- "$workspace"
  chmod 700 "$run_dir" "$workspace"
  rm -f -- "$result_file" "$deferral_file"


  release_instruction="Publish T4 Code for official OMP $upstream_tag at $upstream_commit. Reuse and complete any compatible main commit, version, or tag already present. Use the wrapper-owned atomic publisher for the OMP base tag, product branch, and annotated integration tag."
  if [[ $RESUME_PUBLICATION_JSON != null ]]; then
    release_instruction="Continue and complete the compatible T4 publication for official OMP $upstream_tag at $upstream_commit, reusing its existing main commit, version, and tag where valid."
  fi
  log "Starting the live T4 publication for official OMP $upstream_tag ($upstream_commit)."
  CURRENT_STAGE=sol
  publication_gate || {
    local gate_status=$?
    rm -f -- "$context_file" || true
    ((gate_status == 10)) && return 0
    return "$gate_status"
  }
  revalidate_t4_main_before_publication
  $JQ -n \
    --arg detected_at "$(timestamp)" \
    --argjson upstream "$target" \
    --arg workspace "$workspace" \
    --arg result_file "$result_file" \
    --arg deferral_file "$deferral_file" \
    --arg omp_upstream "$OMP_UPSTREAM_REPOSITORY" \
    --arg omp_integration "$OMP_INTEGRATION_REPOSITORY" \
    --arg omp_product_branch "$OMP_PRODUCT_BRANCH" \
    --arg atomic_publish_helper "$ATOMIC_PUBLISH" \
    --arg atomic_state_dir "$ATOMIC_PUBLICATION_STATE_DIR" \
    --arg t4 "$T4_REPOSITORY" \
    --arg site "$T4_SITE" \
    --arg t4_main_sha "$T4_MAIN_GATE_SHA" \
    --argjson resumable_publication "$RESUME_PUBLICATION_JSON" \
    --slurpfile previous <(if [[ -s $PROCESSED_FILE ]]; then cat "$PROCESSED_FILE"; else printf 'null\n'; fi) \
    '{
      detectedAt: $detected_at,
      upstream: $upstream,
      repositories: {
        officialOmp: $omp_upstream,
        integrationOmp: $omp_integration,
        integrationProductBranch: $omp_product_branch,
        t4: $t4
      },
      t4MainSha: $t4_main_sha,
      site: $site,
      atomicPublisher: {
        helper: $atomic_publish_helper,
        stateDirectory: $atomic_state_dir,
        requiredRefs: [
          "exact official base tag",
          "t4code/main",
          "annotated integration tag"
        ]
      },
      workspace: $workspace,
      resultFile: $result_file,
      deferralFile: $deferral_file,
      resumablePublication: $resumable_publication,
      previousProcessed: $previous[0]
    }' >"$context_file"
  notify_event actionable_work_start sol || true
  set +e
  T4_MAINTENANCE_CONTEXT="$context_file" \
  T4_MAINTENANCE_RESULT="$result_file" \
  T4_MAINTENANCE_DEFERRAL_FILE="$deferral_file" \
  T4_MAINTENANCE_WORKSPACE="$workspace" \
  T4_MAINTENANCE_UPSTREAM_TAG="$upstream_tag" \
  T4_MAINTENANCE_UPSTREAM_COMMIT="$upstream_commit" \
  T4_ATOMIC_PUBLISH_HELPER="$ATOMIC_PUBLISH" \
  T4_ATOMIC_STATE_DIR="$ATOMIC_PUBLICATION_STATE_DIR" \
  T4_ATOMIC_EXPECTED_UPSTREAM_TAG="$upstream_tag" \
  T4_ATOMIC_EXPECTED_UPSTREAM_COMMIT="$upstream_commit" \
    invoke_sol \
      --profile t4-maintainer \
      --cwd "$workspace" \
      --model openai-codex/gpt-5.6-sol \
      --thinking max \
      --print \
      --mode json \
      --approval-mode yolo \
      "@$PROMPT_FILE" \
      "$release_instruction The run context is $context_file, the verified result belongs at $result_file, and any valid final-guard deferral marker belongs at $deferral_file." \
      9>&- \
      >"$run_dir/omp.jsonl" 2>"$run_dir/omp.stderr.log"
  omp_status=$?
  set -e
  marker_present=false
  result_present=false
  [[ -e $deferral_file || -L $deferral_file ]] && marker_present=true
  [[ -e $result_file || -L $result_file ]] && result_present=true
  if [[ $marker_present == true && $result_present == true ]]; then
    fail "Sol produced both a result and a deferral marker; run files are retained at $run_dir"
  fi
  if ((omp_status != 0)); then
    fail "the Sol maintainer exited with status $omp_status; run files are retained at $run_dir"
  fi
  if [[ $marker_present == true ]]; then
    validate_deferral_marker "$deferral_file" \
      || fail "Sol produced an invalid or uncorroborated deferral marker; run files are retained at $run_dir"
    handle_valid_deferral "$deferral_file"
    return 0
  fi
  [[ $result_present == true ]] \
    || fail "Sol exited successfully without a verified result or valid deferral marker; run files are retained at $run_dir"

  verify_result "$result_file" "$target"
  record_pending "$result_file" "$run_id"
  CURRENT_STAGE=publication
  notify_event sol_publication_success publication || true
  deploy_pending_publication
  if [[ -s $PENDING_FILE ]]; then
    CURRENT_STAGE=local-deploy
    notify_blocker_once local_deploy_defer local-deploy "tailnet-$CURRENT_TAG" \
      "local deployment is complete but Tailnet HTTPS proof remains pending" || true
    log "Live publication and exact local deployment are complete for $upstream_tag; independent Tailnet HTTPS proof remains pending."
  else
    CURRENT_STAGE=local-deploy
    notify_event local_deploy_success local-deploy || true
    log "Live publication and local deployment are complete for $upstream_tag; processed state now points to $($JQ -r '.t4.tag' "$result_file")."
  fi
}
validate_absolute_roots() {
  [[ $MAINTAINER_ROOT == /* && $DEPLOYMENTS_DIR == /* && $ATOMIC_PUBLICATION_STATE_DIR == /* ]] \
    || fail "maintainer state roots must be absolute paths"
  canonical_maintainer_root=$("$REALPATH" -e -- "$MAINTAINER_ROOT") \
    || fail "maintainer root must exist and be canonicalized"
  [[ $canonical_maintainer_root == "$MAINTAINER_ROOT" ]] \
    || fail "maintainer root must be canonical"
  if [[ $PROC_ROOT != /proc ]]; then
    [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 \
      && ($canonical_maintainer_root == /tmp/* || $canonical_maintainer_root == /private/tmp/*) ]] \
      || fail "process-root override is restricted to an explicit temporary test root"
    canonical_proc_root=$("$REALPATH" -e -- "$PROC_ROOT") \
      || fail "test process root must exist and be canonical"
    [[ $canonical_proc_root == "$PROC_ROOT" ]] \
      || fail "test process root must be canonical"
    [[ $canonical_proc_root == "$canonical_maintainer_root"/* ]] \
      || fail "test process root must be a child of the maintainer root"
  fi
}

main() {
  validate_absolute_roots
  require_date_command
  require_command flock
  require_command "$GH"
  require_command "$CURL"
  require_command "$JQ"
  require_command "$OMP"
  require_command "$SHA256SUM"
  require_command "$SYSTEMCTL"
  require_command "$DPKG_QUERY"
  require_command "$DPKG"
  require_command "$GIT"
  require_command "$NODE"
  require_command "$REALPATH"
  require_command "$SYNC"
  require_command "$SLEEP"
  require_command "$STAT"
  require_command wc
  require_command awk
  require_command dirname
  require_command find
  require_command grep
  require_command rm
  require_command sed
  require_command sort
  require_command "$LOCAL_DEPLOY"
  require_command "$ATOMIC_PUBLISH"
  [[ -r $PROMPT_FILE ]] || fail "maintainer prompt is unavailable: $PROMPT_FILE"
  preflight_privilege_runner
  prepare_directories
  acquire_lock
  sync_fork_main
  [[ ! -e $BLOCKED_FILE ]] || fail "maintainer is blocked by an unfinished or incompletely rolled-back deployment; reconcile $BLOCKED_FILE before retrying"
  cleanup_unreferenced_local_work
  cleanup_unreferenced_deployments
  cleanup_durable_processed_workspace \
    || log "WARNING: the previous successful Sol workspace could not be removed."

  case ${1:-run} in
    run)
      deploy_pending_publication
      if [[ -s $PENDING_FILE ]]; then
        log "An exact verified publication remains pending; this run will not invoke Sol."
        return 0
      fi
      if finish_verified_processed_noop; then
        return 0
      fi
      requeue_processed_publication
      deploy_pending_publication
      if [[ -s $PENDING_FILE ]]; then
        log "Local repair remains pending; this run will not invoke Sol."
        return 0
      fi
      adopt_current_public_release true
      if [[ -s $PENDING_FILE ]]; then
        log "A current or in-flight public release remains pending; this run will not invoke Sol."
        return 0
      fi
      run_live_maintenance
      ;;
    --adopt-current)
      deploy_pending_publication
      [[ ! -s $PENDING_FILE ]] || return 0
      adopt_current_public_release
      ;;
    --adopt-current-if-compatible)
      deploy_pending_publication
      [[ ! -s $PENDING_FILE ]] || return 0
      adopt_current_public_release true
      ;;
    *)
      fail "usage: $0 [--adopt-current|--adopt-current-if-compatible]"
      ;;
  esac
}

main "$@"
