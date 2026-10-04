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
    // Generous ceilings so loaded CI runners don't fail on the 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ["**/*.test.{ts,js,mjs}"],
    // Tests never send error reports or usage events, including from the child processes they
    // start with a constructed environment (see tools/test/no-telemetry.ts), and never write the
    // real user's ~/.resin (see tools/test/real-home-guard.ts).
    setupFiles: [
      fileURLToPath(new URL("./tools/test/no-telemetry.ts", import.meta.url)),
      fileURLToPath(new URL("./tools/test/real-home-guard.ts", import.meta.url)),
    ],
    env: {
      HOME: testHome,
      USERPROFILE: testHome,
      DO_NOT_TRACK: "1",
    },
  },
});
