// 환경별 모델 설정 — scripts/update-models 가 models.txt 로부터 자동 생성. 직접 편집하지 마세요.
// 이 파일이 없거나 비면 app.js 내장 기본값으로 폴백합니다.
window.QA_BOT_MODELS = [
  {
    "label": "Gemma4 31B",
    "endpoint": "http://model.local/gemma4-31b/v1/chat/completions",
    "model": "gemma-4-31B-it",
    "contextChars": 65536
  },
  {
    "label": "Gemma4 26B",
    "endpoint": "http://model.local/gemma4/v1/chat/completions",
    "model": "gemma-4-26B-it",
    "contextChars": 65536
  }
];
