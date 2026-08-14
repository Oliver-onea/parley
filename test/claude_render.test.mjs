import assert from "node:assert/strict";
import test from "node:test";

import {
  convertClaudeMarkup,
  extractTextFromContent,
  renderBlock,
  renderMessage,
  roleName,
  sortMessages,
} from "../src/lib/claude.mjs";

test("converts antArtifact markup into fenced blocks", () => {
  const input = '<antArtifact title="Demo" language="js">console.log(1)</antArtifact>';
  const output = convertClaudeMarkup(input);
  assert.match(output, /#### Artifact: Demo/);
  assert.match(output, /```js\nconsole\.log\(1\)\n```/);
});

test("renders text, tool_use, tool_result, and thinking blocks", () => {
  assert.equal(renderBlock({ type: "text", text: "hello" }), "hello");

  const toolUse = renderBlock({ type: "tool_use", name: "search", input: { q: "x" } });
  assert.match(toolUse, /\*\*\[Tool use: search\]\*\*/);
  assert.match(toolUse, /"q": "x"/);

  const toolError = renderBlock({
    type: "tool_result",
    name: "search",
    is_error: true,
    content: [{ type: "text", text: "boom" }],
  });
  assert.match(toolError, /\*\*\[Tool error: search\]\*\*/);
  assert.match(toolError, /boom/);

  const thinking = renderBlock({ type: "thinking", thinking: "pondering" });
  assert.equal(thinking, "**[Thinking]**\n\npondering");
});

test("renders image blocks with URLs as markdown images", () => {
  const output = renderBlock({
    type: "image",
    file_name: "chart.png",
    source: { url: "https://example.com/chart.png" },
  });
  assert.equal(output, "![chart.png](https://example.com/chart.png)");
});

test("extracts nested text content", () => {
  const content = [
    { type: "text", text: "a" },
    { type: "wrapper", content: [{ type: "text", text: "b" }] },
  ];
  assert.equal(extractTextFromContent(content), "a\n\nb");
});

test("sorts messages by index first, then created_at", () => {
  const sorted = sortMessages([
    { uuid: "c", created_at: "2024-01-03T00:00:00Z" },
    { uuid: "a", index: 2 },
    { uuid: "b", index: 1 },
    { uuid: "d", created_at: "2024-01-01T00:00:00Z" },
  ]);
  assert.deepEqual(
    sorted.map((message) => message.uuid),
    ["b", "a", "d", "c"],
  );
});

test("maps senders to display roles", () => {
  assert.equal(roleName("human"), "You");
  assert.equal(roleName("assistant"), "Claude");
  assert.equal(roleName("system"), "system");
});

test("renders a full message with heading, uuid comment, and extras", () => {
  const output = renderMessage(
    {
      uuid: "msg-1",
      index: 3,
      sender: "assistant",
      created_at: "2024-01-01T00:00:00Z",
      content: [{ type: "text", text: "body" }],
    },
    1,
    ["**Attachments:** none"],
  );
  assert.match(output, /^### Claude \(3\) - 2024-01-01T00:00:00Z/);
  assert.match(output, /<!-- message_uuid: msg-1 -->/);
  assert.match(output, /body/);
  assert.match(output, /\*\*Attachments:\*\* none/);
});

test("renders empty messages as a placeholder", () => {
  assert.match(renderMessage({ sender: "human", content: [] }, 1), /_\(empty\)_/);
});
