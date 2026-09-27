import type { HarnessDefinition } from "@resin/harness-contracts";
import { ClaudeHarnessAdapter } from "./adapter.js";
import { ClaudeRecordDecoder } from "./decoder.js";
import { claudeCodeInstallHarness } from "./install.js";

export const claudeCodeHarness: HarnessDefinition = {
  ...claudeCodeInstallHarness,
  createAdapter: () => new ClaudeHarnessAdapter(),
  createDecoder: () => new ClaudeRecordDecoder(),
  sessionCapture: "observation-window",
};
