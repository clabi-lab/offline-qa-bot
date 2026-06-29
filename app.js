(function () {
  "use strict";

  // 사용할 모델 목록. 각 항목의 endpoint/model을 본인 환경의 OpenAI-compatible 서버
  //   주소로 바꿔 쓰세요(예: http://localhost:8000/v1/chat/completions). UI에서도 수정 가능.
  // contextChars = 입력에 쓸 '문자' 예산 ≈ (모델 컨텍스트 토큰 − 출력 예약 토큰) × ~2자/토큰.
  //   예: 컨텍스트 65536 − 출력예약 32768 = 32768토큰 × 2 ≈ 65,536자.
  const CHAT_MODELS = [
    {
      id: "gemma4",
      label: "Gemma4 26B",
      endpoint: "http://model.local/gemma4/v1/chat/completions",
      model: "gemma-4-26B-it",
      contextChars: 65536, // (컨텍스트 65536 − 출력예약 32768) × ~2자/토큰
      note: "예시 모델",
    },
    {
      id: "gemma4-31b",
      label: "Gemma4 31B",
      endpoint: "http://model.local/gemma4-31b/v1/chat/completions",
      model: "gemma-4-31B-it",
      contextChars: 65536, // 위와 동일 산식
      note: "예시 모델",
    },
  ];

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
  state = loadState();
  normalizeMemoryState();
  normalizeModelsState();
  let conversationQuery = "";
  let renamingId = null;
  let pendingPrompt = "";
  let pendingAttachments = [];
  let abortController = null;
  let typingTimer = null;

  function loadState() {
    const stored = safeJson(window.localStorage.getItem(APP_STORAGE_KEY));
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
      messages: sanitizeMessages(raw.messages),
    };
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

  function persistState() {
    try {
      window.localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(state));
    } catch (_error) {
      // localStorage 용량(약 5MB) 초과 등 → 앱을 멈추지 않고 한국어로 안내.
      setStatus("저장 공간 부족: 오래된 대화를 삭제하세요.", "is-error");
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
      // endpoint·body model은 모델 레지스트리(영구) 값을 사용. 생성 파라미터는 대화별 폼 값.
      endpoint: preset.endpoint,
      model: preset.model,
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

  function renderConversationList() {
    const query = conversationQuery.trim().toLowerCase();
    const sorted = [...state.conversations]
      .filter((c) => !query || String(c.title || "").toLowerCase().includes(query))
      .sort((a, b) => {
        // 고정된 대화를 위로, 그다음 최신순.
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return String(b.updatedAt).localeCompare(String(a.updatedAt));
      });
    elements.conversationList.innerHTML = "";
    if (sorted.length === 0) {
      const empty = document.createElement("div");
      empty.className = "conversation-empty";
      empty.textContent = query ? "검색 결과 없음" : "대화 없음";
      elements.conversationList.appendChild(empty);
      return;
    }
    for (const conversation of sorted) {
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
      elements.conversationList.appendChild(item);
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
        elements.memoryProfileText.focus();
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

  function renderMessages() {
    const conversation = getActiveConversation();
    elements.messages.innerHTML = "";
    renderContextCount();

    if (conversation.messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const title = document.createElement("strong");
      title.textContent = "Ready";
      const text = document.createElement("span");
      text.textContent = "모델과 endpoint를 확인한 뒤 질문을 입력하세요.";
      empty.append(title, text);
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
      }
    }
    if (message.role === "assistant") {
      actions.appendChild(createCopyButton(message.content, "답변 복사"));
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
      textBuffer.push(`\`\`\`${language === "text" ? "" : language}`);
      textBuffer.push(...codeBuffer);
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

  function appendMarkdownBlock(container, lines) {
    if (isMarkdownTable(lines)) {
      appendTable(container, lines);
      return;
    }

    // 제목: 블록 첫 줄이 #~###### 이면 heading으로 렌더하고 나머지는 이어서 처리.
    const headingMatch = lines[0].trim().match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(6, Math.max(3, headingMatch[1].length + 2)); // # → h3 ... ####+ → h6
      const heading = document.createElement(`h${level}`);
      heading.className = "content-heading";
      appendInlineMarkdown(heading, headingMatch[2]);
      container.appendChild(heading);
      if (lines.length > 1) {
        appendMarkdownBlock(container, lines.slice(1));
      }
      return;
    }

    // 인용: 모든 줄이 '>' 로 시작하면 blockquote.
    if (lines.every((line) => /^>\s?/.test(line.trim()))) {
      const quote = document.createElement("blockquote");
      quote.className = "content-quote";
      const inner = lines.map((line) => line.trim().replace(/^>\s?/, "")).join("\n");
      appendMarkdownSegment(quote, inner);
      container.appendChild(quote);
      return;
    }

    // 목록(불릿/순번 혼합 허용): 모든 줄이 리스트 항목이면 중첩 포함 렌더.
    const isListLine = (line) => /^([-*]|\d+[.)])\s+/.test(line.trim());
    if (lines.every(isListLine)) {
      appendList(container, lines, /^\d+[.)]\s+/.test(lines[0].trim()) ? "ol" : "ul");
      return;
    }

    appendParagraph(container, lines);
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

    const headerCells = splitTableRow(lines[0]);
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    for (const cell of headerCells) {
      const th = document.createElement("th");
      appendInlineMarkdown(th, cell);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const line of lines.slice(2)) {
      const row = document.createElement("tr");
      for (const cell of splitTableRow(line)) {
        const td = document.createElement("td");
        appendInlineMarkdown(td, cell);
        row.appendChild(td);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);
    container.appendChild(wrapper);
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

  function appendInlineMarkdown(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g;
    let lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      if (match.index > lastIndex) {
        parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const token = match[0];
      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.className = "inline-code";
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (token.startsWith("**")) {
        const strong = document.createElement("strong");
        strong.textContent = token.slice(2, -2);
        parent.appendChild(strong);
      } else {
        appendLinkToken(parent, token);
      }
      lastIndex = match.index + token.length;
      match = pattern.exec(text);
    }
    if (lastIndex < text.length) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex)));
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
    anchor.textContent = linkMatch[1];
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

    // 가로로 긴 코드: 좌우 스크롤 버튼(오버플로 시에만 노출).
    const left = document.createElement("button");
    left.type = "button";
    left.className = "code-scroll-btn code-scroll-left";
    left.setAttribute("aria-label", "코드 왼쪽으로 스크롤");
    left.textContent = "‹";
    const right = document.createElement("button");
    right.type = "button";
    right.className = "code-scroll-btn code-scroll-right";
    right.setAttribute("aria-label", "코드 오른쪽으로 스크롤");
    right.textContent = "›";
    const scrollStep = (dir) =>
      scroll.scrollBy({ left: dir * Math.max(160, scroll.clientWidth * 0.7), behavior: "smooth" });
    left.addEventListener("click", () => scrollStep(-1));
    right.addEventListener("click", () => scrollStep(1));
    const updateOverflow = () => {
      block.classList.toggle("has-overflow", scroll.scrollWidth > scroll.clientWidth + 4);
      left.disabled = scroll.scrollLeft <= 0;
      right.disabled = scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
    };
    scroll.addEventListener("scroll", updateOverflow, { passive: true });
    // 가로 오버플로 감지를 견고화: rAF 1회로는 스트리밍/폰트로드/창 리사이즈 후 상태가 어긋나
    // 버튼이 안 뜨거나 위치가 어긋난다 → 컨테이너·내용 크기 변화를 ResizeObserver로 재평가.
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(updateOverflow);
      ro.observe(scroll);
      ro.observe(pre);
    }
    block.append(head, scroll, left, right);
    container.appendChild(block);
    // 부착 직후 동기 측정(레이아웃 강제 read)으로 가로 오버플로 버튼을 즉시 정확히 노출한다.
    // 부착 전 측정은 clientWidth=0이라 무의미했음. rAF/setTimeout/RO는 폰트로드·스트리밍·리사이즈 후속 보정.
    updateOverflow();
    window.requestAnimationFrame(updateOverflow);
    window.setTimeout(updateOverflow, 0);
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
        const rawText = await file.text();
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
    let savedPartial = false;
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

    try {
      // 토큰마다 DOM을 건드리지 않고 다음 프레임에 1회만 갱신(잰크 제거).
      let rafPending = false;
      const onDelta = (textSoFar) => {
        streamedText = textSoFar;
        armTimeout();
        if (streamUi && !rafPending) {
          rafPending = true;
          window.requestAnimationFrame(() => {
            rafPending = false;
            if (streamUi) {
              streamUi.textNode.textContent = streamedText;
              stickyAutoScroll(); // 바닥 근처일 때만 따라가 질문 고정을 깨지 않음
            }
          });
        }
      };
      const answer = streaming
        ? await requestChatCompletionStream(selected, buildRequestMessages(conversation), abortController.signal, onDelta)
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
      if (userAborted && streamedText.trim()) {
        // 스트리밍 중 사용자가 중지: 받은 만큼은 답변으로 보존한다.
        target.messages.push({
          role: "assistant",
          content: streamedText.trim(),
          model: selected.model,
          modelLabel: selected.label,
          createdAt: new Date().toISOString(),
        });
        target.updatedAt = new Date().toISOString();
        pendingPrompt = "";
        savedPartial = true;
        setStatus("중지됨 — 받은 응답까지 저장", "");
      } else if (userAborted) {
        // 사용자가 누른 중지(받은 내용 없음): 오류 버블을 남기지 않는다.
        setStatus("중지됨", "");
      } else {
        const detail = isAbort
          ? `응답 지연 — ${Math.round(SEND_TIMEOUT_MS / 1000)}초 내 진행 없음`
          : error instanceof TypeError
            ? "네트워크 오류 — CORS(Origin null 허용) 또는 endpoint 접근을 확인하세요"
            : error instanceof Error
              ? error.message
              : String(error);
        target.messages.push({
          role: "error",
          content: `호출 실패: ${detail}`,
          createdAt: new Date().toISOString(),
        });
        target.updatedAt = new Date().toISOString();
        setStatus(isAbort ? "응답 지연 — 시간 초과" : "오류", "is-error");
      }
      if (!savedPartial && state.activeConversationId === conversationId) {
        elements.prompt.value = pendingPrompt;
        pendingAttachments = attachmentsSnapshot;
        renderAttachments();
        resizePrompt();
      }
    } finally {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      abortController = null;
      removeTyping();
      streamUi?.wrapper.remove();
      setBusy(false);
      persistState();
      pendingQuestionAnchor = true; // 최종 렌더도 질문을 상단 고정(질문 위 / 답변 아래)
      renderAll();
      elements.prompt.focus();
    }
  }

  // 스트리밍 중 토큰을 증분 표시할 임시 어시스턴트 노드(평문). 완료 시 renderAll로 마크다운 최종 렌더.
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
    const textNode = document.createElement("div");
    textNode.className = "content-text";
    textNode.textContent = "…";
    bubble.appendChild(textNode);

    wrapper.append(top, bubble);
    return { wrapper, textNode };
  }

  async function requestChatCompletion(modelConfig, chatMessages, signal) {
    const response = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: buildHeaders(),
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
  async function requestChatCompletionStream(modelConfig, chatMessages, signal, onDelta) {
    const response = await fetch(modelConfig.endpoint, {
      method: "POST",
      headers: buildHeaders(),
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
    if (!response.ok || !contentType.includes("text/event-stream") || !response.body) {
      // 폴백: 비스트리밍 응답으로 처리(전체 본문 한 번에).
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
    let usage = null;
    let done = false;
    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of rawEvent.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) {
              continue;
            }
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              break;
            }
            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch (_error) {
              continue;
            }
            const delta = chunk?.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) {
              text += delta;
              if (typeof onDelta === "function") {
                onDelta(text);
              }
            }
            if (chunk?.usage) {
              usage = chunk.usage;
            }
          }
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

  function buildHeaders() {
    return {
      "Content-Type": "application/json",
    };
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
        headers: buildHeaders(),
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

  function setStatus(text, className) {
    elements.connectionState.className = `connection-state ${className || ""}`.trim();
    elements.connectionState.textContent = text;
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
    elements.prompt.style.height = `${Math.min(Math.max(elements.prompt.scrollHeight, 110), 300)}px`;
  }

  function scrollToBottom() {
    // 코드블록/첨부가 reflow되기 전 동기 스크롤은 하단 고정이 빗나간다. 즉시 1회 + 레이아웃
    // 확정 후(rAF) + 매크로태스크(setTimeout 0)에 재고정해 긴 코드/이미지에도 바닥에 붙는다.
    const jump = () => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    };
    jump();
    window.requestAnimationFrame(() => {
      jump();
      window.setTimeout(jump, 0);
    });
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
      window.setTimeout(apply, 0);
    });
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

  function bindEvents() {
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
  }
  function confirmRename() {
    const conversation = state.conversations.find((c) => c.id === renamingId);
    if (conversation) {
      const next = String(elements.renameInput.value || "").trim();
      if (next) {
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
      make("삭제", () => deleteConversationById(id), true),
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
    const headers = ["-H 'Content-Type: application/json'"];
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
      `curl ${curlFlags} ${selected.endpoint} \\`,
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
        systemPrompt: conversation.systemPrompt,
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
    elements.importFile.click();
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
      persistState();
      renderAll();
      updateUsage(null);
      setStatus(`${imported.length}개 가져옴`, "");
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
    setSidebarCollapsed(window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1");
    restorePanelStates();
    resizePrompt();
    updateUsage(null);
    elements.prompt.focus();
  }

  init();
})();
