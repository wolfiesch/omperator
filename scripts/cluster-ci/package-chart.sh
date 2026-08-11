#!/bin/sh
set -eu

# Local packaging of the portable t4-cluster chart. This harness never contacts
# a registry, never authenticates, and never publishes. Pushing the packaged
# archive is a separate, explicitly approved publication action.

umask 077

print_plan() {
  cat <<'PLAN'
T4 chart packaging plan (local only; no registry request)
Steps:
  1. Validate the advertised capability contract with scripts/cluster-ci/chart-capabilities.mjs.
  2. helm lint the chart directory with default values.
  3. Render default values and require an empty manifest; the chart is default-off.
  4. helm package the chart directory into the local output directory.
  5. Require the archive to contain Chart.yaml, values.yaml, values.schema.json, capabilities.yaml, templates/NOTES.txt, and exactly the three cluster.t4.dev CRDs.
  6. Record chart name, version, appVersion, archive path, archive size, and archive sha256 in a local manifest.
Not performed here:
  helm registry login, helm push, oras push, cosign sign, or any other publication step.
PLAN
}

usage() {
  cat >&2 <<'USAGE'
usage: package-chart.sh --plan | --package

  --plan     print the exact packaging plan; performs no filesystem mutation
  --package  lint, render, package, and record the archive digest locally

Optional:
  T4_CHART_OUTPUT_DIR  output directory (default artifacts/cluster-chart)
  HELM, NODE           tool overrides
USAGE
  exit 64
}

mode=${1:-}
[ "$#" -eq 1 ] || usage
case "$mode" in
  --plan) print_plan; exit 0 ;;
  --package) ;;
  *) usage ;;
esac

# Publication is out of scope for this harness by construction. Refuse loudly
# rather than let a caller believe an environment variable enabled a push.
if [ -n "${T4_CHART_PUBLISH:-}" ] || [ -n "${HELM_EXPERIMENTAL_OCI_PUSH:-}" ]; then
  echo "package-chart.sh never publishes; remove T4_CHART_PUBLISH/HELM_EXPERIMENTAL_OCI_PUSH" >&2
  exit 64
fi

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
helm=${HELM:-helm}
node=${NODE:-node}
chart_directory=$repo_root/deploy/charts/t4-cluster
output_directory=${T4_CHART_OUTPUT_DIR:-$repo_root/artifacts/cluster-chart}

render=$(mktemp)
listing=$(mktemp)
trap 'rm -f "$render" "$listing"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

"$node" "$repo_root/scripts/cluster-ci/chart-capabilities.mjs"
"$helm" lint "$chart_directory"
"$helm" template t4-cluster "$chart_directory" --namespace t4-system --skip-crds >"$render"
if grep -q '[^[:space:]]' "$render"; then
  echo "default values must render nothing; the chart is default-off" >&2
  exit 65
fi

mkdir -p "$output_directory"
"$helm" package "$chart_directory" --destination "$output_directory" >/dev/null

# Only chart-level metadata is unindented in Chart.yaml, so a column-anchored
# read cannot pick up an annotation value.
chart_field() {
  sed -n "s/^$1:[[:space:]]*//p" "$chart_directory/Chart.yaml" | head -1 | tr -d '"'
}
chart_name=$(chart_field name)
chart_version=$(chart_field version)
app_version=$(chart_field appVersion)
[ -n "$chart_name" ] && [ -n "$chart_version" ] && [ -n "$app_version" ] ||
  { echo "Chart.yaml is missing name, version, or appVersion" >&2; exit 65; }
archive="$output_directory/$chart_name-$chart_version.tgz"
[ -s "$archive" ] || { echo "helm package did not produce $archive" >&2; exit 65; }

tar -tzf "$archive" >"$listing"
for required in \
  "$chart_name/Chart.yaml" \
  "$chart_name/values.yaml" \
  "$chart_name/values.schema.json" \
  "$chart_name/capabilities.yaml" \
  "$chart_name/templates/NOTES.txt" \
  "$chart_name/crds/t4clusterhosts.cluster.t4.dev.yaml" \
  "$chart_name/crds/t4workspaces.cluster.t4.dev.yaml" \
  "$chart_name/crds/t4sessions.cluster.t4.dev.yaml"
do
  grep -Fqx "$required" "$listing" || { echo "packaged archive is missing $required" >&2; exit 65; }
done
crd_count=$(grep -c "^$chart_name/crds/" "$listing")
[ "$crd_count" -eq 3 ] || { echo "packaged archive carries $crd_count CRD files, expected exactly 3" >&2; exit 65; }
if grep -q '\.tgz$' "$listing"; then
  echo "packaged archive contains a nested chart archive" >&2
  exit 65
fi

archive_sha256=$(
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$archive" | cut -d' ' -f1
  else shasum -a 256 "$archive" | cut -d' ' -f1
  fi
)
archive_bytes=$(wc -c <"$archive" | tr -d ' ')

manifest="$output_directory/chart-package.json"
cat >"$manifest" <<EOF
{
  "schemaVersion": "t4-cluster-chart-package/1",
  "chart": "$chart_name",
  "version": "$chart_version",
  "appVersion": "$app_version",
  "archive": "$archive",
  "archiveBytes": $archive_bytes,
  "archiveSha256": "$archive_sha256",
  "published": false,
  "publicationNote": "Local packaging only. Pushing this archive is a separate, explicitly approved action."
}
EOF

cat <<EOF
packaged $chart_name $chart_version (appVersion $app_version)
archive: $archive
sha256:  $archive_sha256
manifest: $manifest
Nothing was published. A registry push is a separate approved action.
EOF
