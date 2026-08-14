#!/usr/bin/env node

// Export a public DeepSeek share (chat.deepseek.com/share/<id>) or a saved raw
// share JSON file to Markdown. Reads the public share API
// `/api/v0/share/content?share_id=<id>` used by the share page.

import fs from "node:fs/promises";
import path from "node:path";

import { fetchText } from "../lib/http.mjs";
import { fenced, linkTarget } from "../lib/markdown.mjs";
import { ensureParent, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { formatFileSize, sanitizeSegment } from "../lib/text.mjs";
import { isoFromUnixSeconds } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_deepseek_share.mjs <deepseek-share-url|raw-share-json> [output.md]

Examples:
  node src/providers/export_deepseek_share.mjs https://chat.deepseek.com/share/<share-id>
  node src/providers/export_deepseek_share.mjs fixtures/deepseek.raw.json exports/deepseek.md`;

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

function looksLikeShareId(value) {
  return /^[A-Za-z0-9_-]{10,}$/.test(String(value || ""));
}

export function extractShareId(input) {
  const value = String(input || "");
  const fromUrl = value.match(/chat\.deepseek\.com\/share\/([A-Za-z0-9_-]+)/i);
  if (fromUrl) return fromUrl[1];
  return looksLikeShareId(value) ? value : "";
}

function shareApiUrl(shareId) {
  return `https://chat.deepseek.com/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`;
}

async function fetchDeepSeekShare(inputUrl) {
  const shareId = extractShareId(inputUrl);
  if (!shareId) throw new Error("Could not extract DeepSeek share id from the URL.");

  const apiUrl = shareApiUrl(shareId);
  const { text } = await fetchText(apiUrl, {
    headers: { accept: "application/json" },
  });

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`DeepSeek share API did not return JSON. First bytes:\n${text.slice(0, 500)}`);
  }

  if (payload?.code !== 0 || !payload?.data?.biz_data) {
    const msg = payload?.msg || payload?.data?.biz_msg || "";
    throw new Error(`DeepSeek share API returned error${msg ? `: ${msg}` : ""}`);
  }

  return { data: payload.data.biz_data, meta: { inputUrl, shareId, apiUrl } };
}

function roleLabel(role) {
  if (role === "USER") return "User";
  if (role === "ASSISTANT") return "Assistant";
  return String(role || "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

function formatSearchResult(result) {
  const title = result.title || "Search result";
  const url = result.url || "";
  const snippet = (result.snippet || "").trim();
  let out = url ? `- [${title}](${linkTarget(url)})` : `- ${title}`;
  if (snippet) out += `\n  > ${snippet.replace(/\n+/g, " ")}`;
  return out;
}

// DeepSeek's share API exposes file metadata (file_name, file_size, id,
// previewable) but no download URL; anonymous file endpoints return the
// app shell, not file bytes. Format what we have and annotate the gap,
// mirroring the Claude hidden-files handling.
function formatFileEntry(file) {
  if (!file || typeof file !== "object") return `- ${file}`;
  const name = file.file_name || file.name || file.id || "file";
  const bits = [String(name)];
  const size = formatFileSize(file.file_size ?? file.size);
  if (size) bits.push(size);
  if (file.id && file.id !== file.file_name) bits.push(`id ${file.id}`);
  return `- ${bits.join(" | ")}`;
}

function fileMetadataTotal(messages) {
  return messages.reduce(
    (sum, message) => sum + (Array.isArray(message?.files) ? message.files.length : 0),
    0,
  );
}

function renderMessage(message) {
  const parts = [];

  const content = String(message.content || "").trim();
  if (content) parts.push(content);

  const thinking = String(message.thinking_content || "").trim();
  if (thinking) {
    parts.push("", "**Thinking**", "", fenced(thinking, ""));
  }

  const searchResults = message.search_results || message.search_status?.results;
  if (Array.isArray(searchResults) && searchResults.length) {
    parts.push("", "**Search results**", "");
    for (const result of searchResults) parts.push(formatSearchResult(result));
  }

  const files = message.files || [];
  if (files.length) {
    parts.push("", "**Files**", "");
    for (const file of files) parts.push(formatFileEntry(file));
    parts.push(
      "",
      "> _DeepSeek public shares expose file metadata only — uploaded file content is not downloadable._",
    );
  }

  return parts.join("\n");
}

export function buildMarkdown(data, source) {
  const messages = (data.messages || []).filter((message) => {
    const role = String(message.role || "").toUpperCase();
    return ["USER", "ASSISTANT"].includes(role);
  });

  const userCount = messages.filter((m) => String(m.role).toUpperCase() === "USER").length;
  const assistantCount = messages.length - userCount;

  const fileTotal = fileMetadataTotal(messages);
  const headerLines = [
    `- Source: ${source}`,
    `- Share title: ${data.title || ""}`,
    `- Exported messages: ${messages.length} (${userCount} user, ${assistantCount} assistant)`,
  ];
  if (fileTotal) {
    headerLines.push(
      `- Files in this share: ${fileTotal} (metadata only, not downloadable from public shares)`,
    );
  }
  headerLines.push(`- Exported at: ${new Date().toISOString()}`);

  const lines = [
    `# ${data.title || "DeepSeek Share Export"}`,
    "",
    ...headerLines,
    "",
    "## Conversation",
  ];

  messages.forEach((message, index) => {
    const role = roleLabel(message.role);
    const created = isoFromUnixSeconds(message.inserted_at);
    const meta = [`message ${message.message_id}`];
    if (created) meta.push(created);
    if (message.model) meta.push(`model ${message.model}`);

    lines.push(
      "",
      `### ${String(index + 1).padStart(2, "0")}. ${role}`,
      "",
      `<!-- ${meta.join(" | ")} -->`,
      "",
      renderMessage(message),
    );
  });

  lines.push("");
  return { markdown: lines.join("\n"), messages };
}

function defaultOutputPath(input) {
  const shareId = extractShareId(input) || sanitizeSegment(path.basename(input).replace(/\.[^.]+$/, ""));
  return path.join("exports", "deepseek", `deepseek_share_${sanitizeSegment(shareId)}.md`);
}

export async function exportDeepSeekShare({ input, output = "" } = {}) {
  if (!input) throw new Error("deepseek requires a share URL or saved share JSON file.");

  let data;
  let source;
  if (looksLikeUrl(input)) {
    ({ data, meta: source } = await fetchDeepSeekShare(input));
    source = source.inputUrl;
  } else {
    const text = await fs.readFile(input, "utf8");
    const payload = JSON.parse(text);
    if (payload?.data?.biz_data) {
      data = payload.data.biz_data;
    } else {
      data = payload;
    }
    source = input;
  }

  const { markdown, messages } = buildMarkdown(data, source);
  const outputPath = output || defaultOutputPath(input);

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);

  return {
    output: outputPath,
    title: data.title,
    exportedMessages: messages.length,
    bytes: Buffer.byteLength(markdown),
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = { input: "", output: "" };
    for (const arg of process.argv.slice(2)) {
      if (arg === "-h" || arg === "--help") {
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
    const summary = await exportDeepSeekShare(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
