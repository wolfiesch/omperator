#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ "$(id -u)" == "10002" && "$(id -g)" == "20001" ]] || {
  printf '%s\n' '{"component":"session-shell","result":"principal_mismatch"}' >&2
  exit 64
}
[[ ! -r /opt/t4 && ! -x /opt/t4/libexec/omp-authority && ! -r /opt/omp/packages/coding-agent/src/cli.ts ]] || {
  printf '%s\n' '{"component":"session-shell","result":"authority_artifact_exposed"}' >&2
  exit 64
}

[[ "$#" -eq 0 ]] || { printf '%s\n' '{"component":"session-shell","result":"invalid_arguments"}' >&2; exit 64; }
: "${T4_RUNTIME_ID:?T4_RUNTIME_ID is required}"
: "${T4_RUNTIME_GENERATION:?T4_RUNTIME_GENERATION is required}"
: "${T4_SESSION_NAME:?T4_SESSION_NAME is required}"
: "${T4_SESSION_STATE_ROOT:?T4_SESSION_STATE_ROOT is required}"
: "${T4_CMUX_STATE_DIR:?T4_CMUX_STATE_DIR is required}"
: "${T4_BROWSER_STATE_DIR:?T4_BROWSER_STATE_DIR is required}"
: "${T4_HOST_RUNTIME_DIR:?T4_HOST_RUNTIME_DIR is required}"
: "${T4_CMUX_SOCKET_PATH:?T4_CMUX_SOCKET_PATH is required}"
: "${T4_WORKSPACE_ROOT:?T4_WORKSPACE_ROOT is required}"
[[ -z "${T4_OMP_EXECUTABLE:-}" && -z "${T4_GENERATION_AUTH_PATH:-}" && -z "${T4_OMP_CONFIG_SOURCE_DIR:-}" ]] || {
  printf '%s\n' '{"component":"session-shell","result":"authority_environment_exposed"}' >&2
  exit 64
}
export CMUX_STATE_DIR="${T4_CMUX_STATE_DIR}"
export CMUX_SOCKET_PATH="${T4_CMUX_SOCKET_PATH}"
export CMUX_SOCKET_MODE=0660
for _ in $(seq 1 600); do
  if [[ -d "${T4_CMUX_STATE_DIR}" && -d "${T4_BROWSER_STATE_DIR}" && -f "${T4_SESSION_HOST_READY_PATH}" ]]; then
    break
  fi
  sleep 0.1
done
[[ -d "${T4_CMUX_STATE_DIR}" && -d "${T4_BROWSER_STATE_DIR}" && -f "${T4_SESSION_HOST_READY_PATH}" ]] || {
  printf '%s\n' '{"component":"session-shell","result":"authority_not_ready"}' >&2
  exit 70
}
[[ ! -e "${T4_SESSION_STATE_ROOT}/private/appserver.sock" ]] || {
  printf '%s\n' '{"component":"session-shell","result":"authority_socket_exposed"}' >&2
  exit 64
}
shell_home="${T4_CMUX_STATE_DIR}/home"
if [[ ! -e "${shell_home}" ]]; then
  mkdir -m 0700 -- "${shell_home}"
fi
[[ -d "${shell_home}" && ! -L "${shell_home}" ]] || {
  printf '%s\n' '{"component":"session-shell","result":"shell_home_invalid"}' >&2
  exit 64
}
export HOME="${shell_home}"
export XDG_RUNTIME_DIR="${T4_HOST_RUNTIME_DIR}"
rm -f -- "${T4_CMUX_SOCKET_PATH}" "/tmp/.X11-unix/X99"
export CMUX_SESSION="${T4_SESSION_NAME}"
exec /usr/local/bin/bun /usr/local/lib/t4/session-runtime-supervisor.js
