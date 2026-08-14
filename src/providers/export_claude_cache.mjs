#!/usr/bin/env node

// Recover Claude Desktop conversations from the local HTTP cache and export
// them to Markdown with raw JSON, manifests, and any cached asset bytes.
// Reads cache files only; never cookies, keychain items, or session tokens.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { messagesOf, renderMessage, titleOf } from "../lib/claude.mjs";
import { escapeImageLabel } from "../lib/markdown.mjs";
import { ensureDir, stripExtension, todayStamp, uniqueName, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { slugify } from "../lib/text.mjs";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const HTTP_MARKER = Buffer.from("HTTP/1.1");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_MAGICS = [
  Buffer.from("RIFF", "ascii"),
  PNG_SIGNATURE.subarray(0, 4),
  Buffer.from([0xff, 0xd8]),
  Buffer.from("GIF8", "ascii"),
];
const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude",
  "Cache",
  "Cache_Data",
);

const USAGE = `Usage:
  node src/providers/export_claude_cache.mjs [--limit 6] [--out output-dir] [--cache-dir cache-dir]
  node src/providers/export_claude_cache.mjs --conversation <uuid> [--conversation <uuid>]

Examples:
  node src/providers/export_claude_cache.mjs --limit 6
  node src/providers/export_claude_cache.mjs --out exports/claude/cache_recent_20260629`;

export function defaultOutputDir() {
  return path.join("exports", "claude", `cache_recent_${todayStamp()}`);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function parseArgs(argv) {
  const args = {
    cacheDir: DEFAULT_CACHE_DIR,
    outDir: defaultOutputDir(),
    limit: 6,
    conversations: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "-h" || item === "--help") {
      args.help = true;
    } else if (item === "--cache-dir") {
      args.cacheDir = argv[++index];
    } else if (item === "--out") {
      args.outDir = argv[++index];
    } else if (item === "--limit") {
      args.limit = Number.parseInt(argv[++index], 10);
      if (!Number.isFinite(args.limit) || args.limit < 1) {
        throw new Error("--limit must be a positive integer.");
      }
    } else if (item === "--conversation") {
      const uuid = argv[++index];
      if (!isUuid(uuid)) throw new Error(`Invalid conversation UUID: ${uuid}`);
      args.conversations.push(uuid.toLowerCase());
    } else if (isUuid(item)) {
      args.conversations.push(item.toLowerCase());
    } else {
      throw new Error(`Unknown argument: ${item}`);
    }
  }

  return args;
}

function shortUuid(uuid) {
  return String(uuid || "").slice(0, 8) || "unknown";
}

async function* walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(fullPath);
    else if (entry.isFile()) yield fullPath;
  }
}

function findHttpEnd(buffer, start) {
  const end = buffer.indexOf(HTTP_MARKER, start);
  return end >= 0 ? end : buffer.length;
}

function findFirstJsonByte(buffer, start, end) {
  const objectStart = buffer.indexOf(0x7b, start);
  const arrayStart = buffer.indexOf(0x5b, start);
  let found = -1;
  if (objectStart >= 0 && objectStart < end) found = objectStart;
  if (arrayStart >= 0 && arrayStart < end && (found < 0 || arrayStart < found)) found = arrayStart;
  return found;
}

// Slice the first balanced JSON value out of text that may have trailing bytes.
function isolateJsonText(text) {
  const first = text.search(/[[{]/);
  if (first < 0) return "";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = first; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(first, index + 1);
    }
  }

  return text.slice(first).trim();
}

function extractJsonPayload(buffer, bodyStart) {
  const bodyEnd = findHttpEnd(buffer, bodyStart);
  const zstdStart = buffer.indexOf(ZSTD_MAGIC, bodyStart);
  if (zstdStart >= 0 && zstdStart < bodyEnd) {
    const compressed = buffer.subarray(zstdStart, bodyEnd);
    try {
      const decompressed = zlib.zstdDecompressSync(compressed).toString("utf8");
      return { json: JSON.parse(decompressed), encoding: "zstd", bodyBytes: compressed.length };
    } catch {
      // Fall through to raw JSON probing.
    }
  }

  const jsonStart = findFirstJsonByte(buffer, bodyStart, bodyEnd);
  if (jsonStart < 0) return null;
  const raw = buffer.subarray(jsonStart, bodyEnd).toString("utf8").trim();
  try {
    return { json: JSON.parse(raw), encoding: "raw", bodyBytes: bodyEnd - jsonStart };
  } catch {
    const isolated = isolateJsonText(raw);
    if (!isolated) return null;
    try {
      return { json: JSON.parse(isolated), encoding: "raw-isolated", bodyBytes: Buffer.byteLength(isolated) };
    } catch {
      return null;
    }
  }
}

function parseRiffWebp(buffer, start, end) {
  if (buffer.subarray(start, start + 4).toString("ascii") !== "RIFF") return null;
  if (buffer.subarray(start + 8, start + 12).toString("ascii") !== "WEBP") return null;
  const size = buffer.readUInt32LE(start + 4) + 8;
  if (size <= 12 || start + size > end) return null;
  return { bytes: buffer.subarray(start, start + size), ext: "webp", mime: "image/webp" };
}

function parsePng(buffer, start, end) {
  if (!buffer.subarray(start, start + PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  let cursor = start + PNG_SIGNATURE.length;
  while (cursor + 12 <= end) {
    const length = buffer.readUInt32BE(cursor);
    const type = buffer.subarray(cursor + 4, cursor + 8).toString("ascii");
    cursor += 8 + length + 4;
    if (cursor > end) return null;
    if (type === "IEND") {
      return { bytes: buffer.subarray(start, cursor), ext: "png", mime: "image/png" };
    }
  }
  return null;
}

function parseJpeg(buffer, start, end) {
  if (buffer[start] !== 0xff || buffer[start + 1] !== 0xd8) return null;
  for (let cursor = start + 2; cursor + 1 < end; cursor += 1) {
    if (buffer[cursor] === 0xff && buffer[cursor + 1] === 0xd9) {
      return { bytes: buffer.subarray(start, cursor + 2), ext: "jpg", mime: "image/jpeg" };
    }
  }
  return null;
}

function parseGif(buffer, start, end) {
  const header = buffer.subarray(start, start + 6).toString("ascii");
  if (header !== "GIF87a" && header !== "GIF89a") return null;
  const trailer = buffer.indexOf(0x3b, start + 6);
  if (trailer < 0 || trailer >= end) return null;
  return { bytes: buffer.subarray(start, trailer + 1), ext: "gif", mime: "image/gif" };
}

function extractPreviewPayload(buffer, bodyStart) {
  const bodyEnd = findHttpEnd(buffer, bodyStart);
  const scanEnd = Math.min(bodyEnd, bodyStart + 4096);
  const candidates = [];

  for (const magic of IMAGE_MAGICS) {
    const found = buffer.indexOf(magic, bodyStart);
    if (found >= 0 && found < scanEnd) candidates.push(found);
  }

  candidates.sort((a, b) => a - b);
  for (const start of candidates) {
    const parsed =
      parseRiffWebp(buffer, start, bodyEnd) ||
      parsePng(buffer, start, bodyEnd) ||
      parseJpeg(buffer, start, bodyEnd) ||
      parseGif(buffer, start, bodyEnd);
    if (parsed) return parsed;
  }

  return null;
}

function readHttpMetadata(buffer, bodyStart) {
  const httpStart = findHttpEnd(buffer, bodyStart);
  if (httpStart >= buffer.length) return { httpStart, status: null, headersText: "" };
  const headersText = buffer
    .subarray(httpStart, Math.min(buffer.length, httpStart + 8192))
    .toString("latin1");
  const status = Number.parseInt(/HTTP\/1\.1\s+(\d{3})/.exec(headersText)?.[1] || "", 10);
  const contentLength = Number.parseInt(/content-length:([0-9]+)/i.exec(headersText)?.[1] || "", 10);
  const contentType = /content-type:([^\p{Cc}]+)/iu.exec(headersText)?.[1] || "";
  const contentEncoding = /content-encoding:([^\p{Cc}]+)/iu.exec(headersText)?.[1] || "";
  return {
    httpStart,
    status: Number.isFinite(status) ? status : null,
    contentLength: Number.isFinite(contentLength) ? contentLength : null,
    contentType,
    contentEncoding,
    headersText,
  };
}

function extractDownloadPayload(buffer, bodyStart) {
  const metadata = readHttpMetadata(buffer, bodyStart);
  if (metadata.status !== 200) return null;
  if (/text\/html/i.test(metadata.contentType) || /cf-mitigated:challenge/i.test(metadata.headersText)) {
    return null;
  }

  const bodyEnd = metadata.httpStart;
  let start = bodyStart;
  while (start < bodyEnd && (buffer[start] === 0x00 || buffer[start] === 0x0a || buffer[start] === 0x0d)) {
    start += 1;
  }
  const payloadEnd =
    metadata.contentLength != null && start + metadata.contentLength <= bodyEnd
      ? start + metadata.contentLength
      : bodyEnd;

  const zstdStart = buffer.indexOf(ZSTD_MAGIC, start);
  if (zstdStart >= 0 && zstdStart < Math.min(payloadEnd, start + 32)) {
    try {
      return {
        bytes: zlib.zstdDecompressSync(buffer.subarray(zstdStart, payloadEnd)),
        encoding: "zstd",
        compressedBytes: payloadEnd - zstdStart,
        status: metadata.status,
        contentType: metadata.contentType,
      };
    } catch {
      // Fall through to saving the cached body as-is.
    }
  }

  return {
    bytes: buffer.subarray(start, payloadEnd),
    encoding: "raw",
    compressedBytes: null,
    status: metadata.status,
    contentType: metadata.contentType,
  };
}

function addBestDetail(details, candidate) {
  const existing = details.get(candidate.uuid);
  if (!existing) {
    details.set(candidate.uuid, candidate);
    return;
  }
  const existingUpdated = Date.parse(existing.json?.updated_at || "");
  const candidateUpdated = Date.parse(candidate.json?.updated_at || "");
  const existingMessages = messagesOf(existing.json).length;
  const candidateMessages = messagesOf(candidate.json).length;
  if (
    candidateMessages > existingMessages ||
    (candidateMessages === existingMessages && candidateUpdated > existingUpdated)
  ) {
    details.set(candidate.uuid, candidate);
  }
}

function addBestPreview(previews, candidate) {
  const existing = previews.get(candidate.fileUuid);
  if (!existing) {
    previews.set(candidate.fileUuid, candidate);
    return;
  }
  const score = (item) => (item.kind === "preview" ? 10 : 0) + item.bytes.length;
  if (score(candidate) > score(existing)) previews.set(candidate.fileUuid, candidate);
}

function addBestDownload(downloads, candidate) {
  const byConversation = downloads.get(candidate.conversationUuid) || new Map();
  const existing = byConversation.get(candidate.remotePath);
  if (!existing || candidate.bytes.length > existing.bytes.length) {
    byConversation.set(candidate.remotePath, candidate);
  }
  downloads.set(candidate.conversationUuid, byConversation);
}

const LIST_RE =
  /https:\/\/claude\.ai\/api\/organizations\/([0-9a-f-]{36})\/chat_conversations_v2\?(?:[A-Za-z0-9_%=&.-]+)/g;
const DETAIL_RE =
  /https:\/\/claude\.ai\/api\/organizations\/([0-9a-f-]{36})\/chat_conversations\/([0-9a-f-]{36})\?(?:[A-Za-z0-9_%=&.-]+)/g;
const PREVIEW_RE =
  /https:\/\/claude\.ai\/api\/(?:organizations\/)?([0-9a-f-]{36})\/files\/([0-9a-f-]{36})\/(preview|thumbnail)(?:\?(?:[A-Za-z0-9_%=&.-]+))?/g;
const DOWNLOAD_RE =
  /https:\/\/claude\.ai\/api\/organizations\/([0-9a-f-]{36})\/conversations\/([0-9a-f-]{36})\/wiggle\/download-file\?path=([A-Za-z0-9%_.~+=/-]+)/g;

async function scanClaudeCache(cacheDir) {
  const lists = [];
  const details = new Map();
  const previews = new Map();
  const downloads = new Map();
  const readErrors = [];
  let filesScanned = 0;

  for await (const cachePath of walkFiles(cacheDir)) {
    filesScanned += 1;
    let buffer;
    try {
      buffer = await fs.readFile(cachePath);
    } catch (error) {
      readErrors.push({ path: cachePath, error: error.message });
      continue;
    }

    const latin1 = buffer.toString("latin1");

    for (const match of latin1.matchAll(LIST_RE)) {
      const payload = extractJsonPayload(buffer, match.index + match[0].length);
      if (!payload) continue;
      lists.push({ url: match[0], cachePath, organizationUuid: match[1], ...payload });
    }

    for (const match of latin1.matchAll(DETAIL_RE)) {
      const payload = extractJsonPayload(buffer, match.index + match[0].length);
      const uuid = match[2].toLowerCase();
      if (!payload?.json || String(payload.json.uuid || "").toLowerCase() !== uuid) continue;
      addBestDetail(details, { uuid, url: match[0], cachePath, organizationUuid: match[1], ...payload });
    }

    for (const match of latin1.matchAll(PREVIEW_RE)) {
      const payload = extractPreviewPayload(buffer, match.index + match[0].length);
      if (!payload) continue;
      addBestPreview(previews, {
        organizationUuid: match[1],
        fileUuid: match[2].toLowerCase(),
        kind: match[3],
        url: match[0],
        cachePath,
        ...payload,
      });
    }

    for (const match of latin1.matchAll(DOWNLOAD_RE)) {
      const payload = extractDownloadPayload(buffer, match.index + match[0].length);
      if (!payload?.bytes?.length) continue;
      let remotePath = match[3];
      try {
        remotePath = decodeURIComponent(remotePath);
      } catch {
        // Keep the encoded path if decoding fails.
      }
      addBestDownload(downloads, {
        organizationUuid: match[1],
        conversationUuid: match[2].toLowerCase(),
        remotePath,
        url: match[0],
        cachePath,
        ...payload,
      });
    }
  }

  return { lists, details, previews, downloads, filesScanned, readErrors };
}

function extractListItems(listJson) {
  if (Array.isArray(listJson)) return listJson;
  if (Array.isArray(listJson?.data)) return listJson.data;
  if (Array.isArray(listJson?.conversations)) return listJson.conversations;
  if (Array.isArray(listJson?.items)) return listJson.items;
  return [];
}

function mergeRecentList(lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const item of extractListItems(list.json)) {
      if (!item?.uuid) continue;
      const uuid = String(item.uuid).toLowerCase();
      const existing = merged.get(uuid);
      const existingUpdated = Date.parse(existing?.updated_at || "");
      const itemUpdated = Date.parse(item.updated_at || "");
      if (!existing || itemUpdated >= existingUpdated) {
        merged.set(uuid, { ...item, uuid, listCachePath: list.cachePath, listUrl: list.url });
      }
    }
  }
  return [...merged.values()].sort((a, b) => {
    const byUpdated = Date.parse(b.updated_at || "") - Date.parse(a.updated_at || "");
    if (byUpdated) return byUpdated;
    return String(a.uuid).localeCompare(String(b.uuid));
  });
}

function conversationTitle(conversation, listItem) {
  return (
    titleOf(conversation, "") ||
    listItem?.name ||
    listItem?.title ||
    `Claude conversation ${shortUuid(conversation.uuid || listItem?.uuid)}`
  );
}

function fileDisplayName(item) {
  return item?.file_name || item?.name || item?.filename || item?.path || item?.uuid || item?.file_uuid || "file";
}

function fileUuidOf(item) {
  return String(item?.file_uuid || item?.uuid || item?.id || "").toLowerCase();
}

function relativePosix(fromDir, targetPath) {
  return path.relative(fromDir, targetPath).split(path.sep).join("/");
}

function renderAttachmentList(message, assets) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (!attachments.length) return "";

  const lines = ["**Attachments:**"];
  for (const attachment of attachments) {
    const id = String(attachment?.id || "");
    const asset = id ? assets.attachments.get(id) : null;
    const name = fileDisplayName(attachment);
    const bits = [name];
    if (attachment?.file_size != null) bits.push(`${attachment.file_size} bytes`);
    if (attachment?.file_type) bits.push(attachment.file_type);
    if (asset) {
      lines.push(`- [${name}](${asset.relativePath}) | ${bits.slice(1).join(" | ") || "extracted text"}`);
    } else {
      lines.push(`- ${bits.join(" | ")} | cached extracted content not available`);
    }
  }
  return lines.join("\n");
}

function renderFileList(message, assets) {
  const files = Array.isArray(message?.files) ? message.files : [];
  if (!files.length) return "";

  const lines = ["**Files:**"];
  for (const file of files) {
    const uuid = fileUuidOf(file);
    const asset = uuid ? assets.files.get(uuid) : null;
    const name = fileDisplayName(file);
    const bits = [name];
    if (file?.file_kind) bits.push(file.file_kind);
    if (file?.size_bytes != null) bits.push(`${file.size_bytes} bytes`);
    if (file?.file_type) bits.push(file.file_type);

    if (asset?.isImage) {
      lines.push(`- ${bits.join(" | ")}`);
      lines.push(`  ![${escapeImageLabel(name)}](${asset.relativePath})`);
    } else if (asset) {
      lines.push(`- [${name}](${asset.relativePath}) | ${bits.slice(1).join(" | ")}`);
    } else {
      lines.push(`- ${bits.join(" | ")} | cached bytes not found`);
    }
  }

  return lines.join("\n");
}

function renderCachedDownloads(downloadAssets) {
  if (!downloadAssets.length) return "";
  const lines = ["## Cached Generated Files", ""];
  for (const asset of downloadAssets) {
    const bits = [asset.remotePath, `${asset.bytes} bytes`];
    if (asset.encoding) bits.push(`encoding: ${asset.encoding}`);
    lines.push(`- [${path.basename(asset.remotePath)}](${asset.relativePath || asset.output}) | ${bits.join(" | ")}`);
  }
  return lines.join("\n");
}

function renderConversationMarkdown(conversation, listItem, detail, assetState, exportManifest) {
  const messages = messagesOf(conversation);
  const title = conversationTitle(conversation, listItem);
  const metaLines = [
    "- Source: Claude Desktop HTTP cache",
    `- Conversation UUID: ${conversation.uuid || listItem?.uuid || ""}`,
    `- Title: ${title}`,
    conversation.model ? `- Model: ${conversation.model}` : "",
    `- Created at: ${conversation.created_at || listItem?.created_at || ""}`,
    `- Updated at: ${conversation.updated_at || listItem?.updated_at || ""}`,
    conversation.current_leaf_message_uuid
      ? `- Current leaf message UUID: ${conversation.current_leaf_message_uuid}`
      : "",
    `- Exported messages: ${messages.length}`,
    `- Cached detail file: ${detail.cachePath}`,
    `- Cached assets saved: ${exportManifest.assets.length}`,
    `- Missing cached asset bytes: ${exportManifest.missingAssets.length}`,
    "- Extraction: local Claude Desktop HTTP cache only; no cookies, keychain, or session tokens read",
  ].filter(Boolean);

  const downloadSection = renderCachedDownloads(exportManifest.downloadAssets || []);
  const lines = [`# ${title}`, "", ...metaLines, ""];
  if (downloadSection) lines.push(downloadSection, "");
  lines.push("---", "", "## Messages", "");
  messages.forEach((message, index) => {
    const extras = [renderAttachmentList(message, assetState), renderFileList(message, assetState)];
    lines.push(renderMessage(message, index + 1, extras), "");
  });
  return `${lines.join("\n").trim()}\n`;
}

function collectReferencedAssets(conversation) {
  const attachments = [];
  const files = [];
  for (const message of messagesOf(conversation)) {
    for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
      attachments.push({ message, item: attachment });
    }
    for (const file of Array.isArray(message.files) ? message.files : []) {
      files.push({ message, item: file });
    }
  }
  return { attachments, files };
}

async function writeConversationAssets(conversation, slug, outDir, previews, downloads) {
  const assetsDir = path.join(outDir, `${slug}_assets`);
  const assetState = { attachments: new Map(), files: new Map() };
  const manifest = { assets: [], missingAssets: [], downloadAssets: [] };
  const writtenAttachmentIds = new Set();
  const writtenFileUuids = new Set();
  const usedDownloadNames = new Set();
  const referenced = collectReferencedAssets(conversation);

  for (const { message, item } of referenced.attachments) {
    const id = String(item?.id || "");
    if (!id || writtenAttachmentIds.has(id)) continue;
    writtenAttachmentIds.add(id);

    const content = item?.extracted_content;
    const name = fileDisplayName(item);
    if (typeof content === "string" && content.length > 0) {
      await ensureDir(assetsDir);
      const fileName = `m${message.index ?? "x"}_${shortUuid(id)}_${slugify(stripExtension(name), {
        maxLength: 80,
        fallback: "attachment",
      })}.txt`;
      const outputPath = path.join(assetsDir, fileName);
      await fs.writeFile(outputPath, content, "utf8");
      const relativePath = relativePosix(outDir, outputPath);
      assetState.attachments.set(id, { relativePath, outputPath });
      manifest.assets.push({
        kind: "attachment_extracted_text",
        messageIndex: message.index,
        id,
        name,
        output: relativePath,
        bytes: Buffer.byteLength(content, "utf8"),
      });
    } else {
      manifest.missingAssets.push({
        kind: "attachment",
        messageIndex: message.index,
        id,
        name,
        reason: "no extracted_content in cached conversation JSON",
      });
    }
  }

  for (const { message, item } of referenced.files) {
    const uuid = fileUuidOf(item);
    if (!uuid || writtenFileUuids.has(uuid)) continue;
    writtenFileUuids.add(uuid);

    const name = fileDisplayName(item);
    const preview = previews.get(uuid);
    if (preview?.bytes?.length) {
      await ensureDir(assetsDir);
      const baseName = slugify(stripExtension(path.basename(name)), { maxLength: 80, fallback: "file" });
      const fileName = `m${message.index ?? "x"}_${shortUuid(uuid)}_${baseName}.${preview.ext}`;
      const outputPath = path.join(assetsDir, fileName);
      await fs.writeFile(outputPath, preview.bytes);
      const relativePath = relativePosix(outDir, outputPath);
      assetState.files.set(uuid, {
        relativePath,
        outputPath,
        isImage: preview.mime.startsWith("image/"),
      });
      manifest.assets.push({
        kind: `file_${preview.kind}`,
        messageIndex: message.index,
        fileUuid: uuid,
        name,
        output: relativePath,
        bytes: preview.bytes.length,
        mime: preview.mime,
        cachePath: preview.cachePath,
        url: preview.url,
      });
    } else {
      manifest.missingAssets.push({
        kind: "file",
        messageIndex: message.index,
        fileUuid: uuid,
        name,
        fileKind: item?.file_kind || null,
        sizeBytes: item?.size_bytes ?? null,
        previewUrl: item?.preview_url || null,
        thumbnailUrl: item?.thumbnail_url || null,
        reason: "no cached preview/original bytes found",
      });
    }
  }

  const conversationDownloads = downloads.get(String(conversation.uuid || "").toLowerCase());
  if (conversationDownloads?.size) {
    for (const download of conversationDownloads.values()) {
      await ensureDir(assetsDir);
      const remoteBase = path.basename(download.remotePath) || "download";
      const outputName = uniqueName(
        `download_${slugify(remoteBase, { maxLength: 80, fallback: "download" })}`,
        usedDownloadNames,
      );
      const outputPath = path.join(assetsDir, outputName);
      await fs.writeFile(outputPath, download.bytes);
      const relativePath = relativePosix(outDir, outputPath);
      const record = {
        kind: "cached_download_file",
        remotePath: download.remotePath,
        output: relativePath,
        bytes: download.bytes.length,
        encoding: download.encoding,
        compressedBytes: download.compressedBytes,
        contentType: download.contentType,
        cachePath: download.cachePath,
        url: download.url,
      };
      manifest.assets.push(record);
      manifest.downloadAssets.push(record);
    }
  }

  return { assetState, manifest };
}

function selectConversations(scan, { conversations, limit }) {
  const recent = mergeRecentList(scan.lists);
  const recentByUuid = new Map(recent.map((item) => [item.uuid, item]));
  const skipped = [];

  if (conversations.length) {
    const selected = conversations
      .map((uuid) => ({ uuid, listItem: recentByUuid.get(uuid) || null, detail: scan.details.get(uuid) || null }))
      .filter((item) => {
        if (item.detail) return true;
        skipped.push({
          uuid: item.uuid,
          title: item.listItem?.name || item.listItem?.title || "",
          reason: "conversation detail is not present in local HTTP cache",
        });
        return false;
      });
    return { selected, recent, skipped };
  }

  const selected = [];
  const source = recent.length
    ? recent
    : [...scan.details.values()]
        .map((detail) => detail.json)
        .sort((a, b) => Date.parse(b.updated_at || "") - Date.parse(a.updated_at || ""));

  for (const item of source) {
    const uuid = String(item.uuid || "").toLowerCase();
    const detail = scan.details.get(uuid);
    if (!detail) {
      skipped.push({
        uuid,
        title: item.name || item.title || "",
        updatedAt: item.updated_at || "",
        reason: "conversation detail is not present in local HTTP cache",
      });
      continue;
    }
    selected.push({ uuid, listItem: recentByUuid.get(uuid) || item, detail });
    if (selected.length >= limit) break;
  }

  return { selected, recent, skipped };
}

async function exportConversation(selectedItem, ordinal, outDir, scan) {
  const conversation = selectedItem.detail.json;
  const title = conversationTitle(conversation, selectedItem.listItem);
  const slug = `${String(ordinal).padStart(2, "0")}_${slugify(title, { maxLength: 80, fallback: "untitled" })}_${shortUuid(conversation.uuid)}`;

  const { assetState, manifest } = await writeConversationAssets(
    conversation,
    slug,
    outDir,
    scan.previews,
    scan.downloads,
  );

  const markdownPath = path.join(outDir, `${slug}.md`);
  const rawPath = path.join(outDir, `${slug}.raw.json`);
  const manifestPath = path.join(outDir, `${slug}.manifest.json`);
  const markdown = renderConversationMarkdown(
    conversation,
    selectedItem.listItem,
    selectedItem.detail,
    assetState,
    manifest,
  );

  await writeFileAtomic(markdownPath, markdown);
  await writeFileAtomic(rawPath, JSON.stringify(conversation, null, 2));

  const fullManifest = {
    conversationUuid: conversation.uuid,
    title,
    createdAt: conversation.created_at || "",
    updatedAt: conversation.updated_at || "",
    messageCount: messagesOf(conversation).length,
    source: {
      detailCachePath: selectedItem.detail.cachePath,
      detailUrl: selectedItem.detail.url,
      listCachePath: selectedItem.listItem?.listCachePath || null,
      listUrl: selectedItem.listItem?.listUrl || null,
    },
    markdown: path.basename(markdownPath),
    rawJson: path.basename(rawPath),
    assets: manifest.assets,
    missingAssets: manifest.missingAssets,
  };
  await writeFileAtomic(manifestPath, JSON.stringify(fullManifest, null, 2));

  return {
    conversationUuid: conversation.uuid,
    title,
    updatedAt: conversation.updated_at || selectedItem.listItem?.updated_at || "",
    messages: messagesOf(conversation).length,
    markdown: path.basename(markdownPath),
    rawJson: path.basename(rawPath),
    manifest: path.basename(manifestPath),
    assets: manifest.assets.length,
    missingAssets: manifest.missingAssets.length,
  };
}

export async function exportClaudeCache({
  cacheDir = DEFAULT_CACHE_DIR,
  outDir = defaultOutputDir(),
  limit = 6,
  conversations = [],
} = {}) {
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("This Node.js build does not support zlib.zstdDecompressSync; Node 22+ is required.");
  }
  const normalizedConversations = conversations.map((uuid) => {
    if (!isUuid(uuid)) throw new Error(`Invalid conversation UUID: ${uuid}`);
    return uuid.toLowerCase();
  });

  const scan = await scanClaudeCache(cacheDir);
  const { selected, recent, skipped } = selectConversations(scan, {
    conversations: normalizedConversations,
    limit,
  });
  await ensureDir(outDir);

  const exported = [];
  for (let index = 0; index < selected.length; index += 1) {
    exported.push(await exportConversation(selected[index], index + 1, outDir, scan));
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    cacheDir,
    outputDir: outDir,
    filesScanned: scan.filesScanned,
    listResponses: scan.lists.length,
    cachedConversationDetails: scan.details.size,
    cachedFilePreviews: scan.previews.size,
    cachedDownloadFileGroups: scan.downloads.size,
    recentConversationsSeen: recent.length,
    requestedLimit: limit,
    exported,
    skipped: skipped.slice(0, 50),
    readErrors: scan.readErrors,
    note: "Export uses Claude Desktop HTTP cache only. It does not read cookies, keychain items, localStorage, or session tokens.",
  };

  await writeFileAtomic(path.join(outDir, "SUMMARY.json"), JSON.stringify(summary, null, 2));
  return summary;
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.error(USAGE);
      return;
    }
    const summary = await exportClaudeCache(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
