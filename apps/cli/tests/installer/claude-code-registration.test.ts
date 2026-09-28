/**
 * Claude Code registration against a real temporary HOME: `resin init` writes the user-scope stdio
 * entry in `.claude.json` and the guidance block in `~/.claude/CLAUDE.md`, a second run changes
 * nothing, and `resin uninstall` removes both while keeping the user's own content.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CLAUDE_GUIDANCE_MARKERS } from "@resin/adapter-claude-code";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeHarnessMcpConfigurations } from "../../src/commands/uninstall.js";
import {
  HarnessReconciler,
  ReconciliationNodeFsBridge,
} from "../../src/installer/harness-reconciler.js";

describe("Claude Code registration on a temporary HOME", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-claude-home-"));
  });
  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  const reconcile = (env: NodeJS.ProcessEnv) =>
    new HarnessReconciler().reconcile({
      autoRepair: true,
      dryRun: false,
      harnesses: ["claude-code"],
      installedHarnesses: ["claude-code"],
      customHome: home,
      env,
      workspacePath: path.join(home, "project"),
      gatewayUrl: "http://127.0.0.1:9400/mcp",
      fsBridge: new ReconciliationNodeFsBridge(),
      probeHarness: async () => null,
    });

  it("installs idempotently and uninstall removes the entry and the guidance block", async () => {
    const configPath = path.join(home, ".claude.json");
    const guidancePath = path.join(home, ".claude", "CLAUDE.md");
    await fs.writeFile(configPath, JSON.stringify({ numStartups: 3, mcpServers: { other: {} } }));
    await fs.mkdir(path.dirname(guidancePath));
    await fs.writeFile(guidancePath, "# My rules\n");
    const env = { HOME: home };

    const first = await reconcile(env);
    expect(first.results[0]).toMatchObject({
      configured: true,
      changed: true,
      guidance: { path: guidancePath, action: "updated" },
    });
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(config.numStartups).toBe(3);
    expect(config.mcpServers.other).toEqual({});
    expect(config.mcpServers.resin).toEqual({
      command: path.join(home, ".resin", "bin", "resin"),
      args: ["mcp"],
    });
    const guidance = await fs.readFile(guidancePath, "utf8");
    expect(guidance.startsWith(`# My rules\n\n${CLAUDE_GUIDANCE_MARKERS.start}\n`)).toBe(true);
    expect(guidance.endsWith(`${CLAUDE_GUIDANCE_MARKERS.end}\n`)).toBe(true);

    const second = await reconcile(env);
    expect(second.results[0]).toMatchObject({ changed: false, guidance: { action: "unchanged" } });
    expect(await fs.readFile(guidancePath, "utf8")).toBe(guidance);

    expect(await removeHarnessMcpConfigurations({ env })).toContain("Claude Code CLI");
    const cleaned = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(cleaned.mcpServers).toEqual({ other: {} });
    expect(await fs.readFile(guidancePath, "utf8")).toBe("# My rules\n");
  });

  it("follows CLAUDE_CONFIG_DIR and removes the config and guidance Resin created there", async () => {
    const configDir = path.join(home, "profile");
    const env = { HOME: home, CLAUDE_CONFIG_DIR: configDir };

    await reconcile(env);
    const configPath = path.join(configDir, ".claude.json");
    const guidancePath = path.join(configDir, "CLAUDE.md");
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers.resin.args).toEqual([
      "mcp",
    ]);
    expect(await fs.readFile(guidancePath, "utf8")).toContain(CLAUDE_GUIDANCE_MARKERS.start);
    await expect(fs.access(path.join(home, ".claude.json"))).rejects.toThrow();

    await removeHarnessMcpConfigurations({ env });
    await expect(fs.access(guidancePath)).rejects.toThrow();
    await expect(fs.access(configDir)).rejects.toThrow();
  });
});
