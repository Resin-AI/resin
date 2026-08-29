#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "../dist/bin/daemon.js");

if (!fs.existsSync(target)) {
  process.stderr.write(
    "Error: @resin/observer has not been built yet.\n" +
      "Please run 'pnpm build' in the workspace root before executing this binary.\n",
  );
  process.exit(1);
}
// The executable must run even when invoked by a Vitest-owned process.
delete process.env.VITEST;

await import(pathToFileURL(target).href);
