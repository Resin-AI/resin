import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileValidationAskLedger } from "../../src/proxy/validation-ask-ledger.js";

function ledger(now: { value: number }, maxChecksPerCallPerDay = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ask-ledger-"));
  const filePath = path.join(dir, "state", "workflow-validation-asks.jsonl");
  return {
    filePath,
    ledger: new FileValidationAskLedger({ filePath, maxChecksPerCallPerDay, now: () => now.value }),
  };
}

describe("the validation ask ledger", () => {
  it("bounds how often one recorded call is checked per day", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks } = ledger(now);
    const ask = (requestId: string, callIds: string[]) =>
      asks.admit({ requestId, planDigest: `digest-${requestId}`, callIds });
    expect(ask("a", ["call-1"])).toBe(true);
    expect(ask("b", ["call-1", "call-2"])).toBe(true);
    // A third different plan over call-1 is one more bit about it: refused.
    expect(ask("c", ["call-1"])).toBe(false);
    expect(ask("d", ["call-2"])).toBe(true);
    expect(ask("f", ["call-2", "call-3"])).toBe(false);
    expect(ask("e", ["call-3"])).toBe(true);
    // The same ask re-sent after a failed delivery does not count again.
    expect(ask("a", ["call-1"])).toBe(true);
    now.value += 24 * 60 * 60 * 1000;
    expect(ask("c", ["call-1"])).toBe(true);
  });

  it("keeps an owner-only audit of which recorded calls were checked", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    asks.admit({ requestId: "a", planDigest: "d1", callIds: ["call-1", "call-2"] });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const entries = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      {
        at: "2026-09-27T00:00:00.000Z",
        requestId: "a",
        planDigest: "d1",
        callIds: ["call-1", "call-2"],
      },
    ]);
  });
});
