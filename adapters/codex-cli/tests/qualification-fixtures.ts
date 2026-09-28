/**
 * Registry qualification convention (apps/observer/tests/harness-qualification.test.ts): places
 * this adapter's recorded fixtures for one tested version (tests/fixtures/recorded/<version>/)
 * into fresh homes from `createHome` exactly where the adapter's default discovery looks, so the observer can qualify
 * them through `createAdapter()`, `createDecoder()` and the real normalization pipeline.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

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
    const jsonl = rebindRecordedProject(
      await fs.readFile(path.join(RECORDED, version, name), "utf8"),
      project,
    );
    const meta = JSON.parse(jsonl.split("\n", 1)[0]!) as { payload?: { id?: string } };
    const id = meta.payload?.id ?? name.replace(/\.jsonl$/, "");
    await fs.writeFile(path.join(sessions, `rollout-2026-09-26T00-00-00-${id}.jsonl`), jsonl);
  }
}

/**
 * Rebinds a rollout recorded in `/workspace/project` to `project`. The placeholder sits inside JSON
 * strings as a path, as a `file://` URL and as a string literal in recorded code-mode JavaScript,
 * so each form is substituted in its own encoding: a Windows path needs a drive-letter URL and its
 * backslashes escaped once per enclosing string syntax.
 */
export function rebindRecordedProject(jsonl: string, project: string): string {
  const inJson = (text: string) => JSON.stringify(text).slice(1, -1);
  return jsonl
    .replaceAll("file:///workspace/project", pathToFileURL(project).href)
    .replaceAll(inJson(JSON.stringify("/workspace/project")), inJson(JSON.stringify(project)))
    .replaceAll("/workspace/project", inJson(project));
}
