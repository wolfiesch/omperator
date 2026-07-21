#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

[[ $# -eq 3 ]] || {
  printf 'usage: %s RESULT_JSON RECEIPT_JSON WORK_DIRECTORY\n' "$0" >&2
  exit 2
}

RESULT_FILE=$1
RECEIPT_FILE=$2
WORK_DIR=$3

GH=${T4_MAINTAINER_GH:-gh}
CURL=${T4_MAINTAINER_CURL:-curl}
JQ=${T4_MAINTAINER_JQ:-jq}
GIT=${T4_MAINTAINER_GIT:-git}
BUN=${T4_MAINTAINER_BUN:-bun}
PNPM=${T4_MAINTAINER_PNPM:-pnpm}
NODE=${T4_MAINTAINER_NODE:-node}
SUDO=${T4_MAINTAINER_SUDO:-sudo}
APT_GET=${T4_MAINTAINER_APT_GET:-apt-get}
DPKG_QUERY=${T4_MAINTAINER_DPKG_QUERY:-dpkg-query}
DPKG=${T4_MAINTAINER_DPKG:-dpkg}
DPKG_DEB=${T4_MAINTAINER_DPKG_DEB:-dpkg-deb}
SHA256SUM=${T4_MAINTAINER_SHA256SUM:-sha256sum}
SYSTEMCTL=${T4_MAINTAINER_SYSTEMCTL:-systemctl}
INSTALL=${T4_MAINTAINER_INSTALL:-install}
SYNC=${T4_MAINTAINER_SYNC:-/bin/sync}
DATE=${T4_MAINTAINER_DATE:-/bin/date}
REALPATH=${T4_MAINTAINER_REALPATH:-realpath}
UNAME=${T4_MAINTAINER_UNAME:-uname}
PROC_ROOT=${T4_MAINTAINER_TEST_PROC_ROOT:-/proc}

OMP_INTEGRATION_REPOSITORY=${T4_LOCAL_OMP_REPOSITORY:-https://github.com/lyc-aon/oh-my-pi.git}
OMP_UPSTREAM_REPOSITORY=${T4_LOCAL_OMP_UPSTREAM_REPOSITORY:-https://github.com/can1357/oh-my-pi.git}
OMP_INTEGRATION_SLUG=${T4_LOCAL_OMP_REPOSITORY_SLUG:-lyc-aon/oh-my-pi}
OMP_UPSTREAM_SLUG=${T4_LOCAL_OMP_UPSTREAM_REPOSITORY_SLUG:-can1357/oh-my-pi}
OMP_PRODUCT_BRANCH=t4code/main
T4_REPOSITORY=${T4_LOCAL_T4_REPOSITORY:-LycaonLLC/t4-code}
T4_CLONE_URL=${T4_LOCAL_T4_CLONE_URL:-https://github.com/LycaonLLC/t4-code.git}
OMP_TARGET=${T4_LOCAL_OMP_TARGET:-$HOME/bin/omp}
OMP_SERVICE=${T4_LOCAL_OMP_SERVICE:-dev.oh-my-pi.appserver.service}
OMP_SOCKET=${T4_LOCAL_OMP_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omp/appserver.sock}
T4_PACKAGE=${T4_LOCAL_T4_PACKAGE:-t4-code}
T4_EXECUTABLE=${T4_LOCAL_T4_EXECUTABLE:-/opt/T4 Code/t4-code}
T4_INSTALLED_WEB_ROOT=${T4_LOCAL_T4_WEB_ROOT:-/opt/T4 Code/resources/web}
T4_APP_ASAR=${T4_LOCAL_T4_APP_ASAR:-/opt/T4 Code/resources/app.asar}
GATEWAY_SERVICE=${T4_LOCAL_GATEWAY_SERVICE:-com.lycaonsolutions.t4code.tailnet-gateway.service}
GATEWAY_CONFIG=${T4_LOCAL_GATEWAY_CONFIG:-$HOME/.config/t4-code/tailnet-gateway.json}
GATEWAY_UNIT=${T4_LOCAL_GATEWAY_UNIT:-$HOME/.config/systemd/user/$GATEWAY_SERVICE}
MAINTAINER_ROOT=${T4_MAINTAINER_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/t4-maintainer}
DEPLOYMENTS_DIR=${T4_LOCAL_DEPLOYMENTS_DIR:-$MAINTAINER_ROOT/deployments}
BLOCKED_FILE=${T4_LOCAL_BLOCKED_FILE:-$MAINTAINER_ROOT/state/deployment-blocked.json}
ROLLBACK_RECEIPT=${T4_LOCAL_ROLLBACK_RECEIPT:-$MAINTAINER_ROOT/state/operator-overlay.json}
HEALTH_ATTEMPTS=${T4_LOCAL_HEALTH_ATTEMPTS:-60}
HEALTH_INTERVAL_SECONDS=${T4_LOCAL_HEALTH_INTERVAL_SECONDS:-1}
MAIN_MIRROR_ATTEMPTS=${T4_LOCAL_MAIN_MIRROR_ATTEMPTS:-5}
MAIN_MIRROR_INTERVAL_SECONDS=${T4_LOCAL_MAIN_MIRROR_INTERVAL_SECONDS:-3}

BACKUP_DIR="$WORK_DIR/rollback"
DOWNLOAD_DIR="$WORK_DIR/downloads"
OMP_SOURCE="$WORK_DIR/omp-source"
T4_BUILD_ROOT="$WORK_DIR/t4-source"
T4_RUNTIME_ROOT=""
PREVIOUS_DEB=""
PREVIOUS_T4_VERSION=""
PREVIOUS_OMP_SHA=""
PREVIOUS_OMP_VERSION=""
OVERLAY_PACKAGE_SIZE=""
OVERLAY_PACKAGE_SHA=""
OVERLAY_APP_ASAR_SHA=""
PREVIOUS_OMP_MODE=""
PREVIOUS_GATEWAY_SOURCE=""
PREVIOUS_APP_ACTIVE=false
PREVIOUS_GATEWAY_ACTIVE=false
PREVIOUS_GATEWAY_ENABLEMENT=""
GATEWAY_SCRIPT_SHA=""
GATEWAY_WEB_TREE_SHA=""
GATEWAY_WS_TREE_SHA=""
GATEWAY_CONFIG_SHA=""
GATEWAY_UNIT_SHA=""
MUTATION_STARTED=false
OMP_MUTATED=false
T4_MUTATED=false
GATEWAY_MUTATED=false
APP_DRAINED=false
GATEWAY_EXPOSURE_ATTEMPTED=false
APP_EXPOSURE_ATTEMPTED=false
APP_HOST_ID=""
APP_EPOCH=""
DEPLOYMENT_IDENTITY=""

timestamp() {
  "$DATE" -u +'%Y-%m-%dT%H:%M:%SZ'
}

log() {
  printf '%s %s\n' "$(timestamp)" "$*"
}

fail() {
  log "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_regular_file() {
  [[ -f $1 && ! -L $1 ]] || fail "$2 is missing or unsafe: $1"
}

require_positive_integer() {
  [[ $2 =~ ^[1-9][0-9]*$ ]] || fail "$1 must be a positive integer"
}

require_noninteractive_privilege() {
  "$SUDO" -n true >/dev/null 2>&1 \
    || fail "non-interactive sudo is unavailable; retaining the pending publication without staging or mutation"
}

service_is_active() {
  "$SYSTEMCTL" --user is-active --quiet "$1"
}

gateway_is_disabled() {
  local enablement
  enablement=$("$SYSTEMCTL" --user is-enabled "$GATEWAY_SERVICE" 2>/dev/null || true)
  [[ $enablement == disabled ]]
}

read_profile_route_config() {
  local config=$1
  "$JQ" -cer '
    if has("profileRoutes") then
      select((.profileRoutes | type) == "array" and (.startProfiles | type) == "boolean")
      | {profileRoutes, startProfiles}
    else
      select(has("startProfiles") | not)
      | {}
    end
  ' "$config"
}

stop_gateway_durably() {
  "$SYSTEMCTL" --user disable --now "$GATEWAY_SERVICE"
  ! service_is_active "$GATEWAY_SERVICE" && gateway_is_disabled
}

restore_service_state() {
  local service=$1 was_active=$2
  if [[ $was_active == true ]]; then
    "$SYSTEMCTL" --user restart "$service"
  else
    "$SYSTEMCTL" --user stop "$service"
  fi
}

restore_service_enablement() {
  local service=$1 previous_enablement=$2
  case $previous_enablement in
    enabled) "$SYSTEMCTL" --user enable "$service" ;;
    disabled) "$SYSTEMCTL" --user disable "$service" ;;
    *) return 1 ;;
  esac
}

atomic_restore_file() {
  local source=$1 target=$2 mode=$3 temporary
  temporary="${target}.t4-rollback.$$"
  "$INSTALL" -m "$mode" -- "$source" "$temporary"
  mv -f -- "$temporary" "$target"
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

cleanup_prepared_artifacts() {
  rm -rf -- "$OMP_SOURCE" "$T4_BUILD_ROOT" "$WORK_DIR/ws-runtime" "$DOWNLOAD_DIR" "$BACKUP_DIR"
  if [[ -n $T4_RUNTIME_ROOT && $T4_RUNTIME_ROOT == "$DEPLOYMENTS_DIR"/t4-* ]]; then
    rm -rf -- "$T4_RUNTIME_ROOT"
  fi
}

cleanup_success_inputs() {
  rm -rf -- "$OMP_SOURCE" "$T4_BUILD_ROOT" "$WORK_DIR/ws-runtime" "$DOWNLOAD_DIR"
}

deployment_checkpoint() {
  local checkpoint=$1 requested=${T4_MAINTAINER_TEST_FAULT:-}
  [[ $requested != "$checkpoint" ]] || {
    [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 \
      && ($MAINTAINER_ROOT == /tmp/* || $MAINTAINER_ROOT == /private/tmp/*) ]] \
      || fail "deployment fault injection is restricted to an explicit temporary test root"
    fail "injected deployment fault at $checkpoint"
  }
}

write_transaction_marker() {
  local status=$1 marker_dir temporary
  marker_dir=$(dirname -- "$BLOCKED_FILE")
  mkdir -p -- "$marker_dir" || return 1
  temporary=$(mktemp "$marker_dir/.deployment-blocked.XXXXXX") || return 1
  if ! $JQ -n \
    --arg detected_at "$(timestamp)" \
    --arg status "$status" \
    --arg backup_dir "$BACKUP_DIR" \
    --arg result_file "$RESULT_FILE" \
    --arg runtime_root "$T4_RUNTIME_ROOT" \
    --argjson omp_mutated "$OMP_MUTATED" \
    --argjson t4_mutated "$T4_MUTATED" \
    --argjson gateway_mutated "$GATEWAY_MUTATED" \
    --argjson app_drained "$APP_DRAINED" \
    --argjson app_exposure_attempted "$APP_EXPOSURE_ATTEMPTED" \
    --argjson gateway_exposure_attempted "$GATEWAY_EXPOSURE_ATTEMPTED" '
      {
        schemaVersion: 1,
        status: $status,
        detectedAt: $detected_at,
        publicationResult: $result_file,
        backupDirectory: $backup_dir,
        preparedRuntime: $runtime_root,
        components: {
          omp: $omp_mutated,
          desktop: $t4_mutated,
          gateway: $gateway_mutated,
          appserverDrained: $app_drained,
          appserverExposureAttempted: $app_exposure_attempted,
          gatewayExposureAttempted: $gateway_exposure_attempted
        }
      }
    ' >"$temporary"; then
    rm -f -- "$temporary"
    return 1
  fi
  chmod 600 "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  "$SYNC" -f "$temporary" || {
    rm -f -- "$temporary"
    return 1
  }
  mv -f -- "$temporary" "$BLOCKED_FILE" || {
    rm -f -- "$temporary"
    return 1
  }
  "$SYNC" -f "$marker_dir" || return 1
}

clear_transaction_marker() {
  local marker_dir
  marker_dir=$(dirname -- "$BLOCKED_FILE")
  rm -f -- "$BLOCKED_FILE" || return 1
  "$SYNC" -f "$marker_dir" || return 1
}

rollback() {
  local rollback_failed=false
  local restored_state dpkg_verification
  set +e
  trap - ERR INT TERM
  rm -f -- "$RECEIPT_FILE"
  log "Local deployment failed; restoring the previous workstation state."

  if [[ $GATEWAY_MUTATED == true ]]; then
    "$SYSTEMCTL" --user stop "$GATEWAY_SERVICE" >/dev/null 2>&1 || rollback_failed=true
  fi
  if [[ $OMP_MUTATED == true || $APP_DRAINED == true ]]; then
    "$SYSTEMCTL" --user stop "$OMP_SERVICE" >/dev/null 2>&1 || rollback_failed=true
  fi

  if [[ $T4_MUTATED == true && -n $PREVIOUS_DEB ]]; then
    if [[ -n $OVERLAY_PACKAGE_SHA ]]; then
      if verify_sealed_overlay "$PREVIOUS_DEB"; then
        "$SUDO" -n "$APT_GET" install -y --reinstall --allow-downgrades "$PREVIOUS_DEB" >/dev/null 2>&1 \
          || rollback_failed=true
      else
        rollback_failed=true
      fi
    else
      "$SUDO" -n "$APT_GET" install -y --reinstall --allow-downgrades "$PREVIOUS_DEB" >/dev/null 2>&1 \
        || rollback_failed=true
    fi
  fi
  if [[ $OMP_MUTATED == true ]]; then
    atomic_restore_file "$BACKUP_DIR/omp" "$OMP_TARGET" "$PREVIOUS_OMP_MODE" || rollback_failed=true
  fi
  if [[ $GATEWAY_MUTATED == true ]]; then
    atomic_restore_file "$BACKUP_DIR/tailnet-gateway.json" "$GATEWAY_CONFIG" 0600 || rollback_failed=true
    atomic_restore_file "$BACKUP_DIR/$GATEWAY_SERVICE" "$GATEWAY_UNIT" 0644 || rollback_failed=true
    "$SYNC" -f "$GATEWAY_CONFIG" || rollback_failed=true
    "$SYNC" -f "$(dirname -- "$GATEWAY_CONFIG")" || rollback_failed=true
    "$SYNC" -f "$(dirname -- "$GATEWAY_UNIT")" || rollback_failed=true
    "$SYSTEMCTL" --user daemon-reload || rollback_failed=true
    restore_service_enablement "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ENABLEMENT" || rollback_failed=true
  fi
  "$SYNC" -f "$OMP_TARGET" || rollback_failed=true
  "$SYNC" -f "$(dirname -- "$OMP_TARGET")" || rollback_failed=true
  if [[ $T4_MUTATED == true && -e $T4_EXECUTABLE ]]; then
    "$SYNC" -f "$T4_EXECUTABLE" || rollback_failed=true
  fi

  if [[ $OMP_MUTATED == true || $APP_DRAINED == true ]]; then
    if [[ $OMP_MUTATED == true ]]; then
      [[ $($SHA256SUM "$OMP_TARGET" 2>/dev/null | awk '{print $1}') == "$PREVIOUS_OMP_SHA" ]] || rollback_failed=true
      [[ $("$OMP_TARGET" --version 2>/dev/null) == "$PREVIOUS_OMP_VERSION" ]] || rollback_failed=true
    fi
  fi
  if [[ $T4_MUTATED == true ]]; then
    restored_state=$($DPKG_QUERY -W -f='${Status}\t${Version}\n' "$T4_PACKAGE" 2>/dev/null) || rollback_failed=true
    [[ ${restored_state:-} == $'install ok installed\t'"$PREVIOUS_T4_VERSION" ]] || rollback_failed=true
    if ! dpkg_verification=$($DPKG -V "$T4_PACKAGE" 2>/dev/null); then
      rollback_failed=true
    elif [[ -n $dpkg_verification ]]; then
      rollback_failed=true
    fi
  fi
  if [[ $GATEWAY_MUTATED == true ]]; then
    cmp -s -- "$BACKUP_DIR/tailnet-gateway.json" "$GATEWAY_CONFIG" || rollback_failed=true
    cmp -s -- "$BACKUP_DIR/$GATEWAY_SERVICE" "$GATEWAY_UNIT" || rollback_failed=true
  fi

  # Restore the appserver first and prove it healthy before reopening the old
  # gateway. This keeps rollback under the same ingress ordering as cutover.
  if [[ $OMP_MUTATED == true || $APP_DRAINED == true ]]; then
    restore_service_state "$OMP_SERVICE" "$PREVIOUS_APP_ACTIVE" || rollback_failed=true
    if [[ $PREVIOUS_APP_ACTIVE == true ]]; then
      wait_for_appserver >/dev/null 2>&1 || rollback_failed=true
    elif service_is_active "$OMP_SERVICE"; then
      rollback_failed=true
    fi
  fi
  if [[ $GATEWAY_MUTATED == true ]]; then
    restore_service_state "$GATEWAY_SERVICE" "$PREVIOUS_GATEWAY_ACTIVE" || rollback_failed=true
    if [[ $PREVIOUS_GATEWAY_ACTIVE == true ]]; then
      wait_for_gateway "$GATEWAY_PORT" || rollback_failed=true
    elif service_is_active "$GATEWAY_SERVICE"; then
      rollback_failed=true
    fi
  fi

  if [[ $rollback_failed == false ]]; then
    if clear_transaction_marker; then
      cleanup_prepared_artifacts || log "WARNING: restored state is healthy, but prepared artifacts could not be fully removed."
    else
      rollback_failed=true
    fi
  fi
  if [[ $rollback_failed == true ]]; then
    write_transaction_marker rollback-incomplete || true
    log "ERROR: rollback was incomplete; backups remain at $BACKUP_DIR" >&2
    log "ERROR: future maintainer runs are blocked by $BLOCKED_FILE until the host is reconciled" >&2
  else
    log "Previous OMP, T4 package, and Tailnet gateway state restored."
  fi
  set -e
}

on_exit() {
  local status=$?
  trap - EXIT
  if ((status != 0)); then
    if [[ $MUTATION_STARTED == true ]]; then
      if [[ $APP_EXPOSURE_ATTEMPTED == true ]]; then
        if prepare_post_exposure_rollback; then
          rollback
        else
          log "ERROR: the new appserver could not be drained after its exposure attempt, and gateway quarantine could not be proven. Ingress may still be active; the new local state and blocking marker are preserved for operator reconciliation." >&2
        fi
      else
        rollback
      fi
    elif [[ ! -e $BLOCKED_FILE ]]; then
      cleanup_prepared_artifacts || true
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

download_release_asset() {
  local tag=$1 name=$2 destination=$3 release_json url
  release_json=$($GH api "repos/$T4_REPOSITORY/releases/tags/$tag")
  url=$(printf '%s' "$release_json" | $JQ -er --arg name "$name" '
    .assets[]
    | select(.name == $name and .state == "uploaded" and .size > 0)
    | .browser_download_url
  ') || fail "release asset is unavailable: $tag/$name"
  "$CURL" -fsSL --retry 3 --retry-all-errors --max-time 300 "$url" -o "$destination"
  require_regular_file "$destination" "downloaded release asset"
  [[ -s $destination ]] || fail "downloaded release asset is empty: $name"
}

verify_release_checksum() {
  local sums=$1 asset=$2 name expected actual matches
  name=$(basename -- "$asset")
  matches=$(awk -v name="$name" '$2 == name && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ {print $1}' "$sums")
  [[ $matches != *$'\n'* && $matches =~ ^[0-9a-f]{64}$ ]] || fail "release checksum is missing or ambiguous for $name"
  expected=$matches
  actual=$($SHA256SUM "$asset" | awk '{print $1}')
  [[ $actual == "$expected" ]] || fail "release checksum mismatch for $name"
  printf '%s\n' "$actual"
}

verify_fork_publication_base() {
  local attempt official_main fork_main official_tag_object fork_tag_object
  local official_tag_commit fork_tag_commit
  for ((attempt = 1; attempt <= MAIN_MIRROR_ATTEMPTS; attempt += 1)); do
    official_main=$($GH api "repos/$OMP_UPSTREAM_SLUG/commits/main" --jq .sha 2>/dev/null) || official_main=''
    fork_main=$($GH api "repos/$OMP_INTEGRATION_SLUG/commits/main" --jq .sha 2>/dev/null) || fork_main=''
    official_tag_object=$($GH api "repos/$OMP_UPSTREAM_SLUG/git/ref/tags/$UPSTREAM_TAG" --jq .object.sha 2>/dev/null) \
      || official_tag_object=''
    fork_tag_object=$($GH api "repos/$OMP_INTEGRATION_SLUG/git/ref/tags/$UPSTREAM_TAG" --jq .object.sha 2>/dev/null) \
      || fork_tag_object=''
    official_tag_commit=$($GH api "repos/$OMP_UPSTREAM_SLUG/commits/$UPSTREAM_TAG" --jq .sha 2>/dev/null) \
      || official_tag_commit=''
    fork_tag_commit=$($GH api "repos/$OMP_INTEGRATION_SLUG/commits/$UPSTREAM_TAG" --jq .sha 2>/dev/null) \
      || fork_tag_commit=''
    if [[ $official_main =~ ^[0-9a-f]{40}$ && $fork_main == "$official_main" \
      && $official_tag_object =~ ^[0-9a-f]{40}$ && $fork_tag_object == "$official_tag_object" \
      && $official_tag_commit == "$UPSTREAM_COMMIT" && $fork_tag_commit == "$UPSTREAM_COMMIT" ]]; then
      log "The fork exactly mirrors official main and unchanged base tag $UPSTREAM_TAG."
      return 0
    fi
    if ((attempt < MAIN_MIRROR_ATTEMPTS)); then
      log "Fork main and base-tag mirror verification is still converging (${attempt}/${MAIN_MIRROR_ATTEMPTS}); checking again in ${MAIN_MIRROR_INTERVAL_SECONDS}s."
      sleep "$MAIN_MIRROR_INTERVAL_SECONDS"
    fi
  done
  fail "fork main or the unchanged official base tag does not exactly match upstream; retaining the pending publication without staging or mutation"
}

download_verified_deb() {
  local version=$1 destination_dir=$2 name sums deb
  name="T4-Code-${version}-linux-amd64.deb"
  sums="$destination_dir/SHA256SUMS-${version}.txt"
  deb="$destination_dir/$name"
  download_release_asset "v$version" SHA256SUMS.txt "$sums"
  download_release_asset "v$version" "$name" "$deb"
  verify_release_checksum "$sums" "$deb" >/dev/null
  printf '%s\n' "$deb"
}

seal_operator_overlay() {
  local source=$1 package_sha=$2 sealed_dir sealed temporary
  sealed_dir="$MAINTAINER_ROOT/state/operator-overlays"
  mkdir -p -- "$sealed_dir"
  chmod 700 "$MAINTAINER_ROOT/state" "$sealed_dir"
  sealed="$sealed_dir/$package_sha.deb"
  if [[ -e $sealed ]]; then
    verify_sealed_overlay "$sealed" \
      || fail "existing sealed operator rollback package failed verification"
    printf '%s\n' "$sealed"
    return 0
  fi
  temporary=$(mktemp "$sealed_dir/.overlay.XXXXXX")
  cp -- "$source" "$temporary"
  "$SYNC" -f "$temporary" 2>/dev/null || "$SYNC"
  mv -f -- "$temporary" "$sealed"
  chmod 400 "$sealed"
  "$SYNC" -f "$sealed_dir" 2>/dev/null || "$SYNC"
  printf '%s\n' "$sealed"
}
sealed_overlay_invalid() {
  log "ERROR: sealed operator rollback package verification failed: $*" >&2
  return 1
}

verify_sealed_overlay() {
  local package=$1
  [[ -f $package && ! -L $package ]] \
    || { sealed_overlay_invalid "package is unavailable"; return 1; }
  [[ $(stat -c '%a' "$package") == 400 ]] \
    || { sealed_overlay_invalid "permissions changed"; return 1; }
  [[ $(wc -c <"$package") == "$OVERLAY_PACKAGE_SIZE" ]] \
    || { sealed_overlay_invalid "size changed"; return 1; }
  [[ $($SHA256SUM "$package" | awk '{print $1}') == "$OVERLAY_PACKAGE_SHA" ]] \
    || { sealed_overlay_invalid "digest changed"; return 1; }
  [[ $(overlay_app_asar_sha "$package") == "$OVERLAY_APP_ASAR_SHA" ]] \
    || { sealed_overlay_invalid "app.asar digest changed"; return 1; }
}

validate_operator_overlay() {
  local receipt=$1 package_path canonical_path package_size package_sha app_asar_sha \
    t4_commit omp_sha gateway_identity current_gateway_identity manifest \
    manifest_t4_commit manifest_identity manifest_omp_sha manifest_version \
    canonical_source_root
  require_regular_file "$receipt" "operator rollback receipt"
  [[ $(stat -c '%a' "$receipt") == 600 ]] || fail "operator rollback receipt must be owner-only mode 0600"
  canonical_source_root=$("$REALPATH" -e -- "$PREVIOUS_GATEWAY_SOURCE") \
    || fail "current gateway sourceRoot is unavailable"
  [[ $canonical_source_root == "$PREVIOUS_GATEWAY_SOURCE" ]] \
    || fail "current gateway sourceRoot must be canonical"
  manifest="$canonical_source_root/LOCAL_DEPLOYMENT.json"
  require_regular_file "$manifest" "current gateway deployment manifest"
  [[ $("$REALPATH" -e -- "$manifest") == "$manifest" ]] \
    || fail "current gateway deployment manifest must be canonical"
  $JQ -e '
    .schemaVersion == 1 and
    (.kind == "t4-maintainer-local-deployment" or .kind == "local-unreleased-candidate") and
    (.t4Commit | strings | test("^[0-9a-f]{40}$")) and
    (.installedOmpSha256 | strings | test("^[0-9a-f]{64}$")) and
    (.reportedPackageVersion | strings | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
    (.deploymentIdentity | strings | test("^sha256:[0-9a-f]{64}$"))
  ' "$manifest" >/dev/null || fail "current gateway deployment manifest is invalid"
  manifest_t4_commit=$($JQ -er '.t4Commit | strings' "$manifest") \
    || fail "current gateway deployment manifest has no T4 commit"
  manifest_omp_sha=$($JQ -er '.installedOmpSha256 | strings' "$manifest") \
    || fail "current gateway deployment manifest has no installed OMP digest"
  manifest_version=$($JQ -er '.reportedPackageVersion | strings' "$manifest") \
    || fail "current gateway deployment manifest has no package version"
  manifest_identity=$($JQ -er '.deploymentIdentity | strings' "$manifest") \
    || fail "current gateway deployment manifest has no deployment identity"
  package_path=$($JQ -er '.artifact.package.path | strings | select(startswith("/"))' "$receipt") \
    || fail "operator rollback receipt has no absolute package path"
  canonical_path=$($JQ -er '.artifact.package.canonicalPath | strings' "$receipt") \
    || fail "operator rollback receipt has no canonical package path"
  [[ $package_path == "$canonical_path" && $("$REALPATH" -e -- "$package_path") == "$canonical_path" ]] \
    || fail "operator rollback package path is not the exact canonical artifact"
  require_regular_file "$canonical_path" "operator rollback package"
  package_size=$($JQ -er '.artifact.package.size | numbers | select(. > 0 and . <= 524288000)' "$receipt") \
    || fail "operator rollback package size is invalid"
  [[ $(wc -c <"$canonical_path") == "$package_size" ]] \
    || fail "operator rollback package size does not match its receipt"
  package_sha=$($JQ -er '.artifact.package.sha256 | strings | select(test("^[0-9a-f]{64}$"))' "$receipt") \
    || fail "operator rollback package digest is invalid"
  [[ $($SHA256SUM "$canonical_path" | awk '{print $1}') == "$package_sha" ]] \
    || fail "operator rollback package digest does not match its receipt"
  $JQ -e \
    --arg manifest_t4_commit "$manifest_t4_commit" \
    --arg manifest_omp_sha "$manifest_omp_sha" \
    --arg manifest_version "$manifest_version" \
    --arg manifest_identity "$manifest_identity" \
    --arg current_omp_sha "$PREVIOUS_OMP_SHA" \
    --arg current_version "$PREVIOUS_T4_VERSION" \
    --arg current_identity "$($JQ -er '.deploymentIdentity | strings' "$GATEWAY_CONFIG")" '
    .schemaVersion == 1 and
    .kind == "t4-maintainer-operator-overlay" and
    .artifact.package.version == $manifest_version and
    .artifact.package.version == $current_version and
    .artifact.t4.commit == $manifest_t4_commit and
    (.artifact.t4.commit | strings | test("^[0-9a-f]{40}$")) and
    (.artifact.t4.appAsarSha256 | strings | test("^[0-9a-f]{64}$")) and
    .artifact.omp.sha256 == $manifest_omp_sha and
    .artifact.omp.sha256 == $current_omp_sha and
    (.artifact.omp.sha256 | strings | test("^[0-9a-f]{64}$")) and
    .artifact.gateway.deploymentIdentity == $manifest_identity and
    .artifact.gateway.deploymentIdentity == $current_identity and
    (.artifact.gateway.deploymentIdentity | strings | test("^sha256:[0-9a-f]{64}$"))
  ' "$receipt" >/dev/null || fail "operator rollback overlay identity does not exactly match the current deployment"
  app_asar_sha=$(overlay_app_asar_sha "$canonical_path") \
    || fail "operator rollback package app.asar could not be extracted"
  $JQ -e --arg sha "$app_asar_sha" '.artifact.t4.appAsarSha256 == $sha' "$receipt" >/dev/null \
    || fail "operator rollback app.asar digest does not match its receipt"
  require_regular_file "$T4_APP_ASAR" "installed T4 app.asar"
  [[ $($SHA256SUM "$T4_APP_ASAR" | awk '{print $1}') == "$app_asar_sha" ]] \
    || fail "operator rollback app.asar does not match the installed T4 app.asar"
  omp_sha=$($SHA256SUM "$OMP_TARGET" | awk '{print $1}')
  [[ $omp_sha == "$manifest_omp_sha" ]] \
    || fail "operator rollback OMP digest does not match the current deployment manifest"
  gateway_identity=$($JQ -er '.artifact.gateway.deploymentIdentity | strings' "$receipt") \
    || fail "operator rollback gateway identity is missing"
  current_gateway_identity=$($JQ -er '.deploymentIdentity | strings' "$GATEWAY_CONFIG") \
    || fail "current gateway deployment identity is missing"
  [[ $gateway_identity == "$current_gateway_identity" ]] \
    || fail "operator rollback gateway identity does not match the current gateway"
  wait_for_gateway "$GATEWAY_PORT" "$gateway_identity" \
    || fail "current gateway health does not prove the operator overlay identity"
  OVERLAY_PACKAGE_SIZE=$package_size
  OVERLAY_PACKAGE_SHA=$package_sha
  OVERLAY_APP_ASAR_SHA=$app_asar_sha
  PREVIOUS_DEB=$(seal_operator_overlay "$canonical_path" "$package_sha")
  verify_sealed_overlay "$PREVIOUS_DEB" \
    || fail "sealed operator rollback package failed verification"
}


overlay_app_asar_sha() {
  local package=$1
  "$DPKG_DEB" --fsys-tarfile "$package" \
    | tar -xOf - './opt/T4 Code/resources/app.asar' 2>/dev/null \
    | $SHA256SUM | awk '{print $1}'
}
wait_for_appserver() {
  local attempt pid installed_sha running_sha status_json host_id epoch
  installed_sha=$($SHA256SUM "$OMP_TARGET" | awk '{print $1}')
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if service_is_active "$OMP_SERVICE" && [[ -S $OMP_SOCKET ]]; then
      pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value)
      if [[ $pid =~ ^[1-9][0-9]*$ && -r "$PROC_ROOT/$pid/exe" ]]; then
        running_sha=$($SHA256SUM "$PROC_ROOT/$pid/exe" | awk '{print $1}')
        status_json=$("$OMP_TARGET" appserver status --json 2>/dev/null) || status_json=''
        if [[ $running_sha == "$installed_sha" ]] && printf '%s' "$status_json" | $JQ -e '
          .state == "running" and .health.ok == true and
          (.health.hostId | type == "string" and length > 0) and
          (.health.epoch | type == "string" and length > 0)
        ' >/dev/null 2>&1; then
          host_id=$(printf '%s' "$status_json" | $JQ -r '.health.hostId')
          epoch=$(printf '%s' "$status_json" | $JQ -r '.health.epoch')
          printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$installed_sha" "$running_sha" "$host_id" "$epoch"
          return 0
        fi
      fi
    fi
    if ((attempt < HEALTH_ATTEMPTS)); then
      sleep "$HEALTH_INTERVAL_SECONDS"
    fi
  done
  return 1
}

prove_installed_drain_contract() {
  local expected_pid=$1 expected_sha=$2 expected_host_id=$3 expected_epoch=$4
  local current_pid current_sha status_json nonce mismatch_host mismatch_epoch
  local probe_result probe_status

  current_pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value 2>/dev/null) || current_pid=0
  [[ $current_pid == "$expected_pid" && -r "$PROC_ROOT/$current_pid/exe" ]] \
    || fail "the installed appserver PID changed before its live drain-contract proof"
  current_sha=$($SHA256SUM "$PROC_ROOT/$current_pid/exe" | awk '{print $1}')
  [[ $current_sha == "$expected_sha" && $current_sha == "$OMP_CANDIDATE_SHA" ]] \
    || fail "the live appserver executable does not match the installed integration during its drain-contract proof"
  status_json=$("$OMP_TARGET" appserver status --json 2>/dev/null) \
    || fail "the installed appserver status is unavailable during its live drain-contract proof"
  printf '%s' "$status_json" | $JQ -e \
    --arg host_id "$expected_host_id" \
    --arg epoch "$expected_epoch" '
      .state == "running" and .health.ok == true and
      .health.hostId == $host_id and .health.epoch == $epoch
    ' >/dev/null 2>&1 \
    || fail "the installed appserver identity changed before its live drain-contract proof"

  nonce=$(printf '%s\0%s\0%s\0%s\0' "$expected_pid" "$expected_sha" "$expected_host_id" "$expected_epoch" \
    | $SHA256SUM | awk '{print $1}')
  [[ $nonce =~ ^[0-9a-f]{64}$ ]] || fail "could not generate the live drain-contract sentinel"
  mismatch_host="t4-maintainer-host-$nonce"
  mismatch_epoch="t4-maintainer-epoch-$nonce"
  [[ $mismatch_host != "$expected_host_id" && $mismatch_epoch != "$expected_epoch" ]] \
    || fail "could not guarantee a mismatched live drain-contract sentinel"
  if probe_result=$("$OMP_TARGET" appserver drain-if-idle --json \
    --expected-host-id "$mismatch_host" \
    --expected-epoch "$mismatch_epoch" 2>/dev/null); then
    probe_status=0
  else
    probe_status=$?
  fi
  ((probe_status == 75)) \
    || fail "the installed appserver returned an invalid live drain-contract status: $probe_status"
  printf '%s' "$probe_result" | $JQ -e \
    --arg host_id "$expected_host_id" \
    --arg epoch "$expected_epoch" '
      .state == "identity_mismatch" and .health.ok == true and
      .health.hostId == $host_id and .health.epoch == $epoch
    ' >/dev/null 2>&1 \
    || fail "the installed appserver returned an invalid live identity-bound drain proof"

  current_pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value 2>/dev/null) || current_pid=0
  [[ $current_pid == "$expected_pid" && -r "$PROC_ROOT/$current_pid/exe" ]] \
    || fail "the installed appserver PID changed during its live drain-contract proof"
  current_sha=$($SHA256SUM "$PROC_ROOT/$current_pid/exe" | awk '{print $1}')
  [[ $current_sha == "$expected_sha" ]] \
    || fail "the installed appserver executable changed during its live drain-contract proof"
}

require_t4_desktop_closed() {
  if pgrep -x t4-code >/dev/null 2>&1 || pgrep -f '(^|/)t4-code( |$)' >/dev/null 2>&1; then
    fail "T4 Code desktop is open; retaining the pending publication for a later idle retry"
  fi
}

require_appserver_sessionless() {
  local app_pid
  service_is_active "$OMP_SERVICE" || return 0
  app_pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value 2>/dev/null) || app_pid=0
  if [[ $app_pid =~ ^[1-9][0-9]*$ ]]; then
    if pgrep -P "$app_pid" >/dev/null 2>&1; then
      fail "OMP appserver has child sessions; retaining the pending publication for a later idle retry"
    fi
  else
    log "OMP appserver is active without a usable MainPID; treating it as a repairable unhealthy baseline."
  fi
}

require_atomic_drain_capability() {
  local app_pid help_output probe_result probe_status status_json running_host_id running_epoch
  local nonce mismatch_host mismatch_epoch
  service_is_active "$OMP_SERVICE" || return 0
  app_pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value 2>/dev/null) || app_pid=0
  [[ $app_pid =~ ^[1-9][0-9]*$ ]] || return 0
  help_output=$("$OMP_TARGET" appserver drain-if-idle --help 2>&1) \
    || fail "the running OMP appserver lacks the atomic drain-if-idle capability; retaining the pending publication without staging or mutation"
  [[ $help_output == *drain-if-idle* ]] \
    || fail "the running OMP appserver lacks the atomic drain-if-idle capability; retaining the pending publication without staging or mutation"
  status_json=$("$OMP_TARGET" appserver status --json 2>/dev/null) \
    || fail "the active OMP appserver identity is unavailable during its drain capability probe"
  running_host_id=$(printf '%s' "$status_json" | $JQ -er '
    select(.state == "running" and .health.ok == true)
    | .health.hostId | strings | select(length > 0)
  ') || fail "the active OMP appserver host identity is invalid during its drain capability probe"
  running_epoch=$(printf '%s' "$status_json" | $JQ -er '.health.epoch | strings | select(length > 0)') \
    || fail "the active OMP appserver epoch is invalid during its drain capability probe"
  nonce=$(printf '%s\0%s\0%s\0' "$app_pid" "$running_host_id" "$running_epoch" \
    | $SHA256SUM | awk '{print $1}')
  [[ $nonce =~ ^[0-9a-f]{64}$ ]] \
    || fail "could not derive the active OMP drain capability sentinel"
  mismatch_host="t4-maintainer-capability-host-$nonce"
  mismatch_epoch="t4-maintainer-capability-epoch-$nonce"
  while [[ $mismatch_host == "$running_host_id" ]]; do
    mismatch_host="${mismatch_host}-mismatch"
  done
  while [[ $mismatch_epoch == "$running_epoch" ]]; do
    mismatch_epoch="${mismatch_epoch}-mismatch"
  done
  [[ $mismatch_host != "$running_host_id" && $mismatch_epoch != "$running_epoch" ]] \
    || fail "could not guarantee a mismatched active OMP drain capability sentinel"
  if probe_result=$("$OMP_TARGET" appserver drain-if-idle --json \
    --expected-host-id "$mismatch_host" \
    --expected-epoch "$mismatch_epoch" 2>/dev/null); then
    probe_status=0
  else
    probe_status=$?
  fi
  ((probe_status == 75)) \
    || fail "the active OMP appserver returned an invalid drain capability-probe status: $probe_status"
  printf '%s' "$probe_result" | $JQ -e \
    --arg host_id "$running_host_id" \
    --arg epoch "$running_epoch" '
    .state == "identity_mismatch" and
    .health.ok == true and
    .health.hostId == $host_id and
    .health.epoch == $epoch
  ' >/dev/null 2>&1 \
    || fail "the active OMP appserver did not prove the identity-bound drain contract; retaining the pending publication without staging or mutation"
}

drain_receipt_is_valid() {
  local drain_result=$1 expected_host_id=$2 expected_epoch=$3
  printf '%s' "$drain_result" | $JQ -e \
    --arg host_id "$expected_host_id" \
    --arg epoch "$expected_epoch" '
      def safe_count:
        type == "number" and . >= 0 and . <= 9007199254740991 and . == floor;
      .state == "draining" and
      .health.ok == true and
      .health.hostId == $host_id and
      .health.epoch == $epoch and
      (.busy | type == "object") and
      ([
        .busy.connections,
        .busy.inflightMessages,
        .busy.startingSupervisors,
        .busy.lifecycleMutations,
        .busy.sessionOperations,
        .busy.activePrompts,
        .busy.rpcSupervisorsWithPendingCalls,
        .busy.busySessions,
        .busy.openTerminalSessions,
        .busy.pendingConfirmations,
        .busy.outboundSends
      ] | all(.[]; safe_count and . == 0))
    ' >/dev/null 2>&1
}

drain_active_appserver_if_idle() {
  local status_json drain_result expected_host_id expected_epoch
  service_is_active "$OMP_SERVICE" || return 0
  status_json=$("$OMP_TARGET" appserver status --json 2>/dev/null) \
    || fail "the active OMP appserver identity is unavailable; retaining the pending publication"
  expected_host_id=$(printf '%s' "$status_json" | $JQ -er '
    select(.state == "running" and .health.ok == true)
    | .health.hostId | strings | select(length > 0)
  ') || fail "the active OMP appserver host identity is invalid"
  expected_epoch=$(printf '%s' "$status_json" | $JQ -er '.health.epoch | strings | select(length > 0)') \
    || fail "the active OMP appserver epoch is invalid"
  drain_result=$("$OMP_TARGET" appserver drain-if-idle --json \
    --expected-host-id "$expected_host_id" \
    --expected-epoch "$expected_epoch") \
    || fail "OMP appserver became busy or changed identity; retaining the pending publication for a later idle retry"
  APP_DRAINED=true
  drain_receipt_is_valid "$drain_result" "$expected_host_id" "$expected_epoch" \
    || fail "OMP appserver returned an invalid atomic drain receipt"
  write_transaction_marker deployment-in-progress \
    || fail "could not persist the drained appserver transaction state"
}

prepare_post_exposure_rollback() {
  local drain_result drain_status current_pid current_sha status_json discovered_host_id discovered_epoch
  stop_gateway_durably >/dev/null 2>&1 || {
    write_transaction_marker gateway-quarantine-incomplete || true
    return 1
  }
  if service_is_active "$GATEWAY_SERVICE" || ! gateway_is_disabled; then
    write_transaction_marker gateway-quarantine-incomplete || true
    return 1
  fi
  if ! service_is_active "$OMP_SERVICE"; then
    write_transaction_marker rollback-appserver-proven-stopped || true
    return 0
  fi

  current_pid=$($SYSTEMCTL --user show "$OMP_SERVICE" --property MainPID --value 2>/dev/null) || current_pid=0
  [[ $current_pid =~ ^[1-9][0-9]*$ && -r "$PROC_ROOT/$current_pid/exe" ]] || {
    write_transaction_marker rollback-blocked-appserver-identity || true
    return 1
  }
  current_sha=$($SHA256SUM "$PROC_ROOT/$current_pid/exe" 2>/dev/null | awk '{print $1}')
  [[ $current_sha =~ ^[0-9a-f]{64}$ && $current_sha == "$($SHA256SUM "$OMP_TARGET" 2>/dev/null | awk '{print $1}')" ]] || {
    write_transaction_marker rollback-blocked-appserver-executable || true
    return 1
  }
  status_json=$("$OMP_TARGET" appserver status --json 2>/dev/null) || {
    write_transaction_marker rollback-blocked-appserver-identity || true
    return 1
  }
  discovered_host_id=$(printf '%s' "$status_json" | $JQ -er '
    select(.state == "running" and .health.ok == true)
    | .health.hostId | strings | select(length > 0)
  ' 2>/dev/null) || {
    write_transaction_marker rollback-blocked-appserver-identity || true
    return 1
  }
  discovered_epoch=$(printf '%s' "$status_json" | $JQ -er '.health.epoch | strings | select(length > 0)' 2>/dev/null) || {
    write_transaction_marker rollback-blocked-appserver-identity || true
    return 1
  }
  if [[ -n $APP_HOST_ID && $APP_HOST_ID != "$discovered_host_id" ]] \
    || [[ -n $APP_EPOCH && $APP_EPOCH != "$discovered_epoch" ]]; then
    write_transaction_marker rollback-blocked-appserver-identity || true
    return 1
  fi
  APP_HOST_ID=$discovered_host_id
  APP_EPOCH=$discovered_epoch
  if drain_result=$("$OMP_TARGET" appserver drain-if-idle --json \
    --expected-host-id "$APP_HOST_ID" \
    --expected-epoch "$APP_EPOCH" 2>/dev/null); then
    drain_status=0
  else
    drain_status=$?
  fi
  if ((drain_status != 0)); then
    write_transaction_marker rollback-blocked-active-work || true
    return 1
  fi
  APP_DRAINED=true
  drain_receipt_is_valid "$drain_result" "$APP_HOST_ID" "$APP_EPOCH" || {
    write_transaction_marker rollback-blocked-invalid-drain-proof || true
    return 1
  }
  write_transaction_marker rollback-drained-after-exposure || true
  return 0
}

require_workstation_idle() {
  local gateway_health active_sessions
  require_t4_desktop_closed
  if service_is_active "$GATEWAY_SERVICE"; then
    gateway_health=$($CURL -fsS --max-time 3 "http://127.0.0.1:${GATEWAY_PORT}/healthz" 2>/dev/null) || gateway_health=''
    active_sessions=$(printf '%s' "$gateway_health" | $JQ -er '.activeSessions | numbers | select(. >= 0)' 2>/dev/null) || active_sessions=''
    if [[ $active_sessions =~ ^[0-9]+$ ]]; then
      ((active_sessions == 0)) || fail "T4 has active sessions; retaining the pending publication for a later idle retry"
    else
      log "Tailnet gateway health is unavailable; the cutover will stop ingress and repair this baseline."
    fi
  fi
  require_appserver_sessionless
}

wait_for_gateway() {
  local port=$1 expected_identity=${2:-} attempt health
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
    if service_is_active "$GATEWAY_SERVICE"; then
      health=$($CURL -fsS --max-time 3 "http://127.0.0.1:${port}/healthz" 2>/dev/null) || health=''
      if printf '%s' "$health" | $JQ -e --arg identity "$expected_identity" '
        .ok == true and .web == true and .upstream == true and .transport == "local-unix" and
        ($identity == "" or .deploymentIdentity == $identity)
      ' >/dev/null 2>&1; then
        return 0
      fi
    fi
    if ((attempt < HEALTH_ATTEMPTS)); then
      sleep "$HEALTH_INTERVAL_SECONDS"
    fi
  done
  return 1
}

for command in "$GH" "$CURL" "$JQ" "$GIT" "$BUN" "$PNPM" "$NODE" "$SUDO" "$APT_GET" \
  "$DPKG_QUERY" "$DPKG" "$DPKG_DEB" "$SHA256SUM" "$SYSTEMCTL" "$INSTALL" "$SYNC" \
  "$REALPATH" "$UNAME" "$DATE" awk basename chmod cmp cp dirname find grep id mkdir mktemp mv pgrep rm sleep sort stat tar; do
  require_command "$command"
done
require_positive_integer T4_LOCAL_HEALTH_ATTEMPTS "$HEALTH_ATTEMPTS"
require_positive_integer T4_LOCAL_HEALTH_INTERVAL_SECONDS "$HEALTH_INTERVAL_SECONDS"
require_positive_integer T4_LOCAL_MAIN_MIRROR_ATTEMPTS "$MAIN_MIRROR_ATTEMPTS"
require_positive_integer T4_LOCAL_MAIN_MIRROR_INTERVAL_SECONDS "$MAIN_MIRROR_INTERVAL_SECONDS"
[[ $("$UNAME" -s) == Linux ]] || fail "the automatic local deployer currently supports Linux only; the Tailnet service helper remains Linux and macOS compatible"
[[ $RESULT_FILE == /* && $RECEIPT_FILE == /* && $WORK_DIR == /* ]] || fail "deployment paths must be absolute"
[[ $MAINTAINER_ROOT == /* && $DEPLOYMENTS_DIR == /* && $WORK_DIR != *'/../'* ]] || fail "maintainer deployment roots must be absolute and normalized"
canonical_maintainer_root=$("$REALPATH" -e -- "$MAINTAINER_ROOT") \
  || fail "maintainer root must exist and be canonical"
[[ $canonical_maintainer_root == "$MAINTAINER_ROOT" ]] \
  || fail "maintainer root must be canonical"
if [[ $PROC_ROOT != /proc ]]; then
  [[ ${T4_MAINTAINER_TEST_MODE:-0} == 1 \
    && ($canonical_maintainer_root == /tmp/* || $canonical_maintainer_root == /private/tmp/*) ]] \
    || fail "process-root override is restricted to an explicit temporary test root"
fi
case $WORK_DIR in
  "$MAINTAINER_ROOT"/runs/*/local-work) ;;
  *) fail "deployment work directory must belong to the maintainer runs directory" ;;
esac
require_regular_file "$RESULT_FILE" "maintainer result"
[[ ! -e $BLOCKED_FILE ]] || fail "local deployment is blocked pending operator reconciliation: $BLOCKED_FILE"
if [[ $PROC_ROOT != /proc ]]; then
  canonical_proc_root=$("$REALPATH" -e -- "$PROC_ROOT") \
    || fail "test process root must exist and be canonical"
  [[ $canonical_proc_root == "$PROC_ROOT" ]] \
    || fail "test process root must be canonical"
  [[ $canonical_proc_root == "$canonical_maintainer_root"/* ]] \
    || fail "test process root must be a child of the maintainer root"
fi
rm -f -- "$RECEIPT_FILE"
mkdir -p -- "$WORK_DIR" "$(dirname -- "$RECEIPT_FILE")"
chmod 700 "$WORK_DIR"

$JQ -e '
  (.upstream.tag | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  (.upstream.commit | test("^[0-9a-f]{40}$")) and
  (.integration.tag | test("^t4code-[0-9]+\\.[0-9]+\\.[0-9]+-appserver-[1-9][0-9]*$")) and
  (.integration.commit | test("^[0-9a-f]{40}$")) and
  (.t4.version | test("^[0-9]+\\.[0-9]+\\.[0-9]+$")) and
  .t4.tag == ("v" + .t4.version) and
  (.t4.commit | test("^[0-9a-f]{40}$"))
' "$RESULT_FILE" >/dev/null || fail "maintainer result cannot drive a local deployment"

UPSTREAM_TAG=$($JQ -r '.upstream.tag' "$RESULT_FILE")
UPSTREAM_COMMIT=$($JQ -r '.upstream.commit' "$RESULT_FILE")
INTEGRATION_TAG=$($JQ -r '.integration.tag' "$RESULT_FILE")
INTEGRATION_COMMIT=$($JQ -r '.integration.commit' "$RESULT_FILE")
T4_VERSION=$($JQ -r '.t4.version' "$RESULT_FILE")
T4_TAG=$($JQ -r '.t4.tag' "$RESULT_FILE")
T4_COMMIT=$($JQ -r '.t4.commit' "$RESULT_FILE")
[[ $INTEGRATION_TAG == "t4code-${UPSTREAM_TAG#v}-appserver-"* ]] || fail "integration tag does not match the official OMP version"

require_regular_file "$OMP_TARGET" "installed OMP binary"
[[ -x $OMP_TARGET ]] || fail "installed OMP binary is not executable: $OMP_TARGET"
require_regular_file "$GATEWAY_CONFIG" "Tailnet gateway config"
require_regular_file "$GATEWAY_UNIT" "Tailnet gateway unit"
PREVIOUS_GATEWAY_SOURCE=$($JQ -er '.sourceRoot | strings | select(startswith("/"))' "$GATEWAY_CONFIG")
GATEWAY_ORIGIN=$($JQ -er '.allowedOrigin | strings | select(test("^https://"))' "$GATEWAY_CONFIG")
GATEWAY_PORT=$($JQ -er '.port | numbers | select(. >= 1024 and . <= 65535)' "$GATEWAY_CONFIG")
GATEWAY_SOCKET=$($JQ -er '.appSocket | strings | select(startswith("/"))' "$GATEWAY_CONFIG")
GATEWAY_LABEL=$($JQ -er '.label | strings | select(length > 0)' "$GATEWAY_CONFIG")
GATEWAY_PROFILE_CONFIG=$(read_profile_route_config "$GATEWAY_CONFIG") \
  || fail "Tailnet gateway profile routes are invalid"
GATEWAY_PROFILE_ROUTES=""
GATEWAY_START_PROFILES=false
if [[ $GATEWAY_PROFILE_CONFIG != "{}" ]]; then
  GATEWAY_PROFILE_ROUTES=$($JQ -c '.profileRoutes' "$GATEWAY_CONFIG")
  GATEWAY_START_PROFILES=$($JQ -r '.startProfiles' "$GATEWAY_CONFIG")
fi
[[ $GATEWAY_SOCKET == "$OMP_SOCKET" ]] || fail "gateway and OMP service sockets do not match"

package_state=$($DPKG_QUERY -W -f='${Status}\t${Version}\n' "$T4_PACKAGE") || fail "T4 package is not installed"
IFS=$'\t' read -r package_status PREVIOUS_T4_VERSION <<<"$package_state"
[[ $package_status == "install ok installed" ]] || fail "T4 package is not fully installed"
[[ $PREVIOUS_T4_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "installed T4 package version is not a public semantic version"

# Avoid expensive exact-tag builds while the workstation is knowingly busy.
# This is repeated after preparation because a user can open a session during
# the build without turning a safe preflight into an unsafe cutover.
require_noninteractive_privilege
require_atomic_drain_capability
require_workstation_idle
mkdir -p -- "$BACKUP_DIR" "$DOWNLOAD_DIR" "$DEPLOYMENTS_DIR"
chmod 700 "$BACKUP_DIR" "$DOWNLOAD_DIR" "$DEPLOYMENTS_DIR"

log "Preparing exact OMP integration $INTEGRATION_TAG before changing the workstation."
verify_fork_publication_base
$GIT clone --quiet --filter=blob:none --branch "$INTEGRATION_TAG" "$OMP_INTEGRATION_REPOSITORY" "$OMP_SOURCE"
[[ $($GIT -C "$OMP_SOURCE" rev-parse HEAD) == "$INTEGRATION_COMMIT" ]] || fail "cloned OMP integration commit does not match the verified publication"
$GIT -C "$OMP_SOURCE" fetch --quiet --filter=blob:none origin \
  "refs/heads/$OMP_PRODUCT_BRANCH:refs/remotes/origin/$OMP_PRODUCT_BRANCH"
$GIT -C "$OMP_SOURCE" merge-base --is-ancestor \
  "$INTEGRATION_COMMIT" "refs/remotes/origin/$OMP_PRODUCT_BRANCH" \
  || fail "OMP integration tag is not reachable from the durable fork product branch"
$GIT -C "$OMP_SOURCE" remote add official "$OMP_UPSTREAM_REPOSITORY"
$GIT -C "$OMP_SOURCE" fetch --quiet official "$UPSTREAM_COMMIT"
$GIT -C "$OMP_SOURCE" merge-base --is-ancestor "$UPSTREAM_COMMIT" "$INTEGRATION_COMMIT" \
  || fail "OMP integration commit does not descend from the exact official release commit"
(
  cd -- "$OMP_SOURCE"
  "$BUN" install --frozen-lockfile
  "$BUN" run build:native
  "$BUN" --cwd packages/app-wire run check
  "$BUN" --cwd packages/app-wire test
  "$BUN" --cwd packages/appserver run build
  "$BUN" --cwd packages/appserver test
  "$BUN" --cwd packages/coding-agent run check
  "$BUN" test \
    packages/coding-agent/test/appserver-identity.test.ts \
    packages/coding-agent/test/appserver-cli.test.ts \
    packages/coding-agent/test/appserver-session-lifecycle.test.ts \
    packages/coding-agent/test/rpc.test.ts \
    packages/coding-agent/test/rpc-managed-images.test.ts \
    packages/coding-agent/test/rpc-session-entry.test.ts \
    packages/coding-agent/test/rpc-agent-end.test.ts \
    packages/coding-agent/test/rpc-subagents.test.ts
  "$BUN" run build
)
OMP_CANDIDATE="$OMP_SOURCE/packages/coding-agent/dist/omp"
require_regular_file "$OMP_CANDIDATE" "built OMP binary"
[[ -x $OMP_CANDIDATE ]] || fail "built OMP binary is not executable"
[[ $("$OMP_CANDIDATE" --version) == "omp/${UPSTREAM_TAG#v}" ]] || fail "built OMP binary reports the wrong version"
"$OMP_CANDIDATE" --smoke-test
candidate_drain_help=$("$OMP_CANDIDATE" appserver drain-if-idle --help 2>&1) \
  || fail "built OMP integration lacks the atomic drain-if-idle capability required for safe future updates"
[[ $candidate_drain_help == *drain-if-idle* ]] \
  || fail "built OMP integration lacks the atomic drain-if-idle capability required for safe future updates"
OMP_CANDIDATE_SHA=$($SHA256SUM "$OMP_CANDIDATE" | awk '{print $1}')
DEPLOYMENT_IDENTITY="sha256:$(printf '%s\0%s\0%s\0' "$T4_COMMIT" "$INTEGRATION_COMMIT" "$OMP_CANDIDATE_SHA" \
  | $SHA256SUM | awk '{print $1}')"
[[ $DEPLOYMENT_IDENTITY =~ ^sha256:[0-9a-f]{64}$ ]] \
  || fail "could not derive the immutable T4/OMP deployment identity"

log "Preparing exact T4 runtime $T4_TAG and verified release packages."
runtime_suffix="${T4_VERSION}-${T4_COMMIT:0:12}-$("${DATE}" -u +%Y%m%dT%H%M%SZ)-$$"
T4_RUNTIME_ROOT="$DEPLOYMENTS_DIR/t4-$runtime_suffix"
$GIT clone --quiet --filter=blob:none --depth 1 --branch "$T4_TAG" "$T4_CLONE_URL" "$T4_BUILD_ROOT"
[[ $($GIT -C "$T4_BUILD_ROOT" rev-parse HEAD) == "$T4_COMMIT" ]] || fail "cloned T4 runtime commit does not match the verified publication"
$JQ -e --arg version "$T4_VERSION" '.version == $version' "$T4_BUILD_ROOT/package.json" >/dev/null \
  || fail "tagged T4 package version does not match the verified publication"
$JQ -e \
  --arg version "$T4_VERSION" \
  --arg upstream_tag "$UPSTREAM_TAG" \
  --arg upstream_commit "$UPSTREAM_COMMIT" \
  --arg integration_tag "$INTEGRATION_TAG" \
  --arg integration_commit "$INTEGRATION_COMMIT" '
    .desktop.version == $version and
    .verifiedRuntime.upstreamTag == $upstream_tag and
    .verifiedRuntime.upstreamCommit == $upstream_commit and
    .verifiedRuntime.sourceTag == $integration_tag and
    .verifiedRuntime.sourceCommit == $integration_commit
  ' "$T4_BUILD_ROOT/compat/omp-app-matrix.json" >/dev/null \
  || fail "tagged T4 compatibility matrix does not match the verified publication"
(
  cd -- "$T4_BUILD_ROOT"
  "$PNPM" install --frozen-lockfile
  "$PNPM" check
  "$PNPM" build
)
require_regular_file "$T4_BUILD_ROOT/apps/web/dist/index.html" "built T4 web application"
require_regular_file "$T4_BUILD_ROOT/node_modules/ws/package.json" "T4 gateway runtime dependency"
$GIT -C "$T4_BUILD_ROOT" diff --quiet --exit-code HEAD -- \
  || fail "tagged T4 checkout has tracked changes after the release build"

# pnpm exposes ws through a symlink into its large content-addressed tree. Copy
# that exact canonical package, then discard the rest of node_modules before
# retaining the immutable runtime. This keeps each deployment small while the
# source checkout, commit proof, service helper, gateway, and web build remain.
WS_SOURCE=$($REALPATH -e -- "$T4_BUILD_ROOT/node_modules/ws") \
  || fail "T4 gateway ws runtime could not be resolved"
case "$WS_SOURCE/" in
  "$T4_BUILD_ROOT"/*) ;;
  *) fail "T4 gateway ws runtime resolves outside the exact tagged checkout" ;;
esac
cp -a -- "$WS_SOURCE" "$WORK_DIR/ws-runtime"
rm -rf -- "$T4_BUILD_ROOT/node_modules"
mkdir -p -- "$T4_BUILD_ROOT/node_modules"
mv -- "$WORK_DIR/ws-runtime" "$T4_BUILD_ROOT/node_modules/ws"
mv -- "$T4_BUILD_ROOT" "$T4_RUNTIME_ROOT"

GATEWAY_SCRIPT_SHA=$($SHA256SUM "$T4_RUNTIME_ROOT/scripts/tailnet-gateway.mjs" | awk '{print $1}')
GATEWAY_WEB_TREE_SHA=$(tree_sha256 "$T4_RUNTIME_ROOT/apps/web/dist" "$T4_RUNTIME_ROOT") \
  || fail "built T4 web tree could not be hashed"
GATEWAY_WS_TREE_SHA=$(tree_sha256 "$T4_RUNTIME_ROOT/node_modules/ws" "$T4_RUNTIME_ROOT") \
  || fail "T4 gateway ws runtime could not be hashed"

TARGET_DEB=$(download_verified_deb "$T4_VERSION" "$DOWNLOAD_DIR")
TARGET_DEB_SHA=$($SHA256SUM "$TARGET_DEB" | awk '{print $1}')
[[ $($DPKG_DEB -f "$TARGET_DEB" Package) == "$T4_PACKAGE" ]] || fail "release deb has the wrong package name"
[[ $($DPKG_DEB -f "$TARGET_DEB" Version) == "$T4_VERSION" ]] || fail "release deb has the wrong version"
PREVIOUS_OMP_SHA=$($SHA256SUM "$OMP_TARGET" | awk '{print $1}')
PREVIOUS_OMP_VERSION=$("$OMP_TARGET" --version)
[[ $PREVIOUS_OMP_VERSION =~ ^omp/[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "installed OMP binary reports an invalid version"
PREVIOUS_OMP_MODE=$(stat -c '%a' "$OMP_TARGET")
[[ $PREVIOUS_OMP_MODE =~ ^[0-7]{3,4}$ ]] || fail "installed OMP mode is invalid"
$INSTALL -m "$PREVIOUS_OMP_MODE" -- "$OMP_TARGET" "$BACKUP_DIR/omp"
$INSTALL -m 0600 -- "$GATEWAY_CONFIG" "$BACKUP_DIR/tailnet-gateway.json"
$INSTALL -m 0644 -- "$GATEWAY_UNIT" "$BACKUP_DIR/$GATEWAY_SERVICE"
if [[ $PREVIOUS_T4_VERSION == "$T4_VERSION" ]]; then
  require_regular_file "$ROLLBACK_RECEIPT" "same-version operator overlay receipt"
  validate_operator_overlay "$ROLLBACK_RECEIPT"
else
  PREVIOUS_DEB=$(download_verified_deb "$PREVIOUS_T4_VERSION" "$BACKUP_DIR")
fi

require_workstation_idle
require_noninteractive_privilege
require_atomic_drain_capability
"$SUDO" -n "$APT_GET" --simulate install --reinstall --allow-downgrades "$TARGET_DEB" >/dev/null \
  || fail "the target T4 package cannot be installed cleanly"
if [[ -n $OVERLAY_PACKAGE_SHA ]]; then
  verify_sealed_overlay "$PREVIOUS_DEB" \
    || fail "sealed operator rollback package failed verification"
fi
"$SUDO" -n "$APT_GET" --simulate install --reinstall --allow-downgrades "$PREVIOUS_DEB" >/dev/null \
  || fail "the rollback T4 package cannot be installed cleanly"
PREVIOUS_APP_ACTIVE=$(service_is_active "$OMP_SERVICE" && printf true || printf false)
PREVIOUS_GATEWAY_ACTIVE=$(service_is_active "$GATEWAY_SERVICE" && printf true || printf false)
PREVIOUS_GATEWAY_ENABLEMENT=$("$SYSTEMCTL" --user is-enabled "$GATEWAY_SERVICE" 2>/dev/null || true)
case $PREVIOUS_GATEWAY_ENABLEMENT in
  enabled|disabled) ;;
  *) fail "Tailnet gateway has an unsupported enablement state: ${PREVIOUS_GATEWAY_ENABLEMENT:-unknown}" ;;
esac
"$SYNC" -f "$BACKUP_DIR" \
  || fail "could not make the prepared rollback state durable before the cutover"

log "Stopping the idle Tailnet gateway before the appserver cutover."
write_transaction_marker deployment-in-progress \
  || fail "could not persist the crash-safe deployment transaction marker"
MUTATION_STARTED=true
deployment_checkpoint after-transaction-marker
GATEWAY_MUTATED=true
stop_gateway_durably || fail "Tailnet gateway did not become durably disabled and stopped for the cutover"
deployment_checkpoint after-gateway-stop
require_t4_desktop_closed
require_appserver_sessionless

log "Installing OMP $INTEGRATION_TAG and restarting $OMP_SERVICE."
drain_active_appserver_if_idle
OMP_MUTATED=true
$SYSTEMCTL --user stop "$OMP_SERVICE"
service_is_active "$OMP_SERVICE" && fail "OMP appserver did not stop for binary replacement"
deployment_checkpoint after-appserver-stop
omp_temporary="${OMP_TARGET}.t4-maintainer.$$"
$INSTALL -m 0755 -- "$OMP_CANDIDATE" "$omp_temporary"
mv -f -- "$omp_temporary" "$OMP_TARGET"
"$SYNC" -f "$OMP_TARGET"
"$SYNC" -f "$(dirname -- "$OMP_TARGET")"
deployment_checkpoint after-omp-install
write_transaction_marker appserver-exposure-starting \
  || fail "could not persist the appserver exposure-attempt phase"
APP_EXPOSURE_ATTEMPTED=true
$SYSTEMCTL --user start "$OMP_SERVICE"
appserver_proof=$(wait_for_appserver) || fail "OMP appserver did not become healthy on the installed binary"
IFS=$'\t' read -r APP_PID INSTALLED_OMP_SHA RUNNING_OMP_SHA APP_HOST_ID APP_EPOCH <<<"$appserver_proof"
[[ $INSTALLED_OMP_SHA == "$OMP_CANDIDATE_SHA" ]] || fail "installed OMP binary does not match the exact built integration"
prove_installed_drain_contract "$APP_PID" "$RUNNING_OMP_SHA" "$APP_HOST_ID" "$APP_EPOCH"
APP_DRAINED=false
deployment_checkpoint after-appserver-start
require_t4_desktop_closed
require_appserver_sessionless
deployment_checkpoint before-desktop-install

log "Installing verified T4 Code $T4_VERSION package."
T4_MUTATED=true
$SUDO -n "$APT_GET" install -y --reinstall --allow-downgrades "$TARGET_DEB"
deployment_checkpoint after-desktop-install
installed_state=$($DPKG_QUERY -W -f='${Status}\t${Version}\n' "$T4_PACKAGE")
IFS=$'\t' read -r installed_status INSTALLED_T4_VERSION <<<"$installed_state"
[[ $installed_status == "install ok installed" && $INSTALLED_T4_VERSION == "$T4_VERSION" ]] || fail "installed T4 package does not match the target release"
dpkg_verification=$($DPKG -V "$T4_PACKAGE") || fail "dpkg verification failed for T4 Code"
[[ -z $dpkg_verification ]] || fail "installed T4 package files failed verification"
require_regular_file "$T4_EXECUTABLE" "installed T4 executable"
[[ -x $T4_EXECUTABLE ]] || fail "installed T4 executable is not executable"
require_regular_file "$T4_INSTALLED_WEB_ROOT/index.html" "installed T4 web application"
"$SYNC" -f "$T4_EXECUTABLE"

log "Staging the Tailnet gateway for exact T4 runtime $T4_TAG while ingress remains stopped."
GATEWAY_INSTALL_ARGS=(
  "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs"
  install
  --defer-start
  --origin "$GATEWAY_ORIGIN"
  --port "$GATEWAY_PORT"
  --web-root "$T4_RUNTIME_ROOT/apps/web/dist"
  --app-socket "$GATEWAY_SOCKET"
  --label "$GATEWAY_LABEL"
  --deployment-identity "$DEPLOYMENT_IDENTITY"
)
if [[ -n $GATEWAY_PROFILE_ROUTES ]]; then
  GATEWAY_INSTALL_ARGS+=(--profile-routes "$GATEWAY_PROFILE_ROUTES")
  if [[ $GATEWAY_START_PROFILES == true ]]; then
    GATEWAY_INSTALL_ARGS+=(--start-profiles)
  fi
fi
"$NODE" "${GATEWAY_INSTALL_ARGS[@]}"
service_is_active "$GATEWAY_SERVICE" && fail "Tailnet gateway started before the final exposure gate"
gateway_is_disabled || fail "Tailnet gateway was enabled before the final exposure gate"
deployment_checkpoint after-gateway-install
[[ $($JQ -r '.sourceRoot' "$GATEWAY_CONFIG") == "$T4_RUNTIME_ROOT" ]] || fail "Tailnet gateway config did not adopt the target runtime"
[[ $($JQ -r '.allowedOrigin' "$GATEWAY_CONFIG") == "$GATEWAY_ORIGIN" ]] || fail "Tailnet gateway origin changed during deployment"
[[ $($JQ -r '.port' "$GATEWAY_CONFIG") == "$GATEWAY_PORT" ]] || fail "Tailnet gateway port changed during deployment"
[[ $($JQ -r '.appSocket' "$GATEWAY_CONFIG") == "$GATEWAY_SOCKET" ]] || fail "Tailnet gateway socket changed during deployment"
[[ $($JQ -r '.label' "$GATEWAY_CONFIG") == "$GATEWAY_LABEL" ]] || fail "Tailnet gateway label changed during deployment"
[[ $($JQ -r '.deploymentIdentity' "$GATEWAY_CONFIG") == "$DEPLOYMENT_IDENTITY" ]] \
  || fail "Tailnet gateway deployment identity changed during deployment"
INSTALLED_GATEWAY_PROFILE_CONFIG=$(read_profile_route_config "$GATEWAY_CONFIG") \
  || fail "installed Tailnet gateway profile routes are invalid"
[[ $INSTALLED_GATEWAY_PROFILE_CONFIG == "$GATEWAY_PROFILE_CONFIG" ]] \
  || fail "Tailnet gateway profile routes changed during deployment"
GATEWAY_NODE_EXECUTABLE=$($JQ -er '.nodeExecutable | strings | select(startswith("/"))' "$GATEWAY_CONFIG") \
  || fail "Tailnet gateway Node executable is invalid"
require_regular_file "$GATEWAY_CONFIG" "installed Tailnet gateway config"
require_regular_file "$GATEWAY_UNIT" "installed Tailnet gateway unit"
"$SYNC" -f "$GATEWAY_CONFIG"
"$SYNC" -f "$(dirname -- "$GATEWAY_CONFIG")"
"$SYNC" -f "$(dirname -- "$GATEWAY_UNIT")"
GATEWAY_CONFIG_SHA=$($SHA256SUM "$GATEWAY_CONFIG" | awk '{print $1}')
GATEWAY_UNIT_SHA=$($SHA256SUM "$GATEWAY_UNIT" | awk '{print $1}')
$GIT -C "$T4_RUNTIME_ROOT" diff --quiet --exit-code HEAD -- \
  || fail "retained tagged T4 runtime has tracked changes"
[[ $($SHA256SUM "$T4_RUNTIME_ROOT/scripts/tailnet-gateway.mjs" | awk '{print $1}') == "$GATEWAY_SCRIPT_SHA" ]] \
  || fail "Tailnet gateway script changed during deployment"
[[ $(tree_sha256 "$T4_RUNTIME_ROOT/apps/web/dist" "$T4_RUNTIME_ROOT") == "$GATEWAY_WEB_TREE_SHA" ]] \
  || fail "built T4 web tree changed during deployment"
[[ $(tree_sha256 "$T4_RUNTIME_ROOT/node_modules/ws" "$T4_RUNTIME_ROOT") == "$GATEWAY_WS_TREE_SHA" ]] \
  || fail "T4 gateway ws runtime changed during deployment"
deployment_checkpoint before-gateway-exposure

log "Starting the verified Tailnet gateway as the final local exposure step."
GATEWAY_EXPOSURE_ATTEMPTED=true
write_transaction_marker gateway-exposure-starting \
  || fail "could not persist the final gateway exposure state"
$NODE "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs" start
deployment_checkpoint after-gateway-start
$NODE "$T4_RUNTIME_ROOT/scripts/tailnet-service.mjs" status
wait_for_gateway "$GATEWAY_PORT" "$DEPLOYMENT_IDENTITY" \
  || fail "Tailnet gateway did not become healthy with the exact deployment identity after the runtime update"
deployment_checkpoint after-loopback-health
deployment_checkpoint before-receipt

receipt_temporary=$(mktemp "$(dirname -- "$RECEIPT_FILE")/.local-deployment.XXXXXX")
$JQ -n \
  --arg completed_at "$(timestamp)" \
  --slurpfile publication "$RESULT_FILE" \
  --arg omp_target "$OMP_TARGET" \
  --arg omp_version "omp/${UPSTREAM_TAG#v}" \
  --arg omp_sha "$INSTALLED_OMP_SHA" \
  --arg running_omp_sha "$RUNNING_OMP_SHA" \
  --arg previous_omp_sha "$PREVIOUS_OMP_SHA" \
  --arg app_service "$OMP_SERVICE" \
  --argjson app_pid "$APP_PID" \
  --arg app_host_id "$APP_HOST_ID" \
  --arg app_epoch "$APP_EPOCH" \
  --arg t4_package "$T4_PACKAGE" \
  --arg t4_version "$INSTALLED_T4_VERSION" \
  --arg previous_t4_version "$PREVIOUS_T4_VERSION" \
  --arg deb_sha "$TARGET_DEB_SHA" \
  --arg gateway_service "$GATEWAY_SERVICE" \
  --arg gateway_origin "$GATEWAY_ORIGIN" \
  --argjson gateway_port "$GATEWAY_PORT" \
  --arg gateway_socket "$GATEWAY_SOCKET" \
  --arg gateway_label "$GATEWAY_LABEL" \
  --arg deployment_identity "$DEPLOYMENT_IDENTITY" \
  --arg gateway_node_executable "$GATEWAY_NODE_EXECUTABLE" \
  --arg runtime_root "$T4_RUNTIME_ROOT" \
  --arg runtime_commit "$T4_COMMIT" \
  --arg gateway_script_sha "$GATEWAY_SCRIPT_SHA" \
  --arg web_tree_sha "$GATEWAY_WEB_TREE_SHA" \
  --arg ws_tree_sha "$GATEWAY_WS_TREE_SHA" \
  --arg gateway_config_sha "$GATEWAY_CONFIG_SHA" \
  --arg gateway_unit_sha "$GATEWAY_UNIT_SHA" \
  --arg previous_gateway_source "$PREVIOUS_GATEWAY_SOURCE" \
  --arg backup_dir "$BACKUP_DIR" '
    {
      schemaVersion: 1,
      status: "complete",
      completedAt: $completed_at,
      upstream: $publication[0].upstream,
      integration: $publication[0].integration,
      t4: $publication[0].t4,
      omp: {
        target: $omp_target,
        version: $omp_version,
        installedSha256: $omp_sha,
        runningExecutableSha256: $running_omp_sha,
        previousSha256: $previous_omp_sha,
        service: $app_service,
        mainPid: $app_pid,
        health: "healthy",
        hostId: $app_host_id,
        epoch: $app_epoch
      },
      desktop: {
        package: $t4_package,
        installedVersion: $t4_version,
        previousVersion: $previous_t4_version,
        debSha256: $deb_sha,
        dpkgVerification: "clean"
      },
      gateway: {
        service: $gateway_service,
        activeState: "active",
        health: "healthy",
        helperStatus: "healthy",
        loopbackHealth: "healthy",
        tailnetHealth: "pending",
        allowedOrigin: $gateway_origin,
        port: $gateway_port,
        appSocket: $gateway_socket,
        "label": $gateway_label,
        deploymentIdentity: $deployment_identity,
        nodeExecutable: $gateway_node_executable,
        runtimeSourceRoot: $runtime_root,
        runtimeCommit: $runtime_commit,
        artifacts: {
          gatewayScriptSha256: $gateway_script_sha,
          webTreeSha256: $web_tree_sha,
          wsTreeSha256: $ws_tree_sha,
          configSha256: $gateway_config_sha,
          unitSha256: $gateway_unit_sha
        },
        previousSourceRoot: $previous_gateway_source
      },
      rollback: {available: true, backupDirectory: $backup_dir}
    }
  ' >"$receipt_temporary"
chmod 600 "$receipt_temporary"
mv -f -- "$receipt_temporary" "$RECEIPT_FILE"
"$SYNC" -f "$RECEIPT_FILE"
"$SYNC" -f "$(dirname -- "$RECEIPT_FILE")"
deployment_checkpoint after-receipt-write
clear_transaction_marker || fail "could not durably clear the completed deployment transaction marker"

MUTATION_STARTED=false
cleanup_success_inputs || log "WARNING: deployment succeeded, but build inputs could not be fully removed."
trap - EXIT
log "Verified local OMP, T4 package, and loopback gateway deployment; external Tailnet proof remains with the wrapper."
