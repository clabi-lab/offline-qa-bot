# src\*.js 기능별 조각을 하나의 app.js 로 결합한다(빌드 도구 없이 file:// 배포 유지).
# 개발은 src\ 의 작은 파일에서 하고, 이 스크립트로 app.js 를 재생성한 뒤 index.html 을 새로고침한다.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "app.js"

# 조각은 파일명 접두 번호(00,10,20,…) 사전순으로 결합한다.
$files = Get-ChildItem -Path (Join-Path $root "src") -Filter "*.js" | Sort-Object Name

$header = @(
  "// ============================================================================"
  "// 생성 파일 — 직접 편집하지 마세요. src/*.js 를 편집하고 scripts/build.ps1 을 실행하세요."
  "// index.html 은 이 결합본을 로드합니다. 조각 순서는 파일명 접두 번호(00,10,…)를 따릅니다."
  "// ============================================================================"
) -join "`n"

# 원본 조각의 바이트를 그대로 이어 붙인다(개행 손상 방지). 각 조각 파일은 개행으로 끝나도록 유지.
$sb = New-Object System.Text.StringBuilder
[void]$sb.Append($header)
[void]$sb.Append("`n")
foreach ($f in $files) {
  [void]$sb.Append((Get-Content -Raw -Encoding UTF8 $f.FullName))
}

# UTF-8 (BOM 없음) 으로 저장
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($out, $sb.ToString(), $utf8NoBom)

Write-Host ("OK: app.js 재생성 ({0} 조각)" -f $files.Count)
