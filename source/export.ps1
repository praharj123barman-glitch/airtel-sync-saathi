param(
  [Parameter(Mandatory = $true)][string]$InPptx,
  [Parameter(Mandatory = $true)][string]$OutPptx,
  [Parameter(Mandatory = $true)][string]$OutPdf,
  [Parameter(Mandatory = $true)][string]$PngDir
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $PngDir | Out-Null
$app = New-Object -ComObject PowerPoint.Application
try {
  # Open(FileName, ReadOnly, Untitled, WithWindow)
  $pres = $app.Presentations.Open($InPptx, -1, 0, 0)
  # SaveAs(FileName, ppSaveAsOpenXMLPresentation=24, EmbedTrueTypeFonts=msoTrue)
  $pres.SaveAs($OutPptx, 24, -1)
  $i = 1
  foreach ($sl in $pres.Slides) {
    $sl.Export((Join-Path $PngDir ("slide{0}.png" -f $i)), "PNG", 1920, 1080)
    $i++
  }
  # ppSaveAsPDF = 32
  $pres.SaveAs($OutPdf, 32)
  $pres.Close()
  "exported $($i - 1) slides"
}
finally {
  $app.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($app) | Out-Null
}
