import path from "node:path";

import { sanitizeSegment } from "./text.mjs";

const SHARE_PROVIDERS = {
  chatgpt: { outputParts: ["chatgpt"], prefix: "chatgpt_share" },
  deepseek: { outputParts: ["deepseek"], prefix: "deepseek_share" },
  gemini: { outputParts: ["gemini"], prefix: "gemini_share" },
  kimi: { outputParts: ["kimi"], prefix: "kimi_share" },
  "claude-share": { outputParts: ["claude", "share"], prefix: "claude_share" },
  grok: { outputParts: ["grok"], prefix: "grok_share" },
};

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

export function idFromInput(input) {
  if (!input) return "";
  if (looksLikeUrl(input)) {
    try {
      const url = new URL(input);
      const parts = url.pathname.split("/").filter(Boolean);
      return sanitizeSegment(parts.at(-1) || url.hostname);
    } catch {
      return sanitizeSegment(input);
    }
  }
  return sanitizeSegment(path.basename(input, path.extname(input)));
}

export function isShareProvider(providerName) {
  return Object.hasOwn(SHARE_PROVIDERS, providerName);
}

export function defaultShareOutputPath(providerName, input, outDir = "exports") {
  const provider = SHARE_PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Provider ${providerName} does not have a single markdown output path.`);
  }
  return path.join(
    outDir,
    ...provider.outputParts,
    `${provider.prefix}_${idFromInput(input)}.md`,
  );
}
