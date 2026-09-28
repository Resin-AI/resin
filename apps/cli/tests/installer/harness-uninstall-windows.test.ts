/**
 * `resin uninstall` removes Resin's guidance blocks from the harness homes the harnesses actually
 * use. On a Windows host started from WSL, interop forwards Linux values such as
 * `CODEX_HOME=/home/dev/.codex`; those must not redirect cleanup to `C:\home\dev\.codex`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CODEX_GUIDANCE_MARKERS } from "@resin/adapter-codex";
import { afterEach, describe, expect, it } from "vitest";
import { removeHarnessMcpConfigurations } from "../../src/commands/uninstall.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function profileWithCodexGuidance(): { home: string; agents: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin uninstall home "));
  tempDirs.push(home);
  const agents = path.join(home, ".codex", "AGENTS.md");
  fs.mkdirSync(path.dirname(agents), { recursive: true });
  fs.writeFileSync(
    agents,
    `${CODEX_GUIDANCE_MARKERS.start}\n# Resin learned tools\n${CODEX_GUIDANCE_MARKERS.end}\n`,
  );
  return { home, agents };
}

describe("harness guidance cleanup", () => {
  it("removes the Codex guidance block from <home>/.codex/AGENTS.md", async () => {
    const { home, agents } = profileWithCodexGuidance();
    const cleaned = await removeHarnessMcpConfigurations({
      customHome: home,
      env: { HOME: home, USERPROFILE: home },
    });
    expect(cleaned).toContain("Codex CLI");
    expect(fs.existsSync(agents)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "ignores a Linux CODEX_HOME leaked from WSL and cleans %USERPROFILE%\\.codex",
    async () => {
      const { home, agents } = profileWithCodexGuidance();
      const cleaned = await removeHarnessMcpConfigurations({
        customHome: home,
        env: {
          USERPROFILE: home,
          CODEX_HOME: "/home/dev/.local/share/codex",
          CLAUDE_CONFIG_DIR: "/home/dev/.claude",
          OMP_HOME: "/home/dev/.omp",
        },
      });
      expect(cleaned).toContain("Codex CLI");
      expect(fs.existsSync(agents)).toBe(false);
    },
  );
});
