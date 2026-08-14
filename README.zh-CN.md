> [English](README.md) | 简体中文

# parley

将 LLM 对话导出为 Markdown 的本地 CLI 工具。一个命令、一次对话、一个整洁的 Markdown 文件（此外在可用时还会导出原始 JSON、清单文件和公开资源）。

支持的输入：

- ChatGPT 公开分享 URL
- DeepSeek 公开分享 URL
- Gemini 公开分享 URL
- Kimi 公开分享 URL
- Claude 公开分享 URL
- Grok 公开分享 URL
- Claude Desktop 本地代理会话
- Claude Desktop HTTP 缓存对话

## 免责声明

Parley 是一个**非官方、社区维护的工具**，与 OpenAI、Google、Anthropic、xAI、DeepSeek、Moonshot 或任何其他模型提供商均无关联，也未获得其背书或赞助。

它只请求通过提供商分享 URL 已经公开可见的内容。用户有责任遵守所导出平台的《服务条款》。请勿使用 parley 抓取非公开数据、绕过身份验证或滥用提供商 API。

## 环境要求

- Node.js 22 或更高版本
- 使用 Claude Desktop 本地/缓存导出器需要 macOS

无运行时 npm 依赖。开发依赖（ESLint）仅在运行 `npm run lint` 时需要。

## 快速开始

```bash
node bin/parley.mjs <share-url>
```

URL 中的提供商会自动识别：

```bash
node bin/parley.mjs https://chatgpt.com/share/<share-id>
node bin/parley.mjs https://chat.deepseek.com/share/<share-id>
node bin/parley.mjs https://share.gemini.google/<share-id>
node bin/parley.mjs https://www.kimi.com/share/<share-id>
node bin/parley.mjs https://claude.ai/share/<share-id>
node bin/parley.mjs https://grok.com/share/<share-id>
```

也可以一次性链接到 PATH：

```bash
npm link
parley https://claude.ai/share/<share-id>
```

## 命令

```text
parley <share-url> [--out-dir exports] [--output file.md] [--no-assets]
parley chatgpt <chatgpt-share-url> [--output file.md]
parley deepseek <deepseek-share-url> [--output file.md]
parley gemini <gemini-share-url> [--no-assets]
parley kimi <kimi-share-url> [--output file.md] [--no-assets]
parley claude <claude-share-url>
parley grok <grok-share-url> [--no-assets]
parley claude-cache [--limit 6] [--conversation uuid] [--cache-dir dir]
parley claude-local --title "Conversation title"
parley claude-local --session <local-session-id>
parley claude-assets <raw-chat-json> [--assets-dir dir] [--download-assets]
```

常用选项：

- `--out-dir <dir>`（`-o`）—— 导出根目录，默认 `./exports`
- `--output <file.md>` —— 单文件提供商的精确输出文件
- `--no-assets` —— 跳过下载附件（ChatGPT / Gemini / Grok / Kimi）
- `--out <dir>` —— `claude-cache` / `claude-local` 的精确输出目录

每条命令成功时会打印一条 JSON 摘要（输出路径、消息数、资源数），失败时以非零状态退出并打印堆栈跟踪。

## 项目结构

```text
bin/parley.mjs              CLI entry (thin shim over src/cli.mjs)
src/cli.mjs                 argument parsing + provider dispatch
src/lib/                    shared modules (rendering, http, paths, text, time)
  claude.mjs                shared Claude message -> Markdown rendering
  http.mjs                  fetch with retry + error snippets
  markdown.mjs              generic Markdown helpers
  paths.mjs                 portable/POSIX path helpers
  text.mjs                  slug/sanitize/decode helpers
  time.mjs                  ISO 8601 UTC timestamp helpers
src/providers/              one module per export source
src/browser/                manual browser-console fallback (not wired to CLI)
test/                       node:test suites
```

每个 provider 都会导出一个供 CLI 和测试使用的 `export<Name>(options)` 函数，也可以作为独立脚本直接运行。

## 输出布局

默认情况下，导出文件会写入当前目录下的 `./exports`：

```text
exports/
  chatgpt/
    chatgpt_share_<id>.md
  deepseek/
    deepseek_share_<id>.md
  gemini/
    gemini_share_<id>.md
    gemini_share_<id>_assets/
    gemini_share_<id>_assets_manifest.json
  kimi/
    kimi_share_<id>.md
    kimi_share_<id>_assets/
    kimi_share_<id>_assets_manifest.json
  claude/
    share/
      claude_share_<id>.md
    cache_recent_YYYYMMDD/
    local/
  grok/
    grok_share_<id>.md
    grok_share_<id>_assets/
```

导出的 Markdown 中的所有时间戳均为 ISO 8601 UTC，因此不同机器和语言环境下的输出完全一致。

## 开发

```bash
npm test        # unit + end-to-end tests (node:test, no network)
npm run check   # node --check every source file
npm install     # dev tooling only (ESLint)
npm run lint    # eslint .
```

约定：仅使用 ES modules，2 空格缩进（`.editorconfig`），共享逻辑放在 `src/lib/` —— provider 之间不得互相复制辅助函数。

## 隐私边界

公开分享导出器只请求公开分享 URL 以及导出所需的公开资源。

Claude 缓存导出器读取本地 HTTP 缓存文件以恢复对话 JSON 和已缓存的资源字节。它不会读取 cookie、钥匙串项目、localStorage 或会话令牌。

## 附件

各平台的公开分享实际暴露的内容，以及 parley 的处理方式：

- **ChatGPT** —— 图片和文件可通过分享页面的匿名文件端点下载。parley 默认会将它们下载到 `<output>_assets/` 并内嵌到 Markdown 中（`--no-assets` 可跳过）。部分文件会被 OpenAI 拒绝（`safety_check_failed`，例如粘贴文本文件），这些失败会记录到资源清单中。
- **Gemini** —— 公开 `googleusercontent` 图片会被下载并本地化。Google Docs/Drive 附件链接会通过 Google 导出端点导出：公开的（“知道链接的任何人”）文档可匿名下载；私有文档需要设置 `GOOGLE_COOKIE` 为已登录的 Google Cookie 请求头（从浏览器 DevTools 的 docs.google.com 中复制）。失败情况会连同原因一起记录到资源清单。
- **Grok** —— 分享 API 会返回完整的消息块；用户上传的文件和生成的图片会从 `assets.grok.com` 匿名下载并内嵌。搜索图片卡片引用了分享载荷中不存在的图片，因此会被渲染为紧凑的占位符。
- **Claude** —— 公开分享会完全隐藏上传的文件（“共享对话中的文件已隐藏”），官方分享页面也不会显示它们。parley 会在每条受影响的消息旁标注隐藏文件数量。要恢复 Claude 附件，请使用 `claude-cache`（本地 Claude Desktop HTTP 缓存）或带已认证 `CLAUDE_COOKIE` 的 `claude-assets --download-assets`。
- **DeepSeek** —— 分享 API 会暴露文件元数据（`file_name`、`file_size`、`id`、`previewable`），但不提供下载 URL；匿名文件端点返回的是应用外壳而非文件字节。parley 因此会列出每个文件的元数据（名称、大小、id），并标注该内容无法从公开分享下载。
- **Kimi** —— 脱水后的分享状态会暴露每个 `file` 块的元数据以及一个签名的 `signUrl`，它会 307 重定向到公开的 Volcengine 对象存储 URL。parley 默认将附件下载到 `<output>_assets/` 并内嵌（`--no-assets` 可跳过）。失败会记录到资源清单。

## 已知限制

- 不带浏览器请求 Claude 公开分享时，可能会被 Cloudflare 拦截。出现这种情况时，请使用浏览器捕获的原始快照 JSON 配合 `claude` provider。
- `claude-cache` 扫描器基于启发式规则：它不会解析 Chromium 缓存帧结构，只识别单文件 `download-file` 响应（不支持批量 ZIP 下载），且 GIF 提取可能会因内部 trailer 字节而截断。
- `src/browser/claude_web_exporter.js` 仅作为手动浏览器备用方案保留，不属于默认 CLI 命令路径。
