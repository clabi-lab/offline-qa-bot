# Offline QA Bot

OpenAI-compatible chat endpoint를 **브라우저에서 직접 호출**하는 단일 페이지 정적 QA 화면입니다.
외부 CDN·npm package·서버·proxy·웹 글꼴 없이 `index.html`, `app.js`, `styles.css` 세 파일만으로 동작하므로
인터넷이 차단된 온프레미스/오프라인 환경에 폴더째 복사해 바로 쓸 수 있습니다.

vLLM, Ollama, TGI, LM Studio 등 **OpenAI Chat Completions 호환 서버라면 무엇이든** 연결할 수 있습니다.

> 배포·실행에 필요한 파일은 여전히 `index.html`·`app.js`·`styles.css` **세 개**입니다. 유지보수 편의를 위해
> `app.js` 는 `src/` 의 기능별 조각을 결합해 만든 **생성물**이며(아래 [코드 구조](#코드-구조--개발) 참고),
> 배포 시에는 결합된 `app.js` 하나만 복사하면 됩니다.

## 빠른 시작

1. **Chrome에서 `index.html`을 더블클릭(`file://`)** 합니다. 별도 서버·Python·설치가 필요 없습니다.
2. 좌측 `Endpoint`의 URL과 `Body model`을 **여러분의 OpenAI-compatible 서버**에 맞게 수정합니다.
   (예: `http://localhost:8000/v1/chat/completions`, model `your-model-name`)
3. `연결 확인`을 눌러 호출 경로가 정상인지 점검합니다.
4. 질문을 입력하고 `전송`(Enter, 줄바꿈은 Shift+Enter)을 누릅니다.

글꼴은 OS 기본 글꼴(Segoe UI / 맑은 고딕 / Consolas 등)을 사용하며 외부 글꼴을 내려받지 않습니다.
대화는 브라우저 `localStorage`에 자동 저장됩니다.

## 모델 / Endpoint 설정

온프레미스 환경마다 모델 경로가 다르므로, **`models.txt` 한 파일을 편집하고 스크립트를 실행**하면 됩니다(코드 수정 불필요).

1. `models.txt` 를 엽니다. 형식은 `label | endpoint | model | contextChars(선택)`, `#` 주석/빈 줄 무시:
   ```
   My Model | http://localhost:8000/v1/chat/completions | my-model-name | 32768
   ```
2. 스크립트로 적용 — `models.config.js`(브라우저가 읽는 `window.QA_BOT_MODELS`)가 재생성됩니다:
   - **macOS / Linux** (Git Bash·WSL 포함): `sh scripts/update-models.sh`
   - **Windows**: 탐색기에서 `scripts\update-models.bat` 더블클릭, 또는
     `powershell -ExecutionPolicy Bypass -File scripts\update-models.ps1`
   - 성공하면 `OK: ... 갱신 (N 개 모델)` 이 출력됩니다. `models.txt` 에 유효한 줄이 없으면
     오류만 내고 기존 `models.config.js` 는 건드리지 않습니다(안전).
3. 브라우저에서 `index.html` 을 **새로고침**하면 새 모델이 반영됩니다.

스크립트 없이 `models.config.js` 를 직접 편집해도 동작하지만, `models.txt` + 스크립트 방식이 더 안전합니다.

| 필드 | 의미 |
|---|---|
| `label` | 화면에 표시할 이름 |
| `endpoint` | OpenAI-compatible `/v1/chat/completions` URL |
| `model` | 요청 body의 `model` 값 (생략 시 label 사용) |
| `contextChars` | 입력에 쓸 '문자' 예산 ≈ (모델 컨텍스트 토큰 − 출력 예약 토큰) × ~2자/토큰 (생략 가능) |

`models.config.js` 가 없거나 비면 `app.js` 의 내장 기본값으로 폴백합니다. UI의 `Endpoint`·`Body model`·`Generation`(temperature·max_tokens·top_p)·`최대 맥락 문자 수`도 모델별로 **즉시** 바꿀 수 있고(비워 두면 서버 기본값), 요청은 OpenAI Chat Completions 호환 shape(`model`, `messages`, `stream`, 선택적 `temperature`/`max_tokens`/`top_p`)을 사용합니다.

**API 인증**: 기본적으로 인증 헤더를 보내지 않습니다. 인증이 걸린 서버(vLLM `--api-key`, 게이트웨이/프록시 등)는 모델 설정(⋯)의 `API Key` 칸에 키를 넣으면 `Authorization: Bearer <키>`로 전송합니다(공백이 포함된 값은 그대로 전송해 커스텀 스킴도 지원). 키는 `localStorage`에 저장되며 대화 JSON 내보내기에는 포함되지 않습니다.

> `최대 맥락 문자 수`(`contextChars`)는 서빙 모델의 실제 컨텍스트 창(예: vLLM `--max-model-len`)에 맞춰 설정하세요.
> 무작정 크게 잡으면 서버에서 잘리거나 오류가 날 수 있습니다.

**컨텍스트 길이를 모를 때**: `models.txt` 의 `contextChars` 를 **비워 두면** 앱이 안전한 기본 예산을 사용하고,
실행 후 화면의 `최대 맥락 문자 수` 에서 모델별로 즉시 조정할 수 있습니다(단발 호출은 현재 메시지만 보내므로
영향이 없고, 멀티턴에서 이전 대화를 얼마나 포함할지에만 작용합니다). 정확한 값이 필요하면 OpenAI 호환 서버의
`GET <엔드포인트 베이스>/models` 응답에서 `max_model_len`(vLLM) 을 확인해 `(max_model_len − 출력예약) × ~2` 로 계산하세요.

## CORS 요구사항

브라우저는 `file://`에서 요청할 때 Origin 헤더를 리터럴 `null`로 보내고, `application/json` 본문 때문에
매 요청 전 preflight `OPTIONS`를 보냅니다. 엔드포인트(또는 앞단 게이트웨이/프록시)는 다음을 만족해야 합니다.

- `OPTIONS`에 `200` 또는 `204` 응답
- `Access-Control-Allow-Origin: *` — 이 앱은 쿠키/인증을 보내지 않으므로 `*`가 `null`을 포함한 모든 origin을 가장 단순하게 커버합니다. `*`가 어려우면 `null`을 echo 합니다.
- `Access-Control-Allow-Methods: POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`
- `Access-Control-Allow-Credentials`는 설정하지 않습니다(`*`/`null`과 충돌).

> curl로는 되는데 브라우저에서만 실패한다면 거의 항상 CORS 문제입니다. curl은 CORS를 거치지 않기 때문입니다.

## 주요 기능

### 대화 관리 · 폴더
좌측 `Conversation` 패널에서 대화를 만들고 검색·고정·이름변경·삭제할 수 있습니다. `+ 폴더`로 폴더를 만들어
대화를 분류하세요. 대화 `⋯` 메뉴의 `폴더로 이동`으로 넣고, 폴더 헤더를 눌러 접거나 펼칩니다. 고정한 대화는
폴더와 무관하게 항상 상단에 유지되고, 대화 검색 중에는 폴더 경계를 무시하고 전체에서 찾습니다. 폴더를 삭제해도
안의 대화는 삭제되지 않고 `미분류`로 이동합니다.

### 파일 첨부
`파일 첨부`는 파일을 서버에 업로드하지 않습니다. 브라우저가 로컬 파일을 텍스트로 읽어, 전송 시 사용자 메시지
아래에 코드 블록으로 합쳐 보냅니다. 버튼 외에 **입력창으로 드래그앤드롭**하거나 **파일을 복사해 붙여넣어**도 첨부됩니다.
UTF-8로 읽을 수 없는 파일은 **EUC-KR/CP949**로 자동 재디코딩하며(첨부 칩에 인코딩 표시), 한국 폐쇄망의 ANSI 텍스트도 깨지지 않습니다.

각 첨부는 코드 펜스 첫 줄에 **파일명 주석 헤더**(`# main.py`, `// app.js`, `-- query.sql` 등)를 넣어
모델이 어떤 파일인지 바로 인식하게 합니다. `.py`·`.js`·`.ts`·`.sql`·`.json`·`.yaml`·`.sh`·`.md`·`.log`·`.html`·`.css`
같은 텍스트 파일과 `Dockerfile`·`Makefile`·`.gitignore` 같은 확장자 없는 개발 파일을 지원합니다(이미지는 미포함).
큰 파일은 한도 내에서 일부만 포함하며, 한도 상수(`MAX_TEXT_ATTACHMENT_CHARS`, `MAX_TOTAL_ATTACHMENT_CHARS`,
`MAX_ATTACHMENTS`)는 `src/00-core.js` 상단에서 조정한 뒤 빌드하면 됩니다.

### 맥락(대화 누적) 관리
화면에는 전체 대화가 유지되지만, 모델로 보낼 때는 OpenAI `messages` 배열로 구성합니다.

- `이전 대화 포함` 토글을 끄면 system + **현재 메시지만** 보냅니다(단발 호출). 켜면 멀티턴으로 보냅니다.
- 멀티턴일 때는 모델별 `최대 맥락 문자 수`를 넘지 않도록 **오래된 메시지부터 연속으로** 제외합니다(system prompt와 최신 메시지는 항상 유지).
- 예산을 넘겨 빠진 오래된 메시지는 화면에서 **흐리게** 표시되고, 실제 전송되는 첫 메시지 앞에 경계선이 표시됩니다.
- 헤더의 `맥락 78% (≈25k/96k자, N/M)`로 사용량을 한눈에 보고, 80%↑ 강조·100%↑ 점선 경고가 표시됩니다.
- 대화가 길어지면 `요약하기`로 오래된 메시지를 1건으로 압축할 수 있습니다. **원문은 삭제되지 않고** 펼쳐 다시 볼 수 있습니다(요청에는 요약본만 전송).

### 답변 보기 / 내보내기
- 모델 답변의 Markdown(코드 펜스, 인라인 코드, 굵게, 제목, 인용, 목록, 간단한 표, 링크)을 읽기 쉽게 표시하고, 코드 블록은 가로 스크롤과 `코드 복사`를 제공합니다. 가로로 넘치는 코드·표는 블록 **상단 툴바의 ‹ › 버튼**으로 페이지 단위 이동합니다(콘텐츠를 가리지 않음).
- **스트리밍 중에도 마크다운으로 렌더**됩니다(제목·굵게·코드블록·표가 생성되는 대로 보이고, 끝에 생성 커서 표시). 원문 기호가 그대로 노출되거나 완료 순간 통째로 바뀌는 점프가 없습니다.
- 추론(reasoning) 모델은 본문 전 추론 단계 동안 `추론 중… (N자)`로 진행을 표시합니다(추론 내용은 최종 답변에 포함하지 않음).
- 대화를 스크롤해 위쪽(과거)을 읽는 중에는 응답이 완료돼도 읽던 위치를 유지하고, 바닥에서 멀어지면 `↓ 맨 아래로` 버튼이 나타납니다.
- `답변 복사`/`코드 복사`로 개별 복사, `대화 복사(MD)`로 대화 전체를 Markdown으로 복사합니다.
- `cURL 복사`는 현재 endpoint·body·system prompt·생성 파라미터·맥락을 반영한 curl 명령을 만듭니다. **무엇이 전송되는지 확인할 때 유용합니다.**
- 헤더 `도구` 메뉴의 `대화 저장(JSON)`/`대화 가져오기`로 대화를 JSON으로 주고받습니다. 브라우저 프로필 초기화·PC 이관에 대비한 백업 수단입니다.

## 오프라인 / `file://` 동작 메모

- `대화 저장`은 File System Access API가 막힌 `file://` 환경에서도 동작하도록, 폴더 선택 창 없이 **Chrome 기본 다운로드 폴더**에 JSON으로 저장됩니다. `대화 가져오기`는 파일 선택 창을 사용합니다.
- 복사는 보안 컨텍스트가 아니어도 동작하도록 폴백을 사용합니다.
- 응답은 기본적으로 **스트리밍**(토큰 단위 출력)입니다. 요청에 `stream: true`를 보내고 SSE(`text/event-stream`)를 파싱해 도착하는 대로 표시합니다. 서버가 SSE를 주지 않거나 미지원이면 자동으로 비스트리밍으로 폴백하므로 동작은 유지됩니다. `스트리밍 응답` 토글로 끌 수 있습니다.
- 토큰이 한꺼번에 몰려온다면 앞단 프록시/게이트웨이의 SSE 버퍼링 설정을 확인하세요. `cURL 복사`는 토글 상태에 맞춰 `stream`/`stream_options`와 `--no-buffer`를 반영합니다.
- 진행 중에는 `중지`로 취소할 수 있습니다. 스트리밍 중 **중지·시간 초과·네트워크 절단** 어느 경우든 그때까지 받은 응답은 답변으로 저장되어 유실되지 않습니다(중단 사유는 아래에 안내됩니다). 일정 시간(기본 약 120초) 동안 서버로부터 **어떤 데이터도** 오지 않으면 시간 초과 처리됩니다(keep-alive·추론 청크 등 내용 없는 수신도 진행으로 간주).
- 호출 실패 버블에는 `재시도` 버튼이 있어 같은 질문을 원클릭으로 다시 보냅니다(질문이 중복 축적되지 않습니다).
- 여러 브라우저 탭에서 같은 화면을 열어 두면, 한 탭의 저장이 다른 탭의 변경을 덮어쓰지 않도록 감지해 경고합니다(유실 방지). 이 경우 최신 탭에서 새로고침해 동기화하세요.
- 페이지를 https로 서빙하면 `http://` endpoint 호출이 mixed content로 차단됩니다. `file://` 또는 같은 스킴(http↔http)으로 사용하세요.

## 코드 구조 / 개발

배포 파일은 `index.html` · `app.js` · `styles.css` 세 개지만, `app.js`(약 4.8천 줄)는 유지보수를 위해
**기능별 조각(`src/*.js`)을 결합해 생성**합니다. `file://` 에서는 ES modules 가 CORS 로 막히므로, 조각을
런타임에 여러 `<script>` 로 나눠 싣는 대신 **하나의 `app.js` 로 결합**해 기존 단일 IIFE 구조(공유 클로저)를
그대로 유지합니다. 결합은 파일명 접두 번호(00,10,20,…) 순서를 따르며, 결과는 결합 전과 **바이트 단위로 동일**합니다.

```
src/
  00-core.js          상수·기본 모델·DOM 참조·전역 상태 선언
  10-state.js         상태 로드/정규화/영속(persistState·폴더·다중탭 rev 가드)
  20-render-sidebar.js 대화 목록·폴더·모델 목록/모달 렌더
  30-memory.js        개인 메모리 프로파일·모달·.md 내보내기/가져오기
  40-messages.js      메시지 영역 렌더·맥락 카운트·요약·메시지 노드
  45-markdown.js      마크다운/표/코드 렌더·인라인·‹›스크롤·스트리밍 캐럿
  50-attachments.js   파일 첨부 읽기(EUC-KR 폴백)·본문 결합
  60-send-network.js  전송·SSE 스트리밍·요청/헤더·오류·맥락 트림·스크롤
  70-events.js        이벤트 바인딩·대화/폴더 CRUD·메뉴·복사·JSON 내보내기/가져오기·첨부 보관함
  90-init.js          부팅(init)
```

`src/` 를 편집한 뒤 결합 스크립트로 `app.js` 를 재생성합니다(`app.js` 를 직접 편집하지 마세요 — 다음 빌드에서 덮어써집니다):

- **macOS / Linux**(Git Bash·WSL 포함): `sh scripts/build.sh`
- **Windows**: `scripts\build.bat` 더블클릭, 또는 `powershell -ExecutionPolicy Bypass -File scripts\build.ps1`
