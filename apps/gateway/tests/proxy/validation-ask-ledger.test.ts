import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPrivacyProblem } from "@resin/observer";
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
      asks.admit({ requestId, planDigest: `digest-${requestId}`, keys }).admitted;
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

  it("says when a key at its limit frees a check: when its oldest counted check ages out", () => {
    const start = Date.parse("2026-09-27T00:00:00Z");
    const hour = 60 * 60 * 1000;
    const now = { value: start };
    const { ledger: asks } = ledger(now);
    asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1"] });
    now.value = start + hour;
    asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:1", "call:2"] });
    now.value = start + 2 * hour;
    asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:2"] });
    now.value = start + 3 * hour;
    // call:1 frees at a's expiry; call:2 only at b's, which is later: the ask waits for both.
    expect(asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] })).toEqual({
      admitted: false,
      reason: "limit-reached",
      key: "call:2",
      retryAt: start + hour + 24 * hour,
    });
    now.value = start + 24 * hour + hour - 1;
    expect(asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] })).toEqual(
      expect.objectContaining({ admitted: false, reason: "limit-reached" }),
    );
    now.value = start + 24 * hour + hour;
    expect(asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] })).toEqual({
      admitted: true,
    });
  });

  it("appends an owner-only audit of what each ask checked", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1", "call:2"] });
    asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:3"] });
    // Windows keeps the file owner-only through the private directory's DACL, not mode bits.
    if (process.platform === "win32") expect(windowsPrivacyProblem(filePath)).toBeUndefined();
    else expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
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
    expect(asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:9"] })).toEqual({
      admitted: false,
      reason: "ledger-unavailable",
    });
    fs.writeFileSync(filePath, "");
    fs.writeFileSync(`${filePath}.lock`, "");
    expect(asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] })).toEqual({
      admitted: false,
      reason: "ledger-unavailable",
    });
    fs.rmSync(`${filePath}.lock`);
    expect(asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] }).admitted).toBe(true);
  });

  it("breaks a lock its holder left behind, moving it aside rather than deleting in place", () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    const lock = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);
    expect(asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1"] }).admitted).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.includes(".stale."))).toEqual(
      [],
    );
  });
});
