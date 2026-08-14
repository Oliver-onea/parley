// Generic Markdown helpers shared by all providers.

export function scalar(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function fenced(value, lang = "") {
  const text = String(value ?? "");
  const longestRun = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

export function fencedJson(value) {
  return fenced(JSON.stringify(value, null, 2), "json");
}

// Wrap link/image targets that contain characters that break inline Markdown
// destinations (spaces, parentheses) in CommonMark angle brackets.
export function linkTarget(value) {
  const target = String(value ?? "");
  return /[\s()<>]/.test(target) ? `<${target.replace(/[<>]/g, "")}>` : target;
}

export function escapeImageLabel(value) {
  return String(value).replace(/\]/g, "\\]").replace(/\n+/g, " ").trim();
}

export function tableCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
