import type { HarnessDefinition } from "@resin/harness-contracts";
import { CodexHarnessAdapter } from "./adapter.js";
import { CodexRecordDecoder } from "./decoder.js";
import { codexInstallHarness } from "./install.js";

export const codexHarness: HarnessDefinition = {
  ...codexInstallHarness,
  createAdapter: () => new CodexHarnessAdapter(),
  createDecoder: () => new CodexRecordDecoder(),
  sessionCapture: "observation-window",
};
