#!/usr/bin/env sh
# models.txt -> models.config.js (window.QA_BOT_MODELS) 재생성.
# mac/linux 용. Windows 는 update-models.ps1 또는 update-models.bat 사용.
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
SRC="$ROOT/models.txt"
OUT="$ROOT/models.config.js"

if [ ! -f "$SRC" ]; then
  echo "models.txt 를 찾을 수 없습니다: $SRC" >&2
  exit 1
fi

TMP=$(mktemp)
if ! awk -F'|' '
  function trim(s){ sub(/^[ \t\r]+/,"",s); sub(/[ \t\r]+$/,"",s); return s }
  function esc(s){ gsub(/\\/,"\\\\",s); gsub(/"/,"\\\"",s); return s }
  BEGIN{ n=0 }
  {
    line=$0; sub(/\r$/,"",line)
    t=line; sub(/^[ \t]+/,"",t)
    if (t=="" || substr(t,1,1)=="#") next
    label=trim($1); endpoint=trim($2); model=trim($3); ctx=trim($4)
    if (label=="" || endpoint=="") { print "WARN 건너뜀(label/endpoint 누락): " line > "/dev/stderr"; next }
    if (model=="") model=label
    n++
    rec[n]="  {\n    \"label\": \"" esc(label) "\",\n    \"endpoint\": \"" esc(endpoint) "\",\n    \"model\": \"" esc(model) "\""
    if (ctx ~ /^[0-9]+$/) rec[n]=rec[n] ",\n    \"contextChars\": " ctx
    rec[n]=rec[n] "\n  }"
  }
  END{
    if (n==0){ print "ERROR: 유효한 모델 항목이 없습니다(models.txt 확인)." > "/dev/stderr"; exit 3 }
    print "// 환경별 모델 설정 — scripts/update-models 가 models.txt 로부터 자동 생성. 직접 편집하지 마세요."
    print "// 이 파일이 없거나 비면 app.js 내장 기본값으로 폴백합니다."
    print "window.QA_BOT_MODELS = ["
    for(i=1;i<=n;i++){ printf "%s%s\n", rec[i], (i<n?",":"") }
    print "];"
  }
' "$SRC" > "$TMP"; then
  rm -f "$TMP"
  echo "생성 실패 — 기존 $OUT 는 그대로 둡니다." >&2
  exit 3
fi

mv "$TMP" "$OUT"
echo "OK: $OUT 갱신 ($(grep -c '"endpoint"' "$OUT") 개 모델)"
