import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import process from "node:process";
import { applyOmpCatalogInstructions } from "@resin/adapter-omp";
import { describe, expect, it, vi } from "vitest";
import { logoutCommand, parseLogoutFlags } from "../src/commands/logout.js";
import {
  parseUninstallFlags,
  removeHarnessMcpConfigurations,
  uninstallCommand,
} from "../src/commands/uninstall.js";
import type { ServiceUninstallResult, UserServiceManager } from "../src/service/manager.js";

function createMockFsBridge(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  return {
    files,
    async readFile(filePath: string): Promise<string | null> {
      return files.get(filePath) ?? null;
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      files.set(filePath, content);
    },
    async exists(filePath: string): Promise<boolean> {
      return files.has(filePath);
    },
    async mkdirp(dirPath: string): Promise<void> {
      files.set(dirPath, "dir");
    },
    async copyFile(src: string, dest: string): Promise<void> {
      const c = files.get(src);
      if (c !== undefined) files.set(dest, c);
    },
    async unlink(filePath: string): Promise<void> {
      files.delete(filePath);
    },
    async chmod(_filePath: string, _mode: number): Promise<void> {},
  };
}

/** A service manager whose uninstall succeeds, for tests about harness and file cleanup. */
function removedServiceStub(): UserServiceManager {
  return {
    name: "stub",
    platform: "systemd",
    install: vi.fn(),
    uninstall: vi.fn().mockResolvedValue({
      success: true,
      unitPath: "",
      stopped: true,
      disabled: true,
      removed: true,
    }),
    start: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    status: vi.fn(),
    isInstalled: vi.fn().mockResolvedValue(false),
    getUnitDefinition: () => "",
    getUnitPath: () => "",
  };
}

describe("logout command", () => {
  const homeDir = "/home/testuser";
  const tokenFilePath = path.join(homeDir, ".resin", "state", "device-token.json");

  it("parses logout flags correctly", () => {
    const flags = parseLogoutFlags(["--all", "-f", "--json", "--home", homeDir]);
    expect(flags.all).toBe(true);
    expect(flags.force).toBe(true);
    expect(flags.json).toBe(true);
    expect(flags.home).toBe(homeDir);
  });

  it("revokes token and purges credentials while preserving data", async () => {
    const mockTokenData = {
      accessToken: "atk_revoke_test",
      refreshToken: "rtk_revoke_test",
      claims: {
        accountId: "acc_1",
        deviceId: "dev_1",
        installationId: "inst_1",
        workspaceId: "ws_1",
        scopes: ["device:connect"],
        rawUploadConsent: false,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        tokenType: "access",
      },
      deviceId: "dev_1",
      workspaceId: "ws_1",
      storedAt: new Date().toISOString(),
    };

    const mockFetch = vi.fn().mockResolvedValue(Response.json({ success: true }));

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await logoutCommand(["--json", "--home", homeDir], {
        // SAFETY: Mock fetch matching fetch interface for testing.
        customFetch: mockFetch as typeof fetch,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.success).toBe(true);
    } finally {
      process.stdout.write = originalStdout;
    }
  });
});

describe("uninstall command & harness cleanup", () => {
  // Drive-qualified on Windows: uninstall resolves every harness path it touches.
  const homeDir = path.resolve("/home/testuser");
  const profilesDir = path.resolve("/profiles");
  const resinHome = path.join(homeDir, ".resin");
  const claudePath = path.join(homeDir, ".claude.json");
  const codexPath = path.join(homeDir, ".codex", "config.toml");
  const ompPath = path.join(homeDir, ".omp", "config.json");

  it("parses uninstall command flags", () => {
    const flags = parseUninstallFlags([
      "--purge-data",
      "--purge-secrets",
      "--purge-all",
      "--dry-run",
      "-y",
      "--json",
    ]);
    expect(flags.purgeData).toBe(true);
    expect(flags.purgeSecrets).toBe(true);
    expect(flags.purgeAll).toBe(true);
    expect(flags.dryRun).toBe(true);
    expect(flags.nonInteractive).toBe(true);
    expect(flags.json).toBe(true);
  });

  it("removes Resin MCP configuration from all detected harnesses", async () => {
    const initialClaude = JSON.stringify({
      mcpServers: {
        resin: { url: "http://localhost:9400" },
        "other-tool": { command: "node", args: ["server.js"] },
      },
    });
    const initialCodex = `[mcp_servers.other]
url = "http://localhost:8000"

[mcp_servers.resin]
url = "http://localhost:9400"
`;
    const initialOmp = JSON.stringify({
      mcpServers: {
        resin: { url: "http://localhost:9400" },
      },
    });

    const fsBridge = createMockFsBridge({
      [claudePath]: initialClaude,
      [codexPath]: initialCodex,
      [ompPath]: initialOmp,
    });

    const cleaned = await removeHarnessMcpConfigurations({
      customHome: homeDir,
      fsBridge,
    });

    expect(cleaned).toContain("Claude Code CLI");
    expect(cleaned).toContain("Codex CLI");
    expect(cleaned).toContain("Oh My Pi (OMP)");

    // Verify Claude config has resin removed but other-tool preserved
    const updatedClaude = JSON.parse((await fsBridge.readFile(claudePath))!);
    expect(updatedClaude.mcpServers.resin).toBeUndefined();
    expect(updatedClaude.mcpServers["other-tool"]).toBeDefined();

    // Verify Codex config has section removed but other preserved
    const updatedCodex = await fsBridge.readFile(codexPath);
    expect(updatedCodex).not.toContain("[mcp_servers.resin]");
    expect(updatedCodex).toContain("[mcp_servers.other]");

    // Verify OMP config has resin removed
    const updatedOmp = JSON.parse((await fsBridge.readFile(ompPath))!);
    expect(updatedOmp.mcpServers.resin).toBeUndefined();
  });

  it("cleans environment-specific harness homes and the prior Claude path", async () => {
    const activeClaudePath = path.join(profilesDir, "claude", ".claude.json");
    const priorClaudePath = path.join(homeDir, ".claude", "claude.json");
    const activeCodexPath = path.join(profilesDir, "codex", "config.toml");
    const activeOmpPath = path.join(profilesDir, "omp", "agent", "mcp.json");
    const resinJson = JSON.stringify({
      mcpServers: { resin: { command: "resin", args: ["mcp"] } },
    });
    const fsBridge = createMockFsBridge({
      [activeClaudePath]: resinJson,
      [priorClaudePath]: resinJson,
      [activeCodexPath]: '[mcp_servers.resin]\ncommand = "resin"\nargs = ["mcp"]\n',
      [activeOmpPath]: resinJson,
    });

    const cleaned = await removeHarnessMcpConfigurations({
      env: {
        HOME: homeDir,
        // Windows resolves the user home from USERPROFILE, not HOME.
        USERPROFILE: homeDir,
        CLAUDE_CONFIG_DIR: path.join(profilesDir, "claude"),
        CODEX_HOME: path.join(profilesDir, "codex"),
        OMP_HOME: path.join(profilesDir, "omp"),
      },
      fsBridge,
    });

    expect(cleaned).toEqual(["Claude Code CLI", "Codex CLI", "Oh My Pi (OMP)"]);
    for (const configPath of [activeClaudePath, priorClaudePath, activeOmpPath]) {
      expect(await fsBridge.readFile(configPath)).not.toContain('"resin"');
    }
    expect(await fsBridge.readFile(activeCodexPath)).not.toContain("[mcp_servers.resin]");
  });

  it("removes the Resin guidance block from Codex AGENTS.md and keeps user content", async () => {
    const agentsPath = path.join(profilesDir, "codex", "AGENTS.md");
    const fsBridge = createMockFsBridge({
      [agentsPath]:
        "# Mine\n\n<!-- resin:codex-guidance:start -->\nguidance\n<!-- resin:codex-guidance:end -->\n",
    });

    const cleaned = await removeHarnessMcpConfigurations({
      env: { HOME: homeDir, CODEX_HOME: path.join(profilesDir, "codex") },
      fsBridge,
    });

    expect(cleaned).toEqual(["Codex CLI"]);
    expect(await fsBridge.readFile(agentsPath)).toBe("# Mine\n");
  });

  it("removes legacy aliases only when recognizably Resin-owned, preserving unrecognized same-named entries", async () => {
    const claudePath = path.join(homeDir, ".claude.json");
    const codexPath = path.join(homeDir, ".codex", "config.toml");
    const ompPath = path.join(homeDir, ".omp", "agent", "mcp.json");

    const initialClaude = JSON.stringify({
      mcpServers: {
        resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
        "resin-gateway": { command: "custom-user-cmd" },
      },
    });
    const initialCodex = [
      "[mcp_servers.resin_gateway]",
      'url = "http://127.0.0.1:9400/mcp/sse"',
      "",
      "[mcp_servers.unrecognized_legacy]",
      'url = "http://custom-legacy.local"',
      "",
      "[mcp_servers.resin_custom]",
      'url = "http://custom.local"',
    ].join("\n");
    const initialOmp = JSON.stringify({
      mcpServers: {
        "resin-gateway": { command: "resin-mcp" },
        resin_gateway: { url: "http://custom-omp.local" },
      },
    });

    const fsBridge = createMockFsBridge({
      [claudePath]: initialClaude,
      [codexPath]: initialCodex,
      [ompPath]: initialOmp,
    });

    const cleaned = await removeHarnessMcpConfigurations({
      customHome: homeDir,
      fsBridge,
    });

    expect(cleaned).toContain("Claude Code CLI");
    expect(cleaned).toContain("Codex CLI");
    expect(cleaned).toContain("Oh My Pi (OMP)");

    const updatedClaude = JSON.parse((await fsBridge.readFile(claudePath))!);
    expect(updatedClaude.mcpServers.resin_gateway).toBeUndefined();
    expect(updatedClaude.mcpServers["resin-gateway"]).toEqual({ command: "custom-user-cmd" });

    const updatedCodex = await fsBridge.readFile(codexPath);
    expect(updatedCodex).not.toContain("[mcp_servers.resin_gateway]");
    expect(updatedCodex).toContain("[mcp_servers.unrecognized_legacy]");
    expect(updatedCodex).toContain("[mcp_servers.resin_custom]");

    const updatedOmp = JSON.parse((await fsBridge.readFile(ompPath))!);
    expect(updatedOmp.mcpServers["resin-gateway"]).toBeUndefined();
    expect(updatedOmp.mcpServers.resin_gateway).toEqual({ url: "http://custom-omp.local" });
  });

  it("simulates uninstall in dry-run mode without modifying filesystem", async () => {
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
    });

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await uninstallCommand(["--dry-run", "--json", "--home", homeDir], {
        fsBridge,
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.success).toBe(true);
      expect(parsed.dryRun).toBe(true);
      expect(await fsBridge.exists(resinHome)).toBe(true);
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("executes full uninstallation with service removal and harness cleanup", async () => {
    const unitPath = path.join(homeDir, ".config", "systemd", "user", "resin.service");
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
      [unitPath]: "service unit",
      [claudePath]: JSON.stringify({
        mcpServers: { resin: { url: "http://localhost:9400" } },
      }),
    });

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await uninstallCommand(["--json", "--home", homeDir], {
        fsBridge,
        serviceManager: removedServiceStub(),
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.success).toBe(true);
      expect(parsed.harnessesCleaned).toContain("Claude Code CLI");
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("purges vault and cloud device token without expecting IPC token when --purge-secrets is used", async () => {
    const vaultDir = path.join(resinHome, "vault");
    const cloudTokenPath = path.join(resinHome, "state", "device-token.json");
    const fsBridge = createMockFsBridge({
      [resinHome]: "dir",
      [vaultDir]: "dir",
      [cloudTokenPath]: '{"accessToken":"cloud-token"}',
    });

    const stdoutChunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    });

    try {
      const exitCode = await uninstallCommand(["--purge-secrets", "--json", "--home", homeDir], {
        fsBridge,
        serviceManager: removedServiceStub(),
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.success).toBe(true);
      expect(parsed.purgedSecrets).toBe(true);
      expect(parsed.removedPaths).toContain(vaultDir);
      expect(parsed.removedPaths).toContain(cloudTokenPath);
      expect(parsed.removedPaths).not.toContain(path.join(resinHome, "state", "token.json"));
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("removes the installer's PATH line from shell profiles on --purge-all, keeping user lines", async () => {
    const bashrc = path.join(homeDir, ".bashrc");
    const zshrc = path.join(homeDir, ".zshrc");
    const installerLine = 'export PATH="$HOME/.resin/bin:$PATH"';
    const userLine = 'export PATH="$HOME/.resin/bin/extra:$PATH" # mine';
    const fsBridge = createMockFsBridge({
      [bashrc]: `alias ll='ls -l'\n${installerLine}\n`,
      [zshrc]: `${userLine}\n${installerLine}\nsetopt autocd\n`,
    });
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockReturnValue(true);

    try {
      const exitCode = await uninstallCommand(["--purge-all", "--yes", "--home", homeDir], {
        fsBridge,
        serviceManager: removedServiceStub(),
        // POSIX shell profiles only; never touch the real Windows user PATH from a test.
        platform: "linux",
      });

      expect(exitCode).toBe(0);
      expect(fsBridge.files.get(bashrc)).toBe("alias ll='ls -l'\n");
      expect(fsBridge.files.get(zshrc)).toBe(`${userLine}\nsetopt autocd\n`);
    } finally {
      process.stdout.write = originalStdout;
    }
  });

  it("removes the learned-tool block from OMP's appended system prompt, keeping the user's text", async () => {
    const home = await mkdtemp(join(tmpdir(), "uninstall-omp-guidance-"));
    try {
      const appendPath = join(home, ".omp", "agent", "APPEND_SYSTEM.md");
      await applyOmpCatalogInstructions({
        markdown: "### `release_notes`",
        toolNames: ["release_notes"],
        ompHome: join(home, ".omp"),
      });
      await writeFile(appendPath, `User notes\n\n${await readFile(appendPath, "utf8")}`);
      const cleaned = await removeHarnessMcpConfigurations({
        customHome: home,
        fsBridge: createMockFsBridge(),
      });
      expect(cleaned).toContain("Oh My Pi (OMP)");
      expect(await readFile(appendPath, "utf8")).toBe("User notes\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("uninstall failure reporting and native Windows cleanup", () => {
  const homeDir = path.resolve(tmpdir(), "resin-uninstall-reporting");
  const resinHome = path.join(homeDir, ".resin");

  function serviceManagerReturning(result: ServiceUninstallResult): UserServiceManager {
    return {
      name: "windows-task",
      platform: "windows-task",
      install: vi.fn(),
      uninstall: vi.fn().mockResolvedValue(result),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      status: vi.fn(),
      isInstalled: vi.fn().mockResolvedValue(true),
      getUnitDefinition: () => "",
      getUnitPath: () => path.join(resinHome, "services", "windows-task.xml"),
    };
  }

  const removedService = serviceManagerReturning({
    success: true,
    unitPath: path.join(resinHome, "services", "windows-task.xml"),
    stopped: true,
    disabled: true,
    removed: true,
  });

  async function runJson(
    args: string[],
    options: Parameters<typeof uninstallCommand>[1],
  ): Promise<{ exitCode: number; output: Record<string, unknown> }> {
    const chunks: string[] = [];
    const originalStdout = process.stdout.write;
    process.stdout.write = vi.fn().mockImplementation((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await uninstallCommand(["--json", "--home", homeDir, ...args], options);
      return { exitCode, output: JSON.parse(chunks.join("")) };
    } finally {
      process.stdout.write = originalStdout;
    }
  }

  it("reports a purge it could not complete and exits non-zero", async () => {
    const dataDir = path.join(resinHome, "data");
    const { exitCode, output } = await runJson(["--purge-data"], {
      fsBridge: createMockFsBridge({ [resinHome]: "dir", [dataDir]: "dir" }),
      platform: "linux",
      serviceManager: removedService,
      removePath: async (target) => {
        if (target === dataDir) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), {
            code: "EBUSY",
          });
        }
      },
    });

    expect(exitCode).toBe(1);
    expect(output.success).toBe(false);
    expect(output.purgeFailures).toEqual([
      { path: dataDir, error: expect.stringContaining("EBUSY") },
    ]);
    expect(output.removedPaths).not.toContain(dataDir);
  });

  it("reports a service that could not be removed", async () => {
    const { output } = await runJson([], {
      fsBridge: createMockFsBridge({ [resinHome]: "dir" }),
      platform: "win32",
      serviceManager: serviceManagerReturning({
        success: false,
        unitPath: path.join(resinHome, "services", "windows-task.xml"),
        stopped: true,
        disabled: false,
        removed: false,
        error: "Failed to delete scheduled task \\Resin\\ResinDaemon: Access is denied.",
      }),
    });

    expect(output.serviceUninstalled).toBe(false);
    expect(output.success).toBe(false);
    expect(output.serviceError).toContain("Access is denied");
  });

  it("on Windows, removes the user PATH entry and defers locked files until after exit", async () => {
    const removeWindowsUserPath = vi.fn().mockResolvedValue({
      attempted: true,
      changed: true,
      present: false,
      binDir: path.join(resinHome, "bin"),
    });
    const scheduleDeferredRemoval = vi.fn();
    const { exitCode, output } = await runJson(["--purge-all"], {
      fsBridge: createMockFsBridge({ [resinHome]: "dir" }),
      platform: "win32",
      serviceManager: removedService,
      removeWindowsUserPath,
      scheduleDeferredRemoval,
      purgeWindowsTree: async (_target, purgeOptions) => ({
        removed:
          purgeOptions.keep.length === 1 && purgeOptions.keep[0] === path.join(resinHome, "bin"),
        stagedFiles: [path.join(tmpdir(), "stage", "0-resin_windows_security.node")],
        stagingDir: path.join(tmpdir(), "stage"),
        remaining: [],
      }),
    });

    expect(exitCode).toBe(0);
    expect(removeWindowsUserPath).toHaveBeenCalledWith({ resinHome, platform: "win32" });
    expect(scheduleDeferredRemoval).toHaveBeenCalledWith([path.join(tmpdir(), "stage")]);
    expect(output).toMatchObject({
      success: true,
      removedPaths: [resinHome],
      deferredRemoval: [path.join(tmpdir(), "stage")],
    });
    expect(output.purgeFailures).toBeUndefined();
  });

  it("on Windows, reports locked paths when the deferred cleanup cannot start", async () => {
    const busyBin = path.join(resinHome, "bin");
    const { exitCode, output } = await runJson(["--purge-all"], {
      fsBridge: createMockFsBridge({ [resinHome]: "dir" }),
      platform: "win32",
      serviceManager: removedService,
      removeWindowsUserPath: vi.fn().mockResolvedValue({
        attempted: true,
        changed: true,
        present: false,
        binDir: busyBin,
      }),
      purgeWindowsTree: async () => ({ removed: false, stagedFiles: [], remaining: [busyBin] }),
      scheduleDeferredRemoval: () => {
        throw new Error("WMI unavailable");
      },
    });

    expect(exitCode).toBe(1);
    expect(output.purgeFailures).toEqual([
      { path: resinHome, error: "in use; deferred removal failed: WMI unavailable" },
    ]);
  });

  it("on Windows, reports a PATH cleanup failure", async () => {
    const { exitCode, output } = await runJson(["--purge-all"], {
      fsBridge: createMockFsBridge({}),
      purgeWindowsTree: async () => ({ removed: true, stagedFiles: [], remaining: [] }),
      platform: "win32",
      serviceManager: removedService,
      removeWindowsUserPath: vi.fn().mockResolvedValue({
        attempted: true,
        changed: false,
        present: true,
        binDir: path.join(resinHome, "bin"),
        error: "reg.exe failed",
      }),
    });

    expect(exitCode).toBe(1);
    expect(output.pathCleanupError).toBe("reg.exe failed");
  });
});
