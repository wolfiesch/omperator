#!/usr/bin/env bash
set -euo pipefail

lock_dir="${TMPDIR:-/tmp}/wolfie-m1-ci.lock"
owner_file="$lock_dir/owner"
deadline=$((SECONDS + 1800))

while ! mkdir "$lock_dir" 2>/dev/null; do
  owner_pid="$(sed -n '1p' "$owner_file" 2>/dev/null || true)"
  if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
    rm -rf "$lock_dir"
    continue
  fi
  if (( SECONDS >= deadline )); then
    echo "timed out waiting for the shared M1 CI slot" >&2
    exit 75
  fi
  sleep 5
done

printf '%s\n' "$$" > "$owner_file"
cleanup() {
  rm -rf "$lock_dir"
}
trap cleanup EXIT INT TERM

free_kib="$(df -Pk / | awk 'NR == 2 { print $4 }')"
if (( free_kib < 12 * 1024 * 1024 )); then
  echo "M1 CI requires at least 12 GiB free; found $((free_kib / 1024 / 1024)) GiB" >&2
  exit 1
fi

"$@"
