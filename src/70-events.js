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

