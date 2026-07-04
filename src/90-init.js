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
