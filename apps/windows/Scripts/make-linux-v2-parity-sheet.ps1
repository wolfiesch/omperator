param(
    [string]$ArtifactRoot = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$parityTypeDefinition = @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class T4LinuxV2ParityImages {
    public static Bitmap Normalize(Image source, int width, int height) {
        var output = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(output)) {
            graphics.Clear(Color.FromArgb(24, 22, 31));
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float scale = Math.Min((float)width / source.Width, (float)height / source.Height);
            int renderedWidth = Math.Max(1, (int)Math.Round(source.Width * scale));
            int renderedHeight = Math.Max(1, (int)Math.Round(source.Height * scale));
            int x = (width - renderedWidth) / 2;
            int y = (height - renderedHeight) / 2;
            graphics.DrawImage(source, x, y, renderedWidth, renderedHeight);
        }
        return output;
    }

    public static Bitmap Blend(Bitmap left, Bitmap right) {
        return Combine(left, right, false);
    }

    public static Bitmap Difference(Bitmap left, Bitmap right) {
        return Combine(left, right, true);
    }

    private static Bitmap Combine(Bitmap left, Bitmap right, bool difference) {
        if (left.Width != right.Width || left.Height != right.Height) {
            throw new ArgumentException("Images must have identical normalized dimensions.");
        }
        var output = new Bitmap(left.Width, left.Height, PixelFormat.Format32bppArgb);
        var rectangle = new Rectangle(0, 0, left.Width, left.Height);
        BitmapData leftData = null;
        BitmapData rightData = null;
        BitmapData outputData = null;
        try {
            leftData = left.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            rightData = right.LockBits(rectangle, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            outputData = output.LockBits(rectangle, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            int byteCount = Math.Abs(leftData.Stride) * left.Height;
            var leftBytes = new byte[byteCount];
            var rightBytes = new byte[byteCount];
            var outputBytes = new byte[byteCount];
            Marshal.Copy(leftData.Scan0, leftBytes, 0, byteCount);
            Marshal.Copy(rightData.Scan0, rightBytes, 0, byteCount);
            for (int offset = 0; offset < byteCount; offset += 4) {
                for (int channel = 0; channel < 3; channel++) {
                    int a = leftBytes[offset + channel];
                    int b = rightBytes[offset + channel];
                    outputBytes[offset + channel] = difference
                        ? (byte)Math.Abs(a - b)
                        : (byte)((a + b) / 2);
                }
                outputBytes[offset + 3] = 255;
            }
            Marshal.Copy(outputBytes, 0, outputData.Scan0, byteCount);
        } finally {
            if (leftData != null) left.UnlockBits(leftData);
            if (rightData != null) right.UnlockBits(rightData);
            if (outputData != null) output.UnlockBits(outputData);
        }
        return output;
    }
}
"@
Add-Type -TypeDefinition $parityTypeDefinition -ReferencedAssemblies System.Drawing

$windowsRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $windowsRoot ".build\linux-v2-parity"
}
$linuxRoot = Join-Path $ArtifactRoot "linux"
$windowsCaptureRoot = Join-Path $ArtifactRoot "windows"
$comparisonRoot = Join-Path $ArtifactRoot "comparisons"
[IO.Directory]::CreateDirectory($comparisonRoot) | Out-Null

$names = @(
    Get-ChildItem -Path $windowsCaptureRoot -Filter "*.png" |
        Where-Object { Test-Path (Join-Path $linuxRoot $_.Name) } |
        ForEach-Object { $_.BaseName } |
        Sort-Object
)
if ($names.Count -eq 0) { throw "No matching Linux and Windows captures found." }

$manifest = @()
for ($index = 0; $index -lt $names.Count; $index++) {
    $name = $names[$index]
    $stateRoot = Join-Path $comparisonRoot $name
    [IO.Directory]::CreateDirectory($stateRoot) | Out-Null
    $linuxImage = [Drawing.Image]::FromFile((Join-Path $linuxRoot ($name + ".png")))
    $windowsImage = [Drawing.Image]::FromFile((Join-Path $windowsCaptureRoot ($name + ".png")))
    try {
        $width = [Math]::Max($linuxImage.Width, $windowsImage.Width)
        $height = [Math]::Max($linuxImage.Height, $windowsImage.Height)
        $normalizedLinux = [T4LinuxV2ParityImages]::Normalize($linuxImage, $width, $height)
        $normalizedWindows = [T4LinuxV2ParityImages]::Normalize($windowsImage, $width, $height)
        $overlay = [T4LinuxV2ParityImages]::Blend($normalizedLinux, $normalizedWindows)
        $difference = [T4LinuxV2ParityImages]::Difference($normalizedLinux, $normalizedWindows)
        try {
            $linuxOutput = Join-Path $stateRoot "linux-normalized.png"
            $windowsOutput = Join-Path $stateRoot "windows-normalized.png"
            $overlayOutput = Join-Path $stateRoot "overlay-50.png"
            $differenceOutput = Join-Path $stateRoot "absolute-difference.png"
            $sideOutput = Join-Path $stateRoot "side-by-side.png"
            $normalizedLinux.Save($linuxOutput, [Drawing.Imaging.ImageFormat]::Png)
            $normalizedWindows.Save($windowsOutput, [Drawing.Imaging.ImageFormat]::Png)
            $overlay.Save($overlayOutput, [Drawing.Imaging.ImageFormat]::Png)
            $difference.Save($differenceOutput, [Drawing.Imaging.ImageFormat]::Png)

            $side = New-Object Drawing.Bitmap ($width * 2), ($height + 32)
            $sideGraphics = [Drawing.Graphics]::FromImage($side)
            $sideFont = New-Object Drawing.Font("Segoe UI", 11, [Drawing.FontStyle]::Bold)
            try {
                $sideGraphics.Clear([Drawing.Color]::FromArgb(24, 22, 31))
                $label = "{0:D2} {1}" -f ($index + 1), $name
                $sideGraphics.DrawString("$label - Linux", $sideFont, [Drawing.Brushes]::White, 8, 6)
                $sideGraphics.DrawString("$label - Windows", $sideFont, [Drawing.Brushes]::White, $width + 8, 6)
                $sideGraphics.DrawImage($normalizedLinux, 0, 32, $width, $height)
                $sideGraphics.DrawImage($normalizedWindows, $width, 32, $width, $height)
                $side.Save($sideOutput, [Drawing.Imaging.ImageFormat]::Png)
            } finally {
                $sideFont.Dispose()
                $sideGraphics.Dispose()
                $side.Dispose()
            }

            $manifest += [pscustomobject]@{
                index = $index + 1
                state = $name
                linux = $linuxOutput
                windows = $windowsOutput
                sideBySide = $sideOutput
                overlay50 = $overlayOutput
                absoluteDifference = $differenceOutput
            }
        } finally {
            $normalizedLinux.Dispose()
            $normalizedWindows.Dispose()
            $overlay.Dispose()
            $difference.Dispose()
        }
    } finally {
        $linuxImage.Dispose()
        $windowsImage.Dispose()
    }
}

$cellWidth = 420
$cellHeight = 280
$sheet = New-Object Drawing.Bitmap ($cellWidth * 3), ($cellHeight * $names.Count)
$graphics = [Drawing.Graphics]::FromImage($sheet)
$font = New-Object Drawing.Font("Segoe UI", 11, [Drawing.FontStyle]::Bold)
try {
    $graphics.Clear([Drawing.Color]::FromArgb(24, 22, 31))
    for ($row = 0; $row -lt $names.Count; $row++) {
        $name = $names[$row]
        $stateRoot = Join-Path $comparisonRoot $name
        $paths = @(
            (Join-Path $stateRoot "linux-normalized.png"),
            (Join-Path $stateRoot "windows-normalized.png"),
            (Join-Path $stateRoot "absolute-difference.png")
        )
        $labels = @("Linux", "Windows", "Difference")
        for ($column = 0; $column -lt 3; $column++) {
            $image = [Drawing.Image]::FromFile($paths[$column])
            try {
                $x = $column * $cellWidth
                $y = $row * $cellHeight
                $label = "{0:D2} {1} - {2}" -f ($row + 1), $name, $labels[$column]
                $graphics.DrawString($label, $font, [Drawing.Brushes]::White, $x + 8, $y + 6)
                $scale = [Math]::Min(($cellWidth - 16) / $image.Width, ($cellHeight - 36) / $image.Height)
                $renderedWidth = [int]($image.Width * $scale)
                $renderedHeight = [int]($image.Height * $scale)
                $graphics.DrawImage($image, $x + 8, $y + 28, $renderedWidth, $renderedHeight)
            } finally {
                $image.Dispose()
            }
        }
    }
    $sheetOutput = Join-Path $ArtifactRoot "linux-windows-contact-sheet.png"
    $sheet.Save($sheetOutput, [Drawing.Imaging.ImageFormat]::Png)
} finally {
    $font.Dispose()
    $graphics.Dispose()
    $sheet.Dispose()
}

$manifestOutput = Join-Path $ArtifactRoot "comparison-index.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText(
    $manifestOutput,
    ($manifest | ConvertTo-Json -Depth 4),
    $utf8NoBom
)
Write-Output $sheetOutput
Write-Output $manifestOutput
