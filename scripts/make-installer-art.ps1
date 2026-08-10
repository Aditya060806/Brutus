<#
    Generates the NSIS installer artwork at the exact sizes NSIS requires.

    WHY THIS SCRIPT EXISTS
    ----------------------
    NSIS does not scale these bitmaps. The sidebar must be 164x314 and the header
    150x57, and anything else is either rejected or drawn corrupt. `build/` held a
    1024x1536 sidebar, which is a fine marketing asset and an unusable installer
    one, so the sizes are produced here rather than resized by hand and forgotten.

    Output is 24-bit BMP because that is what the NSIS Modern UI expects; PNG with
    alpha renders with a black box behind it.

    Run:  powershell -ExecutionPolicy Bypass -File scripts/make-installer-art.ps1
#>

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$iconPath = Join-Path $buildDir 'icon.png'

if (-not (Test-Path $iconPath)) {
    Write-Error "Missing $iconPath - the logo is the one thing this cannot invent."
    exit 1
}

# Brutus palette. Kept in one place so the installer matches the app and the PDF.
$bgTop = [System.Drawing.Color]::FromArgb(14, 14, 17)
$bgBottom = [System.Drawing.Color]::FromArgb(8, 8, 10)
$accent = [System.Drawing.Color]::FromArgb(196, 30, 58)
$textBright = [System.Drawing.Color]::FromArgb(250, 250, 252)
$textMuted = [System.Drawing.Color]::FromArgb(150, 150, 158)

$logo = [System.Drawing.Image]::FromFile($iconPath)

function New-Canvas([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $bgTop, $bgBottom, 90.0)
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()

    return @{ Bitmap = $bmp; Graphics = $g }
}

function Save-Bmp($bmp, [string]$path) {
    if (Test-Path $path) { Remove-Item $path -Force }
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $dims = "$($bmp.Width)x$($bmp.Height)"
    Write-Host ("  wrote {0,-28} {1}" -f (Split-Path $path -Leaf), $dims)
}

# ── Sidebar: 164 x 314 ──────────────────────────────────────────────────────
$W = 164; $H = 314
$c = New-Canvas $W $H
$g = $c.Graphics

# A red spine down the left edge - the same accent the app uses for Brutus red.
$accentBrush = New-Object System.Drawing.SolidBrush($accent)
$g.FillRectangle($accentBrush, 0, 0, 3, $H)

# Soft bloom behind the logo so it does not sit on flat black.
$bloom = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(26, 196, 30, 58))
$g.FillEllipse($bloom, 12, 46, 140, 140)
$bloom.Dispose()

$logoSize = 82
$g.DrawImage($logo, [int](($W - $logoSize) / 2), 74, $logoSize, $logoSize)

$fontWord = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontSub = New-Object System.Drawing.Font('Segoe UI', 8, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$centre = New-Object System.Drawing.StringFormat
$centre.Alignment = [System.Drawing.StringAlignment]::Center

$brushBright = New-Object System.Drawing.SolidBrush($textBright)
$brushMuted = New-Object System.Drawing.SolidBrush($textMuted)
$brushAccent = New-Object System.Drawing.SolidBrush($accent)

$g.DrawString('BRUTUS', $fontWord, $brushBright, (New-Object System.Drawing.RectangleF(0, 176, $W, 26)), $centre)
$g.DrawString('AI ORCHESTRATION', $fontSub, $brushAccent, (New-Object System.Drawing.RectangleF(0, 200, $W, 14)), $centre)
$g.DrawString('ENGINE', $fontSub, $brushMuted, (New-Object System.Drawing.RectangleF(0, 212, $W, 14)), $centre)

# Hairline and the promise, low on the panel.
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), 1)
$g.DrawLine($pen, 34, 244, $W - 22, 244)
$pen.Dispose()

$fontTiny = New-Object System.Drawing.Font('Segoe UI', 7.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('Runs on your machine.', $fontTiny, $brushMuted, (New-Object System.Drawing.RectangleF(0, 256, $W, 12)), $centre)
$g.DrawString('Your models. Your keys.', $fontTiny, $brushMuted, (New-Object System.Drawing.RectangleF(0, 268, $W, 12)), $centre)

Save-Bmp $c.Bitmap (Join-Path $buildDir 'installerSidebar.bmp')
Save-Bmp $c.Bitmap (Join-Path $buildDir 'uninstallerSidebar.bmp')
$g.Dispose(); $c.Bitmap.Dispose()

# ── Header: 150 x 57 ────────────────────────────────────────────────────────
# Shown on the inner wizard pages, top-right. Small, so it is the mark plus the
# wordmark and nothing else.
$W2 = 150; $H2 = 57
$c2 = New-Canvas $W2 $H2
$g2 = $c2.Graphics
$g2.FillRectangle($accentBrush, 0, 0, 2, $H2)
$g2.DrawImage($logo, 10, 12, 32, 32)

$fontHdr = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontHdrSub = New-Object System.Drawing.Font('Segoe UI', 7, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g2.DrawString('BRUTUS', $fontHdr, $brushBright, 48, 15)
$g2.DrawString('Orchestration Engine', $fontHdrSub, $brushMuted, 49, 32)

Save-Bmp $c2.Bitmap (Join-Path $buildDir 'installerHeader.bmp')
$g2.Dispose(); $c2.Bitmap.Dispose()

foreach ($d in @($accentBrush, $brushBright, $brushMuted, $brushAccent, $fontWord, $fontSub, $fontTiny, $fontHdr, $fontHdrSub, $logo)) { $d.Dispose() }

Write-Host ''
Write-Host 'Installer artwork regenerated at NSIS sizes.'
