/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { encodePiSessionDirName } from "../src/paths.js";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded");

/** Transcripts are stored flat with a scrubbed cwd and parent path; rebind them to `home`. */
export async function materializeRecordedHomes(
  version: string,
  createHome: () => string,
): Promise<void> {
  const home = createHome();
  const project = path.join(home, "project");
  const dir = path.join(home, ".pi", "agent", "sessions", encodePiSessionDirName(project));
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  for (const name of await fs.readdir(path.join(RECORDED, version))) {
    if (!name.endsWith(".jsonl")) continue;
    const content = (await fs.readFile(path.join(RECORDED, version, name), "utf8"))
      .replaceAll("<pi-session-dir>", dir)
      .replaceAll("/workspace/project", project);
    const header = JSON.parse(content.split("\n", 1)[0]!) as { id: string; timestamp: string };
    const stamp = header.timestamp.replace(/[:.]/g, "-");
    await fs.writeFile(path.join(dir, `${stamp}_${header.id}.jsonl`), content);
  }
}
