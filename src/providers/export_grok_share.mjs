#!/usr/bin/env node

// Export a public Grok share (grok.com/share/<id>) or a saved raw share JSON
// file to Markdown. Reads the share API the page itself uses
// (`/rest/app-chat/share_links/<id>?useChunk=true`) and downloads user
// attachments from assets.grok.com.

import fs from "node:fs/promises";
import path from "node:path";

import {
  extensionFromBuffer,
  extensionFromContentType,
  extensionFromUrl,
} from "../lib/assets.mjs";
import { fetchText, fetchWithRetry } from "../lib/http.mjs";
import { linkTarget } from "../lib/markdown.mjs";
import { ensureDir, ensureParent, posixRelative, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { parseJsonText, sanitizeFilename } from "../lib/text.mjs";

const ASSET_ORIGIN = "https://assets.grok.com";

const USAGE = `Usage:
  node src/providers/export_grok_share.mjs <grok-share-url|raw-share-json> [output.md] [--assets|--no-assets]

Examples:
  node src/providers/export_grok_share.mjs https://grok.com/share/<share-id>
  node src/providers/export_grok_share.mjs fixtures/grok.raw.json exports/grok.md`;

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

export function extractShareId(input) {
  const fromUrl = String(input).match(/grok\.com\/share\/([A-Za-z0-9_=-]+)/i);
  if (fromUrl) return fromUrl[1];
  const bare = String(input).match(/^[A-Za-z0-9_=-]{10,}$/);
  return bare?.[0] || "";
}

async function fetchGrokShare(inputUrl) {
  const shareId = extractShareId(inputUrl);
  if (!shareId) throw new Error("Could not extract Grok share id from the URL.");
  const shareUrl = `https://grok.com/share/${shareId}`;
  const apiUrl = `https://grok.com/rest/app-chat/share_links/${shareId}?useChunk=true`;
  const { text } = await fetchText(apiUrl, {
    headers: { accept: "application/json", referer: shareUrl },
  });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Grok share API did not return JSON. First bytes:\n${text.slice(0, 500)}`);
  }
  return { data, meta: { inputUrl, shareUrl, apiUrl, shareId } };
}

function chunkText(chunks) {
  return (Array.isArray(chunks) ? chunks : [])
    .map((chunk) => chunk?.text?.text || "")
    .filter(Boolean)
    .join("\n");
}

// Replace <grok:render> card markup (searched-image cards etc.) with a
// compact placeholder; the referenced images are not part of the share payload.
function convertGrokMarkup(text) {
  return String(text).replace(
    /<grok:render\b[^>]*>[\s\S]*?<\/grok:render>/g,
    (block) => {
      const imageId = block.match(/<argument name="image_id">(\d+)<\/argument>/)?.[1];
      return imageId != null ? `_[searched image card #${imageId}]_` : "";
    },
  );
}

function thinkingSeconds(response) {
  const start = Date.parse(response?.thinkingStartTime || "");
  const end = Date.parse(response?.thinkingEndTime || "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 100) / 10;
}

export function parseGrokShare(data, meta = {}) {
  const conversation = data?.conversation || {};
  const responses = [...(data?.responses || [])].sort(
    (a, b) => Date.parse(a.createTime || 0) - Date.parse(b.createTime || 0),
  );

  const turns = responses.map((response) => {
    const isHuman = response.sender === "human";
    const rawText = isHuman
      ? chunkText(response.inputChunks) || response.message || ""
      : chunkText(response.outputChunks) || response.message || "";
    return {
      responseId: response.responseId || "",
      sender: isHuman ? "human" : "assistant",
      createTime: response.createTime || "",
      model: response.model || "",
      thinkingSeconds: thinkingSeconds(response),
      text: convertGrokMarkup(rawText),
      attachments: (response.fileAttachmentsMetadata || []).map((file) => ({
        fileId: file.fileMetadataId || "",
        fileName: file.fileName || file.fileMetadataId || "file",
        mimeType: file.fileMimeType || "",
        fileUri: file.fileUri || "",
      })),
      generatedImageUrls: response.generatedImageUrls || [],
      webSearchResults: (response.webSearchResults || []).map((result) => ({
        url: result.url || "",
        title: result.title || result.url || "",
      })),
    };
  });

  return {
    title: conversation.title || "Grok conversation",
    shareId: meta.shareId || "",
    conversationId: conversation.conversationId || "",
    createTime: conversation.createTime || "",
    modifyTime: conversation.modifyTime || "",
    models: [...new Set(turns.map((turn) => turn.model).filter(Boolean))],
    turns,
  };
}

function assetUrl(fileUri) {
  if (!fileUri) return "";
  if (/^https?:\/\//i.test(fileUri)) return fileUri;
  return `${ASSET_ORIGIN}/${fileUri.replace(/^\//, "")}`;
}

async function downloadGrokAssets(parsed, outputPath) {
  const wanted = [];
  for (const turn of parsed.turns) {
    for (const attachment of turn.attachments) {
      if (attachment.fileUri) wanted.push({ kind: "attachment", ...attachment });
    }
    for (const url of turn.generatedImageUrls) {
      wanted.push({ kind: "generated_image", fileId: url, fileName: path.basename(url), mimeType: "", fileUri: url });
    }
  }
  if (!wanted.length) return null;

  const outputBase = outputPath.replace(/\.md$/i, "");
  const markdownDir = path.dirname(outputPath);
  const assetsDir = `${outputBase}_assets`;
  const manifest = {
    output: outputPath,
    assetsDir,
    manifestPath: `${outputBase}_assets_manifest.json`,
    downloadedAt: new Date().toISOString(),
    assets: [],
  };
  const byFileId = new Map();

  await ensureDir(assetsDir);
  for (const [ordinal, item] of wanted.entries()) {
    const record = { index: ordinal + 1, kind: item.kind, fileId: item.fileId, name: item.fileName };
    try {
      const url = assetUrl(item.fileUri);
      const response = await fetchWithRetry(url, {
        redirect: "follow",
        headers: { referer: "https://grok.com/" },
      });
      if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get("content-type") || "";
      if (/text\/html/i.test(contentType)) {
        throw new Error("download returned an HTML page instead of a file");
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const baseName = sanitizeFilename(
        (item.fileName || "").replace(/\.[^.]+$/, "") || item.fileId.slice(0, 12),
        "grok-file",
      );
      const ext =
        path.extname(sanitizeFilename(item.fileName || "", "")) ||
        extensionFromContentType(contentType || item.mimeType) ||
        extensionFromBuffer(buffer) ||
        extensionFromUrl(url) ||
        ".bin";
      const filename = `${String(ordinal + 1).padStart(3, "0")}_${baseName}${ext}`;
      const filePath = path.join(assetsDir, filename);
      await fs.writeFile(filePath, buffer);
      Object.assign(record, {
        status: "downloaded",
        filename,
        relativePath: posixRelative(markdownDir, filePath),
        contentType,
        bytes: buffer.length,
        url,
      });
      byFileId.set(item.fileId, record);
    } catch (error) {
      Object.assign(record, { status: "failed", error: error.message || String(error) });
    }
    manifest.assets.push(record);
  }

  manifest.downloaded = manifest.assets.filter((item) => item.status === "downloaded").length;
  manifest.failed = manifest.assets.filter((item) => item.status === "failed").length;
  return { manifest, byFileId };
}

function renderAttachment(attachment, assets) {
  const asset = assets?.byFileId?.get(attachment.fileId);
  const label = attachment.fileName || attachment.fileId || "file";
  if (asset && /^image\//i.test(asset.contentType || attachment.mimeType)) {
    return `![${label}](${linkTarget(asset.relativePath)})`;
  }
  if (asset) {
    return `[${label}](${linkTarget(asset.relativePath)}) (${attachment.mimeType || "file"})`;
  }
  return `- ${label} (${attachment.mimeType || "file"}) | not downloaded`;
}

export function renderMarkdown(parsed, meta = {}, assets = null) {
  const source = parsed.shareId ? `https://grok.com/share/${parsed.shareId}` : meta.inputUrl || "";
  const metaLines = [
    source ? `- Source: ${source}` : "",
    `- Conversation ID: ${parsed.conversationId || ""}`,
    `- Created: ${parsed.createTime || ""}`,
    `- Modified: ${parsed.modifyTime || ""}`,
    parsed.models.length ? `- Model(s): ${parsed.models.join(", ")}` : "",
    `- Exported messages: ${parsed.turns.length}`,
    assets
      ? `- Attachments downloaded: ${assets.manifest.downloaded}/${assets.manifest.assets.length}`
      : "",
    "- Extraction: Grok share API `rest/app-chat/share_links` (useChunk=true)",
  ].filter(Boolean);

  const lines = [`# ${parsed.title}`, "", ...metaLines, "", "---", "", "## Messages", ""];

  parsed.turns.forEach((turn, index) => {
    const role = turn.sender === "human" ? "You" : "Grok";
    const comment = [
      `response ${turn.responseId}`,
      turn.createTime,
      turn.model,
      turn.thinkingSeconds != null ? `thinking ${turn.thinkingSeconds}s` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    lines.push(`### ${String(index + 1).padStart(2, "0")}. ${role}`);
    lines.push("", `<!-- ${comment} -->`);

    for (const attachment of turn.attachments) {
      lines.push("", renderAttachment(attachment, assets));
    }
    if (turn.text.trim()) lines.push("", turn.text.trim());
    if (!turn.text.trim() && !turn.attachments.length) lines.push("", "_(empty)_");

    if (turn.webSearchResults.length) {
      lines.push(
        "",
        "<details><summary>Web search results consulted (" +
          turn.webSearchResults.length +
          ")</summary>",
        "",
      );
      for (const result of turn.webSearchResults) {
        lines.push(`- [${result.title.replace(/[[\]]/g, "")}](${result.url})`);
      }
      lines.push("", "</details>");
    }
    lines.push("");
  });

  return `${lines.join("\n").trim()}\n`;
}

function defaultOutputPath(input, parsed) {
  const id =
    parsed.shareId ||
    extractShareId(input) ||
    path.basename(String(input)).replace(/\.[^.]+$/, "") ||
    "grok_share";
  return path.join("exports", "grok", `grok_share_${id}.md`);
}

export async function exportGrokShare({ input, output = "", downloadAssets = true } = {}) {
  if (!input) throw new Error("grok requires a share URL or raw share JSON file.");

  let data;
  let meta = {};
  if (looksLikeUrl(input)) {
    ({ data, meta } = await fetchGrokShare(input));
  } else {
    data = parseJsonText(await fs.readFile(input, "utf8"));
    meta = { inputUrl: input, shareId: extractShareId(path.basename(input)) };
  }

  const parsed = parseGrokShare(data, meta);
  const outputPath = output || defaultOutputPath(input, parsed);
  const assets = downloadAssets ? await downloadGrokAssets(parsed, outputPath) : null;
  const markdown = renderMarkdown(parsed, meta, assets);

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);
  if (assets) {
    await writeFileAtomic(
      assets.manifest.manifestPath,
      `${JSON.stringify(assets.manifest, null, 2)}\n`,
    );
  }

  return {
    output: outputPath,
    title: parsed.title,
    messages: parsed.turns.length,
    models: parsed.models,
    assetsDownloaded: assets?.manifest.downloaded || 0,
    assetsFailed: assets?.manifest.failed || 0,
    assetsManifest: assets?.manifest.manifestPath || null,
    source: parsed.shareId ? `https://grok.com/share/${parsed.shareId}` : null,
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
    const summary = await exportGrokShare(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
