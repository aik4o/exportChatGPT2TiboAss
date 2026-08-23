// ==UserScript==
// @name         ChatGPT 当前会话导出 Markdown
// @namespace    https://chatgpt.com/
// @version      3.2.2
// @description  从原始会话数据导出 Markdown，保留代码、Mermaid、公式、图片和附件。
// @match        https://chatgpt.com/*
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const BUTTON_ID = "codex-markdown-export-button";
  const BATCH_DIALOG_ID = "codex-batch-export-dialog";
  const BATCH_SUBMENU_ID = "codex-batch-export-submenu";
  const PROJECT_EXPORT_BUTTON_ID = "codex-project-export-button";
  const MESSAGE_SELECTOR = "[data-message-author-role][data-message-id]";
  const EXPORT_ATTACHMENTS_KEY = "export-attachments";
  const SCRIPT_VERSION = "3.2.2";
  let exportSettingsCommandId;
  let apiHeadersPromise;
  let conversationCache;

  function includeAttachmentsEnabled() {
    return GM_getValue(EXPORT_ATTACHMENTS_KEY, true);
  }

  function exportSettingsLabel(enabled) {
    return `导出设置：附件（${enabled ? "开启" : "关闭"}）`;
  }

  function registerExportSettings() {
    const enabled = includeAttachmentsEnabled();
    exportSettingsCommandId = GM_registerMenuCommand(exportSettingsLabel(enabled), () => {
      GM_setValue(EXPORT_ATTACHMENTS_KEY, !enabled);
      registerExportSettings();
    }, {
      id: exportSettingsCommandId,
      title: "点击切换导出时是否包含附件",
    });
  }

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

  async function loadApiHeaders() {
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

  function apiHeaders() {
    if (!apiHeadersPromise) {
      apiHeadersPromise = loadApiHeaders().catch(error => {
        apiHeadersPromise = null;
        throw error;
      });
    }
    return apiHeadersPromise;
  }

  function pageConversationRevision() {
    const messages = document.querySelectorAll(MESSAGE_SELECTOR);
    const last = messages[messages.length - 1];
    if (!last) return "";
    // ponytail: 廉价失效信号；只有同 ID、同长度的实时改写出现时才值得换完整内容哈希。
    return `${last.dataset.messageId || ""}:${last.textContent?.length || 0}:${last.querySelectorAll("img").length}`;
  }

  function isFreshConversationCache(cache, id, revision = pageConversationRevision()) {
    return cache?.id === id && cache.revision === revision;
  }

  async function fetchConversationById(id, headers) {
    const response = await fetch(`/backend-api/conversation/${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
      headers,
    });

    if (!response.ok) throw new Error(`读取会话失败（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data?.mapping || !data?.current_node) throw new Error("会话数据结构不完整");
    return data;
  }

  function fetchedConversation(headers) {
    const id = conversationId();
    if (!id) return Promise.resolve(null);
    const revision = pageConversationRevision();
    if (isFreshConversationCache(conversationCache, id, revision)) return conversationCache.promise;

    const promise = fetchConversationById(id, headers);

    conversationCache = { id, revision, promise };
    promise.catch(() => { if (conversationCache?.promise === promise) conversationCache = null; });
    return promise;
  }

  async function fetchConversationIndex(headers, maxItems = Number.POSITIVE_INFINITY) {
    const items = [];
    const seen = new Set();
    const limit = 100;
    let hasMore = false;

    for (let offset = 0; ; offset += limit) {
      const response = await fetch(`/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`, {
        credentials: "include",
        cache: "no-store",
        headers,
      });
      if (!response.ok) throw new Error(`读取对话列表失败（HTTP ${response.status}）`);
      const page = await response.json();
      const pageItems = Array.isArray(page.items) ? page.items : [];
      const novel = pageItems.filter(item => item?.id && !seen.has(item.id));
      novel.forEach(item => seen.add(item.id));
      items.push(...novel);
      if (!pageItems.length || pageItems.length < limit || !novel.length || (Number.isFinite(page.total) && items.length >= page.total)) break;
      if (items.length >= maxItems) {
        hasMore = true;
        break;
      }
    }
    return { items: items.slice(0, maxItems), hasMore };
  }

  async function fetchProjects(headers) {
    const projects = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    do {
      const params = new URLSearchParams({ conversations_per_gizmo: "0" });
      if (cursor != null) params.set("cursor", String(cursor));
      const response = await fetch(`/backend-api/gizmos/snorlax/sidebar?${params}`, {
        credentials: "include",
        cache: "no-store",
        headers,
      });
      if (!response.ok) throw new Error(`读取项目列表失败（HTTP ${response.status}）`);
      const page = await response.json();
      for (const item of Array.isArray(page.items) ? page.items : []) {
        const project = item?.gizmo?.gizmo || item?.gizmo || item;
        if (project?.id && !seenIds.has(project.id)) {
          seenIds.add(project.id);
          projects.push({ id: project.id, name: project.display?.name || project.name || "未命名项目" });
        }
      }
      cursor = page.cursor ?? null;
      if (cursor == null || seenCursors.has(String(cursor))) break;
      seenCursors.add(String(cursor));
    } while (true);
    return projects;
  }

  async function fetchProjectConversations(projectId, headers) {
    const items = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = 0;

    do {
      const params = new URLSearchParams({ cursor: String(cursor), limit: "50" });
      const response = await fetch(`/backend-api/gizmos/${encodeURIComponent(projectId)}/conversations?${params}`, {
        credentials: "include",
        cache: "no-store",
        headers,
      });
      if (!response.ok) throw new Error(`读取项目对话失败（HTTP ${response.status}）`);
      const page = await response.json();
      const pageItems = Array.isArray(page.items) ? page.items : [];
      const novel = pageItems.filter(item => item?.id && !seenIds.has(item.id));
      novel.forEach(item => seenIds.add(item.id));
      items.push(...novel);
      const next = page.cursor ?? null;
      if (!pageItems.length || next == null || seenCursors.has(String(next))) break;
      seenCursors.add(String(next));
      cursor = next;
    } while (true);
    return items;
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
    const lastNodeForMessageId = new Map();

    for (const node of path) {
      const message = node.message;
      const role = message?.author?.role;
      const id = message?.id || node.id;
      if (["user", "assistant"].includes(role) && exportedMessageRole(message, node.id, renderedMessages)) {
        lastNodeForMessageId.set(id, node);
      }
    }

    for (const node of path) {
      const message = node.message;
      const role = message?.author?.role;
      const id = message?.id || node.id;
      const exportRole = exportedMessageRole(message, node.id, renderedMessages);
      if (!exportRole) continue;
      if (["user", "assistant"].includes(role) && lastNodeForMessageId.get(id) !== node) continue;

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

  function collectMessagesFromDom() {
    const messages = new Map();
    readVisibleMessages(messages);
    if (!messages.size) throw new Error("当前页面没有找到可导出的 ChatGPT 会话");

    return Array.from(messages.values()).sort((a, b) => a.turn - b.turn);
  }

  async function collectConversation(includeAttachments = false) {
    const errors = [];
    let conversation = null;
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
      const assets = await hydrateConversationAssets(conversation, null, headers, includeAttachments);
      const messages = messagesFromConversation(conversation);
      if (messages.length) {
        const warnings = [];
        if (assets.failed) warnings.push(`${assets.failed} 个附件或图片未能保存，Markdown 已保留在线链接或资源标识。`);
        return {
          messages,
          title: conversation.title || "",
          sourceMode,
          warning: warnings.join(" "),
          downloads: assets.downloads,
        };
      }
      errors.push("原始会话中没有可见的用户或 ChatGPT 消息");
    }

    const messages = collectMessagesFromDom();
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

  function buildMarkdown(messages, preferredTitle = "", sourceMode = "", warning = "", sourceUrl = "") {
    const title = conversationTitle(preferredTitle);
    const exportedAt = new Date().toLocaleString("zh-CN", { hour12: false });
    const source = sourceUrl || location.href.split("#")[0];
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

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadMarkdown(markdown, title) {
    downloadBlob(
      new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      safeFilename(conversationTitle(title))
    );
  }

  async function downloadExportArchive(markdown, title, attachments) {
    if (typeof JSZip !== "function") throw new Error("压缩组件加载失败，请刷新页面后重试");
    const baseName = safeFilename(conversationTitle(title)).replace(/\.md$/i, "");
    const zip = new JSZip();
    const directory = zip.folder(baseName);

    directory.file(`${baseName}.md`, markdown);
    for (const attachment of attachments) {
      directory.file(attachment.name, attachment.blob);
    }
    // ponytail: 图片、PDF 等附件通常已压缩，STORE 优先速度；需要更小体积时再启用 DEFLATE。
    const blob = await zip.generateAsync({ type: "blob" });
    const archiveName = `${baseName}.zip`;
    downloadBlob(blob, archiveName);
    return archiveName;
  }

  async function mapConcurrent(items, limit, task) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index], index);
      }
    }));
    return results;
  }

  async function loadBatchGroups(projectName = "") {
    const headers = await apiHeaders();
    const [conversationIndex, projects] = await Promise.all([
      projectName ? Promise.resolve({ items: [], hasMore: false }) : fetchConversationIndex(headers, 100),
      fetchProjects(headers),
    ]);
    const regularItems = conversationIndex.items;
    // ponytail: 项目菜单只暴露名称；若 ChatGPT 允许重名项目，再按侧栏顺序补充 ID 匹配。
    const selectedProjects = projectName ? projects.filter(project => project.name === projectName).slice(0, 1) : projects;
    if (projectName && !selectedProjects.length) throw new Error(`未找到项目：${projectName}`);
    let projectGroups;
    if (projectName) {
      projectGroups = await mapConcurrent(selectedProjects, 1, async project => {
        try {
          return { id: project.id, name: project.name, items: await fetchProjectConversations(project.id, headers), loaded: true };
        } catch (error) {
          return { id: project.id, name: project.name, items: [], loaded: true, error: error instanceof Error ? error.message : "读取失败" };
        }
      });
    } else {
      const knownItems = new Map(selectedProjects.map(project => [project.id, []]));
      for (const item of regularItems) knownItems.get(item.gizmo_id)?.push(item);
      projectGroups = selectedProjects.map(project => ({
        id: project.id,
        name: project.name,
        items: knownItems.get(project.id),
        loaded: false,
      }));
    }

    const claimed = new Set(projectGroups.flatMap(group => group.items.map(item => item.id)));
    const groups = projectGroups.map(group => ({
      ...group,
      items: group.items.map(item => ({ ...item, groupName: group.name })),
    }));
    const ungrouped = regularItems
      .filter(item => !claimed.has(item.id))
      .map(item => ({ ...item, groupName: "其他对话" }));
    if (!projectName && (ungrouped.length || conversationIndex.hasMore)) {
      groups.unshift({
        id: "",
        name: "其他对话",
        items: ungrouped,
        loaded: !conversationIndex.hasMore,
        projectIds: new Set(projects.map(project => project.id)),
      });
    }
    return { headers, groups };
  }

  async function exportBatchConversations(items, includeAttachments, onProgress) {
    if (typeof JSZip !== "function") throw new Error("压缩组件加载失败，请刷新页面后重试");
    const headers = await apiHeaders();
    const zip = new JSZip();
    const root = zip.folder("ChatGPT 批量导出");
    const failures = [];
    let completed = 0;
    let exported = 0;

    await mapConcurrent(items, includeAttachments ? 2 : 4, async item => {
      try {
        const conversation = await fetchConversationById(item.id, headers);
        const assets = await hydrateConversationAssets(conversation, null, headers, includeAttachments);
        const messages = messagesFromConversation(conversation);
        if (!messages.length) throw new Error("没有可导出的消息");

        const warnings = assets.failed
          ? `${assets.failed} 个附件或图片未能保存，Markdown 已保留在线链接或资源标识。`
          : "";
        const title = conversation.title || item.title || "ChatGPT 会话";
        const baseName = safeFilename(conversationTitle(title)).replace(/\.md$/i, "");
        const uniqueName = `${baseName} - ${String(item.id).slice(0, 8)}`;
        const groupName = safeAttachmentFilename(item.groupName || "其他对话");
        const markdown = buildMarkdown(
          messages,
          title,
          "ChatGPT 原始会话接口（批量）",
          warnings,
          `${location.origin}/c/${encodeURIComponent(item.id)}`
        );

        if (includeAttachments) {
          const directory = root.folder(`${groupName}/${uniqueName}`);
          directory.file(`${baseName}.md`, markdown);
          for (const attachment of assets.downloads) directory.file(attachment.name, attachment.blob);
        } else {
          root.folder(groupName).file(`${uniqueName}.md`, markdown);
        }
        exported += 1;
      } catch (error) {
        failures.push(`${item.title || item.id}：${error instanceof Error ? error.message : "导出失败"}`);
      } finally {
        completed += 1;
        onProgress?.(completed, items.length);
      }
    });

    if (!exported) throw new Error(failures[0] || "没有成功导出任何对话");
    if (failures.length) root.file("_导出失败.txt", failures.join("\n"));
    const blob = await zip.generateAsync({ type: "blob" });
    const archiveName = `ChatGPT 批量导出 ${new Date().toISOString().slice(0, 10)}.zip`;
    downloadBlob(blob, archiveName);
    return { archiveName, exported, failed: failures.length };
  }

  function ensureBatchExportStyle() {
    if (document.getElementById(`${BATCH_DIALOG_ID}-style`)) return;
    const style = document.createElement("style");
    style.id = `${BATCH_DIALOG_ID}-style`;
    style.textContent = `
      #${BATCH_DIALOG_ID} { color-scheme: light dark; position: fixed; inset: 0; width: min(760px, calc(100vw - 32px)); height: fit-content; max-height: min(760px, calc(100vh - 32px)); margin: auto; padding: 0; color: var(--text-primary, #0d0d0d); background: var(--main-surface-primary, #fff); border: 1px solid var(--border-medium, rgba(0,0,0,.15)); border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.28); }
      #${BATCH_DIALOG_ID}::backdrop { background: rgba(0,0,0,.5); backdrop-filter: blur(2px); }
      #${BATCH_DIALOG_ID} .codex-batch-layout { display: flex; flex-direction: column; max-height: min(760px, calc(100vh - 32px)); }
      #${BATCH_DIALOG_ID} .codex-batch-header, #${BATCH_DIALOG_ID} .codex-batch-toolbar, #${BATCH_DIALOG_ID} .codex-batch-footer { display: flex; align-items: center; gap: 12px; padding: 14px 18px; }
      #${BATCH_DIALOG_ID} .codex-batch-header { justify-content: space-between; border-bottom: 1px solid var(--border-light, rgba(0,0,0,.1)); }
      #${BATCH_DIALOG_ID} h2 { margin: 0; font-size: 18px; }
      #${BATCH_DIALOG_ID} button, #${BATCH_DIALOG_ID} input { font: inherit; }
      #${BATCH_DIALOG_ID} button { color: inherit; background: transparent; border: 0; border-radius: 9px; padding: 8px 12px; cursor: pointer; }
      #${BATCH_DIALOG_ID} button:hover { background: var(--surface-hover, rgba(0,0,0,.08)); }
      #${BATCH_DIALOG_ID} button:disabled { cursor: default; opacity: .5; }
      #${BATCH_DIALOG_ID} [data-export] { color: white; background: #10a37f; }
      #${BATCH_DIALOG_ID} [data-export]:hover { background: #0d8f70; }
      #${BATCH_DIALOG_ID} .codex-batch-toolbar { flex-wrap: wrap; border-bottom: 1px solid var(--border-light, rgba(0,0,0,.1)); }
      #${BATCH_DIALOG_ID} [data-search] { flex: 1 1 260px; min-width: 0; color: inherit; background: var(--main-surface-secondary, rgba(0,0,0,.04)); border: 1px solid var(--border-medium, rgba(0,0,0,.15)); border-radius: 10px; padding: 9px 11px; }
      #${BATCH_DIALOG_ID} .codex-batch-list { flex: 1; overflow: auto; padding: 10px 12px; }
      #${BATCH_DIALOG_ID} .codex-batch-group { margin-bottom: 10px; border: 1px solid var(--border-light, rgba(0,0,0,.1)); border-radius: 12px; overflow: hidden; }
      #${BATCH_DIALOG_ID} .codex-batch-group-title { display: flex; gap: 9px; align-items: center; padding: 10px 12px; font-weight: 600; background: var(--main-surface-secondary, rgba(0,0,0,.04)); }
      #${BATCH_DIALOG_ID} [data-load-project] { margin-inline-start: auto; padding: 4px 8px; font-weight: 400; }
      #${BATCH_DIALOG_ID} .codex-batch-row { display: flex; gap: 9px; align-items: center; padding: 9px 12px 9px 34px; cursor: pointer; }
      #${BATCH_DIALOG_ID} .codex-batch-row:hover { background: var(--surface-hover, rgba(0,0,0,.06)); }
      #${BATCH_DIALOG_ID} .codex-batch-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${BATCH_DIALOG_ID} .codex-batch-error { padding: 10px 12px 10px 34px; color: var(--text-error, #ef4444); }
      #${BATCH_DIALOG_ID} .codex-batch-footer { justify-content: space-between; border-top: 1px solid var(--border-light, rgba(0,0,0,.1)); }
      #${BATCH_DIALOG_ID} [data-status] { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;
    document.head.appendChild(style);
  }

  function openBatchExportDialog(projectName = "") {
    if (typeof projectName !== "string") projectName = "";
    const existing = document.getElementById(BATCH_DIALOG_ID);
    if (existing) {
      if (!existing.open) existing.showModal();
      return;
    }
    ensureBatchExportStyle();

    const dialog = document.createElement("dialog");
    dialog.id = BATCH_DIALOG_ID;
    dialog.innerHTML = `
      <div class="codex-batch-layout">
        <div class="codex-batch-header"><h2>${projectName ? `导出项目：${escapeHtml(projectName)}` : "批量导出"}</h2><button type="button" data-close aria-label="关闭">✕</button></div>
        <div class="codex-batch-toolbar">
          <input type="search" data-search placeholder="搜索对话或项目" aria-label="搜索对话或项目">
          <label><input type="checkbox" data-select-all> 全选当前结果</label>
        </div>
        <div class="codex-batch-list" data-list><div class="codex-batch-row">正在读取对话和项目…</div></div>
        <div class="codex-batch-footer"><span data-status>加载中…</span><button type="button" data-export disabled>导出选中</button></div>
      </div>`;
    document.body.appendChild(dialog);

    const list = dialog.querySelector("[data-list]");
    const search = dialog.querySelector("[data-search]");
    const selectAll = dialog.querySelector("[data-select-all]");
    const status = dialog.querySelector("[data-status]");
    const exportButton = dialog.querySelector("[data-export]");
    const closeButton = dialog.querySelector("[data-close]");
    let exporting = false;

    const rows = () => Array.from(dialog.querySelectorAll(".codex-batch-row[data-title]"));
    const updateSelection = () => {
      const allRows = rows();
      const visibleRows = allRows.filter(row => !row.hidden);
      const checked = allRows.filter(row => row.querySelector("input").checked);
      for (const section of dialog.querySelectorAll(".codex-batch-group")) {
        const groupRows = Array.from(section.querySelectorAll(".codex-batch-row[data-title]"));
        const selected = groupRows.filter(row => row.querySelector("input").checked).length;
        const groupCheckbox = section.querySelector(".codex-batch-group-title input");
        groupCheckbox.checked = !!groupRows.length && selected === groupRows.length;
        groupCheckbox.indeterminate = selected > 0 && selected < groupRows.length;
      }
      const visibleChecked = visibleRows.filter(row => row.querySelector("input").checked).length;
      selectAll.checked = !!visibleRows.length && visibleChecked === visibleRows.length;
      selectAll.indeterminate = visibleChecked > 0 && visibleChecked < visibleRows.length;
      exportButton.disabled = exporting || !checked.length;
      if (!exporting) status.textContent = `已选择 ${checked.length} / ${allRows.length} 个对话`;
    };

    closeButton.addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (exporting) event.preventDefault(); });
    dialog.addEventListener("close", () => dialog.remove());
    search.addEventListener("input", () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const row of rows()) row.hidden = !!query && !row.dataset.title.includes(query);
      for (const section of dialog.querySelectorAll(".codex-batch-group")) {
        const titleMatches = section.dataset.title.includes(query);
        if (titleMatches) for (const row of section.querySelectorAll(".codex-batch-row[data-title]")) row.hidden = false;
        section.hidden = !Array.from(section.querySelectorAll(".codex-batch-row[data-title]")).some(row => !row.hidden);
      }
      updateSelection();
    });
    selectAll.addEventListener("change", () => {
      for (const row of rows().filter(row => !row.hidden)) row.querySelector("input").checked = selectAll.checked;
      updateSelection();
    });

    exportButton.addEventListener("click", async () => {
      const selected = rows().filter(row => row.querySelector("input").checked).map(row => row.codexConversation);
      if (!selected.length) return;
      exporting = true;
      closeButton.disabled = true;
      search.disabled = true;
      selectAll.disabled = true;
      exportButton.disabled = true;
      list.inert = true;
      try {
        const result = await exportBatchConversations(selected, includeAttachmentsEnabled(), (done, total) => {
          status.textContent = `正在导出 ${done} / ${total}…`;
        });
        status.textContent = `已导出 ${result.exported} 个对话${result.failed ? `，失败 ${result.failed} 个` : ""}`;
        exportButton.textContent = "导出完成";
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : "批量导出失败";
        status.style.color = "var(--text-error, #ef4444)";
      } finally {
        exporting = false;
        closeButton.disabled = false;
        search.disabled = false;
        selectAll.disabled = false;
        list.inert = false;
        exportButton.disabled = !selected.length;
      }
    });

    dialog.showModal();
    void loadBatchGroups(projectName).then(({ headers, groups }) => {
      if (!dialog.isConnected) return;
      list.replaceChildren();
      const fragment = document.createDocumentFragment();
      const appendRow = (section, item, checked = false) => {
        const row = document.createElement("label");
        row.className = "codex-batch-row";
        row.dataset.title = `${item.title || "未命名对话"} ${section.codexGroup.name}`.toLocaleLowerCase();
        row.codexConversation = item;
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = checked;
        checkbox.addEventListener("change", updateSelection);
        const title = document.createElement("span");
        title.textContent = item.title || "未命名对话";
        title.title = title.textContent;
        row.append(checkbox, title);
        section.appendChild(row);
      };
      const loadProjectSection = async (section, selectAfter = false) => {
        const group = section.codexGroup;
        const groupCheckbox = section.querySelector(".codex-batch-group-title input");
        if (group.loaded) {
          if (selectAfter) for (const row of section.querySelectorAll(".codex-batch-row[data-title]")) row.querySelector("input").checked = true;
          updateSelection();
          return;
        }
        if (group.loadingPromise) return group.loadingPromise;

        const selectedIds = new Set(Array.from(section.querySelectorAll(".codex-batch-row[data-title]"))
          .filter(row => row.querySelector("input").checked)
          .map(row => row.codexConversation.id));
        const loadButton = section.querySelector("[data-load-project]");
        groupCheckbox.disabled = true;
        if (loadButton) {
          loadButton.disabled = true;
          loadButton.textContent = "加载中…";
        }
        status.style.color = "";
        status.textContent = `正在加载“${group.name}”…`;

        const loadItems = group.id
          ? fetchProjectConversations(group.id, headers)
          : fetchConversationIndex(headers).then(result => result.items.filter(item => !group.projectIds.has(item.gizmo_id)));
        group.loadingPromise = loadItems.then(items => {
          group.items = items.map(item => ({ ...item, groupName: group.name }));
          group.loaded = true;
          for (const row of section.querySelectorAll(".codex-batch-row[data-title]")) row.remove();
          for (const item of group.items) appendRow(section, item, selectAfter || selectedIds.has(item.id));
          section.querySelector("[data-group-label]").textContent = `${group.name}（${group.items.length}）`;
          loadButton?.remove();
          groupCheckbox.disabled = false;
          updateSelection();
        }).catch(error => {
          groupCheckbox.disabled = false;
          groupCheckbox.checked = false;
          if (loadButton) {
            loadButton.disabled = false;
            loadButton.textContent = "重试";
          }
          updateSelection();
          status.textContent = error instanceof Error ? error.message : "读取项目对话失败";
          status.style.color = "var(--text-error, #ef4444)";
        }).finally(() => { group.loadingPromise = null; });
        return group.loadingPromise;
      };

      for (const group of groups) {
        const section = document.createElement("section");
        section.className = "codex-batch-group";
        section.dataset.title = group.name.toLocaleLowerCase();
        section.codexGroup = group;
        const heading = document.createElement("label");
        heading.className = "codex-batch-group-title";
        const groupCheckbox = document.createElement("input");
        groupCheckbox.type = "checkbox";
        const groupLabel = document.createElement("span");
        groupLabel.dataset.groupLabel = "";
        groupLabel.textContent = `${group.name}（${group.items.length}${group.loaded ? "" : "+"}）`;
        heading.append(groupCheckbox, groupLabel);
        if (!group.loaded) {
          const loadButton = document.createElement("button");
          loadButton.type = "button";
          loadButton.dataset.loadProject = "";
          loadButton.textContent = "加载全部";
          loadButton.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            void loadProjectSection(section);
          });
          heading.appendChild(loadButton);
        }
        section.appendChild(heading);
        groupCheckbox.addEventListener("change", () => {
          if (groupCheckbox.checked && !group.loaded) {
            void loadProjectSection(section, true);
            return;
          }
          for (const row of section.querySelectorAll(".codex-batch-row[data-title]")) row.querySelector("input").checked = groupCheckbox.checked;
          updateSelection();
        });

        for (const item of group.items) appendRow(section, item);
        if (group.error) {
          const error = document.createElement("div");
          error.className = "codex-batch-error";
          error.textContent = group.error;
          section.appendChild(error);
        }
        fragment.appendChild(section);
      }
      list.appendChild(fragment);
      updateSelection();
      if (projectName) {
        const section = Array.from(dialog.querySelectorAll(".codex-batch-group"))
          .find(candidate => candidate.codexGroup.name === projectName);
        if (!section) throw new Error(`未找到项目：${projectName}`);
        const projectRows = Array.from(section.querySelectorAll(".codex-batch-row[data-title]"));
        if (!projectRows.length) throw new Error(section.codexGroup.error || "项目中没有可导出的对话");
        for (const row of projectRows) row.querySelector("input").checked = true;
        updateSelection();
        exportButton.click();
      }
    }).catch(error => {
      if (!dialog.isConnected) return;
      list.textContent = "";
      status.textContent = error instanceof Error ? error.message : "读取对话列表失败";
      status.style.color = "var(--text-error, #ef4444)";
    });
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
      showStatus(button, "正在收集…");
      const result = await collectConversation(includeAttachments);
      const { messages } = result;
      if (!messages.length) throw new Error("没有找到可导出的消息");
      const markdown = buildMarkdown(messages, result.title, result.sourceMode, result.warning);

      if (includeAttachments) {
        showStatus(button, "正在生成压缩包…");
        const archiveName = await downloadExportArchive(markdown, result.title, result.downloads || []);
        showStatus(button, `已导出：${archiveName}`);
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

  function createExportMenuItem(template, id, label, action) {
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
      icon.innerHTML = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>';
    }

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      if (button.getAttribute("aria-disabled") !== "true") action(button);
    });
    if (button.tagName !== "BUTTON") {
      button.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") button.click();
      });
    }
    return button;
  }

  function closeNativeMenu(menu) {
    document.getElementById(menu.getAttribute("aria-labelledby"))?.click();
  }

  function projectNameFromLabel(label) {
    return label.match(/^打开\s*[“"]?(.+?)[”"]?\s*的项目选项$/)?.[1]?.trim() || "";
  }

  function projectNameFromMenu(menu) {
    const label = document.getElementById(menu.getAttribute("aria-labelledby"))?.getAttribute("aria-label") || "";
    return projectNameFromLabel(label);
  }

  function addBatchSubmenu(menu, exportButton, template) {
    document.getElementById(BATCH_SUBMENU_ID)?.remove();
    const submenu = menu.cloneNode(false);
    submenu.id = BATCH_SUBMENU_ID;
    submenu.removeAttribute("aria-labelledby");
    submenu.removeAttribute("style");
    submenu.setAttribute("aria-label", "导出方式");
    submenu.hidden = true;
    submenu.codexOwner = exportButton;
    Object.assign(submenu.style, { position: "fixed", zIndex: "10000" });

    let hideTimer;
    const hide = immediate => {
      clearTimeout(hideTimer);
      const close = () => {
        submenu.hidden = true;
        exportButton.setAttribute("aria-expanded", "false");
      };
      if (immediate) close();
      else hideTimer = setTimeout(close, 140);
    };
    const show = () => {
      clearTimeout(hideTimer);
      if (!exportButton.isConnected) return;
      const rect = exportButton.getBoundingClientRect();
      const width = Math.max(160, menu.getBoundingClientRect().width);
      submenu.style.width = `${width}px`;
      submenu.style.minWidth = `${width}px`;
      submenu.hidden = false;
      const left = rect.left - width - 6 >= 8 ? rect.left - width - 6 : Math.min(innerWidth - width - 8, rect.right + 6);
      submenu.style.left = `${Math.max(8, left)}px`;
      submenu.style.top = `${Math.max(8, Math.min(rect.top, innerHeight - submenu.offsetHeight - 8))}px`;
      exportButton.setAttribute("aria-expanded", "true");
    };

    const batchButton = createExportMenuItem(template, `${BATCH_SUBMENU_ID}-button`, "批量导出", () => {
      hide(true);
      closeNativeMenu(menu);
      openBatchExportDialog();
    });
    if (!batchButton) return;
    submenu.appendChild(batchButton);
    document.body.appendChild(submenu);

    const chevron = menu.querySelector('[data-testid="menu-item-submenu-chevron"]')?.cloneNode(true);
    if (chevron) {
      chevron.removeAttribute("data-testid");
      exportButton.appendChild(chevron);
    }
    exportButton.setAttribute("aria-haspopup", "menu");
    exportButton.setAttribute("aria-expanded", "false");
    exportButton.setAttribute("aria-controls", BATCH_SUBMENU_ID);
    exportButton.addEventListener("mouseenter", show);
    exportButton.addEventListener("mouseleave", () => hide(false));
    exportButton.addEventListener("focus", show);
    exportButton.addEventListener("blur", () => hide(false));
    exportButton.addEventListener("click", () => hide(true));
    exportButton.addEventListener("keydown", event => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        show();
        batchButton.focus();
      }
    });
    submenu.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    submenu.addEventListener("mouseleave", () => hide(false));
  }

  function addProjectExportButton(menu) {
    if (menu.querySelector(`#${PROJECT_EXPORT_BUTTON_ID}`)) return true;
    const projectName = projectNameFromMenu(menu);
    if (!projectName) return false;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const projectHome = items.find(item => /^(?:项目主页|Project home)$/i.test((item.textContent || "").trim()));
    const template = projectHome || items[0];
    if (!template) return false;
    const button = createExportMenuItem(template, PROJECT_EXPORT_BUTTON_ID, "导出项目", () => {
      closeNativeMenu(menu);
      openBatchExportDialog(projectName);
    });
    if (!button) return false;
    template.after(button);
    return true;
  }

  function addButton() {
    const staleSubmenu = document.getElementById(BATCH_SUBMENU_ID);
    if (staleSubmenu?.codexOwner && !staleSubmenu.codexOwner.isConnected) staleSubmenu.remove();

    for (const menu of document.querySelectorAll('[role="menu"]')) {
      if (!isRenderedMessageElement(menu)) continue;
      if (addProjectExportButton(menu)) continue;
      if (menu.querySelector(`#${BUTTON_ID}`)) continue;
      const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      const deleteItem = items.find(isDeleteMenuItem);
      if (!deleteItem) continue;

      const template = items[Math.max(0, items.indexOf(deleteItem) - 1)];
      if (!template || template === deleteItem) continue;

      const exportButton = createExportMenuItem(template, BUTTON_ID, "导出", button => {
        exportCurrentConversation(button, includeAttachmentsEnabled());
      });
      if (!exportButton) continue;

      deleteItem.after(exportButton);
      addBatchSubmenu(menu, exportButton, template);
      if (!location.pathname.includes("/share/")) void apiHeaders().then(fetchedConversation).catch(() => {});
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
    assert(`${safeFilename("测试会话").replace(/\.md$/i, "")}.zip` === "测试会话.zip", "压缩包名称");
    assert(exportSettingsLabel(true).includes("开启") && exportSettingsLabel(false).includes("关闭"), "附件导出设置标签");
    assert(isFreshConversationCache({ id: "chat", revision: "v1" }, "chat", "v1") && !isFreshConversationCache({ id: "chat", revision: "v1" }, "chat", "v2"), "会话预取缓存失效");
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
    assert(!metadataOnly.some(message => message.content.includes("MASQUERADE_INTERNAL_ONLY")), "原始接口消息 ID 去重");
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
    assert(projectNameFromLabel("打开 八股 的项目选项") === "八股", "识别项目菜单名称");
    assert(!/[\uE200-\uE204]/u.test(fixedLink), "残余引用控制字符");
  }

  async function selfCheckBatch() {
    const values = await mapConcurrent([1, 2, 3], 2, async value => value * 2);
    if (values.join(",") !== "2,4,6") throw new Error("ChatGPT Markdown 导出脚本自检失败：批量并发顺序");
    const zip = new JSZip();
    zip.folder("ChatGPT 批量导出").folder("测试项目").folder("测试对话").file("测试对话.md", "test");
    if (!zip.file("ChatGPT 批量导出/测试项目/测试对话/测试对话.md")) throw new Error("ChatGPT Markdown 导出脚本自检失败：项目与对话文件夹层级");
  }

  selfCheck();
  void selfCheckBatch();
  registerExportSettings();
  GM_registerMenuCommand("批量导出…", () => openBatchExportDialog(), { title: "选择对话或整个项目并导出 ZIP" });
  if (!location.pathname.includes("/share/")) void apiHeaders().then(fetchedConversation).catch(() => {});
  if (document.body) observeMenuButton();
  else window.addEventListener("DOMContentLoaded", observeMenuButton, { once: true });
})();
