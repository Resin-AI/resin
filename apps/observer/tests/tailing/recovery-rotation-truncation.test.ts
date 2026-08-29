import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceRecoveryEngine, TranscriptWatcher } from "../../src/tailing/index.js";

describe("Recovery Engine, Rotation, Truncation, and Lineage", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "observer-recovery-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("detects copy-truncate / file truncation and resets cursor with incremented generation", async () => {
    const recovery = new SourceRecoveryEngine();

    // 1. Initial file with 5 lines (size approx 150 bytes)
    const lines = [
      JSON.stringify({ i: 1, msg: "Initial line 1" }),
      JSON.stringify({ i: 2, msg: "Initial line 2" }),
      JSON.stringify({ i: 3, msg: "Initial line 3" }),
      JSON.stringify({ i: 4, msg: "Initial line 4" }),
      JSON.stringify({ i: 5, msg: "Initial line 5" }),
    ];
    fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`);
    const initialStat = fs.statSync(transcriptPath);

    // Initial probe
    const probe1 = await recovery.probe(transcriptPath, initialStat.size, 5);
    expect(probe1.condition).toBe("normal");
    expect(probe1.generation).toBe(0);

    // 2. Truncate file in place to a smaller size (e.g. 1 short line)
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ i: 1, msg: "Reset" })}\n`);
    const truncatedStat = fs.statSync(transcriptPath);
    expect(truncatedStat.size).toBeLessThan(initialStat.size);

    // Probe after truncation with previous offset = initialStat.size
    const probe2 = await recovery.probe(transcriptPath, initialStat.size, 5);
    expect(probe2.condition).toBe("truncated");
    expect(probe2.isActionable).toBe(true);
    expect(probe2.generation).toBe(1);
    expect(probe2.suggestedOffset).toBe(0);
    expect(probe2.suggestedLine).toBe(1);

    // Verify lineage history
    const history = recovery.getLineageHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("truncation");
    expect(history[0].generation).toBe(1);
    expect(history[0].finalOffset).toBe(initialStat.size);
  });

  it("detects file rotation / archival and tracks previous file identity", async () => {
    const recovery = new SourceRecoveryEngine();

    // 1. Create original file
    fs.writeFileSync(transcriptPath, `{"msg":"old log"}\n`);
    const statOld = fs.statSync(transcriptPath);

    const probe1 = await recovery.probe(transcriptPath, statOld.size, 1);
    expect(probe1.condition).toBe("normal");

    // 2. Rotate file: rename transcript.jsonl -> transcript.jsonl.1 and create new transcript.jsonl
    const archivedPath = path.join(tmpDir, "transcript.jsonl.1");
    fs.renameSync(transcriptPath, archivedPath);
    fs.writeFileSync(transcriptPath, `{"msg":"new log"}\n`);

    const probe2 = await recovery.probe(transcriptPath, statOld.size, 1);
    expect(probe2.condition).toBe("archived");
    expect(probe2.isActionable).toBe(true);
    expect(probe2.generation).toBe(1);
    expect(probe2.suggestedOffset).toBe(0);
    expect(probe2.archivePath).toBe(archivedPath);

    const history = recovery.getLineageHistory();
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe("archival");
    expect(history[0].archivePath).toBe(archivedPath);
  });

  it("recovers automatically inside TranscriptWatcher upon file rotation", async () => {
    // Initial file
    fs.writeFileSync(transcriptPath, `{"id":1}\n{"id":2}\n`);

    const watcher = new TranscriptWatcher({
      filePath: transcriptPath,
      pollingIntervalMs: 50,
      coalesceDebounceMs: 5,
    });

    const read1 = await watcher.readNext();
    expect(read1).toHaveLength(2);
    expect(read1[0].parsedJson).toEqual({ id: 1 });
    expect(read1[1].parsedJson).toEqual({ id: 2 });

    // Rotate file
    const archive = path.join(tmpDir, "transcript.jsonl.bak");
    fs.renameSync(transcriptPath, archive);
    fs.writeFileSync(transcriptPath, `{"id":3,"after":"rotation"}\n`);

    let rotationEmitted = false;
    watcher.once("rotation", () => {
      rotationEmitted = true;
    });

    const read2 = await watcher.readNext();
    expect(rotationEmitted).toBe(true);
    expect(read2).toHaveLength(1);
    expect(read2[0].parsedJson).toEqual({ id: 3, after: "rotation" });

    watcher.stop();
  });

  it("retries transient permission errors with exponential backoff", async () => {
    const recovery = new SourceRecoveryEngine();

    let attempts = 0;
    const result = await recovery.withPermissionRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("Permission denied") as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return "success";
      },
      { maxRetries: 4, initialDelayMs: 5, maxDelayMs: 20 },
    );

    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });
});
