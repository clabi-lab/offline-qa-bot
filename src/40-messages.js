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

