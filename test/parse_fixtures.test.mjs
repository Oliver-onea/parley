// All provider fixtures are synthetic, minimal, and anonymized. These tests
// read only local files and never call a provider network endpoint.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  buildMarkdown as buildChatGptMarkdown,
  decodeSerializedGraph,
  extractSerializedArray,
  findConversationData,
} from "../src/providers/export_chatgpt_share.mjs";
import { buildMarkdown as buildDeepSeekMarkdown } from "../src/providers/export_deepseek_share.mjs";
import {
  parseBatchExecute,
  parseGeminiPayload,
  renderMarkdown as renderGeminiMarkdown,
} from "../src/providers/export_gemini_share.mjs";
import { renderMarkdown as renderClaudeMarkdown } from "../src/providers/export_claude_share.mjs";
import { messagesOf, titleOf } from "../src/lib/claude.mjs";
import {
  buildMarkdown as buildKimiMarkdown,
  extractHydrationState,
  parseKimiShare,
} from "../src/providers/export_kimi_share.mjs";
import {
  parseGrokShare,
  renderMarkdown as renderGrokMarkdown,
} from "../src/providers/export_grok_share.mjs";
import {
  parseQwenShare,
  renderMarkdown as renderQwenMarkdown,
} from "../src/providers/export_qwen_share.mjs";

function readFixture(provider, filename) {
  return fs.readFile(new URL(`./fixtures/${provider}/${filename}`, import.meta.url), "utf8");
}

test("chatgpt fixture: decodes ordered messages and attachment metadata", async () => {
  const raw = await readFixture("chatgpt", "payload.json");
  const table = JSON.parse(extractSerializedArray(raw));
  const data = findConversationData(decodeSerializedGraph(table));
  const parsed = buildChatGptMarkdown(data, "fixture");

  assert.equal(data.title, "Fixture ChatGPT Share");
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(
    parsed.messages.map(({ message }) => message.author.role),
    ["user", "assistant"],
  );
  assert.deepEqual(
    parsed.messages.map(({ text }) => text),
    ["Question with image", "Answer in order"],
  );
  assert.deepEqual(parsed.attachments, [
    {
      name: "diagram.png",
      id: "file-fixture",
      size: 2048,
      mime_type: "image/png",
      library_file_id: "",
      source: "message.metadata.attachments",
    },
  ]);
  assert.match(parsed.markdown, /### 01\. User[\s\S]*Question with image[\s\S]*### 02\. Assistant[\s\S]*Answer in order/);
  assert.match(parsed.markdown, /> \[Image attachment: diagram\.png \(320x200\)/);
  assert.match(parsed.markdown, /\| diagram\.png \| image\/png \| 2\.00 KB \| file-fixture \| no \|/);
});

test("deepseek fixture: filters ordered roles and preserves file metadata", async () => {
  const payload = JSON.parse(await readFixture("deepseek", "payload.json"));
  const data = payload.data.biz_data;
  const parsed = buildDeepSeekMarkdown(data, "fixture");

  assert.equal(data.title, "Fixture DeepSeek Share");
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(
    parsed.messages.map((message) => message.role),
    ["USER", "ASSISTANT"],
  );
  assert.deepEqual(
    parsed.messages.map((message) => message.content),
    ["First question", "Second answer"],
  );
  assert.deepEqual(parsed.messages[0].files[0], {
    id: "file-deepseek",
    status: "SUCCESS",
    file_name: "table.csv",
    file_size: 4096,
    previewable: false,
  });
  assert.match(parsed.markdown, /# Fixture DeepSeek Share/);
  assert.match(parsed.markdown, /### 01\. User[\s\S]*First question[\s\S]*### 02\. Assistant[\s\S]*Second answer/);
  assert.match(parsed.markdown, /table\.csv \| 4\.0 KB \| id file-deepseek/);
});

test("gemini fixture: parses batchexecute turns and prompt attachments", async () => {
  const raw = await readFixture("gemini", "payload.txt");
  const parsed = parseGeminiPayload(parseBatchExecute(raw));

  assert.equal(parsed.title, "Fixture Gemini Share");
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(
    parsed.turns.map((turn) => turn.prompt),
    ["Question one", "Question two"],
  );
  assert.deepEqual(
    parsed.turns.map((turn) => turn.answer),
    ["Answer one", "Answer two"],
  );
  assert.deepEqual(parsed.turns.map((turn) => turn.attachments), [
    [
      "https://lh3.googleusercontent.com/fixture-image",
      "https://docs.google.com/document/d/fixture-doc/edit",
    ],
    [],
  ]);
  const markdown = renderGeminiMarkdown(parsed);
  assert.match(markdown, /# Fixture Gemini Share/);
  assert.match(markdown, /## Turn 1[\s\S]*### You[\s\S]*Question one[\s\S]*### Gemini[\s\S]*Answer one/);
  assert.match(markdown, /- !\[Attachment 1\]\(https:\/\/lh3\.googleusercontent\.com\/fixture-image\)/);
  assert.match(markdown, /- https:\/\/docs\.google\.com\/document\/d\/fixture-doc\/edit/);
});

test("kimi fixture: extracts hydration state and file attachment metadata", async () => {
  const html = await readFixture("kimi", "payload.html");
  const state = extractHydrationState(html);
  const shareQuery = state.queries.find((query) => query?.queryKey?.[0] === "share");
  const parsed = parseKimiShare(shareQuery.state.data);

  assert.equal(parsed.title, "Fixture Kimi Share");
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(
    parsed.messages.map((message) => message.role),
    [2, 3],
  );
  assert.deepEqual(
    parsed.messages.map((message) => message.blocks),
    [["Translate this"], ["Here is the translation"]],
  );
  assert.deepEqual(parsed.messages[0].attachments, [
    {
      id: "file-kimi",
      name: "notes.md",
      contentType: "text/plain",
      sizeBytes: 5145,
      ext: "md",
      tokenCount: 1128,
      status: 3,
      failReason: "",
      signUrl: "https://www.kimi.com/apiv2-files/sign-obj/fixture",
      previewUrl: "https://www.kimi.com/apiv2-files/sign-obj/preview",
    },
  ]);
  const rendered = buildKimiMarkdown(parsed, "fixture");
  assert.equal(rendered.messages.length, 2);
  assert.match(rendered.markdown, /# Fixture Kimi Share/);
  assert.match(rendered.markdown, /### 01\. You[\s\S]*Translate this[\s\S]*### 02\. Kimi[\s\S]*Here is the translation/);
  assert.match(rendered.markdown, /notes\.md \| text\/plain \| 5\.0 KB — not downloaded/);
});

test("claude fixture: sorts snapshot messages and renders attachment metadata", async () => {
  const data = JSON.parse(await readFixture("claude", "payload.json"));
  const messages = messagesOf(data);

  assert.equal(titleOf(data), "Fixture Claude Share");
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.sender),
    ["human", "assistant"],
  );
  assert.deepEqual(
    messages.map((message) => message.content[0].text),
    ["First question", "Second answer"],
  );
  assert.deepEqual(messages[1].attachments, [
    {
      file_name: "notes.txt",
      size: 128,
      file_type: "text/plain",
    },
  ]);
  const markdown = renderClaudeMarkdown(data, { inputUrl: "fixture" });
  assert.match(markdown, /# Fixture Claude Share/);
  assert.match(markdown, /- Exported messages: 2/);
  assert.match(markdown, /### You \(0\)[\s\S]*First question[\s\S]*### Claude \(1\)[\s\S]*Second answer/);
  assert.match(markdown, /- notes\.txt \| 128 bytes \| text\/plain/);
});

test("grok fixture: sorts responses and preserves attachment metadata", async () => {
  const data = JSON.parse(await readFixture("grok", "payload.json"));
  const parsed = parseGrokShare(data, { shareId: "grok-share-fixture" });

  assert.equal(parsed.title, "Fixture Grok Share");
  assert.equal(parsed.turns.length, 2);
  assert.deepEqual(
    parsed.turns.map((turn) => turn.sender),
    ["human", "assistant"],
  );
  assert.deepEqual(
    parsed.turns.map((turn) => turn.text),
    ["First question", "Answer _[searched image card #7]_ done"],
  );
  assert.deepEqual(parsed.turns[0].attachments, [
    {
      fileId: "file-grok",
      fileName: "diagram.png",
      mimeType: "image/png",
      fileUri: "users/fixture/file-grok/content",
    },
  ]);
  const markdown = renderGrokMarkdown(parsed);
  assert.match(markdown, /# Fixture Grok Share/);
  assert.match(markdown, /### 01\. You[\s\S]*First question[\s\S]*### 02\. Grok[\s\S]*searched image card #7/);
  assert.match(markdown, /- diagram\.png \(image\/png\) \| not downloaded/);
});

test("qwen fixture: follows the active branch and uses answer content phases", async () => {
  const payload = JSON.parse(await readFixture("qwen", "payload.json"));
  const parsed = parseQwenShare(payload.data, { shareId: payload.data.id });

  assert.equal(parsed.title, "Fixture Qwen Share");
  assert.equal(parsed.messages.length, 3);
  assert.deepEqual(
    parsed.messages.map((message) => message.id),
    ["user-root", "assistant-current", "assistant-followup"],
  );
  assert.deepEqual(
    parsed.messages.map((message) => message.text),
    [
      "Explain the function.",
      "## Answer\n\nMath: \\(x^2\\)",
      "_(no answer content exposed; only non-answer phases are present)_",
    ],
  );
  assert.deepEqual(parsed.messages[0].files[0], {
    id: "file-qwen",
    name: "notes.txt",
    type: "text/plain",
    size: 2048,
    status: "ready",
  });

  const markdown = renderQwenMarkdown(parsed);
  assert.match(markdown, /# Fixture Qwen Share/);
  assert.match(markdown, /- Model: qwen3-235b-a22b/);
  assert.match(markdown, /- Created: 2024-03-09T16:00:00\.000Z/);
  assert.match(markdown, /### 01\. You[\s\S]*Explain the function\.[\s\S]*### 02\. Qwen/);
  assert.match(markdown, /Math: \\\(x\^2\\\)/);
  assert.match(markdown, /notes\.txt \| text\/plain \| 2\.0 KB \| id file-qwen \| status ready/);
  assert.match(markdown, /no answer content exposed; only non-answer phases are present/);
  assert.doesNotMatch(markdown, /Wrong branch|Hidden reasoning|This must not be exported/);
});
