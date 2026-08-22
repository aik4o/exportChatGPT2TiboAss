// ==UserScript==
// @name         ChatGPT 当前会话导出 Markdown
// @namespace    https://chatgpt.com/
// @version      2.9.1
// @description  从原始会话数据导出 Markdown，保留代码、Mermaid、公式、图片和附件。
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const BUTTON_ID = "codex-markdown-export-button";
  const ATTACHMENTS_BUTTON_ID = "codex-markdown-export-with-attachments-button";
  const MESSAGE_SELECTOR = "[data-message-author-role][data-message-id]";
  const SCRIPT_VERSION = "2.9.1";

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  function reviveFlatData(flat) {
    const seen = new Map();

    function revive(index) {
      if (typeof index !== "number") return index;
      if (index === -1) return undefined;
      if (index === -2 || index === -5) return null;
      if (index === -3) return Number.NaN;
      if (index === -4) return Number.POSITIVE_INFINITY;
      if (index < 0) return null;
      if (seen.has(index)) return seen.get(index);

      const value = flat[index];
      if (value === null || typeof value !== "object") return value;

      if (Array.isArray(value)) {
        const output = [];
        seen.set(index, output);
        for (const child of value) output.push(revive(child));
        return output;
      }

      const output = {};
      seen.set(index, output);
      for (const [rawKey, child] of Object.entries(value)) {
        const key = rawKey.startsWith("_") ? revive(Number(rawKey.slice(1))) : rawKey;
        output[String(key)] = revive(child);
      }
      return output;
    }

    return revive(0);
  }

  function embeddedConversation() {
    const candidates = Array.from(document.scripts)
      .map(script => script.textContent || "")
      .filter(source => source.includes("streamController.enqueue"))
      .sort((a, b) => b.length - a.length);

    for (const source of candidates) {
      try {
        const start = source.indexOf("enqueue(") + "enqueue(".length;
        const argument = source.slice(start, source.lastIndexOf(");"));
        const payload = JSON.parse(argument);
        const root = reviveFlatData(JSON.parse(payload.trim()));
        const route = root?.loaderData?.["routes/share.$shareId.($action)"];
        const data = route?.serverResponse?.data;
        if (data?.mapping && data?.current_node) return data;
      } catch {
        // Try the next streamed script.
      }
    }
    return null;
  }

  function conversationId() {
    return location.pathname.match(/\/c\/([0-9a-f-]{16,})/i)?.[1] || "";
  }

  async function apiHeaders() {
    const headers = { Accept: "application/json" };
    const sessionResponse = await fetch("/api/auth/session", {
      credentials: "include",
      cache: "no-store",
    });

    if (!sessionResponse.ok) return headers;
    const token = (await sessionResponse.json())?.accessToken;
    if (!token) return headers;

    headers.Authorization = `Bearer ${token}`;
    headers["X-Authorization"] = `Bearer ${token}`;

    const workspaceCookie = document.cookie.match(/(?:^|;)\s*_account=([^;]+)/)?.[1];
    if (!workspaceCookie) return headers;

    try {
      const accountsResponse = await fetch("/backend-api/accounts/check/v4-2023-04-27", {
        credentials: "include",
        cache: "no-store",
        headers,
      });
      if (!accountsResponse.ok) return headers;

      const accounts = (await accountsResponse.json())?.accounts || {};
      const workspaceId = decodeURIComponent(workspaceCookie);
      const accountId = accounts[workspaceId]?.account?.account_id;
      if (accountId) headers["Chatgpt-Account-Id"] = accountId;
    } catch {
      // Personal accounts do not need the workspace header.
    }

    return headers;
  }

  async function fetchedConversation(headers) {
    const id = conversationId();
    if (!id) return null;

    const response = await fetch(`/backend-api/conversation/${id}`, {
      credentials: "include",
      cache: "no-store",
      headers,
    });

    if (!response.ok) throw new Error(`读取原始会话失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data?.mapping || !data?.current_node) throw new Error("原始会话数据结构不完整");
    return data;
  }

  function fileDownloadUrl(pointer) {
    const [fileId, query = ""] = pointer.replace(/^(?:sediment|file-service):\/\//, "").split(/\?(.*)/s);
    const params = new URLSearchParams(query);
    params.set("post_id", "");
    params.set("inline", "false");
    return `/backend-api/files/download/${encodeURIComponent(fileId)}?${params}`;
  }

  async function resolveAssetPointer(pointer, headers) {
    const detailsResponse = await fetch(fileDownloadUrl(pointer), {
      credentials: "include",
      cache: "no-store",
      headers,
    });
    if (!detailsResponse.ok) throw new Error(`读取附件地址失败（HTTP ${detailsResponse.status}）`);

    const details = await detailsResponse.json();
    if (details.status === "error" || !details.download_url) {
      throw new Error(details.error_message || "附件没有可下载地址");
    }

    return { url: details.download_url, details };
  }

  async function fetchAssetBlob(url) {
    try {
      const response = await fetch(url);
      return response.ok ? await response.blob() : null;
    } catch {
      return null;
    }
  }

  function mainPath(conversation) {
    const path = [];
    let id = conversation.current_node;

    while (id) {
      const node = conversation.mapping?.[id];
      if (!node) break;
      path.push(node);
      id = node.parent;
    }

    return path.reverse();
  }

  function hasRenderableImage(message) {
    return (Array.isArray(message?.content?.parts) && message.content.parts.some(part =>
      part && typeof part === "object" && part.content_type === "image_asset_pointer"
    )) || (message?.metadata?.aggregate_result?.messages || []).some(item => item?.message_type === "image");
  }

  function exportedMessageRole(message, nodeId, renderedMessages = null) {
    if (!message?.content || message.metadata?.is_visually_hidden_from_conversation) return "";
    if (message.recipient && message.recipient !== "all") return "";

    const role = message.author?.role;
    const type = message.content.content_type;
    const id = message.id || nodeId;
    const hasImage = hasRenderableImage(message);

    if (["thoughts", "reasoning_recap", "user_editable_context", "model_editable_context"].includes(type)) return "";
    if (message.author?.name === "file_search") return "";
    if (role === "tool") {
      const hasInlineText = Array.isArray(message.content.parts) && message.content.parts.some(part =>
        typeof part === "string" ? part.trim() : typeof part?.text === "string" && part.text.trim()
      );
      return hasImage && !hasInlineText ? "assistant" : "";
    }
    if (!["user", "assistant"].includes(role)) return "";
    if (!["text", "multimodal_text", "code", "execution_output"].includes(type) && !hasImage) return "";
    if (message.channel != null && message.channel !== "" && message.channel !== "final") return "";
    if (role === "assistant" && message.end_turn === false) return "";

    if (renderedMessages?.size) return renderedMessages.has(id) ? role : "";
    return role;
  }

  function filePointerId(pointer) {
    return String(pointer || "")
      .replace(/^(?:sediment|file-service):\/\//, "")
      .split("?")[0];
  }

  async function hydrateConversationAssets(conversation, renderedMessages = null, headers = null, includeAttachments = false) {
    const groups = new Map();
    const addTarget = (object, key, pointer) => {
      if (!object || typeof pointer !== "string" || /^(?:https?:\/\/|data:)/i.test(pointer)) return;
      const id = filePointerId(pointer);
      if (!id) return;

      const group = groups.get(id) || { pointer, targets: [] };
      if (pointer.includes("?") && !group.pointer.includes("?")) group.pointer = pointer;
      group.targets.push({ object, key });
      groups.set(id, group);
    };

    for (const node of mainPath(conversation)) {
      const message = node.message;
      if (!exportedMessageRole(message, node.id, renderedMessages)) continue;
      for (const part of Array.isArray(message?.content?.parts) ? message.content.parts : []) {
        if (part && typeof part === "object" && (part.asset_pointer || part.file_id || /(?:image|file|audio|video)_asset_pointer/.test(part.content_type || ""))) {
          addTarget(part, "download_url", part.asset_pointer || part.file_id || part.id);
        }
      }
      for (const attachment of [
        ...(Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : []),
        ...(Array.isArray(message?.metadata?.files) ? message.metadata.files : []),
        ...(Array.isArray(message?.metadata?.user_attachments) ? message.metadata.user_attachments : []),
      ]) {
        addTarget(attachment, "download_url", attachment.asset_pointer || attachment.file_id || attachment.id);
      }
      for (const image of message?.metadata?.aggregate_result?.messages || []) {
        if (image?.message_type === "image") {
          addTarget(image, "download_url", image.image_url);
        }
      }
    }

    if (!groups.size) return { embedded: 0, failed: 0, downloads: [] };

    if (!headers) {
      headers = { Accept: "application/json" };
      try {
        headers = await apiHeaders();
      } catch {
        // Shared pages can resolve images without an authenticated session.
      }
    }

    let embedded = 0;
    let failed = 0;
    const downloads = [];
    const usedNames = new Map();
    await Promise.all(Array.from(groups.values()).map(async (group) => {
      try {
        const asset = await resolveAssetPointer(group.pointer, headers);
        const resolvedName = asset.details.file_name || asset.details.filename || asset.details.name || "";
        group.targets.forEach(target => {
          target.object[target.key] = asset.url;
          if (resolvedName) target.object.resolved_file_name = resolvedName;
        });

        const namedTarget = group.targets.map(target => target.object)
          .find(item => item.name || item.filename || item.file_name);
        const declaredType = namedTarget?.mime_type || namedTarget?.mimeType || asset.details.mime_type || "";
        const knownImage = declaredType.startsWith("image/") || group.targets.some(target =>
          target.object.content_type === "image_asset_pointer" || target.object.message_type === "image"
        );
        const blob = includeAttachments ? await fetchAssetBlob(asset.url) : null;
        const type = declaredType || blob?.type || "";
        const isImage = knownImage || type.startsWith("image/");

        if (!includeAttachments) {
          group.targets.forEach(target => { delete target.object.export_file_name; });
          embedded += 1;
          return;
        }

        if (!blob) {
          group.targets.forEach(target => { delete target.object.export_file_name; });
          failed += 1;
          embedded += 1;
          return;
        }

        let name = safeAttachmentFilename(
          (isImage && resolvedName) || namedTarget?.name || namedTarget?.filename || namedTarget?.file_name || resolvedName || filePointerId(group.pointer)
        );
        const count = (usedNames.get(name) || 0) + 1;
        usedNames.set(name, count);
        if (count > 1) {
          const dot = name.lastIndexOf(".");
          name = dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
        }
        group.targets.forEach(target => { target.object.export_file_name = name; });
        downloads.push({ name, blob, url: asset.url });
        embedded += 1;
      } catch (error) {
        failed += 1;
        console.warn("ChatGPT 附件导出失败", group.pointer, error);
      }
    }));

    return { embedded, failed, downloads };
  }

  function markdownLink(label, url) {
    const safeLabel = String(label || url).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/]/g, "\\]").replace(/[\r\n]+/g, " ");
    const safeUrl = String(url).replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/[\r\n]+/g, "");
    return `[${safeLabel}](${safeUrl})`;
  }

  function normalizeCitationText(text) {
    return text
      .replace(/[\u00A0\u202F\u2007\u2060]/gu, " ")
      .replace(/[\u2010-\u2015\u2212]/gu, "-")
      .replace(/[\uE203\uE204]/gu, "");
  }

  function normalizeCitations(text, metadata = {}) {
    let output = normalizeCitationText(text)
      .replace(/\uE200url\uE202([^\uE202\uE201]+)\uE202\[([^\uE201\]]+)\uE201\]\(([^)\uE201]+)\uE201\)/gu,
        (_, label, _shownUrl, targetUrl) => markdownLink(label, targetUrl))
      .replace(/\uE200url\uE202([^\uE202\uE201]+)\uE202\[?(https?:\/\/[^\]\s\uE201]+)\]?\uE201/gu,
        (_, label, url) => markdownLink(label, url));

    const references = Array.isArray(metadata.content_references) ? metadata.content_references : [];
    for (const reference of [...references].sort((a, b) => (b.matched_text?.length || 0) - (a.matched_text?.length || 0))) {
      if (!reference.matched_text) continue;
      const sources = [
        ...(reference.items || []),
        ...(reference.fallback_items || []),
        ...(!reference.items?.length && reference.url ? [reference] : []),
      ];
      const replacement = reference.alt || sources
        .filter(source => source?.url)
        .map(source => markdownLink(source.attribution || source.title || source.url, source.url))
        .join(", ");
      output = output.split(normalizeCitationText(reference.matched_text)).join(replacement);
    }

    return output
      .replace(/\uE200(?:cite|url)(?:\uE202[^\uE200\uE201]*)+\uE201/gu, "")
      .replace(/[\uE200-\uE204]/gu, "");
  }

  function normalizeMathSegment(text) {
    const codeSpans = [];
    const protectedText = text.replace(/(`+)([\s\S]*?)\1/g, match => {
      const index = codeSpans.push(match) - 1;
      return `\u0000CODE${index}\u0000`;
    });

    return protectedText
      .replace(/(?<!\\)\\\[\s*/g, () => "\n$$\n")
      .replace(/\s*(?<!\\)\\\]/g, () => "\n$$\n")
      .replace(/(?<!\\)\\\((.*?)\\\)/gs, (_, expression) => `$${expression.trim()}$`)
      .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
  }

  function normalizeMathOutsideCode(text) {
    const lines = text.split("\n");
    const output = [];
    let plain = [];
    let fence = null;

    const flush = () => {
      if (plain.length) output.push(normalizeMathSegment(plain.join("\n")));
      plain = [];
    };

    for (const line of lines) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/i)?.[1] || "";

      if (!fence && marker) {
        flush();
        fence = { char: marker[0], length: marker.length };
        output.push(line);
        continue;
      }

      if (fence) {
        output.push(line);
        if (new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
        continue;
      }

      plain.push(line);
    }

    flush();
    return output.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function byteSize(size) {
    if (!Number.isFinite(Number(size)) || Number(size) < 0) return "";
    const value = Number(size);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  function attachmentIdentity(attachment) {
    const pointer = attachment?.asset_pointer || attachment?.file_id || attachment?.id;
    return filePointerId(pointer) || attachment?.name || attachment?.filename || "";
  }

  function attachmentMarkdown(attachment, index = 0) {
    if (!attachment || typeof attachment !== "object") return "";

    const type = attachment.mime_type || attachment.mimeType || attachment.content_type || "";
    const isImage = type === "image_asset_pointer" || type.startsWith("image/");
    const names = [
      ...(isImage ? [attachment.resolved_file_name] : []),
      attachment.name,
      attachment.filename,
      attachment.file_name,
      ...(!isImage ? [attachment.resolved_file_name] : []),
      attachment.metadata?.dalle?.serialization_title,
    ].map(value => String(value || "").replace(/(?:&#x20;|&#32;|&nbsp;)/gi, " ").trim());
    const name = names.find(value => value && !/^dall(?:-|·)e generation metadata$/i.test(value))
      || `${isImage ? "图片" : "附件"} ${index + 1}`;
    const size = byteSize(attachment.size_bytes ?? attachment.size);
    const pointer = attachment.asset_pointer || attachment.file_id || attachment.id || "";
    const rawUrl = attachment.download_url || attachment.url || attachment.image_url?.url || attachment.image_url || attachment.asset_pointer || "";
    const url = typeof rawUrl === "string" && /^(?:https?:\/\/|data:)/i.test(rawUrl) ? rawUrl : "";
    const details = [type && `类型：${type}`, size && `大小：${size}`].filter(Boolean).join("；");
    const localUrl = attachment.export_file_name
      ? `./${encodeURIComponent(attachment.export_file_name).replace(/\(/g, "%28").replace(/\)/g, "%29")}`
      : "";

    if (isImage && (localUrl || url)) return `![${String(name).replace(/]/g, "\\]")}](${localUrl || url})`;
    if (localUrl) {
      return `${markdownLink(`附件：${name}`, localUrl)}${details ? `（${details}）` : ""}`;
    }
    if (url) return `[附件：${String(name).replace(/]/g, "\\]")}](${url})${details ? `（${details}）` : ""}`;

    const label = attachment.generated ? "ChatGPT 回复图片" : "用户附件";
    return [
      "> [!NOTE]",
      `> ${label}：**${name}**${details ? `（${details}）` : ""}`,
      pointer ? `> 资源标识：\`${pointer}\`` : "",
    ].filter(Boolean).join("\n");
  }

  function rawMessageMarkdown(message, renderedText) {
    const content = message.content || {};
    const metadataAttachments = [
      ...(Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : []),
      ...(Array.isArray(message.metadata?.files) ? message.metadata.files : []),
      ...(Array.isArray(message.metadata?.user_attachments) ? message.metadata.user_attachments : []),
    ];
    const seenAttachments = new Set();
    const useRenderedText = renderedText !== undefined;
    const chunks = useRenderedText && renderedText.trim() ? [renderedText.trim()] : [];
    const executionImages = (message.metadata?.aggregate_result?.messages || [])
      .filter(item => item?.message_type === "image");

    if (!useRenderedText && (content.content_type === "code" || (content.content_type === "execution_output" && !executionImages.length)) && typeof content.text === "string") {
      const value = content.text.trim();
      if (value) chunks.push(codeFence(value, content.language || ""));
    }

    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof part === "string") {
        const value = useRenderedText ? "" : part.trim();
        const safeValue = message.author?.role === "user" ? escapeHtmlOutsideCode(value) : value;
        if (safeValue) chunks.push(safeValue);
        continue;
      }

      if (!useRenderedText && typeof part?.text === "string") {
        const value = part.text.trim();
        if (value) chunks.push(message.author?.role === "user" ? escapeHtmlOutsideCode(value) : value);
      }

      const isAttachment = part && typeof part === "object" && (
        part.asset_pointer ||
        part.file_id ||
        /(?:image|file|audio|video)_asset_pointer/.test(part.content_type || "")
      );
      if (isAttachment) {
        const match = metadataAttachments.find(item => attachmentIdentity(item) === attachmentIdentity(part));
        const attachment = { ...(match || {}), ...part, generated: message.author?.role !== "user" };
        const note = attachmentMarkdown(attachment, chunks.length);
        if (note) chunks.push(note);
        seenAttachments.add(attachmentIdentity(attachment));
      }
    }

    metadataAttachments.forEach((attachment, index) => {
      const identity = attachmentIdentity(attachment);
      if (identity && seenAttachments.has(identity)) return;
      const note = attachmentMarkdown({ ...attachment, generated: message.author?.role !== "user" }, index);
      if (note) chunks.push(note);
    });

    executionImages.forEach((image, index) => {
      const note = attachmentMarkdown({
        ...image,
        content_type: "image_asset_pointer",
        name: image.title || image.alt || `ChatGPT 生成图片 ${index + 1}`,
        generated: true,
      }, index);
      if (note) chunks.push(note);
    });

    return normalizeMathOutsideCode(normalizeCitations(chunks.join("\n\n"), message.metadata));
  }

  function messagesFromConversation(conversation, renderedMessages = null) {
    const messages = [];
    const path = mainPath(conversation);
    const lastNodeForRenderedId = new Map();

    if (renderedMessages?.size) {
      for (const node of path) {
        const message = node.message;
        const role = message?.author?.role;
        const id = message?.id || node.id;
        if (["user", "assistant"].includes(role) && renderedMessages.has(id) && exportedMessageRole(message, node.id, renderedMessages)) {
          lastNodeForRenderedId.set(id, node);
        }
      }
    }

    for (const node of path) {
      const message = node.message;
      const role = message?.author?.role;
      const id = message?.id || node.id;
      const exportRole = exportedMessageRole(message, node.id, renderedMessages);
      if (!exportRole) continue;
      if (lastNodeForRenderedId.size && ["user", "assistant"].includes(role) && lastNodeForRenderedId.get(id) !== node) continue;

      const renderedText = role === "user" && renderedMessages?.size
        ? renderedMessages.get(id)?.content || ""
        : undefined;
      const content = rawMessageMarkdown(message, renderedText);
      if (content) {
        messages.push({ id: message.id || node.id, role: exportRole, content });
      }
    }

    return messages;
  }

  function escapeTableCell(text) {
    return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, "<br>").trim();
  }

  function codeFence(text, language = "") {
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
    const fence = "`".repeat(Math.max(3, longest + 1));
    return `\n\n${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
  }

  function inlineCode(text) {
    const longest = Math.max(0, ...(text.match(/`+/g) || []).map(run => run.length));
    const fence = "`".repeat(longest + 1);
    const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
    return `${fence}${padding}${text}${padding}${fence}`;
  }

  function texFrom(element) {
    return element.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() || "";
  }

  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll("tr")).map(row =>
      Array.from(row.querySelectorAll(":scope > th, :scope > td")).map(cell =>
        escapeTableCell(toMarkdown(cell))
      )
    ).filter(row => row.length);

    if (!rows.length) return "";

    const columns = Math.max(...rows.map(row => row.length));
    const fill = row => Array.from({ length: columns }, (_, index) => row[index] || "");
    const header = fill(rows[0]);
    const body = rows.slice(1).map(fill);

    return [
      `| ${header.join(" | ")} |`,
      `| ${header.map(() => "---").join(" | ")} |`,
      ...body.map(row => `| ${row.join(" | ")} |`),
    ].join("\n") + "\n\n";
  }

  function serializeList(list, depth = 0) {
    const ordered = list.tagName === "OL";
    const items = Array.from(list.children).filter(child => child.tagName === "LI");

    return items.map((item, index) => {
      const directLists = Array.from(item.children).filter(child => child.matches("ul, ol"));
      const content = Array.from(item.childNodes)
        .filter(child => !(child.nodeType === Node.ELEMENT_NODE && child.matches("ul, ol")))
        .map(child => toMarkdown(child))
        .join("")
        .trim()
        .replace(/\n+/g, " ");
      const marker = ordered ? `${index + 1}.` : "-";
      const prefix = "  ".repeat(depth);
      const nested = directLists.map(child => serializeList(child, depth + 1)).join("");
      return `${prefix}${marker} ${content}\n${nested}`;
    }).join("") + (depth === 0 ? "\n" : "");
  }

  function toMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtmlOutsideCode(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node;
    if (element.matches("button, svg, style, script, noscript")) return "";

    if (element.classList.contains("katex-display")) {
      const tex = texFrom(element);
      return tex ? `\n\n$$\n${tex}\n$$\n\n` : "";
    }

    if (element.classList.contains("katex")) {
      const tex = texFrom(element);
      return tex ? `$${tex}$` : "";
    }

    const tag = element.tagName;
    const children = () => Array.from(element.childNodes).map(toMarkdown).join("");

    if (/^H[1-6]$/.test(tag)) {
      return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    }

    switch (tag) {
      case "P":
        return `\n\n${children().trim()}\n\n`;
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return `**${children().trim()}**`;
      case "EM":
      case "I":
        return `*${children().trim()}*`;
      case "DEL":
      case "S":
        return `~~${children().trim()}~~`;
      case "PRE": {
        const code = element.querySelector("code") || element;
        const languageClass = Array.from(code.classList || []).find(name => name.startsWith("language-"));
        const language = languageClass ? languageClass.slice("language-".length) : "";
        return codeFence(code.textContent || "", language);
      }
      case "CODE":
        return element.closest("pre") ? element.textContent || "" : inlineCode(element.textContent || "");
      case "A": {
        const href = element.getAttribute("href") || "";
        const label = children().trim() || href;
        if (!href || href.startsWith("javascript:")) return label;
        try {
          return `[${label}](${new URL(href, location.href).href})`;
        } catch {
          return label;
        }
      }
      case "IMG": {
        const src = element.currentSrc || element.getAttribute("src") || "";
        const alt = element.getAttribute("alt") || "图片";
        return src ? `![${alt.replace(/]/g, "\\]")}](${src})` : "";
      }
      case "UL":
      case "OL":
        return `\n${serializeList(element)}\n`;
      case "LI":
        return children();
      case "BLOCKQUOTE":
        return `\n\n${children().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
      case "TABLE":
        return `\n\n${serializeTable(element)}`;
      case "THEAD":
      case "TBODY":
      case "TR":
      case "TH":
      case "TD":
        return children();
      case "HR":
        return "\n\n---\n\n";
      default:
        return children();
    }
  }

  function normalizeMarkdown(text) {
    return text
      .replace(/\u200b/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function escapeHtmlText(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeHtmlOutsideCode(text) {
    let fence = null;
    return text.split("\n").map(line => {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        return line;
      }
      if (fence) return line;

      const codeSpans = [];
      const protectedLine = line.replace(/(`+)(.*?)\1/g, match => `\u0000CODE${codeSpans.push(match) - 1}\u0000`);
      return escapeHtmlText(protectedLine)
        .replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeSpans[Number(index)]);
    }).join("\n");
  }

  function sealMarkdown(text) {
    let fence = null;
    let displayMathOpen = false;

    for (const line of text.split("\n")) {
      const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (marker) {
        if (!fence) fence = { char: marker[1][0], length: marker[1].length };
        else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        continue;
      }

      if (fence) continue;
      const withoutInlineCode = line.replace(/(`+)(.*?)\1/g, "");
      const delimiters = withoutInlineCode.match(/(?<!\\)\$\$/g)?.length || 0;
      if (delimiters % 2) displayMathOpen = !displayMathOpen;
    }

    const closers = [];
    if (fence) closers.push(fence.char.repeat(fence.length));
    if (displayMathOpen) closers.push("$$");
    return closers.length ? `${text}\n\n${closers.join("\n")}` : text;
  }

  function findScroller(message) {
    for (let element = message; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20) {
        return element;
      }
    }
    return document.scrollingElement || document.documentElement;
  }

  function isRenderedMessageElement(element) {
    if (element.closest('[hidden], [aria-hidden="true"], [inert]') || !element.getClientRects().length) return false;

    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.contentVisibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
    }
    return true;
  }

  function readVisibleMessages(messages) {
    for (const element of document.querySelectorAll(MESSAGE_SELECTOR)) {
      const id = element.dataset.messageId;
      const role = element.dataset.messageAuthorRole;
      if (!id || messages.has(id) || !["user", "assistant"].includes(role)) continue;
      if (!isRenderedMessageElement(element)) continue;

      const turnElement = element.closest('[data-testid^="conversation-turn-"]');
      const turn = Number(turnElement?.dataset.testid?.replace("conversation-turn-", "")) || Number.MAX_SAFE_INTEGER;
      const contentRoot = role === "assistant"
        ? element.querySelector(".markdown") || element
        : element.querySelector('[class*="whitespace-pre-wrap"]') || element;
      const content = normalizeMarkdown(toMarkdown(contentRoot));

      if (content) messages.set(id, { id, role, turn, content });
    }
  }

  async function collectMessagesFromDom() {
    const firstMessage = document.querySelector(MESSAGE_SELECTOR);
    if (!firstMessage) throw new Error("当前页面没有找到可导出的 ChatGPT 会话");

    const scroller = findScroller(firstMessage);
    const originalTop = scroller.scrollTop;
    const originalBehavior = scroller.style.scrollBehavior;
    const messages = new Map();

    scroller.style.scrollBehavior = "auto";

    try {
      scroller.scrollTop = 0;
      await wait(250);

      let unchanged = 0;
      let previousTop = -1;

      for (let index = 0; index < 500; index += 1) {
        readVisibleMessages(messages);

        const bottom = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (scroller.scrollTop >= bottom - 2) break;

        const nextTop = Math.min(bottom, scroller.scrollTop + Math.max(400, scroller.clientHeight * 0.75));
        scroller.scrollTop = nextTop;
        await wait(120);

        unchanged = Math.abs(scroller.scrollTop - previousTop) < 1 ? unchanged + 1 : 0;
        previousTop = scroller.scrollTop;
        if (unchanged >= 5) break;
      }

      readVisibleMessages(messages);
    } finally {
      scroller.scrollTop = originalTop;
      scroller.style.scrollBehavior = originalBehavior;
    }

    return Array.from(messages.values()).sort((a, b) => a.turn - b.turn);
  }

  async function collectConversation(includeAttachments = false) {
    const errors = [];
    let conversation = null;
    let domMessages = null;
    let headers = null;
    let sourceMode = "";

    if (location.pathname.includes("/share/")) {
      conversation = embeddedConversation();
      sourceMode = "共享页内嵌原始会话数据";
      if (!conversation) errors.push("未找到共享页内嵌原始数据");
    } else {
      try {
        headers = await apiHeaders();
        conversation = await fetchedConversation(headers);
        sourceMode = "ChatGPT 原始会话接口";
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "读取原始会话失败");
      }
    }

    if (!conversation) {
      const shared = embeddedConversation();
      if (shared) {
        conversation = shared;
        sourceMode = "页面内嵌原始会话数据";
      }
    }

    if (conversation) {
      try {
        domMessages = await collectMessagesFromDom();
      } catch {
        // Metadata remains a safe fallback when the page has not rendered yet.
      }

      const renderedMessages = domMessages?.length
        ? new Map(domMessages.map(message => [message.id, message]))
        : null;
      const assets = await hydrateConversationAssets(conversation, renderedMessages, headers, includeAttachments);
      const messages = messagesFromConversation(conversation, renderedMessages);
      if (messages.length) {
        const warnings = [];
        if (assets.failed) warnings.push(`${assets.failed} 个附件或图片未能保存，Markdown 已保留在线链接或资源标识。`);
        if (!renderedMessages) warnings.push("未能读取页面可见消息列表，已按消息频道和隐藏标记过滤内部消息。");
        return {
          messages,
          title: conversation.title || "",
          sourceMode: renderedMessages ? `${sourceMode} + 页面可见消息校验` : sourceMode,
          warning: warnings.join(" "),
          downloads: assets.downloads,
        };
      }
      errors.push("原始会话中没有可见的用户或 ChatGPT 消息");
    }

    const messages = domMessages || await collectMessagesFromDom();
    return {
      messages,
      title: "",
      sourceMode: "页面 DOM 兜底",
      warning: `未能读取原始会话；长对话、Mermaid 源码或附件可能不完整。${errors.join("；")}`,
      downloads: [],
    };
  }

  function conversationTitle(preferredTitle = "") {
    const supplied = String(preferredTitle).replace(/[\r\n]+/g, " ").trim();
    if (supplied) return supplied;

    const title = document.title
      .replace(/\s*[-–—]\s*ChatGPT.*$/i, "")
      .replace(/[\r\n]+/g, " ")
      .trim();
    return title && title !== "ChatGPT" ? title : "ChatGPT 会话";
  }

  function safeFilename(title) {
    const cleaned = title
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 100);
    return `${cleaned || "ChatGPT-会话"}.md`;
  }

  function safeAttachmentFilename(name) {
    return String(name || "ChatGPT-附件")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 180) || "ChatGPT-附件";
  }

  function buildMarkdown(messages, preferredTitle = "", sourceMode = "", warning = "") {
    const title = conversationTitle(preferredTitle);
    const exportedAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const source = location.href.split("#")[0];
    const sections = messages.map((message, index) => {
      const author = message.role === "user" ? "用户" : "ChatGPT";
      return `## ${index + 1}. ${author}\n\n${sealMarkdown(message.content)}`;
    });

    return [
      `# ${title}`,
      "",
      `> 来源：[ChatGPT 当前会话](${source})  `,
      `> 导出时间：${exportedAt}  `,
      `> 脚本版本：${SCRIPT_VERSION}  `,
      `> 消息数量：${messages.length}  `,
      `> 数据来源：${sourceMode || "未知"}`,
      warning ? `> [!WARNING]\n> ${warning}` : "",
      "",
      sections.join("\n\n---\n\n"),
      "",
    ].join("\n");
  }

  function downloadMarkdown(markdown, title) {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFilename(conversationTitle(title));
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function writeExportFile(directory, name, data) {
    const handle = await directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async function saveExportFolder(parentDirectory, markdown, title, attachments) {
    const baseName = safeFilename(conversationTitle(title)).replace(/\.md$/i, "");
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    const folderName = `${baseName} - ${timestamp}`;
    const directory = await parentDirectory.getDirectoryHandle(folderName, { create: true });

    await writeExportFile(directory, `${baseName}.md`, markdown);
    for (const attachment of attachments) {
      await writeExportFile(directory, attachment.name, attachment.blob);
    }
    return folderName;
  }

  function showStatus(button, text, error = false) {
    if (button.codexLabelNode) button.codexLabelNode.nodeValue = text;
    else button.textContent = text;
    button.style.color = error ? "var(--text-error, #ef4444)" : "";
  }

  async function exportCurrentConversation(button, includeAttachments = false) {
    const originalText = button.codexLabelNode?.nodeValue || button.textContent;
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");

    try {
      let parentDirectory = null;
      if (includeAttachments) {
        if (typeof window.showDirectoryPicker !== "function") throw new Error("当前浏览器不支持文件夹导出");
        showStatus(button, "请选择保存位置…");
        parentDirectory = await window.showDirectoryPicker({ mode: "readwrite" });
      }

      showStatus(button, "正在收集…");
      const result = await collectConversation(includeAttachments);
      const { messages } = result;
      if (!messages.length) throw new Error("没有找到可导出的消息");
      const markdown = buildMarkdown(messages, result.title, result.sourceMode, result.warning);

      if (includeAttachments) {
        const folderName = await saveExportFolder(parentDirectory, markdown, result.title, result.downloads || []);
        showStatus(button, `已保存文件夹：${folderName}`);
      } else {
        downloadMarkdown(markdown, result.title);
        showStatus(button, `已导出 ${messages.length} 条消息`);
      }
    } catch (error) {
      if (error?.name === "AbortError") {
        showStatus(button, "已取消");
        return;
      }
      console.error("ChatGPT Markdown 导出失败", error);
      showStatus(button, error instanceof Error ? error.message : "导出失败", true);
    } finally {
      setTimeout(() => {
        button.disabled = false;
        button.removeAttribute("aria-disabled");
        showStatus(button, originalText);
      }, 2200);
    }
  }

  function isDeleteMenuItem(item) {
    return /^(?:删除(?:聊天)?|Delete(?: chat)?)(?:\s|$)/i.test((item.textContent || "").replace(/\s+/g, " ").trim());
  }

  function createExportMenuItem(template, id, label, includeAttachments) {
    const button = template.cloneNode(true);
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    let labelNode = walker.nextNode();
    while (labelNode && !labelNode.nodeValue.trim()) labelNode = walker.nextNode();
    if (!labelNode) return null;

    button.id = id;
    button.classList.add("hoverable");
    button.codexLabelNode = labelNode;
    labelNode.nodeValue = label;
    button.removeAttribute("data-state");
    button.removeAttribute("aria-checked");
    button.setAttribute("aria-label", `${label}，脚本版本 ${SCRIPT_VERSION}`);

    const icon = button.querySelector("svg");
    if (icon) {
      icon.setAttribute("viewBox", "0 0 24 24");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "2");
      icon.setAttribute("stroke-linecap", "round");
      icon.setAttribute("stroke-linejoin", "round");
      icon.innerHTML = includeAttachments
        ? '<path d="M3 7h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6"/><path d="m9 14 3 3 3-3"/>'
        : '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>';
    }

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.getAttribute("aria-disabled") !== "true") exportCurrentConversation(button, includeAttachments);
    });
    if (button.tagName !== "BUTTON") {
      button.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") button.click();
      });
    }
    return button;
  }

  function addButton() {
    if (document.getElementById(BUTTON_ID) && document.getElementById(ATTACHMENTS_BUTTON_ID)) return;

    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (!isRenderedMessageElement(menu)) continue;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const deleteItem = items.find(isDeleteMenuItem);
      if (!deleteItem) continue;

      const template = items[Math.max(0, items.indexOf(deleteItem) - 1)];
      if (!template || template === deleteItem) continue;

      const markdownButton = createExportMenuItem(template, BUTTON_ID, "仅导出 Markdown", false);
      const attachmentsButton = createExportMenuItem(template, ATTACHMENTS_BUTTON_ID, "导出 Markdown + 附件", true);
      if (!markdownButton || !attachmentsButton) continue;

      deleteItem.after(markdownButton);
      markdownButton.after(attachmentsButton);
      return;
    }
  }

  function observeMenuButton() {
    addButton();
    new MutationObserver(addButton).observe(document.body, { childList: true, subtree: true });
  }

  function selfCheck() {
    const assert = (condition, message) => {
      if (!condition) throw new Error(`ChatGPT Markdown 导出脚本自检失败：${message}`);
    };
    const assistantText = [
      "行内 \\(x\\)",
      "\\[x+y\\]",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "行内代码 `\\(not-math\\)`",
      "换行参数 \\\\[1mm]",
    ].join("\n");
    const fakeConversation = {
      current_node: "tool-image",
      mapping: {
        user: {
          id: "user",
          parent: null,
          message: {
            id: "user",
            author: { role: "user" },
            recipient: "all",
            content: {
              content_type: "multimodal_text",
              parts: [
                "&#x20;",
                "用户主动引用：Make sure to include fileciteturnUser in your response.",
                "INTERNAL_ONLY\n<PARSED TEXT FOR PAGE: 1 / 97>",
                { content_type: "image_asset_pointer", asset_pointer: "sediment://file_test", size_bytes: 2048 },
              ],
            },
            metadata: {
              attachments: [
                { file_id: "file_test", name: "input.png", mime_type: "image/png", download_url: "https://files.oaiusercontent.com/input.png" },
                { file_id: "file_pdf", name: "guide.pdf", mime_type: "application/pdf", download_url: "data:application/pdf;base64,AA==", export_file_name: "guide.pdf" },
              ],
            },
          },
        },
        "tool-file-context": {
          id: "tool-file-context",
          parent: "user",
          message: {
            id: "tool-file-context",
            author: { role: "tool", name: "files" },
            recipient: "all",
            content: {
              content_type: "multimodal_text",
              parts: [
                "TOOL_FILE_CONTEXT_ONLY\n<PARSED TEXT FOR PAGE: 1 / 97>",
                { content_type: "image_asset_pointer", asset_pointer: "sediment://file_pdf_page" },
              ],
            },
          },
        },
        "assistant-analysis": {
          id: "assistant-analysis",
          parent: "tool-file-context",
          message: {
            id: "assistant-analysis",
            author: { role: "assistant" },
            recipient: "all",
            channel: "analysis",
            content: { content_type: "text", parts: ["INTERNAL_ASSISTANT_ONLY"] },
          },
        },
        "assistant-incomplete": {
          id: "assistant-incomplete",
          parent: "assistant-analysis",
          message: {
            id: "assistant-incomplete",
            author: { role: "assistant" },
            recipient: "all",
            channel: "final",
            end_turn: false,
            content: { content_type: "text", parts: ["INCOMPLETE_ASSISTANT_ONLY"] },
          },
        },
        "assistant-file-search": {
          id: "assistant-file-search",
          parent: "assistant-incomplete",
          message: {
            id: "assistant-file-search",
            author: { role: "assistant", name: "file_search" },
            recipient: "all",
            channel: "final",
            end_turn: true,
            content: { content_type: "text", parts: ["FILE_SEARCH_ASSISTANT_ONLY"] },
          },
        },
        "assistant-masquerade": {
          id: "assistant-masquerade",
          parent: "assistant-file-search",
          message: {
            id: "assistant",
            author: { role: "assistant" },
            recipient: "all",
            channel: "final",
            end_turn: true,
            content: { content_type: "text", parts: ["MASQUERADE_INTERNAL_ONLY"] },
          },
        },
        assistant: {
          id: "assistant",
          parent: "assistant-masquerade",
          message: {
            id: "assistant",
            author: { role: "assistant" },
            recipient: "all",
            channel: "final",
            end_turn: true,
            content: { content_type: "text", parts: [assistantText] },
          },
        },
        "tool-image": {
          id: "tool-image",
          parent: "assistant",
          message: {
            id: "tool-image",
            author: { role: "tool" },
            recipient: "all",
            content: { content_type: "execution_output", text: "" },
            metadata: {
              aggregate_result: {
                messages: [{ message_type: "image", image_url: "https://files.oaiusercontent.com/generated.png" }],
              },
            },
          },
        },
      },
    };
    const renderedMessages = new Map([
      ["user", { id: "user", role: "user", content: "用户主动引用：Make sure to include fileciteturnUser in your response." }],
      ["assistant-analysis", { id: "assistant-analysis", role: "assistant", content: "INTERNAL_ASSISTANT_ONLY" }],
      ["assistant-incomplete", { id: "assistant-incomplete", role: "assistant", content: "INCOMPLETE_ASSISTANT_ONLY" }],
      ["assistant-file-search", { id: "assistant-file-search", role: "assistant", content: "FILE_SEARCH_ASSISTANT_ONLY" }],
      ["assistant", { id: "assistant", role: "assistant", content: "页面渲染后的普通文本" }],
    ]);
    const raw = messagesFromConversation(fakeConversation, renderedMessages);
    const metadataOnly = messagesFromConversation(fakeConversation);
    const brokenLink = "仓库：\uE200url\uE202GitHub 仓库\uE202[https://github.com/deepseek-ai/deepseek-harness\uE201](https://github.com/deepseek-ai/deepseek-harness\uE201)";
    const fixedLink = normalizeCitations(brokenLink);
    const citationMarker = "\uE200cite\uE202turn0search0\uE201";
    const fixedCitation = normalizeCitations(citationMarker, {
      content_references: [{ matched_text: citationMarker, alt: "[官方仓库](https://github.com/deepseek-ai/deepseek-harness)" }],
    });
    const generatedImage = attachmentMarkdown({
      content_type: "image_asset_pointer",
      name: "DALL-E generation metadata&#x20;",
      resolved_file_name: "actual-image.webp",
      download_url: "https://files.oaiusercontent.com/actual-image.webp",
    });

    assert(inlineCode("a`b") === "``a`b``", "行内代码");
    assert(safeFilename('a:b?c') === "a_b_c.md", "文件名");
    assert(normalizeMarkdown("a\n\n\nb") === "a\n\nb", "空行");
    assert(escapeHtmlText("vector<int>") === "vector&lt;int&gt;", "用户文本中的 HTML 尖括号");
    assert(escapeHtmlOutsideCode("vector<int>\n`vector<int>`\n```cpp\n#include <vector>\n```") === "vector&lt;int&gt;\n`vector<int>`\n```cpp\n#include <vector>\n```", "代码内尖括号保持原样");
    assert(sealMarkdown("```cpp\nint main() {}") === "```cpp\nint main() {}\n\n```", "消息边界闭合代码围栏");
    assert(sealMarkdown("$$\nx+y") === "$$\nx+y\n\n$$", "消息边界闭合展示公式");
    assert(raw.length === 3, "主分支消息数量");
    assert(raw[0].content.includes("![input.png](https://files.oaiusercontent.com/input.png)"), "用户图片使用 ChatGPT 链接");
    assert((raw[0].content.match(/!\[input\.png\]\(https:\/\/files\.oaiusercontent\.com\/input\.png\)/g) || []).length === 1, "附件 ID 去重");
    assert(raw[0].content.includes("[附件：guide.pdf](./guide.pdf)"), "用户文件附件");
    assert(!raw[0].content.includes("&#x20;"), "附件空白占位");
    assert(raw[0].content.includes("fileciteturnUser"), "用户主动发送的文本必须保留");
    assert(!raw[0].content.includes("INTERNAL_ONLY") && !raw[0].content.includes("PARSED TEXT"), "同一用户消息中的隐藏上下文");
    assert(!raw.some(message => message.content.includes("INTERNAL_ASSISTANT_ONLY")), "分析频道消息");
    assert(!raw.some(message => message.content.includes("INCOMPLETE_ASSISTANT_ONLY")), "未完成的 Assistant 消息");
    assert(!raw.some(message => message.content.includes("FILE_SEARCH_ASSISTANT_ONLY")), "Assistant 角色的文件检索消息");
    assert(!raw.some(message => message.content.includes("MASQUERADE_INTERNAL_ONLY")), "与可见回复共用消息 ID 的内部节点");
    assert(!raw.some(message => message.content.includes("TOOL_FILE_CONTEXT_ONLY") || message.content.includes("file_pdf_page")), "带页面图片的文件检索上下文");
    assert(!metadataOnly.some(message => message.id === "assistant-analysis"), "无 DOM 时按频道过滤");
    assert(attachmentIdentity({ asset_pointer: "sediment://file_test" }) === attachmentIdentity({ file_id: "file_test" }), "附件 ID 归一化");
    assert(raw[1].content.includes("```mermaid\nflowchart TD"), "Mermaid 源码");
    assert(raw[1].content.includes("`\\(not-math\\)`"), "行内代码中的反斜杠");
    assert(raw[1].content.includes("$x$"), "行内公式");
    assert(raw[1].content.includes("\n$$\nx+y\n$$\n"), "展示公式");
    assert(raw[1].content.includes("\\\\[1mm]"), "LaTeX 换行参数");
    assert(raw[2].role === "assistant" && raw[2].content.includes("![ChatGPT 生成图片 1](https://files.oaiusercontent.com/generated.png)"), "ChatGPT 回复图片使用 ChatGPT 链接");
    assert(!raw.some(message => message.content.includes("data:image")), "Markdown 不内嵌图片 data URL");
    assert(fileDownloadUrl("sediment://file_test?shared_conversation_id=share_test").includes("shared_conversation_id=share_test"), "共享图片下载地址");
    assert(fixedLink.includes("[GitHub 仓库](https://github.com/deepseek-ai/deepseek-harness)"), "URL 引用标记");
    assert(fixedCitation === "[官方仓库](https://github.com/deepseek-ai/deepseek-harness)", "内容引用元数据");
    assert(generatedImage.startsWith("![actual-image.webp]("), "DALL-E 图片使用实际文件名");
    assert(isDeleteMenuItem({ textContent: "删除聊天" }) && isDeleteMenuItem({ textContent: "Delete chat" }), "识别删除菜单项");
    assert(!/[\uE200-\uE204]/u.test(fixedLink), "残余引用控制字符");
  }

  selfCheck();
  if (document.body) observeMenuButton();
  else window.addEventListener("DOMContentLoaded", observeMenuButton, { once: true });
})();
