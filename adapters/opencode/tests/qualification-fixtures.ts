/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { rebuildSqliteStore } from "./helpers.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded");

/** 1.1.x recorded file storage; later versions recorded a SQLite export, rebuilt here. */
export async function materializeRecordedHomes(
  version: string,
  createHome: () => string,
): Promise<void> {
  const dataDir = (home: string) => path.join(home, ".local", "share", "opencode");
  const dir = path.join(RECORDED, version);
  const entries = await fs.readdir(dir);
  if (entries.includes("storage")) {
    await fs.cp(path.join(dir, "storage"), path.join(dataDir(createHome()), "storage"), {
      recursive: true,
    });
    return;
  }
  // Each export is a whole database, so each gets its own home.
  for (const name of entries.filter((entry) => entry.endsWith("-db.jsonl"))) {
    const data = dataDir(createHome());
    await fs.mkdir(data, { recursive: true });
    rebuildSqliteStore(path.join(data, "opencode.db"), path.join(dir, name));
  }
}
