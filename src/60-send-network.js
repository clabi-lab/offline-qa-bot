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

