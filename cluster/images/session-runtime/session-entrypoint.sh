#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${T4_SESSION_STATE_ROOT:?T4_SESSION_STATE_ROOT is required}"
: "${T4_AUTHORITY_STATE_DIR:?T4_AUTHORITY_STATE_DIR is required}"
: "${T4_BROWSER_STATE_DIR:?T4_BROWSER_STATE_DIR is required}"
: "${T4_CLUSTER_SERVER_SERVICE_ACCOUNT:?T4_CLUSTER_SERVER_SERVICE_ACCOUNT is required}"
export T4_KUBERNETES_TOKEN_PATH="${T4_KUBERNETES_TOKEN_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/token}"
export T4_KUBERNETES_CA_PATH="${T4_KUBERNETES_CA_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/ca.crt}"
export T4_KUBERNETES_NAMESPACE_PATH="${T4_KUBERNETES_NAMESPACE_PATH:-/var/run/secrets/kubernetes.io/serviceaccount/namespace}"
for projected_file in "${T4_KUBERNETES_TOKEN_PATH}" "${T4_KUBERNETES_CA_PATH}" "${T4_KUBERNETES_NAMESPACE_PATH}"; do
  [[ -f "${projected_file}" && -r "${projected_file}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"kubernetes_api_projection"}' >&2; exit 64; }
done

if [[ ! "${T4_SESSION_STATE_ROOT}" =~ ^/workspace/\.t4/sessions/[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]]; then
  echo '{"component":"session-runtime","result":"invalid_config","condition":"session_state_path"}' >&2
  exit 64
fi
[[ "${T4_AUTHORITY_STATE_DIR}" == "${T4_SESSION_STATE_ROOT}/authority" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"authority_state_path"}' >&2; exit 64; }
[[ "${T4_BROWSER_STATE_DIR}" == "${T4_SESSION_STATE_ROOT}/browser" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"browser_state_path"}' >&2; exit 64; }

mkdir -p "${T4_AUTHORITY_STATE_DIR}" "${T4_BROWSER_STATE_DIR}" /run/t4 /tmp/t4
export HOME="${T4_AUTHORITY_STATE_DIR}"
export DISPLAY="${DISPLAY:-:99}"
[[ "${DISPLAY}" =~ ^:([0-9]{1,3})$ ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"display"}' >&2; exit 64; }
display_socket="/tmp/.X11-unix/X${BASH_REMATCH[1]}"
export T4_OMP_EXECUTABLE=/opt/t4/bin/omp
export T4_WORKSPACE_ROOT=/workspace

children=()
stop_children() {
  local pid
  for pid in "${children[@]:-}"; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
}
trap stop_children TERM INT EXIT

Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -nolisten tcp -ac &
children+=("$!")
for _ in $(seq 1 50); do
  [[ -S "${display_socket}" ]] && break
  kill -0 "${children[0]}" 2>/dev/null || { echo '{"component":"session-runtime","result":"startup_failed","condition":"xvfb"}' >&2; exit 70; }
  sleep 0.1
done
[[ -S "${display_socket}" ]] || { echo '{"component":"session-runtime","result":"startup_timeout","condition":"xvfb"}' >&2; exit 70; }
fluxbox -display "${DISPLAY}" &
children+=("$!")

if [[ "${T4_GUI_ENABLED:-false}" == "true" ]]; then
  chromium \
    --disable-setuid-sandbox \
    --disable-background-networking \
    --disable-breakpad \
    --disable-component-update \
    --disable-default-apps \
    --disable-sync \
    --metrics-recording-only \
    --no-first-run \
    --password-store=basic \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port=9222 \
    --user-data-dir="${T4_BROWSER_STATE_DIR}" \
    about:blank &
  children+=("$!")
fi

/usr/local/bin/bun /opt/t4/packages/cluster-server/src/session-host-main.ts &
host_pid=$!
children+=("${host_pid}")
wait "${host_pid}"
