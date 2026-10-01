/**
 * How `resin init` registers Resin's MCP server with Claude Code, Codex and OMP on native Windows:
 * no harness there can spawn a shebang shim or a `.cmd` without a shell, so the registration is
 * `node.exe <home>\.resin\bin\resin.mjs mcp`.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { HarnessId } from "@resin/contracts";
import { InMemoryConfigFsBridge, applyConfigMutation } from "@resin/harness-contracts";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import {
  planHarnessRegistration,
  resolveHarnessMcpLaunch,
  resolveInstalledResinMcpCommand,
  verifyHarnessRegistration,
} from "../../src/installer/harness-config.js";

const execFileAsync = promisify(execFile);
const PROFILE = "C:\\Users\\Dev User";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const ENTRY = "C:\\Users\\Dev User\\.resin\\bin\\resin.mjs";
// Config files live on the host running the test (OMP resolves its target with host `path`).
const CONFIG_HOME = process.platform === "win32" ? PROFILE : "/home/Dev User";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("harness MCP launch on native Windows", () => {
  it("registers the installer's stable resin.mjs entry, run by node.exe", () => {
    expect(resolveInstalledResinMcpCommand(PROFILE, "win32")).toBe(ENTRY);
    expect(resolveHarnessMcpLaunch({ command: ENTRY, platform: "win32", nodePath: NODE })).toEqual({
      command: NODE,
      args: [ENTRY, "mcp"],
    });
  });

  it("keeps the POSIX shim launch unchanged", () => {
    const shim = resolveInstalledResinMcpCommand("/home/dev", "linux");
    expect(shim).toBe("/home/dev/.resin/bin/resin");
    expect(resolveHarnessMcpLaunch({ command: shim, platform: "linux" })).toEqual({
      command: shim,
      args: ["mcp"],
    });
  });

  const cases: Array<{
    harnessId: HarnessId;
    targetPath: string;
    read: (content: string) => { command?: unknown; args?: unknown };
  }> = [
    {
      harnessId: "claude-code",
      targetPath: path.join(CONFIG_HOME, ".claude.json"),
      read: (content) => JSON.parse(content).mcpServers.resin,
    },
    {
      harnessId: "codex-cli",
      targetPath: path.join(CONFIG_HOME, ".codex", "config.toml"),
      read: (content) => {
        const doc = parseToml(content);
        const servers = doc.mcp_servers;
        if (servers === null || typeof servers !== "object" || !("resin" in servers)) return {};
        const resin = servers.resin;
        return resin !== null && typeof resin === "object" ? resin : {};
      },
    },
    {
      harnessId: "omp",
      targetPath: path.join(CONFIG_HOME, ".omp", "agent", "mcp.json"),
      read: (content) => JSON.parse(content).mcpServers.resin,
    },
  ];

  it.each(cases)(
    "writes and verifies a shell-free node launch for $harnessId",
    async ({ harnessId, targetPath, read }) => {
      const fsBridge = new InMemoryConfigFsBridge();
      const options = {
        harnessId,
        targetPath,
        workspacePath: path.join(CONFIG_HOME, "source", "app"),
        gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
        command: ENTRY,
        platform: "win32" as const,
        nodePath: NODE,
        fsBridge,
      };
      const plan = await planHarnessRegistration(options);
      expect(read(plan.plannedContent)).toMatchObject({ command: NODE, args: [ENTRY, "mcp"] });

      await applyConfigMutation(plan, fsBridge);
      expect(await verifyHarnessRegistration(options)).toBe(true);
      // A registration for another launch (e.g. the POSIX shim) is drift, not a match.
      expect(await verifyHarnessRegistration({ ...options, platform: "linux" })).toBe(false);
    },
  );

  it.runIf(process.platform === "win32")(
    "the registered launch starts resin.mjs without a shell from a profile path with spaces",
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "resin launch home "));
      tempDirs.push(home);
      const entry = resolveInstalledResinMcpCommand(home);
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
      const launch = resolveHarnessMcpLaunch({ command: entry });
      expect(launch.command).toBe(process.execPath);
      const { stdout } = await execFileAsync(launch.command, [...launch.args], { shell: false });
      expect(JSON.parse(stdout)).toEqual(["mcp"]);
    },
  );
});
