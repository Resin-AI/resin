#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "../dist/cli.js");

if (!fs.existsSync(target)) {
  process.stderr.write(
    "Error: @resin/test-fixtures has not been built yet.\n" +
      "Please run 'pnpm build' in the workspace root before executing this binary.\n",
  );
  process.exit(1);
}

await import(pathToFileURL(target).href);
