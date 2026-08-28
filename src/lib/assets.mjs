// File-type sniffing and download-name helpers shared by asset-downloading
// providers.

import path from "node:path";

import { writeFileAtomic } from "./paths.mjs";

export function createAssetManifest(outputPath) {
  const outputBase = outputPath.replace(/\.md$/i, "");
  return {
    output: outputPath,
    assetsDir: `${outputBase}_assets`,
    manifestPath: `${outputBase}_assets_manifest.json`,
    downloadedAt: new Date().toISOString(),
    assets: [],
  };
}

export function appendAssetRecord(manifest, record) {
  manifest.assets.push(record);
}

export function updateAssetManifestCounts(manifest) {
  manifest.downloaded = manifest.assets.filter((item) => item.status === "downloaded").length;
  manifest.failed = manifest.assets.filter((item) => item.status === "failed").length;
}

export async function writeAssetManifest(manifest) {
  await writeFileAtomic(manifest.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function filenameFromContentDisposition(value) {
  const utf8 = String(value || "").match(/filename\*=UTF-8''([^;]+)/i);
  const regular = String(value || "").match(/filename="?([^";]+)"?/i);
  const raw = utf8?.[1] || regular?.[1] || "";
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function extensionFromContentType(value) {
  const type = String(value || "").split(";")[0].trim().toLowerCase();
  const mapping = {
    "application/pdf": ".pdf",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "text/plain": ".txt",
  };
  return mapping[type] || "";
}

export function extensionFromBuffer(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return ".webp";
  }
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString("ascii"))) return ".gif";
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString("ascii") === "%PDF-") return ".pdf";
  return "";
}

export function extensionFromUrl(value) {
  try {
    const ext = path.extname(new URL(value).pathname).toLowerCase();
    return /^[a-z0-9.]{2,12}$/.test(ext) ? ext : "";
  } catch {
    return "";
  }
}
