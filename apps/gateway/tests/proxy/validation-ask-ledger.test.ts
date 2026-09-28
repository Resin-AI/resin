import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileValidationAskLedger } from "../../src/proxy/validation-ask-ledger.js";

function ledger(now: { value: number }, maxChecksPerKeyPerDay = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ask-ledger-"));
  const filePath = path.join(dir, "state", "workflow-validation-asks.jsonl");
  return {
    filePath,
    ledger: new FileValidationAskLedger({ filePath, maxChecksPerKeyPerDay, now: () => now.value }),
  };
}

describe("the validation ask ledger", () => {
  it("bounds how often one recorded call or private reference is checked per day", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks } = ledger(now);
    const ask = (requestId: string, keys: string[]) =>
      asks.admit({ requestId, planDigest: `digest-${requestId}`, keys });
    expect(ask("a", ["call:1"])).toBe(true);
    expect(ask("b", ["call:1", "call:2"])).toBe(true);
    // A third different plan over call 1 is one more bit about it: refused.
    expect(ask("c", ["call:1"])).toBe(false);
    // A private reference is bounded across different recorded calls too.
    expect(ask("e", ["call:3", "reference:private:v2:secret"])).toBe(true);
    expect(ask("f", ["call:4", "reference:private:v2:secret"])).toBe(true);
    expect(ask("g", ["call:5", "reference:private:v2:secret"])).toBe(false);
    // The same ask re-sent after a failed delivery does not count again.
    expect(ask("a", ["call:1"])).toBe(true);
    now.value += 24 * 60 * 60 * 1000;
    expect(ask("c", ["call:1"])).toBe(true);
  });

  it("appends an owner-only audit of what each ask checked", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1", "call:2"] });
    asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:3"] });
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
        keys: ["call:1", "call:2"],
      },
      { at: "2026-09-27T00:00:00.000Z", requestId: "b", planDigest: "d2", keys: ["call:3"] },
    ]);
  });

  it("refuses every ask while the ledger is unreadable or held by another process", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1"] });
    fs.appendFileSync(filePath, "{torn");
    expect(asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:9"] })).toBe(false);
    fs.writeFileSync(filePath, "");
    fs.writeFileSync(`${filePath}.lock`, "");
    expect(asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] })).toBe(false);
    fs.rmSync(`${filePath}.lock`);
    expect(asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] })).toBe(true);
  });
});
