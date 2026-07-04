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

