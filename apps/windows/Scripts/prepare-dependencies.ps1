param()

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path -Parent $PSScriptRoot
$ResolvedPath = Join-Path $PackageRoot "Package.resolved"
$SwiftWinUICheckoutRoot = Join-Path $PackageRoot ".build\checkouts\swift-winui"
$SwiftWinUISourcePath = Join-Path $SwiftWinUICheckoutRoot "Sources\WinUI\Application\SwiftApplication.swift"
$SwiftCrossUICheckoutRoot = Join-Path $PackageRoot ".build\checkouts\swift-cross-ui"
$SwiftCrossUIPatchPath = Join-Path $PackageRoot "patches\swift-cross-ui-linux-density.patch"
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
if (-not (Test-Path $SwiftWinUISourcePath)) {
    throw "Pinned swift-winui checkout was not found at $SwiftWinUISourcePath"
}
if (-not (Test-Path $SwiftCrossUICheckoutRoot)) {
    throw "Pinned swift-cross-ui checkout was not found at $SwiftCrossUICheckoutRoot"
}
if (-not (Test-Path $SwiftCrossUIPatchPath)) {
    throw "SwiftCrossUI density patch was not found at $SwiftCrossUIPatchPath"
}

$original = "WindowsAppRuntimeInitializer(threadingModel: .multi)"
$replacement = "WindowsAppRuntimeInitializer(threadingModel: .single)"
$source = [IO.File]::ReadAllText($SwiftWinUISourcePath)
if ($source.Contains($replacement)) {
    Write-Host "swift-winui WebView2 STA patch already applied."
} else {
    $matchCount = [regex]::Matches($source, [regex]::Escape($original)).Count
    if ($matchCount -ne 1) {
        throw "Pinned swift-winui startup source did not contain the expected single patch site."
    }

    $patched = $source.Replace($original, $replacement)
    $utf8WithoutBOM = New-Object System.Text.UTF8Encoding($false)
    $sourceFile = Get-Item $SwiftWinUISourcePath
    if ($sourceFile.IsReadOnly) {
        $sourceFile.IsReadOnly = $false
    }
    [IO.File]::WriteAllText($SwiftWinUISourcePath, $patched, $utf8WithoutBOM)
    Write-Host "Applied patches/swift-winui-webview2-sta.patch to the pinned checkout."
}

Push-Location $SwiftCrossUICheckoutRoot
try {
    $savedErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & git apply --reverse --check -- $SwiftCrossUIPatchPath 2>$null
    $alreadyApplied = $LASTEXITCODE -eq 0

    if (-not $alreadyApplied) {
        & git apply --check -- $SwiftCrossUIPatchPath 2>$null
        $canApply = $LASTEXITCODE -eq 0
    }
    $ErrorActionPreference = $savedErrorActionPreference

    if ($alreadyApplied) {
        Write-Host "SwiftCrossUI density patch already applied."
    } elseif ($canApply) {
        & git apply -- $SwiftCrossUIPatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "Applying the SwiftCrossUI density patch failed."
        }
        Write-Host "Applied patches/swift-cross-ui-linux-density.patch to the pinned checkout."
    } else {
        throw "Pinned swift-cross-ui source matches neither side of the density patch."
    }
} finally {
    $ErrorActionPreference = "Stop"
    Pop-Location
}
