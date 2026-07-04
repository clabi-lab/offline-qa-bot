#!/bin/sh
# src/*.js 기능별 조각을 하나의 app.js 로 결합한다(빌드 도구 없이 file:// 배포 유지).
# 개발은 src/ 의 작은 파일에서 하고, 이 스크립트로 app.js 를 재생성한 뒤 index.html 을 새로고침한다.
# 조각 결합 순서는 파일명 접두 번호(00,10,20,…)를 따른다.
set -e
here=$(dirname "$0")
root=$(cd "$here/.." && pwd)
out="$root/app.js"

{
  echo "// ============================================================================"
  echo "// 생성 파일 — 직접 편집하지 마세요. src/*.js 를 편집하고 scripts/build.sh 를 실행하세요."
  echo "// index.html 은 이 결합본을 로드합니다. 조각 순서는 파일명 접두 번호(00,10,…)를 따릅니다."
  echo "// ============================================================================"
  # LC_ALL=C 로 결합 순서를 고정(로케일 무관 사전순 = 접두 번호 순).
  for f in $(LC_ALL=C ls "$root"/src/*.js); do
    cat "$f"
  done
} > "$out"

count=$(LC_ALL=C ls "$root"/src/*.js | wc -l | tr -d ' ')
lines=$(wc -l < "$out" | tr -d ' ')
echo "OK: app.js 재생성 ($count 조각 → $lines 줄)"
