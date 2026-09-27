import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyConfigMutation,
  applyManagedBlock,
  classifyHarnessVersion,
  defaultFsBridge,
} from "@resin/harness-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MuseSettingsError, renderMuseSettings } from "../src/config-planner.js";
import { museCodeHarness } from "../src/harness.js";

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "resin-muse-home-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe("muse settings.json registration", () => {
  it("creates a settings file muse accepts, with Resin under mcp_servers", () => {
    const rendered = JSON.parse(
      renderMuseSettings({
        currentContent: null,
        targetPath: "settings.json",
        command: "/opt/resin",
        args: ["mcp"],
      }),
    );
    expect(rendered).toEqual({
      schema_version: 1,
      mcp_servers: { resin: { command: "/opt/resin", args: ["mcp"] } },
    });
  });

  it("preserves the user's other settings and servers and is idempotent", () => {
    const current = JSON.stringify({
      schema_version: 1,
      model: "x",
      mcp_servers: { demo: { command: "python3", args: ["server.py"] } },
    });
    const once = renderMuseSettings({
      currentContent: current,
      targetPath: "s",
      command: "/opt/resin",
      args: ["mcp"],
    });
    const twice = renderMuseSettings({
      currentContent: once,
      targetPath: "s",
      command: "/opt/resin",
      args: ["mcp"],
    });
    expect(twice).toBe(once);
    expect(JSON.parse(once)).toEqual({
      schema_version: 1,
      model: "x",
      mcp_servers: {
        demo: { command: "python3", args: ["server.py"] },
        resin: { command: "/opt/resin", args: ["mcp"] },
      },
    });
  });

  it("refuses to overwrite a settings file it cannot parse", () => {
    expect(() => renderMuseSettings({ currentContent: "{not json", targetPath: "s" })).toThrow(
      MuseSettingsError,
    );
  });

  it("honours XDG_CONFIG_HOME for the settings and rules paths", () => {
    const env = { XDG_CONFIG_HOME: "/x/cfg" };
    expect(museCodeHarness.mcpConfig.resolvePath(home, env)).toBe("/x/cfg/muse/settings.json");
    expect(museCodeHarness.guidance?.resolvePath(home, env)).toBe("/x/cfg/muse/AGENTS.md");
    expect(museCodeHarness.mcpConfig.resolvePath(home, {})).toBe(
      path.join(home, ".config/muse/settings.json"),
    );
  });
});

describe("muse machine-wide guidance", () => {
  it("installs and removes the managed block idempotently, keeping the user's rules", async () => {
    const guidance = museCodeHarness.guidance!;
    const rulesPath = guidance.resolvePath(home, {});
    await fs.mkdir(path.dirname(rulesPath), { recursive: true });
    await fs.writeFile(rulesPath, "My own rule.\n");

    const first = await applyManagedBlock(
      defaultFsBridge,
      rulesPath,
      guidance.markers,
      guidance.body,
    );
    const second = await applyManagedBlock(
      defaultFsBridge,
      rulesPath,
      guidance.markers,
      guidance.body,
    );
    expect([first.action, second.action]).toEqual(["updated", "unchanged"]);
    const installed = await fs.readFile(rulesPath, "utf8");
    expect(installed).toContain("My own rule.");
    expect(installed.split(guidance.markers.start)).toHaveLength(2);

    await applyManagedBlock(defaultFsBridge, rulesPath, guidance.markers, null);
    expect(await fs.readFile(rulesPath, "utf8")).toBe("My own rule.\n");
  });

  it("carries no machine, user, or workspace specifics", () => {
    const body = museCodeHarness.guidance!.body;
    expect(body).not.toMatch(/\/(home|Users|tmp|workspace)\//);
    expect(body).not.toContain(os.userInfo().username);
    expect(body).not.toContain(os.hostname());
  });
});

describe("muse version pinning", () => {
  it("classifies only the fixture-qualified version as tested", () => {
    expect(classifyHarnessVersion("1.4.0", museCodeHarness.testedVersions)).toBe("tested");
    expect(classifyHarnessVersion("1.5.0", museCodeHarness.testedVersions)).toBe("untested");
  });

  it("probes the version from the launcher's version file without running muse", async () => {
    const bin = path.join(home, "bin");
    await fs.mkdir(bin, { recursive: true });
    const launcher = path.join(bin, "muse");
    // A launcher that fails if executed proves the probe read the file instead.
    await fs.writeFile(launcher, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await fs.writeFile(path.join(bin, ".muse-version"), "1.4.0-R4161.1\n");
    const installation = await museCodeHarness.probeInstallation({
      targetPath: museCodeHarness.mcpConfig.resolvePath(home, {}),
      home,
      env: { PATH: bin },
      fsBridge: defaultFsBridge,
    });
    expect(installation).toMatchObject({
      version: "1.4.0",
      executablePath: launcher,
      status: "ready",
    });
  });
});

describe("muse registration through the definition", () => {
  it("plans and applies a registration into a temp HOME", async () => {
    const targetPath = museCodeHarness.mcpConfig.resolvePath(home, {});
    const plan = await museCodeHarness.mcpConfig.planRegistration({
      targetPath,
      workspace: {
        workspaceId: "ws",
        rootPath: home,
        name: "ws",
        harnessId: "muse-code",
        configPath: targetPath,
        metadata: {},
      },
      gatewayUrl: "http://127.0.0.1:1",
      command: "/opt/resin",
      args: ["mcp"],
      fsBridge: defaultFsBridge,
    });
    await applyConfigMutation(plan, defaultFsBridge);
    expect(JSON.parse(await fs.readFile(targetPath, "utf8"))).toEqual({
      schema_version: 1,
      mcp_servers: { resin: { command: "/opt/resin", args: ["mcp"] } },
    });
  });
});
