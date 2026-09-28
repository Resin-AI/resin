/**
 * A redaction placeholder must never become durable (uploaded, or acknowledged so the transcript
 * is not read again) before the alias that resolves it is on disk: otherwise a crash leaves the
 * cloud holding a placeholder this device can never resolve.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent } from "@resin/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  CloudObservationClient,
  NormalizationPipeline,
  TrajectoryCaptureCoordinator,
} from "../../src/index.js";

const SECRET = "sk-durability-secret-0123456789";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("private alias durability", () => {
  it("persists minted aliases before the batch is uploaded or acknowledged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-alias-durability-"));
    directories.push(root);
    const aliasFile = path.join(root, "private-values", "private-values.json");
    const persistedAliases = () =>
      fs.existsSync(aliasFile)
        ? Object.keys(JSON.parse(fs.readFileSync(aliasFile, "utf8"))).filter((key) =>
            key.startsWith("[REDACTED_"),
          )
        : [];

    const store = new FilePrivateValueStore(root);
    const pipeline = new NormalizationPipeline({
      redactionConfig: { customSecrets: [SECRET], sensitiveEnvVars: [] },
      privateValueStore: store,
    });
    pipeline.registerDecoder(new CodexRecordDecoder());

    const aliasesAtUpload: string[][] = [];
    const client = Object.assign(Object.create(CloudObservationClient.prototype), {
      sendObservationBatch: vi.fn(async (input: { observations: NormalizedSessionEvent[] }) => {
        aliasesAtUpload.push(persistedAliases());
        return { batchId: "batch", acceptedCount: input.observations.length, rejectedCount: 0 };
      }),
    }) as CloudObservationClient;
    const coordinator = new TrajectoryCaptureCoordinator({
      pipeline,
      observationClient: client,
      coalesceDwellMs: 0,
      privateValueStore: store,
    });

    const timestamp = "2026-09-27T12:00:00.000Z";
    const sessionId = "ses_alias_durability";
    const lines = [
      { type: "session_meta", payload: { id: sessionId, cwd: "/work", cli_version: "0.141.0" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Use the key ${SECRET} to deploy.` }],
        },
      },
    ];
    const aliasesAtAck: string[][] = [];
    await coordinator.handleRecords(
      {
        sessionId,
        workspaceId: "ws_alias",
        harnessId: "codex-cli",
        transcriptPath: `/tmp/${sessionId}.jsonl`,
        status: "completed",
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      },
      lines.map((entry, index) => ({
        recordId: `rec_${index + 1}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: index + 1,
        recordType: "transcript_line" as const,
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ...entry }),
        cursor: { offset: index + 1, line: index + 1, sequence: index + 1, timestamp },
        metadata: {},
      })),
      async () => {
        aliasesAtAck.push(persistedAliases());
      },
    );
    coordinator.dispose();

    expect(aliasesAtUpload.length).toBeGreaterThan(0);
    expect(aliasesAtAck).toHaveLength(1);
    for (const seen of [...aliasesAtUpload, ...aliasesAtAck])
      expect(seen.length).toBeGreaterThan(0);
  });
});
