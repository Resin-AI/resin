import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests must never touch the real user store (~/.resin). Point every home-derived
// path at a throwaway directory so fixture tools cannot leak into the daemon state
// that end users see.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "resin-vitest-home-"));

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tools/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.{ts,js,mjs}"],
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
    },
  },
});
