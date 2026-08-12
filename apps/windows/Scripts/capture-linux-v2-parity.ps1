param(
    [string]$Configuration = "debug"
)

$ErrorActionPreference = "Stop"
$windowsRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = [IO.Path]::GetFullPath((Join-Path $windowsRoot "..\.."))
$artifactRoot = Join-Path $windowsRoot ".build\linux-v2-parity"
$windowsCaptureRoot = Join-Path $artifactRoot "windows"
$workspaceTriple = $null
$workspaceState = Join-Path $windowsRoot ".build\workspace-state.json"
if (Test-Path $workspaceState) {
    $workspaceTriple = (Get-Content $workspaceState | ConvertFrom-Json).workspaceTriple
}
if ([string]::IsNullOrWhiteSpace($workspaceTriple)) {
    $workspaceTriple = "x86_64-unknown-windows-msvc"
}
$sourceRoot = Join-Path $windowsRoot ".build\$workspaceTriple\$Configuration"
$executable = Join-Path $sourceRoot "T4CodeWindows.exe"
if (-not (Test-Path $executable)) {
    throw "Build $executable before capturing."
}

$states = @(
    @{ Name = "onboarding"; Args = @("-T4Demo", "-T4CaptureState=onboarding", "-T4WindowSize=1280x800") },
    @{ Name = "workspace"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "friendly-rail"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "user-message"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "streaming"; Args = @("-T4Demo", "-T4DemoStream", "-T4CaptureState=streaming", "-T4WindowSize=1280x800") },
    @{ Name = "markdown"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "browser"; Args = @("-T4Demo", "-T4BrowserFixture", "-T4CaptureState=browser", "-T4WindowSize=1280x800") },
    @{ Name = "settings-closed"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "settings-open"; Args = @("-T4Demo", "-T4CaptureState=settings", "-T4WindowSize=1280x800") },
    @{ Name = "sidebar-shown"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "sidebar-hidden"; Args = @("-T4Demo", "-T4CaptureState=rail-hidden", "-T4WindowSize=1280x800") },
    @{ Name = "compact"; Args = @("-T4Demo", "-T4CaptureState=compact", "-T4WindowSize=440x560") },
    @{ Name = "normal"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "moon"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4Theme=dark", "-T4WindowSize=1280x800") },
    @{ Name = "dawn"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4Theme=light", "-T4WindowSize=1280x800") },
    @{ Name = "narrow"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=900x700") },
    @{ Name = "standard"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1280x800") },
    @{ Name = "wide"; Args = @("-T4Demo", "-T4CaptureState=workspace", "-T4WindowSize=1600x900") }
)

Push-Location $repoRoot
try {
    foreach ($state in $states) {
        $output = Join-Path $windowsCaptureRoot ($state.Name + ".png")
        $process = Start-Process -FilePath $executable -ArgumentList $state.Args -WorkingDirectory $repoRoot -PassThru
        try {
            & (Join-Path $PSScriptRoot "capture-window.ps1") `
                -OutputPath $output `
                -TargetProcessId $process.Id
        } finally {
            if (-not $process.HasExited) {
                $process.Kill()
                $process.WaitForExit(5000) | Out-Null
            }
        }
    }
} finally {
    Pop-Location
}

Write-Output $artifactRoot
