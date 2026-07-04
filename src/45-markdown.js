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

