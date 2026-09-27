import type { HarnessDefinition } from "@resin/harness-contracts";
import { PiHarnessAdapter } from "./adapter.js";
import { PiRecordDecoder } from "./decoder.js";
import { piInstallHarness } from "./install.js";

export const piHarness: HarnessDefinition = {
  ...piInstallHarness,
  createAdapter: () => new PiHarnessAdapter(),
  createDecoder: () => new PiRecordDecoder(),
  sessionCapture: "file-activity",
};
