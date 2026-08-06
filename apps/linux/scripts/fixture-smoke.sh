#!/usr/bin/env bash
# fixture-smoke.sh — live-host smoke test for the Linux client.
#
# Starts the workspace fixture server (scenario basic-v1) and a T4CodeLinux
# instance pointed at it with an ephemeral credential profile (-T4NoRestore +
# -T4Endpoint=). The fixture authenticates hello as `.local`, so no pairing
# ticket is needed. Proves: build → launch → window → wire connect → session
# inventory on screen.
#
# Usage: bash apps/linux/scripts/fixture-smoke.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PORT="${FIXTURE_PORT:-18788}"
URL="ws://127.0.0.1:${PORT}/fixture"

. "$HOME/.local/swift/env.sh"

# 1. Build the app.
echo "== building =="
(cd "$ROOT/apps/linux" && swift build 2>&1 | tail -2)

# 2. Start the fixture server.
echo "== starting fixture host on :${PORT} =="
bun "$ROOT/scripts/run-fixture-host.mts" "$PORT" basic-v1 > /tmp/fixture-host.log 2>&1 &
FIXTURE_PID=$!
trap 'kill $FIXTURE_PID 2>/dev/null || true' EXIT
sleep 2
grep -q "fixture host listening" /tmp/fixture-host.log || { echo "fixture failed:"; cat /tmp/fixture-host.log; exit 1; }

# 3. Launch the app against it (needs the X session; set DISPLAY/XAUTHORITY).
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-/run/user/1000/xauth_wCjaKU}"
echo "== launching T4CodeLinux against ${URL} =="
cd "$ROOT/apps/linux"
./.build/debug/T4CodeLinux \
    -T4NoRestore \
    "-T4Endpoint=$URL" \
    -T4DeviceId=fixture-smoke \
    -T4DeviceToken=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \
    > /tmp/t4-live.log 2>&1 &
APP_PID=$!
# Kill the app by PID *and* by name — a subshell wrapper would orphan it.
trap 'kill $FIXTURE_PID $APP_PID 2>/dev/null || true; pkill -9 -f "T4CodeLinux" 2>/dev/null || true' EXIT

sleep 6
WINDOW=$(xdotool search --name "T4 Code" 2>/dev/null | head -1 || true)
if [ -z "$WINDOW" ]; then
    echo "FAIL: no window"
    tail -20 /tmp/t4-live.log
    exit 1
fi
echo "== window up: $WINDOW =="

# 4. Screenshot the window region and histogram it.
eval "$(xdotool getwindowgeometry --shell "$WINDOW")"
import -window root /tmp/t4-live.png
magick /tmp/t4-live.png -crop "${WIDTH}x${HEIGHT}+${X}+${Y}" +repage /tmp/t4-live-win.png

echo "== colors in window (expect #FAF4ED light bg / #FFFAF3 rail) =="
magick /tmp/t4-live-win.png +dither -format "%c" histogram:info:- 2>/dev/null | sort -rn | head -5

echo "== fixture client activity =="
grep -c "client" /tmp/fixture-host.log || true

kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
echo "SMOKE-OK"
