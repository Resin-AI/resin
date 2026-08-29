import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  detectClaudeWorkspaces,
  detectPlatform,
  isSupportedClaudeVersion,
  probeClaudeInstallation,
  resolveClaudeConfigFileCandidates,
  resolveClaudeExecutableCandidates,
  resolveClaudeHomeCandidates,
} from "../src/discovery.js";

describe("Claude Code Discovery & Installation Probing", () => {
  it("evaluates supported semver versions correctly", () => {
    expect(isSupportedClaudeVersion("0.1.0")).toBe(true);
    expect(isSupportedClaudeVersion("0.2.14")).toBe(true);
    expect(isSupportedClaudeVersion("1.0.0")).toBe(true);
    expect(isSupportedClaudeVersion("2.1.0-alpha.1")).toBe(true);
    expect(isSupportedClaudeVersion("0.0.9")).toBe(false);
    expect(isSupportedClaudeVersion("invalid")).toBe(false);
  });

  it("resolves platform candidates for Linux, macOS, WSL", () => {
    const linuxHomes = resolveClaudeHomeCandidates("linux", "/home/testuser");
    expect(linuxHomes).toContain("/home/testuser/.claude");

    const darwinHomes = resolveClaudeHomeCandidates("darwin", "/Users/testuser");
    expect(darwinHomes).toContain("/Users/testuser/Library/Application Support/Claude");
    expect(darwinHomes).toContain("/Users/testuser/.claude");

    const wslHomes = resolveClaudeHomeCandidates("wsl", "/home/testuser");
    expect(wslHomes).toContain("/home/testuser/.claude");

    const configFiles = resolveClaudeConfigFileCandidates("/home/testuser", "linux");
    expect(configFiles).toContain("/home/testuser/.claude.json");
    expect(configFiles).toContain("/home/testuser/.claude/claude.json");
    expect(configFiles).toContain("/home/testuser/.claude/mcp_settings.json");

    const execCandidates = resolveClaudeExecutableCandidates("/home/testuser", "linux");
    expect(execCandidates).toContain("/usr/local/bin/claude");
    expect(execCandidates).toContain("claude");
  });

  it("probes installation successfully with mock executable and config", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile("/home/test/.claude/claude.json", JSON.stringify({ mcpServers: {} }));

    const mockExec = async (file: string, args: string[]) => {
      if (file.includes("claude") && args.includes("--version")) {
        return { stdout: "claude 0.2.14\n", stderr: "" };
      }
      throw new Error(`Command not found: ${file}`);
    };

    const installation = await probeClaudeInstallation(
      {
        customExecutablePath: "/usr/local/bin/claude",
        customConfigPath: "/home/test/.claude/claude.json",
        checkPermissions: true,
      },
      fsBridge,
      mockExec,
    );

    expect(installation.harnessId).toBe("claude-code");
    expect(installation.displayName).toBe("Claude Code");
    expect(installation.version).toBe("0.2.14");
    expect(installation.isInstalled).toBe(true);
    expect(installation.status).toBe("ready");
    expect(installation.executablePath).toBe("/usr/local/bin/claude");
    expect(installation.configPath).toBe("/home/test/.claude/claude.json");
  });

  it("detects unsupported version status", async () => {
    const fsBridge = new InMemoryConfigFsBridge();

    const mockExec = async () => ({ stdout: "claude 0.0.8\n", stderr: "" });

    const installation = await probeClaudeInstallation(
      {
        customExecutablePath: "/usr/local/bin/claude",
        customConfigPath: "/home/test/.claude/claude.json",
      },
      fsBridge,
      mockExec,
    );

    expect(installation.isInstalled).toBe(true);
    expect(installation.status).toBe("unsupported_version");
    expect(installation.version).toBe("0.0.8");
  });

  it("fails closed when an executable cannot report a parseable version", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const mockExec = async () => ({ stdout: "Claude Code development build\n", stderr: "" });

    const installation = await probeClaudeInstallation(
      {
        customExecutablePath: "/usr/local/bin/claude",
        customConfigPath: "/home/test/.claude/claude.json",
      },
      fsBridge,
      mockExec,
    );

    expect(installation.isInstalled).toBe(false);
    expect(installation.status).toBe("corrupt");
    expect(installation.version).toBe("0.0.0");
  });

  it("reports missing_executable when executable is not found", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const mockExec = async () => {
      throw new Error("spawn claude ENOENT");
    };

    const installation = await probeClaudeInstallation(undefined, fsBridge, mockExec);

    expect(installation.isInstalled).toBe(false);
    expect(installation.status).toBe("missing_executable");
  });

  it("reports config_error when config JSON is corrupt and checkPermissions is true", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile("/home/test/.claude/claude.json", "{ invalid_json ]");

    const mockExec = async () => ({ stdout: "claude 0.2.0\n", stderr: "" });

    const installation = await probeClaudeInstallation(
      {
        customExecutablePath: "/usr/local/bin/claude",
        customConfigPath: "/home/test/.claude/claude.json",
        checkPermissions: true,
      },
      fsBridge,
      mockExec,
    );

    expect(installation.isInstalled).toBe(true);
    expect(installation.status).toBe("config_error");
  });

  it("detects workspaces from filesystem markers", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const cwd = process.cwd();
    await fsBridge.writeFile(`${cwd}/.claude.json`, "{}");

    const workspaces = await detectClaudeWorkspaces(undefined, fsBridge);
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    const current = workspaces.find((w) => w.rootPath === cwd);
    expect(current).toBeDefined();
    expect(current?.harnessId).toBe("claude-code");
  });

  it("detects workspaces from ~/.claude/projects project directories and decodes paths", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const homeDir = "/home/testuser";
    await fsBridge.mkdirp(`${homeDir}/.claude/projects/-home-user-Projects-demo`);
    await fsBridge.writeFile(
      `${homeDir}/.claude/projects/-home-user-Projects-demo/session.jsonl`,
      '{"type":"session_start","sessionId":"session-001"}\n',
    );

    const workspaces = await detectClaudeWorkspaces(homeDir, fsBridge);
    const demoWs = workspaces.find((w) => w.workspaceId === "claude-ws--home-user-Projects-demo");

    expect(demoWs).toBeDefined();
    expect(demoWs?.rootPath).toBe("/home/user/Projects/demo");
    expect(demoWs?.name).toBe("demo");
    expect(demoWs?.harnessId).toBe("claude-code");
    expect(demoWs?.metadata?.discoveredFrom).toBe("projectsDir");
  });
});
