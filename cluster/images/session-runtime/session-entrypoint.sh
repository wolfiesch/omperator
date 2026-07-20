#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${T4_SESSION_STATE_ROOT:?T4_SESSION_STATE_ROOT is required}"
: "${T4_SESSION_NAME:?T4_SESSION_NAME is required}"
: "${T4_AUTHORITY_STATE_DIR:?T4_AUTHORITY_STATE_DIR is required}"
: "${T4_BROWSER_STATE_DIR:?T4_BROWSER_STATE_DIR is required}"
: "${T4_CLUSTER_SERVER_SERVICE_ACCOUNT:?T4_CLUSTER_SERVER_SERVICE_ACCOUNT is required}"
export T4_OMP_CONFIG_SOURCE_DIR="${T4_OMP_CONFIG_SOURCE_DIR:-/run/t4-omp-config-source}"
export T4_OMP_ALLOW_UNAUTHENTICATED="${T4_OMP_ALLOW_UNAUTHENTICATED:-false}"
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
[[ "${T4_SESSION_NAME}" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"session_name"}' >&2; exit 64; }
[[ "${T4_AUTHORITY_STATE_DIR}" == "${T4_SESSION_STATE_ROOT}/authority" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"authority_state_path"}' >&2; exit 64; }
[[ "${T4_BROWSER_STATE_DIR}" == "${T4_SESSION_STATE_ROOT}/browser" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"browser_state_path"}' >&2; exit 64; }

case "${T4_OMP_ALLOW_UNAUTHENTICATED}" in
  true|false) ;;
  *) echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_authentication_mode"}' >&2; exit 64 ;;
esac

models_source="${T4_OMP_CONFIG_SOURCE_DIR}/models.yml"
settings_source="${T4_OMP_CONFIG_SOURCE_DIR}/config.yml"
[[ -f "${models_source}" && -r "${models_source}" && -s "${models_source}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_models"}' >&2; exit 64; }
[[ -f "${settings_source}" && -r "${settings_source}" && -s "${settings_source}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_settings"}' >&2; exit 64; }

if [[ "${T4_OMP_ALLOW_UNAUTHENTICATED}" == "false" ]]; then
  T4_OMP_CREDENTIAL_KEY="${1:-}"
  [[ -n "${T4_OMP_CREDENTIAL_KEY}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_credential_key"}' >&2; exit 64; }
  [[ "${T4_OMP_CREDENTIAL_KEY}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_credential_key"}' >&2; exit 64; }
  case "${T4_OMP_CREDENTIAL_KEY}" in
    T4_*|OMP_*|PI_*|XDG_*|LD_*|HOME|DISPLAY|PATH|BASH_ENV|ENV|SHELLOPTS|NODE_OPTIONS|BUN_OPTIONS)
      echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_credential_key"}' >&2
      exit 64
      ;;
  esac
  [[ -v "${T4_OMP_CREDENTIAL_KEY}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_credential"}' >&2; exit 64; }
  credential_value="${!T4_OMP_CREDENTIAL_KEY}"
  [[ -n "${credential_value}" ]] || { echo '{"component":"session-runtime","result":"invalid_config","condition":"omp_credential"}' >&2; exit 64; }
  unset credential_value
fi

export HOME="${T4_SESSION_STATE_ROOT}/home"
export PI_CODING_AGENT_DIR="${HOME}/.omp/profiles/${T4_SESSION_NAME}/agent"
mkdir -p "${T4_AUTHORITY_STATE_DIR}" "${T4_BROWSER_STATE_DIR}" /run/t4 /tmp/t4
install -d -m 0700 "${HOME}" "${PI_CODING_AGENT_DIR}"
models_private="${PI_CODING_AGENT_DIR}/.models.yml.new"
settings_private="${PI_CODING_AGENT_DIR}/.config.yml.new"
trap 'rm -f "${models_private}" "${settings_private}"' EXIT
install -m 0600 "${models_source}" "${models_private}"
install -m 0600 "${settings_source}" "${settings_private}"
mv -f "${models_private}" "${PI_CODING_AGENT_DIR}/models.yml"
mv -f "${settings_private}" "${PI_CODING_AGENT_DIR}/config.yml"
trap - EXIT
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
