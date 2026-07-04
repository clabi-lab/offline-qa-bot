# models.txt -> models.config.js (window.QA_BOT_MODELS) 재생성. Windows(PowerShell)용.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\update-models.ps1
$ErrorActionPreference = "Stop"

$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $dir
$src  = Join-Path $root "models.txt"
$out  = Join-Path $root "models.config.js"

if (-not (Test-Path -LiteralPath $src)) {
  Write-Error "models.txt 를 찾을 수 없습니다: $src"
  exit 1
}

# JS 문자열 이스케이프: 백슬래시를 먼저 두 배로(\ -> \\), 그다음 큰따옴표를 \" 로.
#   -replace 는 정규식이라 패턴 '\\' = 백슬래시 1개, 치환 '\\' = 백슬래시 2개(치환문자열에선 $만 특수).
#   순서 중요(따옴표 먼저 하면 백슬래시가 이중 이스케이프됨). update-models.sh 의 awk esc()와 동일 결과.
function Esc([string]$s) { return ($s -replace '\\', '\\' -replace '"', '\"') }

$entries = @()
foreach ($raw in (Get-Content -LiteralPath $src)) {
  $line = $raw.TrimEnd("`r")
  $t = $line.TrimStart()
  if ($t -eq "" -or $t.StartsWith("#")) { continue }
  $parts = $line.Split("|")
  $label    = $parts[0].Trim()
  $endpoint = if ($parts.Count -ge 2) { $parts[1].Trim() } else { "" }
  $model    = if ($parts.Count -ge 3) { $parts[2].Trim() } else { "" }
  $ctx      = if ($parts.Count -ge 4) { $parts[3].Trim() } else { "" }
  if ($label -eq "" -or $endpoint -eq "") { Write-Warning "건너뜀(label/endpoint 누락): $line"; continue }
  if ($model -eq "") { $model = $label }
  $rec = "  {`n    ""label"": ""$(Esc $label)"",`n    ""endpoint"": ""$(Esc $endpoint)"",`n    ""model"": ""$(Esc $model)"""
  if ($ctx -match '^[0-9]+$') { $rec += ",`n    ""contextChars"": $ctx" }
  $rec += "`n  }"
  $entries += $rec
}

if ($entries.Count -eq 0) {
  Write-Error "유효한 모델 항목이 없습니다(models.txt 확인). 기존 $out 는 그대로 둡니다."
  exit 3
}

$body = $entries -join ",`n"
$content = @"
// 환경별 모델 설정 — scripts/update-models 가 models.txt 로부터 자동 생성. 직접 편집하지 마세요.
// 이 파일이 없거나 비면 app.js 내장 기본값으로 폴백합니다.
window.QA_BOT_MODELS = [
$body
];
"@

Set-Content -LiteralPath $out -Value $content -Encoding UTF8
Write-Host "OK: $out 갱신 ($($entries.Count) 개 모델)"
