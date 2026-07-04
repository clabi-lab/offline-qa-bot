// ============================================================================
// 생성 파일 — 직접 편집하지 마세요. src/*.js 를 편집하고 scripts/build.sh 를 실행하세요.
// index.html 은 이 결합본을 로드합니다. 조각 순서는 파일명 접두 번호(00,10,…)를 따릅니다.
// ============================================================================
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

  function loadState() {
    const rawStored = window.localStorage.getItem(APP_STORAGE_KEY);
    const stored = safeJson(rawStored);
    if (rawStored && (!stored || !Array.isArray(stored.conversations))) {
      // v4 키에 값이 있는데 읽을 수 없다(손상/비호환). 이후 init의 persistState가 새 state로
      // 덮어쓰므로, 복구 기회를 남기기 위해 원본을 백업 키에 보존한다.
      try {
        window.localStorage.setItem(`${APP_STORAGE_KEY}.corrupt-backup`, rawStored);
        corruptStateBackedUp = true;
      } catch (_error) {
        // 백업 실패(용량 등)는 치명적이지 않음 — 그대로 진행.
      }
    }
    if (stored && Array.isArray(stored.conversations)) {
      const conversations = stored.conversations.map((item) => normalizeConversation(item)).filter(Boolean);
      if (conversations.length > 0) {
        const activeConversationId = conversations.some((conversation) => conversation.id === stored.activeConversationId)
          ? stored.activeConversationId
          : conversations[0].id;
        return {
          activeConversationId,
          conversations,
          streaming: stored.streaming !== false,
          memoryProfiles: stored.memoryProfiles,
          activeMemoryProfileId: stored.activeMemoryProfileId,
          models: stored.models,
          folders: normalizeFolders(stored.folders),
        };
      }
    }
    for (const key of LEGACY_APP_STORAGE_KEYS) {
      const legacy = safeJson(window.localStorage.getItem(key));
      if (!legacy || !Array.isArray(legacy.conversations)) {
        continue;
      }
      const conversations = legacy.conversations
        .map((item) => normalizeConversation(item, { clearSystemPrompt: true }))
        .filter(Boolean);
      if (conversations.length > 0) {
        const activeConversationId = conversations.some((conversation) => conversation.id === legacy.activeConversationId)
          ? legacy.activeConversationId
          : conversations[0].id;
        return { activeConversationId, conversations, streaming: legacy.streaming !== false };
      }
    }
    return migrateLegacyState();
  }

  function migrateLegacyState() {
    const selectedModelId = coerceModelId(window.localStorage.getItem(LEGACY_MODEL_STORAGE_KEY));
    const legacySettings = safeJson(window.localStorage.getItem(LEGACY_MODEL_SETTINGS_STORAGE_KEY)) || {};
    const legacyMessages = sanitizeMessages(safeJson(window.localStorage.getItem(LEGACY_CHAT_STORAGE_KEY)) || []);
    const firstUserMessage = legacyMessages.find((message) => message.role === "user");
    const conversation = createConversation({
      title: firstUserMessage ? makeTitle(firstUserMessage.content) : "새 대화",
      manualTitle: Boolean(firstUserMessage),
      selectedModelId,
      modelSettings: createDefaultModelSettings(legacySettings),
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      messages: legacyMessages,
    });
    return {
      activeConversationId: conversation.id,
      conversations: [conversation],
      streaming: true,
    };
  }

  function isStreamingEnabled() {
    return state.streaming !== false;
  }

  function loadMemoryProfiles(raw) {
    const list = Array.isArray(raw)
      ? raw
          .filter((profile) => profile && typeof profile.text === "string")
          .map((profile) => ({
            id: typeof profile.id === "string" && profile.id.trim() ? profile.id : createId(),
            label: typeof profile.label === "string" && profile.label.trim() ? profile.label.trim() : "메모리",
            instructions: typeof profile.instructions === "string" ? profile.instructions : "",
            text: profile.text,
          }))
      : [];
    return list.length ? list : DEFAULT_MEMORY_PROFILES.map((profile) => ({ ...profile }));
  }

  // 메모리 프로파일/활성 선택을 항상 유효한 상태로 보정(빈 목록·끊긴 활성 id 방지).
  function normalizeMemoryState() {
    state.memoryProfiles = loadMemoryProfiles(state.memoryProfiles);
    if (!state.memoryProfiles.some((profile) => profile.id === state.activeMemoryProfileId)) {
      state.activeMemoryProfileId = state.memoryProfiles[0].id;
    }
    // 지침이 어디에도 없으면 첫 프로파일에 기본 지침을 심어 기존 동작(시스템 프롬프트)을 보존.
    if (!state.memoryProfiles.some((profile) => String(profile.instructions || "").trim())) {
      state.memoryProfiles[0].instructions = DEFAULT_SYSTEM_PROMPT;
    }
  }

  function getActiveMemoryProfile() {
    return (
      state.memoryProfiles.find((profile) => profile.id === state.activeMemoryProfileId) || state.memoryProfiles[0]
    );
  }

  // ── 모델 레지스트리 ─────────────────────────────────────────
  // 모델 목록을 UI에서 추가/수정/삭제하고 localStorage에 영구 저장한다.
  //   endpoint·body model은 모델 단위(레지스트리) 값으로, 생성 파라미터는 대화별(modelSettings)로 유지.
  //   CHAT_MODELS는 최초 시드/초기화용 내장 기본값.
  function loadModelDefs(raw) {
    const list = Array.isArray(raw)
      ? raw
          .filter((model) => model && typeof model.id === "string" && model.id.trim())
          .map((model) => {
            const contextChars = Number(model.contextChars);
            return {
              id: model.id,
              label: typeof model.label === "string" && model.label.trim() ? model.label.trim() : model.id,
              endpoint: typeof model.endpoint === "string" ? model.endpoint : "",
              model: typeof model.model === "string" ? model.model : "",
              // 선택적 API key(인증 게이트웨이·vLLM --api-key 등). 없으면 헤더 미전송.
              apiKey: typeof model.apiKey === "string" ? model.apiKey : "",
              contextChars: Number.isFinite(contextChars) && contextChars > 0 ? Math.trunc(contextChars) : undefined,
            };
          })
      : [];
    return list.length ? list : CHAT_MODELS.map((model) => ({ ...model }));
  }

  function normalizeModelsState() {
    state.models = loadModelDefs(state.models);
  }

  function getModels() {
    return state && Array.isArray(state.models) && state.models.length ? state.models : CHAT_MODELS;
  }

  function createConversation(seed = {}) {
    const now = new Date().toISOString();
    return normalizeConversation({
      id: seed.id || createId(),
      title: seed.title || "새 대화",
      manualTitle: Boolean(seed.manualTitle),
      createdAt: seed.createdAt || now,
      updatedAt: seed.updatedAt || now,
      selectedModelId: seed.selectedModelId || CHAT_MODELS[0].id,
      modelSettings: seed.modelSettings,
      systemPrompt: typeof seed.systemPrompt === "string" ? seed.systemPrompt : DEFAULT_SYSTEM_PROMPT,
      messages: Array.isArray(seed.messages) ? seed.messages : [],
    });
  }

  function normalizeConversation(raw, options = {}) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : createId();
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "새 대화";
    return {
      id,
      title,
      manualTitle: Boolean(raw.manualTitle),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      selectedModelId: coerceModelId(raw.selectedModelId),
      modelSettings: createDefaultModelSettings(raw.modelSettings || raw.settings),
      includeHistory: raw.includeHistory !== false, // 누락/true → 멀티턴 포함(기본), false만 단발
      pinned: Boolean(raw.pinned),
      systemPrompt:
        options.clearSystemPrompt || typeof raw.systemPrompt !== "string" ? DEFAULT_SYSTEM_PROMPT : raw.systemPrompt,
      // 개인 메모리: 이 대화에만 적용할 메모(per-conversation) + 주입 on/off(기본 켜짐).
      memory: typeof raw.memory === "string" ? raw.memory : "",
      memoryOn: raw.memoryOn !== false,
      // 요약 배너 '나중에' 상태. 화이트리스트 재구성에서 빠지면 새로고침마다 배너가 재출현한다.
      summaryDismissed: Boolean(raw.summaryDismissed),
      // 소속 폴더(없으면 null). 화이트리스트에 반드시 포함해야 새로고침 후에도 유지된다.
      folderId: typeof raw.folderId === "string" && raw.folderId ? raw.folderId : null,
      messages: sanitizeMessages(raw.messages),
    };
  }

  // 대화 폴더: { id, name, collapsed }. 단일 blob(qa-bot.state.v4)에 folders 배열로 추가(마이그레이션 불필요).
  function normalizeFolders(raw) {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .filter((folder) => folder && typeof folder.id === "string" && folder.id.trim())
      .map((folder) => ({
        id: folder.id,
        name: typeof folder.name === "string" && folder.name.trim() ? folder.name.trim() : "새 폴더",
        collapsed: Boolean(folder.collapsed),
        createdAt: typeof folder.createdAt === "string" ? folder.createdAt : new Date().toISOString(),
      }));
  }

  function normalizeFoldersState() {
    state.folders = normalizeFolders(state.folders);
    // 존재하지 않는 폴더를 가리키는 대화는 미분류로 되돌린다(삭제된 폴더 참조 정리).
    const ids = new Set(state.folders.map((f) => f.id));
    for (const conversation of state.conversations) {
      if (conversation.folderId && !ids.has(conversation.folderId)) {
        conversation.folderId = null;
      }
    }
  }

  function createDefaultModelSettings(saved = {}) {
    const settings = {};
    const asString = (value) =>
      typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
    for (const preset of CHAT_MODELS) {
      const item = saved[preset.id] || {};
      settings[preset.id] = {
        endpoint: typeof item.endpoint === "string" && item.endpoint.trim() ? item.endpoint.trim() : preset.endpoint,
        model: typeof item.model === "string" && item.model.trim() ? item.model.trim() : preset.model,
        // 생성 파라미터/컨텍스트 예산: 빈 문자열이면 서버 기본값/기본 예산 사용.
        temperature: asString(item.temperature),
        maxTokens: asString(item.maxTokens),
        topP: asString(item.topP),
        contextChars: asString(item.contextChars),
      };
    }
    return settings;
  }

  function sanitizeMessages(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .filter(
        (item) =>
          item &&
          (item.role === "user" || item.role === "assistant" || item.role === "error") &&
          typeof item.content === "string",
      )
      .map((item) => ({
        role: item.role,
        content: item.content,
        model: typeof item.model === "string" ? item.model : undefined,
        modelLabel: typeof item.modelLabel === "string" ? item.modelLabel : undefined,
        usage: item.usage || null,
        summary: Boolean(item.summary),
        // 요약 메시지가 대체한 원문(비파괴 보존). 요청에는 미포함, UI에서 펼쳐보기.
        archived: Array.isArray(item.archived) && item.archived.length > 0 ? sanitizeMessages(item.archived) : undefined,
        // 첨부 ref(보관함 IndexedDB id). 본문엔 텍스트가 박혀 있고, 원본은 보관함에서 재다운로드.
        attachments: Array.isArray(item.attachments) && item.attachments.length > 0
          ? item.attachments
              .filter((a) => a && typeof a.id === "string" && typeof a.name === "string")
              .map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size }))
          : undefined,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      }));
  }

  function getActiveConversation() {
    let conversation = state.conversations.find((item) => item.id === state.activeConversationId);
    if (!conversation) {
      conversation = createConversation();
      state.conversations.unshift(conversation);
      state.activeConversationId = conversation.id;
    }
    return conversation;
  }

  function saveState() {
    syncActiveConversationFromForm();
    persistState();
  }

  // 키 입력마다 전체 state를 직렬화/저장하면 긴 대화에서 잰크가 생긴다 → 디바운스.
  let saveStateTimer = null;
  function saveStateLater() {
    if (saveStateTimer !== null) {
      window.clearTimeout(saveStateTimer);
    }
    saveStateTimer = window.setTimeout(() => {
      saveStateTimer = null;
      saveState();
    }, 300);
  }
  function flushPendingSave() {
    if (saveStateTimer !== null) {
      window.clearTimeout(saveStateTimer);
      saveStateTimer = null;
      saveState();
    }
  }

  // 다중 탭 보수적 방어: 저장마다 작은 별도 키의 rev를 1 올리고, 저장 직전에 rev가 내 스냅샷보다
  // 앞서 있으면 다른 탭이 이미 저장한 것 → 낡은 전체 state로 덮어쓰는 대신 저장을 중단하고 경고한다.
  // (rev만 따로 두는 이유: 저장마다 수 MB짜리 state 전체를 parse해 비교하는 비용을 피한다.)
  const APP_STORAGE_REV_KEY = `${APP_STORAGE_KEY}.rev`;
  let stateRev = Number(window.localStorage.getItem(APP_STORAGE_REV_KEY)) || 0;

  function persistState() {
    const storedRev = Number(window.localStorage.getItem(APP_STORAGE_REV_KEY)) || 0;
    if (storedRev > stateRev) {
      staleTab = true; // 이후 성공 메시지가 경고를 덮지 못하도록 sticky 처리
      setStatus(STALE_TAB_MESSAGE, "is-error");
      return false;
    }
    try {
      window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
      stateRev = storedRev + 1;
      window.localStorage.setItem(APP_STORAGE_REV_KEY, String(stateRev));
      return true;
    } catch (error) {
      // 앱을 멈추지 않고 한국어로 안내. 쿼터 초과만 용량 문구로, 그 외 원인은 그대로 노출(오진단 방지).
      const quota = error && (error.name === "QuotaExceededError" || error.code === 22);
      setStatus(
        quota
          ? "저장 공간 부족: 오래된 대화를 삭제하세요."
          : `저장 실패: ${error instanceof Error ? error.message : String(error)}`,
        "is-error",
      );
      return false;
    }
  }

  function syncActiveConversationFromForm() {
    const conversation = getActiveConversation();
    const selectedModelId = coerceModelId(conversation.selectedModelId);
    if (elements.chatTitleInput) {
      conversation.title = normalizeTitle(elements.chatTitleInput.value) || conversation.title || "새 대화";
    }
    conversation.selectedModelId = selectedModelId;
    // endpoint·body model은 모델 레지스트리, 생성 파라미터(temperature 등)는 UI 제거 → 서버/모델 기본값 사용.
    conversation.includeHistory = elements.includeHistory.checked;
    conversation.updatedAt = new Date().toISOString();
  }

  function getPreset(modelId = getActiveConversation().selectedModelId) {
    const models = getModels();
    return models.find((model) => model.id === modelId) || models[0];
  }

  function coerceModelId(modelId) {
    const models = getModels();
    return models.some((model) => model.id === modelId) ? modelId : models[0].id;
  }

  function getActiveConfig() {
    const conversation = getActiveConversation();
    const preset = getPreset(conversation.selectedModelId);
    const saved = conversation.modelSettings[preset.id] || {};
    return {
      id: preset.id,
      label: preset.label,
      // endpoint·body model·apiKey는 모델 레지스트리(영구) 값을 사용. 생성 파라미터는 대화별 폼 값.
      endpoint: preset.endpoint,
      model: preset.model,
      apiKey: preset.apiKey || "",
      temperature: saved.temperature || "",
      maxTokens: saved.maxTokens || "",
      topP: saved.topP || "",
      contextChars: saved.contextChars || "",
    };
  }

  function renderAll() {
    renderConversationTitle();
    renderConversationList();
    renderModelList();
    renderModelSettings();
    renderHistoryToggle();
    renderMemorySelect();
    renderMemoryToggle();
    renderMessages();
    renderSummaryBanner();
  }

  function renderConversationTitle() {
    const conversation = getActiveConversation();
    if (elements.chatTitleInput) {
      elements.chatTitleInput.value = conversation.title;
    }
    elements.activeChatTitle.textContent = conversation.title;
  }

  // 흑백 핀(압정) 아이콘 — 외부 리소스/이모지 없이 인라인 SVG(currentColor).
  function createPinIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(ns, "path");
    path.setAttribute(
      "d",
      "M9.6 1.3a1 1 0 0 0-1.5 0L6 3.4a3.2 3.2 0 0 0-2.7.9 1 1 0 0 0 0 1.4L5.6 8 1.8 11.8a.7.7 0 0 0 1 1L6.6 9l2.3 2.3a1 1 0 0 0 1.4 0 3.2 3.2 0 0 0 .9-2.7l2.1-2.1a1 1 0 0 0 0-1.5z",
    );
    svg.appendChild(path);
    return svg;
  }

  function createConversationItem(conversation) {
    const item = document.createElement("div");
    item.className = `conversation-item${conversation.pinned ? " pinned" : ""}`;
    item.dataset.conversationId = conversation.id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(conversation.id === state.activeConversationId));

    const main = document.createElement("button");
    main.className = "conversation-item-main";
    main.type = "button";
    main.dataset.conversationId = conversation.id;

    const title = document.createElement("span");
    title.className = "conversation-title";
    if (conversation.pinned) {
      const pin = document.createElement("span");
      pin.className = "conversation-pin";
      pin.setAttribute("aria-hidden", "true");
      pin.appendChild(createPinIcon());
      title.append(pin, document.createTextNode(conversation.title));
    } else {
      title.textContent = conversation.title;
    }

    const meta = document.createElement("span");
    meta.className = "conversation-meta";
    const messageCount = getConversationMessages(conversation).length;
    meta.textContent = `${messageCount} msgs · ${formatDate(conversation.updatedAt)}`;

    main.append(title, meta);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "conversation-menu-btn";
    menuBtn.dataset.menuConversation = conversation.id;
    menuBtn.setAttribute("aria-label", `대화 메뉴: ${conversation.title}`);
    menuBtn.textContent = "⋯";

    item.append(main, menuBtn);
    return item;
  }

  function createFolderHeader(folder, count) {
    const header = document.createElement("div");
    header.className = `folder-header${folder.collapsed ? " collapsed" : ""}`;
    header.dataset.folderId = folder.id;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "folder-toggle";
    toggle.dataset.folderToggle = folder.id;
    toggle.setAttribute("aria-expanded", String(!folder.collapsed));
    toggle.setAttribute("aria-label", `${folder.name} 폴더 ${folder.collapsed ? "펼치기" : "접기"}`);
    const chevron = document.createElement("span");
    chevron.className = "folder-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "▾";
    const name = document.createElement("span");
    name.className = "folder-name";
    name.textContent = folder.name;
    const countEl = document.createElement("span");
    countEl.className = "folder-count";
    countEl.textContent = String(count);
    toggle.append(chevron, name, countEl);

    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "folder-menu-btn";
    menuBtn.dataset.menuFolder = folder.id;
    menuBtn.setAttribute("aria-label", `폴더 메뉴: ${folder.name}`);
    menuBtn.textContent = "⋯";

    header.append(toggle, menuBtn);
    return header;
  }

  function renderConversationList() {
    const query = conversationQuery.trim().toLowerCase();
    const matches = (c) => !query || String(c.title || "").toLowerCase().includes(query);
    const byUpdated = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
    elements.conversationList.innerHTML = "";

    const all = state.conversations.filter(matches);
    if (all.length === 0) {
      const empty = document.createElement("div");
      empty.className = "conversation-empty";
      empty.textContent = query ? "검색 결과 없음" : "대화 없음";
      elements.conversationList.appendChild(empty);
      return;
    }

    // 검색 중에는 폴더 경계를 무시하고 평면 목록(고정 우선 → 최신순).
    if (query) {
      const sorted = [...all].sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return byUpdated(a, b);
      });
      for (const conversation of sorted) {
        elements.conversationList.appendChild(createConversationItem(conversation));
      }
      return;
    }

    // 고정 대화는 폴더와 무관하게 최상단(플랜: 핀 섹션 유지).
    const pinned = all.filter((c) => c.pinned).sort(byUpdated);
    for (const conversation of pinned) {
      elements.conversationList.appendChild(createConversationItem(conversation));
    }

    const unpinned = all.filter((c) => !c.pinned);
    // 폴더별 그룹(접힘이면 항목 생략).
    for (const folder of state.folders) {
      const inFolder = unpinned.filter((c) => c.folderId === folder.id).sort(byUpdated);
      elements.conversationList.appendChild(createFolderHeader(folder, inFolder.length));
      if (!folder.collapsed) {
        for (const conversation of inFolder) {
          const item = createConversationItem(conversation);
          item.classList.add("in-folder");
          elements.conversationList.appendChild(item);
        }
      }
    }

    // 미분류(폴더 없는 대화). 폴더가 하나라도 있으면 '미분류' 구분 헤더를 둔다.
    const ungrouped = unpinned.filter((c) => !c.folderId).sort(byUpdated);
    if (state.folders.length > 0 && ungrouped.length > 0) {
      const header = document.createElement("div");
      header.className = "folder-header ungrouped";
      const label = document.createElement("span");
      label.className = "folder-name";
      label.textContent = "미분류";
      const countEl = document.createElement("span");
      countEl.className = "folder-count";
      countEl.textContent = String(ungrouped.length);
      header.append(label, countEl);
      elements.conversationList.appendChild(header);
    }
    for (const conversation of ungrouped) {
      elements.conversationList.appendChild(createConversationItem(conversation));
    }
  }

  function renderModelList() {
    const active = getActiveConversation();
    elements.modelList.innerHTML = "";
    for (const model of getModels()) {
      const selected = model.id === active.selectedModelId;
      // 대화 항목과 동일한 구조: 카드(item)가 테두리·선택색을 갖고, 안에 이름 버튼 + ⋯.
      const item = document.createElement("div");
      item.className = `model-item${selected ? " is-selected" : ""}`;

      const button = document.createElement("button");
      button.className = "model-option";
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.dataset.modelId = model.id;

      const name = document.createElement("span");
      name.className = "model-name";
      name.textContent = model.label;
      button.append(name);

      // ⋯ → 모델 설정(Endpoint·body model 수정·삭제, 영구).
      const menuBtn = document.createElement("button");
      menuBtn.className = "model-menu-btn";
      menuBtn.type = "button";
      menuBtn.dataset.modelEdit = model.id;
      menuBtn.setAttribute("aria-label", `${model.label} 설정`);
      menuBtn.textContent = "⋯";

      item.append(button, menuBtn);
      elements.modelList.appendChild(item);
    }
  }

  function renderModelSettings() {
    // 생성 파라미터 입력 UI는 제거됨(endpoint·body model은 모델 모달에서, 그 외는 기본값). 표시할 폼 없음.
  }

  // ── 모델 설정 모달(추가/수정/삭제, 영구) ──
  let editingModelId = null;

  function currentEditingModel() {
    return getModels().find((model) => model.id === editingModelId);
  }

  function openModelModal(id) {
    const model = getModels().find((item) => item.id === id);
    if (!model || !elements.modelModal) {
      return;
    }
    editingModelId = id;
    elements.modelLabelInput.value = model.label;
    elements.modelEndpointInput.value = model.endpoint;
    elements.modelBodyInput.value = model.model;
    if (elements.modelApiKeyInput) {
      elements.modelApiKeyInput.value = model.apiKey || "";
    }
    if (elements.modelDelete) {
      elements.modelDelete.disabled = getModels().length <= 1;
    }
    elements.modelModal.hidden = false;
    elements.modelLabelInput.focus();
  }

  function closeModelModal() {
    if (elements.modelModal) {
      elements.modelModal.hidden = true;
    }
    editingModelId = null;
  }

  function addModel() {
    // 새 모델은 내장 기본값(엔드포인트 패턴·body model·contextChars 65536)을 고정으로 채워 시작.
    const base = CHAT_MODELS[0];
    const model = {
      id: createId(),
      label: "새 모델",
      endpoint: base.endpoint,
      model: base.model,
      contextChars: base.contextChars,
    };
    state.models.push(model);
    renderModelList();
    saveStateLater();
    openModelModal(model.id);
  }

  function deleteCurrentModel() {
    if (getModels().length <= 1) {
      return;
    }
    const model = currentEditingModel();
    if (!model || !window.confirm(`모델 "${model.label}"을(를) 삭제할까요?`)) {
      return;
    }
    state.models = state.models.filter((item) => item.id !== model.id);
    const fallbackId = state.models[0].id;
    for (const conversation of state.conversations) {
      if (conversation.selectedModelId === model.id) {
        conversation.selectedModelId = fallbackId;
      }
    }
    closeModelModal();
    renderModelList();
    renderModelSettings();
    renderContextCount();
    saveState();
  }

  function renderHistoryToggle() {
    elements.includeHistory.checked = getActiveConversation().includeHistory !== false;
    if (elements.streamToggle) {
      elements.streamToggle.checked = isStreamingEnabled();
    }
  }


  // ── 개인 메모리 ─────────────────────────────────────────────
  function fillMemoryProfileOptions(select) {
    if (!select) {
      return;
    }
    select.innerHTML = "";
    for (const profile of state.memoryProfiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.label;
      select.appendChild(option);
    }
    select.value = state.activeMemoryProfileId;
  }

  function renderMemorySelect() {
    fillMemoryProfileOptions(elements.memorySelect);
  }

  function renderMemoryToggle() {
    const on = getActiveConversation().memoryOn !== false;
    if (elements.memoryToggle) {
      elements.memoryToggle.classList.toggle("is-on", on);
      elements.memoryToggle.setAttribute("aria-pressed", String(on));
      elements.memoryToggle.title = on ? "개인 메모리 주입: 켜짐 (클릭해 끄기)" : "개인 메모리 주입: 꺼짐 (클릭해 켜기)";
    }
    if (elements.memoryOn) {
      elements.memoryOn.checked = on;
    }
  }

  // 메모리 on/off는 composer 토글과 모달 스위치 어디서 바꿔도 같은 상태를 공유한다.
  function setMemoryOn(value) {
    getActiveConversation().memoryOn = value !== false;
    renderMemoryToggle();
    renderContextCount();
    renderSummaryBanner();
    saveStateLater();
  }

  function renderMemoryModal() {
    const profile = getActiveMemoryProfile();
    fillMemoryProfileOptions(elements.memoryProfileSelect);
    if (elements.memoryProfileLabel) {
      elements.memoryProfileLabel.value = profile ? profile.label : "";
    }
    if (elements.memoryInstructions) {
      elements.memoryInstructions.value = profile ? profile.instructions || "" : "";
    }
    if (elements.memoryProfileText) {
      elements.memoryProfileText.value = profile ? profile.text : "";
    }
    if (elements.memoryConversation) {
      elements.memoryConversation.value = getActiveConversation().memory || "";
    }
    if (elements.memoryOn) {
      elements.memoryOn.checked = getActiveConversation().memoryOn !== false;
    }
    if (elements.memoryDeleteProfile) {
      // 마지막 1개는 삭제 불가(항상 최소 한 개 유지).
      elements.memoryDeleteProfile.disabled = state.memoryProfiles.length <= 1;
    }
  }

  function setActiveMemoryProfile(id) {
    if (!state.memoryProfiles.some((profile) => profile.id === id)) {
      return;
    }
    state.activeMemoryProfileId = id;
    renderMemorySelect();
    renderMemoryModal();
    renderContextCount();
    saveStateLater();
  }

  function addMemoryProfile() {
    const profile = { id: createId(), label: "새 메모리", instructions: "", text: "" };
    state.memoryProfiles.push(profile);
    state.activeMemoryProfileId = profile.id;
    renderMemorySelect();
    renderMemoryModal();
    saveStateLater();
    if (elements.memoryProfileLabel) {
      elements.memoryProfileLabel.focus();
      elements.memoryProfileLabel.select();
    }
  }

  function deleteMemoryProfile() {
    if (state.memoryProfiles.length <= 1) {
      return;
    }
    const profile = getActiveMemoryProfile();
    if (!window.confirm(`메모리 프로파일 "${profile.label}"을(를) 삭제할까요?`)) {
      return;
    }
    state.memoryProfiles = state.memoryProfiles.filter((item) => item.id !== profile.id);
    state.activeMemoryProfileId = state.memoryProfiles[0].id;
    renderMemorySelect();
    renderMemoryModal();
    renderContextCount();
    saveStateLater();
  }

  function openMemory() {
    if (elements.memoryModal) {
      renderMemoryModal();
      elements.memoryModal.hidden = false;
      if (elements.memoryProfileText) {
        // preventScroll: 낮은 화면에서 기본 focus 스크롤이 카드 중간(텍스트영역)으로 점프해
        // 제목·닫기 버튼이 화면 밖으로 나간 채 열리는 문제 방지. 카드는 항상 맨 위에서 시작.
        elements.memoryProfileText.focus({ preventScroll: true });
      }
      const card = elements.memoryModal.querySelector(".modal-card");
      if (card) {
        card.scrollTop = 0;
      }
    }
  }

  function closeMemory() {
    if (elements.memoryModal) {
      elements.memoryModal.hidden = true;
    }
  }

  // 프로파일 1개 = .md 파일 1개. 프로파일 간 `## ` 구분자가 없어 대량 정보도 충돌 없이 안전.
  //   파일 안에서만 `### 지침` / `### 기억할 정보`로 두 칸을 나눈다(헤더 없으면 전체가 기억할 정보).
  function memoryProfileToMarkdown(profile) {
    const lines = [`# ${profile.label}`, ""];
    if (String(profile.instructions || "").trim()) {
      lines.push("### 지침", "", profile.instructions, "");
    }
    lines.push("### 기억할 정보", "", profile.text || "", "");
    return lines.join("\n");
  }

  function safeFileName(name) {
    return String(name || "memory").replace(/[\\/:*?"<>|]+/g, "_").trim() || "memory";
  }

  // 현재 선택한 프로파일을 개별 .md 파일로 내보낸다.
  function exportMemory() {
    const profile = getActiveMemoryProfile();
    if (!profile) {
      return;
    }
    const blob = new Blob([memoryProfileToMarkdown(profile)], { type: "text/markdown;charset=utf-8" });
    downloadBlob(blob, `${safeFileName(profile.label)}.md`);
  }

  // .md 파일 1개 → 프로파일 1개. 파일명이 프로파일 이름, 본문은 지침/기억할 정보로 분리.
  function parseProfileMarkdown(text, label) {
    const instrHeader = /^###\s*지침\s*$/;
    const memHeader = /^###\s*기억할 정보\s*$/;
    const lines = String(text).split(/\r?\n/);
    const instr = [];
    const mem = [];
    let target = "mem"; // 헤더가 없으면 전체를 '기억할 정보'로 본다
    let started = false;
    for (const line of lines) {
      if (instrHeader.test(line)) {
        target = "instr";
        started = true;
        continue;
      }
      if (memHeader.test(line)) {
        target = "mem";
        started = true;
        continue;
      }
      if (!started && /^#\s/.test(line)) {
        continue; // 맨 위 제목(파일명) 줄은 무시
      }
      (target === "instr" ? instr : mem).push(line);
    }
    return {
      id: createId(),
      label: label || "가져온 메모리",
      instructions: instr.join("\n").trim(),
      text: mem.join("\n").trim(),
    };
  }

  // 여러 .md를 한 번에 가져온다. 같은 이름은 덮어쓰고, 새 이름은 추가(개별 관리).
  function importMemoryFiles(files) {
    let firstId = null;
    for (const { label, text } of files) {
      const parsed = parseProfileMarkdown(text, label);
      const existing = state.memoryProfiles.find((profile) => profile.label === parsed.label);
      if (existing) {
        existing.instructions = parsed.instructions;
        existing.text = parsed.text;
        firstId = firstId || existing.id;
      } else {
        state.memoryProfiles.push(parsed);
        firstId = firstId || parsed.id;
      }
    }
    if (firstId) {
      state.activeMemoryProfileId = firstId;
    }
    normalizeMemoryState();
    renderMemorySelect();
    renderMemoryModal();
    renderContextCount();
    saveState();
  }

  // 다음 renderMessages 1회만 바닥 대신 최신 질문을 상단 고정(질문 제출 흐름에서 설정).
  let pendingQuestionAnchor = false;
  // 다음 renderMessages 1회는 자동 스크롤(앵커/바닥)을 생략 — 호출자가 직접 위치를 복원(완료 시 위치 보존).
  let suppressAutoScroll = false;

  // 코드/표에 붙인 ResizeObserver 목록. 재렌더로 노드를 버리기 전에 disconnect 해 누적 방지.
  const hscrollObservers = [];

  function renderMessages() {
    const conversation = getActiveConversation();
    hscrollObservers.forEach((ro) => ro.disconnect());
    hscrollObservers.length = 0;
    elements.messages.innerHTML = "";
    renderContextCount();

    if (conversation.messages.length === 0) {
      const config = getActiveConfig();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "질문을 입력해 시작하세요";
      const text = document.createElement("span");
      text.textContent = "아래 입력창에 질문을 적고 Enter로 전송하세요. 텍스트 파일은 끌어다 놓거나 붙여넣어 첨부할 수 있습니다.";
      // endpoint 요약 + 바로 연결 확인(도구 메뉴에 숨지 않게 첫 화면에서 발견성 확보).
      const conn = document.createElement("div");
      conn.className = "empty-endpoint";
      const ep = document.createElement("code");
      ep.className = "empty-endpoint-url";
      ep.textContent = `${config.label} · ${config.endpoint || "(endpoint 미설정)"}`;
      ep.title = config.endpoint || "";
      const checkBtn = document.createElement("button");
      checkBtn.type = "button";
      checkBtn.className = "ghost-button compact";
      checkBtn.textContent = "연결 확인";
      checkBtn.addEventListener("click", checkConnection);
      conn.append(ep, checkBtn);
      empty.append(title, text, conn);
      elements.messages.appendChild(empty);
      return;
    }

    // 침묵 트림 가시화: 예산을 넘겨 전송에서 빠지는 오래된 메시지를 흐리게 표시하고,
    // 모델에 실제 전송되는 첫 메시지 앞에 경계선을 둔다. 단발 모드에서는 생략.
    const multiturn = conversation.includeHistory !== false;
    const stats = getContextStats(conversation);
    const trimmedCount = Math.max(0, stats.total - stats.included);
    let outRemaining = multiturn ? trimmedCount : 0;
    let dividerPlaced = false;

    conversation.messages.forEach((message, index) => {
      const counts = message.role === "user" || message.role === "assistant";
      if (multiturn && trimmedCount > 0 && outRemaining === 0 && !dividerPlaced && counts) {
        elements.messages.appendChild(createContextDivider());
        dividerPlaced = true;
      }
      const node = createMessageNode(message, index);
      if (multiturn && counts && outRemaining > 0) {
        node.classList.add("out-of-context");
        outRemaining -= 1;
      }
      elements.messages.appendChild(node);
    });
    if (suppressAutoScroll) {
      suppressAutoScroll = false;
      updateScrollBottomButton();
      return;
    }
    if (pendingQuestionAnchor) {
      pendingQuestionAnchor = false;
      anchorLatestQuestion();
    } else {
      scrollToBottom();
    }
  }

  function createContextDivider() {
    const divider = document.createElement("div");
    divider.className = "context-divider";
    divider.setAttribute("role", "separator");
    const label = document.createElement("span");
    label.textContent = "여기부터 모델에 전송됨";
    divider.appendChild(label);
    return divider;
  }

  function renderContextCount() {
    const conversation = getActiveConversation();
    const stats = getContextStats(conversation);
    const historyNote = conversation.includeHistory === false ? " (단발)" : "";
    const pct = stats.limit > 0 ? Math.round((stats.approximateChars / stats.limit) * 100) : 0;
    if (elements.contextCount) {
      elements.contextCount.textContent = `${stats.included}/${stats.total}`;
    }
    // 맥락 사용량을 도넛 차트로 표시(정확한 수치는 tooltip).
    if (elements.contextArc) {
      const circumference = 2 * Math.PI * 15; // r=15
      const clamped = Math.max(0, Math.min(100, pct));
      elements.contextArc.style.strokeDashoffset = String(circumference * (1 - clamped / 100));
    }
    elements.contextState.title = `맥락 ${pct}% · ≈${formatCharCount(stats.approximateChars)}/${formatCharCount(stats.limit)}자 · 포함 ${stats.included}/${stats.total} 메시지${historyNote} (클릭: 상세·압축)`;
    // 사용량 단계 색: 여유(초록) → 주의(주황) → 임박(빨강)
    const level = pct >= 85 ? "level-high" : pct >= 60 ? "level-mid" : "level-ok";
    elements.contextState.classList.remove("level-ok", "level-mid", "level-high");
    elements.contextState.classList.add(level);
  }

  function formatCharCount(value) {
    const n = Number(value) || 0;
    return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
  }

  function shouldOfferSummary(conversation) {
    if (conversation.includeHistory === false || conversation.summaryDismissed) {
      return false;
    }
    const count = conversation.messages.filter((m) => m.role === "user" || m.role === "assistant").length;
    if (count <= SUMMARY_KEEP_RECENT + 1) {
      return false; // 요약할 만큼 쌓이지 않음
    }
    const stats = getContextStats(conversation);
    const budgetHit = stats.approximateChars >= SUMMARY_TRIGGER_RATIO * stats.limit;
    return budgetHit || count >= SUMMARY_MSG_COUNT;
  }

  function renderSummaryBanner() {
    if (!elements.summaryBanner) {
      return;
    }
    elements.summaryBanner.hidden = !(shouldOfferSummary(getActiveConversation()) && !abortController);
  }

  // 오래된 메시지를 모델 요약 1건으로 대체하고 최근 SUMMARY_KEEP_RECENT개는 원문 유지한다.
  async function summarizeConversation() {
    if (abortController) {
      return;
    }
    const conversation = getActiveConversation();
    const conversationId = conversation.id;
    const keep = conversation.messages.slice(-SUMMARY_KEEP_RECENT);
    const older = conversation.messages
      .slice(0, Math.max(0, conversation.messages.length - SUMMARY_KEEP_RECENT))
      .filter((m) => m.role === "user" || m.role === "assistant");
    if (older.length === 0) {
      setStatus("요약할 내용이 부족합니다.", "");
      return;
    }
    // 보존용 원문: 재요약 시 이전 summary는 그 원문(archived)으로 평탄화해 중첩(O(n^2))을 막는다.
    const archivedFlat = older.flatMap((m) =>
      Array.isArray(m.archived) && m.archived.length ? m.archived : [{ ...m, archived: undefined }],
    );
    const transcript = older
      .map((m) => `${m.role === "user" ? "사용자" : "어시스턴트"}: ${m.content}`)
      .join("\n\n");
    const selected = getActiveConfig();
    const summaryMessages = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];

    setBusy(true);
    renderSummaryBanner();
    renderTyping("대화 요약 중…");
    abortController = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      abortController?.abort();
    }, SEND_TIMEOUT_MS);

    try {
      const answer = await requestChatCompletion(selected, summaryMessages, abortController.signal);
      const target = state.conversations.find((item) => item.id === conversationId) || conversation;
      const summaryMessage = {
        role: "assistant",
        content: answer.text,
        modelLabel: "요약",
        summary: true,
        // 원문을 삭제하지 않고 요약 메시지에 보존한다(복구 가능). 요청 전송 대상에서는 제외됨.
        archived: archivedFlat,
        createdAt: new Date().toISOString(),
      };
      target.messages = [summaryMessage, ...keep];
      target.summaryDismissed = false;
      target.updatedAt = new Date().toISOString();
      setStatus("요약 완료", "");
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      const detail = isAbort
        ? timedOut
          ? "응답 지연 — 시간 초과"
          : "중지됨"
        : error instanceof TypeError
          ? "네트워크 오류 — CORS(Origin null 허용) 또는 endpoint 접근을 확인하세요"
          : error instanceof Error
            ? error.message
            : String(error);
      setStatus(`요약 실패: ${detail}`, "is-error");
    } finally {
      window.clearTimeout(timer);
      abortController = null;
      removeTyping();
      setBusy(false);
      persistState();
      renderAll();
      updateUsage(null);
    }
  }

  // 흑백 인라인 SVG 아이콘(currentColor). 외부 리소스 없이 file://에서 동작.
  function makeIcon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const paths = {
      copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
      regenerate: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/>',
      edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
    };
    svg.innerHTML = paths[name] || "";
    return svg;
  }

  function createMessageAction(iconName, title, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-action icon-action";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.appendChild(makeIcon(iconName));
    button.addEventListener("click", handler);
    return button;
  }

  // 사용자 메시지 편집: 내용을 입력창으로 되돌리고 이 메시지 이후를 제거 → 수정 후 다시 전송.
  function editUserMessage(index) {
    if (abortController) {
      return;
    }
    const conversation = getActiveConversation();
    const message = conversation.messages[index];
    if (!message || message.role !== "user") {
      return;
    }
    if (conversation.messages.length > index + 1 && !window.confirm("이 지점 이후의 대화가 모두 사라집니다. 이 메시지로 되돌릴까요?")) {
      return;
    }
    elements.prompt.value = message.content;
    conversation.messages = conversation.messages.slice(0, index);
    conversation.updatedAt = new Date().toISOString();
    persistState();
    renderAll();
    resizePrompt();
    elements.prompt.focus();
    setStatus("편집 후 다시 전송하세요.", "");
  }

  // 어시스턴트 재생성: 직전 user 메시지부터 이후를 제거하고 같은 질문을 재전송.
  function regenerateAssistant(index) {
    if (abortController) {
      return;
    }
    const conversation = getActiveConversation();
    let userIndex = -1;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (conversation.messages[i].role === "user") {
        userIndex = i;
        break;
      }
    }
    if (userIndex === -1) {
      return;
    }
    if (conversation.messages.length > index + 1 && !window.confirm("이 지점 이후의 대화가 사라집니다. 여기서 재생성할까요?")) {
      return;
    }
    const userContent = conversation.messages[userIndex].content;
    conversation.messages = conversation.messages.slice(0, userIndex);
    conversation.updatedAt = new Date().toISOString();
    persistState();
    renderAll();
    elements.prompt.value = userContent;
    resizePrompt();
    elements.composer.requestSubmit();
  }

  function createMessageNode(message, index) {
    const wrapper = document.createElement("article");
    wrapper.className = `message ${message.role}${message.summary ? " summary" : ""}`;

    const top = document.createElement("div");
    top.className = "message-top";

    // Assistant/User 라벨은 표시하지 않는다(요약/오류만 라벨, 어시스턴트는 모델명만 옅게).
    const meta = document.createElement("div");
    meta.className = "message-meta";
    if (message.role === "error") {
      meta.textContent = "오류";
    } else if (message.role === "assistant") {
      meta.textContent = message.summary ? "이전 대화 요약" : message.modelLabel || message.model || "";
    } else {
      meta.textContent = "";
    }
    top.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "message-actions";
    // 메시지별 액션(편집/재생성/복사) — 흑백 아이콘. index가 있을 때만(스트리밍 임시 노드 제외).
    if (typeof index === "number") {
      if (message.role === "user") {
        actions.appendChild(createMessageAction("edit", "편집", () => editUserMessage(index)));
      } else if (message.role === "assistant" && !message.summary) {
        actions.appendChild(createMessageAction("regenerate", "재생성", () => regenerateAssistant(index)));
      } else if (message.role === "error") {
        // 실패 지점 원클릭 재시도: 직전 질문부터 다시 전송(재생성과 동일 경로, 질문 중복 없음).
        actions.appendChild(createMessageAction("regenerate", "재시도", () => regenerateAssistant(index)));
      }
    }
    if (message.role === "assistant") {
      actions.appendChild(createCopyButton(message.content, "답변 복사"));
    } else if (message.role === "error") {
      actions.appendChild(createCopyButton(message.content, "오류 복사"));
    }
    top.appendChild(actions);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    renderMessageContent(bubble, message.content);

    wrapper.append(top, bubble);

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      wrapper.appendChild(createAttachmentRefs(message.attachments));
    }
    if (message.summary && Array.isArray(message.archived) && message.archived.length > 0) {
      wrapper.appendChild(createArchivedBlock(message.archived));
    }
    return wrapper;
  }

  // 메시지에 딸린 첨부 칩(보관함에서 원본 재다운로드).
  function createAttachmentRefs(attachments) {
    const row = document.createElement("div");
    row.className = "attachment-refs";
    for (const attachment of attachments) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "attachment-ref";
      chip.title = `${attachment.name} — 다운로드`;
      const name = document.createElement("span");
      name.className = "attachment-ref-name";
      name.textContent = attachment.name;
      const meta = document.createElement("span");
      meta.className = "attachment-ref-size";
      meta.textContent = `↓ ${formatBytes(attachment.size)}`;
      chip.append(name, meta);
      chip.addEventListener("click", () => downloadAttachment(attachment.id, attachment.name));
      row.appendChild(chip);
    }
    return row;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) {
      return `${n}B`;
    }
    if (n < 1024 * 1024) {
      return `${Math.round(n / 102.4) / 10}KB`;
    }
    return `${Math.round(n / (1024 * 104.8576)) / 10}MB`;
  }

  // 요약이 대체한 원문을 펼쳐보기로 보존 표시(읽기 전용, 전송 대상 아님).
  function createArchivedBlock(archived) {
    const details = document.createElement("details");
    details.className = "archived-block";

    const summary = document.createElement("summary");
    summary.textContent = `요약 전 원문 ${archived.length}개 펼치기`;
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "archived-list";
    for (const message of archived) {
      const item = document.createElement("article");
      item.className = `message ${message.role} archived-item`;

      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = message.role === "user" ? "" : message.modelLabel || message.model || "";

      const itemBubble = document.createElement("div");
      itemBubble.className = "bubble";
      renderMessageContent(itemBubble, message.content);

      item.append(meta, itemBubble);
      list.appendChild(item);
    }
    details.appendChild(list);
    return details;
  }

  function renderMessageContent(container, content) {
    // 빈/공백뿐인 응답은 빈 버블 대신 안내 placeholder 한 번만 표시.
    if (!String(content || "").trim()) {
      const empty = document.createElement("span");
      empty.className = "empty-response-placeholder";
      empty.textContent = "(빈 응답)";
      container.appendChild(empty);
      return;
    }
    const segments = splitFencedCode(content);
    if (segments.length === 0) {
      appendMarkdownSegment(container, content);
      return;
    }

    for (const segment of segments) {
      if (segment.type === "code") {
        appendCodeSegment(container, segment);
      } else {
        appendMarkdownSegment(container, segment.content);
      }
    }
  }

  function splitFencedCode(content) {
    const lines = String(content).replaceAll("\r\n", "\n").split("\n");
    const segments = [];
    let textBuffer = [];
    let codeBuffer = [];
    let inCode = false;
    let language = "text";

    const flushText = () => {
      if (textBuffer.length === 0) {
        return;
      }
      segments.push({ type: "text", content: textBuffer.join("\n") });
      textBuffer = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("```")) {
        if (inCode) {
          segments.push({ type: "code", language, content: codeBuffer.join("\n") });
          codeBuffer = [];
          inCode = false;
          language = "text";
        } else {
          flushText();
          const candidate = trimmed.slice(3).trim().split(/\s+/)[0];
          language = candidate || "text";
          inCode = true;
        }
        continue;
      }

      if (inCode) {
        codeBuffer.push(line);
      } else {
        textBuffer.push(line);
      }
    }

    if (inCode) {
      // 미종결 펜스는 CommonMark처럼 EOF에서 암묵적으로 닫힌 코드로 취급한다.
      // 텍스트로 되돌리면 코드 속 '# 주석'이 제목, '- x'가 목록으로 오파싱된다(중지 저장·모델 실수 시 상시 발생).
      segments.push({ type: "code", language, content: codeBuffer.join("\n") });
    }
    flushText();
    return segments;
  }

  function appendMarkdownSegment(container, content) {
    const lines = String(content).replaceAll("\r\n", "\n").split("\n");
    let block = [];

    const flushBlock = () => {
      if (block.length === 0) {
        return;
      }
      appendMarkdownBlock(container, block);
      block = [];
    };

    for (const line of lines) {
      if (line.trim() === "") {
        flushBlock();
      } else {
        block.push(line);
      }
    }
    flushBlock();
  }

  // 한 블록(빈 줄 사이) 안에 제목·인용·목록·문단이 섞여 있어도 처리한다. 동종 줄의 '선행 런'을
  // 소비하고 나머지를 재귀로 넘겨, 빈 줄 없이 붙은 제목+목록이나 중첩 인용도 올바로 렌더한다.
  function appendMarkdownBlock(container, lines) {
    if (!lines.length) {
      return;
    }
    // 표는 블록 전체가 표 모양(헤더+구분선)일 때만 처리.
    if (isMarkdownTable(lines)) {
      appendTable(container, lines);
      return;
    }

    const isHeading = (line) => /^#{1,6}\s+/.test(line.trim());
    const isQuote = (line) => /^>\s?/.test(line.trim());
    const isListLine = (line) => /^([-*]|\d+[.)])\s+/.test(line.trim());
    const first = lines[0];

    // 제목: 한 줄만 소비하고 나머지를 이어서 처리.
    if (isHeading(first)) {
      const m = first.trim().match(/^(#{1,6})\s+(.*)$/);
      const level = Math.min(6, Math.max(3, m[1].length + 2)); // # → h3 ... ####+ → h6
      const heading = document.createElement(`h${level}`);
      heading.className = "content-heading";
      appendInlineMarkdown(heading, m[2]);
      container.appendChild(heading);
      appendMarkdownBlock(container, lines.slice(1));
      return;
    }

    // 인용: 선행 '>' 런만 소비(중첩은 한 단계 벗긴 뒤 재귀로 처리).
    if (isQuote(first)) {
      let i = 0;
      while (i < lines.length && isQuote(lines[i])) {
        i += 1;
      }
      const quote = document.createElement("blockquote");
      quote.className = "content-quote";
      const inner = lines.slice(0, i).map((line) => line.trim().replace(/^>\s?/, "")).join("\n");
      appendMarkdownSegment(quote, inner);
      container.appendChild(quote);
      appendMarkdownBlock(container, lines.slice(i));
      return;
    }

    // 목록: 선행 리스트 런만 소비(중첩 항목은 들여쓰기 깊이로 처리).
    if (isListLine(first)) {
      let i = 0;
      while (i < lines.length && isListLine(lines[i])) {
        i += 1;
      }
      appendList(container, lines.slice(0, i), /^\d+[.)]\s+/.test(first.trim()) ? "ol" : "ul");
      appendMarkdownBlock(container, lines.slice(i));
      return;
    }

    // 문단: 다음 구조(제목/인용/목록) 라인 전까지의 평문 런을 소비.
    let i = 0;
    while (i < lines.length && !isHeading(lines[i]) && !isQuote(lines[i]) && !isListLine(lines[i])) {
      i += 1;
    }
    appendParagraph(container, lines.slice(0, i));
    appendMarkdownBlock(container, lines.slice(i));
  }

  function appendParagraph(container, lines) {
    const paragraph = document.createElement("div");
    paragraph.className = "content-text";
    lines.forEach((line, index) => {
      if (index > 0) {
        paragraph.appendChild(document.createElement("br"));
      }
      appendInlineMarkdown(paragraph, line);
    });
    container.appendChild(paragraph);
  }

  function appendList(container, lines, tagName) {
    // 선행 공백(2칸=1단계, 탭=2칸)으로 깊이를 계산해 중첩 리스트를 만든다.
    const parsed = lines.map((line) => {
      const indent = (line.match(/^[\t ]*/)[0] || "").replace(/\t/g, "  ").length;
      const trimmed = line.trim();
      return {
        depth: Math.floor(indent / 2),
        ordered: /^\d+[.)]\s+/.test(trimmed),
        text: trimmed.replace(/^([-*]|\d+[.)])\s+/, ""),
      };
    });

    const root = document.createElement(tagName);
    root.className = "markdown-list";
    container.appendChild(root);
    const baseDepth = parsed.length ? parsed[0].depth : 0;
    const stack = [{ depth: baseDepth, list: root, lastItem: null }];

    for (const item of parsed) {
      let top = stack[stack.length - 1];
      while (item.depth < top.depth && stack.length > 1) {
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (item.depth > top.depth && top.lastItem) {
        const child = document.createElement(item.ordered ? "ol" : "ul");
        child.className = "markdown-list";
        top.lastItem.appendChild(child);
        stack.push({ depth: item.depth, list: child, lastItem: null });
        top = stack[stack.length - 1];
      }
      const li = document.createElement("li");
      appendInlineMarkdown(li, item.text);
      top.list.appendChild(li);
      top.lastItem = li;
    }
  }

  function isMarkdownTable(lines) {
    if (lines.length < 2 || !lines[0].includes("|")) {
      return false;
    }
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[1]);
  }

  function appendTable(container, lines) {
    const wrapper = document.createElement("div");
    wrapper.className = "markdown-table-wrap";
    const table = document.createElement("table");
    table.className = "markdown-table";

    // 구분선(2번째 줄)의 :---: / ---: / :--- 로 열별 정렬을 읽어 셀에 적용.
    const aligns = parseTableAligns(lines[1]);
    const headerCells = splitTableRow(lines[0]);
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerCells.forEach((cell, c) => {
      const th = document.createElement("th");
      appendInlineMarkdown(th, cell);
      if (aligns[c]) th.style.textAlign = aligns[c];
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const line of lines.slice(2)) {
      const row = document.createElement("tr");
      splitTableRow(line).forEach((cell, c) => {
        const td = document.createElement("td");
        appendInlineMarkdown(td, cell);
        if (aligns[c]) td.style.textAlign = aligns[c];
        row.appendChild(td);
      });
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    // 오버플로 시에만 보이는 상단 툴바(‹ › + 안내). 콘텐츠 위에 겹치지 않아 첫 열/본문을 가리지 않는다.
    const head = document.createElement("div");
    head.className = "table-head";
    const hint = document.createElement("span");
    hint.className = "table-head-hint";
    hint.textContent = "좌우 스크롤";
    head.appendChild(hint);
    const scroll = document.createElement("div");
    scroll.className = "markdown-table-scroll";
    scroll.appendChild(table);
    wrapper.append(head, scroll);
    container.appendChild(wrapper);
    attachHScrollButtons(scroll, wrapper, { labels: ["표 왼쪽으로 스크롤", "표 오른쪽으로 스크롤"], toolbar: head });
  }

  function splitTableRow(line) {
    let value = line.trim();
    if (value.startsWith("|")) {
      value = value.slice(1);
    }
    if (value.endsWith("|")) {
      value = value.slice(0, -1);
    }
    return value.split("|").map((cell) => cell.trim());
  }

  // 표 구분선 셀의 콜론으로 열 정렬을 판정: :--- 왼쪽, ---: 오른쪽, :---: 가운데.
  function parseTableAligns(sepLine) {
    return splitTableRow(sepLine).map((cell) => {
      const t = cell.trim();
      const left = t.startsWith(":");
      const right = t.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "";
    });
  }

  // 모델이 자주 뱉는 LaTeX 명령(\rightarrow 등)이 평문으로 남아 마크다운이 깨져 보이는 것을
  // 막는다. 알려진 명령만 유니코드 기호로 바꾸고, 모르는 명령은 원문 그대로 둔다.
  const LATEX_SYMBOLS = {
    rightarrow: "→", Rightarrow: "⇒", longrightarrow: "→", to: "→", mapsto: "↦",
    leftarrow: "←", Leftarrow: "⇐", longleftarrow: "←", gets: "←",
    leftrightarrow: "↔", Leftrightarrow: "⇔", uparrow: "↑", downarrow: "↓",
    times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", bullet: "•",
    leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", ll: "≪", gg: "≫",
    approx: "≈", equiv: "≡", cong: "≅", sim: "∼", simeq: "≃", propto: "∝",
    infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", neg: "¬",
    in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇",
    cup: "∪", cap: "∩", emptyset: "∅", setminus: "∖", land: "∧", lor: "∨",
    sum: "∑", prod: "∏", int: "∫", sqrt: "√", angle: "∠", perp: "⊥", parallel: "∥",
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ",
    mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
    phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
    Phi: "Φ", Psi: "Ψ", Omega: "Ω", deg: "°", prime: "′", ldots: "…", dots: "…", cdots: "⋯",
    langle: "⟨", rangle: "⟩", quad: " ", qquad: "  ",
  };

  function decodeInlineSymbols(str) {
    if (str.indexOf("\\") === -1) {
      return str;
    }
    return str
      .replace(/\\\\/g, "") // LaTeX 줄바꿈(\\) 제거
      .replace(/\\([A-Za-z]+)/g, (m, name) =>
        Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name) ? LATEX_SYMBOLS[name] : m,
      )
      .replace(/\\[()[\]]/g, "") // 인라인 수식 구분자 \( \) \[ \]
      .replace(/\\[,;:!> ]/g, " "); // LaTeX 간격 명령
  }

  function appendInlineMarkdown(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;
    let lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(decodeInlineSymbols(text.slice(lastIndex, match.index))));
      }
      const token = match[0];
      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = token.slice(1, -1); // 인라인 코드는 원문 보존(기호 변환 안 함)
        parent.appendChild(code);
      } else if (token.startsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = decodeInlineSymbols(token.slice(2, -2));
        parent.appendChild(strong);
      } else {
        appendLinkToken(parent, token);
      }
      lastIndex = match.index + token.length;
      match = pattern.exec(text);
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(decodeInlineSymbols(text.slice(lastIndex))));
    }
  }

  // [label](href) → 안전한 href만 a로 렌더(javascript:/data: 등 차단), 나머지는 라벨 평문.
  function appendLinkToken(parent, token) {
    const linkMatch = token.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)$/);
    if (!linkMatch) {
      parent.appendChild(document.createTextNode(token));
      return;
    }
    const href = sanitizeUrl(linkMatch[2]);
    if (!href) {
      parent.appendChild(document.createTextNode(linkMatch[1]));
      return;
    }
    const anchor = document.createElement("a");
    anchor.className = "content-link";
    anchor.href = href;
    anchor.textContent = decodeInlineSymbols(linkMatch[1]); // 링크 라벨도 굵게·평문과 동일하게 기호 디코드
    anchor.target = "_blank";
    anchor.rel = "noreferrer noopener";
    parent.appendChild(anchor);
  }

  function sanitizeUrl(url) {
    const value = String(url || "").replace(/[\u0000-\u0020\u00a0\u2028\u2029]/g, "");
    if (!value) {
      return null;
    }
    const schemeMatch = value.match(/^([a-z][a-z0-9+.-]*):/i);
    if (schemeMatch && !/^https?$/i.test(schemeMatch[1])) {
      return null; // javascript:, data:, vbscript:, file: 등 차단. 스킴 없는 상대경로/앵커는 허용.
    }
    return value;
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // 가로로 넘치는 스크롤 컨테이너(scrollEl)에 ‹ › 좌우 스크롤 컨트롤을 단다. 콘텐츠 위에 겹쳐
  // 뜨는 대신 블록 상단 툴바(opts.toolbar)에 인라인 배치해 본문을 가리지 않고, 블록이 아무리
  // 길어도(세로 스크롤) 항상 도달 가능하다. 오버플로 시에만 노출(hostEl 에 .has-overflow 토글).
  // 클릭은 보이는 폭의 85%씩 페이지 단위로 이동. 코드블록·표 공용 헬퍼.
  function attachHScrollButtons(scrollEl, hostEl, opts) {
    const labels = (opts && opts.labels) || ["왼쪽으로 스크롤", "오른쪽으로 스크롤"];
    const toolbar = (opts && opts.toolbar) || hostEl;

    const controls = document.createElement("div");
    controls.className = "hscroll-controls";
    const left = document.createElement("button");
    left.type = "button";
    left.className = "hscroll-btn hscroll-left";
    left.setAttribute("aria-label", labels[0]);
    left.textContent = "‹";
    const right = document.createElement("button");
    right.type = "button";
    right.className = "hscroll-btn hscroll-right";
    right.setAttribute("aria-label", labels[1]);
    right.textContent = "›";
    controls.append(left, right);

    const step = (dir) =>
      scrollEl.scrollBy({
        left: dir * Math.max(160, scrollEl.clientWidth * 0.85),
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    left.addEventListener("click", () => step(-1));
    right.addEventListener("click", () => step(1));
    const update = () => {
      hostEl.classList.toggle("has-overflow", scrollEl.scrollWidth > scrollEl.clientWidth + 4);
      left.disabled = scrollEl.scrollLeft <= 0;
      right.disabled = scrollEl.scrollLeft + scrollEl.clientWidth >= scrollEl.scrollWidth - 1;
    };
    scrollEl.addEventListener("scroll", update, { passive: true });
    // 오버플로 감지 견고화: 스트리밍/폰트로드/리사이즈 후 상태가 어긋나 버튼이 안 뜨거나
    // 위치가 어긋남 → 컨테이너·내용 크기 변화를 ResizeObserver로 재평가.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(update);
      ro.observe(scrollEl);
      if (scrollEl.firstElementChild) {
        ro.observe(scrollEl.firstElementChild);
      }
      hscrollObservers.push(ro); // 다음 재렌더 시 disconnect 대상으로 등록
    }
    toolbar.appendChild(controls);
    // 부착 직후 동기 측정 + rAF/매크로태스크 후속 보정(부착 전엔 clientWidth=0이라 무의미).
    update();
    window.requestAnimationFrame(update);
    window.setTimeout(update, 0);
    return update;
  }

  function appendCodeSegment(container, segment) {
    const block = document.createElement("div");
    block.className = "code-block";
    block.dataset.language = segment.language || "text";

    const head = document.createElement("div");
    head.className = "code-head";

    const label = document.createElement("span");
    label.className = "code-language";
    label.textContent = segment.language || "text";
    head.appendChild(label);
    head.appendChild(createCopyButton(segment.content, "코드 복사"));

    const scroll = document.createElement("div");
    scroll.className = "code-scroll";

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = segment.content;
    pre.appendChild(code);
    scroll.appendChild(pre);

    block.append(head, scroll);
    container.appendChild(block);
    // 가로로 긴 코드: ‹ › 좌우 스크롤 버튼을 code-head 툴바에 배치(콘텐츠 가림 없음, 항상 도달 가능).
    attachHScrollButtons(scroll, block, { labels: ["코드 왼쪽으로 스크롤", "코드 오른쪽으로 스크롤"], toolbar: head });
  }

  function createCopyButton(text, label) {
    const button = document.createElement("button");
    button.className = "copy-button icon-action";
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.appendChild(makeIcon("copy"));
    button.dataset.copyKind = "text";
    button.dataset.icon = "true";
    button._copyText = text;
    return button;
  }

  function renderTyping(loadingLabel = "응답 생성 중…") {
    const wrapper = document.createElement("article");
    wrapper.className = "message assistant";
    wrapper.id = "typing-message";

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = getActiveConfig().label;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    const loading = document.createElement("div");
    loading.className = "loading-row";
    const typing = document.createElement("span");
    typing.className = "typing";
    typing.setAttribute("aria-label", loadingLabel);
    typing.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    const label = document.createElement("span");
    label.className = "loading-label";
    label.textContent = loadingLabel;
    const timerText = document.createElement("span");
    timerText.className = "loading-timer";
    loading.append(typing, label, timerText);
    bubble.appendChild(loading);

    wrapper.append(meta, bubble);
    elements.messages.appendChild(wrapper);
    anchorLatestQuestion(); // 비스트리밍 로딩도 질문을 상단 고정

    // 비스트리밍 단발 응답 대비: 경과 시간을 1초마다 갱신해 진행 중임을 보인다.
    const startedAt = Date.now();
    const limitSeconds = Math.round(SEND_TIMEOUT_MS / 1000);
    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      timerText.textContent = `${seconds}s / ${limitSeconds}s`;
      setStatus(`호출 중 ${seconds}s`, "is-busy");
    };
    tick();
    typingTimer = window.setInterval(tick, 1000);
  }

  function removeTyping() {
    if (typingTimer !== null) {
      window.clearInterval(typingTimer);
      typingTimer = null;
    }
    document.getElementById("typing-message")?.remove();
  }

  function renderAttachments() {
    elements.attachmentList.innerHTML = "";
    elements.clearAttachments.disabled = pendingAttachments.length === 0;

    if (pendingAttachments.length === 0) {
      elements.attachmentStatus.textContent = "첨부 없음";
      return;
    }

    const totalChars = pendingAttachments.reduce((sum, item) => sum + item.content.length, 0);
    elements.attachmentStatus.textContent = `${pendingAttachments.length}개 · ${formatNumber(totalChars)}자`;

    for (const attachment of pendingAttachments) {
      const item = document.createElement("div");
      item.className = "attachment-item";

      const meta = document.createElement("div");
      meta.className = "attachment-meta";

      const name = document.createElement("strong");
      name.textContent = attachment.name;

      const detail = document.createElement("span");
      detail.textContent = [
        attachment.language,
        formatBytes(attachment.size),
        `${formatNumber(attachment.content.length)}자`,
        attachment.encoding && attachment.encoding !== "utf-8" ? attachment.encoding.toUpperCase() : "",
        attachment.truncated ? "잘림" : "",
      ]
        .filter(Boolean)
        .join(" · ");

      meta.append(name, detail);

      const remove = document.createElement("button");
      remove.className = "copy-button attachment-remove";
      remove.type = "button";
      remove.textContent = "제거";
      remove.dataset.attachmentId = attachment.id;

      item.append(meta, remove);
      elements.attachmentList.appendChild(item);
    }
  }

  // 파일을 텍스트로 읽되, UTF-8 로 디코드 불가하면 한국 폐쇄망에서 흔한 CP949/EUC-KR 로 폴백한다.
  // (file.text() 는 항상 UTF-8 이라 ANSI(EUC-KR) 파일이 로 깨진다.)
  async function readFileText(file) {
    const buffer = await file.arrayBuffer();
    try {
      return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" };
    } catch (_utf8Error) {
      try {
        return { text: new TextDecoder("euc-kr").decode(buffer), encoding: "euc-kr" };
      } catch (_eucError) {
        return { text: new TextDecoder("utf-8").decode(buffer), encoding: "utf-8" }; // 최후: 관대한 UTF-8
      }
    }
  }

  async function addTextAttachments(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }

    const accepted = [];
    const rejected = [];
    let remainingSlots = MAX_ATTACHMENTS - pendingAttachments.length;
    let remainingChars =
      MAX_TOTAL_ATTACHMENT_CHARS - pendingAttachments.reduce((sum, item) => sum + item.content.length, 0);

    for (const file of files) {
      if (remainingSlots <= 0) {
        rejected.push(`${file.name}: 최대 ${MAX_ATTACHMENTS}개`);
        continue;
      }
      if (!isTextAttachment(file)) {
        rejected.push(`${file.name}: 텍스트 파일 아님`);
        continue;
      }
      if (remainingChars <= 0) {
        rejected.push(`${file.name}: 첨부 용량 초과`);
        continue;
      }

      try {
        const { text: rawText, encoding } = await readFileText(file);
        const normalized = rawText.replaceAll("\r\n", "\n");
        const language = languageFromFileName(file.name);
        const limit = Math.min(MAX_TEXT_ATTACHMENT_CHARS, remainingChars);
        const truncated = truncateAttachmentContent(normalized, limit, language);
        accepted.push({
          id: createId(),
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          language,
          encoding, // utf-8 | euc-kr (칩에 표시)
          content: truncated.content,
          originalChars: normalized.length,
          truncated: truncated.truncated,
          blob: file, // 원본 File(메모리). 전송 시 IndexedDB 보관함에 저장.
        });
        remainingSlots -= 1;
        remainingChars -= truncated.content.length;
      } catch (error) {
        rejected.push(`${file.name}: ${error instanceof Error ? error.message : "읽기 실패"}`);
      }
    }

    pendingAttachments.push(...accepted);
    renderAttachments();

    if (accepted.length > 0 && rejected.length === 0) {
      setStatus(`${accepted.length}개 첨부`, "");
    } else if (accepted.length > 0) {
      setStatus(`${accepted.length}개 첨부, ${rejected.length}개 제외`, "");
    } else if (rejected.length > 0) {
      setStatus(rejected[0], "is-error");
    }
  }

  function clearPendingAttachments() {
    pendingAttachments = [];
    renderAttachments();
  }

  function isTextAttachment(file) {
    const mime = String(file.type || "").toLowerCase();
    const extension = extensionFromFileName(file.name);
    const fileName = String(file.name || "").toLowerCase();
    if (mime.startsWith("image/") || mime.startsWith("audio/") || mime.startsWith("video/")) {
      return false;
    }
    return (
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      TEXT_ATTACHMENT_EXTENSIONS.has(extension) ||
      TEXT_FILENAMES.has(fileName)
    );
  }

  function truncateAttachmentContent(content, limit, language) {
    if (content.length <= limit) {
      return { content, truncated: false };
    }
    // 코드는 중간을 잘라내면 구문이 깨져 모델이 잘못된 코드를 분석한다 → head-only로 자르고 끝에 주석 마커.
    if (!PROSE_LANGUAGES.has(language)) {
      const reserve = 40; // 마커 문구 여유
      const headLength = Math.max(0, limit - reserve);
      const omitted = content.length - headLength;
      const marker = "\n" + commentLine(commentPrefixFor(language), `(이후 ${formatNumber(omitted)}자 생략)`);
      return { content: `${content.slice(0, headLength)}${marker}`, truncated: true };
    }
    // 산문/로그: 앞 설정 + 뒤 에러를 함께 보존하기 위해 기존 head+tail 절단 유지.
    if (limit < 2000) {
      return { content: content.slice(0, limit), truncated: true };
    }
    const marker = "\n\n[...중간 내용 생략...]\n\n";
    const headLength = Math.floor((limit - marker.length) * 0.65);
    const tailLength = limit - marker.length - headLength;
    return {
      content: `${content.slice(0, headLength)}${marker}${content.slice(-tailLength)}`,
      truncated: true,
    };
  }

  function buildUserMessageContent(prompt, attachments) {
    const parts = [];
    const trimmedPrompt = String(prompt || "").trim();
    if (trimmedPrompt) {
      parts.push(trimmedPrompt);
    }

    if (attachments.length > 0) {
      const blocks = attachments.map((attachment) => {
        const prefix = commentPrefixFor(attachment.language);
        const lines = ["```" + attachment.language, commentLine(prefix, attachment.name)];
        if (attachment.truncated) {
          lines.push(
            commentLine(
              prefix,
              `(잘림: 원문 ${formatNumber(attachment.originalChars)}자 중 ${formatNumber(attachment.content.length)}자 포함)`,
            ),
          );
        }
        lines.push(escapeFenceText(attachment.content), "```");
        return lines.join("\n");
      });
      parts.push(["첨부 파일:", ...blocks].join("\n\n"));
    }

    return parts.join("\n\n");
  }

  function escapeFenceText(content) {
    return String(content).replaceAll("```", "```\u200b");
  }

  function languageFromFileName(fileName) {
    const byName = {
      dockerfile: "dockerfile",
      makefile: "makefile",
      jenkinsfile: "groovy",
      procfile: "yaml",
      rakefile: "ruby",
      gemfile: "ruby",
      ".gitignore": "ini",
      ".dockerignore": "ini",
      ".env": "ini",
      ".editorconfig": "ini",
      ".gitattributes": "ini",
    };
    const named = byName[String(fileName || "").toLowerCase()];
    if (named) {
      return named;
    }
    const extension = extensionFromFileName(fileName);
    const aliases = {
      bash: "bash",
      cfg: "ini",
      conf: "ini",
      env: "ini",
      markdown: "md",
      yml: "yaml",
      zsh: "bash",
    };
    return aliases[extension] || extension || "text";
  }

  // 파일명 헤더용 언어별 주석 기호. 문자열이면 줄 주석, {open,close}면 블록 주석.
  function commentPrefixFor(language) {
    const map = {
      js: "//",
      jsx: "//",
      ts: "//",
      tsx: "//",
      sql: "--",
      groovy: "//",
      html: { open: "<!-- ", close: " -->" },
      xml: { open: "<!-- ", close: " -->" },
      css: { open: "/* ", close: " */" },
      json: { open: "/* ", close: " */" },
    };
    return map[language] || "#"; // py/sh/yaml/ini/bash 등 + 미지 언어는 '#'
  }

  function commentLine(prefix, text) {
    return typeof prefix === "string" ? `${prefix} ${text}` : `${prefix.open}${text}${prefix.close}`;
  }

  function extensionFromFileName(fileName) {
    const match = String(fileName || "").toLowerCase().match(/\.([^.]+)$/);
    return match ? match[1] : "";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat("ko-KR").format(value);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    // 응답 중이면 같은 버튼이 '중지'로 동작 → 진행 중 요청을 취소하고 종료.
    if (abortController) {
      abortController.abort();
      return;
    }
    const content = elements.prompt.value.trim();
    const attachmentsSnapshot = pendingAttachments.map((attachment) => ({ ...attachment }));
    const userContent = buildUserMessageContent(content, attachmentsSnapshot);
    if (!userContent) {
      return;
    }

    pendingPrompt = content;
    elements.prompt.value = "";
    clearPendingAttachments();
    resizePrompt();

    syncActiveConversationFromForm();
    const conversation = getActiveConversation();
    const conversationId = conversation.id;
    const selected = getActiveConfig();
    if (!conversation.manualTitle && getConversationMessages(conversation).length === 0) {
      conversation.title = makeTitle(content || attachmentsSnapshot.map((attachment) => attachment.name).join(" "));
      conversation.manualTitle = false;
    }
    const userMessage = { role: "user", content: userContent, createdAt: new Date().toISOString() };
    if (attachmentsSnapshot.length > 0) {
      // 메시지엔 ref만(id/name/type/size), 원본은 보관함(IndexedDB)에 비동기 저장.
      userMessage.attachments = attachmentsSnapshot.map((a) => ({ id: a.id, name: a.name, type: a.type, size: a.size }));
      storeAttachments(attachmentsSnapshot, conversationId);
    }
    conversation.messages.push(userMessage);
    conversation.summaryDismissed = false; // 새 활동이 생기면 요약 배너를 다시 평가
    conversation.updatedAt = new Date().toISOString();
    persistState();
    pendingQuestionAnchor = true; // 방금 보낸 질문을 상단에 고정해 답변이 그 아래로 흐르게
    renderAll();
    setBusy(true);
    const streaming = isStreamingEnabled();
    let streamUi = null;
    if (streaming) {
      streamUi = createStreamingNode(selected.label);
      elements.messages.appendChild(streamUi.wrapper);
      anchorLatestQuestion(); // 스트리밍 버블이 질문 아래에 붙도록 질문을 상단 고정 유지
      setStatus("응답 스트리밍 중…", "is-busy");
    } else {
      renderTyping();
    }

    abortController = new AbortController();
    let timedOut = false;
    let streamedText = "";
    // 스트리밍은 토큰이 도착할 때마다 타이머를 리셋해(무진행 한도) 느린 스트림을 죽이지 않는다.
    let timer = null;
    const armTimeout = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timedOut = true;
        abortController?.abort();
      }, SEND_TIMEOUT_MS);
    };
    armTimeout();

    // 스트리밍 중 증분 마크다운 렌더. 스트리밍 노드 재렌더로 쌓이는 ResizeObserver 는 매 렌더마다
    // base 이후를 해제해 누적을 막는다(#33 덕에 미종결 펜스도 코드로 안전하게 렌더됨).
    const observerBase = hscrollObservers.length;
    let streamRenderTimer = null;
    let lastStreamRender = 0;
    let reasoningChars = 0;
    const renderStreaming = () => {
      if (!streamUi) {
        return;
      }
      for (let i = hscrollObservers.length - 1; i >= observerBase; i -= 1) {
        hscrollObservers[i].disconnect();
        hscrollObservers.pop();
      }
      streamUi.bubble.innerHTML = "";
      if (streamedText.trim()) {
        renderMessageContent(streamUi.bubble, streamedText);
      } else if (reasoningChars > 0) {
        // 본문 전 추론 단계(reasoning 모델): '추론 중' 표시로 멈춘 게 아님을 알린다.
        const note = document.createElement("div");
        note.className = "reasoning-note";
        note.textContent = `추론 중… (${reasoningChars.toLocaleString()}자)`;
        streamUi.bubble.appendChild(note);
      }
      const caret = document.createElement("span");
      caret.className = "stream-caret";
      caret.setAttribute("aria-hidden", "true");
      streamUi.bubble.appendChild(caret);
      stickyAutoScroll(); // 바닥 근처일 때만 따라가 질문 고정을 깨지 않음
      updateScrollBottomButton(); // 위로 올려 읽는 중이면 '새 내용 ↓' 노출
    };

    try {
      // 토큰마다 전체 재파싱은 비싸므로 스로틀. 텍스트가 커질수록 간격을 늘려 O(n²) 재파싱 비용을 억제.
      const scheduleStreamRender = () => {
        if (!streamUi) {
          return;
        }
        const interval = streamedText.length > 32768 ? 400 : 120;
        const now = Date.now();
        const elapsed = now - lastStreamRender;
        if (elapsed >= interval) {
          lastStreamRender = now;
          renderStreaming();
        } else if (streamRenderTimer === null) {
          streamRenderTimer = window.setTimeout(() => {
            streamRenderTimer = null;
            lastStreamRender = Date.now();
            renderStreaming();
          }, interval - elapsed);
        }
      };
      const onDelta = (textSoFar) => {
        streamedText = textSoFar;
        armTimeout();
        scheduleStreamRender();
      };
      const onReasoning = (chars) => {
        reasoningChars = chars;
        armTimeout();
        if (streamUi && !streamedText.trim()) {
          setStatus(`추론 중… ${chars.toLocaleString()}자`, "is-busy");
          scheduleStreamRender();
        }
      };
      const answer = streaming
        ? await requestChatCompletionStream(selected, buildRequestMessages(conversation), abortController.signal, onDelta, armTimeout, onReasoning)
        : await requestChatCompletion(selected, buildRequestMessages(conversation), abortController.signal);
      const target = state.conversations.find((item) => item.id === conversationId) || conversation;
      target.messages.push({
        role: "assistant",
        content: answer.text,
        model: selected.model,
        modelLabel: selected.label,
        usage: answer.usage,
        createdAt: new Date().toISOString(),
      });
      target.updatedAt = new Date().toISOString();
      pendingPrompt = "";
      setStatus("완료", "");
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === "AbortError";
      const userAborted = isAbort && !timedOut;
      const target = state.conversations.find((item) => item.id === conversationId) || conversation;
      // 받은 부분 응답은 중단 원인과 무관하게 보존한다(타임아웃·네트워크 절단 포함).
      // 화면에 흐르던 텍스트가 오류와 함께 통째로 사라지는 유실을 막는다.
      const savePartial = () => {
        target.messages.push({
          role: "assistant",
          content: streamedText.trim(),
          model: selected.model,
          modelLabel: selected.label,
          createdAt: new Date().toISOString(),
        });
        target.updatedAt = new Date().toISOString();
        pendingPrompt = "";
      };
      if (userAborted && streamedText.trim()) {
        savePartial();
        setStatus("중지됨 — 받은 응답까지 저장", "");
      } else if (userAborted) {
        // 받은 내용 없는 사용자 중지: 질문을 대화에서 회수해 입력창으로 되돌린다.
        // 질문이 대화에 남은 채 입력창까지 복원하면 재전송 시 같은 질문이 중복 축적된다.
        if (target.messages[target.messages.length - 1] === userMessage) {
          target.messages.pop();
        }
        if (state.activeConversationId === conversationId) {
          elements.prompt.value = pendingPrompt;
          pendingAttachments = attachmentsSnapshot;
          renderAttachments();
          resizePrompt();
        }
        setStatus("중지됨", "");
      } else {
        const detail = isAbort
          ? `응답 지연 — ${Math.round(SEND_TIMEOUT_MS / 1000)}초 내 진행 없음`
          : error instanceof TypeError
            ? describeFetchFailure(selected.endpoint)
            : error instanceof Error
              ? error.message
              : String(error);
        const hadPartial = Boolean(streamedText.trim());
        if (hadPartial) {
          savePartial();
        }
        target.messages.push({
          role: "error",
          content: hadPartial
            ? `스트리밍 중단: ${detail} — 여기까지 수신된 응답을 위에 저장했습니다.`
            : `호출 실패: ${detail}`,
          createdAt: new Date().toISOString(),
        });
        target.updatedAt = new Date().toISOString();
        setStatus(isAbort ? "응답 지연 — 시간 초과" : "오류", "is-error");
      }
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      if (streamRenderTimer !== null) {
        window.clearTimeout(streamRenderTimer); // 대기 중인 증분 렌더가 제거된 노드를 건드리지 않게
        streamRenderTimer = null;
      }
      abortController = null;
      removeTyping();
      // 완료 시 강제로 질문을 상단 고정하면(기존 동작) 스트림을 따라 읽던 위치나 위로 올려
      // 과거를 보던 위치가 매번 초기화된다. 대신 완료 직전 상태를 보고 위치를 보존한다:
      // 바닥 근처(스트림 추종)면 새 바닥으로, 아니면(위에서 읽는 중) 스크롤 위치를 그대로 둔다.
      const wasNearBottom = isNearBottom();
      const prevScrollTop = elements.messages.scrollTop;
      const finishedStreamUi = streamUi;
      streamUi = null; // 이후 pending scheduleStreamRender 는 no-op
      finishedStreamUi?.wrapper.remove();
      setBusy(false);
      persistState();
      suppressAutoScroll = true; // renderMessages 의 자동 앵커/바닥 이동을 이번 1회 생략
      renderAll();
      if (wasNearBottom) {
        scrollToBottom();
      } else {
        elements.messages.scrollTop = prevScrollTop; // 읽던 위치 best-effort 보존
        updateScrollBottomButton();
      }
      elements.prompt.focus();
    }
  }

  // 스트리밍 중 토큰을 증분 '마크다운'으로 렌더할 임시 어시스턴트 노드. 완료 시 renderAll로 최종 렌더.
  function createStreamingNode(label) {
    const wrapper = document.createElement("article");
    wrapper.className = "message assistant streaming";
    wrapper.id = "streaming-message";

    const top = document.createElement("div");
    top.className = "message-top";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = label || "";
    top.appendChild(meta);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    // 첫 토큰 도착 전: 생성 중임을 알리는 캐럿만.
    const caret = document.createElement("span");
    caret.className = "stream-caret";
    caret.setAttribute("aria-hidden", "true");
    bubble.appendChild(caret);

    wrapper.append(top, bubble);
    return { wrapper, bubble };
  }

  async function requestChatCompletion(modelConfig, chatMessages, signal) {
    const response = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: buildHeaders(modelConfig),
      signal,
      body: JSON.stringify({
        model: modelConfig.model,
        messages: chatMessages,
        stream: false,
        ...generationParams(modelConfig),
      }),
    });

    const rawText = await response.text();
    let payload = {};
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_error) {
      throw new Error(`HTTP ${response.status}: JSON 응답이 아닙니다. ${rawText.slice(0, 240)}`);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${extractErrorMessage(payload)}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("choices[0].message.content가 비어 있습니다.");
    }
    updateUsage(payload.usage);
    return {
      text: content.trim(),
      usage: payload.usage || null,
    };
  }

  // SSE 스트리밍 전송. 서버가 event-stream을 주면 토큰 단위로 onDelta(누적 텍스트)를 호출하고,
  // 아니면(프록시 버퍼링/미지원) 일반 JSON 응답으로 자동 폴백한다.
  async function requestChatCompletionStream(modelConfig, chatMessages, signal, onDelta, onActivity, onReasoning) {
    const response = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: buildHeaders(modelConfig),
      signal,
      body: JSON.stringify({
        model: modelConfig.model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        ...generationParams(modelConfig),
      }),
    });

    const contentType = response.headers.get("Content-Type") || "";
    if (!response.ok) {
      const rawText = await response.text();
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (_error) {
        // JSON 아님 → 아래에서 상태코드로 처리
      }
      // 일부 구서버(구 llama.cpp·FastChat 등)는 stream:true 를 4xx/501 로 거부한다 → 비스트리밍으로 1회 재시도.
      // 인증(401/403)·rate limit(429)·서버 오류(500)는 stream 무관하므로 재시도하지 않는다.
      if ([400, 404, 405, 422, 501].includes(response.status)) {
        const result = await requestChatCompletion(modelConfig, chatMessages, signal);
        if (typeof onDelta === "function") {
          onDelta(result.text);
        }
        return result;
      }
      throw new Error(`HTTP ${response.status}: ${extractErrorMessage(payload) || rawText.slice(0, 240)}`);
    }
    if (!contentType.includes("text/event-stream") || !response.body) {
      // ok 지만 SSE 가 아님(프록시 버퍼링/미지원) → 비스트리밍 응답으로 처리(전체 본문 한 번에).
      const rawText = await response.text();
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch (_error) {
        throw new Error(`HTTP ${response.status}: JSON 응답이 아닙니다. ${rawText.slice(0, 240)}`);
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim() === "") {
        throw new Error("choices[0].message.content가 비어 있습니다.");
      }
      if (typeof onDelta === "function") {
        onDelta(content);
      }
      updateUsage(payload.usage);
      return { text: content.trim(), usage: payload.usage || null };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let reasoningChars = 0;
    let usage = null;
    let done = false;
    // 한 SSE 이벤트(빈 줄로 구분)의 data: 라인들을 처리. [DONE] 만나면 true 반환.
    const applyEvent = (rawEvent) => {
      for (const line of rawEvent.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) {
          continue;
        }
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          return true;
        }
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch (_error) {
          continue;
        }
        const delta = chunk?.choices?.[0]?.delta;
        const content = delta?.content;
        if (typeof content === "string" && content) {
          text += content;
          if (typeof onDelta === "function") {
            onDelta(text);
          }
        }
        // 추론(reasoning) 모델(DeepSeek-R1 계열 등): 본문 전에 reasoning_content 만 수 분간 흐른다.
        // 최종 답변에는 포함하지 않되, 진행 표시로 사용자에게 '추론 중'을 알린다(무진행 타임아웃 방지는 onActivity 담당).
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          reasoningChars += reasoning.length;
          if (typeof onReasoning === "function") {
            onReasoning(reasoningChars);
          }
        }
        if (chunk?.usage) {
          usage = chunk.usage;
        }
      }
      return false;
    };

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        // content 유무와 무관하게 바이트 수신 자체를 진행으로 간주(keep-alive·role·usage·reasoning 청크).
        if (typeof onActivity === "function") {
          onActivity();
        }
        if (streamDone) {
          break;
        }
        // SSE 표준이 허용하는 CRLF 개행(Java/Spring계 게이트웨이)을 LF로 정규화해 이벤트 경계(\n\n)를 찾는다.
        // 청크가 \r로 끝나 \r\n이 갈라져도 다음 청크가 붙은 뒤 다시 정규화되므로 안전하다.
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          if (applyEvent(rawEvent)) {
            done = true;
            break;
          }
        }
      }
      // 마지막 \n\n 없이 스트림이 끝나면 남은 버퍼(+디코더 flush)를 한 번 더 처리해 마지막 토큰 유실 방지.
      if (!done) {
        buffer = (buffer + decoder.decode()).replace(/\r\n/g, "\n");
        if (buffer.trim()) {
          applyEvent(buffer);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch (_error) {
        // releaseLock 실패는 무시(이미 종료/취소).
      }
    }

    if (text.trim() === "") {
      throw new Error("스트리밍 응답에서 본문을 받지 못했습니다.");
    }
    updateUsage(usage);
    return { text: text.trim(), usage: usage || null };
  }

  function extractErrorMessage(payload) {
    const error = payload?.error;
    if (typeof error === "string") {
      return error;
    }
    if (error && typeof error.message === "string") {
      return error.message;
    }
    return JSON.stringify(payload).slice(0, 240);
  }

  // fetch 가 TypeError 로 실패했을 때 원인을 최대한 구체적으로 안내(브라우저는 원인을 숨기므로 사전 판별).
  function describeFetchFailure(endpoint) {
    let url;
    try {
      url = new URL(endpoint, window.location.href);
    } catch (_error) {
      return "endpoint URL 형식 오류 — http://호스트:포트/v1/chat/completions 형태인지 확인하세요";
    }
    if (window.location.protocol === "https:" && url.protocol === "http:") {
      return "mixed content 차단 — https 페이지에서 http endpoint 는 호출할 수 없습니다. file:// 로 열거나 endpoint 를 https 로 하세요";
    }
    return "네트워크 오류 — endpoint 미기동·방화벽 또는 CORS(OPTIONS 200/204, Access-Control-Allow-Origin) 설정을 확인하세요";
  }

  function buildSystemPrompt() {
    // 지침(시스템 프롬프트)은 활성 메모리 프로파일의 instructions에서 가져온다(메모리 토글과 무관, 항상 적용).
    const profile = getActiveMemoryProfile();
    return String((profile && profile.instructions) || "").trim();
  }

  function buildSystemMessages(conversation = getActiveConversation()) {
    const systemPrompt = buildSystemPrompt(conversation);
    return systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  }

  // 개인 메모리(활성 프로파일 + 대화별 메모)를 하나의 [메모리] 블록 텍스트로. 토글이 꺼져 있으면 빈 문자열.
  function buildMemoryText(conversation = getActiveConversation()) {
    if (conversation.memoryOn === false) {
      return "";
    }
    const parts = [];
    const profile = getActiveMemoryProfile();
    const profileText = profile ? String(profile.text || "").trim() : "";
    const conversationText = String(conversation.memory || "").trim();
    if (profileText) {
      parts.push(profileText);
    }
    if (conversationText) {
      parts.push(conversationText);
    }
    return parts.length ? `[메모리]\n${parts.join("\n\n")}` : "";
  }

  function buildMemoryMessages(conversation = getActiveConversation()) {
    const text = buildMemoryText(conversation);
    return text ? [{ role: "system", content: text }] : [];
  }

  // 예산 계산용: 시스템 프롬프트 + 메모리를 합친 '고정 머리말' 텍스트(문자 수 산정에만 사용).
  function systemBudgetTextFor(conversation = getActiveConversation()) {
    return [buildSystemPrompt(conversation), buildMemoryText(conversation)].filter(Boolean).join("\n\n");
  }

  function buildHeaders(modelConfig) {
    const headers = { "Content-Type": "application/json" };
    // 기본적으로 인증 헤더를 보내지 않는다. 모델에 API key 가 설정된 경우에만 Bearer 로 전송.
    const key = modelConfig && typeof modelConfig.apiKey === "string" ? modelConfig.apiKey.trim() : "";
    if (key) {
      headers.Authorization = /\s/.test(key) ? key : `Bearer ${key}`;
    }
    return headers;
  }

  function getConversationMessages(conversation = getActiveConversation()) {
    return conversation.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => ({ role: message.role, content: message.content }));
  }

  function getMessagesForRequest(conversation = getActiveConversation()) {
    return requestSelection(conversation).messages;
  }

  function buildRequestMessages(conversation = getActiveConversation()) {
    return [
      ...buildSystemMessages(conversation),
      ...buildMemoryMessages(conversation),
      ...getMessagesForRequest(conversation),
    ];
  }

  function getContextStats(conversation = getActiveConversation()) {
    return requestSelection(conversation);
  }

  function conversationContextChars(conversation) {
    const modelId = coerceModelId(conversation.selectedModelId);
    const settings = conversation.modelSettings[modelId] || {};
    const trimmed = String(settings.contextChars || "").trim();
    const value = Number(trimmed);
    // 우선순위: 사용자 입력값 → 모델 프리셋 contextChars → 전역 기본 예산.
    if (trimmed !== "" && Number.isFinite(value) && value > 0) {
      return Math.trunc(value);
    }
    const presetChars = Number(getPreset(modelId).contextChars);
    return Number.isFinite(presetChars) && presetChars > 0 ? Math.trunc(presetChars) : MAX_REQUEST_CONTEXT_CHARS;
  }

  // 전송할 메시지 선택 + 통계. includeHistory=false면 최신 user 1건만(단발), 아니면 예산 트림.
  function requestSelection(conversation = getActiveConversation()) {
    const messages = getConversationMessages(conversation);
    const systemBudgetText = systemBudgetTextFor(conversation);
    const budget = conversationContextChars(conversation);
    if (conversation.includeHistory === false) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const sent = lastUser ? [lastUser] : messages.slice(-1);
      const systemChars = systemBudgetText ? estimateMessageChars({ role: "system", content: systemBudgetText }) : 0;
      const approximateChars = sent.reduce((sum, message) => sum + estimateMessageChars(message), 0) + systemChars;
      return { messages: sent, included: sent.length, total: messages.length, approximateChars, limit: budget };
    }
    return trimMessagesForRequest(messages, systemBudgetText, budget);
  }

  function trimMessagesForRequest(conversationMessages, systemPrompt, contextChars) {
    const totalBudget = contextChars && contextChars > 0 ? contextChars : MAX_REQUEST_CONTEXT_CHARS;
    const systemChars = systemPrompt ? estimateMessageChars({ role: "system", content: systemPrompt }) : 0;
    const budget = Math.max(MIN_CONTEXT_CHARS, totalBudget - systemChars);
    const selected = [];
    let used = 0;

    for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
      const message = conversationMessages[index];
      const size = estimateMessageChars(message);
      // 최신 메시지는 항상 유지하고, 이후 첫 초과에서 종료 → 연속 구간 보장(중간 구멍 방지).
      if (selected.length === 0) {
        selected.push(message);
        used += size;
        continue;
      }
      if (used + size > budget) {
        break;
      }
      selected.push(message);
      used += size;
    }

    return {
      messages: selected.reverse(),
      included: selected.length,
      total: conversationMessages.length,
      approximateChars: used + systemChars,
      limit: Math.max(MIN_CONTEXT_CHARS, totalBudget),
    };
  }

  function estimateMessageChars(message) {
    return String(message.role || "").length + String(message.content || "").length + 32;
  }

  // 생성 파라미터: 빈 값은 키를 생략해 서버 기본값을 유지한다.
  function generationParams(config) {
    const params = {};
    const num = (value) => {
      const trimmed = String(value || "").trim();
      if (trimmed === "") {
        return null;
      }
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const temperature = num(config.temperature);
    if (temperature !== null) {
      params.temperature = temperature;
    }
    const maxTokens = num(config.maxTokens);
    if (maxTokens !== null) {
      params.max_tokens = Math.trunc(maxTokens);
    }
    const topP = num(config.topP);
    if (topP !== null) {
      params.top_p = topP;
    }
    return params;
  }

  async function checkConnection() {
    syncActiveConversationFromForm();
    persistState();
    const selected = getActiveConfig();
    const probeMessages = [
      ...buildSystemMessages(getActiveConversation()),
      { role: "user", content: "ok라고만 답해줘." },
    ];
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    elements.checkConnection.disabled = true;
    setStatus("확인 중", "is-busy");

    try {
      const response = await fetch(selected.endpoint, {
        method: "POST",
        headers: buildHeaders(selected),
        signal: controller.signal,
        body: JSON.stringify({
          model: selected.model,
          messages: probeMessages,
          stream: false,
          ...generationParams(selected),
        }),
      });
      const rawText = await response.text();
      const payload = rawText ? safeJson(rawText) : {};
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${extractErrorMessage(payload || {})}`);
      }
      setStatus(`연결됨 HTTP ${response.status}`, "");
    } catch (error) {
      const detail =
        error instanceof DOMException && error.name === "AbortError"
          ? "15초 안에 응답이 없습니다."
          : error instanceof TypeError
            ? "네트워크 오류 — CORS(Origin null 허용) 또는 endpoint 접근을 확인하세요"
            : error instanceof Error
              ? error.message
              : String(error);
      setStatus(`연결 실패: ${detail}`, "is-error");
    } finally {
      window.clearTimeout(timeout);
      elements.checkConnection.disabled = false;
    }
  }

  function setBusy(isBusy) {
    // 단일 버튼: 유휴=전송(submit), 응답 중=중지(같은 버튼 클릭이 abort 트리거).
    elements.send.classList.toggle("is-stopping", isBusy);
    elements.send.setAttribute("aria-label", isBusy ? "중지" : "전송");
    if (elements.sendLabel) {
      elements.sendLabel.textContent = isBusy ? "중지" : "전송";
    }
    elements.prompt.disabled = isBusy;
    elements.newChat.disabled = isBusy;
    if (elements.importChat) {
      elements.importChat.disabled = isBusy;
    }
    if (elements.clearAll) {
      elements.clearAll.disabled = isBusy;
    }
    elements.checkConnection.disabled = isBusy;
    elements.attachFile.disabled = isBusy;
    elements.summaryRun.disabled = isBusy;
    elements.clearAttachments.disabled = isBusy || pendingAttachments.length === 0;
    if (isBusy) {
      setStatus("호출 중", "is-busy");
    }
  }

  // 다른 탭과의 충돌이 감지되면(staleTab) 이 탭의 저장이 계속 막히므로, 일반 성공 메시지가
  // 경고를 덮어 사용자가 '저장된 줄' 오인하는 것을 막는다. 경고는 새로고침 전까지 유지된다.
  let staleTab = false;
  const STALE_TAB_MESSAGE = "다른 탭에서 대화가 변경됨 — 이 탭의 저장이 중단되었습니다. 새로고침하세요.";

  function setStatus(text, className) {
    // staleTab 상태에서 오류가 아닌(성공/중립) 상태 갱신은 무시하고 경고를 유지한다.
    if (staleTab && className !== "is-error") {
      text = STALE_TAB_MESSAGE;
      className = "is-error";
    }
    elements.connectionState.className = `connection-state ${className || ""}`.trim();
    elements.connectionState.textContent = text;
    elements.connectionState.title = text; // 말줄임된 긴 오류도 hover로 전체 확인
  }

  let lastUsage = null;
  function updateUsage(usage) {
    lastUsage = usage || null;
    if (elements.usageState) {
      elements.usageState.textContent = usage
        ? `tokens ${usage.prompt_tokens ?? "-"}/${usage.completion_tokens ?? "-"}/${usage.total_tokens ?? "-"}`
        : "tokens -";
    }
  }

  function resizePrompt() {
    elements.prompt.style.height = "auto";
    // 최소/최대는 CSS(min-height/max-height)에서 읽는다 — 인라인 상수로 고정하면 미디어쿼리
    // (좁은 폭·낮은 화면)의 축소 값이 입력 이벤트마다 무효화된다.
    const cs = window.getComputedStyle(elements.prompt);
    const min = parseFloat(cs.minHeight) || 110;
    const max = parseFloat(cs.maxHeight) || 300;
    elements.prompt.style.height = `${Math.min(Math.max(elements.prompt.scrollHeight, min), max)}px`;
  }

  function scrollToBottom() {
    // content-visibility:auto 는 바닥 근처 메시지를 스크롤이 도달할 때 실제 높이로 렌더하므로,
    // 한 번 jump 하면 scrollHeight 가 커지며 바닥이 밀린다. scrollHeight 가 안정될 때까지(또는
    // 상한 iterations 까지) rAF 로 재고정해 코드블록/표가 많은 긴 대화에서도 정확히 바닥에 붙는다.
    const el = elements.messages;
    let prevHeight = -1;
    let iterations = 0;
    const jump = () => {
      el.scrollTop = el.scrollHeight;
      iterations += 1;
      if (iterations < 12 && el.scrollHeight !== prevHeight) {
        prevHeight = el.scrollHeight;
        window.requestAnimationFrame(jump);
      } else {
        updateScrollBottomButton();
      }
    };
    jump();
    updateScrollBottomButton();
  }

  // 새 질문을 보낼 때는 바닥이 아니라 최신 질문을 컨테이너 상단에 고정해, 질문이 위에
  // 보이고 그 아래로 답변이 시작되도록 한다(질문이 화면 밖으로 밀리는 문제 방지).
  // scrollToBottom과 같은 이유로 rAF + setTimeout으로 reflow 후 재고정한다.
  function anchorLatestQuestion() {
    const list = elements.messages.querySelectorAll(".message.user");
    const q = list[list.length - 1];
    if (!q) {
      scrollToBottom();
      return;
    }
    const apply = () => {
      elements.messages.scrollTop = Math.max(0, q.offsetTop - 16);
    };
    apply();
    window.requestAnimationFrame(() => {
      apply();
      window.setTimeout(() => {
        apply();
        updateScrollBottomButton();
      }, 0);
    });
    updateScrollBottomButton();
  }

  // 사용자가 이미 바닥 근처에 있을 때만 따라간다. 질문을 상단 고정한 직후엔 바닥과
  // 멀어 자동 스크롤이 일어나지 않으므로 짧은 답변은 질문이 그대로 보인다. 긴 답변을
  // 바닥까지 내려 따라 읽는 중이면 새 토큰을 계속 따라간다.
  function isNearBottom(threshold = 96) {
    const el = elements.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function stickyAutoScroll() {
    if (isNearBottom()) {
      scrollToBottom();
    }
  }

  // 바닥에서 멀어졌을 때만 '맨 아래로' 버튼을 노출. 스트리밍 중이면 '새 내용 ↓'로 강조한다.
  function updateScrollBottomButton() {
    if (!elements.scrollBottom) {
      return;
    }
    const near = isNearBottom();
    elements.scrollBottom.hidden = near;
    const streaming = Boolean(document.getElementById("streaming-message"));
    elements.scrollBottom.classList.toggle("has-new", streaming && !near);
    if (elements.scrollBottomLabel) {
      elements.scrollBottomLabel.textContent = streaming && !near ? "새 내용" : "";
    }
  }

  function bindEvents() {
    // 스크롤 위치에 따라 '맨 아래로' 버튼 노출을 갱신(passive: 스크롤 성능 영향 없음).
    elements.messages.addEventListener("scroll", updateScrollBottomButton, { passive: true });
    if (elements.scrollBottom) {
      elements.scrollBottom.addEventListener("click", () => {
        scrollToBottom();
        elements.prompt.focus();
      });
    }

    elements.messages.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-kind]");
      if (!button) {
        return;
      }
      const ok = await copyText(button._copyText || "");
      if (ok) {
        flashCopyState(button);
      } else {
        setStatus("복사 실패 — 직접 선택해 복사하세요", "is-error");
      }
    });

    elements.conversationList.addEventListener("click", (event) => {
      const folderToggle = event.target.closest("[data-folder-toggle]");
      if (folderToggle) {
        toggleFolderCollapsed(folderToggle.dataset.folderToggle);
        return;
      }
      const folderMenuBtn = event.target.closest("[data-menu-folder]");
      if (folderMenuBtn) {
        event.stopPropagation();
        openFolderMenu(folderMenuBtn, folderMenuBtn.dataset.menuFolder);
        return;
      }
      const menuBtn = event.target.closest("[data-menu-conversation]");
      if (menuBtn) {
        event.stopPropagation();
        openConversationMenu(menuBtn, menuBtn.dataset.menuConversation);
        return;
      }
      const option = event.target.closest(".conversation-item");
      if (!option || abortController) {
        return;
      }
      clearPendingAttachments();
      selectConversation(option.dataset.conversationId);
      closeDrawer();
    });

    // 대화 이름 수정: 목록 항목 더블클릭(또는 ⋯ 메뉴 > 이름 바꾸기).
    elements.conversationList.addEventListener("dblclick", (event) => {
      const main = event.target.closest(".conversation-item-main");
      if (main) {
        renameConversation(main.dataset.conversationId);
      }
    });

    elements.newChat.addEventListener("click", () => {
      if (abortController) {
        return;
      }
      syncActiveConversationFromForm();
      const conversation = createConversation();
      state.conversations.unshift(conversation);
      state.activeConversationId = conversation.id;
      clearPendingAttachments();
      persistState();
      renderAll();
      updateUsage(null);
      setStatus("새 대화", "");
      closeDrawer();
      elements.prompt.focus();
    });

    if (elements.addFolder) {
      elements.addFolder.addEventListener("click", createFolder);
    }

    if (elements.chatTitleInput) {
      elements.chatTitleInput.addEventListener("input", () => {
        const conversation = getActiveConversation();
        conversation.title = normalizeTitle(elements.chatTitleInput.value) || "새 대화";
        conversation.manualTitle = true;
        conversation.updatedAt = new Date().toISOString();
        elements.activeChatTitle.textContent = conversation.title;
        saveStateLater();
        renderConversationList();
      });
    }

    elements.modelList.addEventListener("click", (event) => {
      const menuBtn = event.target.closest(".model-menu-btn");
      if (menuBtn) {
        openModelModal(menuBtn.dataset.modelEdit);
        return;
      }
      const option = event.target.closest(".model-option");
      if (!option) {
        return;
      }
      syncActiveConversationFromForm();
      const conversation = getActiveConversation();
      conversation.selectedModelId = coerceModelId(option.dataset.modelId);
      renderModelList();
      renderModelSettings();
      renderContextCount();
      saveState();
      setStatus("준비됨", "");
    });

    elements.sidebarToggle.addEventListener("click", () => {
      const collapsed = !document.body.classList.contains("sidebar-collapsed");
      setSidebarCollapsed(collapsed);
    });

    // 좁은 폭 드로어: 햄버거로 열고, backdrop/Esc로 닫는다.
    if (elements.chatMenu) {
      elements.chatMenu.addEventListener("click", toggleDrawer);
    }
    if (elements.sidebarBackdrop) {
      elements.sidebarBackdrop.addEventListener("click", closeDrawer);
    }
    document.addEventListener("keydown", (event) => {
      // Ctrl/Cmd+K: 새 대화
      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        elements.newChat.click();
        return;
      }
      // ?: 단축키 도움말 (입력 중이 아닐 때)
      if (event.key === "?" && !isTypingTarget(event.target)) {
        event.preventDefault();
        openShortcuts();
        return;
      }
      if (event.key === "Escape") {
        if (document.getElementById("donut-card")) {
          hideDonutCard();
          return;
        }
        if (document.getElementById("conversation-menu")) {
          closeConversationMenu();
          return;
        }
        if (elements.headerMenu && !elements.headerMenu.hidden) {
          closeHeaderMenu();
          return;
        }
        if (elements.libraryModal && !elements.libraryModal.hidden) {
          closeLibrary();
          return;
        }
        if (elements.renameModal && !elements.renameModal.hidden) {
          closeRename();
          return;
        }
        if (elements.memoryModal && !elements.memoryModal.hidden) {
          closeMemory();
          return;
        }
        if (elements.modelModal && !elements.modelModal.hidden) {
          closeModelModal();
          return;
        }
        if (elements.shortcutsModal && !elements.shortcutsModal.hidden) {
          closeShortcuts();
          return;
        }
        if (document.body.classList.contains("sidebar-drawer-open")) {
          closeDrawer();
          return;
        }
        if (document.activeElement === elements.prompt && elements.prompt.value) {
          elements.prompt.value = "";
          resizePrompt();
        }
      }
    });

    if (elements.conversationSearch) {
      elements.conversationSearch.addEventListener("input", () => {
        conversationQuery = elements.conversationSearch.value;
        renderConversationList();
      });
    }
    if (elements.shortcutsHelp) {
      elements.shortcutsHelp.addEventListener("click", openShortcuts);
    }
    if (elements.shortcutsClose) {
      elements.shortcutsClose.addEventListener("click", closeShortcuts);
    }
    if (elements.shortcutsModal) {
      elements.shortcutsModal.addEventListener("click", (event) => {
        if (event.target === elements.shortcutsModal) {
          closeShortcuts();
        }
      });
    }

    // 디바운스 저장 대기 중 탭이 닫히거나 숨겨지면 즉시 flush(마지막 입력 보존).
    window.addEventListener("pagehide", flushPendingSave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flushPendingSave();
      }
    });

    elements.includeHistory.addEventListener("change", () => {
      saveState();
      renderContextCount();
    });
    elements.streamToggle.addEventListener("change", () => {
      state.streaming = elements.streamToggle.checked;
      persistState();
    });

    // ── 모델 추가/수정/삭제(영구) ──
    if (elements.addModel) {
      elements.addModel.addEventListener("click", addModel);
    }
    if (elements.modelClose) {
      elements.modelClose.addEventListener("click", closeModelModal);
    }
    if (elements.modelModal) {
      elements.modelModal.addEventListener("click", (event) => {
        if (event.target === elements.modelModal) {
          closeModelModal();
        }
      });
    }
    if (elements.modelLabelInput) {
      elements.modelLabelInput.addEventListener("input", () => {
        const model = currentEditingModel();
        if (model) {
          model.label = elements.modelLabelInput.value.trim() || model.id;
          renderModelList();
          saveStateLater();
        }
      });
    }
    if (elements.modelEndpointInput) {
      elements.modelEndpointInput.addEventListener("input", () => {
        const model = currentEditingModel();
        if (model) {
          model.endpoint = elements.modelEndpointInput.value.trim();
          saveStateLater();
        }
      });
    }
    if (elements.modelBodyInput) {
      elements.modelBodyInput.addEventListener("input", () => {
        const model = currentEditingModel();
        if (model) {
          model.model = elements.modelBodyInput.value.trim();
          saveStateLater();
        }
      });
    }
    if (elements.modelApiKeyInput) {
      elements.modelApiKeyInput.addEventListener("input", () => {
        const model = currentEditingModel();
        if (model) {
          model.apiKey = elements.modelApiKeyInput.value;
          saveStateLater();
        }
      });
    }
    if (elements.modelDelete) {
      elements.modelDelete.addEventListener("click", deleteCurrentModel);
    }

    // ── 개인 메모리 이벤트 ──
    if (elements.memorySelect) {
      elements.memorySelect.addEventListener("change", () => setActiveMemoryProfile(elements.memorySelect.value));
    }
    if (elements.memoryEdit) {
      elements.memoryEdit.addEventListener("click", openMemory);
    }
    if (elements.memoryToggle) {
      elements.memoryToggle.addEventListener("click", () => setMemoryOn(getActiveConversation().memoryOn === false));
    }
    if (elements.memoryOn) {
      elements.memoryOn.addEventListener("change", () => setMemoryOn(elements.memoryOn.checked));
    }
    if (elements.memoryClose) {
      elements.memoryClose.addEventListener("click", closeMemory);
    }
    if (elements.memoryModal) {
      elements.memoryModal.addEventListener("click", (event) => {
        if (event.target === elements.memoryModal) {
          closeMemory();
        }
      });
    }
    if (elements.memoryProfileSelect) {
      elements.memoryProfileSelect.addEventListener("change", () =>
        setActiveMemoryProfile(elements.memoryProfileSelect.value),
      );
    }
    if (elements.memoryProfileLabel) {
      elements.memoryProfileLabel.addEventListener("input", () => {
        const profile = getActiveMemoryProfile();
        if (profile) {
          profile.label = elements.memoryProfileLabel.value.trim() || "메모리";
          renderMemorySelect();
          fillMemoryProfileOptions(elements.memoryProfileSelect);
          saveStateLater();
        }
      });
    }
    if (elements.memoryInstructions) {
      elements.memoryInstructions.addEventListener("input", () => {
        const profile = getActiveMemoryProfile();
        if (profile) {
          profile.instructions = elements.memoryInstructions.value;
          renderContextCount();
          saveStateLater();
        }
      });
    }
    if (elements.memoryProfileText) {
      elements.memoryProfileText.addEventListener("input", () => {
        const profile = getActiveMemoryProfile();
        if (profile) {
          profile.text = elements.memoryProfileText.value;
          renderContextCount();
          saveStateLater();
        }
      });
    }
    if (elements.memoryConversation) {
      elements.memoryConversation.addEventListener("input", () => {
        getActiveConversation().memory = elements.memoryConversation.value;
        renderContextCount();
        saveStateLater();
      });
    }
    if (elements.memoryAddProfile) {
      elements.memoryAddProfile.addEventListener("click", addMemoryProfile);
    }
    if (elements.memoryDeleteProfile) {
      elements.memoryDeleteProfile.addEventListener("click", deleteMemoryProfile);
    }
    if (elements.memoryExport) {
      elements.memoryExport.addEventListener("click", exportMemory);
    }
    if (elements.memoryImport && elements.memoryImportInput) {
      elements.memoryImport.addEventListener("click", () => elements.memoryImportInput.click());
      elements.memoryImportInput.addEventListener("change", async () => {
        const fileList = Array.from(elements.memoryImportInput.files || []);
        if (!fileList.length) {
          return;
        }
        try {
          const files = await Promise.all(
            fileList.map(async (file) => ({
              label: file.name.replace(/\.(md|markdown|txt)$/i, ""),
              text: await file.text(),
            })),
          );
          importMemoryFiles(files);
          setStatus(`메모리 ${files.length}개 프로파일을 가져왔습니다.`, "is-ok");
        } catch (_error) {
          setStatus("메모리 가져오기 실패 — 파일을 확인하세요.", "is-error");
        }
        elements.memoryImportInput.value = "";
      });
    }

    elements.checkConnection.addEventListener("click", checkConnection);

    elements.copyCurl.addEventListener("click", async () => {
      const ok = await copyText(buildCurlCommand());
      if (ok) {
        flashCopyState(elements.copyCurl);
      } else {
        setStatus("복사 실패 — 직접 선택해 복사하세요", "is-error");
      }
    });

    elements.copyMarkdown.addEventListener("click", async () => {
      const ok = await copyText(buildConversationMarkdown());
      if (ok) {
        flashCopyState(elements.copyMarkdown);
      } else {
        setStatus("복사 실패 — 직접 선택해 복사하세요", "is-error");
      }
    });

    if (elements.saveChat) {
      elements.saveChat.addEventListener("click", exportConversation);
    }
    if (elements.importChat) {
      elements.importChat.addEventListener("click", importConversation);
    }
    if (elements.importFile) {
      elements.importFile.addEventListener("change", async () => {
        const file = elements.importFile.files?.[0];
        if (!file) {
          return;
        }
        await importConversationFile(file);
        elements.importFile.value = "";
      });
    }

    // 다른 탭이 상태를 저장하면 이 탭의 메모리 state는 낡은 스냅샷 — 즉시 경고(다중 탭 보수적 방어).
    window.addEventListener("storage", (event) => {
      if (event.key === APP_STORAGE_KEY || event.key === APP_STORAGE_REV_KEY) {
        setStatus("다른 탭에서 대화가 변경되었습니다 — 새로고침으로 동기화하세요.", "is-error");
      }
    });

    elements.attachFile.addEventListener("click", () => {
      elements.fileInput.click();
    });

    elements.fileInput.addEventListener("change", async () => {
      await addTextAttachments(elements.fileInput.files);
      elements.fileInput.value = "";
    });

    // 드래그앤드롭으로 파일 첨부
    elements.composer.addEventListener("dragover", (event) => {
      if (abortController) {
        return;
      }
      if (Array.from(event.dataTransfer?.types || []).includes("Files")) {
        event.preventDefault();
        elements.composer.classList.add("drag-over");
      }
    });
    elements.composer.addEventListener("dragleave", (event) => {
      // composer 밖으로 나갈 때만(자식으로의 이동 제외) 하이라이트 제거
      if (!event.relatedTarget || !elements.composer.contains(event.relatedTarget)) {
        elements.composer.classList.remove("drag-over");
      }
    });
    elements.composer.addEventListener("dragend", () => {
      elements.composer.classList.remove("drag-over");
    });
    elements.composer.addEventListener("drop", async (event) => {
      if (abortController) {
        elements.composer.classList.remove("drag-over");
        return;
      }
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) {
        return;
      }
      event.preventDefault();
      elements.composer.classList.remove("drag-over");
      await addTextAttachments(files);
    });

    // 클립보드 파일 붙여넣기로 첨부(파일이 없으면 기본 텍스트 입력 유지)
    elements.prompt.addEventListener("paste", async (event) => {
      if (abortController) {
        return;
      }
      const files = event.clipboardData?.files;
      if (files && files.length > 0) {
        event.preventDefault();
        await addTextAttachments(files);
      }
    });

    elements.attachmentList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-attachment-id]");
      if (!button) {
        return;
      }
      pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== button.dataset.attachmentId);
      renderAttachments();
    });

    elements.clearAttachments.addEventListener("click", clearPendingAttachments);

    // 우측 상단 ⋯ 도구 메뉴(팝업): 단축키/연결확인/cURL/대화복사
    if (elements.headerMenuBtn && elements.headerMenu) {
      elements.headerMenuBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const willOpen = elements.headerMenu.hidden;
        elements.headerMenu.hidden = !willOpen;
        elements.headerMenuBtn.setAttribute("aria-expanded", String(willOpen));
        if (willOpen) {
          setTimeout(() => document.addEventListener("click", headerMenuOutside, true), 0);
        } else {
          document.removeEventListener("click", headerMenuOutside, true);
        }
      });
      // 항목 클릭 시(핸들러 실행 후) 메뉴 닫기
      elements.headerMenu.addEventListener("click", () => closeHeaderMenu());
    }

    if (elements.clearAll) {
      elements.clearAll.addEventListener("click", clearAllConversations);
    }

    if (elements.renameConfirm) {
      elements.renameConfirm.addEventListener("click", confirmRename);
    }
    if (elements.renameCancel) {
      elements.renameCancel.addEventListener("click", closeRename);
    }
    if (elements.renameClose) {
      elements.renameClose.addEventListener("click", closeRename);
    }
    if (elements.renameInput) {
      elements.renameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          confirmRename();
        }
      });
    }
    if (elements.renameModal) {
      elements.renameModal.addEventListener("click", (event) => {
        if (event.target === elements.renameModal) {
          closeRename();
        }
      });
    }

    if (elements.contextState) {
      elements.contextState.addEventListener("mouseenter", showDonutCard);
      elements.contextState.addEventListener("mouseleave", scheduleHideDonutCard);
      elements.contextState.addEventListener("focus", showDonutCard);
      elements.contextState.addEventListener("blur", scheduleHideDonutCard);
      elements.contextState.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showDonutCard();
        }
      });
    }
    if (elements.attachLibrary) {
      elements.attachLibrary.addEventListener("click", () => {
        closeHeaderMenu();
        openLibrary();
      });
    }
    if (elements.libraryClose) {
      elements.libraryClose.addEventListener("click", closeLibrary);
    }
    if (elements.librarySearch) {
      elements.librarySearch.addEventListener("input", () => renderLibrary(elements.librarySearch.value));
    }
    if (elements.libraryModal) {
      elements.libraryModal.addEventListener("click", (event) => {
        if (event.target === elements.libraryModal) {
          closeLibrary();
        }
      });
    }

    elements.summaryRun.addEventListener("click", summarizeConversation);
    elements.summaryDismiss.addEventListener("click", () => {
      getActiveConversation().summaryDismissed = true;
      persistState();
      renderSummaryBanner();
    });

    elements.composer.addEventListener("submit", handleSubmit);

    elements.prompt.addEventListener("input", resizePrompt);
    elements.prompt.addEventListener("keydown", (event) => {
      // event.isComposing: 한글 IME 조합 확정용 Enter는 전송하지 않는다.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements.composer.requestSubmit();
      }
    });
  }

  function selectConversation(conversationId) {
    if (!state.conversations.some((conversation) => conversation.id === conversationId)) {
      return;
    }
    syncActiveConversationFromForm();
    state.activeConversationId = conversationId;
    persistState();
    renderAll();
    updateUsage(null);
    setStatus("준비됨", "");
    clearPendingAttachments();
    elements.prompt.focus();
  }

  function deleteConversationById(id) {
    if (abortController) {
      return;
    }
    const target = state.conversations.find((conversation) => conversation.id === id);
    if (!target) {
      return;
    }
    if (!window.confirm(`"${target.title}" 대화를 삭제할까요?`)) {
      return;
    }
    state.conversations = state.conversations.filter((conversation) => conversation.id !== id);
    attachRemoveByConversation(id); // 보관함의 해당 대화 첨부도 정리
    if (state.conversations.length === 0) {
      const next = createConversation();
      state.conversations.push(next);
      state.activeConversationId = next.id;
    } else if (state.activeConversationId === id) {
      state.activeConversationId = state.conversations[0].id;
    }
    persistState();
    renderAll();
    updateUsage(null);
    setStatus("삭제됨", "");
    clearPendingAttachments();
    elements.prompt.focus();
  }

  function deleteActiveConversation() {
    deleteConversationById(getActiveConversation().id);
  }

  function closeHeaderMenu() {
    if (elements.headerMenu) {
      elements.headerMenu.hidden = true;
    }
    if (elements.headerMenuBtn) {
      elements.headerMenuBtn.setAttribute("aria-expanded", "false");
    }
    document.removeEventListener("click", headerMenuOutside, true);
  }
  function headerMenuOutside(event) {
    if (!event.target.closest("#header-menu") && !event.target.closest("#header-menu-btn")) {
      closeHeaderMenu();
    }
  }

  async function clearAllConversations() {
    if (abortController) {
      return;
    }
    if (!window.confirm("모든 대화를 삭제합니다. 되돌릴 수 없습니다. 계속할까요?")) {
      return;
    }
    const next = createConversation();
    state.conversations = [next];
    state.activeConversationId = next.id;
    try {
      const store = await attachStore("readwrite");
      await idbRequest(store.clear()); // 첨부 보관함 전체 비우기
    } catch (_error) {
      /* 보관함 정리 실패는 무시 */
    }
    clearPendingAttachments();
    persistState();
    renderAll();
    updateUsage(null);
    setStatus("전체 대화 삭제됨", "");
  }

  function renameConversation(id) {
    const conversation = state.conversations.find((c) => c.id === id);
    if (!conversation || !elements.renameModal) {
      return;
    }
    renamingId = id;
    elements.renameInput.value = conversation.title;
    elements.renameModal.hidden = false;
    elements.renameInput.focus();
    elements.renameInput.select();
  }
  function closeRename() {
    if (elements.renameModal) {
      elements.renameModal.hidden = true;
    }
    renamingId = null;
    renamingKind = "conversation";
  }
  function confirmRename() {
    const next = String(elements.renameInput.value || "").trim();
    if (renamingKind === "folder") {
      const folder = state.folders.find((f) => f.id === renamingId);
      if (folder && next) {
        folder.name = next.slice(0, 60);
        persistState();
        renderConversationList();
      }
    } else {
      const conversation = state.conversations.find((c) => c.id === renamingId);
      if (conversation && next) {
        conversation.title = normalizeTitle(next) || conversation.title;
        conversation.manualTitle = true;
        conversation.updatedAt = new Date().toISOString();
        persistState();
        renderConversationList();
        renderConversationTitle();
      }
    }
    closeRename();
  }

  function togglePinConversation(id) {
    const conversation = state.conversations.find((c) => c.id === id);
    if (!conversation) {
      return;
    }
    conversation.pinned = !conversation.pinned;
    persistState();
    renderConversationList();
  }

  // ── 대화 폴더 ──
  function createFolder() {
    const folder = { id: createId(), name: "새 폴더", collapsed: false, createdAt: new Date().toISOString() };
    state.folders.unshift(folder);
    persistState();
    renderConversationList();
    renameFolder(folder.id); // 생성 직후 이름 편집
  }

  function renameFolder(id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder || !elements.renameModal) {
      return;
    }
    renamingId = id;
    renamingKind = "folder";
    elements.renameInput.value = folder.name;
    elements.renameModal.hidden = false;
    elements.renameInput.focus();
    elements.renameInput.select();
  }

  function deleteFolder(id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) {
      return;
    }
    const count = state.conversations.filter((c) => c.folderId === id).length;
    const message = count > 0
      ? `폴더 '${folder.name}'을 삭제할까요? 안의 대화 ${count}개는 미분류로 이동합니다(대화는 삭제되지 않습니다).`
      : `폴더 '${folder.name}'을 삭제할까요?`;
    if (!window.confirm(message)) {
      return;
    }
    state.folders = state.folders.filter((f) => f.id !== id);
    for (const conversation of state.conversations) {
      if (conversation.folderId === id) {
        conversation.folderId = null;
      }
    }
    persistState();
    renderConversationList();
  }

  function toggleFolderCollapsed(id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) {
      return;
    }
    folder.collapsed = !folder.collapsed;
    persistState();
    renderConversationList();
  }

  function moveConversationToFolder(conversationId, folderId) {
    const conversation = state.conversations.find((c) => c.id === conversationId);
    if (!conversation) {
      return;
    }
    conversation.folderId = folderId || null;
    conversation.updatedAt = new Date().toISOString();
    persistState();
    renderConversationList();
  }

  function closeConversationMenu() {
    document.getElementById("conversation-menu")?.remove();
    document.removeEventListener("click", conversationMenuOutside, true);
  }
  function conversationMenuOutside(event) {
    if (!event.target.closest("#conversation-menu")) {
      closeConversationMenu();
    }
  }
  function openConversationMenu(anchor, id) {
    closeConversationMenu();
    const conversation = state.conversations.find((c) => c.id === id);
    if (!conversation) {
      return;
    }
    const menu = document.createElement("div");
    menu.id = "conversation-menu";
    menu.className = "popover-menu";
    const make = (label, handler, danger) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `popover-item${danger ? " danger" : ""}`;
      button.textContent = label;
      button.addEventListener("click", () => {
        closeConversationMenu();
        handler();
      });
      return button;
    };
    menu.append(
      make("이름 바꾸기", () => renameConversation(id)),
      make(conversation.pinned ? "고정 해제" : "채팅 고정", () => togglePinConversation(id)),
    );
    // 폴더로 이동: 폴더가 있을 때만. 현재 폴더 외 폴더 + (폴더 안이면)미분류로 빼기.
    if (state.folders.length > 0) {
      const divider = document.createElement("div");
      divider.className = "popover-divider";
      divider.textContent = "폴더로 이동";
      menu.appendChild(divider);
      if (conversation.folderId) {
        menu.appendChild(make("미분류로 빼기", () => moveConversationToFolder(id, null)));
      }
      for (const folder of state.folders) {
        if (folder.id === conversation.folderId) {
          continue;
        }
        menu.appendChild(make(`📁 ${folder.name}`, () => moveConversationToFolder(id, folder.id)));
      }
    }
    menu.appendChild(make("삭제", () => deleteConversationById(id), true));
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
    setTimeout(() => document.addEventListener("click", conversationMenuOutside, true), 0);
  }

  function openFolderMenu(anchor, id) {
    closeConversationMenu(); // 같은 팝오버 인프라를 공유
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) {
      return;
    }
    const menu = document.createElement("div");
    menu.id = "conversation-menu";
    menu.className = "popover-menu";
    const make = (label, handler, danger) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `popover-item${danger ? " danger" : ""}`;
      button.textContent = label;
      button.addEventListener("click", () => {
        closeConversationMenu();
        handler();
      });
      return button;
    };
    menu.append(
      make("이름 바꾸기", () => renameFolder(id)),
      make(folder.collapsed ? "펼치기" : "접기", () => toggleFolderCollapsed(id)),
      make("폴더 삭제", () => deleteFolder(id), true),
    );
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.max(8, left)}px`;
    setTimeout(() => document.addEventListener("click", conversationMenuOutside, true), 0);
  }

  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    elements.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    elements.sidebarToggle.setAttribute("aria-label", collapsed ? "좌측 패널 펼치기" : "좌측 패널 접기");
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? "1" : "0");
  }

  // 좁은 폭(<=1100px)에서 사이드바를 오프캔버스 드로어로 여닫는다.
  function setDrawerOpen(open) {
    document.body.classList.toggle("sidebar-drawer-open", open);
    if (elements.chatMenu) {
      elements.chatMenu.setAttribute("aria-expanded", String(open));
    }
  }
  function openDrawer() {
    setDrawerOpen(true);
  }
  function closeDrawer() {
    setDrawerOpen(false);
  }
  function toggleDrawer() {
    setDrawerOpen(!document.body.classList.contains("sidebar-drawer-open"));
  }

  function isTypingTarget(target) {
    if (!target) {
      return false;
    }
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  function openShortcuts() {
    if (elements.shortcutsModal) {
      elements.shortcutsModal.hidden = false;
    }
  }
  function closeShortcuts() {
    if (elements.shortcutsModal) {
      elements.shortcutsModal.hidden = true;
    }
  }

  // 도넛(맥락) 위에 마우스 올리면 맥락·토큰 사용량을 예쁜 카드로 표시.
  // 도넛 위에 마우스를 올리면 정보 + '대화 압축하기' 버튼이 하나의 카드로 나타난다.
  // 도넛→카드로 마우스를 옮겨 버튼을 누를 수 있도록 짧은 지연으로 닫는다(hover bridge).
  let donutCardTimer = null;

  function donutInfoRows(parent) {
    const conversation = getActiveConversation();
    const stats = getContextStats(conversation);
    const pct = stats.limit > 0 ? Math.round((stats.approximateChars / stats.limit) * 100) : 0;
    const fmt = (n) => (typeof n === "number" ? formatNumber(n) : "-");

    // 헤더: 사용률 %를 크게, 상태 라벨을 함께.
    const levelLabel = pct >= 85 ? "임박" : pct >= 60 ? "주의" : "여유";
    const head = document.createElement("div");
    head.className = "donut-card-head";
    const headPct = document.createElement("span");
    headPct.className = "donut-card-pct";
    headPct.textContent = `${pct}%`;
    const headLabel = document.createElement("span");
    headLabel.className = "donut-card-label";
    headLabel.textContent = `맥락 사용량 · ${levelLabel}`;
    head.append(headPct, headLabel);
    parent.appendChild(head);

    const modeNote = conversation.includeHistory === false ? "현재 메시지만 전송" : "이전 대화 포함";
    const rows = [
      ["문자", `≈ ${formatCharCount(stats.approximateChars)} / ${formatCharCount(stats.limit)}자`],
      ["메시지", `${stats.included} / ${stats.total}개 전송 · ${modeNote}`],
      [
        "토큰",
        lastUsage
          ? `총 ${fmt(lastUsage.total_tokens)} (입력 ${fmt(lastUsage.prompt_tokens)} · 출력 ${fmt(lastUsage.completion_tokens)})`
          : "응답 후 표시됩니다",
      ],
    ];
    for (const [key, value] of rows) {
      const row = document.createElement("div");
      row.className = "donut-tip-row";
      const k = document.createElement("span");
      k.className = "donut-tip-k";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "donut-tip-v";
      v.textContent = value;
      row.append(k, v);
      parent.appendChild(row);
    }
  }

  function hideDonutCard() {
    if (donutCardTimer) {
      window.clearTimeout(donutCardTimer);
      donutCardTimer = null;
    }
    document.getElementById("donut-card")?.remove();
  }
  function scheduleHideDonutCard() {
    if (donutCardTimer) {
      window.clearTimeout(donutCardTimer);
    }
    donutCardTimer = window.setTimeout(hideDonutCard, 220);
  }
  function showDonutCard() {
    if (donutCardTimer) {
      window.clearTimeout(donutCardTimer);
      donutCardTimer = null;
    }
    if (!elements.contextState || document.getElementById("donut-card")) {
      return;
    }
    const card = document.createElement("div");
    card.id = "donut-card";
    card.className = "popover-menu donut-card";
    const info = document.createElement("div");
    info.className = "donut-pop-info";
    donutInfoRows(info);
    card.appendChild(info);

    const compress = document.createElement("button");
    compress.type = "button";
    compress.className = "ghost-button compact donut-compress-btn";
    compress.textContent = "대화 압축하기";
    compress.title = "오래된 메시지를 요약 1건으로 압축해 맥락을 줄입니다(원문은 보존).";
    compress.addEventListener("click", () => {
      hideDonutCard();
      summarizeConversation();
    });
    card.appendChild(compress);

    // 카드 위에 있으면 닫히지 않게, 벗어나면 닫는다.
    card.addEventListener("mouseenter", () => {
      if (donutCardTimer) {
        window.clearTimeout(donutCardTimer);
        donutCardTimer = null;
      }
    });
    card.addEventListener("mouseleave", scheduleHideDonutCard);

    document.body.appendChild(card);
    const rect = elements.contextState.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - card.offsetWidth, window.innerWidth - card.offsetWidth - 8));
    card.style.top = `${rect.bottom + 6}px`;
    card.style.left = `${left}px`;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        // 권한 거부 등 → 아래 execCommand 폴백으로 진행
      }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (_error) {
      ok = false;
    }
    textarea.remove();
    return ok;
  }

  function flashCopyState(button) {
    if (button.dataset.icon === "true") {
      // 아이콘 버튼: 잠깐 체크 아이콘으로 바꿔 복사 완료 표시.
      button.replaceChildren(makeIcon("check"));
      button.classList.add("copied");
      button.disabled = true;
      window.setTimeout(() => {
        button.replaceChildren(makeIcon("copy"));
        button.classList.remove("copied");
        button.disabled = false;
      }, 1000);
      return;
    }
    const previous = button.textContent;
    button.textContent = "복사됨";
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = previous;
      button.disabled = false;
    }, 1000);
  }

  function buildCurlCommand() {
    syncActiveConversationFromForm();
    const selected = getActiveConfig();
    const streaming = isStreamingEnabled();
    // 셸 안전 작은따옴표 인용(엔드포인트·헤더·본문에 특수문자가 있어도 주입되지 않게).
    const shQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
    const headers = ["-H 'Content-Type: application/json'"];
    const key = String(selected.apiKey || "").trim();
    if (key) {
      const auth = /\s/.test(key) ? key : `Bearer ${key}`;
      headers.push(`-H ${shQuote(`Authorization: ${auth}`)}`);
    }
    const payload = {
      model: selected.model,
      messages: buildRequestMessages(getActiveConversation()),
      stream: streaming,
      ...(streaming ? { stream_options: { include_usage: true } } : {}),
      ...generationParams(selected),
    };
    // 스트리밍은 curl/프록시 버퍼링을 끄도록 --no-buffer를 함께 둔다.
    const curlFlags = streaming ? "-sS --no-buffer" : "-sS";
    return [
      `curl ${curlFlags} ${shQuote(selected.endpoint)} \\`,
      `  ${headers.join(" \\\n  ")} \\`,
      `  -d '${JSON.stringify(payload, null, 2).replaceAll("'", "'\"'\"'")}'`,
    ].join("\n");
  }

  async function exportConversation() {
    syncActiveConversationFromForm();
    persistState();
    const payload = buildConversationExport(getActiveConversation());
    const fileName = `${safeFileName(payload.conversation.title)}.json`;
    const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });

    // File System Access 피커는 보안 컨텍스트 전용. Chrome file://에서는 부재하므로 다운로드로 폴백한다.
    const canSavePicker = window.isSecureContext && typeof window.showSaveFilePicker === "function";
    if (canSavePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setStatus("저장됨", "");
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus("저장 취소", "");
          return;
        }
        // SecurityError/NotAllowedError 등 → 다운로드 폴백으로 진행
      }
    }
    downloadBlob(blob, fileName);
    setStatus("다운로드로 저장됨", "");
  }

  function buildConversationExport(conversation) {
    return {
      version: 4,
      type: "qa-bot.conversation",
      exportedAt: new Date().toISOString(),
      conversation: {
        id: conversation.id,
        title: conversation.title,
        manualTitle: conversation.manualTitle,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        selectedModelId: conversation.selectedModelId,
        modelSettings: conversation.modelSettings,
        includeHistory: conversation.includeHistory,
        pinned: conversation.pinned,
        systemPrompt: conversation.systemPrompt,
        memory: conversation.memory,
        memoryOn: conversation.memoryOn,
        messages: conversation.messages,
      },
    };
  }

  function buildConversationMarkdown(conversation = getActiveConversation()) {
    const blocks = conversation.messages.map((message) => {
      const header =
        message.role === "user"
          ? "## 질문"
          : message.role === "assistant"
            ? `## 답변 (${message.modelLabel || message.model || "model"})`
            : "## 오류";
      return `${header}\n\n${message.content}`;
    });
    return [`# ${conversation.title}`, ...blocks].join("\n\n---\n\n");
  }

  async function importConversation() {
    const canOpenPicker = window.isSecureContext && typeof window.showOpenFilePicker === "function";
    if (canOpenPicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
        });
        const file = await handle.getFile();
        await importConversationFile(file);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setStatus("가져오기 취소", "");
          return;
        }
        // 비보안 컨텍스트/권한 거부 등 → 숨김 input 폴백으로 진행
      }
    }
    if (elements.importFile) {
      elements.importFile.click();
    } else {
      setStatus("가져오기를 사용할 수 없습니다 — import-file 요소가 없습니다.", "is-error");
    }
  }

  async function importConversationFile(file) {
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const imported = extractImportedConversations(payload, file.name);
      if (imported.length === 0) {
        throw new Error("가져올 대화가 없습니다.");
      }
      syncActiveConversationFromForm();
      state.conversations.unshift(...imported);
      state.activeConversationId = imported[0].id;
      const saved = persistState();
      renderAll();
      updateUsage(null);
      if (saved) {
        setStatus(`${imported.length}개 가져옴`, "");
      }
      // 저장 실패 시엔 persistState가 띄운 경고(용량 부족 등)를 성공 메시지로 덮지 않는다.
      elements.prompt.focus();
    } catch (error) {
      setStatus(`가져오기 오류: ${error instanceof Error ? error.message : String(error)}`, "is-error");
    }
  }

  function extractImportedConversations(payload, fileName) {
    let rawConversations = [];
    if (payload?.type === "qa-bot.conversation" && payload.conversation) {
      rawConversations = [payload.conversation];
    } else if (payload?.type === "qa-bot.conversations" && Array.isArray(payload.conversations)) {
      rawConversations = payload.conversations;
    } else if (Array.isArray(payload?.conversations)) {
      rawConversations = payload.conversations;
    } else if (Array.isArray(payload?.messages)) {
      rawConversations = [legacyConversationFromPayload(payload, fileName)];
    } else {
      throw new Error("지원하지 않는 JSON 형식입니다.");
    }

    return rawConversations
      .map((raw) => normalizeConversation(raw))
      .filter(Boolean)
      .map((conversation) => {
        const now = new Date().toISOString();
        conversation.id = createId();
        conversation.title = ensureUniqueTitle(conversation.title || titleFromFileName(fileName));
        conversation.manualTitle = true;
        conversation.createdAt = conversation.createdAt || now;
        conversation.updatedAt = now;
        conversation.folderId = null; // 대상 환경에 없는 폴더 참조가 남지 않도록 미분류로 가져온다
        return conversation;
      });
  }

  function legacyConversationFromPayload(payload, fileName) {
    const selected = payload.selected_model || {};
    const selectedModelId = coerceModelId(selected.id);
    const settings = createDefaultModelSettings();
    settings[selectedModelId] = {
      endpoint: typeof selected.endpoint === "string" && selected.endpoint ? selected.endpoint : getPreset(selectedModelId).endpoint,
      model: typeof selected.model === "string" && selected.model ? selected.model : getPreset(selectedModelId).model,
    };
    return {
      title: payload.title || titleFromFileName(fileName) || "가져온 대화",
      manualTitle: true,
      selectedModelId,
      modelSettings: settings,
      systemPrompt: payload.systemPrompt || payload.system_prompt || payload.context_note || DEFAULT_SYSTEM_PROMPT,
      messages: payload.messages,
    };
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function ensureUniqueTitle(title) {
    const base = normalizeTitle(title) || "가져온 대화";
    const existing = new Set(state.conversations.map((conversation) => conversation.title));
    if (!existing.has(base)) {
      return base;
    }
    let index = 2;
    let candidate = `${base} ${index}`;
    while (existing.has(candidate)) {
      index += 1;
      candidate = `${base} ${index}`;
    }
    return candidate;
  }

  function normalizeTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function makeTitle(content) {
    const normalized = normalizeTitle(content);
    return normalized ? normalized.slice(0, 40) : "새 대화";
  }

  function titleFromFileName(fileName) {
    if (!fileName) {
      return "";
    }
    return String(fileName).replace(/\.json$/i, "").trim();
  }

  function safeFileName(value) {
    const normalized = normalizeTitle(value)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
      .replace(/\.+$/g, "")
      .slice(0, 80);
    return normalized || "qa-bot";
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "-";
    }
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return `${month}-${day} ${hour}:${minute}`;
  }

  function createId() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function safeJson(value) {
    try {
      return value ? JSON.parse(value) : null;
    } catch (_error) {
      return null;
    }
  }

  // 사이드바 설정 패널 아코디언: 기본 접힘, 열고닫은 상태를 기억한다.
  function restorePanelStates() {
    const saved = safeJson(window.localStorage.getItem(PANELS_STORAGE_KEY)) || {};
    document.querySelectorAll("details.collapsible[data-panel]").forEach((panel) => {
      const key = panel.dataset.panel;
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        panel.open = Boolean(saved[key]);
      }
      panel.addEventListener("toggle", () => {
        const current = safeJson(window.localStorage.getItem(PANELS_STORAGE_KEY)) || {};
        current[key] = panel.open;
        try {
          window.localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(current));
        } catch (_error) {
          /* 저장 실패는 무시 */
        }
      });
    });
  }

  // ── 첨부 보관함(IndexedDB): 원본 파일을 브라우저에 영구 보관 → 나중 대화에서 재다운로드 ──
  const ATTACH_DB_NAME = "qa-bot-attachments";
  const ATTACH_STORE = "files";
  let attachDbPromise = null;

  function attachDb() {
    if (attachDbPromise) {
      return attachDbPromise;
    }
    attachDbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB 미지원"));
        return;
      }
      const request = window.indexedDB.open(ATTACH_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ATTACH_STORE)) {
          const store = db.createObjectStore(ATTACH_STORE, { keyPath: "id" });
          store.createIndex("conversationId", "conversationId", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return attachDbPromise;
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function attachStore(mode) {
    const db = await attachDb();
    return db.transaction(ATTACH_STORE, mode).objectStore(ATTACH_STORE);
  }

  async function attachPut(record) {
    const store = await attachStore("readwrite");
    return idbRequest(store.put(record));
  }
  async function attachGet(id) {
    const store = await attachStore("readonly");
    return idbRequest(store.get(id));
  }
  async function attachGetAll() {
    const store = await attachStore("readonly");
    return idbRequest(store.getAll());
  }
  async function attachRemove(id) {
    const store = await attachStore("readwrite");
    return idbRequest(store.delete(id));
  }
  async function attachRemoveByConversation(conversationId) {
    try {
      const store = await attachStore("readwrite");
      const keys = await idbRequest(store.index("conversationId").getAllKeys(conversationId));
      await Promise.all(keys.map((key) => idbRequest(store.delete(key))));
    } catch (_error) {
      /* GC 실패는 치명적이지 않음 */
    }
  }

  // 전송 시 호출: 첨부 원본을 보관함에 저장하고 메시지에 ref만 남긴다.
  async function storeAttachments(attachments, conversationId) {
    const refs = [];
    for (const attachment of attachments) {
      const ref = { id: attachment.id, name: attachment.name, type: attachment.type, size: attachment.size };
      refs.push(ref);
      if (attachment.blob) {
        try {
          await attachPut({
            id: attachment.id,
            conversationId,
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            addedAt: new Date().toISOString(),
            blob: attachment.blob,
          });
        } catch (_error) {
          /* 보관 실패해도 대화는 진행 */
        }
      }
    }
    return refs;
  }

  async function downloadAttachment(id, name) {
    try {
      const record = await attachGet(id);
      if (!record || !record.blob) {
        setStatus("보관함에서 첨부를 찾지 못했습니다.", "is-error");
        return;
      }
      downloadBlob(record.blob, name || record.name || "attachment");
    } catch (_error) {
      setStatus("첨부 다운로드 실패", "is-error");
    }
  }

  function loadPinnedAttachments() {
    const raw = safeJson(window.localStorage.getItem(PINNED_ATTACHMENTS_KEY));
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
  }
  function savePinnedAttachments(set) {
    try {
      window.localStorage.setItem(PINNED_ATTACHMENTS_KEY, JSON.stringify([...set]));
    } catch (_error) {
      /* 저장 실패는 무시 */
    }
  }
  function togglePinnedAttachment(id) {
    const set = loadPinnedAttachments();
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    savePinnedAttachments(set);
    renderLibrary(elements.librarySearch ? elements.librarySearch.value : "");
  }

  // 보관함의 첨부를 재업로드 없이 현재 대화 입력에 다시 첨부(원클릭 재첨부).
  async function reattachFromLibrary(record) {
    if (abortController) {
      return;
    }
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      setStatus(`첨부는 최대 ${MAX_ATTACHMENTS}개입니다.`, "is-error");
      return;
    }
    if (pendingAttachments.some((a) => a.name === record.name && a.size === record.size)) {
      setStatus("이미 첨부되어 있습니다.", "");
      return;
    }
    try {
      const stored = await attachGet(record.id);
      if (!stored || !stored.blob) {
        setStatus("보관함에서 첨부를 찾지 못했습니다.", "is-error");
        return;
      }
      const normalized = (await stored.blob.text()).replaceAll("\r\n", "\n");
      const language = languageFromFileName(stored.name);
      const remainingChars =
        MAX_TOTAL_ATTACHMENT_CHARS - pendingAttachments.reduce((sum, item) => sum + item.content.length, 0);
      const limit = Math.min(MAX_TEXT_ATTACHMENT_CHARS, remainingChars);
      if (limit <= 0) {
        setStatus("첨부 용량을 초과했습니다.", "is-error");
        return;
      }
      const truncated = truncateAttachmentContent(normalized, limit, language);
      pendingAttachments.push({
        id: createId(),
        name: stored.name,
        type: stored.type || "text/plain",
        size: stored.size,
        language,
        content: truncated.content,
        originalChars: normalized.length,
        truncated: truncated.truncated,
        blob: stored.blob,
      });
      renderAttachments();
      closeLibrary();
      setStatus(`'${stored.name}' 다시 첨부됨`, "");
    } catch (_error) {
      setStatus("다시 첨부 실패", "is-error");
    }
  }

  // 전역 첨부 보관함: 전 대화의 첨부 목록 + 검색 + 다시 첨부/고정/다운로드/삭제.
  function openLibrary() {
    if (!elements.libraryModal) {
      return;
    }
    elements.libraryModal.hidden = false;
    if (elements.librarySearch) {
      elements.librarySearch.value = "";
    }
    renderLibrary("");
  }
  function closeLibrary() {
    if (elements.libraryModal) {
      elements.libraryModal.hidden = true;
    }
  }
  async function renderLibrary(query) {
    const list = elements.libraryList;
    if (!list) {
      return;
    }
    list.innerHTML = "";
    let records = [];
    try {
      records = (await attachGetAll()) || [];
    } catch (_error) {
      /* IDB 미지원/오류 */
    }
    const q = String(query || "").trim().toLowerCase();
    const pinned = loadPinnedAttachments();
    const rows = records
      .filter((r) => r && r.id && (!q || String(r.name || "").toLowerCase().includes(q)))
      // 고정(즐겨찾기) 항목을 맨 위로, 그 안에서 최신순.
      .sort((a, b) => {
        const pa = pinned.has(a.id) ? 1 : 0;
        const pb = pinned.has(b.id) ? 1 : 0;
        if (pa !== pb) {
          return pb - pa;
        }
        return String(b.addedAt || "").localeCompare(String(a.addedAt || ""));
      });
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "library-empty";
      empty.textContent = q ? "검색 결과 없음" : "보관된 첨부가 없습니다.";
      list.appendChild(empty);
      return;
    }
    for (const record of rows) {
      const conv = state.conversations.find((c) => c.id === record.conversationId);
      const isPinned = pinned.has(record.id);
      const row = document.createElement("div");
      row.className = `library-row${isPinned ? " pinned" : ""}`;

      // 고정(즐겨찾기) 토글 — 흑백 별.
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "library-pin";
      pin.title = isPinned ? "고정 해제" : "자주 쓰는 첨부로 고정";
      pin.setAttribute("aria-pressed", String(isPinned));
      pin.textContent = isPinned ? "★" : "☆";
      pin.addEventListener("click", () => togglePinnedAttachment(record.id));

      const info = document.createElement("div");
      info.className = "library-row-info";
      const name = document.createElement("div");
      name.className = "library-row-name";
      name.textContent = record.name || "(이름 없음)";
      const meta = document.createElement("div");
      meta.className = "library-row-meta";
      meta.textContent = `${formatBytes(record.size)} · ${conv ? conv.title : "(삭제된 대화)"} · ${formatDate(record.addedAt)}`;
      info.append(name, meta);

      const reattach = document.createElement("button");
      reattach.type = "button";
      reattach.className = "ghost-button compact";
      reattach.textContent = "다시 첨부";
      reattach.addEventListener("click", () => reattachFromLibrary(record));

      const dl = document.createElement("button");
      dl.type = "button";
      dl.className = "text-button";
      dl.textContent = "다운로드";
      dl.addEventListener("click", () => downloadAttachment(record.id, record.name));

      const del = document.createElement("button");
      del.type = "button";
      del.className = "text-button";
      del.textContent = "삭제";
      del.addEventListener("click", async () => {
        await attachRemove(record.id);
        renderLibrary(elements.librarySearch ? elements.librarySearch.value : "");
      });

      row.append(pin, info, reattach, dl, del);
      list.appendChild(row);
    }
  }

  function init() {
    renderAll();
    renderAttachments();
    bindEvents();
    persistState();
    if (corruptStateBackedUp) {
      setStatus("이전 저장 데이터를 읽을 수 없어 새로 시작합니다 — 원본은 복구용 백업으로 보존했습니다.", "is-error");
    }
    setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1");
    restorePanelStates();
    resizePrompt();
    updateUsage(null);
    elements.prompt.focus();
  }

  init();
})();
