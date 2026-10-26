param([Parameter(Mandatory=$true)][string]$InputDocx,[Parameter(Mandatory=$true)][string]$OutputPdf)
$ErrorActionPreference='Stop'
# Read-only rendering of anonymous test artifacts. Never attach to a user document.
$word=$null
$doc=$null
try {
  $word=New-Object -ComObject Word.Application
  $word.Visible=$false
  $word.DisplayAlerts=0
  $doc=$word.Documents.Open([System.IO.Path]::GetFullPath($InputDocx),$false,$true)
  $doc.ExportAsFixedFormat([System.IO.Path]::GetFullPath($OutputPdf),17)
  Write-Output $OutputPdf
} finally {
  if($doc){try {$doc.Close(0)} catch {Write-Warning 'Office renderer already closed its document'};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc)}
  if($word){try {$word.Quit()} catch {Write-Warning 'Office renderer already exited'};[void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)}
}
