#!/usr/bin/env node

// Export a public Claude share (claude.ai/share/<uuid>) or a saved raw
// snapshot JSON file to Markdown.

import fs from "node:fs/promises";
import path from "node:path";

import {
  extractTextFromContent,
  messagesOf,
  renderMessage,
  titleOf,
} from "../lib/claude.mjs";
import { fetchText } from "../lib/http.mjs";
import { scalar } from "../lib/markdown.mjs";
import { ensureParent, writeFileAtomic } from "../lib/paths.mjs";
import { parseJsonText } from "../lib/text.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";

const USAGE = `Usage:
  node src/providers/export_claude_share.mjs <claude-share-url|raw-json-file> [output.md]

Examples:
  node src/providers/export_claude_share.mjs https://claude.ai/share/<share-id>
  node src/providers/export_claude_share.mjs fixtures/claude.raw.json exports/claude.md`;

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

export function extractSnapshotId(input) {
  const value = String(input);
  const fromShare = value.match(/claude\.ai\/share\/([0-9a-f-]{32,36})/i);
  if (fromShare) return fromShare[1];
  const fromApi = value.match(/chat_snapshots\/([0-9a-f-]{32,36})/i);
  if (fromApi) return fromApi[1];
  const bare = value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return bare?.[0] || "";
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

function cookieHeader(setCookies) {
  return setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function fetchClaudeSnapshot(inputUrl) {
  const snapshotId = extractSnapshotId(inputUrl);
  if (!snapshotId) throw new Error("Could not extract Claude share snapshot UUID.");

  const shareUrl = `https://claude.ai/share/${snapshotId}`;
  const page = await fetchText(shareUrl, {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });
  const cookies = getSetCookies(page.response.headers);
  const apiUrl =
    `https://claude.ai/api/chat_snapshots/${snapshotId}` +
    "?rendering_mode=messages&render_all_tools=true";
  const api = await fetchText(apiUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      cookie: cookieHeader(cookies),
      referer: shareUrl,
    },
  });

  let data;
  try {
    data = JSON.parse(api.text);
  } catch {
    throw new Error(`Claude API did not return JSON. First bytes:\n${api.text.slice(0, 500)}`);
  }

  return {
    data,
    meta: { inputUrl, shareUrl, apiUrl, snapshotId },
  };
}

function renderFileList(label, items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines = [`**${label}:**`];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      lines.push(`- ${scalar(item)}`);
      continue;
    }
    const name =
      item.file_name || item.name || item.filename || item.path || item.uuid || item.file_uuid || "file";
    const bits = [String(name)];
    if (item.size != null) bits.push(`${item.size} bytes`);
    const fileType = item.file_type || item.mime_type || item.type;
    if (fileType) bits.push(String(fileType));
    const url = item.url || item.download_url;
    if (url) bits.push(String(url));
    lines.push(`- ${bits.join(" | ")}`);
  }
  return lines.join("\n");
}

function collectMessageText(message) {
  const parts = [];
  if (message?.text) parts.push(message.text);
  const content = message?.content || [];
  for (const block of Array.isArray(content) ? content : [content]) {
    if (block?.text) parts.push(block.text);
    else if (block?.content) parts.push(extractTextFromContent(block.content));
  }
  return parts.filter(Boolean).join("\n\n");
}

function extractLocalSourceRefs(text) {
  return Array.from(
    new Set(
      String(text || "")
        .match(/(?:SourceURL:)?file:\/\/[^\s)>\]]+/g)
        ?.map((item) => item.replace(/^SourceURL:/, "")) || [],
    ),
  );
}

// Claude's public share API strips file bodies but still reports counts
// (file_count / image_count). Surface that instead of silently losing them.
function hiddenFileNote(message) {
  const exposed =
    (Array.isArray(message?.files) ? message.files.length : 0) +
    (Array.isArray(message?.attachments) ? message.attachments.length : 0);
  const declared = Number(message?.file_count) || 0;
  const images = Number(message?.image_count) || 0;
  if (declared <= exposed) return "";
  const imageNote = images ? `, ${images} image(s)` : "";
  return (
    `> **[${declared} attached file(s)${imageNote} hidden by Claude]** — ` +
    "public Claude shares do not expose uploaded files (\"Files hidden in shared chats\")."
  );
}

function messageExtras(message) {
  const extras = [
    renderFileList("Attachments", message?.attachments || []),
    renderFileList("Files", message?.files || []),
    hiddenFileNote(message),
  ];
  const localSourceRefs = extractLocalSourceRefs(collectMessageText(message));
  if (localSourceRefs.length) {
    extras.push(
      [
        "**Local source references found in exported text:**",
        ...localSourceRefs.map((ref) => `- ${ref}`),
        "",
        "_The public Claude share JSON did not expose this original file as a downloadable attachment._",
      ].join("\n"),
    );
  }
  return extras;
}

function hiddenFileTotal(messages) {
  return messages.reduce((sum, message) => {
    const exposed =
      (Array.isArray(message?.files) ? message.files.length : 0) +
      (Array.isArray(message?.attachments) ? message.attachments.length : 0);
    return sum + Math.max(0, (Number(message?.file_count) || 0) - exposed);
  }, 0);
}

export function renderMarkdown(data, meta = {}) {
  const messages = messagesOf(data);
  const source = meta.shareUrl || (data.uuid ? `https://claude.ai/share/${data.uuid}` : "");
  const title = titleOf(data);
  const metaLines = [
    source ? `- Source: ${source}` : "",
    meta.inputUrl && meta.inputUrl !== source ? `- Original link: ${meta.inputUrl}` : "",
    `- Snapshot UUID: ${data.uuid || meta.snapshotId || ""}`,
    data.conversation_uuid ? `- Conversation UUID: ${data.conversation_uuid}` : "",
    `- Model: ${data.model || "Unknown"}`,
    `- Created at: ${data.created_at || ""}`,
    `- Updated at: ${data.updated_at || ""}`,
    data.current_leaf_message_uuid
      ? `- Current leaf message UUID: ${data.current_leaf_message_uuid}`
      : "",
    `- Exported messages: ${messages.length}`,
    hiddenFileTotal(messages)
      ? `- Files hidden by Claude in this share: ${hiddenFileTotal(messages)} (not downloadable from public shares)`
      : "",
    "- Extraction: Claude `chat_snapshots` JSON API after public share cookie bootstrap",
  ].filter(Boolean);

  const lines = [`# ${title}`, "", ...metaLines, "", "---", "", "## Messages", ""];
  messages.forEach((message, index) => {
    lines.push(renderMessage(message, index + 1, messageExtras(message)), "");
  });
  return `${lines.join("\n").trim()}\n`;
}

function defaultOutputPath(input, data, meta = {}) {
  const id = data.uuid || meta.snapshotId || extractSnapshotId(input) || "claude_share";
  return path.join("exports", "claude", "share", `claude_share_${id}.md`);
}

export async function exportClaudeShare({ input, output = "" } = {}) {
  if (!input) throw new Error("claude-share requires a share URL or raw JSON file.");

  let data;
  let meta = {};
  if (looksLikeUrl(input)) {
    ({ data, meta } = await fetchClaudeSnapshot(input));
  } else {
    data = parseJsonText(await fs.readFile(input, "utf8"));
  }

  const outputPath = output || defaultOutputPath(input, data, meta);
  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, renderMarkdown(data, meta));

  return {
    output: outputPath,
    messages: messagesOf(data).length,
    title: titleOf(data),
    snapshotId: data.uuid || meta.snapshotId || null,
    source: meta.shareUrl || null,
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const input = process.argv[2];
    if (!input || input === "-h" || input === "--help") {
      console.error(USAGE);
      process.exitCode = input ? 0 : 1;
      return;
    }
    const summary = await exportClaudeShare({ input, output: process.argv[3] || "" });
    console.log(JSON.stringify(summary, null, 2));
  });
}
