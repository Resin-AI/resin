/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const RECORDED = path.join(import.meta.dirname, "fixtures", "recorded");

/** Rollouts are stored flat; discovery wants dated rollout files whose cwd exists. */
export async function materializeRecordedHomes(
  version: string,
  createHome: () => string,
): Promise<void> {
  const home = createHome();
  const project = path.join(home, "project");
  const sessions = path.join(home, ".codex", "sessions", "2026", "09", "26");
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(sessions, { recursive: true });
  for (const name of await fs.readdir(path.join(RECORDED, version))) {
    if (!name.endsWith(".jsonl")) continue;
    const jsonl = (await fs.readFile(path.join(RECORDED, version, name), "utf8")).replaceAll(
      "/workspace/project",
      project,
    );
    const meta = JSON.parse(jsonl.split("\n", 1)[0]!) as { payload?: { id?: string } };
    const id = meta.payload?.id ?? name.replace(/\.jsonl$/, "");
    await fs.writeFile(path.join(sessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), jsonl);
  }
}
