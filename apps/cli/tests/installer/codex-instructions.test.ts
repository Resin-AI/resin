import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  CODEX_GUIDANCE_END_MARKER,
  CODEX_GUIDANCE_START_MARKER,
  applyCodexGuidance,
  resolveCodexAgentsPath,
} from "../../src/installer/codex-instructions.js";

const AGENTS = "/home/dev/.codex/AGENTS.md";

function blockCount(content: string | null): number {
  return content?.split(CODEX_GUIDANCE_START_MARKER).length ?? 1;
}

describe("Codex guidance block", () => {
  it("resolves AGENTS.md under CODEX_HOME, else ~/.codex", () => {
    expect(resolveCodexAgentsPath("/home/dev")).toBe(AGENTS);
    expect(resolveCodexAgentsPath("/home/dev", { CODEX_HOME: "/profiles/codex" })).toBe(
      "/profiles/codex/AGENTS.md",
    );
  });

  it("creates the file when absent and is idempotent", async () => {
    const fs = new InMemoryConfigFsBridge();
    expect(await applyCodexGuidance(AGENTS, fs, { install: true })).toEqual({
      path: AGENTS,
      action: "created",
    });
    const first = await fs.readFile(AGENTS);
    expect(first?.startsWith(CODEX_GUIDANCE_START_MARKER)).toBe(true);
    expect(first).toContain("mcp__resin__");
    expect(first?.trimEnd().endsWith(CODEX_GUIDANCE_END_MARKER)).toBe(true);

    expect((await applyCodexGuidance(AGENTS, fs, { install: true })).action).toBe("unchanged");
    expect(await fs.readFile(AGENTS)).toBe(first);
  });

  it("appends after user content and refreshes a stale block in place", async () => {
    const fs = new InMemoryConfigFsBridge();
    await fs.writeFile(AGENTS, "# Mine\n\nKeep this.\n");
    expect((await applyCodexGuidance(AGENTS, fs, { install: true })).action).toBe("updated");
    const appended = await fs.readFile(AGENTS);
    expect(appended?.startsWith(`# Mine\n\nKeep this.\n\n${CODEX_GUIDANCE_START_MARKER}`)).toBe(
      true,
    );

    await fs.writeFile(
      AGENTS,
      `above\n\n${CODEX_GUIDANCE_START_MARKER}\nold\n${CODEX_GUIDANCE_END_MARKER}\n\nbelow\n`,
    );
    expect((await applyCodexGuidance(AGENTS, fs, { install: true })).action).toBe("updated");
    const refreshed = await fs.readFile(AGENTS);
    expect(refreshed?.startsWith(`above\n\n${CODEX_GUIDANCE_START_MARKER}\n`)).toBe(true);
    expect(refreshed?.endsWith(`${CODEX_GUIDANCE_END_MARKER}\n\nbelow\n`)).toBe(true);
    expect(refreshed).not.toContain("\nold\n");
    expect(blockCount(refreshed)).toBe(2);
  });

  it("removes only the block and keeps user content", async () => {
    const fs = new InMemoryConfigFsBridge();
    await fs.writeFile(AGENTS, "above\n");
    await applyCodexGuidance(AGENTS, fs, { install: true });
    await fs.writeFile(AGENTS, `${await fs.readFile(AGENTS)}\nbelow\n`);

    expect((await applyCodexGuidance(AGENTS, fs, { install: false })).action).toBe("removed");
    expect(await fs.readFile(AGENTS)).toBe("above\n\nbelow\n");
    expect((await applyCodexGuidance(AGENTS, fs, { install: false })).action).toBe("unchanged");
  });

  it("deletes a file that held only the block", async () => {
    const fs = new InMemoryConfigFsBridge();
    await applyCodexGuidance(AGENTS, fs, { install: true });
    expect((await applyCodexGuidance(AGENTS, fs, { install: false })).action).toBe("removed");
    expect(await fs.exists(AGENTS)).toBe(false);
  });

  it("reports without writing in dry-run mode", async () => {
    const fs = new InMemoryConfigFsBridge();
    expect((await applyCodexGuidance(AGENTS, fs, { install: true, dryRun: true })).action).toBe(
      "created",
    );
    expect(await fs.exists(AGENTS)).toBe(false);
  });
});
