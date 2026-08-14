> [English](providers.md) | 简体中文

# Provider 说明

## ChatGPT

`src/providers/export_chatgpt_share.mjs` 读取公开 ChatGPT 分享页面，并解析其中嵌入的 `streamController.enqueue(...)` 载荷。公开分享会暴露附件元数据，但通常不会暴露原始文件字节。

## DeepSeek

`src/providers/export_deepseek_share.mjs` 调用公开分享 API `/api/v0/share/content?share_id=<id>`，并渲染返回的消息，包括推理内容（`thinking_content`）和搜索结果。

该 API 会暴露文件元数据（`file_name`、`file_size`、`id`、`previewable`），但不提供下载 URL；匿名文件端点返回的是应用外壳而非文件字节。因此 parley 会列出每个文件的元数据（名称、人类可读大小、id），并标注该内容无法下载，处理方式与 Claude 隐藏文件一致。

## Gemini

`src/providers/export_gemini_share.mjs` 解析 Gemini 分享链接，并调用页面使用的 Gemini `batchexecute` RPC。默认会下载公开 Googleusercontent 资源并本地化到 Markdown 文件旁边。

## Kimi

`src/providers/export_kimi_share.mjs` 读取服务端渲染的分享页面，提取脱水后的 `window.HYDRATION_INIT_STATE`，并渲染文本块、推理（`think`）块和联网搜索工具结果。

`file` 块带有一个签名的 `signUrl`，它会 307 重定向到 Volcengine 对象存储 URL。parley 默认将附件下载到 `<output>_assets/`（`--no-assets` 可跳过），并写入 `_assets_manifest.json`。文件元数据（`name`、`contentType`、`sizeBytes`、`ext`、`tokenCount`）来自脱水块值。

## Claude

`src/providers/export_claude_share.mjs` 在 Claude 接受纯 HTTP 访问时，通过 `/api/chat_snapshots/...` 读取 Claude 公开分享快照。

`src/providers/export_claude_cache.mjs` 扫描本地 Claude Desktop Chromium HTTP 缓存，查找对话 JSON 和已缓存的资源。它不会读取 cookie、钥匙串项目、localStorage 或会话令牌。

`src/providers/export_claude_local.mjs` 从 `local-agent-mode-sessions` 导出 Claude Desktop 本地代理模式会话。

`src/browser/claude_web_exporter.js` 是一个用于已登录 Claude 页面的浏览器控制台辅助脚本。它仅作为参考备用方案保留，未接入 CLI，因为浏览器自动化依赖于用户当前的浏览器环境。
