import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { OmpHarnessAdapter } from "../src/adapter.js";
import { type ParsedTranscript, inspectTranscriptFile } from "../src/discovery.js";

// The coordinator rescans every 10 s; a long-lived OMP home holds tens of thousands of dormant
// transcripts. Each scan must not re-inspect all of them, yet new and resumed sessions must
// still be found.
describe("OMP discovery scan cost", () => {
  it("re-inspects dormant transcripts only on a full sweep while still finding new and resumed sessions", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-scan-cost-"));
    try {
      const ompHome = path.join(tmpDir, ".omp");
      const wsPath = path.join(tmpDir, "app");
      await fsp.mkdir(wsPath, { recursive: true });
      const sessionsDir = path.join(ompHome, "agent", "sessions", "-app");
      await fsp.mkdir(sessionsDir, { recursive: true });
      const header = (id: string) =>
        `${JSON.stringify({ type: "session", version: 3, id, cwd: wsPath, timestamp: new Date().toISOString() })}\n`;

      const dayAgo = new Date(Date.now() - 86_400_000);
      const dormantPaths: string[] = [];
      for (let i = 0; i < 40; i++) {
        const filePath = path.join(sessionsDir, `dormant-${i}.jsonl`);
        await fsp.writeFile(filePath, header(`dormant-${i}`));
        await fsp.utimes(filePath, dayAgo, dayAgo);
        dormantPaths.push(filePath);
      }
      await fsp.utimes(sessionsDir, dayAgo, dayAgo);

      const inspected: string[] = [];
      const adapter = new OmpHarnessAdapter({
        ompHome,
        cwd: tmpDir,
        inspectTranscript: (filePath, options): Promise<ParsedTranscript | null> => {
          inspected.push(filePath);
          return inspectTranscriptFile(filePath, options);
        },
      });
      const scan = async () => {
        inspected.length = 0;
        await adapter.listWorkspaces();
        return new Set(adapter.catalog?.getAllSessions().map((s) => s.sessionId));
      };
      const dormantInspections = () => inspected.filter((p) => dormantPaths.includes(p)).length;

      // First scan is a full sweep: every transcript is inspected once and none is active.
      expect(await scan()).toEqual(new Set());
      expect(dormantInspections()).toBe(40);

      // A new session file is found on the very next scan without revisiting dormant ones.
      await fsp.writeFile(path.join(sessionsDir, "fresh.jsonl"), header("fresh"));
      expect(await scan()).toEqual(new Set(["fresh"]));
      expect(dormantInspections()).toBe(0);

      // A resumed dormant session is picked up no later than the next full sweep.
      await fsp.appendFile(dormantPaths[7], header("dormant-7"));
      const found: boolean[] = [];
      for (let i = 0; i < 5; i++) found.push((await scan()).has("dormant-7"));
      expect(found.some(Boolean)).toBe(true);
      expect(found.at(-1)).toBe(true);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
