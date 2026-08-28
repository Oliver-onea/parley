import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inferProvider,
  parseCli,
  runCli,
  sanitizeSegment,
} from "../src/cli.mjs";
import { defaultShareOutputPath, idFromInput } from "../src/lib/share-paths.mjs";

test("infers provider from public share URLs", () => {
  assert.equal(inferProvider("https://chatgpt.com/share/example-chatgpt-share"), "chatgpt");
  assert.equal(inferProvider("https://chat.deepseek.com/share/example-deepseek-share"), "deepseek");
  assert.equal(inferProvider("https://share.gemini.google/example-gemini-share"), "gemini");
  assert.equal(inferProvider("https://gemini.google.com/share/example-gemini-share"), "gemini");
  assert.equal(
    inferProvider("https://www.kimi.com/share/00000000-0000-4000-8000-000000000000"),
    "kimi",
  );
  assert.equal(
    inferProvider("https://claude.ai/share/00000000-0000-4000-8000-000000000000"),
    "claude-share",
  );
  assert.equal(inferProvider("https://grok.com/share/bGVnYWN5_00000000-0000"), "grok");
  assert.equal(
    inferProvider("https://chat.qwen.ai/s/00000000-0000-4000-8000-000000000006?fev=1"),
    "qwen",
  );
  assert.equal(inferProvider("https://example.com/not-a-share"), "");
});

test("sanitizes share ids and file-derived ids for stable filenames", () => {
  assert.equal(sanitizeSegment("hello world/中文"), "hello_world");
  assert.equal(idFromInput("https://share.gemini.google/example-gemini-share"), "example-gemini-share");
  assert.equal(idFromInput("fixtures/claude.raw.json"), "claude.raw");
});

test("parses commands, aliases, and options", () => {
  const parsed = parseCli([
    "claude-cache",
    "--limit",
    "10",
    "--conversation",
    "00000000-0000-4000-8000-000000000000",
    "--out-dir",
    "exports",
  ]);
  assert.equal(parsed.command, "claude-cache");
  assert.equal(parsed.outDir, "exports");
  assert.equal(parsed.limit, 10);
  assert.deepEqual(parsed.conversations, ["00000000-0000-4000-8000-000000000000"]);

  const aliased = parseCli(["gpt", "https://chatgpt.com/share/abc"]);
  assert.equal(aliased.command, "chatgpt");
  assert.equal(aliased.input, "https://chatgpt.com/share/abc");

  const inferred = parseCli(["https://claude.ai/share/abc", "--no-assets"]);
  assert.equal(inferred.command, "claude-share");
  assert.equal(inferred.assets, false);

  const qwen = parseCli(["qwen", "00000000-0000-4000-8000-000000000006"]);
  assert.equal(qwen.command, "qwen");
  assert.equal(qwen.input, "00000000-0000-4000-8000-000000000006");
});

test("rejects unknown options and missing option values", () => {
  assert.throws(() => parseCli(["chatgpt", "--bogus"]), /Unknown option/);
  assert.throws(() => parseCli(["chatgpt", "url", "--output"]), /requires a value/);
  assert.throws(() => parseCli(["claude-cache", "--limit", "zero"]), /positive integer/);
});

test("keeps an explicit --out directory for cache and local commands", () => {
  const parsed = parseCli(["claude-cache", "--out", "my-dir"]);
  assert.equal(parsed.out, "my-dir");
  assert.equal(parsed.input, "");
});

test("accepts a second positional argument as the output path", () => {
  const parsed = parseCli(["claude-assets", "raw.json", "out.md"]);
  assert.equal(parsed.input, "raw.json");
  assert.equal(parsed.output, "out.md");
  assert.throws(() => parseCli(["claude-assets", "raw.json", "out.md", "extra"]), /Unexpected argument/);
});

test("supports --t as a legacy alias for --title", () => {
  const parsed = parseCli(["claude-local", "--t", "Demo"]);
  assert.equal(parsed.title, "Demo");
});

test("builds the same default output path for every provider and input form", () => {
  const providers = [
    ["chatgpt", ["chatgpt"], "chatgpt_share"],
    ["deepseek", ["deepseek"], "deepseek_share"],
    ["gemini", ["gemini"], "gemini_share"],
    ["kimi", ["kimi"], "kimi_share"],
    ["claude-share", ["claude", "share"], "claude_share"],
    ["grok", ["grok"], "grok_share"],
    ["qwen", ["qwen"], "qwen_share"],
  ];
  const inputs = [
    ["https://example.test/share/url-id", "url-id"],
    ["raw-id", "raw-id"],
    ["fixtures/conversation.raw.json", "conversation.raw"],
  ];

  for (const [providerName, outputParts, prefix] of providers) {
    for (const [input, id] of inputs) {
      assert.equal(
        defaultShareOutputPath(providerName, input, "exports"),
        path.join("exports", ...outputParts, `${prefix}_${id}.md`),
      );
    }
  }
});

test("runCli exports a raw Claude share JSON end to end", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parley-cli-"));
  const inputPath = path.join(tempDir, "claude.raw.json");
  const outputPath = path.join(tempDir, "claude.md");
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      uuid: "00000000-0000-4000-8000-000000000000",
      name: "CLI E2E",
      chat_messages: [
        { uuid: "m1", index: 1, sender: "human", content: [{ type: "text", text: "hi" }] },
        { uuid: "m2", index: 2, sender: "assistant", content: [{ type: "text", text: "hello" }] },
      ],
    }),
    "utf8",
  );

  const summary = await runCli(["claude", inputPath, "--output", outputPath]);
  assert.equal(summary.messages, 2);
  const markdown = await fs.readFile(outputPath, "utf8");
  assert.match(markdown, /# CLI E2E/);
  assert.match(markdown, /### You \(1\)/);
  assert.match(markdown, /### Claude \(2\)/);
});
