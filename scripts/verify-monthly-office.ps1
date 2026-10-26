param([Parameter(Mandatory=$true)][string]$Folder)
$ErrorActionPreference = 'Stop'
$app = $null
$book = $null
$results = @()
try {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.AutomationSecurity = 3
  $app.AskToUpdateLinks = $false
  foreach ($name in @('9月工时-真实输入验证.xlsx','work.xlsx','supervision.xlsx')) {
    $path = Join-Path $Folder $name
    $book = $app.Workbooks.Open($path, 0, $true)
    $app.CalculateFullRebuild()
    $errors = @()
    foreach ($sheet in $book.Worksheets) {
      try {
        $cells = $sheet.UsedRange.SpecialCells(-4123,16)
        foreach ($cell in $cells) { $errors += ($sheet.Name + '!' + $cell.Address() + '=' + $cell.Text) }
      } catch {}
    }
    $copy = Join-Path $Folder ($name.Replace('.xlsx','-Excel重算.xlsx'))
    $book.SaveCopyAs($copy)
    $targets = if ($name -like '9月*') { @('工时明细表（填写）','人员工时汇总及校验（仅查看）') } else { @('Sheet1') }
    foreach ($target in $targets) {
      $sheet = $book.Worksheets.Item($target)
      $pdf = Join-Path $Folder ($name.Replace('.xlsx','') + '-' + $target + '.pdf')
      $sheet.ExportAsFixedFormat(0,$pdf)
    }
    $results += @{file=$name;formulaErrors=$errors;recalculatedCopy=$copy;sheetCount=$book.Worksheets.Count}
    $book.Close($false)
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($book)
    $book=$null
  }
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Folder 'excel-native-verification.json') -Encoding UTF8
} finally {
  if ($book) { $book.Close($false); [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($book) }
  if ($app) { $app.Quit(); [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
}
