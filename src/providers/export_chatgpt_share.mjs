#!/usr/bin/env node

// Export a public ChatGPT share (chatgpt.com/share/<id>) or saved share-page
// HTML to Markdown. Parses the serialized `streamController.enqueue(...)`
// payload into `serverResponse.data.linear_conversation`, and downloads
// shared attachments through the anonymous share file endpoint.

import fs from "node:fs/promises";
import path from "node:path";

import {
  appendAssetRecord,
  createAssetManifest,
  extensionFromBuffer,
  extensionFromContentType,
  extensionFromUrl,
  updateAssetManifestCounts,
  writeAssetManifest,
} from "../lib/assets.mjs";
import { fetchText, fetchWithRetry } from "../lib/http.mjs";
import { fenced, linkTarget, tableCell } from "../lib/markdown.mjs";
import { ensureDir, ensureParent, posixRelative, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { defaultShareOutputPath } from "../lib/share-paths.mjs";
import { sanitizeFilename } from "../lib/text.mjs";
import { isoFromUnixSeconds } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_chatgpt_share.mjs <source-url-or-file> [output.md] [--assets|--no-assets]

Source can be:
  - a ChatGPT share URL
  - saved HTML from a ChatGPT share page
  - a script file containing streamController.enqueue(...)
  - the decoded stream text that starts with a serialized JSON array

Attachments listed in the public share metadata are downloaded through the
anonymous share file endpoint by default; use --no-assets to skip.`;

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

async function fetchSharePage(url) {
  const { response, text } = await fetchText(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const setCookies =
    typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const cookies = setCookies.map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
  return { text, cookies };
}

function extractEnqueueArgument(text) {
  const marker = "streamController.enqueue(";
  const start = text.indexOf(marker);
  if (start === -1) return null;

  let i = start + marker.length;
  while (/\s/.test(text[i] || "")) i += 1;
  const quote = text[i];
  if (quote === "'") {
    throw new Error("streamController.enqueue uses a single-quoted literal, which is not supported.");
  }
  if (quote !== '"') {
    throw new Error("streamController.enqueue argument is not a string literal");
  }

  let escaped = false;
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === quote) return text.slice(i, j + 1);
  }
  throw new Error("Could not find end of streamController.enqueue string");
}

export function extractSerializedArray(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return trimmed;

  const enqueueArg = extractEnqueueArgument(text);
  if (enqueueArg) return JSON.parse(enqueueArg);

  const scriptMatch = text.match(
    /<script[^>]*>([\s\S]*?streamController\.enqueue\([\s\S]*?)<\/script>/i,
  );
  if (scriptMatch) {
    const nestedArg = extractEnqueueArgument(scriptMatch[1]);
    if (nestedArg) return JSON.parse(nestedArg);
  }

  throw new Error("No serialized ChatGPT share stream found");
}

// The share page embeds a devalue-style flat reference table; entry 0 is the
// root, non-negative numbers are indexes into the table, `_N` keys are indexed
// key names, and negative numbers are value sentinels.
const SENTINELS = new Map([
  [-1, undefined], // UNDEFINED
  [-2, undefined], // HOLE
  [-3, Number.NaN],
  [-4, Number.POSITIVE_INFINITY],
  [-5, Number.NEGATIVE_INFINITY],
  [-6, -0],
]);

export function decodeSerializedGraph(table) {
  const memo = new Map();

  function decodeValue(value) {
    if (typeof value === "number") {
      if (value < 0) return SENTINELS.has(value) ? SENTINELS.get(value) : null;
      return decodeIndex(value);
    }
    return value;
  }

  function decodeKey(key) {
    const match = /^_(\d+)$/.exec(key);
    if (!match) return key;
    const decoded = decodeIndex(Number(match[1]));
    return typeof decoded === "string" ? decoded : String(decoded);
  }

  function decodeIndex(index) {
    const value = table[index];
    if (value === null || typeof value !== "object") return value;
    if (memo.has(index)) return memo.get(index);

    if (Array.isArray(value)) {
      const out = [];
      memo.set(index, out);
      for (const item of value) out.push(decodeValue(item));
      return out;
    }

    const out = {};
    memo.set(index, out);
    for (const [key, valueRef] of Object.entries(value)) {
      out[decodeKey(key)] = decodeValue(valueRef);
    }
    return out;
  }

  return decodeIndex(0);
}

export function findConversationData(root) {
  const direct = root?.loaderData?.["routes/share.$shareId.($action)"]?.serverResponse?.data;
  if (direct?.linear_conversation) return direct;

  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value.linear_conversation && value.mapping) return value;
    for (const child of Object.values(value)) stack.push(child);
  }

  throw new Error("Could not locate serverResponse.data.linear_conversation");
}

function fileIdFromPointer(pointer) {
  return String(pointer || "").match(/file[-_][A-Za-z0-9]+/)?.[0] || "";
}

// Split message content into text parts and image asset pointers.
function messageParts(message) {
  const content = message?.content;
  const textParts = [];
  const imageParts = [];
  if (!content) return { textParts, imageParts };
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") {
        if (part) textParts.push(part);
      } else if (part?.content_type === "image_asset_pointer") {
        imageParts.push({
          fileId: fileIdFromPointer(part.asset_pointer),
          width: part.width,
          height: part.height,
          mimeType: part.mime_type || "",
          sizeBytes: part.size_bytes,
        });
      } else if (part?.content_type === "audio_transcription" && part.text) {
        textParts.push(part.text);
      } else if (part) {
        textParts.push(JSON.stringify(part, null, 2));
      }
    }
  } else if (typeof content.text === "string") {
    textParts.push(content.text);
  } else if (typeof content.content === "string") {
    textParts.push(content.content);
  }
  return { textParts, imageParts };
}

function selectMessages(nodes) {
  const selected = [];
  nodes.forEach((node, index) => {
    const message = node.message;
    if (!message || message.metadata?.is_visually_hidden_from_conversation) return;
    const role = message.author?.role;
    const type = message.content?.content_type;
    const { textParts, imageParts } = messageParts(message);
    const text = textParts.join("\n");

    if (["user", "assistant"].includes(role) && ["text", "multimodal_text"].includes(type)) {
      if (text.trim() || imageParts.length) {
        selected.push({ index, node, message, text, imageParts, kind: "message" });
      }
    } else if (role === "assistant" && type === "code" && text.trim()) {
      selected.push({ index, node, message, text, imageParts: [], kind: "code" });
    }
  });
  return selected;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function refLink(ref) {
  if (ref.type === "file") {
    const label = String(ref.name || ref.id || "attached file").replace(/[[\]]/g, "");
    return `([${label}](#attachments))`;
  }
  if (ref.alt && /\[[^\]]+\]\(https?:\/\//.test(ref.alt)) return ref.alt;
  const item = ref.items?.[0] || ref.sources?.[0];
  const href = item?.url || ref.safe_urls?.[0];
  if (!href) return "";
  const label = String(item?.attribution || item?.title || new URL(href).host).replace(/[[\]]/g, "");
  return `([${label}](${href}))`;
}

function sourceItems(metadata) {
  const out = [];
  const seen = new Set();
  for (const ref of metadata?.content_references || []) {
    const candidates = [];
    if (Array.isArray(ref.sources)) candidates.push(...ref.sources);
    if (Array.isArray(ref.items)) {
      for (const item of ref.items) {
        candidates.push(item);
        if (Array.isArray(item.supporting_websites)) candidates.push(...item.supporting_websites);
      }
    }
    for (const item of candidates) {
      if (!item?.url || seen.has(item.url)) continue;
      seen.add(item.url);
      out.push({
        title: item.title || item.attribution || item.url,
        url: item.url,
        attribution: item.attribution || "",
      });
    }
  }
  return out;
}

function addAttachment(out, value, source) {
  if (!value || typeof value !== "object") return;
  const id = value.id || value.metadata?.id;
  const name = value.name || value.metadata?.name || id;
  if (!id && !name) return;

  const key = id || name;
  const existing = out.get(key) || {};
  out.set(key, {
    name: existing.name || name || "",
    id: existing.id || id || "",
    size: existing.size || value.size || "",
    mime_type:
      existing.mime_type ||
      value.mime_type ||
      value.metadata?.mime_type ||
      value.metadata?.extra?.mime_type ||
      "",
    library_file_id:
      existing.library_file_id ||
      value.library_file_id ||
      value.metadata?.library_file_id ||
      value.metadata?.extra?.library_file_id ||
      "",
    source: existing.source || value.source || value.metadata?.source || source,
  });
}

function collectAttachments(nodes) {
  const out = new Map();
  for (const node of nodes) {
    const metadata = node.message?.metadata || {};
    for (const attachment of metadata.attachments || []) {
      addAttachment(out, attachment, "message.metadata.attachments");
    }
    for (const ref of metadata.content_references || []) {
      if (ref.type === "file") addAttachment(out, ref, "content_references");
    }
    for (const citation of metadata.citations || []) {
      if (citation.metadata?.type === "file") addAttachment(out, citation, "citations");
    }
  }
  return Array.from(out.values()).sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id)),
  );
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024) return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(1)} TB`;
}

function replaceCitations(text, metadata) {
  let out = text;
  for (const ref of metadata?.content_references || []) {
    if (!ref?.matched_text || !ref.matched_text.includes("cite")) continue;
    const link = refLink(ref);
    if (link) {
      out = out.replace(new RegExp(escapeRegExp(ref.matched_text), "g"), link);
    }
  }
  return out;
}

// The share page's own file endpoint: anonymous, but requires the share-page
// cookies. Returns a short-lived signed download URL.
async function resolveShareFileUrl(fileId, shareId, cookies) {
  const url =
    `https://chatgpt.com/backend-anon/files/download/${fileId}` +
    `?post_id=&shared_conversation_id=${shareId}&inline=false&download_intent=false`;
  const { text } = await fetchText(url, {
    headers: {
      accept: "application/json",
      cookie: cookies,
      referer: `https://chatgpt.com/share/${shareId}`,
    },
  });
  const payload = JSON.parse(text);
  if (payload?.status !== "success" || !payload.download_url) {
    throw new Error(`share file endpoint returned: ${text.slice(0, 200)}`);
  }
  return payload.download_url;
}

async function downloadShareAssets({ fileIds, attachmentsById, shareId, cookies, outputPath }) {
  const markdownDir = path.dirname(outputPath);
  const manifest = createAssetManifest(outputPath);
  const byFileId = new Map();

  await ensureDir(manifest.assetsDir);
  for (const [ordinal, fileId] of fileIds.entries()) {
    const meta = attachmentsById.get(fileId) || {};
    const record = {
      index: ordinal + 1,
      fileId,
      name: meta.name || "",
      mimeType: meta.mime_type || "",
    };
    try {
      const downloadUrl = await resolveShareFileUrl(fileId, shareId, cookies);
      const response = await fetchWithRetry(downloadUrl, { redirect: "follow" });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type") || "";
      if (/text\/html/i.test(contentType)) {
        throw new Error("download returned an HTML page instead of a file");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const baseName = sanitizeFilename(
        (meta.name || "").replace(/\.[^.]+$/, "") || fileId,
        fileId,
      );
      const ext =
        path.extname(sanitizeFilename(meta.name || "", "")) ||
        extensionFromContentType(contentType || meta.mime_type) ||
        extensionFromBuffer(buffer) ||
        extensionFromUrl(downloadUrl) ||
        ".bin";
      const filename = `${String(ordinal + 1).padStart(3, "0")}_${baseName}${ext}`;
      const filePath = path.join(manifest.assetsDir, filename);
      await fs.writeFile(filePath, buffer);
      Object.assign(record, {
        status: "downloaded",
        filename,
        relativePath: posixRelative(markdownDir, filePath),
        contentType,
        bytes: buffer.length,
      });
      byFileId.set(fileId, record);
    } catch (error) {
      Object.assign(record, { status: "failed", error: error.message || String(error) });
    }
    appendAssetRecord(manifest, record);
  }

  updateAssetManifestCounts(manifest);
  return { manifest, byFileId };
}

function renderImagePart(part, assets, attachmentsById) {
  const meta = attachmentsById.get(part.fileId) || {};
  const label = meta.name || part.fileId || "image";
  const dims = part.width && part.height ? ` (${part.width}x${part.height})` : "";
  const asset = assets?.byFileId?.get(part.fileId);
  if (asset) return `![${label}${dims}](${linkTarget(asset.relativePath)})`;
  return `> [Image attachment: ${label}${dims} — not downloaded; see Attachments table]`;
}

export function buildMarkdown(data, source, { assets = null } = {}) {
  const nodes = data.linear_conversation || [];
  const attachments = collectAttachments(nodes);
  const attachmentsById = new Map(attachments.filter((a) => a.id).map((a) => [a.id, a]));
  const stats = {};
  for (const node of nodes) {
    const message = node.message;
    const key = `${message?.author?.role || "(root)"} | ${
      message?.content?.content_type || "(none)"
    } | hidden=${Boolean(message?.metadata?.is_visually_hidden_from_conversation)}`;
    stats[key] = (stats[key] || 0) + 1;
  }

  const messages = selectMessages(nodes);
  const userCount = messages.filter(({ message }) => message.author.role === "user").length;
  const assistantCount = messages.length - userCount;

  const lines = [
    `# ${data.title || "ChatGPT Share Export"}`,
    "",
    `- Source: ${source}`,
    `- Shared conversation ID: ${data.conversation_id || ""}`,
    `- Backing conversation ID: ${data.backing_conversation_id || ""}`,
    `- Created: ${isoFromUnixSeconds(data.create_time)}`,
    `- Updated: ${isoFromUnixSeconds(data.update_time)}`,
    `- Exported at: ${new Date().toISOString()}`,
    "- Extraction: parsed embedded `streamController.enqueue(...)` -> `serverResponse.data.linear_conversation`",
    `- Exported messages: ${messages.length} (${userCount} user, ${assistantCount} assistant)`,
    `- Attachments in public metadata: ${attachments.length}`,
    assets ? `- Attachments downloaded: ${assets.manifest.downloaded}/${assets.manifest.assets.length}` : "",
    `- Source nodes: ${nodes.length}`,
    "",
    "## Node Statistics",
    "",
    "| Node type | Count |",
    "|---|---:|",
  ].filter((line) => line !== "");

  for (const [key, value] of Object.entries(stats).sort()) {
    lines.push(`| ${tableCell(key)} | ${value} |`);
  }

  if (attachments.length) {
    lines.push(
      "",
      "## Attachments",
      "",
      "| Name | MIME type | Size | File ID | Downloaded | Source |",
      "|---|---|---:|---|---|---|",
    );
    for (const attachment of attachments) {
      const asset = assets?.byFileId?.get(attachment.id);
      lines.push(
        `| ${tableCell(attachment.name)} | ${tableCell(attachment.mime_type)} | ${tableCell(
          formatBytes(attachment.size),
        )} | ${tableCell(attachment.id)} | ${
          asset ? `[${tableCell(asset.filename)}](${linkTarget(asset.relativePath)})` : "no"
        } | ${tableCell(attachment.source)} |`,
      );
    }
  }

  lines.push("", "## Conversation");

  messages.forEach(({ index, node, message, text, imageParts, kind }, messageIndex) => {
    const role = message.author.role === "user" ? "User" : "Assistant";
    const channel = message.channel || "";
    const suffix =
      kind === "code" ? " (code)" : channel && channel !== "final" ? ` (${channel})` : "";
    const meta = [`node ${index}`, `id ${node.id}`];
    const created = isoFromUnixSeconds(message.create_time);
    if (created) meta.push(created);
    if (channel) meta.push(`channel ${channel}`);

    lines.push("", `### ${String(messageIndex + 1).padStart(2, "0")}. ${role}${suffix}`);
    lines.push("", `<!-- ${meta.join(" | ")} -->`);

    for (const part of imageParts) {
      lines.push("", renderImagePart(part, assets, attachmentsById));
    }

    if (kind === "code") {
      lines.push("", fenced(text.trimEnd(), message.content?.language || ""));
    } else if (text.trim()) {
      lines.push("", replaceCitations(text.trimEnd(), message.metadata || {}));
    }

    const sources = sourceItems(message.metadata || {});
    if (sources.length) {
      lines.push("", "**Sources**", "");
      for (const sourceItem of sources) {
        const title = String(sourceItem.title).replace(/[[\]]/g, "");
        const attribution = sourceItem.attribution ? ` -- ${sourceItem.attribution}` : "";
        lines.push(`- [${title}](${sourceItem.url})${attribution}`);
      }
    }
  });

  lines.push("");
  return {
    markdown: lines.join("\n"),
    messages,
    sourceNodes: nodes.length,
    attachments,
  };
}

function collectDownloadableFileIds(nodes, attachments) {
  const ids = [];
  const seen = new Set();
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  for (const { imageParts } of selectMessages(nodes)) {
    for (const part of imageParts) push(part.fileId);
  }
  for (const attachment of attachments) push(attachment.id);
  return ids;
}

export async function exportChatGptShare({ input, output = "", downloadAssets = true } = {}) {
  if (!input) throw new Error("chatgpt requires a share URL or saved share-page file.");

  let raw;
  let cookies = "";
  if (isUrl(input)) {
    ({ text: raw, cookies } = await fetchSharePage(input));
  } else {
    raw = await fs.readFile(input, "utf8");
  }

  const serializedArray = extractSerializedArray(raw);
  const table = JSON.parse(serializedArray.trim());
  const root = decodeSerializedGraph(table);
  const data = findConversationData(root);
  const outputPath = output || defaultShareOutputPath("chatgpt", input);

  const nodes = data.linear_conversation || [];
  const attachments = collectAttachments(nodes);
  const shareId = data.conversation_id || "";
  let assets = null;

  if (downloadAssets && shareId) {
    const fileIds = collectDownloadableFileIds(nodes, attachments);
    if (fileIds.length) {
      if (!cookies) {
        // File input: bootstrap cookies from the live share page.
        try {
          ({ cookies } = await fetchSharePage(`https://chatgpt.com/share/${shareId}`));
        } catch {
          cookies = "";
        }
      }
      if (cookies) {
        assets = await downloadShareAssets({
          fileIds,
          attachmentsById: new Map(attachments.filter((a) => a.id).map((a) => [a.id, a])),
          shareId,
          cookies,
          outputPath,
        });
      }
    }
  }

  const { markdown, messages, sourceNodes } = buildMarkdown(data, input, { assets });

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);
  if (assets) {
    await writeAssetManifest(assets.manifest);
  }

  return {
    output: outputPath,
    title: data.title,
    sourceNodes,
    exportedMessages: messages.length,
    attachments: attachments.length,
    assetsDownloaded: assets?.manifest.downloaded || 0,
    assetsFailed: assets?.manifest.failed || 0,
    assetsManifest: assets?.manifest.manifestPath || null,
    bytes: Buffer.byteLength(markdown),
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = { input: "", output: "", downloadAssets: true };
    for (const arg of process.argv.slice(2)) {
      if (arg === "--assets") args.downloadAssets = true;
      else if (arg === "--no-assets") args.downloadAssets = false;
      else if (arg === "-h" || arg === "--help") {
        console.error(USAGE);
        return;
      } else if (!args.input) args.input = arg;
      else if (!args.output) args.output = arg;
      else throw new Error(`Unexpected argument: ${arg}`);
    }
    if (!args.input) {
      console.error(USAGE);
      process.exitCode = 1;
      return;
    }
    const summary = await exportChatGptShare(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
