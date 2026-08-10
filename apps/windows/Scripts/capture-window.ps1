param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$ProcessName = "T4CodeWindows",
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$WaitSeconds = 15,
    [double]$SettleSeconds = 3
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class T4WindowCaptureNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
}
"@

[T4WindowCaptureNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$process = $null
while ([DateTime]::UtcNow -lt $deadline) {
    $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($null -ne $process) { break }
    Start-Sleep -Milliseconds 100
}
if ($null -eq $process) { throw "No visible $ProcessName window appeared within $WaitSeconds seconds." }

$handle = $process.MainWindowHandle
[T4WindowCaptureNative]::ShowWindow($handle, 9) | Out-Null
if ($Width -gt 0 -and $Height -gt 0) {
    if (-not [T4WindowCaptureNative]::MoveWindow($handle, 40, 40, $Width, $Height, $true)) {
        throw "MoveWindow failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }
}
$noMoveOrResize = 0x0013
if (-not [T4WindowCaptureNative]::SetWindowPos(
        $handle, [IntPtr](-1), 0, 0, 0, 0, $noMoveOrResize)) {
    throw "SetWindowPos(HWND_TOPMOST) failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
}
try {
    [T4WindowCaptureNative]::SetForegroundWindow($handle) | Out-Null
    Start-Sleep -Milliseconds ([int]($SettleSeconds * 1000))

    $rect = New-Object T4WindowCaptureNative+Rect
    if (-not [T4WindowCaptureNative]::GetWindowRect($handle, [ref]$rect)) {
        throw "GetWindowRect failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }
    $bitmapWidth = $rect.Right - $rect.Left
    $bitmapHeight = $rect.Bottom - $rect.Top
    if ($bitmapWidth -le 0 -or $bitmapHeight -le 0) { throw "The target window has invalid bounds." }

    $absoluteOutput = [IO.Path]::GetFullPath($OutputPath)
    $directory = [IO.Path]::GetDirectoryName($absoluteOutput)
    if (-not [IO.Directory]::Exists($directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }

    $bitmap = New-Object Drawing.Bitmap $bitmapWidth, $bitmapHeight
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
        $bitmap.Save($absoluteOutput, [Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
} finally {
    [T4WindowCaptureNative]::SetWindowPos(
        $handle, [IntPtr](-2), 0, 0, 0, 0, $noMoveOrResize) | Out-Null
}
Write-Output $absoluteOutput
