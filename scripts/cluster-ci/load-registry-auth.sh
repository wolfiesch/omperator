#!/bin/sh
set -eu

umask 077
workspace=${CI_WORKSPACE:-$PWD}
auth_dir=${T4_REGISTRY_AUTH_DIR:-$workspace/.cluster-ci/registry-auth}
case "$auth_dir" in
  "$workspace"/.cluster-ci/*) ;;
  *)
    echo "registry auth directory must remain inside the CI workspace" >&2
    exit 64
    ;;
esac

rm -rf "$auth_dir"
mkdir -p "$auth_dir"
auth_parent=${auth_dir%/*}
chmod 0711 "$auth_parent" "$auth_dir"
unset auth_parent
encoded=$(kubectl -n linkedin-ci get secret harbor-registry-credentials -o 'jsonpath={.data.\.dockerconfigjson}')
if [ -z "$encoded" ]; then
  echo "Harbor credential resource is missing its Docker config key" >&2
  exit 65
fi
printf '%s' "$encoded" | base64 -d > "$auth_dir/config.json"
unset encoded
node scripts/cluster-ci/normalize-registry-auth.mjs "$auth_dir/config.json"
test -r "$auth_dir/config.json"
