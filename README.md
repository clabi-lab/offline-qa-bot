# Offline QA Bot

OpenAI-compatible chat endpoint를 **브라우저에서 직접 호출**하는 단일 페이지 정적 QA 화면입니다.
외부 CDN·npm package·서버·proxy·웹 글꼴 없이 `index.html`, `app.js`, `styles.css` 세 파일만으로 동작하므로
인터넷이 차단된 온프레미스/오프라인 환경에 폴더째 복사해 바로 쓸 수 있습니다.

vLLM, Ollama, TGI, LM Studio 등 **OpenAI Chat Completions 호환 서버라면 무엇이든** 연결할 수 있습니다.

## 빠른 시작

1. **Chrome에서 `index.html`을 더블클릭(`file://`)** 합니다. 별도 서버·Python·설치가 필요 없습니다.
2. 좌측 `Endpoint`의 URL과 `Body model`을 **여러분의 OpenAI-compatible 서버**에 맞게 수정합니다.
   (예: `http://localhost:8000/v1/chat/completions`, model `your-model-name`)
3. `연결 확인`을 눌러 호출 경로가 정상인지 점검합니다.
4. 질문을 입력하고 `전송`(Enter, 줄바꿈은 Shift+Enter)을 누릅니다.

글꼴은 OS 기본 글꼴(Segoe UI / 맑은 고딕 / Consolas 등)을 사용하며 외부 글꼴을 내려받지 않습니다.
대화는 브라우저 `localStorage`에 자동 저장됩니다.

## 모델 / Endpoint 설정

기본 모델 목록은 `app.js` 상단의 `CHAT_MODELS` 배열에 정의되어 있습니다. 각 항목을 본인 환경에 맞게 수정하세요.

| 필드 | 의미 |
|---|---|
| `label` | 화면에 표시할 이름 |
| `endpoint` | OpenAI-compatible `/v1/chat/completions` URL |
| `model` | 요청 body의 `model` 값 |
| `contextChars` | 입력에 쓸 '문자' 예산 ≈ (모델 컨텍스트 토큰 − 출력 예약 토큰) × ~2자/토큰 |

UI의 `Endpoint`·`Body model`·`Generation`(temperature·max_tokens·top_p)·`최대 맥락 문자 수`도 모델별로 즉시 바꿀 수 있으며,
비워 두면 서버 기본값을 사용합니다. 요청은 OpenAI Chat Completions 호환 shape(`model`, `messages`, `stream`,
선택적 `temperature`/`max_tokens`/`top_p`)을 사용합니다. 기본적으로 API key·Bearer 헤더를 보내지 않습니다.

> `최대 맥락 문자 수`(`contextChars`)는 서빙 모델의 실제 컨텍스트 창(예: vLLM `--max-model-len`)에 맞춰 설정하세요.
> 무작정 크게 잡으면 서버에서 잘리거나 오류가 날 수 있습니다.

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

### 파일 첨부
`파일 첨부`는 파일을 서버에 업로드하지 않습니다. 브라우저가 로컬 파일을 텍스트로 읽어, 전송 시 사용자 메시지
아래에 코드 블록으로 합쳐 보냅니다. 버튼 외에 **입력창으로 드래그앤드롭**하거나 **파일을 복사해 붙여넣어**도 첨부됩니다.

각 첨부는 코드 펜스 첫 줄에 **파일명 주석 헤더**(`# main.py`, `// app.js`, `-- query.sql` 등)를 넣어
모델이 어떤 파일인지 바로 인식하게 합니다. `.py`·`.js`·`.ts`·`.sql`·`.json`·`.yaml`·`.sh`·`.md`·`.log`·`.html`·`.css`
같은 텍스트 파일과 `Dockerfile`·`Makefile`·`.gitignore` 같은 확장자 없는 개발 파일을 지원합니다(이미지는 미포함).
큰 파일은 한도 내에서 일부만 포함하며, 한도 상수(`MAX_TEXT_ATTACHMENT_CHARS`, `MAX_TOTAL_ATTACHMENT_CHARS`,
`MAX_ATTACHMENTS`)는 `app.js` 상단에서 조정할 수 있습니다.

### 맥락(대화 누적) 관리
화면에는 전체 대화가 유지되지만, 모델로 보낼 때는 OpenAI `messages` 배열로 구성합니다.

- `이전 대화 포함` 토글을 끄면 system + **현재 메시지만** 보냅니다(단발 호출). 켜면 멀티턴으로 보냅니다.
- 멀티턴일 때는 모델별 `최대 맥락 문자 수`를 넘지 않도록 **오래된 메시지부터 연속으로** 제외합니다(system prompt와 최신 메시지는 항상 유지).
- 예산을 넘겨 빠진 오래된 메시지는 화면에서 **흐리게** 표시되고, 실제 전송되는 첫 메시지 앞에 경계선이 표시됩니다.
- 헤더의 `맥락 78% (≈25k/96k자, N/M)`로 사용량을 한눈에 보고, 80%↑ 강조·100%↑ 점선 경고가 표시됩니다.
- 대화가 길어지면 `요약하기`로 오래된 메시지를 1건으로 압축할 수 있습니다. **원문은 삭제되지 않고** 펼쳐 다시 볼 수 있습니다(요청에는 요약본만 전송).

### 답변 보기 / 내보내기
- 모델 답변의 Markdown(코드 펜스, 인라인 코드, 굵게, 제목, 인용, 목록, 간단한 표, 링크)을 읽기 쉽게 표시하고, 코드 블록은 가로 스크롤과 `코드 복사`를 제공합니다.
- `답변 복사`/`코드 복사`로 개별 복사, `대화 복사(MD)`로 대화 전체를 Markdown으로 복사합니다.
- `cURL 복사`는 현재 endpoint·body·system prompt·생성 파라미터·맥락을 반영한 curl 명령을 만듭니다. **무엇이 전송되는지 확인할 때 유용합니다.**
- `대화 저장`/`대화 가져오기`로 대화를 JSON으로 주고받습니다.

## 오프라인 / `file://` 동작 메모

- `대화 저장`은 File System Access API가 막힌 `file://` 환경에서도 동작하도록, 폴더 선택 창 없이 **Chrome 기본 다운로드 폴더**에 JSON으로 저장됩니다. `대화 가져오기`는 파일 선택 창을 사용합니다.
- 복사는 보안 컨텍스트가 아니어도 동작하도록 폴백을 사용합니다.
- 응답은 기본적으로 **스트리밍**(토큰 단위 출력)입니다. 요청에 `stream: true`를 보내고 SSE(`text/event-stream`)를 파싱해 도착하는 대로 표시합니다. 서버가 SSE를 주지 않거나 미지원이면 자동으로 비스트리밍으로 폴백하므로 동작은 유지됩니다. `스트리밍 응답` 토글로 끌 수 있습니다.
- 토큰이 한꺼번에 몰려온다면 앞단 프록시/게이트웨이의 SSE 버퍼링 설정을 확인하세요. `cURL 복사`는 토글 상태에 맞춰 `stream`/`stream_options`와 `--no-buffer`를 반영합니다.
- 진행 중에는 `중지`로 취소할 수 있고(스트리밍 중이면 받은 응답까지 저장), 일정 시간(기본 약 120초) 동안 새 토큰이 없으면 시간 초과 처리됩니다.
- 페이지를 https로 서빙하면 `http://` endpoint 호출이 mixed content로 차단됩니다. `file://` 또는 같은 스킴(http↔http)으로 사용하세요.
