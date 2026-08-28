#!/usr/bin/env node

// Export a public Qwen share (chat.qwen.ai/s/<uuid>) to Markdown. The share
// page's anonymous JSON endpoint exposes the conversation tree directly.

import { fetchText } from "../lib/http.mjs";
import { linkTarget, scalar } from "../lib/markdown.mjs";
import { ensureParent, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { defaultShareOutputPath } from "../lib/share-paths.mjs";
import { formatFileSize, parseJsonText } from "../lib/text.mjs";
import { isoFromEpoch, isoFromUnixSeconds } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_qwen_share.mjs <qwen-share-url|uuid> [output.md]

Examples:
  node src/providers/export_qwen_share.mjs https://chat.qwen.ai/s/<share-id>
  node src/providers/export_qwen_share.mjs <share-id> exports/qwen.md`;

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function extractShareId(input) {
  const value = String(input || "").trim();
  const fromUrl = value.match(new RegExp(`chat\\.qwen\\.ai/s/(${UUID_PATTERN})`, "i"));
  if (fromUrl) return fromUrl[1];
  const bare = value.match(new RegExp(`^${UUID_PATTERN}$`, "i"));
  return bare?.[0] || "";
}

function shareApiUrl(shareId) {
  return `https://chat.qwen.ai/api/v2/chats/share/${encodeURIComponent(shareId)}`;
}

async function fetchQwenShare(input) {
  const shareId = extractShareId(input);
  if (!shareId) throw new Error("Could not extract Qwen share UUID from the input.");

  const shareUrl = `https://chat.qwen.ai/s/${shareId}`;
  const apiUrl = shareApiUrl(shareId);
  const { text } = await fetchText(apiUrl, {
    headers: { accept: "application/json", referer: shareUrl },
  });

  let payload;
  try {
    payload = parseJsonText(text);
  } catch {
    throw new Error(`Qwen share API did not return JSON. First bytes:\n${text.slice(0, 500)}`);
  }

  if (payload?.success !== true || !payload?.data) {
    const message = payload?.message || payload?.error || "";
    throw new Error(`Qwen share API returned an error${message ? `: ${message}` : ""}`);
  }

  return { data: payload.data, meta: { inputUrl: input, shareUrl, apiUrl, shareId } };
}

function normalizeMessages(messages) {
  const entries = Array.isArray(messages)
    ? messages.map((message, index) => [message?.id ?? index, message])
    : Object.entries(messages || {});
  const byId = new Map();

  for (const [key, message] of entries) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const id = String(message.id ?? key);
    byId.set(id, { ...message, id });
  }
  return byId;
}

function childIds(message, byId) {
  return (Array.isArray(message?.childrenIds) ? message.childrenIds : [])
    .map((id) => String(id ?? ""))
    .filter((id) => id && byId.has(id));
}

function leadsToCurrent(byId, nodeId, currentId, visited = new Set()) {
  if (!currentId || nodeId === currentId) return nodeId === currentId;
  if (visited.has(nodeId)) return false;

  const message = byId.get(nodeId);
  if (!message) return false;
  const nextVisited = new Set(visited).add(nodeId);
  return childIds(message, byId).some((childId) =>
    leadsToCurrent(byId, childId, currentId, nextVisited),
  );
}

function activeBranch(data) {
  const byId = normalizeMessages(data?.chat?.history?.messages);
  if (!byId.size) return [];

  const currentId = data?.currentId == null ? "" : String(data.currentId);
  const roots = [...byId.values()].filter(
    (message) => message.parentId === null || message.parentId === undefined,
  );
  const rootCandidates = roots.length
    ? roots
    : [...byId.values()].filter(
        (message) => !byId.has(String(message.parentId ?? "")),
      );
  const root =
    rootCandidates.find((message) => leadsToCurrent(byId, message.id, currentId)) ||
    rootCandidates[0] ||
    [...byId.values()][0];

  const selected = [];
  const visited = new Set();
  let nodeId = root.id;
  while (nodeId && !visited.has(nodeId)) {
    const message = byId.get(nodeId);
    if (!message) break;
    visited.add(nodeId);
    selected.push(message);

    const children = childIds(message, byId);
    const preferred = currentId
      ? children.find((childId) => leadsToCurrent(byId, childId, currentId))
      : "";
    nodeId = preferred || children[0] || "";
  }

  return selected;
}

function modelOf(message) {
  return String(message?.modelName || message?.model || "").trim();
}

function assistantBody(message) {
  const contentList = Array.isArray(message?.content_list) ? message.content_list : [];
  const answers = contentList
    .filter((item) => String(item?.phase || "").toLowerCase() === "answer")
    .map((item) => (typeof item?.content === "string" ? item.content : ""))
    .filter((content) => content.length > 0);

  if (answers.length) return answers.join("\n\n");
  if (contentList.some((item) => String(item?.phase || "").toLowerCase() !== "answer")) {
    return "_(no answer content exposed; only non-answer phases are present)_";
  }
  return "";
}

function messageBody(message) {
  if (message.role === "assistant") return assistantBody(message);
  return typeof message.content === "string" ? message.content : "";
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object?.[key] != null && object[key] !== "") return object[key];
  }
  return "";
}

function formatFileEntry(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    return `- ${scalar(file)}`;
  }

  const metadata = file.metadata && typeof file.metadata === "object" ? file.metadata : {};
  const value = (keys) => firstValue(file, keys) || firstValue(metadata, keys);
  const name = value(["name", "file_name", "filename", "fileName", "id", "file_id", "fileId"]) || "file";
  const bits = [String(name)];
  const type = value(["mime_type", "mimeType", "file_type", "type"]);
  const size = formatFileSize(value(["size", "size_bytes", "sizeBytes", "file_size"]));
  const id = value(["id", "file_id", "fileId"]);
  const status = value(["status"]);
  const publicUrl = value(["url", "public_url", "publicUrl", "download_url", "downloadUrl"]);

  if (type) bits.push(String(type));
  if (size) bits.push(size);
  if (id && String(id) !== String(name)) bits.push(`id ${id}`);
  if (status) bits.push(`status ${status}`);
  if (/^https?:\/\//i.test(String(publicUrl))) {
    bits.push(`[public URL](${linkTarget(publicUrl)})`);
  }
  return `- ${bits.join(" | ")}`;
}

function renderMessage(message) {
  const sections = [];
  if (message.files.length) {
    sections.push(
      [
        "**Files**",
        ...message.files.map((file) => formatFileEntry(file)),
        "",
        "_File content was not downloaded; the public share exposes metadata only._",
      ].join("\n"),
    );
  }

  const body = String(message.text || "").trim();
  if (body) sections.push(body);
  return sections.join("\n\n") || "_(empty)_";
}

export function parseQwenShare(data, meta = {}) {
  const share = data?.success === true && data.data ? data.data : data || {};
  const selected = activeBranch(share).filter((message) =>
    ["user", "assistant"].includes(String(message.role || "").toLowerCase()),
  );
  const messages = selected.map((message) => ({
    id: message.id || "",
    role: String(message.role || "").toLowerCase(),
    timestamp: message.timestamp,
    text: messageBody(message),
    files:
      String(message.role || "").toLowerCase() === "user" && Array.isArray(message.files)
        ? message.files
        : [],
    model: modelOf(message),
  }));
  const models = [
    share.modelName,
    share.model,
    ...messages.map((message) => message.model),
  ].filter(Boolean);

  return {
    title: share.title || "Qwen Share Export",
    shareId: meta.shareId || share.id || "",
    createdAt: share.created_at,
    updatedAt: share.updated_at,
    currentId: share.currentId || "",
    currentResponseIds: Array.isArray(share.currentResponseIds) ? share.currentResponseIds : [],
    models: [...new Set(models)],
    messages,
  };
}

function fileCount(messages) {
  return messages.reduce((count, message) => count + message.files.length, 0);
}

export function renderMarkdown(parsed, meta = {}) {
  const source = meta.shareUrl || (parsed.shareId ? `https://chat.qwen.ai/s/${parsed.shareId}` : meta.inputUrl || "");
  const model = parsed.models.length ? parsed.models.join(", ") : "Unknown";
  const files = fileCount(parsed.messages);
  const metaLines = [
    source ? `- Source: ${source}` : "",
    `- Model: ${model}`,
    `- Created: ${isoFromUnixSeconds(parsed.createdAt)}`,
    `- Updated: ${isoFromUnixSeconds(parsed.updatedAt)}`,
    `- Exported messages: ${parsed.messages.length}`,
    files ? `- Files in public share: ${files} (metadata only)` : "",
    "- Extraction: Qwen public-share API `GET /api/v2/chats/share/<uuid>`",
  ].filter(Boolean);

  const lines = [`# ${parsed.title}`, "", ...metaLines, "", "---", "", "## Messages", ""];
  parsed.messages.forEach((message, index) => {
    const role = message.role === "user" ? "You" : "Qwen";
    const timestamp = isoFromEpoch(message.timestamp);
    const comment = [
      `message ${message.id}`,
      timestamp,
      message.role === "assistant" && message.model ? `model ${message.model}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    lines.push(`### ${String(index + 1).padStart(2, "0")}. ${role}`);
    lines.push("", `<!-- ${comment} -->`, "", renderMessage(message), "");
  });

  return `${lines.join("\n").trim()}\n`;
}

export async function exportQwenShare({ input, output = "" } = {}) {
  if (!input) throw new Error("qwen requires a share URL or bare UUID.");

  const { data, meta } = await fetchQwenShare(input);
  const parsed = parseQwenShare(data, meta);
  const outputPath = output || defaultShareOutputPath("qwen", input);
  const markdown = renderMarkdown(parsed, meta);

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);

  return {
    output: outputPath,
    title: parsed.title,
    messages: parsed.messages.length,
    models: parsed.models,
    source: parsed.shareId ? `https://chat.qwen.ai/s/${parsed.shareId}` : null,
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
    const summary = await exportQwenShare({ input, output: process.argv[3] || "" });
    console.log(JSON.stringify(summary, null, 2));
  });
}
