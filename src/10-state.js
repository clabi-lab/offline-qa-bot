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

