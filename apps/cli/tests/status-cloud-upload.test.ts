import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { CLOUD_UPLOAD_STATUS_FILE_NAME, CloudUploadStatusRecorder } from "@resin/observer";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectStatus,
  formatStatusForTerminal,
  readCloudUploadSummary,
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
const stateFile = path.join(homeDir, ".resin", "state", CLOUD_UPLOAD_STATUS_FILE_NAME);

describe("last cloud upload in status", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** The file the daemon's recorder writes after two accepted batches. */
  function daemonRecord(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-status-upload-"));
    roots.push(root);
    const filePath = path.join(root, CLOUD_UPLOAD_STATUS_FILE_NAME);
    let now = Date.parse("2026-10-04T09:00:00.000Z");
    const recorder = new CloudUploadStatusRecorder({ filePath, now: () => now });
    recorder.recordSuccess(40);
    now = Date.parse("2026-10-04T09:30:00.000Z");
    recorder.recordSuccess(37);
    return fs.readFileSync(filePath, "utf8");
  }

  it("shows the last accepted upload in `resin status`, verbose output and JSON", async () => {
    const summary = await collectStatus({
      home: homeDir,
      fsBridge: createMockFsBridge({ [stateFile]: daemonRecord() }),
    });
    const expected = {
      available: true,
      lastSuccessAt: "2026-10-04T09:30:00.000Z",
      lastBatchObservations: 37,
      totalBatches: 2,
      totalObservations: 77,
      since: "2026-10-04T09:00:00.000Z",
    };
    expect(summary.cloudUpload).toEqual(expected);
    expect(JSON.parse(JSON.stringify(summary)).cloudUpload).toEqual(expected);
    expect(formatStatusForTerminal(summary)).toMatch(
      /Uploads\s+2026-10-04T09:30:00\.000Z \(37 observations\)/,
    );
    const verbose = formatStatusForTerminal(summary, { verbose: true });
    expect(verbose).toContain("Last upload: 2026-10-04T09:30:00.000Z (37 observations)");
    expect(verbose).toContain(
      "Uploaded:   77 observations in 2 batches since 2026-10-04T09:00:00.000Z",
    );
  });

  it("reads a missing or corrupt record as none, never throwing", async () => {
    const stateDir = path.dirname(stateFile);
    for (const files of [{}, { [stateFile]: "{not json" }, { [stateFile]: '{"version":1}' }]) {
      expect(await readCloudUploadSummary(createMockFsBridge(files), stateDir)).toMatchObject({
        available: false,
        lastSuccessAt: null,
      });
    }
    const summary = await collectStatus({ home: homeDir, fsBridge: createMockFsBridge() });
    expect(formatStatusForTerminal(summary)).not.toContain("Uploads");
    expect(formatStatusForTerminal(summary, { verbose: true })).toContain(
      "Last upload: none recorded yet",
    );
  });
});
