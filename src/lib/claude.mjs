// Shared rendering for Claude conversation JSON (share snapshots, desktop
// cache, raw chat exports). One implementation so every Claude provider
// produces the same Markdown for the same message shapes.

import { escapeImageLabel, fencedJson, scalar } from "./markdown.mjs";

export function parseAttributes(raw) {
  const attrs = {};
  for (const match of String(raw || "").matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

// Convert Claude <antArtifact> markup into a titled fenced code block.
export function convertClaudeMarkup(text) {
  return String(text ?? "")
    .replace(/<antArtifact\b([^>]*)>/g, (_match, rawAttrs) => {
      const attrs = parseAttributes(rawAttrs);
      const title = attrs.title || attrs.identifier || "Artifact";
      const language = attrs.language || (attrs.type?.includes("code") ? "text" : "markdown");
      return `\n\n#### Artifact: ${title}\n\n\`\`\`${language}\n`;
    })
    .replace(/<\/antArtifact>/g, "\n```\n");
}

export function extractTextFromContent(content) {
  if (typeof content === "string") return convertClaudeMarkup(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (item && typeof item === "object") {
        if (item.text) parts.push(convertClaudeMarkup(item.text));
        else if (item.thinking) parts.push(String(item.thinking));
        else if ("content" in item) {
          const nested = extractTextFromContent(item.content);
          if (nested) parts.push(nested);
        }
      } else {
        const rendered = scalar(item);
        if (rendered) parts.push(rendered);
      }
    }
    return parts.filter(Boolean).join("\n\n");
  }
  if (content && typeof content === "object") {
    if (content.text) return convertClaudeMarkup(content.text);
    if (content.thinking) return String(content.thinking);
    if ("content" in content) return extractTextFromContent(content.content);
  }
  return "";
}

export function renderBlock(block) {
  if (!block || typeof block !== "object") return scalar(block);
  const blockType = block.type || "unknown";
  if (blockType === "text") return convertClaudeMarkup(block.text || "");

  if (blockType === "tool_use") {
    return `**[Tool use: ${block.name || "tool"}]**\n\n${fencedJson(block.input || {})}`;
  }

  if (blockType === "tool_result") {
    const name = block.name || block.tool_use_id || "tool";
    const status = block.is_error ? "error" : "result";
    const text = extractTextFromContent(block.content);
    return `**[Tool ${status}: ${name}]**\n\n${text || fencedJson(block)}`;
  }

  if (blockType === "thinking" || blockType === "redacted_thinking") {
    const text = block.thinking || block.text || "";
    return `**[Thinking]**${text ? `\n\n${text}` : ""}`;
  }

  if (blockType === "image") {
    const source = block.source || {};
    const label = escapeImageLabel(block.file_name || block.name || block.uuid || "image");
    if (source.url) return `![${label}](${source.url})`;
  }

  const text = extractTextFromContent(block.content);
  if (text) return `**[${blockType}]**\n\n${text}`;
  return `**[${blockType}]**\n\n${fencedJson(block)}`;
}

export function roleName(sender) {
  return { human: "You", user: "You", assistant: "Claude" }[sender] || sender || "unknown";
}

function messageSortKey(message) {
  const index = message?.index;
  if (Number.isFinite(index)) return [0, index];
  const created = Date.parse(message?.created_at || "");
  return [1, Number.isFinite(created) ? created : 0];
}

export function sortMessages(messages) {
  return [...messages].sort((a, b) => {
    const ak = messageSortKey(a);
    const bk = messageSortKey(b);
    return ak[0] - bk[0] || ak[1] - bk[1];
  });
}

export function messagesOf(conversation) {
  return sortMessages(conversation?.chat_messages || conversation?.messages || []);
}

export function titleOf(conversation, fallback = "Claude conversation") {
  return conversation?.name || conversation?.title || conversation?.snapshot_name || fallback;
}

// Render one message: heading, uuid comment, content blocks, then any
// provider-specific extra parts (attachment lists, asset links, ...).
export function renderMessage(message, ordinal, extraParts = []) {
  const role = roleName(message?.sender || message?.role);
  const headingBits = [`### ${role}`, `(${message?.index ?? ordinal})`];
  if (message?.created_at) headingBits.push(`- ${message.created_at}`);

  const content = message?.content || [];
  const parts = (Array.isArray(content) ? content : [content])
    .map((block) => renderBlock(block))
    .filter(Boolean);
  if (!parts.length && message?.text) parts.push(convertClaudeMarkup(message.text));
  parts.push(...extraParts.filter(Boolean));
  if (message?.truncated) parts.push("**[Message marked truncated by Claude]**");

  return [
    headingBits.join(" "),
    message?.uuid ? `<!-- message_uuid: ${message.uuid} -->` : "",
    "",
    parts.join("\n\n").trim() || "_(empty)_",
  ]
    .filter((line, index) => index === 2 || line !== "")
    .join("\n");
}
