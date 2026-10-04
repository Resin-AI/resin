import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPrivacyProblem } from "@resin/observer";
import { describe, expect, it } from "vitest";
import { FileValidationAskLedger } from "../../src/proxy/validation-ask-ledger.js";

const HOUR = 60 * 60 * 1000;

function ledger(now: { value: number }, maxChecksPerKeyPerDay = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-ask-ledger-"));
  const filePath = path.join(dir, "state", "workflow-validation-asks.jsonl");
  const logs: string[] = [];
  return {
    filePath,
    logs,
    ledger: new FileValidationAskLedger({
      filePath,
      maxChecksPerKeyPerDay,
      now: () => now.value,
      log: (message) => logs.push(message),
    }),
  };
}

function lines(filePath: string): Array<{ requestId: string }> {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("the validation ask ledger", () => {
  it("bounds how often one recorded call or private reference is checked per day", async () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks } = ledger(now);
    const ask = async (requestId: string, keys: string[]) =>
      (await asks.admit({ requestId, planDigest: `digest-${requestId}`, keys })).admitted;
    expect(await ask("a", ["call:1"])).toBe(true);
    expect(await ask("b", ["call:1", "call:2"])).toBe(true);
    // A third different plan over call 1 is one more bit about it: refused.
    expect(await ask("c", ["call:1"])).toBe(false);
    // A private reference is bounded across different recorded calls too.
    expect(await ask("e", ["call:3", "reference:private:v2:secret"])).toBe(true);
    expect(await ask("f", ["call:4", "reference:private:v2:secret"])).toBe(true);
    expect(await ask("g", ["call:5", "reference:private:v2:secret"])).toBe(false);
    // The same ask re-sent after a failed delivery does not count again.
    expect(await ask("a", ["call:1"])).toBe(true);
    now.value += 24 * HOUR;
    expect(await ask("c", ["call:1"])).toBe(true);
  });

  it("says when a key at its limit frees a check: when its oldest counted check ages out", async () => {
    const start = Date.parse("2026-09-27T00:00:00Z");
    const now = { value: start };
    const { ledger: asks } = ledger(now);
    await asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1"] });
    now.value = start + HOUR;
    await asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:1", "call:2"] });
    now.value = start + 2 * HOUR;
    await asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:2"] });
    now.value = start + 3 * HOUR;
    // call:1 frees at a's expiry; call:2 only at b's, which is later: the ask waits for both.
    expect(
      await asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] }),
    ).toEqual({
      admitted: false,
      reason: "limit-reached",
      key: "call:2",
      retryAt: start + HOUR + 24 * HOUR,
    });
    now.value = start + 24 * HOUR + HOUR - 1;
    expect(
      await asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] }),
    ).toEqual(expect.objectContaining({ admitted: false, reason: "limit-reached" }));
    now.value = start + 24 * HOUR + HOUR;
    expect(
      await asks.admit({ requestId: "d", planDigest: "d4", keys: ["call:1", "call:2"] }),
    ).toEqual({ admitted: true });
  });

  it("appends an owner-only audit of what each ask checked", async () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    await asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1", "call:2"] });
    await asks.admit({ requestId: "b", planDigest: "d2", keys: ["call:3"] });
    // Windows keeps the file owner-only through the private directory's DACL, not mode bits.
    if (process.platform === "win32") expect(windowsPrivacyProblem(filePath)).toBeUndefined();
    else expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(lines(filePath)).toEqual([
      {
        at: "2026-09-27T00:00:00.000Z",
        requestId: "a",
        planDigest: "d1",
        keys: ["call:1", "call:2"],
      },
      { at: "2026-09-27T00:00:00.000Z", requestId: "b", planDigest: "d2", keys: ["call:3"] },
    ]);
  });

  it("drops entries older than the daily window when it records a new ask", async () => {
    const start = Date.parse("2026-09-27T00:00:00Z");
    const now = { value: start };
    const { ledger: asks, filePath } = ledger(now, 1);
    for (let index = 0; index < 50; index += 1) {
      now.value = start + index * HOUR;
      expect(
        (await asks.admit({ requestId: `r${index}`, planDigest: "d", keys: [`call:${index}`] }))
          .admitted,
      ).toBe(true);
    }
    // 50 hours of asks leave only the last 24 hours on disk.
    expect(lines(filePath).map((entry) => entry.requestId)).toEqual(
      Array.from({ length: 24 }, (_unused, index) => `r${index + 26}`),
    );
    if (process.platform !== "win32") expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
    // What the window still holds is still counted.
    expect(
      await asks.admit({ requestId: "again", planDigest: "d2", keys: ["call:49"] }),
    ).toMatchObject({ admitted: false, reason: "limit-reached" });
  });

  it("moves an unreadable ledger aside and keeps admitting, keeping the newest few copies", async () => {
    const start = Date.parse("2026-09-27T00:00:00Z");
    const now = { value: start };
    const { ledger: asks, filePath, logs } = ledger(now);
    const dir = path.dirname(filePath);
    for (let round = 0; round < 5; round += 1) {
      now.value = start + round;
      await asks.admit({ requestId: `ok${round}`, planDigest: "d", keys: ["call:1"] });
      fs.appendFileSync(filePath, round % 2 === 0 ? "{torn" : '{"at":"never"}\n');
      expect(
        await asks.admit({ requestId: `next${round}`, planDigest: "d", keys: ["call:9"] }),
      ).toEqual({ admitted: true });
      expect(lines(filePath).map((entry) => entry.requestId)).toEqual([`next${round}`]);
    }
    expect(fs.readFileSync(`${filePath}.corrupt-${start + 4}`, "utf8")).toContain("ok4");
    expect(
      fs
        .readdirSync(dir)
        .filter((name) => name.includes(".corrupt-"))
        .sort(),
    ).toEqual([2, 3, 4].map((round) => `${path.basename(filePath)}.corrupt-${start + round}`));
    expect(logs).toHaveLength(5);
    expect(logs[0]).toContain("unreadable line");
  });

  it("waits for a lock another process holds without blocking the event loop", async () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(`${filePath}.lock`, "");
    let settled = false;
    const pending = asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] });
    void pending.then(() => {
      settled = true;
    });
    // Control comes back while the lock is held; the holder lets go and the waiter takes it.
    const { promise: turn, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await turn;
    expect(settled).toBe(false);
    fs.rmSync(`${filePath}.lock`);
    expect(await pending).toEqual({ admitted: true });
  });

  it("refuses an ask while another process keeps holding the ledger", async () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(`${filePath}.lock`, "");
    expect(await asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] })).toEqual({
      admitted: false,
      reason: "ledger-unavailable",
    });
    fs.rmSync(`${filePath}.lock`);
    expect(
      (await asks.admit({ requestId: "c", planDigest: "d3", keys: ["call:9"] })).admitted,
    ).toBe(true);
  });

  it("breaks a lock its holder left behind, moving it aside rather than deleting in place", async () => {
    const now = { value: Date.parse("2026-09-27T00:00:00Z") };
    const { ledger: asks, filePath } = ledger(now);
    const lock = `${filePath}.lock`;
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, "");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);
    expect(
      (await asks.admit({ requestId: "a", planDigest: "d1", keys: ["call:1"] })).admitted,
    ).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(path.dirname(lock)).filter((name) => name.includes(".stale."))).toEqual(
      [],
    );
  });
});
