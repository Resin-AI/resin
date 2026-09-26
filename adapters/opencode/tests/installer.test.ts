import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  NodeConfigFsBridge,
  UNKNOWN_HARNESS_VERSION,
  applyConfigMutation,
  applyManagedBlock,
  classifyHarnessVersion,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { opencodeHarness, probeOpencodeInstallation } from "../src/index.js";

const fsBridge = new NodeConfigFsBridge();
const RESIN = "/opt/resin/bin/resin";
let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "resin-opencode-home-"));
  env = {};
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function register(targetPath = opencodeHarness.mcpConfig.resolvePath(home, env)) {
  const plan = await opencodeHarness.mcpConfig.planRegistration({
    targetPath,
    workspace: {
      workspaceId: "w",
      rootPath: home,
      name: "w",
      harnessId: "opencode",
      configPath: targetPath,
      metadata: {},
    },
    gatewayUrl: "http://127.0.0.1:9400/mcp",
    command: RESIN,
    args: ["mcp"],
    fsBridge,
  });
  await applyConfigMutation(plan, fsBridge);
  return plan;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("OpenCode MCP registration on a temp HOME", () => {
  it("writes a local `mcp.resin` entry in ~/.config/opencode/opencode.json and verifies it", async () => {
    const target = opencodeHarness.mcpConfig.resolvePath(home, env);
    expect(target).toBe(path.join(home, ".config", "opencode", "opencode.json"));
    await register();
    expect(readJson(target)).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { resin: { type: "local", command: [RESIN, "mcp"], enabled: true } },
    });
    const verify = opencodeHarness.mcpConfig.verifyRegistration!;
    expect(await verify({ targetPath: target, command: RESIN, fsBridge })).toBe(true);
    expect(await verify({ targetPath: target, command: "/other/resin", fsBridge })).toBe(false);
  });

  it("honors XDG_CONFIG_HOME like OpenCode does", () => {
    env = { XDG_CONFIG_HOME: path.join(home, "xdg") };
    expect(opencodeHarness.mcpConfig.resolvePath(home, env)).toBe(
      path.join(home, "xdg", "opencode", "opencode.json"),
    );
    expect(opencodeHarness.guidance!.resolvePath(home, env)).toBe(
      path.join(home, "xdg", "opencode", "AGENTS.md"),
    );
  });

  it("preserves user config and is idempotent", async () => {
    const target = opencodeHarness.mcpConfig.resolvePath(home, env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const user = {
      model: "github-copilot/gpt-4.1",
      mcp: {
        echo: { type: "local", command: ["node", "echo.mjs"] },
        resin: { type: "local", command: ["resin", "mcp"], environment: { A: "1" } },
        resin_gateway: { type: "remote", url: "http://127.0.0.1:9400/mcp/sse" },
      },
    };
    fs.writeFileSync(target, JSON.stringify(user));
    await register();
    const once = fs.readFileSync(target, "utf8");
    expect(JSON.parse(once)).toEqual({
      model: "github-copilot/gpt-4.1",
      mcp: {
        echo: { type: "local", command: ["node", "echo.mjs"] },
        resin: { type: "local", command: [RESIN, "mcp"], environment: { A: "1" }, enabled: true },
      },
    });
    const again = await register();
    expect(again.plannedContent).toBe(once);
    expect(fs.readFileSync(target, "utf8")).toBe(once);
  });

  it("refuses to rewrite a config that is not JSON", async () => {
    const target = opencodeHarness.mcpConfig.resolvePath(home, env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "{ // comment\n}");
    await expect(register()).rejects.toThrow(/Cannot parse OpenCode config/);
    expect(fs.readFileSync(target, "utf8")).toBe("{ // comment\n}");
  });

  it("uninstall removes only Resin entries from every global config file", async () => {
    await register();
    const dir = path.join(home, ".config", "opencode");
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ mcp: { "resin-gateway": { type: "local", command: ["resin-mcp"] } } }),
    );
    const jsonc = '{\n  // user comment\n  "mcp": {}\n}\n';
    fs.writeFileSync(path.join(dir, "opencode.jsonc"), jsonc);
    const remove = opencodeHarness.mcpConfig.removeRegistration!;

    expect(await remove({ home, env, fsBridge, dryRun: true })).toBe(true);
    expect(readJson(path.join(dir, "opencode.json")).mcp).toBeDefined();

    expect(await remove({ home, env, fsBridge })).toBe(true);
    expect(readJson(path.join(dir, "opencode.json"))).toEqual({
      $schema: "https://opencode.ai/config.json",
    });
    expect(readJson(path.join(dir, "config.json"))).toEqual({});
    expect(fs.readFileSync(path.join(dir, "opencode.jsonc"), "utf8")).toBe(jsonc);
    expect(await remove({ home, env, fsBridge })).toBe(false);
    expect(opencodeHarness.mcpConfig.uninstallPaths(home, env)).toEqual(
      ["config.json", "opencode.json", "opencode.jsonc"].map((name) => path.join(dir, name)),
    );
  });

  it("keeps a user's own `resin` server that is not Resin's", async () => {
    const target = opencodeHarness.mcpConfig.resolvePath(home, env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const user = { mcp: { resin: { type: "local", command: ["python", "my_resin_tool.py"] } } };
    fs.writeFileSync(target, JSON.stringify(user));
    expect(await opencodeHarness.mcpConfig.removeRegistration!({ home, env, fsBridge })).toBe(
      false,
    );
    expect(readJson(target)).toEqual(user);
  });

  it("installs and removes the AGENTS.md guidance block idempotently", async () => {
    const guidance = opencodeHarness.guidance!;
    const file = guidance.resolvePath(home, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# My rules\n");
    expect((await applyManagedBlock(fsBridge, file, guidance.markers, guidance.body)).action).toBe(
      "updated",
    );
    expect((await applyManagedBlock(fsBridge, file, guidance.markers, guidance.body)).action).toBe(
      "unchanged",
    );
    expect(fs.readFileSync(file, "utf8")).toContain("`resin_<name>`");
    await applyManagedBlock(fsBridge, file, guidance.markers, null);
    expect(fs.readFileSync(file, "utf8")).toBe("# My rules\n");
  });
});

describe("OpenCode version pinning", () => {
  it("qualifies only the recorded versions", () => {
    expect(classifyHarnessVersion("1.18.32", opencodeHarness.testedVersions)).toBe("tested");
    expect(classifyHarnessVersion("1.1.65", opencodeHarness.testedVersions)).toBe("tested");
    expect(classifyHarnessVersion("1.18.33", opencodeHarness.testedVersions)).toBe("untested");
  });

  it("probes the version from the npm package owning the executable without running it", async () => {
    const pkgDir = path.join(home, "prefix", "lib", "node_modules", "opencode-ai");
    const bin = path.join(home, "prefix", "bin");
    fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "opencode-ai", version: "1.18.32" }),
    );
    // A binary that fails if executed proves the probe read the package metadata instead.
    fs.writeFileSync(path.join(pkgDir, "bin", "opencode.exe"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    fs.symlinkSync(path.join(pkgDir, "bin", "opencode.exe"), path.join(bin, "opencode"));
    const installation = await probeOpencodeInstallation({ home, env: { PATH: bin } });
    expect(installation).toMatchObject({
      version: "1.18.32",
      executablePath: path.join(bin, "opencode"),
      status: "ready",
      metadata: { versionClassification: "tested", store: "none" },
    });

    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "other" }));
    expect(await probeOpencodeInstallation({ home, env: { PATH: bin } })).toMatchObject({
      version: UNKNOWN_HARNESS_VERSION,
      status: "ready",
    });
    expect(await probeOpencodeInstallation({ home, env: { PATH: "" } })).toBeNull();
  });
});
