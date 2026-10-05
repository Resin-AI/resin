import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_PENDING_MAX_AGE_MS,
  AuthPendingRetentionModule,
  sweepExpiredAuthPending,
} from "../src/auth-pending-retention-module.js";
import { BoundedRecordQueue } from "../src/tailing/queue.js";

const DAY = 24 * 60 * 60 * 1000;

let root: string;
let directory: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "auth-pending-retention-"));
  directory = path.join(root, "auth-pending");
  fs.mkdirSync(directory);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function pendingName(sessionId: string): string {
  return `${createHash("sha256").update(sessionId).digest("hex")}.json`;
}

function writeAged(filePath: string, ageMs: number, content = "{}"): void {
  fs.writeFileSync(filePath, content);
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, at, at);
}

function pendingRecordFile(sessionId: string): string {
  const timestamp = new Date().toISOString();
  return JSON.stringify({
    version: 1,
    sessionId,
    records: [
      {
        recordId: "record_1",
        sessionId,
        harnessId: "omp",
        sequenceNumber: 1,
        timestamp,
        recordType: "prompt",
        rawPayload: {},
        cursor: { offset: 1, line: 1, sequence: 1, timestamp },
        metadata: {},
      },
    ],
  });
}

describe("auth-pending retention", () => {
  it("expires only orphaned queue files older than 14 days", async () => {
    const expired = path.join(directory, pendingName("orphan"));
    const fresh = path.join(directory, pendingName("recent"));
    const expiredTemp = path.join(
      directory,
      `${pendingName("crashed")}.4242.0b5e7d3c-1c2f-4a7e-9a55-0e6f6f1f2a3b.tmp`,
    );
    const unrelated = path.join(directory, "notes.json");
    const outside = path.join(root, "outside.json");
    const link = path.join(directory, pendingName("linked"));
    const nestedDirectory = path.join(directory, pendingName("directory"));
    writeAged(expired, AUTH_PENDING_MAX_AGE_MS + DAY);
    writeAged(fresh, AUTH_PENDING_MAX_AGE_MS - DAY);
    writeAged(expiredTemp, AUTH_PENDING_MAX_AGE_MS + DAY);
    writeAged(unrelated, AUTH_PENDING_MAX_AGE_MS + DAY);
    writeAged(outside, AUTH_PENDING_MAX_AGE_MS + DAY);
    fs.symlinkSync(outside, link);
    const old = new Date(Date.now() - AUTH_PENDING_MAX_AGE_MS - DAY);
    fs.lutimesSync(link, old, old);
    fs.mkdirSync(nestedDirectory);
    fs.utimesSync(nestedDirectory, old, old);

    const result = await sweepExpiredAuthPending({ directory });

    expect(result).toEqual({ scanned: 5, deleted: 2 });
    expect(fs.existsSync(expired)).toBe(false);
    expect(fs.existsSync(expiredTemp)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.statSync(nestedDirectory).isDirectory()).toBe(true);
  });

  it("keeps the file of a session that re-attached, however old its deferred batch", async () => {
    const sessionId = "reattached-session";
    const filePath = path.join(directory, pendingName(sessionId));
    writeAged(filePath, AUTH_PENDING_MAX_AGE_MS + DAY, pendingRecordFile(sessionId));

    const queue = new BoundedRecordQueue({ sessionId, authPendingFilePath: filePath });
    expect(queue.hasDurablePending).toBe(true);

    expect(await sweepExpiredAuthPending({ directory })).toEqual({ scanned: 1, deleted: 0 });
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("tolerates a missing directory and logs counts only", async () => {
    expect(await sweepExpiredAuthPending({ directory: path.join(root, "absent") })).toEqual({
      scanned: 0,
      deleted: 0,
    });

    const expired = path.join(directory, pendingName("orphan"));
    writeAged(expired, AUTH_PENDING_MAX_AGE_MS + DAY);
    const infos: unknown[][] = [];
    const module = new AuthPendingRetentionModule({
      directory,
      logger: {
        debug: () => undefined,
        info: (...args: unknown[]) => infos.push(args),
        warn: () => undefined,
        error: () => undefined,
      },
    });
    expect(await module.runOnce()).toEqual({ scanned: 1, deleted: 1 });
    expect(infos).toEqual([
      ["Expired orphaned auth-pending observation files", { scanned: 1, deleted: 1 }],
    ]);
  });
});
