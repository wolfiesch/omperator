param(
    [string]$Image = "omperator-linux-v2-capture:swift-6.1"
)

$ErrorActionPreference = "Stop"
$windowsRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath((Join-Path $windowsRoot "..\.."))
$linuxCommit = "d4fb75ff3cf24dbd4981948dc4c2d1a685c9b887"
$artifactRoot = Join-Path $windowsRoot ".build\linux-v2-parity"
$linuxCaptureRoot = Join-Path $artifactRoot "linux"
New-Item -ItemType Directory -Force -Path $linuxCaptureRoot | Out-Null
$sourceArchive = Join-Path $linuxCaptureRoot "pinned-linux-source.tar"
git -C $repoRoot archive --format=tar --output=$sourceArchive $linuxCommit apps/linux apps/ios/HostWire apps/ios/Sources packages/fixture-server packages/host-wire packages/protocol scripts/run-fixture-host.mts spike-gtk-linux
if ($LASTEXITCODE -ne 0) {
    throw "Could not archive the pinned Linux source."
}
$dockerfile = Join-Path $PSScriptRoot "Dockerfile.linux-v2-capture"
docker build --file $dockerfile --tag $Image $PSScriptRoot
if ($LASTEXITCODE -ne 0) {
    throw "Could not build the Linux capture image."
}

$script = @'
set -eu
mkdir -p /src /home/alexis/dev/omperator
tar -xf /artifacts/pinned-linux-source.tar -C /src
ln -s /src/spike-gtk-linux /home/alexis/dev/omperator/spike-gtk-linux
cd /src/apps/linux
swift package resolve --scratch-path /tmp/t4-linux-build
# The pinned Linux patch omits the final context line in its first two hunks.
# Apply the corrected capture copy without changing the pinned source archive.
if git -C /tmp/t4-linux-build/checkouts/swift-cross-ui apply --check /repo/apps/windows/Scripts/swift-cross-ui-scroll-bottom-anchor.patch; then
  git -C /tmp/t4-linux-build/checkouts/swift-cross-ui apply /repo/apps/windows/Scripts/swift-cross-ui-scroll-bottom-anchor.patch
fi
mkdir -p /tmp/fixture-deps
printf '{"private":true}\n' >/tmp/fixture-deps/package.json
(cd /tmp/fixture-deps && bun add --exact ws@8.21.0)
mkdir -p /tmp/fixture-deps/node_modules/@t4-code
ln -s /src/packages/host-wire /tmp/fixture-deps/node_modules/@t4-code/host-wire
ln -s /src/packages/protocol /tmp/fixture-deps/node_modules/@t4-code/protocol
ln -s /tmp/fixture-deps/node_modules /src/node_modules
dbus-run-session -- bash -lc 'printf "fixture-keyring\n" | gnome-keyring-daemon --unlock --components=secrets >/tmp/keyring.env && cd /src/apps/linux && swift test --scratch-path /tmp/t4-linux-build'
git apply --no-index --unsafe-paths --directory=/src /repo/apps/windows/Scripts/linux-v2-capture-state.patch
swift build -c debug --product T4CodeLinuxGtk --scratch-path /tmp/t4-linux-build
mkdir -p /artifacts
capture() {
  name="$1"; shift
  width="$1"; shift
  height="$1"; shift
  rm -f /tmp/.X99-lock
  Xvfb :99 -screen 0 "${width}x${height}x24" -nolisten tcp >/tmp/xvfb.log 2>&1 &
  xvfb_pid=$!
  export DISPLAY=:99
  export GDK_BACKEND=x11
  export GSK_RENDERER=cairo
  export NO_AT_BRIDGE=1
  export GTK_A11Y=none
  export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
  sleep 1
  dbus-run-session -- /tmp/t4-linux-build/debug/T4CodeLinuxGtk "$@" >/tmp/t4-linux.log 2>&1 &
  app_pid=$!
  sleep 5
  window_id="$(xdotool search --onlyvisible --name 'T4 Code' 2>/dev/null | sed -n '1p' || true)"
  if [ -n "$window_id" ]; then
    xdotool windowsize "$window_id" "$width" "$height"
    sleep 1
    import -display :99 -window "$window_id" "/artifacts/${name}.png"
  else
    import -display :99 -window root "/artifacts/${name}.png"
  fi
  kill "$app_pid" 2>/dev/null || true
  wait "$app_pid" 2>/dev/null || true
  cp /tmp/t4-linux.log "/artifacts/${name}.log"
  cp /tmp/xvfb.log "/artifacts/${name}-xvfb.log"
  kill "$xvfb_pid" 2>/dev/null || true
  wait "$xvfb_pid" 2>/dev/null || true
}
capture onboarding 1280 800 -T4NoRestore
capture workspace 1280 800 -T4Demo -T4CaptureState=workspace
capture friendly-rail 1280 800 -T4Demo -T4CaptureState=workspace
capture user-message 1280 800 -T4Demo -T4CaptureState=workspace
capture streaming 1280 800 -T4Demo -T4DemoStream -T4CaptureState=streaming
capture markdown 1280 800 -T4Demo -T4CaptureState=workspace
capture browser 1280 800 -T4Demo -T4CaptureState=browser
capture settings-closed 1280 800 -T4Demo -T4CaptureState=workspace
capture settings-open 1280 800 -T4Demo -T4CaptureState=settings
capture sidebar-shown 1280 800 -T4Demo -T4CaptureState=workspace
capture sidebar-hidden 1280 800 -T4Demo -T4CaptureState=sidebar-hidden
capture compact 440 560 -T4Demo -T4CaptureState=compact
capture normal 1280 800 -T4Demo -T4CaptureState=workspace
capture moon 1280 800 -T4Demo -T4CaptureState=moon
capture dawn 1280 800 -T4Demo -T4CaptureState=dawn
capture narrow 900 700 -T4Demo -T4CaptureState=narrow
capture standard 1280 800 -T4Demo -T4CaptureState=workspace
capture wide 1600 900 -T4Demo -T4CaptureState=wide
'@
$captureScript = Join-Path $linuxCaptureRoot "capture-linux-v2.sh"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($captureScript, $script, $utf8NoBom)

# The repository is mounted read-only so the exact pinned source remains
# unchanged. Swift build products and captures live in private Docker volumes.
docker run --rm `
    --mount "type=bind,source=$repoRoot,target=/repo,readonly" `
    --mount "type=volume,source=omperator-linux-v2-swift-build,target=/tmp/t4-linux-build" `
    --mount "type=bind,source=$linuxCaptureRoot,target=/artifacts" `
    $Image bash /artifacts/capture-linux-v2.sh
if ($LASTEXITCODE -ne 0) {
    throw "Linux reference capture container failed with exit code $LASTEXITCODE."
}

Write-Output $linuxCaptureRoot
