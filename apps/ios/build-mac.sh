#!/bin/bash
#
# build-mac.sh — build the iOS app on a remote Mac from a Linux workstation.
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
# The checkout path on the Mac. There is no safe default: $HOME here would
# expand to the workstation's home and then be sent over ssh, so require it.
MAC_PATH="${MAC_PATH:?set MAC_PATH to the repository path on $MAC_HOST}"
SCHEME="${SCHEME:-T4Code}"
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
    # scp/ssh inside a read loop MUST get /dev/null as stdin: left alone they
    # drain the loop's file list and silently skip every file after the first.
    git diff --name-status HEAD | while IFS=$'\t' read -r status file; do
        [ -n "$file" ] || continue
        case "$status" in
            M|A)
                dir=$(dirname "$file")
                ssh "$MAC_HOST" "mkdir -p '$MAC_PATH/$dir'" < /dev/null
                scp "$file" "$MAC_HOST:$MAC_PATH/$file" < /dev/null
                ;;
            D)
                ssh "$MAC_HOST" "rm -f '$MAC_PATH/$file'" < /dev/null
                ;;
        esac
    done
else
    echo "Working tree clean; pulling latest on $MAC_HOST..."
    ssh "$MAC_HOST" "cd '$MAC_PATH' && git pull origin '$BRANCH'"
fi

echo "Building on $MAC_HOST..."
ssh "$MAC_HOST" "cd '$MAC_PATH/apps/ios' && xcodegen generate && xcodebuild -scheme '$SCHEME' -destination '$DESTINATION' build"
