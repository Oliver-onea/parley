#!/usr/bin/env node

// Export a raw Claude chat JSON file to Markdown with an asset manifest.
// Asset metadata is always exported; downloading binaries needs an
// authenticated Claude session (CLAUDE_COOKIE / CLAUDE_AUTHORIZATION).

import fs from "node:fs/promises";
import path from "node:path";

import { messagesOf, renderMessage, titleOf } from "../lib/claude.mjs";
import { scalar } from "../lib/markdown.mjs";
import { ensureDir, portablePath, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { parseJsonText, sanitizeFilename } from "../lib/text.mjs";

const CLAUDE_ORIGIN = "https://claude.ai";

const USAGE = `Usage:
  node export_claude_chat_assets.mjs <raw-chat-json> [output.md] [options]

Options:
  --source-url <url>       Original Claude chat/share URL to put in the Markdown
  --download-assets        Try downloading image previews into a local assets folder
  --assets-dir <dir>       Assets folder. Defaults to <output-basename>_assets

Environment for --download-assets:
  CLAUDE_COOKIE            Raw Cookie header from an authenticated Claude session
  CLAUDE_AUTHORIZATION     Optional Authorization header value, if required`;

function parseArgs(argv) {
  const args = { positional: [], downloadAssets: false, sourceUrl: "", assetsDir: "", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--download-assets") args.downloadAssets = true;
    else if (arg === "--source-url") args.sourceUrl = argv[++i] || "";
    else if (arg === "--assets-dir") args.assetsDir = argv[++i] || "";
    else if (arg === "-h" || arg === "--help") args.help = true;
    else args.positional.push(arg);
  }
  return args;
}

function absoluteClaudeUrl(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return `${CLAUDE_ORIGIN}${url}`;
  return url;
}

function dimensions(asset) {
  const width = asset?.preview_asset?.image_width || asset?.thumbnail_asset?.image_width || asset?.image_width;
  const height = asset?.preview_asset?.image_height || asset?.thumbnail_asset?.image_height || asset?.image_height;
  return width && height ? { width, height } : null;
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

function targetFilename(asset, ordinal) {
  const original = sanitizeFilename(
    asset.file_name || asset.name || asset.filename || asset.file_uuid || asset.uuid,
    "claude-file",
  );
  return `${String(ordinal).padStart(4, "0")}-${original}`;
}

function collectAssets(messages, assetsDir) {
  const assets = [];
  for (const message of messages) {
    const candidates = [...(message.files || []), ...(message.attachments || [])];
    for (const item of candidates) {
      if (!isAssetItem(item)) continue;
      const fileUuid = item.file_uuid || item.uuid || "";
      const ordinal = assets.length + 1;
      assets.push({
        ordinal,
        message_index: message.index ?? null,
        message_uuid: message.uuid || "",
        sender: message.sender || "",
        created_at: message.created_at || "",
        file_name: item.file_name || item.name || item.filename || fileUuid || "file",
        file_uuid: fileUuid,
        file_kind: item.file_kind || item.kind || item.type || item.mime_type || "file",
        dimensions: dimensions(item),
        preview_url: absoluteClaudeUrl(
          item.preview_url || item.preview_asset?.url || item.url || item.download_url,
        ),
        thumbnail_url: absoluteClaudeUrl(item.thumbnail_url || item.thumbnail_asset?.url),
        local_path: path.join(assetsDir, targetFilename(item, ordinal)),
        downloaded: false,
        status: "pending",
      });
    }
  }
  return assets;
}

function renderNonAssetAttachments(message) {
  const candidates = [...(message.files || []), ...(message.attachments || [])].filter(
    (item) => !isAssetItem(item),
  );
  if (!candidates.length) return "";
  const lines = ["**Attachments:**"];
  for (const item of candidates) {
    if (!item || typeof item !== "object") {
      lines.push(`- ${scalar(item)}`);
      continue;
    }
    const name = item.file_name || item.name || item.filename || item.id || "attachment";
    const bits = [String(name || "attachment")];
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
    const dim = asset.dimensions ? `, ${asset.dimensions.width}x${asset.dimensions.height}` : "";
    if (asset.downloaded) {
      lines.push(`![${asset.file_name}](${asset.local_path})`);
    } else {
      lines.push(`- ${asset.file_name} (${asset.file_kind}${dim})`);
      if (asset.preview_url) lines.push(`  - Preview: ${asset.preview_url}`);
      if (asset.thumbnail_url) lines.push(`  - Thumbnail: ${asset.thumbnail_url}`);
      lines.push(`  - Local target: \`${asset.local_path}\``);
      lines.push("  - Note: Claude requires an authenticated session to download this asset.");
    }
  }
  return lines.join("\n");
}

function renderMarkdown(data, messages, assets, meta) {
  const lines = [
    `# ${titleOf(data)}`,
    "",
    meta.sourceUrl ? `- Source: ${meta.sourceUrl}` : "",
    `- Conversation UUID: ${data.uuid || ""}`,
    `- Model: ${data.model || ""}`,
    `- Created at: ${data.created_at || ""}`,
    `- Updated at: ${data.updated_at || ""}`,
    data.current_leaf_message_uuid ? `- Current leaf message UUID: ${data.current_leaf_message_uuid}` : "",
    `- Exported messages: ${messages.length}`,
    `- Exported assets: ${assets.length}`,
    "- Asset mode: metadata is always exported; binary download requires Claude login authorization",
    "",
    "## Messages",
    "",
  ].filter((line) => line !== "");

  messages.forEach((message, index) => {
    const extras = [
      renderAssetList(assets.filter((asset) => asset.message_uuid && asset.message_uuid === message.uuid)),
      renderNonAssetAttachments(message),
    ];
    lines.push(renderMessage(message, index + 1, extras), "");
  });
  return `${lines.join("\n").trim()}\n`;
}

function downloadHeaders() {
  const headers = {};
  if (process.env.CLAUDE_COOKIE) headers.cookie = process.env.CLAUDE_COOKIE;
  if (process.env.CLAUDE_AUTHORIZATION) headers.authorization = process.env.CLAUDE_AUTHORIZATION;
  return headers;
}

async function downloadAssets(assets, outputDir) {
  const headers = downloadHeaders();
  for (const asset of assets) {
    if (!asset.preview_url) {
      asset.status = "missing_preview_url";
      continue;
    }
    const target = path.resolve(outputDir, asset.local_path);
    try {
      const response = await fetch(asset.preview_url, { headers, redirect: "follow" });
      asset.http_status = response.status;
      asset.content_type = response.headers.get("content-type") || "";
      if (!response.ok) {
        asset.status = `http_${response.status}`;
        continue;
      }
      if (/text\/html/i.test(asset.content_type)) {
        asset.status = "html_response_not_saved";
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      await ensureDir(path.dirname(target));
      await fs.writeFile(target, bytes);
      asset.bytes = bytes.length;
      asset.downloaded = true;
      asset.status = "downloaded";
    } catch (error) {
      asset.status = "error";
      asset.error = error?.message || String(error);
    }
  }
}

export async function exportClaudeAssets({
  input,
  output = "",
  outDir = "exports",
  assetsDir = "",
  sourceUrl = "",
  downloadAssets: shouldDownload = false,
} = {}) {
  if (!input) throw new Error("claude-assets requires a raw Claude chat JSON file.");

  const inputPath = path.resolve(input);
  const data = parseJsonText(await fs.readFile(inputPath, "utf8"));
  const messages = messagesOf(data);
  const outputPath = path.resolve(
    output ||
      path.join(
        outDir,
        "claude",
        "web",
        `claude_chat_${data.uuid || path.basename(inputPath, path.extname(inputPath))}_with_assets.md`,
      ),
  );
  const outputDir = path.dirname(outputPath);
  const defaultAssetsDir = `${path.basename(outputPath, path.extname(outputPath))}_assets`;
  const assetsRoot = path.resolve(outputDir, assetsDir || defaultAssetsDir);
  const assets = collectAssets(messages, portablePath(assetsRoot, outputDir));

  if (shouldDownload) {
    await downloadAssets(assets, outputDir);
  } else {
    for (const asset of assets) asset.status = "metadata_only";
  }

  await ensureDir(outputDir);
  await writeFileAtomic(outputPath, renderMarkdown(data, messages, assets, { sourceUrl }));

  const manifestPath = `${outputPath.replace(/\.md$/i, "")}_assets_manifest.json`;
  const manifest = {
    source: portablePath(inputPath),
    output: portablePath(outputPath),
    assets,
  };
  await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    output: portablePath(outputPath),
    manifest: portablePath(manifestPath),
    messages: messages.length,
    assets: assets.length,
    downloaded: assets.filter((asset) => asset.downloaded).length,
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.positional[0]) {
      console.log(USAGE);
      return;
    }
    const summary = await exportClaudeAssets({
      input: args.positional[0],
      output: args.positional[1] || "",
      assetsDir: args.assetsDir,
      sourceUrl: args.sourceUrl,
      downloadAssets: args.downloadAssets,
    });
    console.log(JSON.stringify(summary, null, 2));
  });
}
