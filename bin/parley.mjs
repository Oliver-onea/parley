#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.mjs";

const MAX_HTTP_HEADER_SIZE = 131072;
const MAX_HTTP_HEADER_SIZE_OPTION = `--max-http-header-size=${MAX_HTTP_HEADER_SIZE}`;
const hasHeaderSizeOption = process.execArgv.some((arg) =>
  /^--max[-_]http[-_]header[-_]size(?:=|$)/.test(arg),
);

if (!hasHeaderSizeOption) {
  const result = spawnSync(
    process.execPath,
    [MAX_HTTP_HEADER_SIZE_OPTION, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error) {
    console.error(result.error?.stack || String(result.error));
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
} else {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
