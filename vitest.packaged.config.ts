import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import rootConfig from "./vitest.config";

// Suites that install the packed npm bootstrap share one tarball, packed once per run by the
// global setup and handed to them through Vitest's provide/inject. Pass the suites to run as
// file filters; each still performs its own offline install into its own temporary directory.
export default defineConfig({
  ...rootConfig,
  test: {
    ...rootConfig.test,
    globalSetup: [
      fileURLToPath(
        new URL("./apps/cli/tests/support/packed-npm-bootstrap.global-setup.ts", import.meta.url),
      ),
    ],
  },
});
