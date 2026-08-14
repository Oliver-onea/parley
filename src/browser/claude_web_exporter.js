/*
 * Claude Web conversation exporter.
 *
 * Run this in the Claude Web page context, for example from DevTools Console on
 * https://claude.ai/chat/<conversation-uuid>. It does not scroll the page. It
 * searches Claude's in-browser caches for the current conversation JSON, then
 * downloads image previews with the browser's existing same-origin session and
 * saves a zip containing Markdown, raw JSON, manifest, and assets/.
 */
(async () => {
  "use strict";

  const ORIGIN = "https://claude.ai";
  const encoder = new TextEncoder();

  function log(...args) {
    console.log("[claude-export]", ...args);
  }

  function conversationIdFromLocation() {
    return (
      location.pathname.match(/\/chat\/([0-9a-f-]{32,36})/i)?.[1] ||
      location.pathname.match(/\/share\/([0-9a-f-]{32,36})/i)?.[1] ||
      ""
    );
  }

  function safeName(value, fallback = "file") {
    const clean = String(value || fallback)
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 140);
    return clean || fallback;
  }

  function roleName(sender) {
    return { human: "You", user: "You", assistant: "Claude" }[sender] || sender || "unknown";
  }

  function scalar(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join("\n\n");
    if (content && typeof content === "object") {
      if (content.text) return String(content.text);
      if (content.thinking) return String(content.thinking);
      if (content.content) return extractText(content.content);
    }
    return "";
  }

  function fencedJson(value) {
    return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
  }

  function renderBlock(block) {
    if (!block || typeof block !== "object") return scalar(block);
    const type = block.type || "unknown";
    if (type === "text") return block.text || "";
    if (type === "thinking" || type === "redacted_thinking") {
      const text = block.thinking || block.text || "";
      return text ? `**[Thinking]**\n\n${text}` : "";
    }
    if (type === "tool_use") {
      return `**[Tool use: ${block.name || "tool"}]**\n\n${fencedJson(block.input || {})}`;
    }
    if (type === "tool_result") {
      const text = extractText(block.content);
      return `**[Tool result: ${block.name || block.tool_use_id || "tool"}]**\n\n${text || fencedJson(block)}`;
    }
    const text = extractText(block.content);
    return text ? `**[${type}]**\n\n${text}` : `**[${type}]**\n\n${fencedJson(block)}`;
  }

  function sortMessages(messages) {
    return [...messages].sort((a, b) => {
      const ai = Number.isFinite(a?.index) ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = Number.isFinite(b?.index) ? b.index : Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return Date.parse(a?.created_at || "") - Date.parse(b?.created_at || "");
    });
  }

  function absoluteClaudeUrl(url) {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith("/")) return `${ORIGIN}${url}`;
    return url;
  }

  function isAssetItem(item) {
    if (!item || typeof item !== "object") return false;
    const kind = item.file_kind || item.kind || item.type || item.mime_type || "";
    return Boolean(
      kind === "image" ||
        item.preview_url ||
        item.preview_asset?.url ||
        item.thumbnail_url ||
        item.thumbnail_asset?.url ||
        item.url ||
        item.download_url,
    );
  }

  function collectAssets(messages) {
    const assets = [];
    for (const message of messages) {
      const candidates = [...(message.files || []), ...(message.attachments || [])];
      for (const item of candidates) {
        if (!isAssetItem(item)) continue;
        const ordinal = assets.length + 1;
        const fileName = item.file_name || item.name || item.filename || item.file_uuid || item.uuid || "file";
        const localName = `${String(ordinal).padStart(4, "0")}-${safeName(fileName)}`;
        assets.push({
          ordinal,
          message_index: message.index ?? null,
          message_uuid: message.uuid || "",
          sender: message.sender || "",
          file_name: fileName,
          file_uuid: item.file_uuid || item.uuid || "",
          file_kind: item.file_kind || item.kind || item.type || item.mime_type || "file",
          width: item.preview_asset?.image_width || item.thumbnail_asset?.image_width || null,
          height: item.preview_asset?.image_height || item.thumbnail_asset?.image_height || null,
          preview_url: absoluteClaudeUrl(item.preview_url || item.preview_asset?.url || item.url || item.download_url),
          thumbnail_url: absoluteClaudeUrl(item.thumbnail_url || item.thumbnail_asset?.url),
          local_path: `assets/${localName}`,
          downloaded: false,
          status: "pending",
        });
      }
    }
    return assets;
  }

  function assetsForMessage(assets, message) {
    return assets.filter((asset) => asset.message_uuid && asset.message_uuid === message.uuid);
  }

  function renderNonAssetAttachments(message) {
    const candidates = [...(message.files || []), ...(message.attachments || [])].filter((item) => !isAssetItem(item));
    if (!candidates.length) return "";
    const lines = ["**Attachments:**"];
    for (const item of candidates) {
      if (!item || typeof item !== "object") {
        lines.push(`- ${scalar(item)}`);
        continue;
      }
      const bits = [String(item.file_name || item.name || item.filename || item.id || "attachment")];
      if (item.file_type) bits.push(String(item.file_type));
      if (item.file_size != null) bits.push(`${item.file_size} bytes`);
      lines.push(`- ${bits.join(" | ")}`);
      if (item.extracted_content) {
        lines.push("", "```text", String(item.extracted_content).trim(), "```");
      }
    }
    return lines.join("\n");
  }

  function renderAssetList(items) {
    if (!items.length) return "";
    const lines = ["**Files:**"];
    for (const asset of items) {
      if (asset.downloaded) {
        lines.push(`![${asset.file_name}](${asset.local_path})`);
      } else {
        const dim = asset.width && asset.height ? `, ${asset.width}x${asset.height}` : "";
        lines.push(`- ${asset.file_name} (${asset.file_kind}${dim})`);
        if (asset.preview_url) lines.push(`  - Preview: ${asset.preview_url}`);
        lines.push(`  - Status: ${asset.status}`);
      }
    }
    return lines.join("\n");
  }

  function renderMessage(message, ordinal, assets) {
    const heading = [`### ${roleName(message.sender || message.role)}`, `(${message.index ?? ordinal})`];
    if (message.created_at) heading.push(`- ${message.created_at}`);
    const parts = [];
    const content = Array.isArray(message.content) ? message.content : [message.content].filter(Boolean);
    for (const block of content) {
      const rendered = renderBlock(block);
      if (rendered) parts.push(rendered);
    }
    if (!parts.length && message.text) parts.push(message.text);
    const fileBlock = renderAssetList(assetsForMessage(assets, message));
    if (fileBlock) parts.push(fileBlock);
    const attachmentBlock = renderNonAssetAttachments(message);
    if (attachmentBlock) parts.push(attachmentBlock);
    if (message.truncated) parts.push("**[Message marked truncated by Claude]**");
    return [
      heading.join(" "),
      message.uuid ? `<!-- message_uuid: ${message.uuid} -->` : "",
      "",
      parts.join("\n\n").trim() || "_(empty)_",
    ]
      .filter((line, index) => index === 2 || line)
      .join("\n");
  }

  function renderMarkdown(data, messages, assets) {
    const lines = [
      `# ${data.name || data.title || "Claude conversation"}`,
      "",
      `- Source: ${location.href}`,
      `- Conversation UUID: ${data.uuid || ""}`,
      `- Model: ${data.model || ""}`,
      `- Created at: ${data.created_at || ""}`,
      `- Updated at: ${data.updated_at || ""}`,
      `- Exported messages: ${messages.length}`,
      `- Exported assets: ${assets.length}`,
      "- Extraction: Claude Web page-context exporter",
      "",
      "## Messages",
      "",
    ];
    messages.forEach((message, index) => lines.push(renderMessage(message, index + 1, assets), ""));
    return `${lines.join("\n").trim()}\n`;
  }

  function findConversationInValue(value, conversationId) {
    const queue = [value];
    const seen = new WeakSet();
    let visited = 0;
    while (queue.length && visited < 15000) {
      const current = queue.shift();
      visited += 1;
      if (!current) continue;
      if (typeof current === "string") {
        if (
          current.includes("chat_messages") &&
          (!conversationId || current.includes(conversationId)) &&
          /^[[{]/.test(current.trim())
        ) {
          try {
            queue.push(JSON.parse(current));
          } catch {
            // Not JSON; ignore.
          }
        }
        continue;
      }
      if (typeof current !== "object") continue;
      if (seen.has(current)) continue;
      seen.add(current);

      if (
        Array.isArray(current.chat_messages) &&
        (!conversationId || current.uuid === conversationId || JSON.stringify(current).includes(conversationId))
      ) {
        return current;
      }
      if (Array.isArray(current.messages) && (!conversationId || current.uuid === conversationId)) {
        return current;
      }

      if (Array.isArray(current)) {
        for (const item of current) queue.push(item);
      } else {
        for (const key of Object.keys(current)) {
          if (key === "body" || key === "data" || key === "state" || key === "value" || key === "queryKey") {
            queue.unshift(current[key]);
          } else {
            queue.push(current[key]);
          }
        }
      }
    }
    return null;
  }

  function openDb(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  function scanStore(db, storeName, conversationId) {
    return new Promise((resolve) => {
      let done = false;
      function finish(value) {
        if (!done) {
          done = true;
          resolve(value || null);
        }
      }
      try {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        request.onerror = () => finish(null);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return finish(null);
          const found = findConversationInValue(cursor.value, conversationId);
          if (found) return finish(found);
          cursor.continue();
        };
      } catch {
        finish(null);
      }
    });
  }

  async function findConversationJson(conversationId) {
    const preloaded = await Promise.resolve(window.__PRELOADED_IDB_CACHE__).catch(() => null);
    const fromPreloaded = findConversationInValue(preloaded, conversationId);
    if (fromPreloaded) return fromPreloaded;

    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        const value = storage.getItem(key);
        const found = findConversationInValue(value, conversationId);
        if (found) return found;
      }
    }

    if (!indexedDB.databases) return null;
    const dbInfos = await indexedDB.databases();
    for (const dbInfo of dbInfos) {
      if (!dbInfo.name) continue;
      let db;
      try {
        db = await openDb(dbInfo.name);
      } catch {
        continue;
      }
      log("scanning IndexedDB", dbInfo.name);
      for (const storeName of Array.from(db.objectStoreNames)) {
        const found = await scanStore(db, storeName, conversationId);
        if (found) {
          db.close();
          return found;
        }
      }
      db.close();
    }
    return null;
  }

  async function downloadAssets(assets) {
    for (const asset of assets) {
      if (!asset.preview_url) {
        asset.status = "missing_preview_url";
        continue;
      }
      try {
        log(`downloading ${asset.ordinal}/${assets.length}`, asset.file_name);
        const response = await fetch(asset.preview_url, { credentials: "include", redirect: "follow" });
        asset.http_status = response.status;
        asset.content_type = response.headers.get("content-type") || "";
        if (!response.ok) {
          asset.status = `http_${response.status}`;
          continue;
        }
        asset.bytes = new Uint8Array(await response.arrayBuffer());
        asset.downloaded = true;
        asset.status = "downloaded";
      } catch (error) {
        asset.status = "error";
        asset.error = error?.message || String(error);
      }
    }
  }

  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }

  function dosTimeDate(date = new Date()) {
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, dosDate };
  }

  function u16(value) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, value, true);
    return b;
  }

  function u32(value) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    return b;
  }

  function createZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { time, dosDate } = dosTimeDate();

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.bytes instanceof Uint8Array ? file.bytes : encoder.encode(String(file.bytes));
      const crc = crc32(data);
      const localHeader = [
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(time),
        u16(dosDate),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
      ];
      localParts.push(...localHeader, data);

      const centralHeader = [
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(time),
        u16(dosDate),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ];
      centralParts.push(...centralHeader);
      offset += localHeader.reduce((sum, part) => sum + part.length, 0) + data.length;
    }

    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const end = [
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralSize),
      u32(offset),
      u16(0),
    ];
    return new Blob([...localParts, ...centralParts, ...end], { type: "application/zip" });
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  const conversationId = conversationIdFromLocation();
  log("conversation id", conversationId || "(unknown)");
  const data = await findConversationJson(conversationId);
  if (!data) {
    throw new Error("Could not find Claude conversation JSON in page caches. Open the target chat, let it finish loading, then run again.");
  }

  const messages = sortMessages(data.chat_messages || data.messages || []);
  const assets = collectAssets(messages);
  log(`found ${messages.length} messages and ${assets.length} asset(s)`);
  await downloadAssets(assets);

  const title = safeName(data.name || data.title || data.uuid || conversationId || "claude-conversation", "claude-conversation");
  const markdown = renderMarkdown(data, messages, assets);
  const manifest = assets.map(({ bytes: _bytes, ...asset }) => asset);
  const files = [
    { name: `${title}.md`, bytes: markdown },
    { name: `${title}.raw.json`, bytes: JSON.stringify(data, null, 2) },
    { name: `${title}.assets_manifest.json`, bytes: JSON.stringify(manifest, null, 2) },
  ];
  for (const asset of assets) {
    if (asset.downloaded && asset.bytes) files.push({ name: asset.local_path, bytes: asset.bytes });
  }

  const zip = createZip(files);
  triggerDownload(zip, `${title}.zip`);
  log("done", {
    messages: messages.length,
    assets: assets.length,
    downloaded: assets.filter((asset) => asset.downloaded).length,
  });
})();
