(function () {
  "use strict";

  // 내장 기본 모델 목록(폴백). 환경별 endpoint는 models.txt 편집 + scripts/update-models로
  //   models.config.js(window.QA_BOT_MODELS)를 재생성해 바꾼다. UI에서도 즉시 수정 가능.
  // contextChars = 입력에 쓸 '문자' 예산 ≈ (모델 컨텍스트 토큰 − 출력 예약 토큰) × ~2자/토큰.
  //   예: 컨텍스트 65536 − 출력예약 32768 = 32768토큰 × 2 ≈ 65,536자.
  const DEFAULT_CHAT_MODELS = [
    {
      id: "gemma4-31b",
      label: "Gemma4 31B",
      endpoint: "http://model.local/gemma4-31b/v1/chat/completions",
      model: "gemma-4-31B-it",
      contextChars: 65536, // (컨텍스트 65536 − 출력예약 32768) × ~2자/토큰
      note: "예시 모델",
    },
    {
      id: "gemma4",
      label: "Gemma4 26B",
      endpoint: "http://model.local/gemma4/v1/chat/completions",
      model: "gemma-4-26B-it",
      contextChars: 65536, // 위와 동일 산식
      note: "예시 모델",
    },
  ];

  // models.config.js가 window.QA_BOT_MODELS를 세팅했으면 그걸 쓰고(환경별 오버라이드),
  //   없거나 비었으면 내장 기본값으로 폴백한다. 각 항목을 정규화해 누락 필드를 채운다.
  function normalizeModelList(list) {
    if (!Array.isArray(list)) {
      return null;
    }
    const out = [];
    list.forEach((m, i) => {
      if (!m || typeof m !== "object") {
        return;
      }
      const endpoint = typeof m.endpoint === "string" ? m.endpoint.trim() : "";
      const label = typeof m.label === "string" && m.label.trim() ? m.label.trim() : `Model ${i + 1}`;
      if (!endpoint) {
        return; // endpoint 없는 항목은 무시
      }
      const id = typeof m.id === "string" && m.id.trim() ? m.id.trim() : `model-${i + 1}`;
      const model = typeof m.model === "string" && m.model.trim() ? m.model.trim() : label;
      const contextChars = Number.isFinite(m.contextChars) ? m.contextChars : undefined;
      const entry = { id, label, endpoint, model };
      if (contextChars !== undefined) {
        entry.contextChars = contextChars;
      }
      if (typeof m.note === "string" && m.note) {
        entry.note = m.note;
      }
      out.push(entry);
    });
    return out.length ? out : null;
  }

  const CHAT_MODELS = normalizeModelList(window.QA_BOT_MODELS) || DEFAULT_CHAT_MODELS;

  const DEFAULT_SYSTEM_PROMPT =
    "당신은 유능한 코딩 어시스턴트입니다. 항상 한국어로 명확하고 간결하게 답하세요. 사용자의 요구사항을 정확히 따르고, 먼저 접근 방법을 단계적으로 설명한 뒤 정확하고 실행 가능한 코드를 제시하세요. 확실하지 않으면 모른다고 말하고 가정을 명시하세요. 보안과 엣지케이스를 함께 고려하세요.";
  // 개인 메모리: 시스템 프롬프트와 별개로, 대화에 함께 주입되는 명명 프로파일.
  //   상황별(인프라/AI 등)로 골라 쓰며, 활성 프로파일 + 대화별 메모리가 [메모리] system 메시지로 전달된다.
  // 프로파일 = 지침(instructions, 행동/역할=시스템 프롬프트) + 기억할 정보(text, 사실/맥락) 번들.
  const DEFAULT_MEMORY_PROFILES = [
    { id: "default", label: "기본", instructions: DEFAULT_SYSTEM_PROMPT, text: "" },
  ];

  const APP_STORAGE_KEY = "qa-bot.state.v4";
  const LEGACY_APP_STORAGE_KEYS = ["qa-bot.state.v3"];
  const LEGACY_CHAT_STORAGE_KEY = "qa-bot.chat.v2";
  const LEGACY_MODEL_STORAGE_KEY = "qa-bot.model.v2";
  const LEGACY_MODEL_SETTINGS_STORAGE_KEY = "qa-bot.model-settings.v2";
  const SIDEBAR_STORAGE_KEY = "qa-bot.sidebar-collapsed.v2";
  const PANELS_STORAGE_KEY = "qa-bot.panels.v1";
  const PINNED_ATTACHMENTS_KEY = "qa-bot.pinned-attachments.v1"; // 자주 쓰는 첨부(즐겨찾기) id 목록
  const MAX_REQUEST_CONTEXT_CHARS = 65536; // 모델별 contextChars 미설정 시 기본 전송 예산(약 64K 문자 = (65536-32768)*2)
  const MIN_CONTEXT_CHARS = 2000; // 전송 예산 하한 (트림 floor와 표시 limit을 일치시킴)
  const SEND_TIMEOUT_MS = 120000; // 전송 경로 응답 대기 한도(ms)
  const SUMMARY_TRIGGER_RATIO = 0.8; // 전송 예산의 이 비율을 넘으면 요약 배너 노출
  const SUMMARY_MSG_COUNT = 20; // 보조 트리거: user+assistant 메시지 수
  const SUMMARY_KEEP_RECENT = 4; // 요약 시 원문으로 유지할 최근 메시지 수
  const SUMMARY_SYSTEM_PROMPT =
    "다음 대화를 한국어로 간결히 요약하세요. 사용자의 목표, 합의·결정사항, 미해결 질문, 중요한 코드·파일·식별자(테이블/컬럼/케이스 ID 등)를 보존하고 잡담은 생략하세요. 불릿 위주로 작성하세요.";
  const MAX_ATTACHMENTS = 5;
  const MAX_TEXT_ATTACHMENT_CHARS = 12000;
  const MAX_TOTAL_ATTACHMENT_CHARS = 24000;
  const PROSE_LANGUAGES = new Set(["md", "txt", "log", "csv"]); // 코드가 아닌 산문/로그: head+tail 절단 유지
  const TEXT_ATTACHMENT_EXTENSIONS = new Set([
    "bash",
    "cfg",
    "conf",
    "csv",
    "css",
    "env",
    "html",
    "ini",
    "js",
    "json",
    "jsx",
    "log",
    "markdown",
    "md",
    "py",
    "sh",
    "sql",
    "toml",
    "ts",
    "tsx",
    "txt",
    "xml",
    "yaml",
    "yml",
    "zsh",
  ]);
  const TEXT_FILENAMES = new Set([
    "dockerfile",
    "makefile",
    "jenkinsfile",
    "procfile",
    "rakefile",
    "gemfile",
    ".gitignore",
    ".dockerignore",
    ".env",
    ".editorconfig",
    ".gitattributes",
  ]);

  const elements = {
    newChat: document.getElementById("new-chat"),
    addFolder: document.getElementById("add-folder"),
    conversationList: document.getElementById("conversation-list"),
    chatTitleInput: document.getElementById("chat-title-input"),
    saveChat: document.getElementById("save-chat"),
    importChat: document.getElementById("import-chat"),
    importFile: document.getElementById("import-file"),
    activeChatTitle: document.getElementById("active-chat-title"),
    modelList: document.getElementById("model-list"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    chatMenu: document.getElementById("chat-menu"),
    sidebarBackdrop: document.getElementById("sidebar-backdrop"),
    conversationSearch: document.getElementById("conversation-search"),
    shortcutsHelp: document.getElementById("shortcuts-help"),
    shortcutsModal: document.getElementById("shortcuts-modal"),
    shortcutsClose: document.getElementById("shortcuts-close"),
    renameModal: document.getElementById("rename-modal"),
    renameInput: document.getElementById("rename-input"),
    renameClose: document.getElementById("rename-close"),
    renameCancel: document.getElementById("rename-cancel"),
    renameConfirm: document.getElementById("rename-confirm"),
    headerMenuBtn: document.getElementById("header-menu-btn"),
    headerMenu: document.getElementById("header-menu"),
    clearAll: document.getElementById("clear-all"),
    attachLibrary: document.getElementById("attach-library"),
    libraryModal: document.getElementById("library-modal"),
    libraryClose: document.getElementById("library-close"),
    librarySearch: document.getElementById("library-search"),
    libraryList: document.getElementById("library-list"),
    addModel: document.getElementById("add-model"),
    modelModal: document.getElementById("model-modal"),
    modelClose: document.getElementById("model-close"),
    modelLabelInput: document.getElementById("model-label-input"),
    modelEndpointInput: document.getElementById("model-endpoint-input"),
    modelBodyInput: document.getElementById("model-body-input"),
    modelApiKeyInput: document.getElementById("model-apikey-input"),
    modelDelete: document.getElementById("model-delete"),
    includeHistory: document.getElementById("include-history"),
    streamToggle: document.getElementById("stream-toggle"),
    copyMarkdown: document.getElementById("copy-markdown"),
    contextCount: document.getElementById("context-count"),
    contextState: document.getElementById("context-state"),
    checkConnection: document.getElementById("check-connection"),
    copyCurl: document.getElementById("copy-curl"),
    clearChat: document.getElementById("clear-chat"),
    deleteChat: document.getElementById("delete-chat"),
    attachFile: document.getElementById("attach-file"),
    clearAttachments: document.getElementById("clear-attachments"),
    fileInput: document.getElementById("file-input"),
    attachmentList: document.getElementById("attachment-list"),
    attachmentStatus: document.getElementById("attachment-status"),
    messages: document.getElementById("messages"),
    scrollBottom: document.getElementById("scroll-bottom"),
    scrollBottomLabel: document.getElementById("scroll-bottom-label"),
    composer: document.getElementById("composer"),
    prompt: document.getElementById("prompt"),
    send: document.getElementById("send"),
    sendLabel: document.getElementById("send-label"),
    connectionState: document.getElementById("connection-state"),
    contextArc: document.getElementById("context-arc"),
    usageState: document.getElementById("usage-state"),
    summaryBanner: document.getElementById("summary-banner"),
    summaryRun: document.getElementById("summary-run"),
    summaryDismiss: document.getElementById("summary-dismiss"),
    memorySelect: document.getElementById("memory-select"),
    memoryEdit: document.getElementById("memory-edit"),
    memoryToggle: document.getElementById("memory-toggle"),
    memoryToggleLabel: document.getElementById("memory-toggle-label"),
    memoryModal: document.getElementById("memory-modal"),
    memoryClose: document.getElementById("memory-close"),
    memoryProfileSelect: document.getElementById("memory-profile-select"),
    memoryProfileLabel: document.getElementById("memory-profile-label"),
    memoryInstructions: document.getElementById("memory-instructions"),
    memoryProfileText: document.getElementById("memory-profile-text"),
    memoryOn: document.getElementById("memory-on"),
    memoryAddProfile: document.getElementById("memory-add-profile"),
    memoryDeleteProfile: document.getElementById("memory-delete-profile"),
    memoryConversation: document.getElementById("memory-conversation"),
    memoryExport: document.getElementById("memory-export"),
    memoryImport: document.getElementById("memory-import"),
    memoryImportInput: document.getElementById("memory-import-input"),
  };

  // loadState() 내부(normalizeConversation→coerceModelId→getModels)에서 state를 참조하므로
  //   TDZ를 피하려고 선언과 대입을 분리한다(대입 전엔 state===undefined → getModels는 내장 기본값).
  let state;
  let corruptStateBackedUp = false; // loadState에서 손상 원본을 백업했는지(init에서 안내)
  state = loadState();
  normalizeMemoryState();
  normalizeModelsState();
  normalizeFoldersState();
  let conversationQuery = "";
  let renamingId = null;
  let renamingKind = "conversation"; // "conversation" | "folder" — rename 모달 공용
  let pendingPrompt = "";
  let pendingAttachments = [];
  let abortController = null;
  let typingTimer = null;

