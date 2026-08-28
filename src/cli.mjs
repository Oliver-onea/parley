#!/usr/bin/env node

// parley CLI: one command to export an LLM conversation.
// Providers are imported directly, so errors propagate and no argv
// re-serialization happens between the CLI and provider code.

import path from "node:path";

import {
  defaultShareOutputPath,
  idFromInput,
  isShareProvider,
} from "./lib/share-paths.mjs";
import { todayStamp } from "./lib/paths.mjs";
import { isMainModule, runMain } from "./lib/proc.mjs";
import { sanitizeSegment } from "./lib/text.mjs";
import { exportChatGptShare } from "./providers/export_chatgpt_share.mjs";
import { exportClaudeAssets } from "./providers/export_claude_chat_assets.mjs";
import { exportClaudeCache } from "./providers/export_claude_cache.mjs";
import { exportClaudeLocal } from "./providers/export_claude_local.mjs";
import { exportClaudeShare } from "./providers/export_claude_share.mjs";
import { exportDeepSeekShare } from "./providers/export_deepseek_share.mjs";
import { exportGeminiShare } from "./providers/export_gemini_share.mjs";
import { exportGrokShare } from "./providers/export_grok_share.mjs";
import { exportKimiShare } from "./providers/export_kimi_share.mjs";

export { sanitizeSegment };
export { idFromInput };

const COMMAND_ALIASES = new Map([
  ["gpt", "chatgpt"],
  ["chatgpt", "chatgpt"],
  ["deepseek", "deepseek"],
  ["gemini", "gemini"],
  ["kimi", "kimi"],
  ["grok", "grok"],
  ["claude", "claude-share"],
  ["claude-share", "claude-share"],
  ["claude-cache", "claude-cache"],
  ["cache", "claude-cache"],
  ["claude-local", "claude-local"],
  ["local", "claude-local"],
  ["claude-assets", "claude-assets"],
  ["assets", "claude-assets"],
]);

// option flag -> canonical parsed key; "conversations" collects repeats.
const VALUE_OPTIONS = new Map([
  ["--out-dir", "outDir"],
  ["--export-root", "outDir"],
  ["-o", "outDir"],
  ["--out", "out"],
  ["--output", "output"],
  ["--limit", "limit"],
  ["--conversation", "conversations"],
  ["--cache-dir", "cacheDir"],
  ["--root", "root"],
  ["--session", "session"],
  ["--session-id", "session"],
  ["--title", "title"],
  ["-t", "title"],
  ["--t", "title"],
  ["--assets-dir", "assetsDir"],
  ["--source-url", "sourceUrl"],
]);

const FLAG_OPTIONS = new Map([
  ["--assets", ["assets", true]],
  ["--no-assets", ["assets", false]],
  ["--download-assets", ["downloadAssets", true]],
  ["-h", ["help", true]],
  ["--help", ["help", true]],
]);

export function usage() {
  return `
parley

Usage:
  parley <share-url> [--out-dir exports] [--output file.md] [--no-assets]
  parley chatgpt <chatgpt-share-url> [--output file.md] [--no-assets]
  parley deepseek <deepseek-share-url> [--output file.md]
  parley gemini <gemini-share-url> [--no-assets]
  parley kimi <kimi-share-url> [--output file.md] [--no-assets]
  parley claude <claude-share-url>
  parley grok <grok-share-url> [--no-assets]
  parley claude-cache [--limit 6] [--conversation uuid] [--cache-dir dir]
  parley claude-local --title "Conversation title"
  parley claude-local --session local_session_id
  parley claude-assets <raw-chat-json> [--assets-dir dir] [--download-assets]

Examples:
  parley https://chatgpt.com/share/<share-id>
  parley https://chat.deepseek.com/share/<share-id>
  parley https://share.gemini.google/<share-id>
  parley https://www.kimi.com/share/<share-id>
  parley https://claude.ai/share/<share-id>
  parley https://grok.com/share/<share-id>
  parley claude-cache --limit 10 --out-dir ./chat-exports

Notes:
  - Default export root is ./exports relative to the current shell directory.
  - ChatGPT/Gemini/Kimi attachment downloading is on by default; --no-assets skips it.
  - Claude public shares hide uploaded files; the export annotates them instead.
  - Claude public shares may be blocked by Cloudflare in plain HTTP mode. Use a
    browser-captured raw JSON file with the claude provider if needed.
`.trim();
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

export function inferProvider(input) {
  const value = String(input || "");
  if (/chatgpt\.com\/share\//i.test(value)) return "chatgpt";
  if (/chat\.deepseek\.com\/share\//i.test(value)) return "deepseek";
  if (/share\.gemini\.google\//i.test(value) || /gemini\.google\.com\/share\//i.test(value)) {
    return "gemini";
  }
  if (/kimi\.com\/share\//i.test(value)) return "kimi";
  if (/claude\.ai\/share\//i.test(value)) return "claude-share";
  if (/grok\.com\/share\//i.test(value)) return "grok";
  return "";
}

export function parseCli(argv) {
  const args = [...argv];
  const parsed = {
    command: "",
    input: "",
    outDir: "exports",
    out: "",
    output: "",
    assets: true,
    downloadAssets: false,
    limit: 0,
    conversations: [],
    cacheDir: "",
    root: "",
    session: "",
    title: "",
    assetsDir: "",
    sourceUrl: "",
    help: false,
  };

  if (!args.length) {
    parsed.help = true;
    return parsed;
  }

  if (!looksLikeUrl(args[0]) && COMMAND_ALIASES.has(args[0])) {
    parsed.command = COMMAND_ALIASES.get(args.shift());
  }

  while (args.length) {
    const arg = args.shift();
    if (FLAG_OPTIONS.has(arg)) {
      const [key, value] = FLAG_OPTIONS.get(arg);
      parsed[key] = value;
    } else if (VALUE_OPTIONS.has(arg)) {
      const value = args.shift();
      if (value == null || value === "") throw new Error(`${arg} requires a value.`);
      const key = VALUE_OPTIONS.get(arg);
      if (key === "conversations") parsed.conversations.push(value);
      else if (key === "limit") {
        parsed.limit = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed.limit) || parsed.limit < 1) {
          throw new Error("--limit must be a positive integer.");
        }
      } else parsed[key] = value;
    } else if (String(arg).startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.input) {
      parsed.input = arg;
    } else if (!parsed.output) {
      parsed.output = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!parsed.command) parsed.command = inferProvider(parsed.input);
  return parsed;
}

async function runShareProvider(parsed) {
  if (!parsed.input) throw new Error(`Missing input for ${parsed.command}.`);
  const output = path.resolve(
    parsed.output || defaultShareOutputPath(parsed.command, parsed.input, parsed.outDir),
  );

  if (parsed.command === "chatgpt") {
    return exportChatGptShare({ input: parsed.input, output, downloadAssets: parsed.assets });
  }
  if (parsed.command === "deepseek") {
    return exportDeepSeekShare({ input: parsed.input, output });
  }
  if (parsed.command === "gemini") {
    return exportGeminiShare({ input: parsed.input, output, downloadAssets: parsed.assets });
  }
  if (parsed.command === "kimi") {
    return exportKimiShare({ input: parsed.input, output, downloadAssets: parsed.assets });
  }
  if (parsed.command === "grok") {
    return exportGrokShare({ input: parsed.input, output, downloadAssets: parsed.assets });
  }
  return exportClaudeShare({ input: parsed.input, output });
}

export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (parsed.help) {
    console.log(usage());
    return null;
  }
  if (!parsed.command) {
    throw new Error(`Could not infer provider from input: ${parsed.input || "(none)"}`);
  }

  let summary;
  if (isShareProvider(parsed.command)) {
    summary = await runShareProvider(parsed);
  } else if (parsed.command === "claude-cache") {
    summary = await exportClaudeCache({
      ...(parsed.cacheDir ? { cacheDir: path.resolve(parsed.cacheDir) } : {}),
      outDir:
        parsed.out ||
        path.join(path.resolve(parsed.outDir), "claude", `cache_recent_${todayStamp()}`),
      ...(parsed.limit ? { limit: parsed.limit } : {}),
      conversations: parsed.conversations.map((uuid) => uuid.toLowerCase()),
    });
  } else if (parsed.command === "claude-local") {
    summary = await exportClaudeLocal({
      title: parsed.title,
      session: parsed.session,
      root: parsed.root,
      outDir: parsed.out || path.join(path.resolve(parsed.outDir), "claude", "local"),
    });
  } else if (parsed.command === "claude-assets") {
    summary = await exportClaudeAssets({
      input: parsed.input,
      output: parsed.output,
      outDir: path.resolve(parsed.outDir),
      assetsDir: parsed.assetsDir,
      sourceUrl: parsed.sourceUrl,
      downloadAssets: parsed.downloadAssets,
    });
  } else {
    throw new Error(`Unsupported command: ${parsed.command}`);
  }

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (isMainModule(import.meta.url)) {
  runMain(runCli);
}
