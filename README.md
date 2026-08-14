# parley

Local CLI for exporting LLM conversations to Markdown. One command, one
conversation, one clean Markdown file (plus raw JSON, manifests, and public
assets where available).

Supported inputs:

- ChatGPT public share URLs
- DeepSeek public share URLs
- Gemini public share URLs
- Kimi public share URLs
- Claude public share URLs
- Grok public share URLs
- Claude Desktop local-agent sessions
- Claude Desktop HTTP cache conversations

## Disclaimer

Parley is an **unofficial, community-maintained tool** and is not affiliated with,
endorsed by, or sponsored by OpenAI, Google, Anthropic, xAI, DeepSeek, Moonshot,
or any other model provider.

It only requests content that is already publicly visible through a provider's
share URL. Users are responsible for complying with the Terms of Service of each
platform they export from. Do not use parley to scrape non-public data, bypass
authentication, or abuse provider APIs.

## Requirements

- Node.js 22 or newer
- macOS for the Claude Desktop local/cache exporters

No runtime npm dependencies. Dev dependencies (ESLint) are only needed for
`npm run lint`.

## Quick Start

```bash
node bin/parley.mjs <share-url>
```

The provider is inferred from the URL:

```bash
node bin/parley.mjs https://chatgpt.com/share/<share-id>
node bin/parley.mjs https://chat.deepseek.com/share/<share-id>
node bin/parley.mjs https://share.gemini.google/<share-id>
node bin/parley.mjs https://www.kimi.com/share/<share-id>
node bin/parley.mjs https://claude.ai/share/<share-id>
node bin/parley.mjs https://grok.com/share/<share-id>
```

Or link it into your PATH once:

```bash
npm link
parley https://claude.ai/share/<share-id>
```

## Commands

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

Common options:

- `--out-dir <dir>` (`-o`) — export root, default `./exports`
- `--output <file.md>` — exact output file for single-file providers
- `--no-assets` — skip downloading attachments (ChatGPT / Gemini / Grok / Kimi)
- `--out <dir>` — exact output directory for `claude-cache` / `claude-local`

Every command prints a JSON summary (output path, message counts, asset
counts) on success and exits non-zero with a stack trace on failure.

## Project Layout

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

Each provider exports a `export<Name>(options)` function used by the CLI and
tests, and can also be run directly as a standalone script.

## Output Layout

By default exports are written under `./exports` relative to the current
directory:

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

All timestamps in exported Markdown are ISO 8601 UTC, so output is identical
across machines and locales.

## Development

```bash
npm test        # unit + end-to-end tests (node:test, no network)
npm run check   # node --check every source file
npm install     # dev tooling only (ESLint)
npm run lint    # eslint .
```

Conventions: ES modules only, 2-space indent (`.editorconfig`), shared logic
lives in `src/lib/` — providers must not copy helpers from each other.

## Privacy Boundary

The public-share exporters only request the public share URLs and public
assets needed for the export.

The Claude cache exporter reads local HTTP cache files to recover conversation
JSON and cached asset bytes. It does not read cookies, keychain items,
localStorage, or session tokens.

## Attachments

What each platform's public share actually exposes, and what parley does:

- **ChatGPT** — images and files are downloadable through the share page's
  anonymous file endpoint. parley downloads them into `<output>_assets/` and
  inlines them in the Markdown (on by default; `--no-assets` skips). Some
  files are refused by OpenAI (`safety_check_failed`, e.g. pasted-text files);
  those are recorded as failed in the assets manifest.
- **Gemini** — public `googleusercontent` images are downloaded and localized.
  Google Docs/Drive attachment links are exported through Google's export
  endpoints: public ("anyone with the link") documents download anonymously;
  private ones need `GOOGLE_COOKIE` set to a logged-in Google Cookie header
  (copy it from your browser's DevTools on docs.google.com). Failures are
  recorded in the assets manifest with the reason.
- **Grok** — the share API exposes full message chunks; user-uploaded files
  and generated images are downloaded anonymously from `assets.grok.com` and
  inlined. Searched-image cards reference images not present in the share
  payload and are rendered as compact placeholders.
- **Claude** — public shares hide uploaded files entirely ("Files hidden in
  shared chats"); not even the official share page shows them. parley
  annotates each affected message with the hidden file count. To recover
  Claude attachments, use `claude-cache` (local Claude Desktop HTTP cache) or
  `claude-assets --download-assets` with an authenticated `CLAUDE_COOKIE`.
- **DeepSeek** — the share API exposes file metadata (`file_name`,
  `file_size`, `id`, `previewable`) but no download URL; anonymous file
  endpoints return the app shell. parley lists each file's metadata (name,
  size, id) and annotates that the content is not downloadable from public
  shares.
- **Kimi** — the dehydrated share state exposes each `file` block's metadata
  plus a signed `signUrl` that redirects to a public Volcengine object-storage
  URL. parley downloads attachments into `<output>_assets/` and inlines them
  (on by default; `--no-assets` skips). Failures are recorded in the assets
  manifest.

## Known Limits

- Claude public shares may be blocked by Cloudflare when fetched without a
  browser. Use browser-captured raw snapshot JSON with the `claude` provider
  when that happens.
- The `claude-cache` scanner is heuristic: it does not parse the Chromium
  cache framing, only recognizes single-file `download-file` responses (not
  batched ZIP downloads), and GIF extraction can truncate at an interior
  trailer byte.
- `src/browser/claude_web_exporter.js` is kept as a manual browser fallback
  and is not part of the default CLI command path.
