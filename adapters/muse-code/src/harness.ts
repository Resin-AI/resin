import type { HarnessDefinition } from "@resin/harness-contracts";
import { MuseHarnessAdapter } from "./adapter.js";
import { MuseRecordDecoder } from "./decoder.js";
import { museCodeInstallHarness } from "./install.js";

export const museCodeHarness: HarnessDefinition = {
  ...museCodeInstallHarness,
  createAdapter: () => new MuseHarnessAdapter(),
  createDecoder: () => new MuseRecordDecoder(),
  // Resumed muse sessions append to the same log, so any log that changes is captured.
  sessionCapture: "file-activity",
};
