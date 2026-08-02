#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly T4_AUTHORITY_OS_UID=10001
readonly T4_SESSION_OS_GID=20001
readonly T4_MAX_UNIX_SOCKET_PATH_BYTES=103

runtime_error() {
  local condition="$1"
  printf '{"component":"session-runtime","result":"invalid_state","condition":"%s"}\n' "${condition}" >&2
  return 64
}

require_canonical_absolute_path() {
  local path="$1" field="$2" part
  [[ "${path}" == /* && "${path}" != "/" && "${path}" != */ ]] || runtime_error "${field}"
  IFS='/' read -r -a path_parts <<< "${path}"
  for part in "${path_parts[@]:1}"; do
    [[ -n "${part}" && "${part}" != "." && "${part}" != ".." ]] || runtime_error "${field}"
  done
}

require_canonical_child() {
  local path="$1" parent="$2" field="$3"
  require_canonical_absolute_path "${path}" "${field}"
  require_canonical_absolute_path "${parent}" "${field}"
  [[ "${path}" == "${parent}/"* && "${path}" != "${parent}" ]] || runtime_error "${field}"
}

require_no_symlink_components() {
  local path="$1" field="$2" current="" part
  IFS='/' read -r -a path_parts <<< "${path}"
  for part in "${path_parts[@]:1}"; do
    current="${current}/${part}"
    if [[ -L "${current}" ]]; then
      runtime_error "${field}"
      return
    fi
    [[ -e "${current}" ]] || break
  done
}

stat_identity_mode() {
  if stat -c '%u:%g:%a' -- "$1" >/dev/null 2>&1; then
    stat -c '%u:%g:%a' -- "$1"
  else
    stat -f '%u:%g:%Lp' -- "$1"
  fi
}

require_private_directory() {
  local path="$1" uid="$2" gid="$3" field="$4"
  require_no_symlink_components "${path}" "${field}"
  [[ -d "${path}" && ! -L "${path}" ]] || runtime_error "${field}"
  [[ "$(stat_identity_mode "${path}")" == "${uid}:${gid}:700" ]] || runtime_error "${field}"
}

ensure_private_directory() {
  local path="$1" uid="$2" gid="$3" field="$4"
  require_no_symlink_components "${path}" "${field}"
  if [[ ! -e "${path}" ]]; then
    mkdir -m 0700 -- "${path}" 2>/dev/null || true
  fi
  require_private_directory "${path}" "${uid}" "${gid}" "${field}"
}
ensure_shared_directory() {
  local path="$1" uid="$2" gid="$3" mode="$4" field="$5"
  require_no_symlink_components "${path}" "${field}"
  if [[ ! -e "${path}" ]]; then
    mkdir -m "${mode}" -- "${path}" 2>/dev/null || true
  fi
  if [[ "$(stat_identity_mode "${path}")" == "${uid}:${gid}:700" ]]; then
    chmod "${mode}" -- "${path}"
  fi
  [[ -d "${path}" && ! -L "${path}" ]] || runtime_error "${field}"
  [[ "$(stat_identity_mode "${path}")" == "${uid}:${gid}:${mode}" ]] || runtime_error "${field}"
}

paths_overlap() {
  [[ "$1" == "$2" || "$1" == "$2/"* || "$2" == "$1/"* ]]
}

validate_private_file() {
  local path="$1" uid="$2" gid="$3" field="$4"
  require_no_symlink_components "${path}" "${field}"
  [[ -f "${path}" && ! -L "${path}" ]] || runtime_error "${field}"
  [[ "$(stat_identity_mode "${path}")" == "${uid}:${gid}:600" ]] || runtime_error "${field}"
}

process_start_time() {
  local pid="$1" stat_line rest
  [[ "${pid}" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ -r "/proc/${pid}/stat" ]] || return 1
  IFS= read -r stat_line < "/proc/${pid}/stat" || return 1
  [[ "${stat_line}" == *") "* ]] || return 1
  rest="${stat_line##*) }"
  set -- ${rest}
  [[ "$#" -ge 20 && "${20}" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "${20}"
}

current_boot_id() {
  local boot_id
  [[ -r /proc/sys/kernel/random/boot_id ]] || return 1
  IFS= read -r boot_id < /proc/sys/kernel/random/boot_id || return 1
  [[ "${boot_id}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  printf '%s\n' "${boot_id}"
}

read_writer_lease() {
  local path="$1" line1 line2 line3 line4 line5 line6 line7 extra
  {
    IFS= read -r line1 &&
      IFS= read -r line2 &&
      IFS= read -r line3 &&
      IFS= read -r line4 &&
      IFS= read -r line5 &&
      IFS= read -r line6 &&
      IFS= read -r line7 || return 1
    if IFS= read -r extra; then
      return 1
    fi
  } < "${path}"
  [[ "${line1}" == "version=1" ]] || return 1
  [[ "${line2}" == runtime_id=* && -n "${line2#runtime_id=}" ]] || return 1
  [[ "${line3}" == runtime_generation=* && -n "${line3#runtime_generation=}" ]] || return 1
  [[ "${line4}" == boot_id=* && "${line4#boot_id=}" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || return 1
  [[ "${line5}" == pid=* && "${line5#pid=}" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "${line6}" == start_time=* && "${line6#start_time=}" =~ ^[0-9]+$ ]] || return 1
  [[ "${line7}" == owner_token=* && "${line7#owner_token=}" =~ ^[0-9a-f]{32}$ ]] || return 1
  LEASE_RUNTIME_ID="${line2#runtime_id=}"
  LEASE_RUNTIME_GENERATION="${line3#runtime_generation=}"
  LEASE_BOOT_ID="${line4#boot_id=}"
  LEASE_PID="${line5#pid=}"
  LEASE_START_TIME="${line6#start_time=}"
  LEASE_OWNER_TOKEN="${line7#owner_token=}"
}

T4_WRITER_LEASE_HELD=false
T4_WRITER_LEASE_OWNER_BASHPID=""
T4_WRITER_LEASE_OWNER_TOKEN=""
T4_WRITER_LEASE_INODE=""
T4_WRITER_LEASE_PUBLISHING=false
T4_WRITER_LEASE_INTERRUPTED_STATUS=""

lease_acquisition_signal() {
  [[ -n "${T4_WRITER_LEASE_INTERRUPTED_STATUS}" ]] || T4_WRITER_LEASE_INTERRUPTED_STATUS="$1"
}

writer_lease_before_publish() {
  :
}

cleanup_writer_lease() {
  [[ "${T4_WRITER_LEASE_HELD}" == "true" ]] || return 0
  [[ "${BASHPID}" == "${T4_WRITER_LEASE_OWNER_BASHPID}" ]] || return 0
  local current_inode="" current_token="" current_pid="" current_start="" current_boot="" observed_start="" observed_boot=""
  flock -n 9 2>/dev/null || return 0
  if [[ -f "${T4_WRITER_LEASE_PATH}" && ! -L "${T4_WRITER_LEASE_PATH}" ]]; then
    current_inode="$(stat -c '%d:%i' -- "${T4_WRITER_LEASE_PATH}" 2>/dev/null || stat -f '%d:%i' -- "${T4_WRITER_LEASE_PATH}" 2>/dev/null || true)"
    if read_writer_lease "${T4_WRITER_LEASE_PATH}"; then
      current_token="${LEASE_OWNER_TOKEN}"
      current_pid="${LEASE_PID}"
      current_start="${LEASE_START_TIME}"
      current_boot="${LEASE_BOOT_ID}"
    fi
  fi
  observed_start="$(process_start_time "${BASHPID}" 2>/dev/null || true)"
  observed_boot="$(current_boot_id 2>/dev/null || true)"
  if [[ "${current_inode}" == "${T4_WRITER_LEASE_INODE}" ]] &&
    { [[ "${T4_WRITER_LEASE_PUBLISHING}" == "true" ]] ||
      { [[ "${current_token}" == "${T4_WRITER_LEASE_OWNER_TOKEN}" ]] &&
        [[ "${current_pid}" == "${BASHPID}" ]] &&
        [[ -n "${observed_boot}" && "${current_boot}" == "${observed_boot}" ]] &&
        [[ -n "${observed_start}" && "${current_start}" == "${observed_start}" ]]; }; }; then
    rm -f -- "${T4_WRITER_LEASE_PATH}"
    sync -f "$(dirname "${T4_WRITER_LEASE_PATH}")" 2>/dev/null || true
  fi
  flock -u 9 2>/dev/null || true
  exec 9>&-
  T4_WRITER_LEASE_HELD=false
  T4_WRITER_LEASE_PUBLISHING=false
}

# This local durable lease complements Kubernetes Pod/PVC fencing; it never substitutes for it.
acquire_writer_lease() {
  local path="$1" runtime_id="$2" generation="$3" uid="$4" gid="$5"
  local created=false current_start owner_token owner_start owner_boot path_inode fd_inode
  require_canonical_child "${path}" "${T4_PRIVATE_RUNTIME_DIR}" "writer_lease_path"
  require_no_symlink_components "${path}" "writer_lease_path"
  if [[ ! -e "${path}" ]]; then
    if ( set -o noclobber; umask 077; : > "${path}" ) 2>/dev/null; then
      created=true
    fi
  fi
  validate_private_file "${path}" "${uid}" "${gid}" "writer_lease_file"
  exec 9<> "${path}"
  flock -n 9 || runtime_error "writer_lease_live_duplicate"
  validate_private_file "${path}" "${uid}" "${gid}" "writer_lease_file"
  path_inode="$(stat -c '%d:%i' -- "${path}")"
  fd_inode="$(stat -Lc '%d:%i' -- /proc/self/fd/9)"
  [[ "${path_inode}" == "${fd_inode}" ]] || runtime_error "writer_lease_replaced"
  T4_WRITER_LEASE_INODE="${path_inode}"

  if [[ "${created}" != "true" ]]; then
    read_writer_lease /proc/self/fd/9 || runtime_error "writer_lease_malformed"
    [[ "${LEASE_RUNTIME_ID}" == "${runtime_id}" ]] || runtime_error "writer_lease_runtime_mismatch"
    [[ "${LEASE_RUNTIME_GENERATION}" == "${generation}" ]] || runtime_error "writer_lease_generation_mismatch"
    owner_boot="$(current_boot_id)" || runtime_error "writer_lease_process_identity"
    if [[ "${LEASE_BOOT_ID}" == "${owner_boot}" ]] &&
      current_start="$(process_start_time "${LEASE_PID}" 2>/dev/null)" &&
      [[ "${current_start}" == "${LEASE_START_TIME}" ]]; then
      runtime_error "writer_lease_live_duplicate"
    fi
  fi

  owner_start="$(process_start_time "${BASHPID}")" || runtime_error "writer_lease_process_identity"
  owner_boot="$(current_boot_id)" || runtime_error "writer_lease_process_identity"
  owner_token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  [[ "${owner_token}" =~ ^[0-9a-f]{32}$ ]] || runtime_error "writer_lease_owner_token"
  T4_WRITER_LEASE_OWNER_BASHPID="${BASHPID}"
  T4_WRITER_LEASE_OWNER_TOKEN="${owner_token}"
  T4_WRITER_LEASE_HELD=true
  T4_WRITER_LEASE_PUBLISHING=true
  writer_lease_before_publish
  [[ -z "${T4_WRITER_LEASE_INTERRUPTED_STATUS}" ]] || exit "${T4_WRITER_LEASE_INTERRUPTED_STATUS}"
  : > /proc/self/fd/9
  printf 'version=1\nruntime_id=%s\nruntime_generation=%s\nboot_id=%s\npid=%s\nstart_time=%s\nowner_token=%s\n' \
    "${runtime_id}" "${generation}" "${owner_boot}" "${BASHPID}" "${owner_start}" "${owner_token}" >&9
  sync -f "${path}" &&
    sync -f "${T4_PRIVATE_RUNTIME_DIR}" &&
    sync -f "${T4_SESSION_STATE_ROOT}" || runtime_error "runtime_state_not_durable"
  T4_WRITER_LEASE_PUBLISHING=false
  [[ -z "${T4_WRITER_LEASE_INTERRUPTED_STATUS}" ]] || exit "${T4_WRITER_LEASE_INTERRUPTED_STATUS}"
}

initialize_runtime_roots() {
  local runtime_mount="$1" workspace_mount="$2" short_mount="$3" uid="$4" gid="$5"
  local root expected_short socket_bytes first second
  require_canonical_absolute_path "${runtime_mount}" "runtime_state_mount"
  require_canonical_absolute_path "${workspace_mount}" "workspace_root"
  require_canonical_absolute_path "${short_mount}" "short_runtime_mount"
  require_no_symlink_components "${runtime_mount}" "runtime_state_mount"
  require_no_symlink_components "${workspace_mount}" "workspace_root"
  require_no_symlink_components "${short_mount}" "short_runtime_mount"
  [[ -d "${runtime_mount}" && -w "${runtime_mount}" && ! -L "${runtime_mount}" ]] || runtime_error "runtime_state_unavailable"
  [[ -d "${workspace_mount}" && ! -L "${workspace_mount}" ]] || runtime_error "workspace_unavailable"
  if [[ ! -e "${short_mount}" ]]; then
    mkdir -m 0711 -- "${short_mount}" 2>/dev/null || true
  fi
  [[ -d "${short_mount}" && ! -L "${short_mount}" ]] || runtime_error "short_runtime_mount"

  [[ "${T4_RUNTIME_ID}" =~ ^runtime-[a-z0-9]([-a-z0-9]{0,53}[a-z0-9])?$ ]] || runtime_error "runtime_id"
  [[ "${T4_SESSION_STATE_ID}" == "${T4_RUNTIME_ID}" ]] || runtime_error "session_state_identity"
  [[ "${T4_RUNTIME_GENERATION}" =~ ^gen_[A-Za-z0-9_-]{24}$ ]] || runtime_error "runtime_generation"
  [[ "${T4_SESSION_NAME}" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$ ]] || runtime_error "session_name"

  root="${runtime_mount}/${T4_RUNTIME_ID}"
  expected_short="${short_mount}/${T4_RUNTIME_ID}"
  [[ "${T4_SESSION_STATE_ROOT}" == "${root}" ]] || runtime_error "session_state_path"
  [[ "${T4_AUTHORITY_STATE_DIR}" == "${root}/authority" ]] || runtime_error "authority_state_path"
  [[ "${T4_CMUX_STATE_DIR}" == "${root}/cmux" ]] || runtime_error "cmux_state_path"
  [[ "${T4_BROWSER_STATE_DIR}" == "${root}/browser" ]] || runtime_error "browser_state_path"
  [[ "${T4_ARTIFACT_ROOT}" == "${root}/artifacts" ]] || runtime_error "artifact_state_path"
  [[ "${T4_PRIVATE_RUNTIME_DIR}" == "${root}/private" ]] || runtime_error "private_runtime_path"
  [[ "${T4_OMP_HOME}" == "${root}/home" ]] || runtime_error "omp_home_path"
  [[ "${T4_WRITER_LEASE_PATH}" == "${root}/private/writer-lease" ]] || runtime_error "writer_lease_path"
  [[ "${T4_HOST_RUNTIME_DIR}" == "${expected_short}" ]] || runtime_error "short_runtime_path"
  [[ "${T4_CMUX_SOCKET_PATH}" == "${expected_short}/c.sock" ]] || runtime_error "cmux_socket_path"
  [[ "${T4_CMUX_SOCKET_MODE}" == "0660" ]] || runtime_error "cmux_socket_mode"
  [[ "${T4_WORKSPACE_ROOT}" == "${workspace_mount}" ]] || runtime_error "workspace_root"

  for root in "${T4_SESSION_STATE_ROOT}" "${T4_AUTHORITY_STATE_DIR}" "${T4_CMUX_STATE_DIR}" "${T4_BROWSER_STATE_DIR}" "${T4_ARTIFACT_ROOT}" "${T4_PRIVATE_RUNTIME_DIR}" "${T4_OMP_HOME}" "${T4_HOST_RUNTIME_DIR}"; do
    require_canonical_absolute_path "${root}" "runtime_root"
    require_no_symlink_components "${root}" "runtime_root"
  done
  for first in "${T4_AUTHORITY_STATE_DIR}" "${T4_CMUX_STATE_DIR}" "${T4_BROWSER_STATE_DIR}" "${T4_ARTIFACT_ROOT}" "${T4_PRIVATE_RUNTIME_DIR}" "${T4_OMP_HOME}"; do
    require_canonical_child "${first}" "${T4_SESSION_STATE_ROOT}" "runtime_root_escape"
    paths_overlap "${first}" "${workspace_mount}" && runtime_error "workspace_runtime_overlap"
    for second in "${T4_AUTHORITY_STATE_DIR}" "${T4_CMUX_STATE_DIR}" "${T4_BROWSER_STATE_DIR}" "${T4_ARTIFACT_ROOT}" "${T4_PRIVATE_RUNTIME_DIR}" "${T4_OMP_HOME}"; do
      [[ "${first}" == "${second}" ]] || ! paths_overlap "${first}" "${second}" || runtime_error "private_root_overlap"
    done
  done
  ! paths_overlap "${T4_SESSION_STATE_ROOT}" "${workspace_mount}" || runtime_error "workspace_runtime_overlap"
  require_canonical_child "${T4_HOST_RUNTIME_DIR}" "${short_mount}" "short_runtime_escape"
  ! paths_overlap "${T4_HOST_RUNTIME_DIR}" "${T4_SESSION_STATE_ROOT}" || runtime_error "durable_socket_overlap"

  ensure_shared_directory "${T4_SESSION_STATE_ROOT}" "${uid}" "${gid}" "770" "session_state_directory"
  ensure_private_directory "${T4_AUTHORITY_STATE_DIR}" "${uid}" "${gid}" "authority_state_directory"
  ensure_shared_directory "${T4_CMUX_STATE_DIR}" "${uid}" "${gid}" "770" "cmux_state_directory"
  ensure_shared_directory "${T4_BROWSER_STATE_DIR}" "${uid}" "${gid}" "770" "browser_state_directory"
  ensure_private_directory "${T4_ARTIFACT_ROOT}" "${uid}" "${gid}" "artifact_state_directory"
  ensure_private_directory "${T4_PRIVATE_RUNTIME_DIR}" "${uid}" "${gid}" "private_runtime_directory"
  ensure_private_directory "${T4_OMP_HOME}" "${uid}" "${gid}" "omp_home_directory"
  ensure_shared_directory "${T4_HOST_RUNTIME_DIR}" "${uid}" "${gid}" "770" "short_runtime_directory"

  socket_bytes="$(printf '%s' "${T4_CMUX_SOCKET_PATH}" | wc -c | tr -d ' ')"
  [[ "${socket_bytes}" -le "${T4_MAX_UNIX_SOCKET_PATH_BYTES}" ]] || runtime_error "cmux_socket_path_too_long"
  export T4_SESSION_HOST_READY_PATH="${T4_SESSION_HOST_READY_PATH:-${T4_HOST_RUNTIME_DIR}/host.ready}"
  export HOME="${T4_OMP_HOME}"
  export XDG_RUNTIME_DIR="${T4_HOST_RUNTIME_DIR}"
  export PI_CODING_AGENT_DIR="${T4_AUTHORITY_STATE_DIR}/agent"
  export T4_OMP_AUTHORITY_DIR="${T4_AUTHORITY_STATE_DIR}"
  export T4_OMP_ARTIFACT_ROOT="${T4_ARTIFACT_ROOT}"
  export CMUX_STATE_DIR="${T4_CMUX_STATE_DIR}"
  export CMUX_SOCKET_PATH="${T4_CMUX_SOCKET_PATH}"
  export CMUX_SOCKET_MODE="${T4_CMUX_SOCKET_MODE}"
  export CMUX_SESSION="${T4_SESSION_NAME}"
  ensure_private_directory "${PI_CODING_AGENT_DIR}" "${uid}" "${gid}" "omp_authority_directory"
}

supervisor_pid=""
entrypoint_signal_forwarded=false
entrypoint_pending_signal=""
entrypoint_pending_signal_status=""
models_private=""
settings_private=""

forward_supervisor_signal() {
  local signal="$1" status="$2"
  [[ "${entrypoint_signal_forwarded}" == "false" ]] || return 0
  if [[ -z "${supervisor_pid}" ]]; then
    if [[ -z "${entrypoint_pending_signal}" ]]; then
      entrypoint_pending_signal="${signal}"
      entrypoint_pending_signal_status="${status}"
    fi
    return 0
  fi
  entrypoint_signal_forwarded=true
  kill "-${signal}" "${supervisor_pid}" 2>/dev/null || true
}

run_runtime_supervisor() {
  /usr/local/bin/bun /usr/local/lib/t4/session-host-main/session-host-main.js
}

runtime_before_supervisor_launch() {
  :
}

supervise_runtime() {
  run_runtime_supervisor 9>&- &
  supervisor_pid="$!"
  if [[ -n "${entrypoint_pending_signal}" ]]; then
    forward_supervisor_signal "${entrypoint_pending_signal}" "${entrypoint_pending_signal_status}"
  fi
  local supervisor_status=70
  while kill -0 "${supervisor_pid}" 2>/dev/null; do
    if wait "${supervisor_pid}"; then
      supervisor_status=0
    else
      supervisor_status="$?"
    fi
  done
  if wait "${supervisor_pid}" 2>/dev/null; then
    supervisor_status=0
  else
    local reaped_status="$?"
    [[ "${reaped_status}" == "127" ]] || supervisor_status="${reaped_status}"
  fi
  supervisor_pid=""
  [[ -z "${entrypoint_pending_signal_status}" ]] || supervisor_status="${entrypoint_pending_signal_status}"
  return "${supervisor_status}"
}

launch_supervised_runtime() {
  runtime_before_supervisor_launch
  supervise_runtime
}

entrypoint_cleanup() {
  [[ -z "${models_private}" ]] || rm -f -- "${models_private}"
  [[ -z "${settings_private}" ]] || rm -f -- "${settings_private}"
  cleanup_writer_lease
}

main() {
  : "${T4_RUNTIME_ID:?T4_RUNTIME_ID is required}"
  : "${T4_RUNTIME_UID:?T4_RUNTIME_UID is required}"
  : "${T4_SESSION_STATE_ID:?T4_SESSION_STATE_ID is required}"
  : "${T4_RUNTIME_GENERATION:?T4_RUNTIME_GENERATION is required}"
  : "${T4_SESSION_STATE_ROOT:?T4_SESSION_STATE_ROOT is required}"
  : "${T4_SESSION_NAME:?T4_SESSION_NAME is required}"
  : "${T4_AUTHORITY_STATE_DIR:?T4_AUTHORITY_STATE_DIR is required}"
  : "${T4_CMUX_STATE_DIR:?T4_CMUX_STATE_DIR is required}"
  : "${T4_BROWSER_STATE_DIR:?T4_BROWSER_STATE_DIR is required}"
  : "${T4_ARTIFACT_ROOT:?T4_ARTIFACT_ROOT is required}"
  : "${T4_PRIVATE_RUNTIME_DIR:?T4_PRIVATE_RUNTIME_DIR is required}"
  : "${T4_OMP_HOME:?T4_OMP_HOME is required}"
  : "${T4_WRITER_LEASE_PATH:?T4_WRITER_LEASE_PATH is required}"
  : "${T4_HOST_RUNTIME_DIR:?T4_HOST_RUNTIME_DIR is required}"
  : "${T4_CMUX_SOCKET_PATH:?T4_CMUX_SOCKET_PATH is required}"
  : "${T4_CMUX_SOCKET_MODE:?T4_CMUX_SOCKET_MODE is required}"
  : "${T4_WORKSPACE_ROOT:?T4_WORKSPACE_ROOT is required}"
  : "${T4_CLUSTER_SERVER_SERVICE_ACCOUNT:?T4_CLUSTER_SERVER_SERVICE_ACCOUNT is required}"
  [[ "$#" -eq 0 ]] || runtime_error "unexpected_arguments"

  export T4_OMP_CONFIG_SOURCE_DIR="${T4_OMP_CONFIG_SOURCE_DIR:-/run/t4-omp-config-source}"
  export T4_KUBERNETES_TOKEN_PATH="${T4_KUBERNETES_TOKEN_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/token}"
  export T4_KUBERNETES_CA_PATH="${T4_KUBERNETES_CA_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/ca.crt}"
  export T4_KUBERNETES_NAMESPACE_PATH="${T4_KUBERNETES_NAMESPACE_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/namespace}"
  local projected_file
  for projected_file in "${T4_KUBERNETES_TOKEN_PATH}" "${T4_KUBERNETES_CA_PATH}" "${T4_KUBERNETES_NAMESPACE_PATH}"; do
    [[ -f "${projected_file}" && -r "${projected_file}" ]] || runtime_error "kubernetes_api_projection"
  done

  local models_source="${T4_OMP_CONFIG_SOURCE_DIR}/models.yml"
  local settings_source="${T4_OMP_CONFIG_SOURCE_DIR}/config.yml"
  [[ -f "${models_source}" && -r "${models_source}" && -s "${models_source}" ]] || runtime_error "omp_models"
  [[ -f "${settings_source}" && -r "${settings_source}" && -s "${settings_source}" ]] || runtime_error "omp_settings"

  initialize_runtime_roots "/runtime-state" "/workspace" "/run/t4" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}"
  trap 'lease_acquisition_signal 143' TERM
  trap 'lease_acquisition_signal 130' INT
  trap entrypoint_cleanup EXIT
  acquire_writer_lease "${T4_WRITER_LEASE_PATH}" "${T4_RUNTIME_ID}" "${T4_RUNTIME_GENERATION}" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}"
  trap 'forward_supervisor_signal TERM 143' TERM
  trap 'forward_supervisor_signal INT 130' INT
  local models_destination="${PI_CODING_AGENT_DIR}/models.yml"
  local settings_destination="${PI_CODING_AGENT_DIR}/config.yml"
  if [[ -e "${models_destination}" || -L "${models_destination}" ]]; then
    validate_private_file "${models_destination}" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}" "omp_models_destination"
  fi
  if [[ -e "${settings_destination}" || -L "${settings_destination}" ]]; then
    validate_private_file "${settings_destination}" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}" "omp_settings_destination"
  fi
  models_private="${PI_CODING_AGENT_DIR}/.models.yml.new"
  settings_private="${PI_CODING_AGENT_DIR}/.config.yml.new"
  [[ ! -e "${models_private}" && ! -L "${models_private}" ]] || runtime_error "omp_models_staging"
  [[ ! -e "${settings_private}" && ! -L "${settings_private}" ]] || runtime_error "omp_settings_staging"
  install -m 0600 "${models_source}" "${models_private}"
  install -m 0600 "${settings_source}" "${settings_private}"
  mv -f "${models_private}" "${models_destination}"
  mv -f "${settings_private}" "${settings_destination}"
  validate_private_file "${models_destination}" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}" "omp_models_destination"
  validate_private_file "${settings_destination}" "${T4_AUTHORITY_OS_UID}" "${T4_SESSION_OS_GID}" "omp_settings_destination"
  sync -f "${models_destination}" &&
    sync -f "${settings_destination}" &&
    sync -f "${PI_CODING_AGENT_DIR}" || runtime_error "runtime_state_not_durable"
  models_private=""
  settings_private=""
  /usr/local/bin/bun /usr/local/lib/t4/assert-omp-credentials-absent.js "${PI_CODING_AGENT_DIR}" "${HOME}" || runtime_error "omp_credential_state_present"

  export DISPLAY="${DISPLAY:-:99}"
  [[ "${DISPLAY}" =~ ^:([0-9]{1,3})$ ]] || runtime_error "display"
  export T4_OMP_EXECUTABLE=/opt/t4/libexec/omp-authority

  launch_supervised_runtime
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
