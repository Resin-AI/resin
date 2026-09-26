import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  NodeConfigFsBridge,
  applyConfigMutation,
  applyManagedBlock,
} from "@resin/harness-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { readGrokTomlServer, updateGrokTomlServer } from "../src/config-planner.js";
import { grokBuildHarness } from "../src/harness.js";

const fsBridge = new NodeConfigFsBridge();
const temps: string[] = [];

async function tempHome(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resin-grok-home-"));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Runs the definition's registration + guidance install, as `resin init` does, into `home`. */
async function install(home: string, command: string): Promise<void> {
  const env = {};
  const targetPath = grokBuildHarness.mcpConfig.resolvePath(home, env);
  const plan = await grokBuildHarness.mcpConfig.planRegistration({
    targetPath,
    workspace: {
      workspaceId: "ws",
      rootPath: home,
      name: "home",
      harnessId: "grok-build",
      configPath: targetPath,
      metadata: {},
    },
    gatewayUrl: "http://127.0.0.1:9400/mcp",
    command,
    args: ["mcp"],
    fsBridge,
  });
  await applyConfigMutation(plan, fsBridge);
  const guidance = grokBuildHarness.guidance;
  if (!guidance) throw new Error("no guidance surface");
  await applyManagedBlock(fsBridge, guidance.resolvePath(home, env), guidance.markers, guidance.body);
}

describe("Grok config.toml registration", () => {
  it("replaces an existing resin table and its sub-tables, keeping everything else", () => {
    const before = [
      "[cli]",
      'installer = "npm"',
      "",
      "[mcp_servers.resin]",
      'command = "/old/resin"',
      'args = ["serve"]',
      "",
      "[mcp_servers.resin.env]",
      'RESIN_X = "1"',
      "",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const after = updateGrokTomlServer(before, "resin", { command: "/new/resin", args: ["mcp"] });
    expect(after).toBe(
      [
        "[cli]",
        'installer = "npm"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
        "[mcp_servers.resin]",
        'command = "/new/resin"',
        'args = ["mcp"]',
        "",
      ].join("\n"),
    );
    expect(updateGrokTomlServer(after, "resin", { command: "/new/resin", args: ["mcp"] })).toBe(after);
    expect(readGrokTomlServer(after, "resin")).toEqual({ command: "/new/resin", args: ["mcp"] });
    expect(readGrokTomlServer(after, "other")).toEqual({ command: "other" });
    expect(updateGrokTomlServer(after, "resin", null)).toBe(
      '[cli]\ninstaller = "npm"\n\n[mcp_servers.other]\ncommand = "other"\n',
    );
  });

  it("installs into a temp HOME idempotently, honoring GROK_HOME", async () => {
    const home = await tempHome();
    await install(home, "/opt/resin/bin/resin");
    await install(home, "/opt/resin/bin/resin");
    const config = await fs.readFile(path.join(home, ".grok", "config.toml"), "utf8");
    expect(config).toBe('[mcp_servers.resin]\ncommand = "/opt/resin/bin/resin"\nargs = ["mcp"]\n');
    const agents = await fs.readFile(path.join(home, ".grok", "AGENTS.md"), "utf8");
    expect(agents.match(/resin:grok-guidance:start/g)).toHaveLength(1);
    expect(grokBuildHarness.mcpConfig.resolvePath(home, { GROK_HOME: "/elsewhere" })).toBe(
      "/elsewhere/config.toml",
    );
  });

  // The real install; test runners may point HOME elsewhere.
  const grok = path.join(os.userInfo().homedir, ".grok", "bin", "grok");
  it.skipIf(!existsSync(grok))(
    "makes the installed grok load Resin once even when ~/.claude.json also declares it",
    async () => {
      const home = await tempHome();
      const project = path.join(home, "project");
      await fs.mkdir(project);
      await fs.writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({ mcpServers: { resin: { command: "/opt/resin/bin/resin", args: ["mcp"] } } }),
      );
      const inspect = () =>
        JSON.parse(
          execFileSync(grok, ["inspect", "--json"], {
            cwd: project,
            env: { ...process.env, HOME: home, GROK_HOME: path.join(home, ".grok") },
            encoding: "utf8",
          }),
        ) as {
          mcpServers: Array<{ name: string; source: { type: string } }>;
          projectInstructions: Array<{ path: string; scope: string }>;
        };

      const before = inspect().mcpServers.filter((s) => s.name === "resin");
      expect(before.map((s) => s.source.type)).toEqual(["claudeJson"]);

      await install(home, "/opt/resin/bin/resin");
      const after = inspect();
      expect(after.mcpServers.filter((s) => s.name === "resin").map((s) => s.source.type)).toEqual([
        "configToml",
      ]);
      expect(after.projectInstructions).toContainEqual(
        expect.objectContaining({ path: path.join(home, ".grok", "AGENTS.md"), scope: "global" }),
      );
    },
  );
});
