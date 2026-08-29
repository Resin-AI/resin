import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

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
  },
});
