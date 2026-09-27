import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type HarnessWorkspace,
  applyConfigMutation,
  applyManagedBlock,
  classifyHarnessVersion,
  defaultFsBridge,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copilotHarness } from "../src/harness.js";

const COMMAND = "/opt/resin/bin/resin";
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-installer-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

const workspace = (targetPath: string): HarnessWorkspace => ({
  workspaceId: "ws",
  rootPath: home,
  name: "ws",
  harnessId: "copilot-cli",
  configPath: targetPath,
  mcpConfigPath: targetPath,
  metadata: {},
});

async function register(env: NodeJS.ProcessEnv): Promise<string> {
  const targetPath = copilotHarness.mcpConfig.resolvePath(home, env);
  const plan = await copilotHarness.mcpConfig.planRegistration({
    targetPath,
    workspace: workspace(targetPath),
    gatewayUrl: "http://127.0.0.1:9400/mcp",
    command: COMMAND,
    args: ["mcp"],
    fsBridge: defaultFsBridge,
  });
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await applyConfigMutation(plan, defaultFsBridge);
  return targetPath;
}

describe("Copilot CLI registration on a temporary HOME", () => {
  it("honors COPILOT_HOME as the data root itself", () => {
    expect(copilotHarness.mcpConfig.resolvePath(home, {})).toBe(
      path.join(home, ".copilot", "mcp-config.json"),
    );
    expect(copilotHarness.mcpConfig.resolvePath(home, { COPILOT_HOME: "/data/cp" })).toBe(
      "/data/cp/mcp-config.json",
    );
    expect(copilotHarness.guidance?.resolvePath(home, { COPILOT_HOME: "/data/cp" })).toBe(
      "/data/cp/copilot-instructions.md",
    );
  });

  it("registers Resin next to user servers, idempotently, and removes only Resin", async () => {
    const env = {};
    const targetPath = copilotHarness.mcpConfig.resolvePath(home, env);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const userConfig = {
      mcpServers: {
        github: { type: "http", url: "https://example.test/mcp", tools: ["*"] },
        resin_gateway: { type: "local", command: "resin-mcp", args: [], tools: ["*"] },
      },
    };
    await fs.writeFile(targetPath, `${JSON.stringify(userConfig, null, 2)}\n`);

    await register(env);
    const first = await fs.readFile(targetPath, "utf8");
    expect(JSON.parse(first)).toEqual({
      mcpServers: {
        github: userConfig.mcpServers.github,
        // Legacy alias folded into the canonical entry; its user-owned `tools` field is kept.
        resin: { tools: ["*"], type: "local", command: COMMAND, args: ["mcp"] },
      },
    });
    expect(
      await copilotHarness.mcpConfig.verifyRegistration?.({
        targetPath,
        command: COMMAND,
        fsBridge: defaultFsBridge,
      }),
    ).toBe(true);

    await register(env);
    expect(await fs.readFile(targetPath, "utf8")).toBe(first);

    const removed = await copilotHarness.mcpConfig.removeRegistration?.({
      home,
      env,
      fsBridge: defaultFsBridge,
    });
    expect(removed).toBe(true);
    expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({
      mcpServers: { github: userConfig.mcpServers.github },
    });
    expect(
      await copilotHarness.mcpConfig.removeRegistration?.({ home, env, fsBridge: defaultFsBridge }),
    ).toBe(false);
  });

  it("refuses to rewrite an mcp-config.json Copilot could not parse", async () => {
    const targetPath = copilotHarness.mcpConfig.resolvePath(home, {});
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, "{ not json");
    await expect(register({})).rejects.toThrow(/not valid JSON/);
    expect(await fs.readFile(targetPath, "utf8")).toBe("{ not json");
  });

  it("does not verify an entry that runs a different command or hides tools", async () => {
    const targetPath = copilotHarness.mcpConfig.resolvePath(home, {});
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const check = async (entry: object) => {
      await fs.writeFile(targetPath, JSON.stringify({ mcpServers: { resin: entry } }));
      return copilotHarness.mcpConfig.verifyRegistration?.({
        targetPath,
        command: COMMAND,
        fsBridge: defaultFsBridge,
      });
    };
    expect(await check({ type: "stdio", command: COMMAND, args: ["mcp"] })).toBe(true);
    expect(await check({ type: "local", command: "resin", args: ["mcp"] })).toBe(false);
    expect(await check({ type: "local", command: COMMAND, args: ["mcp"], tools: [] })).toBe(false);
    expect(await check({ type: "http", url: "http://127.0.0.1:9400/mcp" })).toBe(false);
  });

  it("installs and removes the guidance block around the user's own instructions", async () => {
    const guidance = copilotHarness.guidance!;
    const file = guidance.resolvePath(home, {});
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "Always answer in English.\n");

    const install = () => applyManagedBlock(defaultFsBridge, file, guidance.markers, guidance.body);
    expect((await install()).action).toBe("updated");
    const installed = await fs.readFile(file, "utf8");
    expect(
      installed.startsWith("Always answer in English.\n\n<!-- resin:copilot-guidance:start -->"),
    ).toBe(true);
    expect((await install()).action).toBe("unchanged");

    await applyManagedBlock(defaultFsBridge, file, guidance.markers, null);
    expect(await fs.readFile(file, "utf8")).toBe("Always answer in English.\n");
  });

  it("classifies only recorded versions as tested", () => {
    expect(classifyHarnessVersion("1.0.88", copilotHarness.testedVersions)).toBe("tested");
    expect(classifyHarnessVersion("1.0.89", copilotHarness.testedVersions)).toBe("untested");
    expect(classifyHarnessVersion("0.0.0", copilotHarness.testedVersions)).toBe("unknown");
  });
});
