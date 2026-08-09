# Omperator Native Windows Client

Swift + SwiftPM + SwiftCrossUI client using the pinned native WinUI 3 backend. It connects to the existing `t4-host` through `HostWire`; it does not embed OMP or create another runtime authority.

## Toolchain and runtime

Use the **x64 Native Tools Command Prompt for VS 2022** or PowerShell initialized with the Visual Studio C++ toolchain.

Required:

- Swift 6.3.3 or newer for Windows (`x86_64-unknown-windows-msvc`)
- Visual Studio 2022 C++ build tools
- Windows SDK 10.0.17763 or newer
- Windows App Runtime 1.5 required by the pinned SwiftCrossUI/`swift-winui` graph

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
swift build
swift test
```

SwiftPM can print `pkg-config` warnings for GTK system-library declarations while evaluating SwiftCrossUI's cross-platform package manifest. The Windows targets depend directly on `WinUIBackend`; they do not import or link GTK.

## Launch the native demo

After `swift build`:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo
```

Deterministic capture options:

```powershell
.\.build\debug\T4CodeWindows.exe -T4Demo -T4Theme=dark -T4WindowSize=1280x800
.\.build\debug\T4CodeWindows.exe -T4Demo -T4Theme=light -T4WindowSize=1600x1000
```

Supported first-milestone launch seams:

- `-T4Demo` enables deterministic offline sessions and transcript content. Fake content never appears without this explicit flag.
- `-T4Theme=dark|light|system` selects the Rosé Pine Moon/Dawn appearance or follows Windows.
- `-T4WindowSize=<width>x<height>` sets initial client geometry; malformed or non-positive values fall back to `1280x800`.

## Package layout

- `Sources/T4CodeWindows/` — thin `@main` executable; imports `WinUIBackend` and creates the native window.
- `Sources/T4CodeWindowsLib/` — testable launch parsing, Windows identity seam, portable demo models, Linux-parity theme tokens, and SwiftCrossUI views.
- `Tests/T4CodeWindowsLibTests/` — launch-contract, identity, and deterministic-demo tests.

SwiftCrossUI is pinned to revision `199a85614e3b2346aa10736b12f969af14a1f1ea`, matching `apps/linux/Package.swift`. `HostWire` is consumed directly from `apps/ios/HostWire`.
