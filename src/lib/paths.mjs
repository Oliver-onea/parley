import fs from "node:fs/promises";
import path from "node:path";

export function toPosixPath(value) {
  return String(value).split(path.sep).join(path.posix.sep);
}

// Path relative to fromDir, POSIX separators, for use inside Markdown/manifests.
export function portablePath(value, fromDir = process.cwd()) {
  if (!value) return "";
  const relative = path.relative(fromDir, path.resolve(value)) || ".";
  return toPosixPath(relative);
}

export function posixRelative(fromDir, toPath) {
  let relative = toPosixPath(path.relative(fromDir, toPath));
  if (!relative.startsWith(".")) relative = `./${relative}`;
  return relative;
}

export function todayStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll("-", "");
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureParent(filePath) {
  await ensureDir(path.dirname(filePath));
}

// Write via temp file + rename so a failure never leaves a half-written
// document at the final path.
export async function writeFileAtomic(filePath, data, options = "utf8") {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, data, options);
  await fs.rename(tempPath, filePath);
}

export function stripExtension(fileName) {
  const ext = path.extname(fileName);
  return ext ? fileName.slice(0, -ext.length) : fileName;
}

export function uniqueName(fileName, usedNames) {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  let suffix = 2;
  while (usedNames.has(`${stem}_${suffix}${ext}`)) suffix += 1;
  const unique = `${stem}_${suffix}${ext}`;
  usedNames.add(unique);
  return unique;
}
