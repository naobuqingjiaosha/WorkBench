# 制度识别预览 - 生成器（v4）
# 只读扫描 C:\Users\Fangnan\Desktop\工作test\3.制度 的元数据，按可解释规则判定制度/非制度/待确认，
# 生成 docs\制度识别预览.md。不打开任何文件内容，不写目标目录，不导入知识库。
# 用法： powershell -File gen-zhidu-preview.ps1

param(
  [string]$ConfigPath
)

$here = $PSScriptRoot
if (-not $ConfigPath) { $ConfigPath = Join-Path $here '_zhidu-config.json' }
$cfgText = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($ConfigPath))
if ($cfgText.Length -gt 0 -and [int]$cfgText[0] -eq 0xFEFF) { $cfgText = $cfgText.Substring(1) }
$cfg = $cfgText | ConvertFrom-Json

$T = @{}
foreach ($p in $cfg.PSObject.Properties) { $T[$p.Name] = $p.Value }
function TT([string]$k) {
  if ($T.ContainsKey($k)) { return [string]$T[$k] }
  throw ("missing token: " + $k)
}
function Fill([string]$s) {
  foreach ($k in $T.Keys) { $s = $s.Replace('@@' + $k + '@@', [string]$T[$k]) }
  return $s
}

$Root   = [string]$cfg.root
$OutDir = [string]$cfg.outDir
$MdOut  = [string]$cfg.mdOut
$TopN   = [int]$cfg.topN
if (-not (Test-Path -LiteralPath $Root)) { throw ("root missing: " + $Root) }
foreach ($d in @($OutDir, (Split-Path -Parent $MdOut))) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}
$UTF8 = New-Object System.Text.UTF8Encoding($false)

function Get-Rel([string]$full, [string]$rootPath) {
  $r = $rootPath.TrimEnd([char[]]@([char]92)) + [string][char]92
  if ($full.StartsWith($r, [System.StringComparison]::OrdinalIgnoreCase)) { return $full.Substring($r.Length) }
  return $full
}
function FmtSize([int64]$b) {
  if ($b -ge 1073741824) { return ('{0:N2} GB' -f ($b / 1073741824)) }
  if ($b -ge 1048576)    { return ('{0:N1} MB' -f ($b / 1048576)) }
  if ($b -ge 1024)       { return ('{0:N0} KB' -f ($b / 1024)) }
  return ([string]$b + ' B')
}
function TblCell([string]$s) {
  if ($null -eq $s) { return '' }
  return ($s.Replace([string][char]124, [string][char]92 + [string][char]124))
}
# 单份制度正文规模粗估（未打开文件，纯按体积档次）
function EstChars([int64]$bytes) {
  $mb = $bytes / 1048576.0
  if ($mb -lt 1.0) { return @(5000.0, 30000.0) }
  if ($mb -lt 5.0) { return @(10000.0, 40000.0) }
  return @(20000.0, 80000.0)
}
function EstWanStr([object[]]$items) {
  $arr = @($items)
  $lo = 0.0; $hi = 0.0
  foreach ($r in $arr) { $e = EstChars ([int64]$r.size); $lo += $e[0]; $hi += $e[1] }
  $s = '{0:N1}~{1:N1} ' + (TT 'unit_wan'); return ($s -f ($lo / 10000), ($hi / 10000))
}

# ---------- 1. 采集元数据（只读） ----------
$files = New-Object System.Collections.Generic.List[object]
Get-ChildItem -LiteralPath $Root -Force -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
  $rel = Get-Rel $_.FullName $Root
  $par = Split-Path -Parent $rel
  if ([string]::IsNullOrEmpty($par)) { $par = '' }
  $files.Add([pscustomobject]@{
    rel = $rel; name = $_.Name; dir = $par
    ext = $_.Extension.ToLowerInvariant(); size = [int64]$_.Length
    mtime = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
  })
}
$dirEntries = @(Get-ChildItem -LiteralPath $Root -Force -Recurse -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { [pscustomobject]@{ rel = (Get-Rel $_.FullName $Root) } })

# ---------- 2. 规则 ----------
$EXCL_DIR = @('.workbuddy','tmp','temp','output','outputs','_rels','docprops','.git','node_modules','__pycache__','.cache','cache')
$EXT_NON_DOC = @('.py','.js','.ts','.mjs','.cjs','.java','.go','.rs','.c','.cpp','.h','.sh','.ps1','.bat','.cmd','.sql','.yml','.yaml','.toml','.ini','.exe','.dll','.zip','.rar','.7z','.tar','.gz','.png','.jpg','.jpeg','.gif','.bmp','.svg','.ico','.mp4','.mp3','.wav','.pptx','.ppt')
$NAME_STRONG = Fill '@@re_strong@@'
$NAME_PROC   = Fill '@@re_proc@@'
$NAME_LIST   = Fill '@@re_list@@'
$NAME_ABAND  = Fill '@@re_aband@@'

function Test-Artifact([string]$dir, [string]$name) {
  $why = @()
  if ($name.StartsWith('~$')) { $why += (TT 'a_lock') }
  if ($name -match '\.(doc|docx|xls|xlsx|ppt|pptx|pdf|wps|ofd)\.txt$') { $why += (TT 'a_extract') }
  if ($name -match '\.(tmp|crdownload|part|bak|log)$') { $why += (TT 'a_tmp') }
  foreach ($s in $dir.Split([char[]]@([char]92))) {
    if ($s.StartsWith('.') -and $s.Length -gt 0) { $why += ((TT 'a_hidden') + ' ' + $s) }
    foreach ($d in $EXCL_DIR) { if ($s.ToLowerInvariant() -eq $d) { $why += ((TT 'a_excl') + ' ' + $s) } }
  }
  return $why
}
function Get-DirClass([string]$dir) {
  if ($dir -match (TT 'dc_G')) { return 'G' }
  if ($dir -match (TT 'dc_H')) { return 'H' }
  if ($dir -match (TT 'dc_E')) { return 'E' }
  if ($dir -match (TT 'dc_D')) { return 'D' }
  if ($dir -match (TT 'dc_F')) { return 'F' }
  if ($dir -match (TT 'dc_C')) { return 'C' }
  if ($dir -match (TT 'dc_A')) { return 'A' }
  if ($dir -match (TT 'dc_B')) { return 'B' }
  return 'I'
}

# 判定结果 -> 分类键
$CAT_KEYS = @(
  'A1','A2','B1','B2','C1','F1','N1','N2','N3',
  'G1','G2','G3','G4','H1','W1','W2','W3','Z0','Z1','Z2','Z3'
)
$CAT_TEXT = @{}
foreach ($k in $CAT_KEYS) { $CAT_TEXT[$k] = TT ('cat_' + $k) }
$CAT_VERDICT = @{}
foreach ($k in $CAT_KEYS) { $CAT_VERDICT[$k] = TT ('ver_' + $k) }

# ---------- 3. 逐文件判定 ----------
$rows = New-Object System.Collections.Generic.List[object]
foreach ($f in $files) {
  $dir = $f.dir; $name = $f.name
  $stem = [System.IO.Path]::GetFileNameWithoutExtension($name)
  $dcls = Get-DirClass $dir
  $ck = ''; $reason = ''

  $art = Test-Artifact $dir $name
  if ($art.Count -gt 0) {
    $ck = 'Z0'
    $reason = (TT 'r_z0') + ($art -join (TT 'sep'))
  }
  elseif (($EXT_NON_DOC -contains $f.ext) -and -not ($f.ext -eq '.jpg' -or $f.ext -eq '.png')) {
    $ck = 'Z1'
    $reason = (TT 'r_z1a') + ' ' + $f.ext + ' ' + (TT 'r_z1b')
  }
  else {
    $hits = @()
    foreach ($x in [regex]::Matches($stem, $NAME_STRONG)) { if ($hits -notcontains $x.Value) { $hits += $x.Value } }
    $hasStrong = $hits.Count -gt 0
    $hasProc = ($stem -match $NAME_PROC)
    $hasList = ($stem -match $NAME_LIST)
    $hasAband = ($stem -match $NAME_ABAND)
    $procHits = (($stem | Select-String -Pattern $NAME_PROC -AllMatches).Matches | ForEach-Object { $_.Value } | Select-Object -Unique) -join '/'
    $strongTxt = ($hits -join '/')
    $q1 = TT 'q1'; $q2 = TT 'q2'

    if ($dcls -eq 'G') {
      if ($hasStrong) {
        $ck = 'G1'
        $reason = (TT 'r_g1a') + $q1 + $strongTxt + $q2 + (TT 'r_g1b')
      } elseif ($stem -match (TT 're_sysdoc')) {
        $ck = 'G2'; $reason = (TT 'r_g2')
      } elseif ($stem -match (TT 're_comp')) {
        $ck = 'G3'; $reason = (TT 'r_g3')
      } else {
        $ck = 'G4'; $reason = (TT 'r_g4')
      }
    }
    elseif ($dcls -eq 'H') {
      $ck = 'H1'; $reason = (TT 'r_h1')
    }
    elseif ($dcls -eq 'B') {
      if ($hasAband) { $ck = 'Z2'; $reason = (TT 'r_z2b') }
      elseif ($hasStrong) {
        $ck = 'B1'
        $reason = (TT 'r_b1a') + $q1 + $strongTxt + $q2
      } else {
        $ck = 'B2'; $reason = (TT 'r_b2')
      }
    }
    elseif ($dcls -eq 'A') {
      if ($hasStrong) {
        $ck = 'A1'
        $reason = (TT 'r_a1a') + $q1 + $strongTxt + $q2
      } else {
        $ck = 'A2'; $reason = (TT 'r_a2')
      }
    }
    elseif ($dcls -eq 'F') {
      $ck = 'F1'; $reason = (TT 'r_f1')
    }
    elseif ($dcls -eq 'C' -or $dcls -eq 'E' -or $dcls -eq 'D') {
      if ($dcls -eq 'C') { $tags = TT 'tag_C' } elseif ($dcls -eq 'E') { $tags = TT 'tag_E' } else { $tags = TT 'tag_D' }
      if ($hasList) {
        $ck = 'N2'; $reason = (TT 'r_n2a') + $procHits + (TT 'r_n2e')
      } elseif ($hasAband) {
        $ck = 'Z2'; $reason = $tags + (TT 'r_z2a')
      } elseif ($hasProc) {
        if ($hasStrong) {
          $ck = 'W2'; $reason = $tags + (TT 'r_w2a') + $procHits + (TT 'r_w2b')
        } else {
          $ck = 'Z3'; $reason = $tags + (TT 'r_z3a') + $procHits + (TT 'r_z3b')
        }
      } elseif ($hasStrong) {
        if ($stem -match (TT 're_draft')) {
          $ck = 'W1'; $reason = $tags + (TT 'r_w1a') + $q1 + $strongTxt + $q2 + (TT 'r_w1b')
        } else {
          $ck = 'C1'; $reason = $tags + (TT 'r_c1b')
        }
      } else {
        $ck = 'W3'; $reason = $tags + (TT 'r_w3')
      }
    }
    else {
      if ($hasAband) {
        $ck = 'Z2'; $reason = (TT 'r_z2c')
      } elseif ($hasList) {
        $ck = 'N2'
        $reason = (TT 'r_n2a') + $procHits + (TT 'r_n2b')
        if ($hasStrong) { $reason = $reason + (TT 'r_n2c') + $q1 + $strongTxt + $q2 + (TT 'r_n2d') }
      } elseif ($hasStrong) {
        $ck = 'N1'
        $reason = (TT 'r_n1a') + $q1 + $strongTxt + $q2
      } elseif ($hasProc) {
        $ck = 'N2'
        $reason = (TT 'r_n2a') + $procHits + (TT 'r_n2e')
      } else {
        $ck = 'N3'; $reason = (TT 'r_n3')
      }
    }
  }

  $rows.Add([pscustomobject]@{
    rel = $f.rel; name = $name; dir = $dir; ext = $f.ext; size = $f.size; mtime = $f.mtime
    cat = $CAT_TEXT[$ck]; ckey = $ck; verdict = $CAT_VERDICT[$ck]; reason = $reason
  })
}

# ---------- 4. 落盘 JSON + 扫描后快照 ----------
[System.IO.File]::WriteAllText((Join-Path $OutDir 'zhidu-scan.json'), ($rows | ConvertTo-Json -Depth 5), $UTF8)
$snap = Get-ChildItem -LiteralPath $Root -Force -Recurse | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.FullName, $_.Length, $_.LastWriteTimeUtc.Ticks, $_.Attributes }
[System.IO.File]::WriteAllLines((Join-Path $OutDir 'zhidu-post-snapshot.txt'), $snap, $UTF8)

# ---------- 5. 生成 Markdown ----------
$sb = New-Object System.Text.StringBuilder
function W([string]$s) { [void]$sb.AppendLine($s) }
function RowsOf([string]$ck) { return @($rows | Where-Object { $_.ckey -eq $ck } | Sort-Object rel) }

$vRule = TT 'ver_B1'
$vNon  = TT 'ver_Z1'
$vWai  = TT 'ver_W1'
$gRule = @($rows | Where-Object { $_.verdict -eq $vRule } | Sort-Object rel)
$gNon  = @($rows | Where-Object { $_.verdict -eq $vNon }  | Sort-Object rel)
$gWai  = @($rows | Where-Object { $_.verdict -eq $vWai }  | Sort-Object rel)
$nTotal = $rows.Count; $nRule = $gRule.Count; $nNon = $gNon.Count; $nWai = $gWai.Count
$sumSize = [int64](($rows | Measure-Object size -Sum).Sum)
$ruleSize = [int64](($gRule | Measure-Object size -Sum).Sum)
$nonSize = [int64](($gNon | Measure-Object size -Sum).Sum)
$waiSize = [int64](($gWai | Measure-Object size -Sum).Sum)
$scanAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
function Pct([int]$n) { return ([string][math]::Round(100.0 * $n / $nTotal, 1) + '%') }

$L = New-Object System.Collections.Generic.List[string]

$L.Add('# ' + (TT 'h_title')); $L.Add('')
$L.Add('> ' + (TT 'h_root') + '`' + $Root + '`  ')
$L.Add('> ' + (TT 'h_time') + $scanAt + '  ')
$L.Add('> ' + (TT 'h_count') + '**' + $nTotal + '**' + (TT 'h_dirs') + '**' + $dirEntries.Count + '**  ')
$L.Add('> **' + (TT 'h_warn') + '**')
$L.Add('> ' + (TT 'h_note')); $L.Add('')

$L.Add('## 1. ' + (TT 's1')); $L.Add('')
$L.Add('| ' + (TT 't_verdict') + ' | ' + (TT 't_files') + ' | ' + (TT 't_share') + ' | ' + (TT 't_volume') + ' |')
$L.Add('| --- | ---: | ---: | ---: |')
$L.Add('| ' + $vRule + ' | ' + $nRule + ' | ' + (Pct $nRule) + ' | ' + (FmtSize $ruleSize) + ' |')
$L.Add('| ' + $vNon + ' | ' + $nNon + ' | ' + (Pct $nNon) + ' | ' + (FmtSize $nonSize) + ' |')
$L.Add('| ' + $vWai + ' | ' + $nWai + ' | ' + (Pct $nWai) + ' | ' + (FmtSize $waiSize) + ' |')
$L.Add('| **' + (TT 't_total') + '** | **' + $nTotal + '** | 100% | ' + (FmtSize $sumSize) + ' |')
$L.Add('')
$L.Add('### 1.1 ' + (TT 's11')); $L.Add('')
$L.Add('| ' + (TT 't_cat') + ' | ' + (TT 't_verdict') + ' | ' + (TT 't_files') + ' | ' + (TT 't_rulemean') + ' |')
$L.Add('| --- | --- | ---: | --- |')
foreach ($k in $CAT_KEYS) {
  $n = @($rows | Where-Object { $_.ckey -eq $k }).Count
  if ($n -gt 0) { $L.Add('| ' + $CAT_TEXT[$k] + ' | ' + $CAT_VERDICT[$k] + ' | ' + $n + ' | ' + (TT ('desc_' + $k)) + ' |') }
}
$L.Add('')
$L.Add('### 1.2 ' + (TT 's12')); $L.Add('')
$L.Add('| ' + (TT 't_ext') + ' | ' + (TT 't_files') + ' | ' + $vRule + ' | ' + $vNon + ' | ' + $vWai + ' |')
$L.Add('| --- | ---: | ---: | ---: | ---: |')
foreach ($grp in ($rows | Group-Object ext | Sort-Object { -$_.Count })) {
  $e = $grp.Name; if ($e -eq '') { $e = TT 'noext' }
  $g = $grp.Group
  $L.Add('| ' + $e + ' | ' + $g.Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vRule }).Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vNon }).Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vWai }).Count + ' |')
}
$L.Add('')
$L.Add('### 1.3 ' + (TT 's13')); $L.Add('')
$L.Add('| ' + (TT 't_topdir') + ' | ' + (TT 't_files') + ' | ' + $vRule + ' | ' + $vNon + ' | ' + $vWai + ' |')
$L.Add('| --- | ---: | ---: | ---: | ---: |')
foreach ($grp in ($rows | Group-Object { if ($_.dir -eq '') { TT 'rootdir' } else { $_.dir.Split([char[]]@([char]92))[0] } } | Sort-Object Name)) {
  $g = $grp.Group
  $L.Add('| ' + $grp.Name + ' | ' + $g.Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vRule }).Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vNon }).Count + ' | ' + @($g | Where-Object { $_.verdict -eq $vWai }).Count + ' |')
}
$L.Add('')

$L.Add('## 2. ' + (TT 's2')); $L.Add('')
$L.Add((TT 's2_intro')); $L.Add('')
$L.Add('| ' + (TT 't_step') + ' | ' + (TT 't_rule') + ' | ' + (TT 't_effect') + ' |')
$L.Add('| --- | --- | --- |')
foreach ($k in @('R0','R1','R2','R3','R3b','R3c','R4')) {
  $L.Add('| ' + $k + ' | ' + (TT ('rule_' + $k)) + ' | ' + (TT ('eff_' + $k)) + ' |')
}
$L.Add('')
$L.Add((TT 's2_eg')); $L.Add('')
foreach ($e in @('eg1','eg2','eg3','eg4','eg5','eg6')) { $L.Add('- ' + (TT $e)) }
$L.Add('')

$L.Add('## 3. ' + (TT 's3')); $L.Add('')
$L.Add('> ' + (TT 's3_note1') + $nTotal + (TT 's3_note2') + $TopN + (TT 's3_note3')); $L.Add('')
function EmitTop([object[]]$items, [string]$title, [int]$n) {
  $take = [math]::Min($n, $items.Count)
  $L.Add('### ' + $title + (TT 'g_of') + $items.Count + (TT 'g_show') + $take + (TT 'g_rows'))
  $L.Add('')
  $L.Add('| # | ' + (TT 't_relpath') + ' | ' + (TT 't_size') + ' | ' + (TT 't_verdict') + ' | ' + (TT 't_reason') + ' |')
  $L.Add('| ---: | --- | ---: | --- | --- |')
  $i = 0
  foreach ($r in ($items | Select-Object -First $n)) {
    $i++
    $L.Add('| ' + $i + ' | ' + (TblCell $r.rel) + ' | ' + (FmtSize $r.size) + ' | ' + $r.verdict + ' | ' + (TblCell $r.reason) + ' |')
  }
  $L.Add('')
}
$g1keys = @('B1','A1','F1','C1','N1')
$g2keys = @('G1','G2','G3','H1','W1','W2','W3','B2','A2','N2','N3')
$g3keys = @('Z3','Z2','Z1','Z0')
foreach ($k in $g1keys) {
  $it = RowsOf $k
  if ($it.Count -gt 0) { EmitTop $it ('3.1 ' + (TT ('cat_' + $k))) $TopN }
}
foreach ($k in $g2keys) {
  $it = RowsOf $k
  if ($it.Count -gt 0) { EmitTop $it ('3.2 ' + (TT ('cat_' + $k))) $TopN }
}
foreach ($k in $g3keys) {
  $it = RowsOf $k
  if ($it.Count -gt 0) { EmitTop $it ('3.3 ' + (TT ('cat_' + $k))) $TopN }
}
$uniqRule = @($gRule | Select-Object -ExpandProperty name | Select-Object -Unique).Count
$L.Add((TT 's3_dedup1') + $nRule + (TT 's3_dedup2') + '**' + $uniqRule + (TT 's3_dedup3')); $L.Add('')

$L.Add('## 4. ' + (TT 's4')); $L.Add('')
function EmitAll([object[]]$items, [string]$title) {
  $L.Add('### ' + $title + (TT 'g_of') + $items.Count + (TT 'g_rows'))
  $L.Add('')
  $L.Add('| # | ' + (TT 't_relpath') + ' | ' + (TT 't_size') + ' | ' + (TT 't_mtime') + ' | ' + (TT 't_verdict') + ' | ' + (TT 't_cat') + ' | ' + (TT 't_reason') + ' |')
  $L.Add('| ---: | --- | ---: | --- | --- | --- | --- |')
  $i = 0
  foreach ($r in $items) {
    $i++
    $L.Add('| ' + $i + ' | ' + (TblCell $r.rel) + ' | ' + (FmtSize $r.size) + ' | ' + $r.mtime + ' | ' + $r.verdict + ' | ' + (TblCell $r.cat) + ' | ' + (TblCell $r.reason) + ' |')
  }
  $L.Add('')
}
EmitAll $gRule ('4.1 ' + (TT 's41'))
EmitAll $gNon  ('4.2 ' + (TT 's42'))
EmitAll $gWai  ('4.3 ' + (TT 's43'))

$L.Add('## 5. ' + (TT 's5')); $L.Add('')
$cnt = @{}
foreach ($k in $g2keys + $g3keys + @('W1','W2','W3','Z2','B2','A2','G1','H1')) { $cnt[$k] = @($rows | Where-Object { $_.ckey -eq $k }).Count }
$L.Add('- **' + (TT 'u1t') + '** ' + (TT 'u1a') + $cnt['W1'] + (TT 'u1b'))
$L.Add('- **' + (TT 'u2t') + '** ' + $cnt['W2'] + (TT 'u2b'))
$L.Add('- **' + (TT 'u3t') + '** ' + $cnt['H1'] + (TT 'u3b'))
$L.Add('- **' + (TT 'u4t') + '** ' + (TT 'u4b'))
$L.Add('- **' + (TT 'u5t') + '** ' + $cnt['W3'] + (TT 'u5b'))
$L.Add('- **' + (TT 'u6t') + '** ' + (TT 'u6a') + $cnt['A2'] + (TT 'u6b'))
$L.Add('- **' + (TT 'u7t') + '** ' + (TT 'u7a') + $cnt['B2'] + (TT 'u7b'))
$L.Add('- **' + (TT 'u8t') + '** ' + (TT 'u8a') + $cnt['Z2'] + (TT 'u8b'))
$L.Add('- **' + (TT 'u9t') + '** ' + (TT 'u9a') + $cnt['G1'] + (TT 'u9b'))
$L.Add('- **' + (TT 'u10t') + '** ' + (TT 'u10b'))
$L.Add('- **' + (TT 'u11t') + '** ' + (TT 'u11b'))
$L.Add('')

$L.Add('## 6. ' + (TT 's6')); $L.Add('')
$b1 = @($rows | Where-Object { $_.ckey -in @('B1','A1','F1') })
$b2 = @($rows | Where-Object { $_.ckey -in @('C1','W1') })
$b3 = @($rows | Where-Object { $_.ckey -in @('G1','G2','G3') })
$b4 = @($rows | Where-Object { $_.ckey -eq 'H1' })
$bNo = @($rows | Where-Object { $_.ckey -in @('Z0','Z1','Z2','Z3') })
$s1 = [int64](($b1 | Measure-Object size -Sum).Sum)
$s2 = [int64](($b2 | Measure-Object size -Sum).Sum)
$s3 = [int64](($b3 | Measure-Object size -Sum).Sum)
$s4 = [int64](($b4 | Measure-Object size -Sum).Sum)
$sNo = [int64](($bNo | Measure-Object size -Sum).Sum)
function UniqN([object[]]$items) { return @($items | Select-Object -ExpandProperty name | Select-Object -Unique).Count }
function Mid([object[]]$items) {
  $lo = 0.0; $hi = 0.0
  foreach ($r in @($items)) { $e = EstChars ([int64]$r.size); $lo += $e[0]; $hi += $e[1] }
  return (($lo + $hi) / 2)
}
$L.Add('| ' + (TT 't_batch') + ' | ' + (TT 't_scope') + ' | ' + (TT 't_files') + ' | ' + (TT 't_uniq') + ' | ' + (TT 't_volume') + ' | ' + (TT 't_est') + ' | ' + (TT 't_note') + ' |')
$L.Add('| --- | --- | ---: | ---: | ---: | ---: | --- |')
$L.Add('| **' + (TT 'b1n') + '** | ' + (TT 'b1s') + ' | ' + $b1.Count + ' | ' + (UniqN $b1) + ' | ' + (FmtSize $s1) + ' | ' + (EstWanStr $b1) + ' | ' + (TT 'b1d') + ' |')
$L.Add('| ' + (TT 'b2n') + ' | ' + (TT 'b2s') + ' | ' + $b3.Count + ' | ' + (UniqN $b3) + ' | ' + (FmtSize $s3) + ' | ' + (EstWanStr $b3) + ' | ' + (TT 'b2d') + ' |')
$L.Add('| ' + (TT 'b3n') + ' | ' + (TT 'b3s') + ' | ' + $b4.Count + ' | ' + (UniqN $b4) + ' | ' + (FmtSize $s4) + ' | ' + (EstWanStr $b4) + ' | ' + (TT 'b3d') + ' |')
$L.Add('| ' + (TT 'b4n') + ' | ' + (TT 'b4s') + ' | ' + $b2.Count + ' | ' + (UniqN $b2) + ' | ' + (FmtSize $s2) + ' | ' + (EstWanStr $b2) + ' | ' + (TT 'b4d') + ' |')
$L.Add('| ' + (TT 'b5n') + ' | ' + (TT 'b5s') + ' | ' + $bNo.Count + ' | ' + (UniqN $bNo) + ' | ' + (FmtSize $sNo) + ' | - | ' + (TT 'b5d') + ' |')
$L.Add('')
$mid1 = Mid $b1
$blocks = [math]::Round($mid1 / 500 / 100) * 100
$L.Add('**' + (TT 'cost_t') + '**' + (TT 'cost_a') + $b1.Count + (TT 'cost_b') + (FmtSize $s1) + (TT 'cost_c') + (EstWanStr $b1) + (TT 'cost_d') + ([string][math]::Round($mid1 / 10000, 1)) + (TT 'cost_e') + $blocks + (TT 'cost_f'))
$L.Add('**' + (TT 'order_t') + '**' + (TT 'order_b'))
$L.Add('')

$L.Add('## 7. ' + (TT 's7')); $L.Add('')
$L.Add('| ' + (TT 't_guar') + ' | ' + (TT 't_how') + ' |')
$L.Add('| --- | --- |')
foreach ($k in @('1','2','3','4','5')) { $L.Add('| ' + (TT ('g_' + $k + '_t')) + ' | ' + (TT ('g_' + $k + '_d')) + ' |') }
$L.Add('')
$basePath = Join-Path $OutDir 'zhidu-baseline-snapshot.txt'
$postPath = Join-Path $OutDir 'zhidu-post-snapshot.txt'
if ((Test-Path -LiteralPath $basePath) -and (Test-Path -LiteralPath $postPath)) {
  $b = @(Get-Content -LiteralPath $basePath -Encoding UTF8)
  $p = @(Get-Content -LiteralPath $postPath -Encoding UTF8)
  $d = @(Compare-Object -ReferenceObject $b -DifferenceObject $p)
  $hb = (Get-FileHash -LiteralPath $basePath -Algorithm SHA256).Hash
  $hp = (Get-FileHash -LiteralPath $postPath -Algorithm SHA256).Hash
  $L.Add('| ' + (TT 't_item') + ' | ' + (TT 't_before') + ' | ' + (TT 't_after') + ' |')
  $L.Add('| --- | --- | --- |')
  $L.Add('| ' + (TT 't_entries') + ' | ' + $b.Count + ' | ' + $p.Count + ' |')
  $L.Add('| ' + (TT 't_sha') + ' | `' + $hb + '` | `' + $hp + '` |')
  $L.Add('| ' + (TT 't_diff') + ' | ' + $d.Count + ' | - |')
  $L.Add('')
  if ($d.Count -eq 0) { $L.Add('**' + (TT 'snap_ok') + '**') } else {
    $L.Add('**' + (TT 'snap_bad') + '**'); $L.Add(''); $L.Add('```')
    foreach ($x in $d) { $L.Add($x.SideIndicator + ' ' + $x.InputObject) }
    $L.Add('```')
  }
} else { $L.Add((TT 'snap_na')) }
$L.Add('')
$L.Add('---')
$L.Add('')
$L.Add((TT 'footer'))

[System.IO.File]::WriteAllLines($MdOut, $L.ToArray(), $UTF8)
Write-Output ('FILES=' + $nTotal + ' DIRS=' + $dirEntries.Count)
Write-Output ($vRule + '=' + $nRule + ' ' + $vNon + '=' + $nNon + ' ' + $vWai + '=' + $nWai)
Write-Output ('MD=' + $MdOut)
