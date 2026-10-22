param(
  [Parameter(Mandatory=$true)][string]$OutPath,
  [Parameter(Mandatory=$true)][string]$Title,
  [string]$Author = "",
  [string]$C1 = "#2f6fb0",
  [string]$C2 = "#122c4d"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$w = 600; $h = 800
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

# 纵向渐变背景（逐行插值，避免 LinearGradientBrush 构造兼容问题）
$c1 = [System.Drawing.ColorTranslator]::FromHtml($C1)
$c2 = [System.Drawing.ColorTranslator]::FromHtml($C2)
for ($y = 0; $y -lt $h; $y++) {
  $t = $y / $h
  $r = [int]($c1.R + ($c2.R - $c1.R) * $t)
  $gch = [int]($c1.G + ($c2.G - $c1.G) * $t)
  $b = [int]($c1.B + ($c2.B - $c1.B) * $t)
  $rowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, $r, $gch, $b))
  $g.FillRectangle($rowBrush, 0, $y, $w, 1)
  $rowBrush.Dispose()
}

# 半透明装饰圆
$deco = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(36, 255, 255, 255))
$g.FillEllipse($deco, -120, -140, 420, 420)
$g.FillEllipse($deco, 380, 560, 380, 380)

# 顶部细线 + 「短篇小说」/「长篇小说」眉标（由标题栏外传入时省略，这里统一留白带）
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), 2)
$g.DrawLine($pen, 60, 150, 160, 150)

# 书名：自动换行，最多 3 行
$titleFont = New-Object System.Drawing.Font('Microsoft YaHei', 46, [System.Drawing.FontStyle]::Bold)
$white = [System.Drawing.Brushes]::White
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = 'Near'; $fmt.LineAlignment = 'Near'
$rect = New-Object System.Drawing.RectangleF(60, 190, 480, 400)
$g.DrawString($Title, $titleFont, $white, $rect, $fmt)

# 作者署名
if ($Author) {
  $authorFont = New-Object System.Drawing.Font('Microsoft YaHei', 24, [System.Drawing.FontStyle]::Regular)
  $g.DrawString("- $Author -", $authorFont, $white, 60, 660)
}

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "OK"
