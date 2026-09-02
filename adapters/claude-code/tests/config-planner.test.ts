import {
  ConfigPreconditionFailedError,
  type HarnessWorkspace,
  InMemoryConfigFsBridge,
} from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  applyClaudeMcpConfig,
  generatePlannedClaudeConfig,
  planClaudeMcpConfig,
  rollbackClaudeMcpConfig,
  verifyClaudeMcpConfig,
} from "../src/config-planner.js";

describe("Claude Code MCP Config Planner", () => {
  const mockWorkspace: HarnessWorkspace = {
    workspaceId: "ws-test-1",
    name: "test-workspace",
    rootPath: "/workspace/project",
    harnessId: "claude-code",
    configPath: "/workspace/project/.claude.json",
    mcpConfigPath: "/workspace/project/.claude.json",
    metadata: {},
  };

  it("generates planned configuration from empty or null content", () => {
    const planned = generatePlannedClaudeConfig(null, "http://127.0.0.1:4545/sse");
    const parsed = JSON.parse(planned);

    expect(parsed.mcpServers).toBeDefined();
    expect(parsed.mcpServers.resin).toEqual({
      command: "resin",
      args: ["mcp"],
    });
  });

  it("preserves unrelated MCP servers and other root configuration keys", () => {
    const initialConfig = JSON.stringify(
      {
        theme: "dark",
        allowedTools: ["Bash", "Edit"],
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
          },
          sqlite: {
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "/db.sqlite"],
          },
        },
      },
      null,
      2,
    );

    const planned = generatePlannedClaudeConfig(initialConfig, "http://127.0.0.1:4545/sse");
    const parsed = JSON.parse(planned);

    expect(parsed.theme).toBe("dark");
    expect(parsed.allowedTools).toEqual(["Bash", "Edit"]);
    expect(parsed.mcpServers.github).toBeDefined();
    expect(parsed.mcpServers.sqlite).toBeDefined();
    expect(parsed.mcpServers.resin).toEqual({
      command: "resin",
      args: ["mcp"],
    });
  });

  it("is idempotent when gateway is already configured with identical command", () => {
    const initialConfig = generatePlannedClaudeConfig(null, "http://127.0.0.1:4545/sse");
    const secondPlan = generatePlannedClaudeConfig(initialConfig, "http://127.0.0.1:4545/sse");

    expect(secondPlan).toBe(initialConfig);
  });

  it("executes atomic plan, apply, backup, and byte-for-byte rollback", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const initialContent = `${JSON.stringify(
      {
        theme: "light",
        mcpServers: {
          postgres: { url: "postgresql://localhost:5432" },
        },
      },
      null,
      2,
    )}\n`;

    await fsBridge.writeFile(mockWorkspace.configPath, initialContent);

    // 1. Plan mutation
    const plan = await planClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge);

    expect(plan.harnessId).toBe("claude-code");
    expect(plan.targetPath).toBe(mockWorkspace.configPath);
    expect(plan.preconditionHash).toBeTruthy();
    expect(plan.plannedContent).toContain("resin");

    // 2. Apply mutation
    const backup = await applyClaudeMcpConfig(plan, fsBridge);

    expect(backup.targetPath).toBe(mockWorkspace.configPath);
    expect(backup.originalContent).toBe(initialContent);

    const updatedContent = await fsBridge.readFile(mockWorkspace.configPath);
    expect(updatedContent).toContain("resin");
    expect(updatedContent).toContain("postgres");
    const isVerified = await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge);
    expect(isVerified).toBe(true);

    // 4. Rollback mutation
    await rollbackClaudeMcpConfig(backup, fsBridge);

    const restoredContent = await fsBridge.readFile(mockWorkspace.configPath);
    expect(restoredContent).toBe(initialContent);
    expect(restoredContent).not.toContain("resin");
  });

  it("fails precondition check if file was modified externally before apply", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(mockWorkspace.configPath, '{"initial": 1}\n');

    const plan = await planClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge);

    // Concurrently alter target file
    await fsBridge.writeFile(mockWorkspace.configPath, '{"concurrent_change": 2}\n');

    await expect(applyClaudeMcpConfig(plan, fsBridge)).rejects.toThrow(
      ConfigPreconditionFailedError,
    );
  });

  it("verifies registration presence correctly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();

    expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

    await fsBridge.writeFile(
      mockWorkspace.configPath,
      JSON.stringify({
        mcpServers: {
          resin: { url: "http://127.0.0.1:4545/sse", type: "sse" },
        },
      }),
    );

    expect(await verifyClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:4545/sse", fsBridge)).toBe(
      false,
    );
    expect(await verifyClaudeMcpConfig(mockWorkspace, "http://wrong-url:9999", fsBridge)).toBe(
      false,
    );

    await fsBridge.writeFile(
      mockWorkspace.configPath,
      JSON.stringify({
        mcpServers: {
          resin: { command: "resin", args: ["mcp"] },
        },
      }),
    );

    expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(true);
    expect(await verifyClaudeMcpConfig(mockWorkspace, "resin", fsBridge)).toBe(true);
  });

  it("plans and verifies an explicit Resin command exactly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const command = "/home/developer/.resin/bin/resin";
    const plan = await planClaudeMcpConfig(mockWorkspace, undefined, fsBridge, command);

    expect(JSON.parse(plan.plannedContent).mcpServers.resin).toEqual({
      command,
      args: ["mcp"],
    });
    await applyClaudeMcpConfig(plan, fsBridge);

    await expect(verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge, command)).resolves.toBe(
      true,
    );
    await expect(verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).resolves.toBe(false);

    await fsBridge.writeFile(
      mockWorkspace.configPath,
      JSON.stringify({
        mcpServers: {
          resin: { type: "http", command, args: ["mcp"] },
        },
      }),
    );
    await expect(verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge, command)).resolves.toBe(
      false,
    );

    await fsBridge.writeFile(
      mockWorkspace.configPath,
      JSON.stringify({
        mcpServers: {
          resin: { command: ` ${command} `, args: ["mcp"] },
        },
      }),
    );
    await expect(verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge, command)).resolves.toBe(
      false,
    );
  });

  describe("Canonical resin key and legacy alias migration", () => {
    it("migrates recognized legacy alias resin_gateway and resin-gateway to resin", () => {
      const initial = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
          "resin-gateway": { command: "resin-mcp" },
          user_server: { command: "my-tool" },
        },
      });

      const planned = generatePlannedClaudeConfig(initial, "http://127.0.0.1:9400/mcp/sse");
      const parsed = JSON.parse(planned);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin_gateway).toBeUndefined();
      expect(parsed.mcpServers["resin-gateway"]).toBeUndefined();
      expect(parsed.mcpServers.user_server).toEqual({ command: "my-tool" });
    });

    it("resolves coexistence by retaining canonical resin and removing owned legacy alias", () => {
      const initial = JSON.stringify({
        mcpServers: {
          resin: { type: "sse", url: "http://127.0.0.1:9400/mcp/sse" },
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
        },
      });

      const planned = generatePlannedClaudeConfig(initial, "http://127.0.0.1:9400/mcp/sse");
      const parsed = JSON.parse(planned);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin_gateway).toBeUndefined();
    });

    it("preserves unrecognized same-named legacy alias when not Resin-owned", () => {
      const initial = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://custom-external.company/sse" },
        },
      });

      const planned = generatePlannedClaudeConfig(initial, "http://127.0.0.1:9400/mcp/sse");
      const parsed = JSON.parse(planned);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin_gateway).toEqual({
        url: "http://custom-external.company/sse",
      });
    });
  });

  describe("verifyClaudeMcpConfig", () => {
    it("verifies fresh canonical resin mcp configuration with command resin and leading mcp arg", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { command: "resin", args: ["mcp"] },
          },
        }),
      );

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(true);
      expect(
        await verifyClaudeMcpConfig(mockWorkspace, "http://127.0.0.1:9400/mcp/sse", fsBridge),
      ).toBe(true);
    });

    it("verifies canonical configuration with additional arguments or environment variables", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: {
              command: "resin",
              args: ["mcp", "--verbose"],
              env: { DEBUG: "1" },
            },
          },
        }),
      );

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(true);
    });

    it("rejects legacy SSE and URL-only configurations regardless of expectedGatewayUrl", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";

      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { type: "sse", url: gatewayUrl },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, gatewayUrl, fsBridge)).toBe(false);
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { url: gatewayUrl },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, gatewayUrl, fsBridge)).toBe(false);
    });

    it("rejects entries where url is present alongside stdio command", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: {
              type: "stdio",
              command: "resin",
              args: ["mcp"],
              url: "http://127.0.0.1:9400/mcp/sse",
            },
          },
        }),
      );

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);
    });

    it("rejects command equal to gateway URL", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: {
              command: gatewayUrl,
              args: ["mcp"],
            },
          },
        }),
      );

      expect(await verifyClaudeMcpConfig(mockWorkspace, gatewayUrl, fsBridge)).toBe(false);
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);
    });

    it("rejects malformed stdio configurations with wrong command or missing/invalid args", async () => {
      const fsBridge = new InMemoryConfigFsBridge();

      // Missing args
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { command: "resin" },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      // Empty args
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { command: "resin", args: [] },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      // Wrong first arg
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { command: "resin", args: ["status"] },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      // Legacy resin-mcp binary
      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({
          mcpServers: {
            resin: { command: "resin-mcp", args: ["mcp"] },
          },
        }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);
    });

    it("rejects missing file, corrupt JSON, or missing server entry", async () => {
      const fsBridge = new InMemoryConfigFsBridge();

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      await fsBridge.writeFile(mockWorkspace.configPath, "not-json");
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      await fsBridge.writeFile(
        mockWorkspace.configPath,
        JSON.stringify({ mcpServers: { other: { command: "other" } } }),
      );
      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);
    });

    it("verifies true after planning and applying mutation from legacy config", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const legacyContent = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
          user_tool: { command: "tool" },
        },
      });
      await fsBridge.writeFile(mockWorkspace.configPath, legacyContent);

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(false);

      const plan = await planClaudeMcpConfig(
        mockWorkspace,
        "http://127.0.0.1:9400/mcp/sse",
        fsBridge,
      );
      await applyClaudeMcpConfig(plan, fsBridge);

      expect(await verifyClaudeMcpConfig(mockWorkspace, undefined, fsBridge)).toBe(true);
    });
  });
});
