# Provider Notes

## ChatGPT

`src/providers/export_chatgpt_share.mjs` reads public ChatGPT share pages and
parses the embedded `streamController.enqueue(...)` payload. Public shares expose
attachment metadata, but usually not the original file bytes.

## DeepSeek

`src/providers/export_deepseek_share.mjs` calls the public share API
`/api/v0/share/content?share_id=<id>` and renders the returned messages,
including reasoning (`thinking_content`) and search results.

The API exposes file metadata (`file_name`, `file_size`, `id`,
`previewable`) but no download URL; the anonymous file endpoints return the
app shell rather than file bytes. parley therefore lists each file's
metadata (name, human-readable size, id) and annotates that the content is
not downloadable, mirroring the Claude hidden-files handling.

## Gemini

`src/providers/export_gemini_share.mjs` resolves Gemini share links and calls the
Gemini `batchexecute` RPC used by the page. Public Googleusercontent assets are
downloaded by default and localized next to the Markdown file.

## Kimi

`src/providers/export_kimi_share.mjs` reads the server-side rendered share page,
extracts the dehydrated `window.HYDRATION_INIT_STATE`, and renders text blocks,
reasoning (`think`) blocks, and web-search tool results.

`file` blocks carry a signed `signUrl` that 307-redirects to a Volcengine
object-storage URL. parley downloads attachments into `<output>_assets/` by
default (`--no-assets` skips) and writes an `_assets_manifest.json`. File
metadata (`name`, `contentType`, `sizeBytes`, `ext`, `tokenCount`) comes from
the dehydrated block value.

## Claude

`src/providers/export_claude_share.mjs` reads Claude public share snapshots via
`/api/chat_snapshots/...` when plain HTTP access is accepted by Claude.

`src/providers/export_claude_cache.mjs` scans the local Claude Desktop Chromium
HTTP cache for conversation JSON and cached assets. It does not read cookies,
keychain items, localStorage, or session tokens.

`src/providers/export_claude_local.mjs` exports Claude Desktop local-agent mode
sessions from `local-agent-mode-sessions`.

`src/browser/claude_web_exporter.js` is a browser-console helper for logged-in
Claude pages. It is kept as a reference fallback rather than wired into the CLI,
because browser automation depends on the user's active browser environment.
