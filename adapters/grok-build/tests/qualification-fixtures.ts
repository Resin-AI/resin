/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded");

/** Sessions were recorded in `/workspace/project`; grok keys its session dirs by encoded cwd. */
export async function materializeRecordedHomes(
  version: string,
  createHome: () => string,
): Promise<void> {
  const home = createHome();
  await fs.cp(
    path.join(RECORDED, version, "sessions"),
    path.join(home, ".grok", "sessions", encodeURIComponent("/workspace/project")),
    { recursive: true },
  );
}
