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


