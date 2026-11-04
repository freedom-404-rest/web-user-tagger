# Generate extension icons (16 / 48 / 128 PNG)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\gen-icons.ps1 -OutDir "..\icons"

param(
    [string]$OutDir = (Join-Path $PSScriptRoot '..\icons')
)

Add-Type -AssemblyName System.Drawing

function New-RoundedRect {
    param($x, $y, $w, $h, $r)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
    $path.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
    $path.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Icon {
    param([int]$Size, [string]$Path)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $purple = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 124, 58, 237))
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    # Rounded square background
    $bgPath = New-RoundedRect 0 0 $Size $Size ($Size * 0.22)
    $g.FillPath($purple, $bgPath)

    # White tag body
    $tagPath = New-RoundedRect ($Size * 0.22) ($Size * 0.30) ($Size * 0.56) ($Size * 0.40) ($Size * 0.08)
    $g.FillPath($white, $tagPath)

    # Tag hole
    $g.FillEllipse($purple, ($Size * 0.29), ($Size * 0.42), ($Size * 0.16), ($Size * 0.16))

    # Tag text lines
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 124, 58, 237), [float][Math]::Max(1, $Size * 0.05))
    $g.DrawLine($pen, $Size * 0.52, $Size * 0.42, $Size * 0.69, $Size * 0.42)
    $g.DrawLine($pen, $Size * 0.52, $Size * 0.52, $Size * 0.65, $Size * 0.52)

    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose()
    $bmp.Dispose()
    $purple.Dispose()
    $white.Dispose()
    $pen.Dispose()
    $bgPath.Dispose()
    $tagPath.Dispose()
    Write-Host "Generated $Path"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Icon 16 (Join-Path $OutDir 'icon16.png')
New-Icon 48 (Join-Path $OutDir 'icon48.png')
New-Icon 128 (Join-Path $OutDir 'icon128.png')
