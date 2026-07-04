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

