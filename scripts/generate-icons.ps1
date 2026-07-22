param()

Add-Type -AssemblyName System.Drawing

$iconDirectory = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $iconDirectory | Out-Null

function New-RoundedRectanglePath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($size in 16, 32, 48, 128) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $backgroundPath = New-RoundedRectanglePath 0.5 0.5 ($size - 1) ($size - 1) ($size * 0.22)
    $greenBrush = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#04b70a'))
    $graphics.FillPath($greenBrush, $backgroundPath)

    $cardPath = New-RoundedRectanglePath ($size * 0.19) ($size * 0.17) ($size * 0.62) ($size * 0.66) ($size * 0.09)
    $whiteBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $graphics.FillPath($whiteBrush, $cardPath)

    $strokeWidth = [Math]::Max(1.2, $size * 0.065)
    $greenPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#039408'), $strokeWidth)
    $greenPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $greenPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $eyeRectangle = [System.Drawing.RectangleF]::new($size * 0.30, $size * 0.40, $size * 0.40, $size * 0.24)
    $graphics.DrawEllipse($greenPen, $eyeRectangle)
    $graphics.FillEllipse($greenBrush, $size * 0.45, $size * 0.475, $size * 0.10, $size * 0.10)
    $graphics.DrawLine($greenPen, $size * 0.27, $size * 0.34, $size * 0.73, $size * 0.70)

    $outputPath = Join-Path $iconDirectory "icon-$size.png"
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $greenPen.Dispose()
    $whiteBrush.Dispose()
    $greenBrush.Dispose()
    $cardPath.Dispose()
    $backgroundPath.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}
