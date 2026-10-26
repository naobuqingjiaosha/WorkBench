param([Parameter(Mandatory=$true)][string]$InputFile,[Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
$app = $null
$book = $null
try {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false
  $app.DisplayAlerts = $false
  $app.AutomationSecurity = 3
  $app.AskToUpdateLinks = $false
  $book = $app.Workbooks.Open($InputFile, 0, $true)
  $book.SaveAs($OutputFile, 51)
} finally {
  if ($book) { $book.Close($false); [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($book) }
  if ($app) { $app.Quit(); [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app) }
}
