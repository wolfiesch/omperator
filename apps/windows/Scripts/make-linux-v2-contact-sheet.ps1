param(
    [string]$ArtifactRoot = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$windowsRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ArtifactRoot)) {
    $ArtifactRoot = Join-Path $windowsRoot ".build\linux-v2-parity"
}
$windowsCaptureRoot = Join-Path $ArtifactRoot "windows"
$files = Get-ChildItem -Path $windowsCaptureRoot -Filter "*.png" | Sort-Object Name
if ($files.Count -eq 0) { throw "No Windows captures found in $windowsCaptureRoot." }

$cellWidth = 420
$cellHeight = 300
$columns = 3
$rows = [Math]::Ceiling($files.Count / $columns)
$sheet = New-Object Drawing.Bitmap ($cellWidth * $columns), ($cellHeight * $rows)
$graphics = [Drawing.Graphics]::FromImage($sheet)
$graphics.Clear([Drawing.Color]::FromArgb(24, 22, 31))
$font = New-Object Drawing.Font("Segoe UI", 12, [Drawing.FontStyle]::Bold)
$brush = [Drawing.Brushes]::White
try {
    for ($index = 0; $index -lt $files.Count; $index++) {
        $column = $index % $columns
        $row = [Math]::Floor($index / $columns)
        $x = $column * $cellWidth
        $y = $row * $cellHeight
        $image = [Drawing.Image]::FromFile($files[$index].FullName)
        try {
            $availableWidth = $cellWidth - 16
            $availableHeight = $cellHeight - 38
            $scale = [Math]::Min($availableWidth / $image.Width, $availableHeight / $image.Height)
            $width = [int]($image.Width * $scale)
            $height = [int]($image.Height * $scale)
            $graphics.DrawImage($image, $x + 8, $y + 30, $width, $height)
            $graphics.DrawString($files[$index].BaseName, $font, $brush, $x + 8, $y + 7)
        } finally {
            $image.Dispose()
        }
    }
    $output = Join-Path $ArtifactRoot "windows-contact-sheet.png"
    $sheet.Save($output, [Drawing.Imaging.ImageFormat]::Png)
    Write-Output $output
} finally {
    $font.Dispose()
    $graphics.Dispose()
    $sheet.Dispose()
}
