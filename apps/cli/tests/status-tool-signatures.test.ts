import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOL_SIGNATURES_STATE_FILE_NAME as GATEWAY_STATE_FILE_NAME,
  type ToolCertificateCheckRecord,
  ToolSignatureStateStore,
} from "@resin/gateway";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiagnostics } from "../src/commands/doctor.js";
import {
  TOOL_SIGNATURES_STATE_FILE_NAME,
  collectStatus,
  formatStatusForTerminal,
  formatToolSignatureSummary,
  readToolSignaturesStatus,
} from "../src/commands/status.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}): ConfigFsBridge {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async mkdirp(_dirPath: string): Promise<void> {},
    async copyFile(source: string, destination: string): Promise<void> {
      const content = files.get(source);
      if (content !== undefined) files.set(destination, content);
    },
  };
}

const homeDir = path.resolve("/home/testuser");
const stateFile = path.join(homeDir, ".resin", "state", TOOL_SIGNATURES_STATE_FILE_NAME);

function record(
  outcome: ToolCertificateCheckRecord["outcome"],
  index: number,
): ToolCertificateCheckRecord {
  return {
    toolId: `00000000-0000-4000-8000-00000000000${index}`,
    version: "1.0.0",
    artifactDigest: String(index).repeat(64),
    outcome,
    checkedAt: "2026-10-02T10:00:00.000Z",
  };
}

describe("tool signature status (report-only)", () => {
  let tempDir: string;
  let gatewayState: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-tool-signatures-"));
    // The state file exactly as the gateway writes it.
    const store = new ToolSignatureStateStore({
      filePath: path.join(tempDir, GATEWAY_STATE_FILE_NAME),
    });
    expect(
      store.write({
        scopeKey: "scope-a",
        records: [
          record("verified", 1),
          record("verified", 2),
          record("missing-certificate", 3),
          record("invalid-signature", 4),
          record("digest-mismatch", 5),
        ],
        mode: "report-only",
        now: new Date("2026-10-02T10:00:00.000Z"),
      }),
    ).toBe(true);
    gatewayState = fs.readFileSync(path.join(tempDir, GATEWAY_STATE_FILE_NAME), "utf8");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads the summary from the gateway's state file name", async () => {
    expect(TOOL_SIGNATURES_STATE_FILE_NAME).toBe(GATEWAY_STATE_FILE_NAME);
    const status = await readToolSignaturesStatus(
      createMockFsBridge({ [stateFile]: gatewayState }),
      path.dirname(stateFile),
    );
    expect(status).toEqual({
      available: true,
      mode: "report-only",
      verified: 2,
      missing: 1,
      unpinned: 0,
      failed: 2,
      updatedAt: "2026-10-02T10:00:00.000Z",
    });
    expect(formatToolSignatureSummary(status)).toBe(
      "Tool signatures (report-only): 2 verified, 1 missing, 2 failed",
    );
  });

  it("reads a missing or corrupt state file as no checks, never throwing", async () => {
    for (const files of [{}, { [stateFile]: "{not json" }, { [stateFile]: '{"summary":{}}' }]) {
      const status = await readToolSignaturesStatus(
        createMockFsBridge(files),
        path.dirname(stateFile),
      );
      expect(status.available).toBe(false);
      expect(formatToolSignatureSummary(status)).toBe(
        "Tool signatures (report-only): no checks recorded yet",
      );
    }
  });

  it("shows the one-line summary in `resin status`, verbose output and JSON", async () => {
    const summary = await collectStatus({
      home: homeDir,
      fsBridge: createMockFsBridge({ [stateFile]: gatewayState }),
    });
    expect(summary.toolSignatures).toMatchObject({ verified: 2, missing: 1, failed: 2 });
    expect(JSON.parse(JSON.stringify(summary)).toolSignatures.failed).toBe(2);
    expect(formatStatusForTerminal(summary)).toMatch(
      /Signatures\s+2 verified, 1 missing, 2 failed \(report-only\)/,
    );
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "Tool signatures (report-only): 2 verified, 1 missing, 2 failed",
    );
  });

  it("omits the concise row until the gateway has recorded checks", async () => {
    const summary = await collectStatus({ home: homeDir, fsBridge: createMockFsBridge() });
    expect(summary.toolSignatures?.available).toBe(false);
    expect(formatStatusForTerminal(summary)).not.toContain("Signatures");
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "Tool signatures (report-only): no checks recorded yet",
    );
  });

  it("reports failures as a doctor warning, never a failure", async () => {
    const items = await runDiagnostics({
      home: homeDir,
      fsBridge: createMockFsBridge({ [stateFile]: gatewayState }),
    });
    const item = items.find((candidate) => candidate.id === "tool_signatures");
    expect(item).toMatchObject({
      category: "security",
      status: "warn",
      message: "Tool signatures (report-only): 2 verified, 1 missing, 2 failed",
    });
    expect(item?.remediation).toContain("still run");

    const clean = await runDiagnostics({ home: homeDir, fsBridge: createMockFsBridge() });
    expect(clean.find((candidate) => candidate.id === "tool_signatures")?.status).toBe("pass");
  });
});
