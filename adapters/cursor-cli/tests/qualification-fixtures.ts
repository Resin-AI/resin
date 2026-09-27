/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * the scrubbed hook spool files recorded with cursor-agent `<version>` (see
 * fixtures/recorded/CAPTURE.md) where Resin's capture hook writes them, `~/.resin/capture/cursor-cli/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCursorSpoolDir } from "../src/paths.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "recorded");

export async function materializeRecordedHomes(
  version: string | undefined,
  createHome: () => string,
): Promise<void> {
  if (version === undefined) throw new Error("cursor-cli qualification needs a tested version");
  const home = createHome();
  const spool = resolveCursorSpoolDir(home);
  fs.mkdirSync(spool, { recursive: true });
  const dir = path.join(RECORDED, version);
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    fs.copyFileSync(path.join(dir, file), path.join(spool, file));
  }
}
