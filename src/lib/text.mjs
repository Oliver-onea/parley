// ASCII-only segment for share ids and URL-derived names.
export function sanitizeSegment(value, fallback = "conversation") {
  const segment = String(value || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return segment || fallback;
}

// Unicode-friendly slug for filenames derived from conversation titles.
export function slugify(value, { maxLength = 100, fallback = "conversation" } = {}) {
  const slug = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, maxLength);
  return slug || fallback;
}

export function sanitizeFilename(value, fallback = "file") {
  const clean = String(value || "")
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return clean || fallback;
}

// Human-readable byte count (e.g. 429269 -> "419 KB"). Shared by providers
// that surface file metadata.
export function formatFileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

// External JSON files may carry a UTF-8 BOM, which JSON.parse rejects.
export function stripBom(value) {
  const text = String(value ?? "");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function parseJsonText(value) {
  return JSON.parse(stripBom(value));
}

export function decodeHtml(value) {
  const named = { amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " " };
  return String(value).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity] ?? match;
  });
}
