$ErrorActionPreference = 'Stop'
$projectRoot = 'D:\project\工作台'
$backupRoot = Join-Path $projectRoot ('data\backups\cleanup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupRoot | Out-Null
$targets = @((Join-Path $projectRoot '.tmp'), (Join-Path $projectRoot '.npm-cache'), 'C:\Users\Fangnan\AppData\Local\Temp\workbench-isolated-GSlpFV')
# Exact, previously inspected test processes only; the daily 8787 service is excluded.
$expected = @(
 @{ Id=26364; Pattern='monthly-usability-20261021-r1\\scripts\\start.mjs --background-worker --port 18879' },
 @{ Id=31192; Pattern='monthly-usability-20261021-r1\\packages\\server\\src\\index.ts' },
 @{ Id=40328; Pattern='--import ./scripts/test-preflight.mjs packages/server/src/index.ts' }
)
foreach ($spec in $expected) {
 $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($spec.Id)"
 if ($proc -and ($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch $spec.Pattern)) { throw "PID changed: $($spec.Id)" }
}
if ((Get-Content -LiteralPath ($targets[2]+'\runtime\server.lock') -Raw).Trim() -ne '31192') { throw 'Unexpected test lock' }
if (!(Test-Path -LiteralPath ($targets[2]+'\.workbench-test-root'))) { throw 'Missing isolation marker' }
foreach ($spec in $expected) { if (Get-Process -Id $spec.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $spec.Id -Force } }
$files = [Collections.Generic.List[object]]::new()
$dirs = [Collections.Generic.List[object]]::new()
$links = [Collections.Generic.List[object]]::new()
function Assert-TargetPath([string]$path) {
 $full=[IO.Path]::GetFullPath($path)
 $ok=$false
 foreach($root in $targets) { if($full -eq $root -or $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)) { $ok=$true } }
 if(!$ok) { throw "Out of cleanup roots: $full" }
 return $full
}
function Inventory([string]$path,[string]$entry) {
 $full=Assert-TargetPath $path
 $item=Get-Item -LiteralPath $full -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $links.Add(@{path=$full;entry=$entry;target=$item.Target;type=$item.LinkType}); return }
 if($item.PSIsContainer) {
  $dirs.Add(@{path=$full;entry=$entry})
  foreach($child in Get-ChildItem -LiteralPath $full -Force) { Inventory $child.FullName ($entry+'/'+$child.Name) }
 } else { $files.Add(@{path=$full;entry=$entry;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash}) }
}
for($i=0;$i -lt $targets.Count;$i++) { Inventory $targets[$i] "root-$i" }
$manifest=@{created=(Get-Date -Format o);roots=$targets;files=@($files.ToArray());directories=@($dirs.ToArray());links=@($links.ToArray());stoppedTestProcesses=@($expected | ForEach-Object {$_.Id})}
$manifestPath=Join-Path $backupRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
$zipPath=Join-Path $backupRoot 'removed-files.zip'
$zip=[IO.Compression.ZipFile]::Open($zipPath,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($file in $files) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file.path,$file.entry,[IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $zip.Dispose() }
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
try {
 if($zip.Entries.Count -ne $files.Count) { throw 'Archive file count mismatch' }
 foreach($file in $files) {
  $stream=$zip.GetEntry($file.entry).Open();$sha=[Security.Cryptography.SHA256]::Create()
  try { $hash=[Convert]::ToHexString($sha.ComputeHash($stream)) } finally { $stream.Dispose();$sha.Dispose() }
  if($hash -ne $file.sha256 -or (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash -ne $file.sha256) { throw "Archive mismatch or source changed: $($file.path)" }
 }
} finally { $zip.Dispose() }
# All resolved roots have been checked. Reparse points are removed as links, never traversed.
function Remove-CheckedTree([string]$path) {
 $full=Assert-TargetPath $path
 $item=Get-Item -LiteralPath $full -Force
 if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Remove-Item -LiteralPath $full -Force; return }
 if($item.PSIsContainer) { foreach($child in Get-ChildItem -LiteralPath $full -Force) { Remove-CheckedTree $child.FullName } }
 Remove-Item -LiteralPath $full -Force
}
foreach($target in $targets) { Remove-CheckedTree $target }
$summary=@{backup=$backupRoot;files=$files.Count;directories=$dirs.Count;links=$links.Count;sourceBytes=($files | Measure-Object bytes -Sum).Sum;archiveBytes=(Get-Item -LiteralPath $zipPath).Length;archiveVerified=$true;removedRoots=$targets}
$summary | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backupRoot 'summary.json') -Encoding utf8
$summary | ConvertTo-Json -Depth 5
