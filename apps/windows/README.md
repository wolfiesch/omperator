# Omperator Native Windows Client

Swift + SwiftPM + SwiftCrossUI client using the pinned native WinUI 3 backend. It connects to the existing `t4-host` through `HostWire`; it does not embed OMP or create another runtime authority.

## Toolchain and runtime

Use the **x64 Native Tools Command Prompt for VS 2022** or PowerShell initialized with the Visual Studio C++ toolchain.

Required:

- Swift 6.3.3 or newer for Windows (`x86_64-unknown-windows-msvc`)
- Visual Studio 2022 C++ build tools
- Windows SDK 10.0.17763 or newer
- Windows App Runtime 1.5 required by the pinned SwiftCrossUI/`swift-winui` graph
- Bun on `PATH` (or its absolute path in `BUN_EXE`) for fixture integration tests
- Root workspace dependencies installed with `pnpm install --frozen-lockfile`

Install the SDK from PowerShell if it is missing:

```powershell
winget install --id Microsoft.WindowsSDK.10.0.17763
```

Install the exact x64 Windows App Runtime named by the pinned SwiftCrossUI documentation:

```powershell
$runtimeInstaller = Join-Path $env:TEMP "windowsappruntimeinstall-x64.exe"
curl.exe -L --fail --output $runtimeInstaller "https://aka.ms/windowsappsdk/1.5/1.5.240205001-preview1/windowsappruntimeinstall-x64.exe"
Get-AuthenticodeSignature $runtimeInstaller | Format-List Status,SignerCertificate
& $runtimeInstaller --quiet
Remove-Item $runtimeInstaller
```

The signature must report `Valid` and a Microsoft Corporation certificate before execution. Without the matching runtime lifetime-manager package, the executable opens a Windows dialog titled `T4CodeWindows.exe - This application could not be started` instead of the app window.

## Verify shared HostWire on Windows

From the repository root:

```powershell
Set-Location apps\ios\HostWire
swift build
swift test
Set-Location ..\..\..
```

The current Windows baseline is 21 tests across the `HostClientTests`, `HostWireFixtureTests`, and `LiveTranscriptTests` suites.

## Build and test the Windows client

```powershell
Set-Location apps\windows
swift package resolve
.\Scripts\prepare-dependencies.ps1
swift build
swift test
```

SwiftPM can print `pkg-config` warnings for GTK system-library declarations while evaluating SwiftCrossUI's cross-platform package manifest. The Windows targets depend directly on `WinUIBackend`; they do not import or link GTK.

`prepare-dependencies.ps1` idempotently applies
`patches/swift-winui-webview2-sta.patch` to the pinned `swift-winui` checkout.
The pinned backend otherwise initializes the WinUI thread as MTA; native
WebView2 requires the XAML UI thread to remain STA and fails with
`0x80010106 (RPC_E_CHANGED_MODE)`. The script fails closed if the pinned source
no longer matches either the original or patched form.

The executable target passes MSVC `/STACK:8388608`. Windows' 1 MiB default is
not sufficient to materialize the source-aligned SwiftCrossUI workspace's
deeply nested generic view metadata.

## Exercise the deterministic host flow

The Windows tests launch `scripts/run-fixture-host.mts` on ephemeral loopback
ports. The HostWire probe covers hello/welcome, inventory, catalog, attach,
snapshot, invalid-token rejection, and clean disconnect. The shared-store probe
additionally sends a prompt, observes the live streaming projection, forces an
unclean socket drop, verifies automatic reconnect, and sends again:

```powershell
Set-Location apps\windows
swift test --filter HostWireFixtureIntegrationTests
swift test --filter T4SessionStoreFixtureIntegrationTests
swift test --filter T4PaneBehaviorTests
```

The shared `URLSessionHostWireTransport` is exercised directly for handshake
and small push frames. Swift Foundation on Windows can expose a single large
WebSocket text message as variably sized libcurl callbacks.
`WindowsURLSessionHostWireTransport` structurally rejoins those callbacks into
one complete JSON frame before passing it to `HostClient`. The fixture's catalog
response guards that production store path.

The pane behavior suite exercises the real shared-store paths for
`files.list`, `files.read`, `files.search`, `files.diff`, agent and review
push projections, `usage.read`, `settings.read`, and confirmation-backed
`settings.write`. It also verifies inbox priority, command-palette
availability, artifact extraction, plan progress, ask dismissal, and that
normal launches never substitute demo pane data.

Fixture coverage remains intentionally honest: `basic-v1` currently returns
an incomplete `review.read` result and no `artifact.read` payload, artifacts,
todo phases, ask request, or attention flags. Those panes use their real
store-backed empty/error states. `-T4Demo` remains the only source of
deterministic visual sample content.

To exercise the same open-host prompt flow in the native window, run these in
separate PowerShell terminals:

```powershell
# Repository root
bun scripts/run-fixture-host.mts 18788 stream-v1

# apps\windows, after swift build
.\.build\debug\T4CodeWindows.exe `
  -T4OpenEndpoint=ws://127.0.0.1:18788/fixture `
  -T4NoRestore `
  -T4Send "Native Windows fixture prompt" `
  -T4SendSession session-stream
```

`-T4OpenEndpoint` connects without device credentials to a host that reports
local authentication. `-T4NoRestore` prevents unrelated saved state from
participating, and this QA path does not persist test credentials.

## Launch the native demo

After `swift build`:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo
```

Deterministic visual-parity capture commands:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo -T4Theme=dark  -T4WindowSize=900x600
.\.build\debug\T4CodeWindows.exe -T4Demo -T4Theme=light -T4WindowSize=1280x800
.\.build\debug\T4CodeWindows.exe -T4Demo -T4Theme=dark  -T4WindowSize=1600x900
```

Supported first-milestone launch seams:

- `-T4Demo` enables deterministic offline sessions and transcript content. Fake content never appears without this explicit flag.
- `-T4Theme=dark|light|system` selects the Rosé Pine Moon/Dawn appearance or follows Windows.
- `-T4WindowSize=<width>x<height>` sets initial client geometry; malformed or non-positive values fall back to `1280x800`.

Pane capture seams are also available for deterministic development checks:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowSheet=files
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=1600x900 -T4ShowSheet=searchDiff -T4SearchMode=diff
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowSheet=agents
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowSheet=review
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=1600x900 -T4ShowSheet=artifacts
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=900x600  -T4ShowInbox
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=900x600  -T4ShowPalette
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowSheet=usage
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=1280x800 -T4ShowSheet=settings
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowPlan
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowAsk
```

`-T4ShowSheet` accepts `files`, `searchDiff`, `agents`, `usage`, `review`,
`artifacts`, `settings`, and `browser`. `-T4ShowBrowser` is the direct browser
capture alias. Add `-T4BrowserFixture` with `-T4Demo` to load the deterministic
native WebView2 history, popup, and scrolling page instead of a network URL.
`-T4SearchQuery=<text>` opens Search with a deterministic query. `-T4ShowPlan`
expands the plan strip, while `-T4ShowAsk` injects the capture request only when
`-T4Demo` is also present. Normal launches never synthesize pane content.

## Verify the native WebView2 browser

From `apps\windows`, prepare the pinned dependency, run the focused state and
lifecycle contracts, then launch the embedded fixture:

```powershell
.\Scripts\prepare-dependencies.ps1
swift test --filter T4WindowsBrowserTests
.\.build\debug\T4CodeWindows.exe `
  -T4Demo `
  -T4NoRestore `
  -T4Theme=dark `
  -T4WindowSize=1280x800 `
  -T4ShowBrowser `
  -T4BrowserFixture
```

For the six browser capture baselines, launch each command from
`apps\windows`; save the resulting window image under `.build\`:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=900x600  -T4ShowBrowser -T4BrowserFixture
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=900x600  -T4ShowBrowser -T4BrowserFixture
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=1280x800 -T4ShowBrowser -T4BrowserFixture
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1280x800 -T4ShowBrowser -T4BrowserFixture
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=dark  -T4WindowSize=1600x900 -T4ShowBrowser -T4BrowserFixture
.\.build\debug\T4CodeWindows.exe -T4Demo -T4NoRestore -T4Theme=light -T4WindowSize=1600x900 -T4ShowBrowser -T4BrowserFixture
```

The browser is a WinUI `WebView2` hosted directly by SwiftCrossUI's
`WinUIElementRepresentable`; no browser window, Electron surface, or second
runtime authority is created. The fixture verifies rendered HTML, Back and
Forward history, Reload and Stop command routing, `_blank` interception into
the same pane, title/loading state, scrolling, resize behavior, per-session
surface isolation, and close/reopen cleanup. For an HTTP navigation check,
serve the fixture in another terminal and enter the shown URL in the pane:

```powershell
Set-Location apps\windows\Sources\T4CodeWindowsLib\Resources
python -m http.server 8765 --bind 127.0.0.1
# Enter http://127.0.0.1:8765/BrowserFixture.html in Omperator.
```

Deterministic browser captures may be stored under `apps\windows\.build\`;
that directory is ignored and must not be committed.

## Pane behavior and fixture limits

Run the pane contract suite from `apps/windows`:

```powershell
swift test --filter T4PaneBehaviorTests
```

The `basic-v1` fixture exercises the live HostWire paths for file list/read,
search, diff, review, usage, and confirmed settings writes. It also supplies
live agent and review frames. The current fixture does not emit artifact
entries, todo phases, attention-bearing session combinations, or ask
requests/prompt leases. Those derivations are covered with typed store-model
tests; `-T4Demo` supplies only their visual smoke data. An ask dismissal is
model-tested, but a full `session.ui.respond` wire round trip remains blocked
until a fixture scenario emits the matching request and lease.

## Package layout

- `Sources/T4CodeWindows/` — thin `@main` executable; imports `WinUIBackend` and creates the native window.
- `Sources/T4CodeWindowsLib/Store/` — source-aligned links to the Linux `T4SessionStore` and domain models.
- `Sources/T4CodeWindowsLib/Views/` — source links to the Linux panes, inline cards, workspace components, theme, and view primitives, plus Windows-owned browser, pairing, and deferred terminal surfaces.
- `Sources/T4CodeWindowsLib/Platform/` — Windows launch parsing, identity, credential placeholder, WinUI environment gaps, the native WebView2 representable and per-session browser state, and the tested URLSession HostWire transport.
- `Scripts/` and `patches/` — the fail-closed preparation step and minimal pinned WinUI STA startup correction required by WebView2.
- `Tests/T4CodeWindowsLibTests/` — launch, identity, credential-seam, browser lifecycle, pane behavior, and deterministic host-flow integration tests.

Most Store and shared View entries are relative source links; the Windows root
and adapted workspace are local files. Enable Windows Developer Mode (or run
Git with symlink privileges) so checkout preserves links instead of plain text
files.

SwiftCrossUI is pinned to revision `199a85614e3b2346aa10736b12f969af14a1f1ea`, matching `apps/linux/Package.swift`. `HostWire` is consumed directly from `apps/ios/HostWire`.
