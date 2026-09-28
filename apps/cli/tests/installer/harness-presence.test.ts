import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { HarnessId } from "@resin/contracts";
import type { HarnessInstallation } from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeHarnessMcpConfigurations } from "../../src/commands/uninstall.js";
import { SUPPORTED_HARNESS_IDS } from "../../src/harness-registry.js";
import {
  HarnessConfigOrchestrator,
  type HarnessProbeOptions,
  resolveHarnessConfigPath,
} from "../../src/installer/harness-config.js";
import { HarnessHealthCoordinator } from "../../src/installer/harness-health.js";
import {
  type HarnessInstallationProbe,
  ReconciliationNodeFsBridge,
} from "../../src/installer/harness-reconciler.js";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "resin-harness-presence-"));
  // Windows harnesses resolve the profile folder from USERPROFILE, never HOME.
  env = { HOME: home, USERPROFILE: home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** Stands in for binary detection: only the listed harnesses have an executable on PATH. */
function binariesOnPath(...present: HarnessId[]): HarnessInstallationProbe {
  return async ({
    harnessId,
    targetPath,
  }: HarnessProbeOptions): Promise<HarnessInstallation | null> =>
    present.includes(harnessId)
      ? {
          harnessId,
          displayName: harnessId,
          version: "test",
          isInstalled: true,
          status: "ready",
          configPath: targetPath,
          detectedAt: "2026-08-28T12:00:00.000Z",
          metadata: {},
        }
      : null;
}

/** Configures harnesses the way `resin init` does: real filesystem bridge, default harness set. */
function initHarnesses(probeHarness: HarnessInstallationProbe) {
  return new HarnessConfigOrchestrator().configureHarnesses({
    customHome: home,
    env,
    workspacePath: home,
    fsBridge: new ReconciliationNodeFsBridge(),
    probeHarness,
  });
}

async function listTree(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).sort();
}

describe("harness presence gating", () => {
  it("writes Resin config only for the harness whose config directory exists", async () => {
    await mkdir(path.join(home, ".codex"));

    const result = await initHarnesses(binariesOnPath());

    expect(result.success).toBe(true);
    expect(
      result.results.filter((entry) => entry.configured).map((entry) => entry.harnessId),
    ).toEqual(["codex-cli"]);
    for (const harnessId of SUPPORTED_HARNESS_IDS) {
      if (harnessId === "codex-cli") continue;
      await expect(readFile(resolveHarnessConfigPath(harnessId, home, env))).rejects.toThrow(
        /ENOENT/,
      );
    }
    const topLevel = (await readdir(home)).sort();
    expect(topLevel).toEqual([".codex"]);
    expect(await readFile(path.join(home, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.resin]",
    );
  });

  it("registers a harness that appears after init on the next repair", async () => {
    await initHarnesses(binariesOnPath());
    const cursorConfig = resolveHarnessConfigPath("cursor-cli", home, env);
    await expect(readFile(cursorConfig)).rejects.toThrow(/ENOENT/);

    await mkdir(path.dirname(cursorConfig), { recursive: true });
    const repair = await new HarnessHealthCoordinator({
      home,
      env,
      workspacePath: home,
      fsBridge: new ReconciliationNodeFsBridge(),
      probeHarness: binariesOnPath(),
      autoRepair: true,
    }).run({ trigger: "repair", force: true, autoRepair: true });

    expect(repair.status).toBe("checked");
    expect(
      repair.snapshot?.harnesses.find((harness) => harness.harnessId === "cursor-cli"),
    ).toMatchObject({ installed: true, configured: true });
    expect(JSON.parse(await readFile(cursorConfig, "utf8")).mcpServers.resin).toBeDefined();
  });
});

describe("uninstall removes only what Resin added", () => {
  it("removes Resin-created files, directories and backups but keeps user content", async () => {
    const codexConfig = path.join(home, ".codex", "config.toml");
    const userToml = 'model = "o3"\n';
    await mkdir(path.dirname(codexConfig));
    await writeFile(codexConfig, userToml);

    const result = await initHarnesses(binariesOnPath("cursor-cli", "grok-build", "codex-cli"));
    expect(result.success).toBe(true);
    expect(await listTree(path.join(home, ".cursor"))).toEqual(
      expect.arrayContaining(["mcp.json", expect.stringMatching(/\.resin-backup\..*\.bak$/)]),
    );

    // The harness itself later adds settings to the file Resin created.
    const grokConfig = resolveHarnessConfigPath("grok-build", home, env);
    const grokWithUserSetting = `${await readFile(grokConfig, "utf8")}\n[ui]\ntheme = "dark"\n`;
    await writeFile(grokConfig, grokWithUserSetting);

    await removeHarnessMcpConfigurations({ customHome: home, env });

    const remaining = await listTree(home);
    expect(remaining.filter((entry) => entry.includes(".resin-backup."))).toEqual([]);
    expect(remaining.some((entry) => entry.startsWith(".cursor"))).toBe(false);
    expect((await readFile(codexConfig, "utf8")).trim()).toBe(userToml.trim());
    const grokAfter = await readFile(grokConfig, "utf8");
    expect(grokAfter).toContain('theme = "dark"');
    expect(grokAfter).not.toContain("resin");
  });
});
