#!/usr/bin/env node

// Export a Claude Desktop local-agent session (audit/transcript JSONL) to
// Markdown with extracted image assets and a manifest.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { escapeHtml, fenced } from "../lib/markdown.mjs";
import { portablePath } from "../lib/paths.mjs";
import { isMainModule, runMain } from "../lib/proc.mjs";
import { slugify, stripBom } from "../lib/text.mjs";
import { isoFromEpoch } from "../lib/time.mjs";

const USAGE = `Usage:
  node src/providers/export_claude_local.mjs --title "Conversation title" [--out dir] [--root dir]
  node src/providers/export_claude_local.mjs --session <local-session-id> [--out dir] [--root dir]`;

function writeFileAtomicSync(filePath, data) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, data, "utf8");
  fs.renameSync(tempPath, filePath);
}

function defaultSearchRoots() {
  const home = os.homedir();
  return ["Claude-3p", "Claude"].map((profile) =>
    path.join(home, "Library", "Application Support", profile, "local-agent-mode-sessions"),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      (parsed._ ||= []).push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      i += 1;
    }
  }
  return parsed;
}

function* walk(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function readJson(file) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  return stripBom(fs.readFileSync(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return { type: "parse_error", line: index + 1, error: error.message };
      }
    });
}

function countEvents(records) {
  const counts = {};
  for (const rec of records) {
    const key = rec.type || rec.message?.role || rec.role || "unknown";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function findLocalAgentConversations(root) {
  const found = [];
  for (const file of walk(root)) {
    if (!path.basename(file).startsWith("local_") || !file.endsWith(".json")) continue;
    const meta = readJson(file);
    if (!meta?.sessionId) continue;
    const sessionDir = path.join(path.dirname(file), meta.sessionId);
    const auditPath = path.join(sessionDir, "audit.jsonl");
    if (!fs.existsSync(auditPath)) continue;
    found.push({
      metaPath: file,
      sessionDir,
      auditPath,
      meta,
      projectTranscripts: findProjectTranscripts(sessionDir),
    });
  }
  return found;
}

function findProjectTranscripts(sessionDir) {
  const projectRoot = path.join(sessionDir, ".claude", "projects");
  if (!fs.existsSync(projectRoot)) return [];
  return [...walk(projectRoot)]
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => ({
      path: file,
      bytes: fs.statSync(file).size,
      counts: countEvents(readJsonl(file)),
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

// Prefer the Claude Code project transcript when it has real user/assistant
// events; otherwise fall back to the local-agent audit log.
function chooseTranscriptSource(selected) {
  const project = selected.projectTranscripts.find(
    (entry) => (entry.counts.user || 0) + (entry.counts.assistant || 0) > 0,
  );
  if (project) return { kind: "claude-code-project-jsonl", path: project.path };
  return { kind: "local-agent-audit-jsonl", path: selected.auditPath };
}

function selectConversation({ root, title, session }) {
  const searchRoots = root ? [path.resolve(root)] : defaultSearchRoots();
  let matches = searchRoots.flatMap((item) => findLocalAgentConversations(item));

  if (session) {
    matches = matches.filter((entry) => entry.meta.sessionId === session);
  }
  if (title) {
    const needle = title.toLowerCase();
    matches = matches.filter((entry) => String(entry.meta.title || "").toLowerCase().includes(needle));
    matches.sort((a, b) => {
      const aExact = String(a.meta.title || "").toLowerCase() === needle ? 0 : 1;
      const bExact = String(b.meta.title || "").toLowerCase() === needle ? 0 : 1;
      return aExact - bExact || Number(b.meta.lastActivityAt || 0) - Number(a.meta.lastActivityAt || 0);
    });
  }

  if (!matches.length) {
    throw new Error(
      `No local Claude conversation matched ${title || session}. Roots: ${searchRoots.join(", ")}`,
    );
  }
  return matches[0];
}

function isOnlyToolResult(content) {
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "tool_result");
}

function extractMessageRecords(records, kind, ctx) {
  const seen = new Set();
  const items = [];
  for (const rec of records) {
    if (kind === "claude-code-project-jsonl" && rec.type === "attachment") {
      items.push({ type: "attachment", record: rec });
      continue;
    }
    if (rec.type !== "user" && rec.type !== "assistant") continue;

    const id = rec.uuid || `${rec.type}:${items.length}`;
    if (seen.has(id)) {
      ctx.skippedDuplicateMessages += 1;
      continue;
    }
    seen.add(id);

    const content = rec.message?.content;
    if (isOnlyToolResult(content)) {
      ctx.toolResultCount += 1;
      items.push({ type: "tool_result", role: "tool", content });
      continue;
    }
    items.push({ type: "message", role: rec.type === "assistant" ? "assistant" : "user", content });
  }
  return items;
}

function extensionFor(mediaType) {
  const lower = mediaType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  return "bin";
}

function renderImage(block, ctx) {
  const source = block.source || {};
  if (source.type !== "base64" || !source.data) return fenced(JSON.stringify(block, null, 2), "json");
  const mediaType = source.media_type || "image/png";
  const hash = crypto.createHash("sha256").update(source.data).digest("hex");
  let asset = ctx.assetByHash.get(hash);
  if (!asset) {
    ctx.assetIndex += 1;
    const filename = `${String(ctx.assetIndex).padStart(4, "0")}-${hash.slice(0, 12)}.${extensionFor(mediaType)}`;
    const bytes = Buffer.from(source.data, "base64");
    fs.writeFileSync(path.join(ctx.assetsDir, filename), bytes);
    asset = {
      index: ctx.assetIndex,
      mediaType,
      sha256: hash,
      filename,
      path: portablePath(path.join(ctx.finalAssetsDir, filename)),
      bytes: bytes.length,
    };
    ctx.assetByHash.set(hash, asset);
    ctx.assetRefs.push(asset);
  }
  return `![image ${asset.index}](${ctx.assetsDirName}/${asset.filename})`;
}

function details(summary, body) {
  return [`<details><summary>${summary}</summary>`, "", body, "", "</details>"].join("\n");
}

function renderToolUse(block) {
  const name = block.name || "tool";
  const id = block.id ? ` ${block.id}` : "";
  const input = block.input == null ? "" : fenced(JSON.stringify(block.input, null, 2), "json");
  return details(`Tool use: ${escapeHtml(name)}${escapeHtml(id)}`, input);
}

function renderToolResult(block) {
  const id = block.tool_use_id ? ` ${block.tool_use_id}` : "";
  const content =
    typeof block.content === "string"
      ? fenced(block.content, "text")
      : fenced(JSON.stringify(block.content, null, 2), "json");
  return details(`Tool result${escapeHtml(id)}`, content);
}

function renderAttachment(rec, ctx) {
  ctx.attachmentCount += 1;
  const attachment = rec.attachment || {};
  const label = attachment.type || "attachment";
  return details(`Attachment: ${escapeHtml(label)}`, fenced(JSON.stringify(attachment, null, 2), "json"));
}

function renderBlock(block, ctx) {
  if (!block || typeof block !== "object") return String(block ?? "");
  if (block.type === "text") return block.text || "";
  if (block.type === "thinking") {
    ctx.omittedThinking += 1;
    return "> [Thinking block omitted]";
  }
  if (block.type === "image") return renderImage(block, ctx);
  if (block.type === "tool_use") {
    ctx.toolUseCount += 1;
    return renderToolUse(block);
  }
  if (block.type === "tool_result") return renderToolResult(block);
  return fenced(JSON.stringify(block, null, 2), "json");
}

function renderContent(content, ctx) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => renderBlock(block, ctx)).filter(Boolean).join("\n\n");
  }
  if (typeof content === "object") return fenced(JSON.stringify(content, null, 2), "json");
  return String(content);
}

export async function exportClaudeLocal({ title = "", session = "", root = "", outDir = "" } = {}) {
  if (!title && !session) {
    throw new Error("Pass --title <conversation title> or --session <session id>.");
  }

  const resolvedOutDir = path.resolve(outDir || path.join("exports", "claude", "local"));
  const selected = selectConversation({ root, title, session });
  const transcriptSource = chooseTranscriptSource(selected);
  const conversationTitle = selected.meta.title || selected.meta.sessionId;
  // Include the session id so same-titled sessions never overwrite each other.
  const slug = `${slugify(conversationTitle)}_${slugify(selected.meta.sessionId, { maxLength: 24 })}`;
  fs.mkdirSync(resolvedOutDir, { recursive: true });

  // Read the transcript before touching any existing export, and write assets
  // to a staging directory that is swapped in only after rendering succeeds.
  const records = readJsonl(transcriptSource.path);

  const assetsDirName = `claude_local_${slug}_assets`;
  const assetsDir = path.join(resolvedOutDir, assetsDirName);
  const stagingDir = `${assetsDir}.staging`;
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const ctx = {
    assetsDir: stagingDir,
    finalAssetsDir: assetsDir,
    assetsDirName,
    assetIndex: 0,
    assetByHash: new Map(),
    assetRefs: [],
    omittedThinking: 0,
    toolUseCount: 0,
    toolResultCount: 0,
    attachmentCount: 0,
    skippedDuplicateMessages: 0,
  };

  const eventCounts = countEvents(records);
  const messageRecords = extractMessageRecords(records, transcriptSource.kind, ctx);

  const lines = [`# ${conversationTitle}`, ""];
  lines.push(`- Source: ${transcriptSource.kind}`);
  lines.push(`- Session ID: \`${selected.meta.sessionId}\``);
  if (selected.meta.model) lines.push(`- Model: \`${selected.meta.model}\``);
  if (selected.meta.cwd) lines.push(`- CWD: \`${selected.meta.cwd}\``);
  if (selected.meta.createdAt) lines.push(`- Created: ${isoFromEpoch(selected.meta.createdAt)}`);
  if (selected.meta.lastActivityAt) lines.push(`- Last activity: ${isoFromEpoch(selected.meta.lastActivityAt)}`);
  lines.push(`- Source events: ${records.length}`);
  lines.push(`- Exported at: ${new Date().toISOString()}`);
  lines.push("", "## Conversation", "");

  const roleCounts = { user: 0, assistant: 0, attachment: 0 };
  let renderedToolResultCount = 0;
  for (const item of messageRecords) {
    if (item.type === "attachment") {
      const rendered = renderAttachment(item.record, ctx).trim();
      if (!rendered) continue;
      roleCounts.attachment += 1;
      lines.push(`### Attachment ${roleCounts.attachment}`, "", rendered, "");
      continue;
    }

    const rendered = renderContent(item.content, ctx).trim();
    if (!rendered) continue;

    if (item.type === "tool_result") {
      renderedToolResultCount += 1;
      lines.push(`### Tool Result ${renderedToolResultCount}`);
    } else if (item.role === "assistant") {
      roleCounts.assistant += 1;
      lines.push(`### Assistant ${roleCounts.assistant}`);
    } else {
      roleCounts.user += 1;
      lines.push(`### User ${roleCounts.user}`);
    }
    lines.push("", rendered, "");
  }

  lines.push("## Export Summary", "");
  lines.push(`- User messages: ${roleCounts.user}`);
  lines.push(`- Assistant messages: ${roleCounts.assistant}`);
  lines.push(`- Attachments: ${roleCounts.attachment}`);
  lines.push(`- Tool uses rendered: ${ctx.toolUseCount}`);
  lines.push(`- Tool results rendered: ${renderedToolResultCount}`);
  lines.push(`- Duplicate messages skipped: ${ctx.skippedDuplicateMessages}`);
  lines.push(`- Thinking blocks omitted: ${ctx.omittedThinking}`);
  lines.push(`- Image assets: ${ctx.assetByHash.size}`);
  lines.push("");

  // Rendering succeeded: publish the staged assets, then the documents.
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.renameSync(stagingDir, assetsDir);

  const mdPath = path.join(resolvedOutDir, `claude_local_${slug}.md`);
  writeFileAtomicSync(mdPath, lines.join("\n"));

  const manifest = {
    title: conversationTitle,
    sessionId: selected.meta.sessionId,
    model: selected.meta.model || null,
    cwd: selected.meta.cwd || null,
    createdAt: selected.meta.createdAt || null,
    createdAtIso: selected.meta.createdAt ? isoFromEpoch(selected.meta.createdAt) : null,
    lastActivityAt: selected.meta.lastActivityAt || null,
    lastActivityAtIso: selected.meta.lastActivityAt ? isoFromEpoch(selected.meta.lastActivityAt) : null,
    source: {
      kind: transcriptSource.kind,
      metadata: portablePath(selected.metaPath),
      transcript: portablePath(transcriptSource.path),
      audit: portablePath(selected.auditPath),
      projectTranscripts: selected.projectTranscripts.map((entry) => ({
        ...entry,
        path: portablePath(entry.path),
      })),
    },
    output: {
      markdown: portablePath(mdPath),
      assetsDir: portablePath(assetsDir),
    },
    eventCounts,
    renderedCounts: {
      user: roleCounts.user,
      assistant: roleCounts.assistant,
      attachment: roleCounts.attachment,
      toolUse: ctx.toolUseCount,
      toolResult: renderedToolResultCount,
      skippedDuplicateMessages: ctx.skippedDuplicateMessages,
      omittedThinking: ctx.omittedThinking,
    },
    assets: ctx.assetRefs,
  };

  const manifestPath = path.join(resolvedOutDir, `claude_local_${slug}_manifest.json`);
  writeFileAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    markdown: portablePath(mdPath),
    manifest: portablePath(manifestPath),
    assetsDir: portablePath(assetsDir),
    assets: ctx.assetByHash.size,
    records: records.length,
    source: transcriptSource.kind,
    rendered: manifest.renderedCounts,
    selected: {
      title: conversationTitle,
      sessionId: selected.meta.sessionId,
      transcriptPath: portablePath(transcriptSource.path),
    },
  };
}

if (isMainModule(import.meta.url)) {
  runMain(async () => {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
      console.error(USAGE);
      return;
    }
    const summary = await exportClaudeLocal({
      title: typeof args.title === "string" ? args.title : typeof args.t === "string" ? args.t : "",
      session:
        typeof args.session === "string"
          ? args.session
          : typeof args["session-id"] === "string"
            ? args["session-id"]
            : "",
      root: typeof args.root === "string" ? args.root : "",
      outDir: typeof args.out === "string" ? args.out : "",
    });
    console.log(JSON.stringify(summary, null, 2));
  });
}
