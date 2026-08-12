param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [string]$ProcessName = "T4CodeWindows",
    [int]$TargetProcessId = 0,
    [int]$Width = 0,
    [int]$Height = 0,
    [int]$WaitSeconds = 15,
    [double]$SettleSeconds = 3
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
public static class T4WindowCaptureNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(
        IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool PrintWindow(IntPtr handle, IntPtr deviceContext, uint flags);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
    public static bool HasRenderedContent(Bitmap image) {
        var colors = new HashSet<int>();
        int stepX = Math.Max(1, image.Width / 160);
        int stepY = Math.Max(1, image.Height / 100);
        for (int y = 0; y < image.Height; y += stepY) {
            for (int x = 0; x < image.Width; x += stepX) {
                colors.Add(image.GetPixel(x, y).ToArgb());
            }
        }
        var rightCenter = image.GetPixel(image.Width * 7 / 8, image.Height / 2);
        int rightBrightness = rightCenter.R + rightCenter.G + rightCenter.B;
        return colors.Count >= 48 && rightBrightness >= 30;
    }
}
"@ -ReferencedAssemblies System.Drawing

[T4WindowCaptureNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null

# Keep the capture target private and nonactivating. HWND_BOTTOM plus
# SWP_NOACTIVATE prevents this script from stealing foreground input.
$hwndBottom = [IntPtr](1)
$swpNoActivate = 0x0010
$swpShowWindow = 0x0040
$flags = $swpNoActivate -bor $swpShowWindow
if ($Width -le 0 -and $Height -le 0) {
    $swpNoSize = 0x0001
    $flags = $flags -bor $swpNoSize
}

$deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
$process = $null
$handle = [IntPtr]::Zero
$captureWidth = 0
$captureHeight = 0
while ([DateTime]::UtcNow -lt $deadline) {
    $candidates = if ($TargetProcessId -gt 0) {
        Get-Process -Id $TargetProcessId -ErrorAction SilentlyContinue
    } else {
        Get-Process -Name $ProcessName -ErrorAction SilentlyContinue
    }
    $candidate = $candidates |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
    if ($null -eq $candidate) {
        Start-Sleep -Milliseconds 100
        continue
    }

    $candidate.Refresh()
    $candidateHandle = $candidate.MainWindowHandle
    if ($candidateHandle -eq [IntPtr]::Zero -or
        -not [T4WindowCaptureNative]::IsWindow($candidateHandle)) {
        Start-Sleep -Milliseconds 100
        continue
    }

    $candidateRect = New-Object T4WindowCaptureNative+Rect
    if (-not [T4WindowCaptureNative]::GetWindowRect($candidateHandle, [ref]$candidateRect)) {
        Start-Sleep -Milliseconds 100
        continue
    }
    $candidateWidth = if ($Width -gt 0) { $Width } else { $candidateRect.Right - $candidateRect.Left }
    $candidateHeight = if ($Height -gt 0) { $Height } else { $candidateRect.Bottom - $candidateRect.Top }
    if ($candidateWidth -le 0 -or $candidateHeight -le 0) {
        Start-Sleep -Milliseconds 100
        continue
    }
    if (-not [T4WindowCaptureNative]::SetWindowPos(
            $candidateHandle, $hwndBottom, -32000, -32000, $candidateWidth, $candidateHeight, $flags)) {
        Start-Sleep -Milliseconds 100
        continue
    }

    $process = $candidate
    $handle = $candidateHandle
    $captureWidth = $candidateWidth
    $captureHeight = $candidateHeight
    break
}
if ($null -eq $process -or $handle -eq [IntPtr]::Zero) {
    throw "No stable $ProcessName window appeared within $WaitSeconds seconds."
}

$absoluteOutput = [IO.Path]::GetFullPath($OutputPath)
$directory = [IO.Path]::GetDirectoryName($absoluteOutput)
if (-not [IO.Directory]::Exists($directory)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}

try {
    $settleDeadline = [DateTime]::UtcNow.AddSeconds($SettleSeconds)
    while ([DateTime]::UtcNow -lt $settleDeadline) {
        Start-Sleep -Milliseconds 100
        if ($process.HasExited) {
            throw "$ProcessName exited before its window could be captured."
        }
        $process.Refresh()
        $currentHandle = $process.MainWindowHandle
        if ($currentHandle -ne [IntPtr]::Zero -and
            $currentHandle -ne $handle -and
            [T4WindowCaptureNative]::IsWindow($currentHandle) -and
            [T4WindowCaptureNative]::SetWindowPos(
                $currentHandle, $hwndBottom, -32000, -32000, $captureWidth, $captureHeight, $flags)) {
            $handle = $currentHandle
        }
    }
    $captured = $false
    $lastCaptureError = 0
    $captureDeadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    while (-not $captured -and [DateTime]::UtcNow -lt $captureDeadline) {
        if ($process.HasExited) {
            throw "$ProcessName exited before its window could be captured."
        }
        $process.Refresh()
        $currentHandle = $process.MainWindowHandle
        if ($currentHandle -eq [IntPtr]::Zero -or
            -not [T4WindowCaptureNative]::IsWindow($currentHandle) -or
            -not [T4WindowCaptureNative]::SetWindowPos(
                $currentHandle, $hwndBottom, -32000, -32000, $captureWidth, $captureHeight, $flags)) {
            $lastCaptureError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            Start-Sleep -Milliseconds 100
            continue
        }
        $handle = $currentHandle

        $bitmap = New-Object Drawing.Bitmap $captureWidth, $captureHeight
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        $rendered = $false
        try {
            $deviceContext = $graphics.GetHdc()
            try {
                # PW_RENDERFULLCONTENT asks DWM-backed controls, including WinUI,
                # to render their complete non-client and client surfaces.
                $rendered = [T4WindowCaptureNative]::PrintWindow($handle, $deviceContext, 2)
                if (-not $rendered) {
                    $lastCaptureError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
                }
            } finally {
                $graphics.ReleaseHdc($deviceContext)
            }
            if ($rendered -and [T4WindowCaptureNative]::HasRenderedContent($bitmap)) {
                $bitmap.Save($absoluteOutput, [Drawing.Imaging.ImageFormat]::Png)
                $captured = $true
            }
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
        if (-not $captured) {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $captured) {
        throw "PrintWindow did not capture a stable $ProcessName window (last Win32 error $lastCaptureError)."
    }
} finally {
    if (-not $process.HasExited) {
        $process.Kill()
        $process.WaitForExit(5000) | Out-Null
    }
}

Write-Output $absoluteOutput
