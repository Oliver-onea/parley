#!/usr/bin/env node

// Export a public Gemini share (share.gemini.google/<id>) or a saved raw
// batchexecute response to Markdown, downloading public image assets.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  extensionFromBuffer,
  extensionFromContentType,
  extensionFromUrl,
  filenameFromContentDisposition,
} from "../lib/assets.mjs";
import { fetchText, fetchWithRetry } from "../lib/http.mjs";
import { linkTarget } from "../lib/markdown.mjs";
import { ensureDir, ensureParent, posixRelative, writeFileAtomic } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { decodeHtml, sanitizeFilename } from "../lib/text.mjs";
import { isoFromUnixSeconds } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_gemini_share.mjs <gemini-share-url|raw-batchexecute-file> [output.md] [--assets|--no-assets]

Examples:
  node src/providers/export_gemini_share.mjs https://share.gemini.google/<share-id>
  node src/providers/export_gemini_share.mjs fixtures/gemini.raw.txt exports/gemini.md
  node src/providers/export_gemini_share.mjs https://share.gemini.google/<share-id> exports/gemini.md --no-assets

Environment:
  GOOGLE_COOKIE   Logged-in Google Cookie header; enables downloading private
                  Google Docs/Drive attachments referenced by the share.`;

function parseArgs(argv) {
  const args = { input: "", output: "", downloadAssets: true, help: false };
  for (const arg of argv) {
    if (arg === "--assets") args.downloadAssets = true;
    else if (arg === "--no-assets") args.downloadAssets = false;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (!args.input) args.input = arg;
    else if (!args.output) args.output = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(value);
}

function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}





function isGeminiAssetUrl(value) {
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return parsed.hostname === "lh3.googleusercontent.com" || parsed.hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return "";
}

function extractShareId(...values) {
  for (const value of values) {
    if (!value) continue;
    const match = String(value).match(/\/share\/([A-Za-z0-9_-]+)/);
    if (match) return match[1];
  }
  return "";
}

function extractGeminiPageMeta(html, finalUrl) {
  const canonical = firstMatch(html, [
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i,
    /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i,
  ]);
  const shareId = extractShareId(finalUrl, canonical, html);
  const bl = firstMatch(html, [
    /boq_assistant-bard-web-server_[^"'<>\\&\s]+/,
    /"cfb2h"\s*:\s*"([^"]+)"/,
  ]);
  const sid = firstMatch(html, [/"FdrFJe"\s*:\s*"([^"]+)"/, /\["FdrFJe"\s*,\s*"([^"]+)"\]/]);

  if (!shareId) throw new Error("Could not extract Gemini share id from the page.");
  if (!bl) throw new Error("Could not extract Gemini build label (bl) from the page.");
  if (!sid) throw new Error("Could not extract Gemini f.sid from the page.");

  return {
    canonical: canonical || `https://gemini.google.com/share/${shareId}`,
    shareId,
    bl,
    sid,
  };
}

async function fetchGeminiRaw(inputUrl) {
  const page = await fetchText(inputUrl, {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });
  const meta = extractGeminiPageMeta(page.text, page.url);
  const hl = process.env.GEMINI_HL || "zh-TW";
  const reqid = String(100000 + Math.floor(Math.random() * 900000));
  const rpcUrl = new URL("https://gemini.google.com/_/BardChatUi/data/batchexecute");
  rpcUrl.searchParams.set("rpcids", "ujx1Bf");
  rpcUrl.searchParams.set("source-path", `/share/${meta.shareId}`);
  rpcUrl.searchParams.set("bl", meta.bl);
  rpcUrl.searchParams.set("f.sid", meta.sid);
  rpcUrl.searchParams.set("hl", hl);
  rpcUrl.searchParams.set("_reqid", reqid);
  rpcUrl.searchParams.set("rt", "c");

  const fReq = JSON.stringify([[["ujx1Bf", JSON.stringify([null, meta.shareId]), null, "generic"]]]);
  const rpc = await fetchText(rpcUrl.toString(), {
    method: "POST",
    body: new URLSearchParams({ "f.req": fReq }),
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      origin: "https://gemini.google.com",
      referer: meta.canonical,
      "x-same-domain": "1",
    },
  });

  return { raw: rpc.text, meta: { ...meta, inputUrl, finalUrl: page.url, hl } };
}

export function parseBatchExecute(raw) {
  const line = raw.split(/\r?\n/).find((item) => item.startsWith("[["));
  if (!line) throw new Error("Could not find batchexecute JSON payload line.");
  const outer = JSON.parse(line);
  const row =
    outer.find((item) => Array.isArray(item) && item[0] === "wrb.fr" && item[1] === "ujx1Bf") ??
    outer.find((item) => Array.isArray(item) && typeof item[2] === "string");
  if (!row?.[2]) throw new Error("Could not find ujx1Bf payload inside batchexecute response.");
  return JSON.parse(row[2]);
}

function flattenStrings(value) {
  const found = [];
  const walk = (node) => {
    if (typeof node === "string") found.push(node);
    else if (Array.isArray(node)) for (const item of node) walk(item);
    else if (node && typeof node === "object") for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return found;
}

function getPath(value, pathParts, fallback = undefined) {
  let current = value;
  for (const part of pathParts) {
    if (current == null) return fallback;
    current = current[part];
  }
  return current ?? fallback;
}

function imageMapFromCandidate(candidate) {
  const mapping = {};
  if (!Array.isArray(candidate) || candidate.length <= 12) return mapping;
  const entries = getPath(candidate, [12, 1]);
  if (!Array.isArray(entries)) return mapping;

  for (const entry of entries) {
    const strings = flattenStrings(entry);
    const tags = strings.filter((item) => item.includes("image_agent_tag_"));
    if (!tags.length) continue;
    const urls = strings.filter(
      (item) =>
        item.startsWith("http") &&
        !item.includes("image_agent_tag_") &&
        !item.startsWith("https://www.gettyimages.com/"),
    );
    const sourceUrls = strings.filter((item) => item.startsWith("https://www.gettyimages.com/"));
    const alt =
      strings.find((item) => item.length > 10 && !item.startsWith("http") && !item.includes("getty:")) || "";
    for (const tag of tags) {
      mapping[tag.split("/").at(-1)] = {
        url: urls[0] || sourceUrls[0] || "",
        alt,
        source: sourceUrls[0] || "",
      };
    }
  }
  return mapping;
}

function escapeMdImageLabel(value) {
  return value.replace(/\]/g, "\\]").replace(/\n+/g, " ").trim();
}

function replaceImageTags(text, imageMap) {
  return text.replace(
    /<Image\s+alt="(?<alt>[^"]*)"\s+caption="(?<caption>[^"]*)"\s+src="(?<src>[^"]*)"\s*\/>/g,
    (...matchArgs) => {
      const groups = matchArgs.at(-1);
      const alt = decodeHtml(groups.alt || "");
      const caption = decodeHtml(groups.caption || "");
      const src = groups.src || "";
      const info = imageMap[src] || {};
      const url = info.url || src;
      const label = escapeMdImageLabel(caption || alt || info.alt || "image");
      let out = `![${label}](${url})`;
      if (caption && alt && caption !== alt) out += `\n\n> ${alt}`;
      if (info.source) out += `\n\n[Image source](${info.source})`;
      return out;
    },
  );
}

function convertCustomTags(text) {
  return text
    .replace(/<FollowUp\s+label="([^"]*)"\s+query="([^"]*)"\s*\/>/g, (_m, label, query) => {
      return `> Follow-up: ${decodeHtml(label)}\n>\n> Query: ${decodeHtml(query)}`;
    })
    .replace(/<ElicitationsGroup\s+message="([^"]*)">/g, (_m, message) => {
      return `> Suggested follow-ups: ${decodeHtml(message)}`;
    })
    .replace(/\s*<Elicitation\s+label="([^"]*)"\s+query="([^"]*)"\s*\/>/g, (_m, label, query) => {
      return `\n> - ${decodeHtml(label)}: ${decodeHtml(query)}`;
    })
    .replace(/\s*<\/ElicitationsGroup>/g, "")
    .replace(/\s*<Sequence>\s*/g, "\n")
    .replace(/\s*<\/Sequence>\s*/g, "\n")
    .replace(
      /\s*<Step\s+subtitle="([^"]*)"\s+title="([^"]*)">\s*/g,
      (_m, subtitle, title) => `\n#### ${decodeHtml(title)}\n\n_${decodeHtml(subtitle)}_\n\n`,
    )
    .replace(/\s*<\/Step>\s*/g, "\n");
}

function extractUrls(value) {
  return uniq(flattenStrings(value).filter((item) => /^https?:\/\//i.test(item)));
}

function buildGeneratedImagePlaceholderMap(value) {
  const mapping = new Map();
  const pending = [];
  for (const item of flattenStrings(value)) {
    if (/^https?:\/\/googleusercontent\.com\/image_generation_content\/\d+$/.test(item)) {
      pending.push(item);
      continue;
    }
    if (pending.length && item.startsWith("https://lh3.googleusercontent.com/gg/")) {
      mapping.set(pending.shift(), item);
    }
  }
  return mapping;
}

function replaceGeneratedImagePlaceholders(text, placeholderMap) {
  if (!placeholderMap?.size) return text;
  return text.replace(/https?:\/\/googleusercontent\.com\/image_generation_content\/\d+/g, (url) => {
    const mapped = placeholderMap.get(url);
    return mapped
      ? `\n\n![Generated image](${mapped})\n\n[Original Gemini image handle](${url})`
      : url;
  });
}

function formatTimePair(pair) {
  if (!Array.isArray(pair)) return "";
  return isoFromUnixSeconds(pair[0]);
}

export function parseGeminiPayload(inner, fetchMeta = {}) {
  const root = inner?.[0];
  if (!Array.isArray(root)) {
    throw new Error("Unexpected Gemini payload shape: root is not an array.");
  }
  const generatedImageMap = buildGeneratedImagePlaceholderMap(inner);
  const messages = Array.isArray(root[1]) ? root[1] : [];
  const title = getPath(root, [2, 1], "Gemini share") || "Gemini share";
  const shareId = root[3] || fetchMeta.shareId || "";
  const published = formatTimePair(root[4]);
  const model = getPath(root, [2, 7, 2], "") || "";

  const turns = messages.map((msg, index) => {
    const promptNode = Array.isArray(msg) && msg.length > 2 ? msg[2] : null;
    const responseNode = Array.isArray(msg) && msg.length > 3 ? msg[3] : null;
    const candidate = getPath(responseNode, [0, 0], null);
    const imageMap = imageMapFromCandidate(candidate);
    const answer = convertCustomTags(
      replaceGeneratedImagePlaceholders(
        replaceImageTags(getPath(responseNode, [0, 0, 1, 0], "") || "", imageMap),
        generatedImageMap,
      ),
    );
    return {
      index: index + 1,
      messageId: Array.isArray(msg) ? msg[0] : null,
      parent: Array.isArray(msg) ? msg[1] : null,
      createdAt: formatTimePair(Array.isArray(msg) && msg.length > 4 ? msg[4] : null),
      prompt: getPath(promptNode, [0, 0], "") || "",
      answer,
      attachments: extractUrls(promptNode),
    };
  });

  return { title, shareId, published, model, turns };
}

function defaultOutputPath(input, parsed) {
  const shareId =
    parsed.shareId ||
    extractShareId(input) ||
    path.basename(String(input)).replace(/\.[^.]+$/, "") ||
    "gemini_share";
  return path.join("exports", "gemini", `gemini_share_${shareId}.md`);
}

export function renderMarkdown(parsed, meta = {}) {
  const source = parsed.shareId ? `https://gemini.google.com/share/${parsed.shareId}` : meta.canonical || "";
  const metaLines = [
    source ? `- Source: ${source}` : "",
    meta.inputUrl && meta.inputUrl !== source ? `- Original link: ${meta.inputUrl}` : "",
    meta.finalUrl && meta.finalUrl !== meta.inputUrl ? `- Resolved URL: ${meta.finalUrl}` : "",
    `- Model: ${parsed.model || "Unknown"}`,
    `- Published: ${parsed.published || "Unknown"}`,
    `- Exported turns: ${parsed.turns.length}`,
    "- Extraction: Gemini batchexecute RPC `ujx1Bf`",
  ].filter(Boolean);

  const lines = [`# ${parsed.title}`, "", ...metaLines, "", "---", ""];

  for (const turn of parsed.turns) {
    lines.push(`## Turn ${turn.index}`);
    if (turn.createdAt) lines.push("", `_Time: ${turn.createdAt}_`);
    lines.push("", "### You", "", turn.prompt.trim() || "_(empty)_");
    if (turn.attachments.length) {
      lines.push("", "Attachments:");
      turn.attachments.forEach((url, index) => {
        if (isGeminiAssetUrl(url)) lines.push(`- ![Attachment ${index + 1}](${url})`);
        else lines.push(`- ${url}`);
      });
    }
    lines.push("", "### Gemini", "", turn.answer.trim() || "_(empty)_", "", "---", "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function collectMarkdownImageUrls(markdown) {
  return Array.from(markdown.matchAll(/!\[[^\]]*]\((https?:\/\/[^)\s]+)\)/g), (match) => match[1]);
}

function collectAssetUrls(markdown, parsed) {
  const urls = collectMarkdownImageUrls(markdown);
  for (const turn of parsed.turns) {
    urls.push(...(turn.attachments || []));
  }
  return uniq(urls.filter(isGeminiAssetUrl));
}

async function downloadAsset(url, index, assetsDir, markdownDir) {
  const response = await fetchWithRetry(url, {
    redirect: "follow",
    headers: {
      accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,application/pdf,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType)) {
    throw new Error("download returned an HTML page instead of a file");
  }
  const disposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());

  const fallbackName = `asset_${String(index + 1).padStart(3, "0")}_${sha256(url).slice(0, 12)}`;
  const dispositionName = sanitizeFilename(filenameFromContentDisposition(disposition), "");
  const ext =
    path.extname(dispositionName) ||
    extensionFromContentType(contentType) ||
    extensionFromBuffer(buffer) ||
    extensionFromUrl(url) ||
    ".bin";
  const dispositionBaseName = dispositionName ? dispositionName.replace(/\.[^.]+$/, "") : "";
  const baseName = dispositionBaseName ? `${dispositionBaseName}_${sha256(url).slice(0, 12)}` : fallbackName;
  const filename = `${baseName}${ext}`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, buffer);

  return {
    index: index + 1,
    url,
    finalUrl: response.url,
    status: "downloaded",
    filename,
    path: filePath,
    relativePath: posixRelative(markdownDir, filePath),
    contentType,
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

// Google Docs / Drive attachment links found in prompts. These need either a
// public ("anyone with the link") document or a GOOGLE_COOKIE for access.
export function googleAttachmentInfo(url) {
  const doc = String(url).match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([\w-]+)/);
  if (doc) {
    const format = { document: "docx", spreadsheets: "xlsx", presentation: "pptx" }[doc[1]];
    return {
      id: doc[2],
      exportUrl: `https://docs.google.com/${doc[1]}/d/${doc[2]}/export?format=${format}`,
    };
  }
  const file = String(url).match(/drive\.google\.com\/file\/d\/([\w-]+)/);
  if (file) {
    return { id: file[1], exportUrl: `https://drive.google.com/uc?export=download&id=${file[1]}` };
  }
  return null;
}

function collectGoogleAttachmentUrls(parsed) {
  const urls = [];
  for (const turn of parsed.turns) {
    for (const url of turn.attachments || []) {
      if (googleAttachmentInfo(url)) urls.push(url);
    }
  }
  return uniq(urls);
}

async function downloadGoogleAttachment(url, index, assetsDir, markdownDir) {
  const info = googleAttachmentInfo(url);
  const headers = {
    accept: "*/*",
    ...(process.env.GOOGLE_COOKIE ? { cookie: process.env.GOOGLE_COOKIE } : {}),
  };
  const response = await fetchWithRetry(info.exportUrl, { redirect: "follow", headers });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Google returned ${response.status}: document is not public. ` +
        "Set GOOGLE_COOKIE to a logged-in Google cookie header to download it.",
    );
  }
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (/text\/html/i.test(contentType)) {
    throw new Error("Google returned an HTML page (login or virus-scan interstitial) instead of the file");
  }
  const disposition = response.headers.get("content-disposition") || "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const dispositionName = sanitizeFilename(filenameFromContentDisposition(disposition), "");
  const ext =
    path.extname(dispositionName) || extensionFromContentType(contentType) || extensionFromBuffer(buffer) || ".bin";
  const baseName = dispositionName ? dispositionName.replace(/\.[^.]+$/, "") : `gdoc_${info.id.slice(0, 12)}`;
  const filename = `${String(index + 1).padStart(3, "0")}_${baseName}${ext}`;
  const filePath = path.join(assetsDir, filename);
  await fs.writeFile(filePath, buffer);

  return {
    index: index + 1,
    kind: "google_attachment",
    url,
    exportUrl: info.exportUrl,
    status: "downloaded",
    filename,
    path: filePath,
    relativePath: posixRelative(markdownDir, filePath),
    contentType,
    bytes: buffer.length,
    sha256: sha256(buffer),
  };
}

async function localizeMarkdownAssets(markdown, parsed, outputPath) {
  const urls = collectAssetUrls(markdown, parsed);
  const googleUrls = collectGoogleAttachmentUrls(parsed);
  if (!urls.length && !googleUrls.length) return { markdown, manifest: null };

  const outputBase = outputPath.replace(/\.md$/i, "");
  const markdownDir = path.dirname(outputPath);
  const assetsDir = `${outputBase}_assets`;
  const manifestPath = `${outputBase}_assets_manifest.json`;
  const manifest = {
    output: outputPath,
    assetsDir,
    manifestPath,
    downloadedAt: new Date().toISOString(),
    assets: [],
  };

  await ensureDir(assetsDir);
  for (const [index, url] of urls.entries()) {
    try {
      const asset = await downloadAsset(url, index, assetsDir, markdownDir);
      manifest.assets.push(asset);
      markdown = markdown.split(url).join(linkTarget(asset.relativePath));
    } catch (error) {
      manifest.assets.push({
        index: index + 1,
        url,
        status: "failed",
        error: error.message || String(error),
      });
    }
  }

  for (const [index, url] of googleUrls.entries()) {
    const ordinal = urls.length + index;
    try {
      const asset = await downloadGoogleAttachment(url, ordinal, assetsDir, markdownDir);
      manifest.assets.push(asset);
      markdown = markdown
        .split(`- ${url}`)
        .join(`- [${asset.filename}](${linkTarget(asset.relativePath)}) ([source](${url}))`);
    } catch (error) {
      manifest.assets.push({
        index: ordinal + 1,
        kind: "google_attachment",
        url,
        status: "failed",
        error: error.message || String(error),
      });
    }
  }

  manifest.downloaded = manifest.assets.filter((item) => item.status === "downloaded").length;
  manifest.failed = manifest.assets.filter((item) => item.status === "failed").length;
  return { markdown, manifest };
}

export async function exportGeminiShare({ input, output = "", downloadAssets = true } = {}) {
  if (!input) throw new Error("gemini requires a share URL or raw batchexecute file.");

  let raw;
  let meta = {};
  if (looksLikeUrl(input)) {
    ({ raw, meta } = await fetchGeminiRaw(input));
  } else {
    raw = await fs.readFile(input, "utf8");
  }

  const inner = parseBatchExecute(raw);
  const parsed = parseGeminiPayload(inner, meta);
  const outputPath = output || defaultOutputPath(input, parsed);
  let markdown = renderMarkdown(parsed, meta);
  const bundle = downloadAssets ? await localizeMarkdownAssets(markdown, parsed, outputPath) : null;
  if (bundle) markdown = bundle.markdown;

  await ensureParent(outputPath);
  await writeFileAtomic(outputPath, markdown);
  if (bundle?.manifest) {
    await writeFileAtomic(bundle.manifest.manifestPath, `${JSON.stringify(bundle.manifest, null, 2)}\n`);
  }

  return {
    output: outputPath,
    assetsDir: bundle?.manifest?.assetsDir || null,
    assetsManifest: bundle?.manifest?.manifestPath || null,
    assetsDownloaded: bundle?.manifest?.downloaded || 0,
    assetsFailed: bundle?.manifest?.failed || 0,
    turns: parsed.turns.length,
    title: parsed.title,
    shareId: parsed.shareId,
    source: parsed.shareId ? `https://gemini.google.com/share/${parsed.shareId}` : null,
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.input) {
      console.error(USAGE);
      process.exitCode = args.help ? 0 : 1;
      return;
    }
    const summary = await exportGeminiShare(args);
    console.log(JSON.stringify(summary, null, 2));
  });
}
