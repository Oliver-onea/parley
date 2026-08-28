#!/usr/bin/env node

// Export a public Kimi share (kimi.com/share/<uuid>) or a saved raw share HTML
// file to Markdown. The share page embeds the conversation as a dehydrated
// React Query state in `window.HYDRATION_INIT_STATE`; this module parses that
// state without executing page content and renders the message blocks.

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
import { fetchText, fetchWithRetry, USER_AGENT } from "../lib/http.mjs";
import { fenced, linkTarget } from "../lib/markdown.mjs";
import { ensureDir, ensureParent, posixRelative, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { formatFileSize, sanitizeFilename, sanitizeSegment } from "../lib/text.mjs";
import { isoFromUnixSeconds } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_kimi_share.mjs <kimi-share-url|raw-share-html> [output.md] [--assets|--no-assets]

Examples:
  node src/providers/export_kimi_share.mjs https://www.kimi.com/share/<share-id>
  node src/providers/export_kimi_share.mjs fixtures/kimi.raw.html exports/kimi.md

File blocks carry a signed download URL; attachments are downloaded into
<output>_assets/ by default. Use --no-assets to skip.`;

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

export function extractShareId(input) {
  const value = String(input || "");
  const fromUrl = value.match(/kimi\.com\/share\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromUrl) return fromUrl[1];
  const bare = value.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return bare?.[0] || "";
}

function extractScriptTags(html) {
  const scripts = [];
  const regex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  return scripts;
}

function isIdentifierCharacter(value) {
  return value !== undefined && /[A-Za-z0-9_$]/.test(value);
}

function skipStringLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    index += 1;
    if (source[index - 1] === quote) break;
  }
  return index;
}

function isValuePosition(source, start, end) {
  let before = start - 1;
  while (before >= 0 && /\s/.test(source[before])) before -= 1;
  let after = end;
  while (after < source.length && /\s/.test(source[after])) after += 1;

  const beforeIsValueDelimiter =
    before < 0 || source[before] === ":" || source[before] === "," || source[before] === "[";
  const afterIsValueDelimiter =
    after >= source.length || source[after] === "," || source[after] === "]" || source[after] === "}";
  return beforeIsValueDelimiter && afterIsValueDelimiter;
}

function preprocessHydrationExpression(expr) {
  let output = "";
  let index = 0;

  while (index < expr.length) {
    const char = expr[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = skipStringLiteral(expr, index);
      output += expr.slice(index, end);
      index = end;
      continue;
    }

    if (expr.startsWith("BigInt", index) && !isIdentifierCharacter(expr[index - 1])) {
      const match = expr.slice(index).match(/^BigInt\s*\(\s*([+-]?\d+)\s*\)/);
      const end = match ? index + match[0].length : index;
      if (match && !isIdentifierCharacter(expr[end]) && isValuePosition(expr, index, end)) {
        output += JSON.stringify(match[1]);
        index = end;
        continue;
      }
    }

    if (expr.startsWith("undefined", index) && !isIdentifierCharacter(expr[index - 1])) {
      const end = index + "undefined".length;
      if (!isIdentifierCharacter(expr[end]) && isValuePosition(expr, index, end)) {
        output += "null";
        index = end;
        continue;
      }
    }

    output += char;
    index += 1;
  }

  return output;
}

export function extractHydrationState(html) {
  const scripts = extractScriptTags(html);
  const stateScript = scripts.find((script) => script.trim().startsWith("window.HYDRATION_INIT_STATE="));
  if (!stateScript) {
    throw new Error("Could not find window.HYDRATION_INIT_STATE in the Kimi share page.");
  }

  const expr = stateScript.trim().replace(/^window\.HYDRATION_INIT_STATE=/, "").replace(/;\s*$/, "");
  try {
    // Normalize the two non-JSON values while preserving quoted content, then
    // let JSON.parse reject every other JavaScript expression.
    return JSON.parse(preprocessHydrationExpression(expr));
  } catch (error) {
    throw new Error(`Could not parse Kimi hydration state: ${error.message || String(error)}`);
  }
}

function findShareQuery(state) {
  if (!state || !Array.isArray(state.queries)) return null;
  return state.queries.find((query) => query?.queryKey?.[0] === "share");
}

function timestampSeconds(ts) {
  if (!ts || typeof ts !== "object") return null;
  if (typeof ts.seconds === "bigint") return Number(ts.seconds);
  if (typeof ts.seconds === "number") return ts.seconds;
  if (typeof ts.seconds === "string") return Number(ts.seconds);
  return null;
}

function roleLabel(role) {
  if (role === 2) return "You";
  if (role === 3) return "Kimi";
  return `Role ${role}`;
}

function blockType(block) {
  return block?.content?.case || "";
}

function blockValue(block) {
  return block?.content?.value;
}

function renderTextBlock(block) {
  const value = blockValue(block);
  return String(value?.content || "").trim();
}

function renderThinkBlock(block) {
  const value = blockValue(block);
  const content = String(value?.content || "").trim();
  const summary = String(value?.summary || "").trim();
  if (!content) return "";
  const lines = ["**Thinking**", ""];
  if (summary) lines.push(`_${summary}_`, "");
  lines.push(fenced(content, ""));
  return lines.join("\n");
}

function renderSearchResult(result) {
  const base = result?.base || result || {};
  const title = base.title || "Search result";
  const url = base.url || "";
  const snippet = String(base.snippet || "").trim();
  const site = base.siteName || "";
  const refIndex = result?.refIndex || "";

  let label = title;
  if (site && !title.includes(site)) label = `${title} — ${site}`;
  if (refIndex) label = `[${refIndex}] ${label}`;

  let out = url ? `- ${label}: ${linkTarget(url)}` : `- ${label}`;
  if (snippet) out += `\n  > ${snippet.replace(/\n+/g, " ")}`;
  return out;
}

function renderToolBlock(block) {
  const value = blockValue(block);
  const name = value?.name || "";
  const args = value?.args || "";
  const contents = value?.contents || [];

  const lines = [];
  if (name) lines.push(`**Tool call: ${name}**`);
  if (args) {
    try {
      const parsed = JSON.parse(args);
      lines.push("", fenced(JSON.stringify(parsed, null, 2), "json"));
    } catch {
      lines.push("", fenced(args, ""));
    }
  }

  const searchResults = contents
    .map((item) => item?.content)
    .filter((item) => item?.case === "searchResult")
    .map((item) => item.value);

  if (searchResults.length) {
    lines.push("", "**Search results**", "");
    for (const result of searchResults) lines.push(renderSearchResult(result));
  }

  return lines.join("\n");
}

// Map a Kimi `file` block value (protobuf-ish) to a flat attachment record.
// sizeBytes/tokenCount may arrive as BigInt; coerce for display/manifest.
function extractAttachment(value) {
  const meta = value?.meta || {};
  const blob = value?.blob || {};
  return {
    id: String(value?.id || ""),
    name: String(meta.name || value?.id || "file"),
    contentType: String(meta.contentType || ""),
    sizeBytes: Number(meta.sizeBytes ?? 0),
    ext: String(meta.ext || ""),
    tokenCount: Number(value?.tokenCount ?? 0),
    status: Number(value?.status ?? 0),
    failReason: String(value?.failReason || ""),
    signUrl: String(blob.signUrl || ""),
    previewUrl: String(blob.previewUrl || ""),
  };
}

function renderBlock(block) {
  const type = blockType(block);
  switch (type) {
    case "text":
      return renderTextBlock(block);
    case "think":
      return renderThinkBlock(block);
    case "tool":
      return renderToolBlock(block);
    case "file":
      // Attachments are collected in parseKimiShare and rendered separately.
      return "";
    case "multiStage":
    case "stage":
      // Layout wrappers; their children are rendered as separate blocks.
      return "";
    default:
      return "";
  }
}

export function parseKimiShare(data) {
  const chat = data?.chat || {};
  const rawMessages = Array.isArray(data?.messages) ? data.messages : [];

  const messages = rawMessages
    .map((message) => {
      const blocks = Array.isArray(message?.blocks) ? message.blocks : [];
      const renderedBlocks = blocks.map(renderBlock).filter(Boolean);
      const attachments = blocks
        .filter((block) => blockType(block) === "file")
        .map((block) => extractAttachment(blockValue(block)));
      return {
        id: message?.id || "",
        parentId: message?.parentId || "",
        role: message?.role,
        createdAt: timestampSeconds(message?.createTime),
        blocks: renderedBlocks,
        attachments,
      };
    })
    .filter((message) => message.role === 2 || message.role === 3);

  return {
    title: chat.name || "Kimi Share Export",
    shareId: data?.id || "",
    chatId: chat.id || "",
    createdAt: timestampSeconds(chat?.createTime),
    updatedAt: timestampSeconds(chat?.updateTime),
    creatorName: data?.creator?.name || "",
    messages,
  };
}

function collectAttachments(messages) {
  const all = [];
  let ordinal = 0;
  for (const message of messages) {
    for (const att of message.attachments || []) {
      ordinal += 1;
      all.push({ ...att, ordinal });
    }
  }
  return all;
}

// Kimi file blocks carry a signed `signUrl` that 307-redirects to a Volcengine
// object-storage URL. Download each into <output>_assets/, mirroring the
// ChatGPT asset handling. Returns { manifest, byAttachmentId }.
async function downloadAttachments({ attachments, outputPath }) {
  const markdownDir = path.dirname(outputPath);
  const manifest = createAssetManifest(outputPath);
  const byAttachmentId = new Map();

  await ensureDir(manifest.assetsDir);
  for (const att of attachments) {
    const record = {
      index: att.ordinal,
      fileId: att.id,
      name: att.name,
      contentType: att.contentType,
      sizeBytes: att.sizeBytes,
    };
    try {
      if (!att.signUrl) throw new Error("no signed download URL in share data");
      const response = await fetchWithRetry(att.signUrl, {
        redirect: "follow",
        headers: { "user-agent": USER_AGENT },
      });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type") || "";
      if (/text\/html/i.test(contentType)) {
        throw new Error("download returned an HTML page instead of a file");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const baseName = sanitizeFilename(att.name.replace(/\.[^.]+$/, "") || att.id, att.id);
      const metaExt = att.ext ? `.${att.ext.replace(/^\./, "")}` : "";
      const ext =
        path.extname(att.name) ||
        metaExt ||
        extensionFromContentType(contentType || att.contentType) ||
        extensionFromBuffer(buffer) ||
        extensionFromUrl(att.signUrl) ||
        ".bin";
      const filename = `${String(att.ordinal).padStart(3, "0")}_${baseName}${ext}`;
      const filePath = path.join(manifest.assetsDir, filename);
      await fs.writeFile(filePath, buffer);
      Object.assign(record, {
        status: "downloaded",
        filename,
        relativePath: posixRelative(markdownDir, filePath),
        contentType,
        bytes: buffer.length,
      });
      byAttachmentId.set(att.id, record);
    } catch (error) {
      Object.assign(record, { status: "failed", error: error.message || String(error) });
    }
    appendAssetRecord(manifest, record);
  }

  updateAssetManifestCounts(manifest);
  return { manifest, byAttachmentId };
}

function isImageAttachment(att) {
  return /^image\//i.test(att.contentType) || att.contentType === "image";
}

function describeAttachment(att, assets) {
  const bits = [];
  if (att.contentType) bits.push(att.contentType);
  if (att.sizeBytes) bits.push(formatFileSize(att.sizeBytes));
  const asset = assets?.byAttachmentId?.get(att.id);
  if (asset) {
    const label = att.name.replace(/[[\]]/g, "");
    if (isImageAttachment(att)) {
      return `![${label}](${linkTarget(asset.relativePath)})`;
    }
    return `- [${label}](${linkTarget(asset.relativePath)})${bits.length ? ` (${bits.join("; ")})` : ""}`;
  }
  return `- ${[att.name, ...bits].join(" | ")} — not downloaded`;
}

export function buildMarkdown(parsed, source, { assets = null } = {}) {
  const userCount = parsed.messages.filter((m) => m.role === 2).length;
  const assistantCount = parsed.messages.length - userCount;
  const attachments = collectAttachments(parsed.messages);

  const metaLines = [
    `- Source: ${source}`,
    `- Share title: ${parsed.title}`,
    parsed.creatorName ? `- Shared by: ${parsed.creatorName}` : "",
    `- Exported messages: ${parsed.messages.length} (${userCount} user, ${assistantCount} assistant)`,
    attachments.length ? `- Attachments in share: ${attachments.length}` : "",
    assets ? `- Attachments downloaded: ${assets.manifest.downloaded}/${assets.manifest.assets.length}` : "",
    `- Exported at: ${new Date().toISOString()}`,
  ].filter(Boolean);

  const lines = [`# ${parsed.title}`, "", ...metaLines, "", "## Conversation"];

  parsed.messages.forEach((message, index) => {
    const role = roleLabel(message.role);
    const created = isoFromUnixSeconds(message.createdAt);
    const meta = [`message ${index + 1}`];
    if (message.id) meta.push(`id ${message.id}`);
    if (created) meta.push(created);

    lines.push(
      "",
      `### ${String(index + 1).padStart(2, "0")}. ${role}`,
      "",
      `<!-- ${meta.join(" | ")} -->`,
      "",
      message.blocks.join("\n\n"),
    );

    const msgAttachments = message.attachments || [];
    if (msgAttachments.length) {
      lines.push("", "**Attachments**", "");
      for (const att of msgAttachments) lines.push(describeAttachment(att, assets));
    }
  });

  if (attachments.length) {
    lines.push("", "## Attachments", "");
    for (const att of attachments) lines.push(describeAttachment(att, assets));
  }

  lines.push("");
  return { markdown: lines.join("\n"), messages: parsed.messages };
}

function defaultOutputPath(input) {
  const shareId = extractShareId(input) || sanitizeSegment(path.basename(input).replace(/\.[^.]+$/, ""));
  return path.join("exports", "kimi", `kimi_share_${sanitizeSegment(shareId)}.md`);
}

export async function exportKimiShare({ input, output = "", downloadAssets = true } = {}) {
  if (!input) throw new Error("kimi requires a share URL or saved share HTML file.");

  let html;
  let source;
  if (looksLikeUrl(input)) {
    const page = await fetchText(input, {
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    html = page.text;
    source = input;
  } else {
    html = await fs.readFile(input, "utf8");
    source = input;
  }

  const state = extractHydrationState(html);
  const shareQuery = findShareQuery(state);
  if (!shareQuery || !shareQuery.state?.data) {
    throw new Error("Could not locate the share conversation in the Kimi hydration state.");
  }

  const parsed = parseKimiShare(shareQuery.state.data);
  const outputPath = output || defaultOutputPath(input, parsed);

  const attachments = collectAttachments(parsed.messages);
  let assets = null;
  if (downloadAssets && attachments.length) {
    assets = await downloadAttachments({ attachments, outputPath });
  }

  const { markdown, messages } = buildMarkdown(parsed, source, { assets });

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);
  if (assets) {
    await writeAssetManifest(assets.manifest);
  }

  return {
    output: outputPath,
    title: parsed.title,
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
    const summary = await exportKimiShare(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
