import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_SERVER_NAME,
  DEFAULT_RESIN_MCP_COMMAND,
  applyCodexMcpConfig,
  planCodexMcpConfig,
  rollbackCodexMcpConfig,
  updateJsonMcpConfig,
  updateTomlMcpConfig,
  verifyCodexMcpConfig,
} from "../src/config-planner.js";

describe("Codex CLI Config Planner (TOML & JSON)", () => {
  describe("TOML MCP Configuration Manipulation", () => {
    it("creates clean TOML structure for empty content with canonical stdio command", () => {
      const result = updateTomlMcpConfig("");
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain("url =");
      expect(result).not.toContain("127.0.0.1");
      expect(result).not.toContain("localhost");
    });

    it("preserves non-mcp TOML keys, comments, and structure", () => {
      const initial = [
        "# OpenAI Codex Configuration",
        'model = "gpt-4o"',
        "temperature = 0.2",
        "",
        "[profiles.dev]",
        'sandbox = "docker"',
      ].join("\n");

      const result = updateTomlMcpConfig(initial);

      expect(result).toContain("# OpenAI Codex Configuration");
      expect(result).toContain('model = "gpt-4o"');
      expect(result).toContain("temperature = 0.2");
      expect(result).toContain("[profiles.dev]");
      expect(result).toContain('sandbox = "docker"');
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain("url =");
    });

    it("preserves existing MCP servers defined as tables", () => {
      const initial = [
        "[mcp_servers.filesystem]",
        'command = "npx"',
        'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
      ].join("\n");

      const result = updateTomlMcpConfig(initial);

      expect(result).toContain("[mcp_servers.filesystem]");
      expect(result).toContain('command = "npx"');
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain("url =");
    });

    it("is strictly idempotent when config already contains exact definition", () => {
      const initial = updateTomlMcpConfig("");
      const secondPass = updateTomlMcpConfig(initial);

      expect(secondPass).toBe(initial);
    });

    it("updates legacy URL entry to canonical stdio command without leftover URL", () => {
      const initial = [
        "[mcp_servers.resin]",
        'url = "http://127.0.0.1:9400/mcp/sse"',
        'description = "Legacy Resin gateway"',
      ].join("\n");

      const updated = updateTomlMcpConfig(initial);

      expect(updated).toContain("[mcp_servers.resin]");
      expect(updated).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(updated).toContain('description = "Legacy Resin gateway"');
      expect(updated).not.toContain("http://127.0.0.1:9400/mcp/sse");
      expect(updated).not.toContain("url =");
    });
  });

  describe("JSON MCP Configuration Manipulation", () => {
    it("creates clean JSON structure for empty content with canonical stdio command", () => {
      const result = updateJsonMcpConfig("");
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers).toBeDefined();
      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
    });

    it("preserves non-mcp keys and other servers in JSON", () => {
      const initial = JSON.stringify(
        {
          model: "gpt-4o",
          temperature: 0.2,
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "fs"],
            },
          },
          permissions: { allowAll: true },
        },
        null,
        2,
      );

      const result = updateJsonMcpConfig(initial);
      const parsed = JSON.parse(result);

      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.temperature).toBe(0.2);
      expect(parsed.permissions).toEqual({ allowAll: true });
      expect(parsed.mcpServers.filesystem).toEqual({
        command: "npx",
        args: ["-y", "fs"],
      });
      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
    });

    it("migrates existing JSON legacy URL server to stdio command", () => {
      const initial = JSON.stringify(
        {
          mcpServers: {
            resin: {
              url: "http://127.0.0.1:9400/mcp/sse",
            },
          },
        },
        null,
        2,
      );

      const result = updateJsonMcpConfig(initial);
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin.url).toBeUndefined();
    });

    it("is idempotent for repeated JSON updates", () => {
      const initial = updateJsonMcpConfig("{}");
      const secondPass = updateJsonMcpConfig(initial);

      expect(JSON.parse(secondPass)).toEqual(JSON.parse(initial));
    });
  });

  describe("End-to-End Plan, Apply, Rollback, and Verification (TOML & JSON)", () => {
    it("executes full lifecycle on TOML configuration with canonical stdio command", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const targetPath = "/workspace/.codex/config.toml";
      const initialContent = '# Codex Config\nmodel = "gpt-4o"\n';
      await fsBridge.writeFile(targetPath, initialContent);

      // 1. Plan mutation
      const plan = await planCodexMcpConfig({
        targetPath,
        fsBridge,
      });

      expect(plan.harnessId).toBe("codex-cli");
      expect(plan.targetPath).toBe(targetPath);
      expect(plan.plannedContent).toContain("[mcp_servers.resin]");
      expect(plan.plannedContent).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(plan.plannedContent).not.toContain("127.0.0.1");
      expect(plan.plannedContent).not.toContain("url =");

      // 2. Apply mutation
      const backup = await applyCodexMcpConfig(plan, fsBridge);
      const modifiedContent = await fsBridge.readFile(targetPath);
      expect(modifiedContent).toBe(plan.plannedContent);

      // 3. Verify configuration integrity
      const isVerified = await verifyCodexMcpConfig(
        targetPath,
        DEFAULT_RESIN_MCP_COMMAND,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(isVerified).toBe(true);

      // 4. Rollback mutation
      await rollbackCodexMcpConfig(backup, fsBridge);
      const restored = await fsBridge.readFile(targetPath);
      expect(restored).toBe(initialContent);
    });

    it("executes full lifecycle on JSON configuration with canonical stdio command", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const targetPath = "/workspace/.codex/config.json";
      const initialContent = `${JSON.stringify({ model: "gpt-4o" }, null, 2)}\n`;
      await fsBridge.writeFile(targetPath, initialContent);

      // 1. Plan mutation
      const plan = await planCodexMcpConfig({
        targetPath,
        fsBridge,
      });

      expect(plan.harnessId).toBe("codex-cli");
      const parsed = JSON.parse(plan.plannedContent);
      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });

      // 2. Apply mutation
      const backup = await applyCodexMcpConfig(plan, fsBridge);
      const modifiedContent = await fsBridge.readFile(targetPath);
      expect(modifiedContent).toBe(plan.plannedContent);

      // 3. Verify configuration integrity
      const isVerified = await verifyCodexMcpConfig(
        targetPath,
        DEFAULT_RESIN_MCP_COMMAND,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(isVerified).toBe(true);

      // 4. Rollback mutation
      await rollbackCodexMcpConfig(backup, fsBridge);
      const restored = await fsBridge.readFile(targetPath);
      expect(restored).toBe(initialContent);
    });
    it("plans, applies, and verifies canonical stdio Resin server for fresh empty TOML config", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const targetPath = "/workspace/.codex/config.toml";

      const plan = await planCodexMcpConfig({
        targetPath,
        fsBridge,
      });
      expect(plan.plannedContent).toContain("[mcp_servers.resin]");
      expect(plan.plannedContent).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(plan.plannedContent).toContain('args = ["mcp"]');
      const backup = await applyCodexMcpConfig(plan, fsBridge);
      expect(backup.targetPath).toBe(targetPath);

      const isVerified = await verifyCodexMcpConfig({
        targetPath,
        fsBridge,
      });
      expect(isVerified).toBe(true);

      const isVerifiedPositional = await verifyCodexMcpConfig(
        targetPath,
        undefined,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(isVerifiedPositional).toBe(true);
    });
  });

  describe("Canonical resin key and legacy alias migration", () => {
    it("migrates recognized TOML legacy aliases resin_gateway and resin-gateway to resin", () => {
      const initialToml = [
        "# Existing config",
        "[mcp_servers.resin_gateway]",
        'url = "http://127.0.0.1:9400/mcp/sse"',
        "",
        "[mcp_servers.other_tool]",
        'command = "other-bin"',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain("[mcp_servers.resin_gateway]");
      expect(result).not.toContain("http://127.0.0.1:9400/mcp/sse");
      expect(result).not.toContain("url =");
      expect(result).toContain("[mcp_servers.other_tool]");
    });

    it("resolves TOML coexistence when canonical resin and legacy alias coexist", () => {
      const initialToml = [
        "[mcp_servers.resin]",
        `command = "${DEFAULT_RESIN_MCP_COMMAND}"`,
        "",
        "[mcp_servers.resin_gateway]",
        'url = "http://127.0.0.1:9400/mcp/sse"',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain("[mcp_servers.resin_gateway]");
      expect(result).not.toContain("http://127.0.0.1:9400/mcp/sse");
    });

    it("preserves unrecognized same-named legacy alias in TOML when not Resin-owned", () => {
      const initialToml = ["[mcp_servers.resin-gateway]", 'command = "custom-user-tool"'].join(
        "\n",
      );
      const result = updateTomlMcpConfig(initialToml);
      expect(result).toContain("[mcp_servers.resin-gateway]");
      expect(result).toContain('command = "custom-user-tool"');
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
    });

    it("migrates inline legacy aliases under [mcp_servers] in TOML", () => {
      const initialToml = [
        "[mcp_servers]",
        'resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
        'user_tool = { command = "my-tool" }',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).not.toContain('resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }');
      expect(result).toContain('user_tool = { command = "my-tool" }');
    });

    it("migrates recognized JSON legacy aliases resin_gateway and resin-gateway to resin", () => {
      const initialJson = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
          "resin-gateway": { command: "resin-mcp" },
          user_tool: { command: "my-tool" },
        },
      });

      const result = updateJsonMcpConfig(initialJson);
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin_gateway).toBeUndefined();
      expect(parsed.mcpServers["resin-gateway"]).toBeUndefined();
      expect(parsed.mcpServers.user_tool).toEqual({ command: "my-tool" });
    });

    it("preserves unrecognized same-named legacy alias in JSON when not Resin-owned", () => {
      const initialJson = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
          "resin-gateway": { command: "custom-user-tool" },
        },
      });

      const result = updateJsonMcpConfig(initialJson);
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers.resin).toEqual({
        command: "resin",
        args: ["mcp"],
      });
      expect(parsed.mcpServers.resin_gateway).toBeUndefined();
      expect(parsed.mcpServers["resin-gateway"]).toEqual({
        command: "custom-user-tool",
      });
    });

    it("preserves unrelated sections that contain words like resin_gateway outside mcp_servers", () => {
      const initialToml = [
        "[custom_settings]",
        'resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`command = "${DEFAULT_RESIN_MCP_COMMAND}"`);
      expect(result).toContain('resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }');
      expect(result).toContain("[custom_settings]");
    });
  });
});
