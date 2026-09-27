/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded");

/** Each recorded scenario (full, abort, kill) holds its own session tree; all share one root. */
export async function materializeRecordedHomes(
  version: string,
  createHome: () => string,
): Promise<void> {
  const home = createHome();
  const root = path.join(home, ".local", "share", "muse", "sessions");
  for (const scenario of await fs.readdir(path.join(RECORDED, version))) {
    const sessions = path.join(RECORDED, version, scenario, "sessions");
    await fs.cp(sessions, root, { recursive: true });
  }
}
