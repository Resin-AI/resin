#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "../dist/bin/cli.js");
// `resin suggest` runs once per shell command an agent is about to run (a harness hook): it loads
// only the lean suggestion module, not the whole CLI.
const suggestTarget = path.resolve(__dirname, "../../gateway/dist/suggest/index.js");

if (process.argv[2] === "suggest" && fs.existsSync(suggestTarget)) {
  const { runSuggestCli } = await import(pathToFileURL(suggestTarget).href);
  process.exitCode = await runSuggestCli(process.argv.slice(3));
} else {
  if (!fs.existsSync(target)) {
    process.stderr.write(
      "Error: resin has not been built yet.\n" +
        "Please run 'pnpm build' in the workspace root before executing this binary.\n",
    );
    process.exit(1);
  }

  const { main } = await import(pathToFileURL(target).href);
  if (main instanceof Function) {
    try {
      const exitCode = await main(process.argv.slice(2));
      if (Number.isInteger(exitCode) && exitCode !== 0) {
        process.exit(exitCode);
      }
    } catch (err) {
      process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }
}
