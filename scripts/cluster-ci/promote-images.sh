#!/bin/sh
set -eu

umask 077

: "${CI_COMMIT_SHA:?CI_COMMIT_SHA is required}"
: "${HARBOR_REGISTRY:?HARBOR_REGISTRY is required}"
: "${HARBOR_PROJECT:?HARBOR_PROJECT is required}"
if [ "$HARBOR_REGISTRY" != "harbor.tailb18de3.ts.net" ]; then
  echo "HARBOR_REGISTRY must be the exact HTTPS tailnet Harbor host" >&2
  exit 64
fi
case "$CI_COMMIT_SHA" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "CI_COMMIT_SHA must be an exact lowercase 40-character SHA" >&2; exit 64 ;;
esac

auth_dir=${T4_REGISTRY_AUTH_DIR:-${CI_WORKSPACE:-$PWD}/.cluster-ci/registry-auth}
test -r "$auth_dir/config.json"
export DOCKER_CONFIG="$auth_dir"
artifact_dir=artifacts/cluster-proof/images

for entry in \
  controller:t4-cluster-operator \
  cluster-server:t4-cluster-server \
  session-runtime:t4-session-runtime
do
  component=${entry%%:*}
  repository_suffix=${entry#*:}
  digest=$(cat "$artifact_dir/$component.digest")
  case "$digest" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) echo "$component image digest artifact is malformed" >&2; exit 65 ;;
  esac
  source="$HARBOR_REGISTRY/$HARBOR_PROJECT/quarantine/$repository_suffix@$digest"
  destination="$HARBOR_REGISTRY/$HARBOR_PROJECT/$repository_suffix:$CI_COMMIT_SHA"
  if resolved=$(oras resolve "$destination" 2>&1); then
    if [ "$resolved" != "$digest" ]; then
      echo "$component destination commit tag already resolves to a different digest" >&2
      exit 65
    fi
  else
    case "$resolved" in
      *"failed to resolve digest: $CI_COMMIT_SHA: not found") ;;
      *)
        printf '%s\n' "$resolved" >&2
        echo "$component destination commit tag could not be resolved safely" >&2
        exit 65
        ;;
    esac
    oras copy --recursive "$source" "$destination"
  fi
  resolved=$(oras resolve "$destination")
  if [ "$resolved" != "$digest" ]; then
    echo "$component promoted reference did not resolve to the gated digest" >&2
    exit 65
  fi
done
