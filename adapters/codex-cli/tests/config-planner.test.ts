import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_SERVER_NAME,
  applyCodexMcpConfig,
  planCodexMcpConfig,
  rollbackCodexMcpConfig,
  updateJsonMcpConfig,
  updateTomlMcpConfig,
  verifyCodexMcpConfig,
} from "../src/config-planner.js";

describe("Codex CLI Config Planner (TOML & JSON)", () => {
  const gatewayUrl = "http://127.0.0.1:4000/sse";

  describe("TOML MCP Configuration Manipulation", () => {
    it("creates clean TOML structure for empty content", () => {
      const result = updateTomlMcpConfig("", DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`url = "${gatewayUrl}"`);
    });

    it("preserves existing sections, profiles, and comments when appending", () => {
      const original = `# Main configuration
model = "gpt-4o"

# Filesystem MCP server
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "filesystem-server"]

[profiles.dev]
sandbox = "docker"
`;

      const result = updateTomlMcpConfig(original, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);

      // Verify original parts remain intact
      expect(result).toContain("# Main configuration");
      expect(result).toContain('model = "gpt-4o"');
      expect(result).toContain("# Filesystem MCP server");
      expect(result).toContain("[mcp_servers.filesystem]");
      expect(result).toContain("[profiles.dev]");
      expect(result).toContain('sandbox = "docker"');

      // Verify new section is added
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`url = "${gatewayUrl}"`);
    });

    it("is strictly idempotent when config already contains exact definition", () => {
      const initial = updateTomlMcpConfig("", DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      const secondPass = updateTomlMcpConfig(initial, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);

      expect(secondPass).toBe(initial);
    });

    it("updates URL when existing section has different URL", () => {
      const initial = `[mcp_servers.resin]\nurl = "http://old-gateway:3000/sse"\n`;
      const updated = updateTomlMcpConfig(initial, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);

      expect(updated).toContain(`url = "${gatewayUrl}"`);
      expect(updated).not.toContain("http://old-gateway:3000/sse");
    });
  });

  describe("JSON MCP Configuration Manipulation", () => {
    it("creates clean JSON structure for empty content", () => {
      const result = updateJsonMcpConfig("", DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers.resin.url).toBe(gatewayUrl);
    });

    it("preserves existing properties and sibling servers in JSON", () => {
      const original = JSON.stringify(
        {
          model: "gpt-4o",
          temperature: 0.7,
          mcpServers: {
            filesystem: {
              command: "npx",
            },
          },
        },
        null,
        2,
      );

      const result = updateJsonMcpConfig(original, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      const parsed = JSON.parse(result);

      expect(parsed.model).toBe("gpt-4o");
      // Verify resin was added alongside existing
      expect(parsed.mcpServers.resin.url).toBe(gatewayUrl);
    });

    it("is strictly idempotent in JSON", () => {
      const initial = updateJsonMcpConfig("", DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      const secondPass = updateJsonMcpConfig(initial, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);

      expect(secondPass).toBe(initial);
    });
  });

  describe("Plan, Apply, Verify, and Rollback Workflow", () => {
    it("executes full atomic config lifecycle on TOML config", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const targetPath = "/home/user/.codex/config.toml";
      const initialContent = `# Initial config\nmodel = "gpt-4o"\n`;
      await fsBridge.writeFile(targetPath, initialContent);

      // 1. Plan mutation
      const plan = await planCodexMcpConfig({
        targetPath,
        gatewayUrl,
        fsBridge,
      });

      expect(plan.harnessId).toBe("codex-cli");
      expect(plan.targetPath).toBe(targetPath);
      expect(plan.plannedContent).toContain("[mcp_servers.resin]");
      expect(plan.preconditionHash).toBeDefined();

      // 2. Verify config before apply (should be false)
      const verifiedBefore = await verifyCodexMcpConfig(
        targetPath,
        gatewayUrl,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(verifiedBefore).toBe(false);

      // 3. Apply mutation
      const backup = await applyCodexMcpConfig(plan, fsBridge);
      expect(backup.targetPath).toBe(targetPath);
      expect(backup.originalContent).toBe(initialContent);

      // 4. Verify config after apply (should be true)
      const verifiedAfter = await verifyCodexMcpConfig(
        targetPath,
        gatewayUrl,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(verifiedAfter).toBe(true);

      const updatedFile = await fsBridge.readFile(targetPath);
      expect(updatedFile).toContain(`url = "${gatewayUrl}"`);

      // 5. Rollback mutation
      await rollbackCodexMcpConfig(backup, fsBridge);
      const restoredFile = await fsBridge.readFile(targetPath);
      expect(restoredFile).toBe(initialContent);

      const verifiedAfterRollback = await verifyCodexMcpConfig(
        targetPath,
        gatewayUrl,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(verifiedAfterRollback).toBe(false);
    });

    it("executes full atomic config lifecycle on JSON config", async () => {
      const fsBridge = new InMemoryConfigFsBridge();
      const targetPath = "/home/user/.codex/config.json";
      const initialContent = JSON.stringify({ model: "gpt-4o" }, null, 2);
      await fsBridge.writeFile(targetPath, initialContent);

      // 1. Plan mutation
      const plan = await planCodexMcpConfig({
        targetPath,
        gatewayUrl,
        fsBridge,
      });

      expect(plan.targetPath).toBe(targetPath);

      // 2. Apply mutation
      const backup = await applyCodexMcpConfig(plan, fsBridge);

      // 3. Verify
      const verified = await verifyCodexMcpConfig(
        targetPath,
        gatewayUrl,
        DEFAULT_GATEWAY_SERVER_NAME,
        fsBridge,
      );
      expect(verified).toBe(true);

      // 4. Rollback
      await rollbackCodexMcpConfig(backup, fsBridge);
      const restored = await fsBridge.readFile(targetPath);
      expect(restored).toBe(initialContent);
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
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain(`url = "${gatewayUrl}"`);
      expect(result).not.toContain("[mcp_servers.resin_gateway]");
      expect(result).toContain("[mcp_servers.other_tool]");
    });

    it("resolves TOML coexistence by keeping canonical resin and deleting recognized legacy alias", () => {
      const initialToml = [
        "[mcp_servers.resin]",
        `url = "${gatewayUrl}"`,
        "",
        "[mcp_servers.resin_gateway]",
        'url = "http://127.0.0.1:9400/mcp/sse"',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).not.toContain("[mcp_servers.resin_gateway]");
    });

    it("preserves unrecognized same-named legacy alias in TOML", () => {
      const initialToml = [
        "[mcp_servers.resin_gateway]",
        'url = "http://user-internal.corp/sse"',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain("[mcp_servers.resin_gateway]");
      expect(result).toContain('url = "http://user-internal.corp/sse"');
    });

    it("migrates recognized JSON legacy aliases to resin and preserves unrecognized same-named aliases", () => {
      const initialJson = JSON.stringify({
        mcpServers: {
          resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
          "resin-gateway": { command: "custom-user-tool" },
        },
      });

      const result = updateJsonMcpConfig(initialJson, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      const parsed = JSON.parse(result);

      expect(parsed.mcpServers.resin).toEqual({ url: gatewayUrl });
      expect(parsed.mcpServers.resin_gateway).toBeUndefined();
      expect(parsed.mcpServers["resin-gateway"]).toEqual({ command: "custom-user-tool" });
    });

    it("migrates recognized inline-table legacy alias when inside [mcp_servers] container", () => {
      const initialToml = [
        "[mcp_servers]",
        'resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
        'user_tool = { command = "my-tool" }',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).not.toContain("resin_gateway =");
      expect(result).toContain('user_tool = { command = "my-tool" }');
    });

    it("migrates recognized dotted inline-table legacy alias (mcp_servers.resin_gateway)", () => {
      const initialToml = [
        'mcp_servers.resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
        'mcp_servers.other = { command = "other" }',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).not.toContain("mcp_servers.resin_gateway");
      expect(result).toContain('mcp_servers.other = { command = "other" }');
    });

    it("preserves legacy-named inline-table when in unrelated non-MCP container or global scope", () => {
      const initialToml = [
        'resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
        "",
        "[custom_settings]",
        'resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }',
      ].join("\n");
      const result = updateTomlMcpConfig(initialToml, DEFAULT_GATEWAY_SERVER_NAME, gatewayUrl);
      expect(result).toContain("[mcp_servers.resin]");
      expect(result).toContain('resin_gateway = { url = "http://127.0.0.1:9400/mcp/sse" }');
      expect(result).toContain("[custom_settings]");
    });
  });
});
