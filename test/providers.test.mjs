import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildMarkdown,
  decodeSerializedGraph,
  extractSerializedArray,
  findConversationData,
} from "../src/providers/export_chatgpt_share.mjs";
import { extractShareId as extractDeepSeekShareId, buildMarkdown as buildDeepSeekMarkdown } from "../src/providers/export_deepseek_share.mjs";
import { parseBatchExecute, parseGeminiPayload, renderMarkdown } from "../src/providers/export_gemini_share.mjs";
import {
  extractShareId as extractKimiShareId,
  extractHydrationState,
  parseKimiShare,
  buildMarkdown as buildKimiMarkdown,
} from "../src/providers/export_kimi_share.mjs";

const execFileAsync = promisify(execFile);

test("chatgpt: extracts the serialized array from an enqueue script", () => {
  const payload = JSON.stringify([{ a: 1 }]);
  const script = `streamController.enqueue(${JSON.stringify(payload)});`;
  assert.equal(extractSerializedArray(script), payload);
  assert.equal(extractSerializedArray("  [1,2,3]  "), "[1,2,3]");
});

test("chatgpt: decodes the reference-table graph", () => {
  const table = [
    { title: 1, count: 2, nested: 3, flag: false },
    "Test Conversation",
    "not-a-ref",
    [1, 2],
  ];
  const decoded = decodeSerializedGraph(table);
  assert.equal(decoded.title, "Test Conversation");
  assert.equal(decoded.count, "not-a-ref");
  assert.deepEqual(decoded.nested, ["Test Conversation", "not-a-ref"]);
  assert.equal(decoded.flag, false);
});

test("chatgpt: finds conversation data anywhere in the decoded graph", () => {
  const data = { linear_conversation: [], mapping: {} };
  assert.equal(findConversationData({ deeply: { nested: { value: data } } }), data);
  assert.throws(() => findConversationData({ nothing: true }), /Could not locate/);
});

test("chatgpt: builds markdown with visible user/assistant text only", () => {
  const data = {
    title: "Fixture Chat",
    conversation_id: "conv-1",
    create_time: 1710000000,
    linear_conversation: [
      {
        id: "n1",
        message: {
          author: { role: "user" },
          content: { content_type: "text", parts: ["Question?"] },
          metadata: {},
        },
      },
      {
        id: "n2",
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Answer."] },
          metadata: {},
        },
      },
      {
        id: "n3",
        message: {
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["secret-hidden-text"] },
          metadata: { is_visually_hidden_from_conversation: true },
        },
      },
    ],
  };
  const { markdown, messages } = buildMarkdown(data, "https://chatgpt.com/share/fixture");
  assert.equal(messages.length, 2);
  assert.match(markdown, /# Fixture Chat/);
  assert.match(markdown, /### 01\. User/);
  assert.match(markdown, /### 02\. Assistant/);
  assert.match(markdown, /- Created: 2024-03-09T16:00:00\.000Z/);
  assert.doesNotMatch(markdown, /secret-hidden-text/);
});

test("chatgpt: exports multimodal user messages with image placeholders", () => {
  const data = {
    title: "Multimodal Chat",
    conversation_id: "share-1",
    linear_conversation: [
      {
        id: "n1",
        message: {
          author: { role: "user" },
          content: {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "image_asset_pointer",
                asset_pointer: "sediment://file_abc123?shared_conversation_id=share-1",
                width: 100,
                height: 80,
              },
              "look at this",
            ],
          },
          metadata: {},
        },
      },
      {
        id: "n2",
        message: {
          author: { role: "assistant" },
          content: { content_type: "code", language: "python", text: "print(1)" },
          metadata: {},
        },
      },
    ],
  };
  const { markdown, messages } = buildMarkdown(data, "test");
  assert.equal(messages.length, 2);
  assert.match(markdown, /look at this/);
  assert.match(markdown, /\[Image attachment: file_abc123 \(100x80\)/);
  assert.match(markdown, /### 02\. Assistant \(code\)/);
  assert.match(markdown, /```python\nprint\(1\)\n```/);
});

test("claude-share: annotates files hidden by the public share API", async () => {
  const { renderMarkdown } = await import("../src/providers/export_claude_share.mjs");
  const markdown = renderMarkdown({
    uuid: "u1",
    name: "Hidden Files",
    chat_messages: [
      {
        uuid: "m1",
        index: 0,
        sender: "human",
        content: [{ type: "text", text: "看我的图" }],
        files: [],
        attachments: [],
        file_count: 3,
        image_count: 0,
      },
    ],
  });
  assert.match(markdown, /3 attached file\(s\) hidden by Claude/);
  assert.match(markdown, /- Files hidden by Claude in this share: 3/);
});

test("gemini: parses a batchexecute payload into turns", () => {
  const inner = [
    [
      null,
      [
        [
          "msg-1",
          null,
          [["Hello Gemini"]],
          [[[null, ["Answer text"]]]],
          [1710000000],
        ],
      ],
      [null, "Fixture Share"],
      "share-id-1",
      [1710000000],
    ],
  ];
  const raw = JSON.stringify([["wrb.fr", "ujx1Bf", JSON.stringify(inner)]]);
  const parsed = parseGeminiPayload(parseBatchExecute(raw));

  assert.equal(parsed.title, "Fixture Share");
  assert.equal(parsed.shareId, "share-id-1");
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].prompt, "Hello Gemini");
  assert.equal(parsed.turns[0].answer, "Answer text");
  assert.equal(parsed.turns[0].createdAt, "2024-03-09T16:00:00.000Z");

  const markdown = renderMarkdown(parsed);
  assert.match(markdown, /# Fixture Share/);
  assert.match(markdown, /### You\n\nHello Gemini/);
  assert.match(markdown, /### Gemini\n\nAnswer text/);
});

test("gemini: recognizes Google Docs/Drive attachment links", async () => {
  const { googleAttachmentInfo } = await import("../src/providers/export_gemini_share.mjs");
  assert.deepEqual(
    googleAttachmentInfo("https://docs.google.com/document/d/abc_123-XYZ/edit?usp=drivesdk"),
    {
      id: "abc_123-XYZ",
      exportUrl: "https://docs.google.com/document/d/abc_123-XYZ/export?format=docx",
    },
  );
  assert.deepEqual(
    googleAttachmentInfo("https://docs.google.com/spreadsheets/d/s1/edit"),
    { id: "s1", exportUrl: "https://docs.google.com/spreadsheets/d/s1/export?format=xlsx" },
  );
  assert.deepEqual(googleAttachmentInfo("https://drive.google.com/file/d/f1/view"), {
    id: "f1",
    exportUrl: "https://drive.google.com/uc?export=download&id=f1",
  });
  assert.equal(googleAttachmentInfo("https://example.com/doc"), null);
});

test("grok: parses share JSON into ordered turns with markup converted", async () => {
  const { extractShareId, parseGrokShare, renderMarkdown } = await import(
    "../src/providers/export_grok_share.mjs"
  );
  assert.equal(extractShareId("https://grok.com/share/bGVnYWN5_abc-123"), "bGVnYWN5_abc-123");

  const parsed = parseGrokShare(
    {
      conversation: { conversationId: "c1", title: "Grok Fixture" },
      responses: [
        {
          responseId: "r2",
          sender: "assistant",
          createTime: "2026-01-01T00:01:00Z",
          model: "grok-4",
          thinkingStartTime: "2026-01-01T00:00:58Z",
          thinkingEndTime: "2026-01-01T00:01:00Z",
          outputChunks: [
            {
              text: {
                text:
                  'Answer<grok:render card_id="x" card_type="image_card" type="render_searched_image">\n' +
                  '<argument name="image_id">3</argument>\n</grok:render> done',
              },
            },
          ],
          webSearchResults: [{ url: "https://example.com", title: "Example" }],
        },
        {
          responseId: "r1",
          sender: "human",
          createTime: "2026-01-01T00:00:00Z",
          inputChunks: [{ text: { text: "Question" } }],
          fileAttachmentsMetadata: [
            {
              fileMetadataId: "f1",
              fileMimeType: "image/png",
              fileName: "shot.png",
              fileUri: "users/u1/f1/content",
            },
          ],
        },
      ],
    },
    { shareId: "share-1" },
  );

  assert.equal(parsed.title, "Grok Fixture");
  assert.deepEqual(
    parsed.turns.map((turn) => turn.sender),
    ["human", "assistant"],
  );
  assert.equal(parsed.turns[0].attachments[0].fileUri, "users/u1/f1/content");
  assert.match(parsed.turns[1].text, /_\[searched image card #3\]_/);
  assert.equal(parsed.turns[1].thinkingSeconds, 2);

  const markdown = renderMarkdown(parsed);
  assert.match(markdown, /# Grok Fixture/);
  assert.match(markdown, /### 01\. You/);
  assert.match(markdown, /### 02\. Grok/);
  assert.match(markdown, /shot\.png \(image\/png\) \| not downloaded/);
  assert.match(markdown, /Web search results consulted \(1\)/);
});

test("claude-assets: writes portable paths in manifest and status output", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parley-assets-"));
  const inputPath = path.join(tempDir, "raw.json");
  const outputPath = path.join(tempDir, "export.md");
  const assetsDir = path.join(tempDir, "asset-output");
  await fs.writeFile(
    inputPath,
    JSON.stringify({
      uuid: "conversation-1",
      name: "Asset Path Test",
      messages: [
        {
          uuid: "message-1",
          index: 1,
          sender: "human",
          content: [{ type: "text", text: "hello" }],
          files: [
            {
              file_name: "diagram.png",
              file_kind: "image",
              preview_url: "/api/files/example/preview",
              image_width: 100,
              image_height: 80,
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    "src/providers/export_claude_chat_assets.mjs",
    inputPath,
    outputPath,
    "--assets-dir",
    assetsDir,
  ]);
  const status = JSON.parse(stdout);
  const manifestPath = outputPath.replace(/\.md$/i, "_assets_manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  assert.equal(path.isAbsolute(status.output), false);
  assert.equal(path.isAbsolute(status.manifest), false);
  assert.equal(path.isAbsolute(manifest.source), false);
  assert.equal(path.isAbsolute(manifest.output), false);
  assert.equal(path.isAbsolute(manifest.assets[0].local_path), false);
});

test("claude-local: writes portable paths in manifest and status output", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "parley-local-"));
  const rootDir = path.join(tempDir, "sessions");
  const sessionDir = path.join(rootDir, "session-1");
  const outDir = path.join(tempDir, "exports");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "local_session-1.json"),
    JSON.stringify({
      sessionId: "session-1",
      title: "Portable Demo",
      model: "claude-test",
      cwd: "relative/project",
      createdAt: 1710000000,
      lastActivityAt: 1710000100,
    }),
    "utf8",
  );
  await fs.writeFile(
    path.join(sessionDir, "audit.jsonl"),
    [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        message: { content: [{ type: "text", text: "Hi" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        message: { content: [{ type: "text", text: "Hello" }] },
      }),
    ].join("\n"),
    "utf8",
  );

  const { stdout } = await execFileAsync(process.execPath, [
    "src/providers/export_claude_local.mjs",
    "--root",
    rootDir,
    "--session",
    "session-1",
    "--out",
    outDir,
  ]);
  const status = JSON.parse(stdout);
  const manifest = JSON.parse(
    await fs.readFile(path.join(outDir, "claude_local_portable_demo_session-1_manifest.json"), "utf8"),
  );

  assert.equal(path.isAbsolute(status.markdown), false);
  assert.equal(path.isAbsolute(status.manifest), false);
  assert.equal(path.isAbsolute(status.assetsDir), false);
  assert.equal(path.isAbsolute(status.selected.transcriptPath), false);
  assert.equal(path.isAbsolute(manifest.source.metadata), false);
  assert.equal(path.isAbsolute(manifest.source.transcript), false);
  assert.equal(path.isAbsolute(manifest.source.audit), false);
  assert.equal(path.isAbsolute(manifest.output.markdown), false);
  assert.equal(path.isAbsolute(manifest.output.assetsDir), false);
});

test("deepseek: extracts share ids from URLs and bare ids", () => {
  assert.equal(extractDeepSeekShareId("https://chat.deepseek.com/share/abc123"), "abc123");
  assert.equal(extractDeepSeekShareId("abc123-def_456"), "abc123-def_456");
  assert.equal(extractDeepSeekShareId(""), "");
});

test("deepseek: builds markdown from share messages", () => {
  const data = {
    title: "DeepSeek Fixture",
    messages: [
      {
        message_id: 1,
        role: "USER",
        content: "Hello",
        inserted_at: 1710000000,
        thinking_content: null,
        search_results: null,
        files: [],
      },
      {
        message_id: 2,
        role: "ASSISTANT",
        content: "Hi there",
        inserted_at: 1710000001,
        thinking_content: "Think step by step",
        search_results: [{ title: "Example", url: "https://example.com", snippet: "A snippet" }],
        files: [],
      },
    ],
  };
  const { markdown, messages } = buildDeepSeekMarkdown(data, "test");
  assert.equal(messages.length, 2);
  assert.match(markdown, /# DeepSeek Fixture/);
  assert.match(markdown, /### 01\. User/);
  assert.match(markdown, /### 02\. Assistant/);
  assert.match(markdown, /Think step by step/);
  assert.match(markdown, /A snippet/);
});

test("deepseek: renders file metadata and annotates it is not downloadable", () => {
  const data = {
    title: "DeepSeek Files",
    messages: [
      {
        message_id: 1,
        role: "USER",
        content: "看这张图",
        inserted_at: 1710000000,
        thinking_content: null,
        search_results: null,
        files: [
          {
            id: "file-00000000-0000-4000-8000-000000000000",
            status: "SUCCESS",
            file_name: "example_screenshot.jpg",
            previewable: false,
            file_size: 429269,
            token_usage: 125,
            error_code: null,
          },
        ],
      },
    ],
  };
  const { markdown, messages } = buildDeepSeekMarkdown(data, "test");
  assert.equal(messages.length, 1);
  assert.match(markdown, /# DeepSeek Files/);
  assert.match(
    markdown,
    /example_screenshot\.jpg \| 419 KB \| id file-00000000-0000-4000-8000-000000000000/,
  );
  assert.match(markdown, /not downloadable/);
  assert.match(markdown, /- Files in this share: 1 \(metadata only, not downloadable from public shares\)/);
});

test("kimi: extracts share ids from URLs and bare ids", () => {
  assert.equal(
    extractKimiShareId("https://www.kimi.com/share/00000000-0000-4000-8000-000000000000"),
    "00000000-0000-4000-8000-000000000000",
  );
  assert.equal(extractKimiShareId("00000000-0000-4000-8000-000000000000"), "00000000-0000-4000-8000-000000000000");
  assert.equal(extractKimiShareId(""), "");
});

test("kimi: extracts and parses the hydration state", () => {
  const html = `<html><script>window.HYDRATION_INIT_STATE={"queries":[{"queryKey":["other"],"state":{"data":{}}},{"queryKey":["share","share-id"],"state":{"data":{"chat":{"name":"Fixture"},"messages":[]}}}]};</script></html>`;
  const state = extractHydrationState(html);
  const shareQuery = state.queries.find((q) => q.queryKey[0] === "share");
  assert.equal(shareQuery.state.data.chat.name, "Fixture");
});

test("kimi: parses BigInt and undefined hydration values safely", () => {
  const html = `<html><script>window.HYDRATION_INIT_STATE={"queries":[{"queryKey":["share"],"state":{"data":{"large":BigInt(9007199254740993),"missing":undefined}}}]};</script></html>`;
  const state = extractHydrationState(html);
  const data = state.queries[0].state.data;
  assert.equal(data.large, "9007199254740993");
  assert.equal(data.missing, null);
});

test("kimi: preserves undefined and BigInt text inside message strings", () => {
  const html = `<html><script>window.HYDRATION_INIT_STATE={"queries":[{"queryKey":["share"],"state":{"data":{"messages":[{"blocks":[{"content":{"case":"text","value":{"content":"undefined BigInt(1)"}}}]}]}}}]};</script></html>`;
  const state = extractHydrationState(html);
  assert.equal(state.queries[0].state.data.messages[0].blocks[0].content.value.content, "undefined BigInt(1)");
});

test("kimi: active hydration content throws instead of executing", () => {
  globalThis.__kimiHydrationExecuted = false;
  try {
    const html = `<html><script>window.HYDRATION_INIT_STATE={"attack":(globalThis.__kimiHydrationExecuted=true)};</script></html>`;
    assert.throws(() => extractHydrationState(html), /Could not parse Kimi hydration state/);
    assert.equal(globalThis.__kimiHydrationExecuted, false);
  } finally {
    delete globalThis.__kimiHydrationExecuted;
  }
});

test("kimi: parses share data into markdown", () => {
  const data = {
    chat: { name: "Kimi Fixture" },
    messages: [
      {
        id: "m1",
        role: 2,
        createTime: { seconds: 1710000000n },
        blocks: [{ content: { case: "text", value: { content: "Hello" } } }],
      },
      {
        id: "m2",
        role: 3,
        createTime: { seconds: 1710000001n },
        blocks: [
          { content: { case: "think", value: { content: "Reasoning", summary: "Summary" } } },
          {
            content: {
              case: "tool",
              value: {
                name: "web_search",
                args: JSON.stringify({ queries: ["test"] }),
                contents: [
                  {
                    content: {
                      case: "searchResult",
                      value: {
                        refIndex: "web_search:1#0",
                        base: { title: "Result", url: "https://example.com", snippet: "Snippet" },
                      },
                    },
                  },
                ],
              },
            },
          },
          { content: { case: "text", value: { content: "Hi there" } } },
        ],
      },
    ],
  };
  const parsed = parseKimiShare(data);
  const { markdown, messages } = buildKimiMarkdown(parsed, "test");
  assert.equal(messages.length, 2);
  assert.equal(parsed.title, "Kimi Fixture");
  assert.match(markdown, /# Kimi Fixture/);
  assert.match(markdown, /### 01\. You/);
  assert.match(markdown, /### 02\. Kimi/);
  assert.match(markdown, /Reasoning/);
  assert.match(markdown, /web_search:1#0/);
  assert.match(markdown, /Hi there/);
});

test("kimi: collects file blocks as attachments and renders them", () => {
  const data = {
    chat: { name: "Kimi Files" },
    messages: [
      {
        id: "m1",
        role: 2,
        createTime: { seconds: 1710000000n },
        blocks: [
          {
            content: {
              case: "file",
              value: {
                id: "file-1",
                status: 3,
                meta: {
                  name: "notes.md",
                  contentType: "text/plain",
                  sizeBytes: 5145n,
                  ext: "md",
                },
                blob: {
                  signUrl: "https://www.kimi.com/apiv2-files/sign-obj/example",
                  previewUrl: "https://www.kimi.com/apiv2-files/sign-obj/preview",
                },
                tokenCount: 1128n,
              },
            },
          },
          { content: { case: "text", value: { content: "翻译这个" } } },
        ],
      },
      {
        id: "m2",
        role: 3,
        createTime: { seconds: 1710000001n },
        blocks: [{ content: { case: "text", value: { content: "好的" } } }],
      },
    ],
  };
  const parsed = parseKimiShare(data);
  assert.equal(parsed.messages[0].attachments.length, 1);
  assert.equal(parsed.messages[0].attachments[0].name, "notes.md");
  assert.equal(parsed.messages[0].attachments[0].signUrl, "https://www.kimi.com/apiv2-files/sign-obj/example");
  assert.equal(parsed.messages[0].attachments[0].sizeBytes, 5145);

  const { markdown, messages } = buildKimiMarkdown(parsed, "test");
  assert.equal(messages.length, 2);
  assert.match(markdown, /# Kimi Files/);
  assert.match(markdown, /- Attachments in share: 1/);
  assert.match(markdown, /\*\*Attachments\*\*/);
  assert.match(markdown, /notes\.md \| text\/plain \| 5\.0 KB — not downloaded/);
  assert.match(markdown, /## Attachments/);
  assert.match(markdown, /翻译这个/);
});
