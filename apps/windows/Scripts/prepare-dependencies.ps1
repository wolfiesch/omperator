param()

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $PSScriptRoot
$ResolvedPath = Join-Path $PackageRoot "Package.resolved"
$CheckoutRoot = Join-Path $PackageRoot ".build\checkouts\swift-winui"
$SourcePath = Join-Path $CheckoutRoot "Sources\WinUI\Application\SwiftApplication.swift"

Push-Location $PackageRoot
try {
    & swift package resolve
    if ($LASTEXITCODE -ne 0) {
        throw "swift package resolve failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$resolved = Get-Content -Raw $ResolvedPath | ConvertFrom-Json
$swiftCrossUI = $resolved.pins | Where-Object { $_.identity -eq "swift-cross-ui" }
$swiftWinUI = $resolved.pins | Where-Object { $_.identity -eq "swift-winui" }
if ($swiftCrossUI.state.revision -ne "199a85614e3b2346aa10736b12f969af14a1f1ea") {
    throw "Refusing to patch an unexpected swift-cross-ui revision."
}
if ($swiftWinUI.state.revision -ne "df7642fbb88e23a9cc1bbd366c7d6d3780fd0251") {
    throw "Refusing to patch an unexpected swift-winui revision."
}
if (-not (Test-Path $SourcePath)) {
    throw "Pinned swift-winui checkout was not found at $SourcePath"
}

$original = "WindowsAppRuntimeInitializer(threadingModel: .multi)"
$replacement = "WindowsAppRuntimeInitializer(threadingModel: .single)"
$source = [IO.File]::ReadAllText($SourcePath)
if ($source.Contains($replacement)) {
    Write-Host "swift-winui WebView2 STA patch already applied."
    exit 0
}

$matchCount = [regex]::Matches($source, [regex]::Escape($original)).Count
if ($matchCount -ne 1) {
    throw "Pinned swift-winui startup source did not contain the expected single patch site."
}

$patched = $source.Replace($original, $replacement)
$utf8WithoutBOM = New-Object System.Text.UTF8Encoding($false)
$sourceFile = Get-Item $SourcePath
if ($sourceFile.IsReadOnly) {
    $sourceFile.IsReadOnly = $false
}
[IO.File]::WriteAllText($SourcePath, $patched, $utf8WithoutBOM)
Write-Host "Applied patches/swift-winui-webview2-sta.patch to the pinned checkout."
