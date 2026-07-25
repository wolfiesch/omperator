#!/bin/bash
#
# build-mac.sh — build Enclave on the remote Mac from the Linux workstation.
#
# If the local working tree has uncommitted changes in tracked files, they are
# synced to the Mac via SCP before building. If the working tree is clean, the
# Mac pulls the latest commit from origin and builds.
#
# This script does NOT commit or push. Run git commit/push first.
#
# Usage:
#   ./build-mac.sh
#
set -euo pipefail

# ── config ───────────────────────────────────────────────────────────
MAC_HOST="${MAC_HOST:-macbookpro.local}"
MAC_PATH="${MAC_PATH:-/Users/alexis/Enclave}"
SCHEME="${SCHEME:-Enclave}"
DESTINATION="${DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro}"
# ─────────────────────────────────────────────────────────────────────

cd "$(git rev-parse --show-toplevel)"

BRANCH=$(git branch --show-current)
TRACKED_CHANGED=$(git diff --name-only HEAD)

# If the tree is clean but local is ahead of origin, the Mac cannot pull the
# latest source. Fail early so the caller pushes first.
if [ -z "$TRACKED_CHANGED" ] && [ "$(git rev-list --count "origin/$BRANCH"..HEAD 2>/dev/null || echo 0)" -ne 0 ]; then
    echo "Error: local branch '$BRANCH' is ahead of origin/$BRANCH. Push first."
    exit 1
fi

# Reset any tracked-file changes on the Mac build machine so pulls or syncs
# never conflict with stale SCP state.
echo "Resetting tracked files on $MAC_HOST..."
ssh "$MAC_HOST" "cd '$MAC_PATH' && git checkout -- ."

# Pull the latest origin first so the Mac has any fixes that are already committed
# but not yet present locally, even when we are about to overlay local changes.
echo "Pulling latest on $MAC_HOST..."
ssh "$MAC_HOST" "cd '$MAC_PATH' && git pull origin '$BRANCH'"

# Determine whether we have tracked local changes to sync, or should leave the tree clean.
if [ -n "$TRACKED_CHANGED" ]; then
    echo "Tracked local changes detected; syncing to $MAC_HOST..."
    git diff --name-status HEAD | while IFS=$'\t' read -r status file; do
        [ -n "$file" ] || continue
        case "$status" in
            M|A)
                dir=$(dirname "$file")
                ssh "$MAC_HOST" "mkdir -p '$MAC_PATH/$dir'"
                scp "$file" "$MAC_HOST:$MAC_PATH/$file"
                ;;
            D)
                ssh "$MAC_HOST" "rm -f '$MAC_PATH/$file'"
                ;;
        esac
    done
else
    echo "Working tree clean; pulling latest on $MAC_HOST..."
    ssh "$MAC_HOST" "cd '$MAC_PATH' && git pull origin '$BRANCH'"
fi

echo "Building on $MAC_HOST..."
ssh "$MAC_HOST" "cd '$MAC_PATH' && xcodegen generate && xcodebuild -scheme '$SCHEME' -destination '$DESTINATION' build"
