import * as os from "node:os";
import type { HarnessDefinition } from "@resin/harness-contracts";
import { OpencodeHarnessAdapter } from "./adapter.js";
import { OpencodeRecordDecoder } from "./decoder.js";
import { readOpencodeMcpServers, resolveOpencodeMcpServer } from "./discovery.js";
import { opencodeInstallHarness } from "./install.js";

export const opencodeHarness: HarnessDefinition = {
  ...opencodeInstallHarness,
  createAdapter: () => new OpencodeHarnessAdapter(),
  // Server keys are read when the decoder is created so `<server>_<tool>` calls are attributed.
  createDecoder: () =>
    new OpencodeRecordDecoder({
      mcpServers: Object.keys(readOpencodeMcpServers({ home: os.homedir(), env: process.env })),
    }),
  sessionCapture: "file-activity",
  resolveMcpServer: (name, workspaceRoot) =>
    resolveOpencodeMcpServer(name, workspaceRoot, os.homedir(), process.env),
};
