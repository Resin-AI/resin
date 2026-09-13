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

  it("detects workspaces from exact project metadata rather than decoding directory names", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const homeDir = "/home/testuser";
    await fsBridge.mkdirp(`${homeDir}/.claude/projects/-home-user-Projects-demo`);
    await fsBridge.writeFile(
      `${homeDir}/.claude/projects/-home-user-Projects-demo/session.jsonl`,
      '{"type":"user","sessionId":"session","cwd":"/home/user/Projects/demo"}\n',
    );

    const workspaces = await detectClaudeWorkspaces(homeDir, fsBridge);
    const demoWs = workspaces.find((w) => w.workspaceId === "claude-ws--home-user-Projects-demo");

    expect(demoWs).toBeDefined();
    expect(demoWs?.rootPath).toBe("/home/user/Projects/demo");
    expect(demoWs?.name).toBe("demo");
    expect(demoWs?.harnessId).toBe("claude-code");
    expect(demoWs?.metadata?.discoveredFrom).toBe("projectsDir");
  });

  it("preserves Windows drive paths and hyphens from the session index", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const projectDir = "/home/testuser/.claude/projects/C--Users-test-user-demo-app";
    await fsBridge.writeFile(
      `${projectDir}/sessions-index.json`,
      JSON.stringify({ version: 1, originalPath: "C:\\Users\\test-user\\demo-app", entries: [] }),
    );

    const workspaces = await detectClaudeWorkspaces("/home/testuser", fsBridge);

    expect(workspaces.map((workspace) => [workspace.rootPath, workspace.configPath])).toEqual([
      ["C:\\Users\\test-user\\demo-app", "C:\\Users\\test-user\\demo-app\\.claude.json"],
    ]);
  });

  it.each([
    ["missing metadata", '{"type":"user","sessionId":"session"}\n'],
    ["relative cwd", '{"type":"user","sessionId":"session","cwd":"workspace/demo-app"}\n'],
    ["different project", '{"type":"user","sessionId":"session","cwd":"/workspace/other"}\n'],
    ["different session", '{"type":"user","sessionId":"other","cwd":"/workspace/demo-app"}\n'],
    [
      "sidechain cwd",
      '{"type":"user","sessionId":"session","cwd":"/workspace/demo-app","isSidechain":true}\n',
    ],
    [
      "nested tool cwd",
      '{"type":"user","sessionId":"session","message":{"cwd":"/workspace/demo-app"}}\n',
    ],
    [
      "ambiguous matching roots",
      '{"type":"user","sessionId":"session","cwd":"/workspace/demo-app"}\n' +
        '{"type":"assistant","sessionId":"session","cwd":"/workspace/demo/app"}\n',
    ],
  ])("does not invent a root from %s", async (_label, content) => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(
      "/home/testuser/.claude/projects/-workspace-demo-app/session.jsonl",
      content,
    );

    expect(await detectClaudeWorkspaces("/home/testuser", fsBridge)).toEqual([]);
  });

  it("ignores subagent transcripts when resolving the project root", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const projectDir = "/home/testuser/.claude/projects/-workspace-demo-app";
    await fsBridge.writeFile(
      `${projectDir}/session/subagents/agent.jsonl`,
      '{"type":"user","sessionId":"agent","cwd":"/workspace/demo-app"}\n',
    );

    expect(await detectClaudeWorkspaces("/home/testuser", fsBridge)).toEqual([]);
  });

  it("rejects conflicting index and transcript roots that share a lossy encoding", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const projectDir = "/home/testuser/.claude/projects/-workspace-demo-app";
    await fsBridge.writeFile(
      `${projectDir}/sessions-index.json`,
      JSON.stringify({ originalPath: "/workspace/demo-app", entries: [] }),
    );
    await fsBridge.writeFile(
      `${projectDir}/session.jsonl`,
      '{"type":"user","sessionId":"session","cwd":"/workspace/demo/app"}\n',
    );

    expect(await detectClaudeWorkspaces("/home/testuser", fsBridge)).toEqual([]);
  });

  it("uses exact index entry paths when the transcript metadata is not yet complete", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const projectDir = "/home/testuser/.claude/projects/-workspace-demo-app";
    await fsBridge.writeFile(
      `${projectDir}/sessions-index.json`,
      JSON.stringify({ entries: [{ projectPath: "/workspace/demo-app" }] }),
    );
    await fsBridge.writeFile(`${projectDir}/session.jsonl`, '{"type":"user"');

    const workspaces = await detectClaudeWorkspaces("/home/testuser", fsBridge);

    expect(workspaces.map((workspace) => workspace.rootPath)).toEqual(["/workspace/demo-app"]);
  });

  it("keeps project session discovery when the workspace also has a cwd marker", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const cwd = process.cwd();
    const projectDir = `/home/testuser/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;
    await fsBridge.writeFile(`${cwd}/.claude.json`, "{}");
    await fsBridge.writeFile(
      `${projectDir}/sessions-index.json`,
      JSON.stringify({ originalPath: cwd, entries: [] }),
    );

    const workspaces = await detectClaudeWorkspaces("/home/testuser", fsBridge);

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].metadata?.projectDir).toBe(projectDir);
  });
});
