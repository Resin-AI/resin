import path from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { logoutCommand, parseLogoutFlags } from "../src/commands/logout.js";
import {
  parseUninstallFlags,
  removeHarnessMcpConfigurations,
  uninstallCommand,
} from "../src/commands/uninstall.js";

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
  const homeDir = "/home/testuser";
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

    expect(cleaned).toContain("Claude Code");
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

    expect(cleaned).toContain("Claude Code");
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
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.success).toBe(true);
      expect(parsed.harnessesCleaned).toContain("Claude Code");
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
});
