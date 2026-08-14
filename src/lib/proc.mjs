import { pathToFileURL } from "node:url";

// True when the module was invoked directly (node path/to/file.mjs).
export function isMainModule(metaUrl) {
  return metaUrl === pathToFileURL(process.argv[1] || "").href;
}

// Standard CLI wrapper: run the async main, print stack on failure, set exit code.
export function runMain(main) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
