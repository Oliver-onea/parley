import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAssetRecord,
  createAssetManifest,
  updateAssetManifestCounts,
  writeAssetManifest,
} from "../src/lib/assets.mjs";

test("asset manifest helpers preserve the shared shape and status counts", () => {
  const manifest = createAssetManifest("exports/example.md");
  const downloaded = { index: 1, status: "downloaded" };
  const failed = { index: 2, status: "failed" };

  appendAssetRecord(manifest, downloaded);
  appendAssetRecord(manifest, failed);
  updateAssetManifestCounts(manifest);

  assert.deepEqual(Object.keys(manifest), [
    "output",
    "assetsDir",
    "manifestPath",
    "downloadedAt",
    "assets",
    "downloaded",
    "failed",
  ]);
  assert.equal(manifest.output, "exports/example.md");
  assert.equal(manifest.assetsDir, "exports/example_assets");
  assert.equal(manifest.manifestPath, "exports/example_assets_manifest.json");
  assert.deepEqual(manifest.assets, [downloaded, failed]);
  assert.equal(manifest.downloaded, 1);
  assert.equal(manifest.failed, 1);
});

test("asset manifest writer preserves JSON formatting and writes atomically", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parley-assets-manifest-"));
  const manifest = createAssetManifest(path.join(tempDir, "example.md"));
  appendAssetRecord(manifest, { index: 1, status: "downloaded", bytes: 3 });
  updateAssetManifestCounts(manifest);

  await writeAssetManifest(manifest);

  const serialized = await fs.readFile(manifest.manifestPath, "utf8");
  assert.equal(serialized, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(fs.access(`${manifest.manifestPath}.tmp-${process.pid}`));
});
